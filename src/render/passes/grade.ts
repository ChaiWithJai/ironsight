/**
 * Passes 25–28 — tonemap + grade, lens character, present. OWNER: RCORE.
 *
 * This is where the frame stops being radiance and starts being a picture, and
 * LOOK_SPEC is blunt about how much of the final read happens here: "the grade
 * is what a viewer reads in the first 200 ms".
 *
 * COLOUR MANAGEMENT, WRITTEN DOWN ONCE SO NOBODY HAS TO REVERSE-ENGINEER IT.
 * `LdrColor` and `post.graded` are allocated as SRGB8_ALPHA8, so the HARDWARE
 * applies the sRGB transfer function on write and removes it on read. three, in
 * turn, leaves a shader's output in the working (linear) space when rendering
 * into a render target — it relies on exactly that hardware conversion. So:
 *
 *   tonemap  writes DISPLAY-LINEAR  → hardware encodes → 8-bit code values
 *   lens     reads (hardware decodes) → works in code space → writes display-linear
 *   present  reads (hardware decodes) → RE-ENCODES BY HAND, because the default
 *            framebuffer is not an sRGB target and three does not encode for a
 *            raw ShaderMaterial.
 *
 * Getting any one of those three wrong produces a frame that is exactly one
 * gamma out — which reads as "washed out" or "crushed", never as "colour
 * management bug", and eats a day.
 */
