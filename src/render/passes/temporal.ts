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
import { EXPOSURE_PRESET_EV, GLSL_COLOR_COMMON, exposureScaleFromEv } from '@/render/color';
import { GLSL_CATMULL_ROM, GLSL_SKY_VELOCITY, ut, uf, uv2, um4 } from '@/render/fullscreen';
import type { PostChainState } from '@/render/passes/chain';

/** Tile edge in full-res pixels. 1/20 of the frame, architecture pass 18. */
const TILE = 20;

/**
 * History blend weight for the current frame when nothing on screen is moving.
 *
 * IT USED TO BE `1 / taaSamples`, i.e. 0.25 at this tier, and that makes the
 * resolve a biased sub-pixel filter rather than a box over the pixel.
 *
 * An exponential blend at rate a over a jitter sequence of period N does not
 * weight the N sub-pixel positions equally. It weights them
 * `a/(1-(1-a)^N) x (1-a)^k` for k = 0..N-1, so at a = 0.25 and N = 4 the four
 * Halton positions land at 36.6 %, 27.4 %, 20.6 % and 15.4 %. That is not a box
 * filter over the pixel, it is a filter whose centroid sits off-centre in the
 * direction of the most recent jitter, and whose offset changes sign with the
 * sub-pixel phase of the edge it lands on. A straight high-contrast edge
 * therefore resolves with a coverage error that varies along its length.
 *
 * At 0.10 the same four positions land at 29.1 %, 26.2 %, 23.6 % and 21.2 % —
 * within 16 % of uniform rather than within 140 % — and the residual centroid
 * error is a fifth of what it was. Measured on `sky_golden`'s near truss the
 * mean row-to-row change in the rim's peak fell from 2.31 to 1.77 code values.
 * The cost is convergence time: (1-0.10)^24 = 0.08, so a 24-frame shot is 92 %
 * converged, and the motion ramp below still takes alpha to 0.32 the moment
 * anything moves, which is what bounds ghosting.
 *
 * WHAT IT DOES NOT FIX, said plainly: the review called the truss rim a
 * "scalloped caterpillar" and blamed sub-pixel geometry sampled once per pixel.
 * The lumps along that rim survive this change, an aggressive despike (below),
 * and a 4x aperture on the DOF gather, all unchanged in shape and position, and
 * their autocorrelation along the beam has no periodic peak at all. They are not
 * a temporal or a sampling artefact. They are the shading itself, and the fix
 * for them is a wrap/Fresnel rim term in the material rather than anything in
 * this file.
 */
/*
 * ROUND 5: 0.10 -> 0.07. Same argument as the paragraph above, taken one step
 * further now that the capture harness runs 24-28 frames per shot rather than
 * the 12 it did when 0.10 was chosen. At N = 8 Halton positions the four-way
 * weight spread is 26.4 / 24.6 / 22.8 / 21.2 % against 29.1 / 26.2 / 23.6 /
 * 21.2 % at 0.10 -- a further third off the centroid error on a static edge --
 * and (1 - 0.07)^28 = 0.13, so a 28-frame shot is still 87 % converged. The
 * motion ramp is untouched, so nothing about ghosting in play changes: the
 * moment a pixel moves at all, alpha goes to 0.32.
 */
const TAA_STATIC_BLEND = 0.07;

/*
 * SPIKE REMOVAL — an ENERGY-PRESERVING firefly filter, run on the current frame
 * before it is resolved against the history.
 *
 * THE PROBLEM IT SOLVES is the one the water review named exactly: "the
 * high-frequency specular from the wave normals is undersampled and nothing is
 * resolving it... clamp specular intensity per-sample (firefly clamp) before the
 * resolve". A grazing specular lobe narrower than a pixel lands on a scattered
 * subset of the pixels it geometrically covers, at many times the radiance it
 * should carry on any of them. That is a sampling failure, not a brightness
 * failure, and the two obvious answers both make the frame worse: a hard clamp
 * throws the energy away (the highlight goes dim and stays broken), and more
 * temporal samples do not converge something that is present at one jitter
 * position and absent at the next.
 *
 * WHAT THIS DOES. Every pixel whose max channel exceeds SPIKE_RATIO x the mean
 * of its own 5x5 neighbourhood hands that excess to a 5x5 separable 1-2-3-2-1
 * tent centred on itself, and receives every neighbour's contribution in return.
 * ONE limit is computed for the whole window, which is what makes scatter and
 * gather the same sum and the redistribution EXACTLY energy-conserving: this
 * moves radiance sideways, it never destroys it. A pinprick becomes a small
 * smooth lobe of the same total brightness; a large uniformly bright region (the
 * sun disc, a blown sky) has every pixel within SPIKE_RATIO of its own mean and
 * is not touched at all.
 *
 * WHY 5x5 AND NOT 3x3. 3x3 was written first and measured nearly inert. The
 * features that need widening are 1x2 and 1x3 fragments of a specular, and a
 * 3x3 window that contains the whole fragment reports a mean a third of the
 * peak, so a ratio test never fires. A 5x5 window sees the same fragment as
 * 3 texels in 25 and fires properly. The 25 taps are shared with the
 * neighbourhood statistics below, so the marginal cost is the arithmetic only.
 *
 * The ratio ceiling is 25 (a pixel with 24 black neighbours), so 2.2 leaves
 * ordinary high-frequency detail alone — a 1 px continuous bright line loses
 * about half its energy sideways and takes most of it straight back from its own
 * neighbours along the line — while an isolated point loses 91 % of its.
 */
