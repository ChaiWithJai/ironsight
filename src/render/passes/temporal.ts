/**
 * Velocity tile-max (pass 18) and the TAA resolve (pass 19). OWNER: RCORE.
 *
 * TAA is the single highest-risk pass in the frame, because when it goes wrong
 * it does not look broken — it looks SOFT, and softness gets blamed on
 * materials, on mips, on the shadow filter, on anything but the resolve. The
 * three decisions that keep it sharp are all here and all deliberate:
 *
 *  1. **A 5-tap Catmull-Rom history fetch.** Bilinear reprojection filters the
 *     history every single frame, so detail decays exponentially and the image
 *     converges to mush. This is the difference between "TAA" and "TAA that
 *     resolves railings".
 *  2. **YCoCg variance clipping, not a min/max box.** A box clamp over a 3×3
 *     neighbourhood is far too loose around a thin bright edge — the wire's own
 *     pixel widens the box enough to admit its ghost. Clipping to mean ± γ·σ in
 *     a luma/chroma space kills the ghost while leaving genuine chroma detail.
 *  3. **A tighter γ on viewmodel pixels.** LOOK_SPEC §6.3: recoil must stay
 *     crisp. The weapon moves fast, occupies 12–16 % of the frame and is the
 *     thing the player is actually looking at.
 *
 * Sky and anything the prepass skipped have no motion vector, so the resolve
 * computes camera-rotation reprojection for them analytically (`ironSkyVelocity`)
 * rather than trusting a cleared buffer that claims the horizon is nailed to the
 * screen.
 */
