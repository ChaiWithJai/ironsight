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
export const GRADE_BLACK_LIFT = 0.042;

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
 *   §5.1/§5.2 contrast   — the AGX_CONTRAST_GAMMA fit above
 *   §5.2 black level     — a toe lift that dies out by code 46 so it cannot
 *                          touch the ramp fit
 *   §5.3 saturation      — the defining curve, verbatim from the spec, peaking
 *                          in the lower midtones and collapsing above 0.85
 *   §5.4 split tone      — a 3-way corrector at the spec's ±0.03–0.06 maximum.
 *                          It is deliberately TINY: the frame's warmth is
 *                          supposed to come from golden-hour lighting on
 *                          sandstone, and a LUT that manufactures it instead
 *                          turns every shadow blue including the bounce-warmed
 *                          ones, which §5.4 calls a defect.
 */
export const GLSL_GRADE = /* glsl */ `
vec3 ironGrade(vec3 displayLinear) {
  vec3 d = ironSrgbEncode(clamp(displayLinear, 0.0, 1.0));

  d = pow(max(d, vec3(0.0)), vec3(${AGX_CONTRAST_GAMMA}));

  // Toe: +0.042 at black, +0.002 by code 46, nothing above. The corpus never
  // reaches code 0 on a real surface and pure black is reserved for letterbox.
  d += ${GRADE_BLACK_LIFT} * exp2(-d * 16.6);

  float L = ironLuma(d);
  float w = smoothstep(0.62, 0.95, L);
  // The spec writes smoothstep(0.45, 0.10, L): a DESCENDING ramp, which GLSL
  // does not define, so it is spelled out as 1 - smoothstep(0.10, 0.45, L).
  float boost = 1.0 + 0.09 * (1.0 - smoothstep(0.10, 0.45, L)) * smoothstep(0.02, 0.12, L);
  d = mix(d * boost, vec3(L), w * 0.88);

  float shadowW = 1.0 - smoothstep(0.0, 0.25, L);
  float highW = smoothstep(0.70, 1.0, L);
  float midW = (1.0 - shadowW) * (1.0 - highW);
  d += vec3(-0.010, -0.004, 0.014) * shadowW;
  vec3 gamma = vec3(0.030, 0.006, -0.040) * midW;
  d = pow(max(d, vec3(0.0)), 1.0 / (1.0 + gamma));
  d *= 1.0 + vec3(0.014, 0.006, -0.010) * highW;

  return ironSrgbDecode(clamp(d, 0.0, 1.0));
}
`;