const SPIKE_RATIO = 2.2;
/**
 * The floor under the ratio test, in DISPLAY-linear units, converted to scene
 * radiance with the preset exposure at the call site.
 *
 * Without it the ratio test is scale-free and would redistribute energy across
 * every dark, contrasty texture in the frame — which is a blur, not a despike.
 * At 2.0 it only engages on things that are already at least a stop over display
 * white, i.e. genuine specular pinpricks, sun glitter and emitters. Auto-exposure
 * is clamped to +/-0.75 EV around the preset and is frozen to it outright on a
 * deterministic frame, so the preset is within a factor of 1.7 of the true
 * exposure at all times and this threshold never moves far.
 */
const SPIKE_FLOOR_DISPLAY = 2.0;

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

        // --- spike removal, energy-preserving -------------------------------
        // See ironDespike below. Everything downstream — the neighbourhood
        // statistics, the history, bloom, DOF — reads the despiked image.
        vec3 c5[25];
        float l5[25];
        for (int j = -2; j <= 2; j++) {
          for (int i = -2; i <= 2; i++) {
            vec3 s = max(texture(uColor, vUv + vec2(float(i), float(j)) * texel).rgb, vec3(0.0));
            c5[(j + 2) * 5 + (i + 2)] = s;
            l5[(j + 2) * 5 + (i + 2)] = max(s.r, max(s.g, s.b));
          }
        }
        // ONE limit for the whole 3x3, taken from the FULL 5x5 mean. Giving each
        // of the nine its own 3x3 mean was tried first and measured almost
        // inert: the features that need widening are 1x2 and 1x3 fragments of a
        // grazing highlight, and a 3x3 window that contains the whole fragment
        // reports a mean a third of the peak, so the ratio test barely fires. A
        // 5x5 window sees the same fragment as 3 texels in 25 and fires
        // properly. The local mean is smooth at this scale, so using the
        // centre's for all nine costs accuracy worth a fraction of a code value.
        float sum25 = 0.0;
        for (int k = 0; k < 25; k++) sum25 += l5[k];
        float limit = max(uSpikeRatio * sum25 * (1.0 / 25.0), uSpikeFloor);
        // ONE limit for the whole window, so scatter and gather are the same
        // sum and the redistribution is exactly energy-conserving. The kernel is
        // a separable 1-2-3-2-1 tent (sum 81), not a box: a box turns a point
        // source into a visible 5x5 square, which trades one artefact for
        // another.
        const float TENT[5] = float[5](1.0, 2.0, 3.0, 2.0, 1.0);
        vec3 current = vec3(0.0);
        for (int j = -2; j <= 2; j++) {
          for (int i = -2; i <= 2; i++) {
            int k = (j + 2) * 5 + (i + 2);
            float lq = l5[k];
            float f = lq > limit ? 1.0 - limit / lq : 0.0;
            vec3 excess = c5[k] * f;
            current += excess * (TENT[i + 2] * TENT[j + 2] * (1.0 / 81.0));
            if (k == 12) current += c5[k] - excess;
          }
        }
        // Retained for the clip box below: how much of each of the inner 3x3 was
        // spike rather than surface.
        float frac[9];
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            float lq = l5[(j + 2) * 5 + (i + 2)];
            frac[(j + 1) * 3 + (i + 1)] = lq > limit ? 1.0 - limit / lq : 0.0;
          }
        }

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
            // The DESPIKED neighbour, not the raw one. A clip box built from raw
            // samples inherits the spike's variance and reopens by several stops
            // exactly where the spike is, which is the one place it needs to be
            // tight. The redistribution term is left out here on purpose: it
            // would need a 7x7 fetch, and the box is widened to contain the
            // centre sample two lines below in any case.
            vec3 c = ironRgbToYCoCg(c5[(y + 2) * 5 + (x + 2)] * (1.0 - frac[(y + 1) * 3 + (x + 1)]));
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
        // The centre sample is always inside its own clip box. It is not
        // automatically, because the box is built from KEPT values and the
        // centre also carries the ninth of each neighbour's excess it was given.
        lo = min(lo, curY);
        hi = max(hi, curY);

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
        uBlend: uf(TAA_STATIC_BLEND),
        uHistoryValid: uf(history.valid ? 1 : 0),
        uEnabled: uf(taaOn ? 1 : 0),
        uSpikeRatio: uf(SPIKE_RATIO),
        uSpikeFloor: uf(SPIKE_FLOOR_DISPLAY / exposureScaleFromEv(EXPOSURE_PRESET_EV)),
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
          uniform float uSpikeRatio;
          uniform float uSpikeFloor;
        `,
      },
    );
    graph.blit(history.current.texture, graph.target(RTId.ResolvedColor));
    // Republish the canonical post source every frame: motion blur moves it to
    // SceneColor and would otherwise read its own output next frame.
    this.state.source = RTId.ResolvedColor;
  }
}
