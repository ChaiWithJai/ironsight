/**
 * Pass 23 — bloom. OWNER: RCORE.
 *
 * **The threshold is high, and this is measured, not a preference.** LOOK_SPEC
 * §6.1: a diffuse white letter at display 224 sitting on a display-42 background
 * lifts that background by ~5/255, and a fully blown 240–250 sky does not bloom
 * onto the buildings in front of it. Bright diffuse surfaces DO NOT BLOOM. Only
 * genuine over-range emitters — the sun disc, fire cores, muzzle flash, specular
 * pinpricks on water — are allowed to bleed, and a global glow over the frame is
 * the rubric's automatic fail on Axis 4.
 *
 * The threshold is expressed in scene-linear AFTER exposure, so it is 1.05 (≈ a
 * quarter stop over display white) whether the frame is a 48 000 lx exterior or
 * a cellar. That is the whole reason exposure runs before bloom.
 *
 * **The threshold is applied per TAP, at full resolution, before any averaging.**
 * Thresholding a downsampled image instead is the classic mistake: a two-pixel
 * specular pinprick gets averaged with twelve dark neighbours, falls under the
 * threshold and never blooms at all, so the only things left bright enough to
 * survive are large bright areas — which are exactly the things that must NOT
 * bloom.
 *
 * The pyramid's geometric mip weights are what let one bloom produce both the
 * tight 1/r core halo AND the frame-wide veiling glare the corpus measures
 * around the sun. A single-radius gaussian mathematically cannot do both.
 */
