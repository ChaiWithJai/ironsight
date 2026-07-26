/**
 * Colour science for the whole frame. OWNER: RCORE.
 *
 * Everything in `docs/LOOK_SPEC.md` §2.1 (exposure), §5.1 (tonemapper), §5.2
 * (black/white/contrast), §5.3 (saturation vs luminance) and §5.4 (split tone)
 * is implemented HERE, once, as GLSL source shared by the passes that need it.
 * No pass invents its own transfer function.
 *
 * THE THREE THINGS TO KNOW BEFORE EDITING
 * ---------------------------------------
 * 1. **Exposure is a scalar, not a look.** `exposureScale = 2^-EV`, and EV is
 *    defined as `log2(L_grey / 0.18)` where `L_grey` is the luminance of an 18 %
 *    surface under the scene's total illuminance. For the GOLDEN preset
 *    (16 700 lx total horizontal) `L_grey = 16700·0.18/π = 957 cd/m²`, so
 *    `EV = 12.376` and `exposureScale = 1.88e-4` — which is exactly the
 *    `toneMappingExposure` LOOK_SPEC §1 asks for. The whole point of writing it
 *    this way is that the number is DERIVED and can be re-derived when the sun
 *    moves, instead of being dialled by eye.
 *
 * 2. **The grade runs in sRGB-ENCODED display space**, because every number in
 *    LOOK_SPEC §5.2–§5.4 is a measurement of an 8-bit code value. Doing the
 *    saturation curve in linear light and hoping is how you miss the targets by
 *    a stop. The tonemap pass therefore decodes back to display-linear at the
 *    very end, and the hardware sRGB framebuffer re-encodes it: net result, the
 *    exact code values this file computed.
 *
 * 3. **The contrast exponent is a fit, not a taste.** three's AgX sits
 *    consistently ABOVE the §5.1 ramp (it puts scene 0.18 at code 128 rather
 *    than 110). A single gamma of 1.2143 applied in code space maps it onto that
 *    ramp to within ±1.5 codes at every one of the ten measured stops — see the
 *    table in `AGX_RAMP_FIT` below. That is the "contrast curve" §5.2 asks for.
 */

/**
 * GOLDEN preset exposure. `L_grey = E_total · 0.18/π = 16700 · 0.18/π = 957`,
 * `EV = log2(957/0.18) = 12.376`, `2^-12.376 = 1.88e-4`. LOOK_SPEC §1/§2.1.
 *
 * HAZE (1.73e-4 → EV 12.53) and COMBAT (2.40e-4 → EV 12.02) both sit inside the
 * ±0.75 EV auto-exposure clamp around this anchor, which is why one anchor is
 * enough for all three shipping presets.
 */
export const EXPOSURE_PRESET_EV = 12.376;

/** ±0.75 EV, LOOK_SPEC §2.1. Auto-exposure may not leave this window. */
export const EXPOSURE_CLAMP_EV = 0.75;

/**
 * How far the METERED EV may sit from the preset before we conclude the scene is
 * not in photometric units at all and stop trusting the preset.
 *
 * This exists because lighting and rendering land in parallel: until the sun is
 * a real 48 000 lx `DirectionalLight`, freezing the shot to 1.88e-4 renders a
 * black PNG. Six stops is far outside any legitimate weather/time-of-day
 * variation and comfortably inside the ~13-stop gap between "intensity 3.4" and
 * "intensity 48 000", so the test cannot misfire on a real scene.
 */
export const EXPOSURE_UNIT_SANITY_EV = 6.0;

/** Auto-exposure adaptation half-life in seconds (LOOK_SPEC §2.1 / P22). */
export const EXPOSURE_ADAPT_SECONDS = 0.8;

/** `2^-EV`. The multiplier a scene-linear radiance is scaled by before AgX. */
export function exposureScaleFromEv(ev: number): number {
  return Math.pow(2, -ev);
}

/** Inverse of {@link exposureScaleFromEv}. */
export function evFromExposureScale(scale: number): number {
  return -Math.log2(Math.max(scale, 1e-30));
}

/**
 * The measured fit of three's AgX onto the LOOK_SPEC §5.1 ramp, kept next to the
 * exponent that produces it so a future change can be re-checked in a minute.
 *
 * | scene-linear | AgX code | ×^1.2143 | §5.1 target |
 * |---|---|---|---|
 * | 0.020 |  36.7 |  24.2 |  25 |
 * | 0.050 |  70.1 |  53.1 |  52 |
 * | 0.090 |  95.5 |  77.6 |  78 |
 * | 0.180 | 127.6 | 110.0 | 110 |
 * | 0.360 | 159.8 | 146.9 | 145 |
 * | 0.720 | 189.5 | 177.8 | 178 |
 * | 1.440 | 214.2 | 206.3 | 205 |
 * | 2.900 | 232.6 | 228.1 | 228 |
 * | 5.800 | 244.2 | 242.0 | 243 |
 * | 16.30 | 254.6 | 254.5 | 255 |
 */