import * as THREE from 'three';
import {
  AntiAliasMode,
  PassOrder,
  RTId,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';
import { GLSL_COLOR_COMMON } from '@/render/color';
import { GLSL_CATMULL_ROM, GLSL_SKY_VELOCITY, ut, uf, uv2, um4 } from '@/render/fullscreen';
import type { PostChainState } from '@/render/passes/chain';

/** Tile edge in full-res pixels. 1/20 of the frame, architecture pass 18. */
const TILE = 20;

/**
 * Pass 18. Per-tile maximum velocity, so motion blur can pick a sampling
 * direction that covers the whole neighbourhood's motion rather than only its
 * own pixel's — without it, the leading edge of a moving object cuts off dead.
 */
export class VelocityDilatePass implements RenderPass {
  readonly id = 'motion.dilate';
  readonly order = PassOrder.VelocityDilate;
  readonly reads: readonly RTId[] = [RTId.GVelocity];
  readonly writes: readonly RTId[] = [RTId.VelocityTiles];
  readonly budgetMs = 0.15;

  enabled(quality: Readonly<QualitySettings>): boolean {
    return quality.motionBlur.enabled;
  }

  execute(_ctx: FrameCtx, graph: RenderGraph): void {
    const src = graph.target(RTId.GVelocity);
    graph.fullscreen(
      'motion.dilate',
      /* glsl */ `
        vec2 srcSize = vec2(uSrcSize);
        vec2 tileOrigin = floor(vUv * srcSize / float(TILE)) * float(TILE);
        vec2 best = vec2(0.0);
        float bestLen = -1.0;
        for (int y = 0; y < TILE; y++) {
          for (int x = 0; x < TILE; x++) {
            vec2 uv = (tileOrigin + vec2(float(x) + 0.5, float(y) + 0.5)) / srcSize;
            vec2 v = texture(uVelocity, uv).xy;
            float l = dot(v, v);
            if (l > bestLen) { bestLen = l; best = v; }
          }
        }
        outColor = vec4(best, 0.0, 1.0);
      `,
      { uVelocity: ut(graph.texture(RTId.GVelocity)), uSrcSize: uv2(src.width, src.height) },
      graph.target(RTId.VelocityTiles),
      {
        prelude: 'uniform sampler2D uVelocity;\nuniform vec2 uSrcSize;',
        defines: { TILE },
      },
    );
  }
}

/**
 * Pass 19. Resolve `SceneColor` (jittered) against the history into
 * `TaaHistory.current`, then publish it as `ResolvedColor`.
 *
 * The history is a separate resource from `ResolvedColor` ON PURPOSE: VFX draws
 * tracers and muzzle flashes into `ResolvedColor` at pass 20, and feeding those
 * back into the history would accumulate a comet trail behind every round.
 */
export class TaaResolvePass implements RenderPass {
  readonly id = 'taa.resolve';
  readonly order = PassOrder.TaaResolve;
  readonly reads: readonly RTId[] = [RTId.SceneColor, RTId.GVelocity, RTId.SceneDepth, RTId.GNormalRough];
  readonly writes: readonly RTId[] = [RTId.TaaHistory, RTId.ResolvedColor];
  readonly budgetMs = 0.55;

  private readonly invViewProj = new THREE.Matrix4();
  private readonly prevViewProj = new THREE.Matrix4();

  constructor(private readonly state: PostChainState) {}

  /** Always on: with TAA off it degrades to a copy, so `ResolvedColor` is
   *  written on every tier and `validate()` stays satisfied. */
  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const history = graph.history(RTId.TaaHistory);
    const taaOn = ctx.quality.aa === AntiAliasMode.Taa;

    this.invViewProj.copy(ctx.camera.inverseViewProjection);
    this.prevViewProj.copy(ctx.camera.prevViewProjection);

    graph.fullscreen(
      'taa.resolve',
      /* glsl */ `
        vec2 texel = 1.0 / uResolution;
        vec3 current = max(texture(uColor, vUv).rgb, vec3(0.0));

        if (uEnabled < 0.5 || uHistoryValid < 0.5) {
          outColor = vec4(current, 1.0);
          return;
        }

        // --- motion vector: 3x3 closest-depth dilation ----------------------
        float closest = 1e30;
        vec2 velocityUv = vUv;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 uv = vUv + vec2(float(x), float(y)) * texel;
            float d = texture(uDepth, uv).r;
            if (d > 0.0 && d < closest) { closest = d; velocityUv = uv; }
          }
        }
        vec2 velocity;
        if (closest > 1e29) {
          velocity = ironSkyVelocity(vUv, uInvViewProj, uPrevViewProj, uCameraPos);
        } else {
          velocity = texture(uVelocity, velocityUv).xy;
        }
        vec2 prevUv = vUv - velocity;

        // --- neighbourhood statistics in YCoCg ------------------------------
        vec3 m1 = vec3(0.0);
        vec3 m2 = vec3(0.0);
        vec3 curY = ironRgbToYCoCg(current);
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec3 c = ironRgbToYCoCg(max(texture(uColor, vUv + vec2(float(x), float(y)) * texel).rgb, vec3(0.0)));
            m1 += c;
            m2 += c * c;
          }
        }
        vec3 mean = m1 / 9.0;
        vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));

        float surfaceClass = texture(uNormalRough, vUv).a * 255.0;
        bool isViewmodel = surfaceClass > 1.5;
        // Wider on the world (more history = more stable thin geometry),
        // deliberately tight on the weapon (LOOK_SPEC 6.3: recoil stays crisp).
        float gamma = isViewmodel ? 0.85 : 1.45;
        vec3 lo = mean - gamma * sigma;
        vec3 hi = mean + gamma * sigma;
        // LUMINANCE CANNOT BE NEGATIVE, and letting the box say otherwise is not
        // a rounding detail — it is a division by a negative number four lines
        // below. In a high-variance neighbourhood (the sun glitter path on water
        // is the only place in this scene that reaches it) sigma.x runs to
        // several times mean.x, so lo.x goes hard negative, the clamped history
        // luma follows it, and the Karis weight 1/(1 + Y) turns negative. The
        // blend then flips sign per pixel and resolves to black with a speckle
        // of single-channel survivors — which is exactly the black wedge that
        // used to run down the glitter path of water_golden. Co-ordinate
        // channels are signed and are left alone.
        lo.x = max(lo.x, 0.0);
        hi.x = max(hi.x, lo.x);

        bool offscreen = any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)));
        if (offscreen) {
          outColor = vec4(current, 1.0);
          return;
        }

        vec3 history = max(ironSampleCatmullRom(uHistory, prevUv, uResolution).rgb, vec3(0.0));
        vec3 histY = clamp(ironRgbToYCoCg(history), lo, hi);

        // --- blend ----------------------------------------------------------
        // Tonemapped weighting (Karis): a single 10 000 cd/m2 firefly would
        // otherwise dominate the average and stay lit for thirty frames.
        float speedPx = length(velocity * uResolution);
        float alpha = mix(uBlend, 0.32, clamp(speedPx / 24.0, 0.0, 1.0));
        if (isViewmodel) alpha = max(alpha, 0.22);
        // Belt and braces on the same failure: the weights are only a tonemap if
        // their denominators stay >= 1, so the luma fed to them is floored here
        // too. Cheap, and it means no future clip-box change can reintroduce a
        // negative weight.
        float wc = alpha / (1.0 + max(curY.x, 0.0));
        float wh = (1.0 - alpha) / (1.0 + max(histY.x, 0.0));
        vec3 resolved = ironYCoCgToRgb((curY * wc + histY * wh) / max(wc + wh, 1e-5));
        resolved = max(resolved, vec3(0.0));
        // A NaN anywhere in an accumulating history is permanent.
        if (any(isnan(resolved)) || any(isinf(resolved))) resolved = current;
        outColor = vec4(resolved, 1.0);
      `,
      {
        uColor: ut(graph.texture(RTId.SceneColor)),
        uHistory: ut(history.previous.texture),
        uVelocity: ut(graph.texture(RTId.GVelocity)),
        uDepth: ut(graph.texture(RTId.SceneDepth)),
        uNormalRough: ut(graph.texture(RTId.GNormalRough)),
        uInvViewProj: um4(this.invViewProj),
        uPrevViewProj: um4(this.prevViewProj),
        uCameraPos: { value: ctx.camera.position },
        uBlend: uf(1 / Math.max(2, ctx.quality.taaSamples)),
        uHistoryValid: uf(history.valid ? 1 : 0),
        uEnabled: uf(taaOn ? 1 : 0),
      },
      history.current,
      {
        prelude: `
          ${GLSL_COLOR_COMMON}
          ${GLSL_CATMULL_ROM}
          ${GLSL_SKY_VELOCITY}
          uniform sampler2D uColor;
          uniform sampler2D uHistory;
          uniform sampler2D uVelocity;
          uniform sampler2D uDepth;
          uniform sampler2D uNormalRough;
          uniform mat4 uInvViewProj;
          uniform mat4 uPrevViewProj;
          uniform vec3 uCameraPos;
          uniform float uBlend;
          uniform float uHistoryValid;
          uniform float uEnabled;
        `,
      },
    );
    graph.blit(history.current.texture, graph.target(RTId.ResolvedColor));
    // Republish the canonical post source every frame: motion blur moves it to
    // SceneColor and would otherwise read its own output next frame.
    this.state.source = RTId.ResolvedColor;
  }
}