import {
  PassOrder,
  RTId,
  type FrameCtx,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';
import {
  BLOOM_THRESHOLD_LINEAR,
  EXPOSURE_PRESET_EV,
  GLSL_COLOR_COMMON,
  exposureScaleFromEv,
} from '@/render/color';
import { ut, uf, uv2 } from '@/render/fullscreen';
import { BLOOM_MIP_WEIGHTS, bloomLevels, bloomMipId, bloomUpId } from '@/render/targets';
import type { PostChainState } from '@/render/passes/chain';

/**
 * Scene-linear, post-exposure. LOOK_SPEC §6.1 states this threshold twice — as
 * "1.05" and as "≈ display 0.90" — and the two only agree under a curve whose
 * white point is scene-linear 1. Ours is AgX, whose white point is 16.3, so the
 * literal number thresholded the SKY into the pyramid and produced the global
 * veil §6.1 exists to forbid. It is therefore derived from the curve, in
 * `color.ts`, where the curve lives.
 */
const THRESHOLD = BLOOM_THRESHOLD_LINEAR;
/** Soft knee, 0.55 EV wide, centred on the threshold. */
const KNEE = THRESHOLD * (Math.pow(2, 0.275) - Math.pow(2, -0.275)) * 0.5;
/**
 * Ceiling on what one texel may contribute to the pyramid, in exposed linear —
 * eight stops over display white.
 *
 * The sun disc is 1.6e7 cd/m², about 3000 after exposure. Uncapped, one texel of
 * it would drive the coarse mips white and veil the entire frame; capped, it
 * still produces the very low-slope veiling glare §6.1 measures around the sun
 * without turning the sky into a lightbox.
 *
 * LOOK_SPEC also asks for a Karis-averaged mip 0. DELIBERATE DEVIATION: with
 * this clamp in place the 1/(1+L) weight costs a GENUINE emitter — sun disc,
 * spark, specular pinprick — roughly a factor of ten, and the bloom disappears
 * with it. TAA's own tonemapped-weight blend runs four passes earlier and has
 * already removed the single-frame fireflies the Karis average exists to catch.
 */
const FIREFLY_CLAMP = 256;

/**
 * 13-tap dual-box downsample (Jimenez/COD). `FETCH(uv)` is defined by each
 * caller's prelude, so mip 0 can prefilter every tap and the deeper mips can
 * skip it.
 */
const DOWNSAMPLE_BODY = /* glsl */ `
  vec2 t = uTexel;
  vec3 a = FETCH(vUv + t * vec2(-2.0,  2.0));
  vec3 b = FETCH(vUv + t * vec2( 0.0,  2.0));
  vec3 c = FETCH(vUv + t * vec2( 2.0,  2.0));
  vec3 d = FETCH(vUv + t * vec2(-1.0,  1.0));
  vec3 e = FETCH(vUv + t * vec2( 1.0,  1.0));
  vec3 f = FETCH(vUv + t * vec2(-2.0,  0.0));
  vec3 g = FETCH(vUv);
  vec3 h = FETCH(vUv + t * vec2( 2.0,  0.0));
  vec3 i = FETCH(vUv + t * vec2(-1.0, -1.0));
  vec3 j = FETCH(vUv + t * vec2( 1.0, -1.0));
  vec3 k = FETCH(vUv + t * vec2(-2.0, -2.0));
  vec3 l = FETCH(vUv + t * vec2( 0.0, -2.0));
  vec3 m = FETCH(vUv + t * vec2( 2.0, -2.0));

  vec3 g0 = (d + e + i + j) * 0.25;
  vec3 g1 = (a + b + f + g) * 0.25;
  vec3 g2 = (b + c + g + h) * 0.25;
  vec3 g3 = (f + g + k + l) * 0.25;
  vec3 g4 = (g + h + l + m) * 0.25;
  vec3 result = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
`;

const PREFILTER_GLSL = /* glsl */ `
${GLSL_COLOR_COMMON}
uniform sampler2D uSrc;
uniform sampler2D uExposure;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;
uniform float uExposureFallback;

vec3 ironBloomPrefilter(vec2 uv) {
  float exposureScale = texelFetch(uExposure, ivec2(0, 0), 0).r;
  if (!(exposureScale > 0.0) || !(exposureScale < 1.0e12)) exposureScale = uExposureFallback;
  // NOT max(x, 0.0): that passes a NaN straight through, and min(NaN, uClamp)
  // four lines below returns uClamp on the drivers we ship against — i.e. a
  // single bad texel enters the pyramid at the FIREFLY_CLAMP ceiling and veils
  // the whole frame. ironSanitize is the NaN-safe form; see color.ts.
  vec3 c = ironSanitize(texture(uSrc, uv).rgb) * exposureScale;
  float brightness = max(c.r, max(c.g, c.b));
  // Soft knee: quadratic between T-K and T+K, linear above.
  float soft = clamp(brightness - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 1e-5);
  return min(c * contribution, vec3(uClamp));
}
#define FETCH(uv) ironBloomPrefilter(uv)
`;

export class BloomPass implements RenderPass {
  readonly id = 'post.bloom';
  readonly order = PassOrder.Bloom;
  readonly reads: readonly RTId[] = [RTId.ResolvedColor, RTId.Exposure];
  readonly writes: readonly RTId[] = [RTId.BloomPyramid];
  readonly budgetMs = 0.45;

  constructor(private readonly state: PostChainState) {}

  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const levels = bloomLevels(ctx.quality);
    const src = graph.target(this.state.source);

    // ---- level 0: prefilter every tap, then downsample --------------------
    graph.fullscreen(
      'post.bloom.threshold',
      `${DOWNSAMPLE_BODY}\n outColor = vec4(result, 1.0);`,
      {
        uSrc: ut(graph.texture(this.state.source)),
        uTexel: uv2(1 / src.width, 1 / src.height),
        uExposure: ut(graph.texture(RTId.Exposure)),
        uThreshold: uf(THRESHOLD),
        uKnee: uf(KNEE),
        uClamp: uf(FIREFLY_CLAMP),
        uExposureFallback: uf(exposureScaleFromEv(EXPOSURE_PRESET_EV)),
      },
      graph.target(bloomMipId(0)),
      { prelude: PREFILTER_GLSL },
    );

    // ---- levels 1..N-1: plain downsample ----------------------------------
    for (let i = 1; i < levels; i++) {
      const from = graph.target(bloomMipId(i - 1));
      graph.fullscreen(
        'post.bloom.down',
        `${DOWNSAMPLE_BODY}\n outColor = vec4(result, 1.0);`,
        { uSrc: ut(from.texture), uTexel: uv2(1 / from.width, 1 / from.height) },
        graph.target(bloomMipId(i)),
        {
          prelude: 'uniform sampler2D uSrc;\nuniform vec2 uTexel;\n#define FETCH(uv) texture(uSrc, uv).rgb',
        },
      );
    }

    // ---- upsample, accumulating the LOOK_SPEC §6.1 mip weights ------------
    // Renormalised to whatever level count the tier gives us: the SHAPE of the
    // fall-off is what the spec pins down, not the absolute sum.
    let weightSum = 0;
    for (let i = 0; i < levels; i++) weightSum += BLOOM_MIP_WEIGHTS[i];

    for (let i = levels - 1; i >= 0; i--) {
      const weight = BLOOM_MIP_WEIGHTS[i] / weightSum;
      const dest = i === 0 ? graph.target(RTId.BloomPyramid) : graph.target(bloomUpId(i));
      const mip = graph.target(bloomMipId(i));
      const hasCoarser = i < levels - 1;
      const coarserTex = hasCoarser ? graph.texture(bloomUpId(i + 1)) : null;
      graph.fullscreen(
        'post.bloom.up',
        /* glsl */ `
          vec3 acc = texture(uMip, vUv).rgb * uWeight;
          if (uHasCoarser > 0.5) {
            // 3x3 tent on the coarser accumulator: the filter that makes a
            // progressive pyramid read as one smooth halo instead of five
            // concentric rings.
            vec2 t = uTexel;
            vec3 s = texture(uCoarser, vUv + vec2(-t.x,  t.y)).rgb
                   + texture(uCoarser, vUv + vec2( 0.0,  t.y)).rgb * 2.0
                   + texture(uCoarser, vUv + vec2( t.x,  t.y)).rgb
                   + texture(uCoarser, vUv + vec2(-t.x,  0.0)).rgb * 2.0
                   + texture(uCoarser, vUv).rgb * 4.0
                   + texture(uCoarser, vUv + vec2( t.x,  0.0)).rgb * 2.0
                   + texture(uCoarser, vUv + vec2(-t.x, -t.y)).rgb
                   + texture(uCoarser, vUv + vec2( 0.0, -t.y)).rgb * 2.0
                   + texture(uCoarser, vUv + vec2( t.x, -t.y)).rgb;
            acc += s * (1.0 / 16.0);
          }
          outColor = vec4(acc, 1.0);
        `,
        {
          uMip: ut(mip.texture),
          uCoarser: ut(coarserTex ?? mip.texture),
          uTexel: uv2(1 / dest.width, 1 / dest.height),
          uWeight: uf(weight),
          uHasCoarser: uf(hasCoarser ? 1 : 0),
        },
        dest,
        {
          prelude: `
            uniform sampler2D uMip;
            uniform sampler2D uCoarser;
            uniform vec2 uTexel;
            uniform float uWeight;
            uniform float uHasCoarser;
          `,
        },
      );
    }
  }
}
