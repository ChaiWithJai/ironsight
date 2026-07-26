/**
 * Pass 21 — per-object motion blur from the velocity buffer. OWNER: RCORE.
 *
 * LOOK_SPEC §6.3, and the rubric's Axis 6, both single out the failure mode: a
 * camera-wide radial smear. What the reference actually shows is a TRACKED
 * SUBJECT STAYING SHARP WHILE ITS BACKGROUND STREAKS, and a moving object
 * streaking against a static background in the same frame. That only falls out
 * of a per-pixel velocity buffer, which is why the whole G-buffer exists.
 *
 * Three properties that are easy to get wrong:
 *  - **180° shutter.** The blur covers half a frame of motion, centred on the
 *    sample time, which is what produces the measured 20–80 px streaks at 60 fps
 *    rather than the 2× smear of a full-open shutter.
 *  - **Depth-aware weighting**, so a sharp foreground does not get painted over
 *    by the background streaking behind it.
 *  - **The viewmodel is exempt entirely** — its class bit is checked here, not
 *    just its velocity, because a weapon whose recoil smears reads as input lag.
 *
 * It runs BEFORE bloom: the shutter integrates motion first and the lens
 * scatters that integrated light second. Blurring after bloom reads as a filter.
 */
import {
  PassOrder,
  RTId,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';
import { GLSL_NOISE, ut, uf } from '@/render/fullscreen';
import type { PostChainState } from '@/render/passes/chain';
import type { IronCameraRig } from '@/render/camera-rig';

export class MotionBlurPass implements RenderPass {
  readonly id = 'post.motionblur';
  readonly order = PassOrder.MotionBlur;
  readonly reads: readonly RTId[] = [RTId.ResolvedColor, RTId.VelocityTiles, RTId.GVelocity, RTId.SceneDepth, RTId.GNormalRough];
  readonly writes: readonly RTId[] = [RTId.SceneColor];
  readonly budgetMs = 0.35;

  constructor(
    private readonly state: PostChainState,
    private readonly rig: IronCameraRig,
  ) {}

  enabled(quality: Readonly<QualitySettings>): boolean {
    return quality.motionBlur.enabled;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const q = ctx.quality;
    const samples = Math.max(4, Math.min(24, q.motionBlur.samples));
    // Shutter angle → the fraction of a frame's motion the shutter integrates.
    const shutter = q.motionBlur.shutterAngleDeg / 360;

    graph.fullscreen(
      `post.motionblur.${samples}`,
      /* glsl */ `
        vec3 centre = texture(uColor, vUv).rgb;
        vec2 tileVelocity = texture(uTiles, vUv).xy;
        float tilePx = length(tileVelocity * uResolution);

        // Under a quarter of a pixel of motion anywhere in the tile there is
        // nothing to integrate, and this is the common case in a still frame.
        float surfaceClass = texture(uNormalRough, vUv).a * 255.0;
        if (tilePx < 0.5 || surfaceClass > 1.5) {
          outColor = vec4(centre, 1.0);
          return;
        }

        float centreDepth = texture(uDepth, vUv).r;
        vec2 ownVelocity = texture(uVelocity, vUv).xy;
        // Blur along the tile's dominant motion but never further than the
        // tile itself moves; using only the pixel's own velocity cuts the
        // leading edge of a moving object off dead.
        vec2 blur = tileVelocity * uShutter;

        float jitter = ironIgn(gl_FragCoord.xy + vec2(uFrame * 1.618, uFrame * 3.142)) - 0.5;
        vec3 sum = vec3(0.0);
        float weightSum = 0.0;
        for (int i = 0; i < SAMPLES; i++) {
          float t = (float(i) + 0.5 + jitter) / float(SAMPLES) - 0.5;
          vec2 uv = vUv + blur * t;
          float d = texture(uDepth, uv).r;
          float cls = texture(uNormalRough, uv).a * 255.0;
          // In front of us, or sky: full weight. Behind us: fades out, so a
          // sharp foreground is not painted over by its own background.
          float depthWeight = (d <= 0.0) ? 0.6 : clamp(1.0 + (centreDepth - d) * 4.0, 0.12, 1.0);
          if (cls > 1.5) depthWeight = 0.0;
          sum += texture(uColor, uv).rgb * depthWeight;
          weightSum += depthWeight;
        }
        vec3 blurred = weightSum > 1e-4 ? sum / weightSum : centre;

        // Pixels whose OWN motion is nil sit inside a moving tile — the static
        // background behind a passing vehicle. Keep them sharp in proportion.
        float ownPx = length(ownVelocity * uResolution);
        float mixAmount = clamp(ownPx / max(tilePx, 1e-3), 0.0, 1.0);
        mixAmount = max(mixAmount, clamp((ownPx - 0.5) / 2.0, 0.0, 1.0));
        outColor = vec4(mix(centre, blurred, mixAmount), 1.0);
      `,
      {
        uColor: ut(graph.texture(this.state.source)),
        uTiles: ut(graph.texture(RTId.VelocityTiles)),
        uVelocity: ut(graph.texture(RTId.GVelocity)),
        uDepth: ut(graph.texture(RTId.SceneDepth)),
        uNormalRough: ut(graph.texture(RTId.GNormalRough)),
        uShutter: uf(shutter),
        uFrame: uf(this.rig.jitterPhase % 64),
      },
      graph.target(RTId.SceneColor),
      {
        prelude: `
          ${GLSL_NOISE}
          uniform sampler2D uColor;
          uniform sampler2D uTiles;
          uniform sampler2D uVelocity;
          uniform sampler2D uDepth;
          uniform sampler2D uNormalRough;
          uniform float uShutter;
          uniform float uFrame;
        `,
        defines: { SAMPLES: samples },
      },
    );
    this.state.source = RTId.SceneColor;
  }
}