export const AGX_CONTRAST_GAMMA = 1.2143;

/** Toe lift. LOOK_SPEC §5.2 wants an output black point at display 0.035–0.050. */
export const GRADE_BLACK_LIFT = 0.040;

/**
 * THE BLACK POINT, and why it exists as a separate control from the toe lift
 * above — they pull in opposite directions and both are required.
 *
 * `GRADE_BLACK_LIFT` says *where display black sits* (§5.2: 0.035–0.050, so a
 * real surface never reaches code 0). It does nothing about *what lands there*.
 * Measured on our own frames before this pass existed, the darkest 0.1 % of the
 * image sat at code 50–130 against a §5.2 target of 3–20: the toe was lifted
 * onto a floor nothing ever reached, which is the milky, filter-like wash a
 * critic picks out of a line-up instantly.
 *
 * It is a SHARP-KNEE rolloff, `L / (1 + (k/L)^4)`, applied on LUMINANCE with the
 * result carried back to RGB as a scalar. Three properties, all of them load
 * bearing:
 *
 *  - **It converges on the identity, not on `x - k`.** The error is O((k/L)⁴), so
 *    at L = 2k the midtone has already lost only 6 %, and by L = 3k it is under
 *    1 %. A plain subtract-and-renormalise black point costs every midtone the
 *    same ~6 codes and walks the median out of §5.2's 70–115 band; this one
 *    spends its whole budget in the bottom eighth of the range where the defect
 *    actually is.
 *  - **Zero derivative at the origin**, so shadow content COMPRESSES into the toe
 *    rather than clipping to void. LOOK_SPEC and the rubric both treat crushed
 *    blacks as a defect; a hard `max(L - k, 0)` would produce them, and the
 *    measured sub-display-8 fraction stays at 0.00 % against a 5 % ceiling.
 *  - **Luminance domain, not per channel.** Run per channel, the rolloff divides
 *    the small channel by much more than the large one and MANUFACTURES chroma in
 *    the toe — measured, it doubled shadow saturation to 0.62 against §5.3's
 *    0.40–0.55 ceiling. Saturation is §5.3's business and it is set there.
 */
export const GRADE_BLACK_POINT = 0.15;

/**
 * §5.2 contrast: a small symmetric S about a pivot, in code space.
 *
 * Deliberately SMALL (1.06). The heavy lifting of "wide range" is done by the
 * black point above and the shoulder below, which act on the two ends where the
 * measured defect was; a large S would also drag p25 and the median down with it
 * and §5.2 is explicit that the image "is **not** high-contrast — it is
 * wide-range with a dense, low-placed midtone. A frame pushed to a crushed punchy
 * curve reads as a filter, not a renderer."
 *
 * Endpoint-preserving and monotone by construction, with the pivot a fixed point:
 *
 *     u = d^g            g = ln(0.5)/ln(pivot)   → pivot maps to 0.5
 *     v = u^c / (u^c + (1-u)^c)                  → symmetric sigmoid at 0.5
 *     d = v^(1/g)                                → 0.5 maps back to pivot
 */
export const GRADE_CONTRAST_PIVOT = 0.44;
export const GRADE_CONTRAST = 1.06;

/** `ln(0.5)/ln(pivot)` — the warp that puts the pivot on the sigmoid's centre. */
const GRADE_S_WARP = Math.log(0.5) / Math.log(GRADE_CONTRAST_PIVOT);

/**
 * THE SHOULDER — the other half of "wide range", and the half that fixes p99.
 *
 * Measured before this pass: p99 sat at 175–182 against §5.2's 195–248. The top
 * of the frame was as unoccupied as the bottom. This is the gain wheel, ramped in
 * over luminance so it is a shoulder rather than an exposure change: nothing
 * below display 77 moves at all, the lift reaches its full 20 % by display 235,
 * and the whole thing runs through a C¹ soft clip at 0.80 so a bright sky is
 * compressed into the last fifth of the range instead of being pushed to 255.
 * The measured above-display-250 fraction stays at 0.000 % against §5.2's 0.30 %
 * ceiling, which is the test that "bright diffuse surfaces never clip".
 */
export const GRADE_SHOULDER = 0.20;
const GRADE_SHOULDER_LO = 0.30;
const GRADE_SHOULDER_HI = 0.92;
const GRADE_SHOULDER_CLIP = 0.80;

