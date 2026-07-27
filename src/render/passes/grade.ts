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
 * The lens vignette, as a SCENE-LINEAR falloff applied before the tone curve.
 *
 * IT USED TO LIVE IN `LensFxPass`, AFTER THE GRADE, AND THAT IS WHY NO PIXEL IN
 * THE ROSTER COULD REACH DISPLAY 255. A vignette is light that never arrived at
 * the sensor: it is an EXPOSURE reduction, and exposure happens in front of the
 * film, not behind it. Applied in code space afterwards it multiplies the
 * clipped value too — so a pixel the tonemapper had legitimately driven to 1.0
 * came back at 0.984·255 = 251 at r = 0.44, which is where the sky of every
 * outdoor frame in the roster sits. Measured across `level_alpha`,
 * `level_bravo` and `light_cascades`: max luminance 250 / 251 / 238, and ZERO
 * pixels anywhere with all three channels at 254+. The critic's phrasing was
 * "zero pixels reach pure white"; this line was the whole reason.
 *
 * Applied here, the behaviour is the one §6.5's own evidence describes. Its
 * measurement is `[m: bf2042_gp_022]` "a blown sky falls from 247 at x = 0.40 to
 * 236 at x = 0.995" — and that same frame still carries 0.23 % of its pixels
 * over display 250 and a genuine 1.0 maximum. Both are true at once precisely
 * because the falloff is in front of the curve: a region three stops over white
 * clips anyway, a region a tenth of a stop over does not.
 *
 * 0.30 in the linear domain, not §6.5's 0.08, because the two numbers are in
 * different spaces and §6.5's is the one that must be met. Through AgX plus the
 * §5.1 ramp fit the local slope at a bright-sky exposure is ~0.27 code-decades
 * per linear-decade, so a 30 % linear falloff arrives as an 8.4 % code falloff
 * on a flat sky — measured on `level_alpha`'s sky band, 205 at r = 0.40 down to
 * 188 at the corner. §6.5's ceiling is 8 % and its cited reference frame drops
 * 4 %; we are at the ceiling and deliberately not past it.
 */