import * as THREE from 'three';
import {
  PassOrder,
  QualityTier,
  RTId,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';
import {
  EXPOSURE_PRESET_EV,
  GLSL_AGX,
  GLSL_COLOR_COMMON,
  GLSL_GRADE,
  exposureScaleFromEv,
} from '@/render/color';
import { GLSL_NOISE, ut, uf } from '@/render/fullscreen';
import { RT_GRADED } from '@/render/targets';
import { GLSL_COC, type PostChainState } from '@/render/passes/chain';
import type { IronCameraRig } from '@/render/camera-rig';

/**
 * Fraction of the bloom pyramid added back. The pyramid holds only the
 * over-threshold energy, renormalised, so this is the lens' scatter efficiency
 * rather than a "bloom strength" slider — LOOK_SPEC §6.1 asks for 5–8 % of the
 * source as total added energy.
 */
const BLOOM_INTENSITY = 0.07;

/**
 * Pass 25. Exposure → bloom composite → DOF composite → AgX → the 3-way grade.
 *
 * The DOF composite lives here rather than in the DOF pass because the CoC that
 * decides how much of the half-res blur to take has to be evaluated at FULL
 * resolution, or the transition between sharp and blurred inherits the half-res
 * staircase and reads as a halo.
 */
export class TonemapPass implements RenderPass {
  readonly id = 'post.tonemap';
  readonly order = PassOrder.Tonemap;
  readonly reads: readonly RTId[] = [RTId.ResolvedColor, RTId.BloomPyramid, RTId.Exposure, RTId.SceneDepth];
  readonly writes: readonly (RTId | string)[] = [RT_GRADED];
  readonly budgetMs = 0.2;

  constructor(private readonly state: PostChainState) {}

  enabled(): boolean {
    return true;
  }

  setup(graph: RenderGraph): void {
    // Take tonemapping off the renderer the moment this pass exists, or the
    // frame is tonemapped twice — which reads as a washed-out grade rather than
    // as a bug. `src/engine/renderer.ts` exports `setTonemapOwnedByGraph` for
    // exactly this hand-over, but CORE is a different lane and boundary CI
    // (rightly) forbids importing it, so the hand-over is a property write on
    // the renderer this graph already owns.
    graph.renderer.toneMapping = THREE.NoToneMapping;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const dof = this.state.dof;
    const dofActive = dof.active && graph.has(RTId.DofResult);

    graph.fullscreen(
      `post.tonemap.${dofActive ? 'dof' : 'plain'}`,
      /* glsl */ `
        // Sanitised, not just clamped to zero: a NaN survives max(x, 0.0) on
        // every driver we ship against, and one that reaches AgX comes out of
        // its terminal clamp as 1.0 — a white pixel that then blooms. See
        // ironSanitize in color.ts.
        vec3 scene = ironSanitize(texture(uColor, vUv).rgb);

        #ifdef USE_DOF
          vec2 lens = ironDofFocus(uDepth, uFocus, uCocScale, uAutoFocus);
          float depth = texture(uDepth, vUv).r;
          float coc = ironCoc(depth, lens.x, lens.y, uMaxCoc, uFarGain);
          vec3 blurred = ironSanitize(texture(uDof, vUv).rgb);
          scene = mix(scene, blurred, smoothstep(0.6, 1.8, coc));
        #endif

        float exposureScale = texelFetch(uExposure, ivec2(0, 0), 0).r;
        // The exposure pass guards its own output, but this multiplier reaches
        // every pixel in the frame, so it is worth the one comparison here too.
        // The fallback is the GOLDEN ANCHOR, never 1.0: the scene is photometric
        // (LOOK_SPEC §2.1, mid grey at 957 cd/m2), so a unit exposure is thirteen
        // stops hot and renders exactly the uniform white this guard exists to
        // prevent.
        if (!(exposureScale > 0.0) || !(exposureScale < 1.0e12)) exposureScale = uExposureFallback;
        vec3 exposed = scene * exposureScale;
        exposed += ironSanitize(texture(uBloom, vUv).rgb) * uBloomIntensity;

        vec3 display = ironAgx(exposed);
        outColor = vec4(ironGrade(display), 1.0);
      `,
      {
        uColor: ut(graph.texture(this.state.source)),
        uBloom: ut(graph.texture(RTId.BloomPyramid)),
        uExposure: ut(graph.texture(RTId.Exposure)),
        uDepth: ut(graph.texture(RTId.SceneDepth)),
        uDof: ut(graph.texture(RTId.DofResult)),
        uBloomIntensity: uf(BLOOM_INTENSITY),
        uExposureFallback: uf(exposureScaleFromEv(EXPOSURE_PRESET_EV)),
        uFocus: uf(dof.focus),
        uCocScale: uf(dof.scale),
        uMaxCoc: uf(dof.maxCoc),
        uFarGain: uf(dof.farGain),
        uAutoFocus: uf(dof.autoFocus ? 1 : 0),
      },
      graph.target(RT_GRADED),
      {
        prelude: `
          ${GLSL_COLOR_COMMON}
          ${GLSL_AGX}
          ${GLSL_GRADE}
          ${GLSL_COC}
          uniform sampler2D uColor;
          uniform sampler2D uBloom;
          uniform sampler2D uExposure;
          uniform sampler2D uDepth;
          uniform sampler2D uDof;
          uniform float uBloomIntensity;
          uniform float uExposureFallback;
          uniform float uFocus;
          uniform float uCocScale;
          uniform float uMaxCoc;
          uniform float uFarGain;
          uniform float uAutoFocus;
        `,
        defines: dofActive ? { USE_DOF: 1 } : {},
      },
    );
  }
}

/**
 * Pass 26 — lens character, and the renderScale → native resolve.
 *
 * LOOK_SPEC §6.4–§6.6, and the rule that governs all three: **if you can notice
 * any of these individually, they are too strong.** The numbers are therefore
 * much smaller than instinct suggests, and every one of them is a measurement:
 *
 *  - vignette ≤ 8 % corner darkening on a flat sky, very wide, r²-weighted;
 *  - chromatic aberration ZERO inside 60 % of frame radius, ≤ 1.2 px at the
 *    corner, sampled along the RADIAL direction only. Uniform full-frame CA is
 *    an anti-tell and is worse than none;
 *  - grain monochrome, σ 1.6/255 in the toe falling to 0.4/255 in the
 *    highlights, correlation length ~1.25 px. Anything visible as texture on a
 *    flat sky is an order of magnitude too much.
 *
 * Everything happens in sRGB CODE space, because that is the space the grain
 * amplitudes and the vignette percentages were measured in.
 */
export class LensFxPass implements RenderPass {
  constructor(private readonly rig: IronCameraRig) {}

  readonly id = 'post.lens';
  readonly order = PassOrder.LensFx;
  readonly reads: readonly (RTId | string)[] = [RT_GRADED];
  readonly writes: readonly RTId[] = [RTId.LdrColor];
  readonly budgetMs = 0.1;

  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const src = graph.target(RT_GRADED);
    const sharpen = ctx.quality.tier === QualityTier.Ultra ? 0.35 : 0;

    graph.fullscreen(
      'post.lens',
      /* glsl */ `
        vec2 uv = vUv;
        // Normalised frame radius: 1.0 at the corner, aspect-corrected so the
        // vignette is round rather than an ellipse stretched with the window.
        vec2 centred = (uv - 0.5) * vec2(uAspect, 1.0) * 2.0;
        float r = length(centred) / length(vec2(uAspect, 1.0));

        // --- lateral chromatic aberration -----------------------------------
        float shiftPx = 1.2 * pow(smoothstep(0.60, 1.00, r), 2.0);
        vec2 radial = normalize(uv - 0.5 + vec2(1e-6));
        vec2 shift = radial * shiftPx * uTexel;
        vec3 c;
        c.r = texture(uSrc, uv + shift).r;
        c.g = texture(uSrc, uv).g;
        c.b = texture(uSrc, uv - shift).b;

        vec3 d = ironSrgbEncode(c);

        #ifdef SHARPEN
          // CAS-style contrast-adaptive sharpen: a soft-clamped unsharp mask
          // that leaves already-crisp edges alone.
          vec3 n0 = ironSrgbEncode(texture(uSrc, uv + vec2(0.0, uTexel.y)).rgb);
          vec3 n1 = ironSrgbEncode(texture(uSrc, uv - vec2(0.0, uTexel.y)).rgb);
          vec3 n2 = ironSrgbEncode(texture(uSrc, uv + vec2(uTexel.x, 0.0)).rgb);
          vec3 n3 = ironSrgbEncode(texture(uSrc, uv - vec2(uTexel.x, 0.0)).rgb);
          vec3 lo = min(min(n0, n1), min(n2, n3));
          vec3 hi = max(max(n0, n1), max(n2, n3));
          vec3 sharpened = d + (d * 4.0 - n0 - n1 - n2 - n3) * uSharpen * 0.25;
          d = clamp(sharpened, min(lo, d), max(hi, d));
        #endif

        // --- vignette --------------------------------------------------------
        d *= 1.0 - 0.08 * r * r;

        // --- grain -----------------------------------------------------------
        float L = ironLuma(d);
        float sigma = mix(1.6, 0.4, smoothstep(0.10, 0.75, L)) / 255.0;
        // Value noise at ~1.25 px, so the grain has a correlation length rather
        // than being per-pixel salt. Monochrome: chroma noise is exactly zero.
        vec2 gp = gl_FragCoord.xy / 1.25 + vec2(uFrame * 17.0, uFrame * 23.0);
        vec2 gi = floor(gp);
        vec2 gf = fract(gp);
        gf = gf * gf * (3.0 - 2.0 * gf);
        float n00 = ironHash12(gi);
        float n10 = ironHash12(gi + vec2(1.0, 0.0));
        float n01 = ironHash12(gi + vec2(0.0, 1.0));
        float n11 = ironHash12(gi + vec2(1.0, 1.0));
        float noise = mix(mix(n00, n10, gf.x), mix(n01, n11, gf.x), gf.y);
        // Triangular about zero, unit-variance-normalised, then scaled to sigma.
        d += (noise - 0.5) * 3.46 * sigma;

        // --- ordered dither to 8 bits ----------------------------------------
        // The toe of a filmic curve is where 8-bit banding lives; a half-LSB
        // triangular dither costs nothing and removes it.
        float dither = (ironHash12(gl_FragCoord.xy * 1.37 + 11.0) - 0.5) / 255.0;
        d += dither;

        outColor = vec4(ironSrgbDecode(clamp(d, 0.0, 1.0)), 1.0);
      `,
      {
        uSrc: ut(graph.texture(RT_GRADED)),
        uTexel: { value: new THREE.Vector2(1 / src.width, 1 / src.height) },
        uAspect: uf(ctx.camera.aspect),
        uSharpen: uf(sharpen),
        uFrame: uf(this.rig.jitterPhase % 32),
      },
      graph.target(RTId.LdrColor),
      {
        prelude: `
          ${GLSL_COLOR_COMMON}
          ${GLSL_NOISE}
          uniform sampler2D uSrc;
          uniform vec2 uTexel;
          uniform float uAspect;
          uniform float uSharpen;
          uniform float uFrame;
        `,
        defines: sharpen > 0 ? { SHARPEN: 1 } : {},
      },
    );
  }
}