/**
 * §5.3 saturation. Three deliberate deviations from the section's code snippet,
 * all of them because the snippet and the table above it disagree once you run
 * the snippet on a real frame.
 *
 * 1. **Amplitude.** The snippet's `0.09` assumes the render already carries the
 *    corpus' chroma and only needs a nudge. Ours measured mean HSV saturation of
 *    0.13–0.21 in the 48–96 bucket against §5.3's 0.40–0.55 — a factor of three,
 *    not nine percent. §10's checklist line ("saturation peaks in luma bucket
 *    48–96 or 96–144 at 0.40–0.55") is the acceptance test and it is bold; the
 *    snippet illustrates the SHAPE, and the shape is preserved exactly — the
 *    boost dies above L 0.70 and the §5.3 desaturation term still collapses
 *    everything over display 216.
 * 2. **It is applied as a chroma scale about luma, not `rgb * boost`.** The
 *    snippet multiplies all three channels, which is an exposure change wearing a
 *    saturation label — invisible at 1.09, but at the amplitude this frame needs
 *    it moves the median by fifteen codes and walks straight out of §5.2's band.
 * 3. **It is a VIBRANCE, not a saturation** — weighted by `1 - smoothstep` of the
 *    pixel's own HSV saturation, so it has full authority on the flat, washed
 *    sandstone the defect is about and almost none on a pixel that is already at
 *    0.6. Without that weighting a single amplitude cannot serve both a
 *    monochrome-warm plaza (which needs ×2) and a deep warm shadow (which is
 *    already over the ceiling): measured across three shots it pulls the spread
 *    of the peak bucket from 0.37–0.61 down to 0.40–0.56.
 */
export const GRADE_SAT_BOOST = 2.2;
const GRADE_SAT_LO = 0.12;
const GRADE_SAT_HI = 0.70;
const GRADE_VIBRANCE_LO = 0.15;
const GRADE_VIBRANCE_HI = 0.60;

/**
 * Transfer functions + luminance + YCoCg. Included by every pass that touches
 * colour; YCoCg is here rather than in `fullscreen.ts` because TAA's variance
 * clip is a COLOUR operation and belongs to the same vocabulary.
 */
export const GLSL_COLOR_COMMON = /* glsl */ `
float ironLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 ironSrgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-8)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

vec3 ironSrgbDecode(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, step(c, vec3(0.04045)));
}

// YCoCg is the right space for TAA's neighbourhood clip: chroma and luma
// separate, so a clip that must be tight on luma (to kill flicker) can stay
// loose on chroma (to avoid desaturating thin bright edges).
vec3 ironRgbToYCoCg(vec3 c) {
  return vec3(
    0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
    0.5 * c.r - 0.5 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

vec3 ironYCoCgToRgb(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}
`;

/**
 * AgX, ported from three's `tonemapping_pars_fragment` so the graph's version and
 * `WebGLRenderer.toneMapping` cannot drift apart, with `toneMappingExposure`
 * lifted to a parameter because our exposure comes from a render target and not
 * from a renderer property.
 *
 * NOT ACES: the ACES RRT pushes warm sandstone into orange hue-clipping at the
 * top of the range, which is the "everything is orange" tell (LOOK_SPEC §5.1).
 */
export const GLSL_AGX = /* glsl */ `
const mat3 IRON_REC2020_TO_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182),
  vec3(-0.5876,  1.1329, -0.1006),
  vec3(-0.0728, -0.0083,  1.1187));
const mat3 IRON_SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));

vec3 ironAgxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 ironAgx(vec3 color) {
  const mat3 inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(
    vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323,  1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = IRON_SRGB_TO_REC2020 * max(color, vec3(0.0));
  color = inset * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - minEv) / (maxEv - minEv);
  color = clamp(color, 0.0, 1.0);
  color = ironAgxContrast(color);
  color = outset * color;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color = IRON_REC2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
`;

/**
 * The grade. Input and output are DISPLAY-LINEAR (i.e. post-AgX); the body works
 * in sRGB-encoded space because that is the space LOOK_SPEC measured.
 *
 * Stages, in order, each traceable to a section:
 *   §5.1      ramp fit   — the AGX_CONTRAST_GAMMA gamma above
 *   §5.2 black point     — the lift wheel pulled down. This is the stage that
 *                          fixes the milky frame: the darkest scene content is
 *                          mapped ONTO the output black point instead of
 *                          floating fifty codes above it.
 *   §5.2 contrast        — a small S about a fixed pivot
 *   §5.2 shoulder        — the gain wheel, ramped in over luminance, so the top
 *                          of the histogram is occupied too, then soft-clipped
 *   §5.2 black level     — a toe lift that dies out by code 46 so it cannot
 *                          touch the ramp fit, and which sets where black sits
 *   §5.3 saturation      — the defining curve's SHAPE verbatim, at an amplitude
 *                          fitted to §5.3's target table, weighted by the pixel's
 *                          own chroma (vibrance) and applied as a chroma scale
 *                          about luma so it cannot move the histogram
 *   §5.4 split tone      — a 3-way corrector inside the spec's ±0.03–0.06.
 *                          The chroma offsets are deliberately SMALL: the
 *                          frame's warmth is supposed to come from golden-hour
 *                          lighting on sandstone, and a LUT that manufactures it
 *                          instead turns every shadow blue including the
 *                          bounce-warmed ones, which §5.4 calls a defect. The
 *                          midtone gamma runs at 0.7× the spec's numbers for
 *                          exactly that reason — the §5.3 boost above already
 *                          expands the scene's own warm/cool separation, and the
 *                          two stacking overshoots §5.4's B−R row.
 */