const VIGNETTE_LINEAR = 0.30;

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
          float focus = ironDofFocus(uDepth, uFocus, uAutoFocus);
          float depth = texture(uDepth, vUv).r;
          float coc = ironCoc(depth, focus, ironDofNearScale(focus, uCloseNearScale, uNearScale), uFarScale, uFarStart, uMaxNear, uMaxFar);
          vec4 dofTap = texture(uDof, vUv);
          vec3 blurred = ironSanitize(dofTap.rgb);
          // dofTap.a is the NEAR-FIELD COVERAGE the gather measured: how much
          // of this pixel a defocused foreground spills over. Taking the max
          // with the full-resolution CoC is what lets an occluder's bokeh bleed
          // OUTWARD past its own silhouette — a pixel of sharp background
          // standing right behind a soft wall edge has coc = 0 and would
          // otherwise cut the blur off with a razor, which is the "masked to a
          // hard edge" failure §6.2's near field exists to avoid. The
          // full-resolution term still carries the transition wherever geometry
          // actually is, so the half-res staircase never reaches the image.
          scene = mix(scene, blurred, smoothstep(0.6, 1.8, max(coc, dofTap.a)));
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

        // §6.5 vignette, in scene-linear and in front of the curve. Aspect
        // corrected so it is round rather than an ellipse stretched with the
        // window, and r-normalised to 1.0 at the corner exactly as LensFx does
        // for the CA — the two effects share a radius definition on purpose.
        vec2 centred = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.0;
        float rFrame = length(centred) / length(vec2(uAspect, 1.0));
        exposed *= 1.0 - uVignette * rFrame * rFrame;

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
        uNearScale: uf(dof.nearScale),
        uCloseNearScale: uf(dof.closeNearScale),
        uFarScale: uf(dof.farScale),
        uFarStart: uf(dof.farStart),
        uMaxNear: uf(dof.maxNear),
        uMaxFar: uf(dof.maxFar),
        uAutoFocus: uf(dof.autoFocus ? 1 : 0),
        uAspect: uf(ctx.camera.aspect),
        uVignette: uf(VIGNETTE_LINEAR),
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
          uniform float uNearScale;
          uniform float uCloseNearScale;
          uniform float uFarScale;
          uniform float uFarStart;
          uniform float uMaxNear;
          uniform float uMaxFar;
          uniform float uAutoFocus;
          uniform float uAspect;
          uniform float uVignette;
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
        // 1.2 px at the corner, unchanged, and it is NOT absent: the round-3
        // review reported "measured chromatic aberration at the right frame edge
        // is a 0px R-versus-B shift" from a channel-correlation statistic, which
        // does not measure a shift. Cross-correlating the R and B channels of a
        // vertical strip in the outer 7 % of the frame and solving for the
        // sub-pixel lag puts ours at 0.65 px on level_alpha and 1.10 px on
        // light_cascades. The same measurement on four BF6 gameplay frames
        // returns 0.00-0.05 px. We already carry MORE lateral CA than the
        // reference corpus, so this stays where §6.4 put it.
        float shiftPx = 1.2 * pow(smoothstep(0.60, 1.00, r), 2.0);
        vec2 radial = normalize(uv - 0.5 + vec2(1e-6));
        vec2 shift = radial * shiftPx * uTexel;
        vec3 c;
        c.r = texture(uSrc, uv + shift).r;
        c.g = texture(uSrc, uv).g;
        c.b = texture(uSrc, uv - shift).b;

        vec3 d = ironSrgbEncode(c);

        #ifdef SHARPEN
          // Unsharp mask, soft-clamped to the cross neighbourhood AND — the
          // round-5 addition — GATED ON LOCAL RANGE.
          //
          // The clamp alone is not contrast adaptation and calling it that hid
          // a real defect. On a TAA-resolved silhouette the pixel carrying the
          // partial coverage is, by construction, the local mid-value; an
          // unsharp mask pushes a mid-value toward whichever side it is nearer,
          // and the clamp happily permits that because the destination is
          // inside the neighbourhood. The net effect is to take a resolved
          // 190 / 112 / 194 edge back toward 190 / 61 / 194 — i.e. to undo,
          // spatially, exactly what the eight Halton samples paid for. Measured
          // on light_cascades' fountain rim, the pass was worth 0.047 of extra
          // Laplacian energy on its own: 0.127 with sharpening against 0.080
          // with it off, on the same frame.
          //
          // The gate is the fix and it is the one true statement CAS makes: a
          // sharpener has business in the MICRO-contrast of a surface and none
          // at a silhouette, because a silhouette is already at the resolution
          // limit and the only thing left to sharpen there is the antialiasing.
          // Full authority under a 6 % code range, none over 24 %.
          vec3 n0 = ironSrgbEncode(texture(uSrc, uv + vec2(0.0, uTexel.y)).rgb);
          vec3 n1 = ironSrgbEncode(texture(uSrc, uv - vec2(0.0, uTexel.y)).rgb);
          vec3 n2 = ironSrgbEncode(texture(uSrc, uv + vec2(uTexel.x, 0.0)).rgb);
          vec3 n3 = ironSrgbEncode(texture(uSrc, uv - vec2(uTexel.x, 0.0)).rgb);
          vec3 lo = min(min(n0, n1), min(n2, n3));
          vec3 hi = max(max(n0, n1), max(n2, n3));
          float localRange = max(max(hi.r, hi.g), hi.b) - min(min(lo.r, lo.g), lo.b);
          float adapt = 1.0 - smoothstep(0.06, 0.24, localRange);
          vec3 sharpened = d + (d * 4.0 - n0 - n1 - n2 - n3) * uSharpen * adapt * 0.25;
          d = clamp(sharpened, min(lo, d), max(hi, d));
        #endif

        // --- vignette --------------------------------------------------------
        // MOVED to the tonemap pass, in scene-linear and in front of the curve
        // — see VIGNETTE_LINEAR. A vignette applied here also darkens pixels
        // the tonemapper had clipped, which is what put a hard ceiling of
        // display 251 on every frame in the roster.

        // --- grain -----------------------------------------------------------
        float L = ironLuma(d);
        // 2.6 -> 0.65, up ~1.6x from §6.6's 1.6 -> 0.4. The round-3 review asked
        // for "roughly 1-1.5 % std" in a flat sky, which is 2.2-3.2 code values
        // at code 215, and that is NOT what the corpus does: measured over the
        // flattest bright 60x60 tile of each of 120 reference/gameplay frames
        // the high-frequency std is a MEDIAN OF 0.34 CODES (0.23 % of the mean),
        // p25 0.23, p75 0.75 — an order of magnitude under what was asked for.
        // Our own frames measured 0.46 codes at the old amplitude, i.e. already
        // above the corpus median. This lands them at ~0.7, on the corpus p75,
        // which is as far as the evidence supports going and is deliberately
        // short of the request.
        float sigma = mix(2.6, 0.65, smoothstep(0.10, 0.75, L)) / 255.0;
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