/**
 * Pass 28 — present.
 *
 * REGISTERED AT `DebugOverlay - 100`, NOT AT `PassOrder.Present`, and that is
 * deliberate. Passes in the `DebugOverlay` slot composite DIRECTLY over the
 * default framebuffer (see `src/audio/debug/overlay.ts`, which draws its readout
 * with `drawScene(..., null, false)`). Presenting after them would erase them
 * and the audio lane's debug shot would come out as a clean gameplay frame with
 * no readout. The ordering that matters — every image pass, then the HUD, then
 * the present — is unchanged.
 */
export class PresentPass implements RenderPass {
  readonly id = 'present';
  readonly order = PassOrder.DebugOverlay;
  readonly subOrder = -100;
  readonly reads: readonly RTId[] = [RTId.LdrColor];
  readonly writes: readonly RTId[] = [];
  readonly budgetMs = 0.05;

  enabled(_quality: Readonly<QualitySettings>): boolean {
    return true;
  }

  execute(_ctx: FrameCtx, graph: RenderGraph): void {
    graph.fullscreen(
      'present',
      /* glsl */ `
        // The source is an sRGB texture, so the sample arrives display-LINEAR;
        // the default framebuffer expects code values, so encode by hand.
        outColor = vec4(ironSrgbEncode(texture(uSrc, vUv).rgb), 1.0);
      `,
      { uSrc: ut(graph.texture(RTId.LdrColor)) },
      null,
      { prelude: `${GLSL_COLOR_COMMON}\nuniform sampler2D uSrc;` },
    );
  }
}