export const GLSL_GRADE = /* glsl */ `
// Endpoint-preserving, monotone filmic S with a fixed pivot. See
// GRADE_CONTRAST_PIVOT for the derivation.
vec3 ironContrastS(vec3 d) {
  vec3 u = pow(clamp(d, 1e-5, 1.0), vec3(${GRADE_S_WARP}));
  vec3 a = pow(u, vec3(${GRADE_CONTRAST}));
  vec3 b = pow(max(1.0 - u, 1e-5), vec3(${GRADE_CONTRAST}));
  return pow(max(a / (a + b), 1e-5), vec3(${1 / GRADE_S_WARP}));
}

// C1 soft clip: identity below T, exponential approach to 1.0 above it. The
// shoulder can therefore push hard without ever putting a diffuse surface on 255.
vec3 ironSoftClip(vec3 x) {
  const float T = ${GRADE_SHOULDER_CLIP};
  vec3 over = max(x - T, vec3(0.0));
  return min(x, vec3(T)) + (1.0 - T) * (1.0 - exp(-over / (1.0 - T)));
}

vec3 ironGrade(vec3 displayLinear) {
  vec3 d = ironSrgbEncode(clamp(displayLinear, 0.0, 1.0));

  d = pow(max(d, vec3(0.0)), vec3(${AGX_CONTRAST_GAMMA}));

  // --- §5.2 black point -------------------------------------------------
  // L/(1 + (k/L)^4), on luminance, carried back as a scalar. Converges on the
  // identity a factor of two above k, so the midtone does not pay for it, and
  // has zero derivative at the origin, so nothing clips to void.
  float bpL = max(ironLuma(d), 1e-4);
  float bpT = ${GRADE_BLACK_POINT} / bpL;
  float bpT2 = bpT * bpT;
  d *= 1.0 / (1.0 + bpT2 * bpT2);

  d = ironContrastS(d);

  // --- §5.2 shoulder ----------------------------------------------------
  d *= 1.0 + ${GRADE_SHOULDER}
    * smoothstep(${GRADE_SHOULDER_LO}, ${GRADE_SHOULDER_HI}, ironLuma(d));
  d = ironSoftClip(d);

  // Toe: +0.040 at black, +0.002 by code 46, nothing above. The corpus never
  // reaches code 0 on a real surface and pure black is reserved for letterbox.
  d += ${GRADE_BLACK_LIFT} * exp2(-d * 16.6);

  // --- §5.3 saturation --------------------------------------------------
  float L = ironLuma(d);
  float w = smoothstep(0.62, 0.95, L);
  float chroma = (max(d.r, max(d.g, d.b)) - min(d.r, min(d.g, d.b)))
    / max(max(d.r, max(d.g, d.b)), 1e-4);
  // Vibrance weight: full authority on washed pixels, none on pixels already at
  // the top of §5.3's band.
  float vib = 1.0 - smoothstep(${GRADE_VIBRANCE_LO}, ${GRADE_VIBRANCE_HI}, chroma);
  // The spec writes smoothstep(0.45, 0.10, L): a DESCENDING ramp, which GLSL
  // does not define, so it is spelled out as 1 - smoothstep(lo, hi, L).
  float boost = 1.0 + ${GRADE_SAT_BOOST} * vib
    * (1.0 - smoothstep(${GRADE_SAT_LO}, ${GRADE_SAT_HI}, L))
    * smoothstep(0.02, 0.12, L);
  // Chroma scale about luma — boosting and desaturating are the same operation
  // with the multiplier either side of 1, and neither may move L.
  d = vec3(L) + (d - vec3(L)) * (boost * (1.0 - w * 0.88));

  // --- §5.4 split tone --------------------------------------------------
  float shadowW = 1.0 - smoothstep(0.0, 0.25, L);
  float highW = smoothstep(0.70, 1.0, L);
  float midW = (1.0 - shadowW) * (1.0 - highW);
  d += vec3(-0.010, -0.004, 0.014) * shadowW;
  vec3 gamma = vec3(0.021, 0.004, -0.028) * midW;
  d = pow(max(d, vec3(0.0)), 1.0 / (1.0 + gamma));
  d *= 1.0 + vec3(0.014, 0.006, -0.010) * highW;

  return ironSrgbDecode(clamp(d, 0.0, 1.0));
}
`;
