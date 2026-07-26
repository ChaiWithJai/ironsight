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

/**
 * Toe lift — **0.012, down from 0.040, and this is the change that gives the
 * frame blacks at all.**
 *
 * §5.2 asks for "output black point 0.035–0.050 display", and 0.040 delivered
 * that literally: the term is `+lift · 2^(-16.6·d)`, so it is an ADDITIVE FLOOR
 * that every pixel in the frame receives. The consequence, measured by inverting
 * this whole chain numerically (see the ramp in AGX_RAMP_FIT for the method):
 * **no input radiance whatsoever could produce a code below 10.2, and everything
 * from −3.5 EV to −21 EV relative to mid grey landed on codes 10–16.** Our own
 * captures duly measured `below-display-8 = 0.000 %` on every shot in the roster.
 *
 * Then measure the corpus the spec was derived from. Across 60 `reference/
 * gameplay/` frames: **minimum luminance is 0 in every single one**, median p1 is
 * 5, median below-8 fraction is 2.37 % and the 90th percentile is 15 %. §5.2's
 * own evidence row concedes it — p0.1 measured 0 / 16 / 3 on its three frames,
 * i.e. two of the three sit BELOW the black point the same section specifies.
 * The 0.035–0.050 figure is where a real *surface* bottoms out; it was never a
 * floor under the whole image, and implementing it as one is what produced the
 * milky, no-blacks frame six independent critics opened with.
 *
 * 0.012 puts the floor at code 3 — inside §5.2's measured p0.1 range of 3–20, so
 * a genuine surface still never reaches code 0 and pure black stays reserved for
 * letterbox — while leaving the bottom fifteen codes reachable. Re-measured over
 * the shot roster it moves below-8 from 0.00 % to 0.6–1.5 % on the frames that
 * have shadowed content at all, against a corpus median of 2.4 % and §5.2's
 * ceiling of 5 %.
 */
export const GRADE_BLACK_LIFT = 0.012;

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
 *
 * **0.055, down from 0.15.** At k = 0.15 the knee reached far enough up the
 * curve to cost the §5.1 ramp thirteen codes at scene-linear 0.020 (25 → 12) and
 * eleven at 0.050 — i.e. it was not a black point any more, it was a second
 * contrast curve living in the bottom third of the range, and it is what put the
 * darkest 5 % of `post_chain` at code 21 against a §5.1 prediction of 36. At
 * 0.055 the whole rolloff is inside the bottom fifteen codes, which is where
 * §5.2's p0.1 = 3–20 target actually lives.
 */
export const GRADE_BLACK_POINT = 0.055;

/**
 * §5.2 contrast: a symmetric S about a pivot, in code space.
 *
 * **1.42 about a pivot of 0.47, up from 1.14 about 0.44 — and this is a
 * deliberate, measured deviation from §5.1's ramp table, made because §5.1 and
 * §5.2 cannot both be satisfied and §5.2's is the bold acceptance line.**
 *
 * The conflict, stated precisely. §5.1 gives a ten-stop scene-linear → display
 * ramp. §5.2 gives distribution targets: **p25–p75 inside 55–150** (an ~95-code
 * inter-quartile range) with p50 in 70–115, p1 in 5–30 and p99 in 195–248. A
 * transfer function that hits §5.1 exactly hands the output whatever range the
 * SCENE has; measured on our own roster the IQR came out 42–79 codes wide, i.e.
 * roughly half of §5.2's, with p1 at 18–69 against a target of 5–30. Measured on
 * 60 `reference/gameplay/` frames the same statistics run p25 43, p75 130
 * (IQR 87) and p1 5. §5.1's ramp is a fit to three frames; §5.2's bands and the
 * corpus agree with each other and disagree with the ramp.
 *
 * §5.2's warning against a "crushed punchy curve" is about the MIDTONE — "do not
 * centre the histogram" — and the S here is pivoted at 0.47 precisely so the
 * median does not move: measured across the roster p50 goes 96→89, 106→101,
 * 108→104, all still inside 70–115. What changes is the tails, which is what was
 * missing. Re-measured over the roster after the change:
 *
 * | | IQR width | mid-40 % band | below 8 | above 240 |
 * |---|---|---|---|---|
 * | before | 42–79 | 43–80 % | 0.00 % | 0.00–0.83 % |
 * | after  | 55–96 | 29–74 % | 0.6–1.5 % | 0.0–1.6 % |
 * | corpus | 87 (median) | 36 % (median) | 2.4 % | 0.20 % |
 *
 * The cost is that scene-linear 0.72 now lands on code 197 rather than §5.1's
 * 178. That is not free, but it is the direction §2.4 already points: §2.4's own
 * "display (post-grade)" column puts a 9 000 cd/m² horizon (scene-linear 1.69
 * under §2.1's exposure) at RGB(250, 232, 210), luma 234, where §5.1's ramp
 * predicts 212. §2.4 and the corpus want the top of the curve where this puts
 * it; §5.1 alone wants it 20 codes lower.
 *
 * The pivot moved 0.44 → 0.47 for one reason: at 0.44 the extra contrast pushed
 * p50 down by 12–14 codes on the darker shots and `light_cascades` fell out of
 * §5.2's 70–115 band entirely. 0.47 sits just above the roster's median code, so
 * the S spends its slope on the tails and leaves the median where it was.
 *
 * Endpoint-preserving and monotone by construction, with the pivot a fixed point:
 *
 *     u = d^g            g = ln(0.5)/ln(pivot)   → pivot maps to 0.5
 *     v = u^c / (u^c + (1-u)^c)                  → symmetric sigmoid at 0.5
 *     d = v^(1/g)                                → 0.5 maps back to pivot
 */
export const GRADE_CONTRAST_PIVOT = 0.47;
export const GRADE_CONTRAST = 1.42;

/**
 * **The bloom threshold, in scene-linear-after-exposure — derived from the curve
 * above rather than copied out of §6.1, because §6.1's number was written
 * against a different tonemapper's white point.**
 *
 * §6.1 states the threshold twice and the two statements are only consistent if
 * you know which curve is in play: "scene-linear 1.05" and "(≈ display 0.90)".
 * Under this chain scene-linear 1.05 is display 0.77, not 0.90 — AgX puts
 * display white at scene-linear 16.3, where a Reinhard-class curve puts it at
 * about 1. So the literal 1.05 was thresholding two thirds of a stop lower than
 * §6.1's own display-referred intent, and the sky went over it: a golden-hour
 * sky sits at +2.9 EV over mid grey, i.e. scene-linear 1.3, so **half the frame
 * was feeding the pyramid** and the result was the uniform milky veil the
 * round-2 critics measured on `sky_golden` — the exact failure §6.1 legislates
 * against ("a fully blown 240–250 sky does not bloom onto the buildings in front
 * of it", "bright diffuse surfaces DO NOT BLOOM").
 *
 * 2.30 is the scene-linear value this chain maps to display 240, solved off the
 * composed curve (0.18→106, 1.44→227, 2.88→244; log-interpolating for 240 gives
 * 1.44·2^0.69 = 2.32). Everything §6.1 names as a legitimate bloom source is
 * orders of magnitude above it — the sun disc is 1.6e7 cd/m², about 3 000 after
 * exposure — and every diffuse surface in the map, sky included, is below it.
 *
 * Re-derive this whenever the curve moves; it is a property of the curve.
 */
export const BLOOM_THRESHOLD_LINEAR = 2.30;

/** `ln(0.5)/ln(pivot)` — the warp that puts the pivot on the sigmoid's centre. */
const GRADE_S_WARP = Math.log(0.5) / Math.log(GRADE_CONTRAST_PIVOT);

/*
 * THE SHOULDER IS AgX'S, AND THERE IS NO SECOND ONE. Read this before adding a
 * gain wheel back.
 *
 * A previous revision of this file carried a luminance-ramped +20 % gain
 * followed by a C¹ soft clip at 0.80, added to fix a p99 that sat at 175–182
 * against §5.2's 195–248. Measured end to end on a synthetic ramp, that pair did
 * this to the §5.1 transfer function:
 *
 * | scene-linear | §5.1 | with the gain+clip | now |
 * |---|---|---|---|
 * | 0.020 |  25 |  12 |  21 |
 * | 0.180 | 110 | 111 | 110 |
 * | 0.720 | 178 | 207 | 186 |
 * | 1.440 | 205 | 234 | 215 |
 * | 5.800 | 243 | 246 | 246 |
 * | 16.30 | 255 | 248 | 255 |
 *
 * Two defects, both of them exactly what the round-1 critics measured. The
 * curve's CEILING WAS 251, so no scene value however large could produce a white
 * pixel and the frame could not clip — "zero pure-white pixels in the entire
 * image", on a shot with the sun in it. And four and a half stops of scene range
 * (0.72 → 16.3) were crushed into 41 code values, which is the compressed,
 * upper-midtone-heavy histogram the same critics described as "the whole frame
 * floats in a bright, compressed midtone".
 *
 * The p99 the gain existed to fix was never a curve problem: `post_chain`'s
 * scene-linear p99 was 0.67, and 0.67 IS code 175 on the §5.1 ramp. The frame
 * had no highlights because the camera was pointed 180° away from the sun (see
 * `src/shots/render.ts`), and a tone curve cannot invent range the scene does
 * not have. Lifting the top of the curve to hide that traded a correct
 * tonemapper for a filter.
 *
 * AgX's own shoulder is the shoulder: it puts scene 16.3 on display 255 and
 * desaturates toward white on the way, which is §5.1's requirement verbatim.
 */

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
/**
 * **2.2, down from 3.0 — a direct consequence of GRADE_CONTRAST going to 1.42.**
 *
 * `ironContrastS` runs PER CHANNEL, so raising it raises chroma as well as
 * contrast; the two knobs are not independent and the vibrance was fitted
 * against the old, flatter curve. Measured on the roster immediately after the
 * contrast change, the §5.3 peak bucket (48–96) came out at 0.51 / 0.57 / 0.60
 * against §5.3's 0.40–0.55, and §5.4's B−R at 96–144 reached −70 against a
 * −48…−24 target. 2.2 scales the chroma multiplier by 0.83 and lands the peak
 * bucket at 0.43–0.50, inside §5.3, without touching the SHAPE — the boost still
 * dies above L 0.86 and the desaturation term still owns everything over 216.
 */
export const GRADE_SAT_BOOST = 2.2;
const GRADE_SAT_LO = 0.12;
/**
 * 0.86, up from 0.70 — i.e. the boost now reaches into the 144–192 and 192–216
 * buckets instead of dying at 178.
 *
 * §5.3's target table is a per-bucket floor as well as a ceiling, and measured on
 * `post_chain` every bucket from 48 to 216 sat UNDER it: 0.284 / 0.207 / 0.086 /
 * 0.065 against 0.40–0.55 / 0.25–0.50 / 0.15–0.34 / 0.08–0.24. Ending the ramp at
 * 0.70 meant the two upper-midtone buckets — 58 % of that frame — got a boost of
 * 1.02 and were effectively ungraded.
 *
 * It still dies well before §5.3's collapse: at display 217 the descending ramp
 * is down to 0.004, so the 216–240 and 240+ buckets (measured 0.077 and 0.051,
 * both already inside the 0.05–0.16 and 0.02–0.09 bands) are untouched and the
 * desaturation term owns them alone.
 */
const GRADE_SAT_HI = 0.86;
const GRADE_VIBRANCE_LO = 0.15;
const GRADE_VIBRANCE_HI = 0.60;

/**
 * Transfer functions + luminance + YCoCg. Included by every pass that touches
 * colour; YCoCg is here rather than in `fullscreen.ts` because TAA's variance
 * clip is a COLOUR operation and belongs to the same vocabulary.
 */
export const GLSL_COLOR_COMMON = /* glsl */ `
float ironLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/**
 * Replace a non-finite or absurd radiance with black.
 *
 * WHY THIS IS NOT PARANOIA. A single NaN texel anywhere in SceneColor is a
 * WHOLE-FRAME failure, not a local one, because the auto-exposure meters a
 * global log-average: the NaN propagates through the reduction to greyLuminance
 * to ev to exposureScale, every pixel is then multiplied by NaN, and AgX's
 * terminal clamp(x, 0.0, 1.0) returns 1.0 for a NaN operand on the drivers we
 * ship against. The frame comes back UNIFORM WHITE with a vignette on it — no
 * geometry, no clue where the NaN was, and identical for every camera in the
 * roster, which is exactly how it presented when a parallel lane briefly landed
 * one. The taa.resolve pass already carries the same guard on its history for
 * the same reason; this is the other half of it.
 *
 * Written as a NEGATED comparison on purpose: every comparison against NaN is
 * false, so !(x < BIG) is the portable NaN test and isnan() (GLSL ES 3.00, and
 * optional in practice) is not needed.
 *
 * The 1e12 ceiling is nine orders of magnitude above the brightest thing the
 * scene legitimately contains — LOOK_SPEC §2.2's sun disc at 1.6e7 cd/m² — so it
 * cannot fire on real content.
 */
vec3 ironSanitize(vec3 c) {
  bvec3 ok = bvec3(!(c.r < -1.0 || !(c.r < 1.0e12)),
                   !(c.g < -1.0 || !(c.g < 1.0e12)),
                   !(c.b < -1.0 || !(c.b < 1.0e12)));
  return mix(vec3(0.0), max(c, vec3(0.0)), vec3(ok));
}

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
 *   §5.2 contrast        — a small S about a fixed pivot. There is NO second
 *                          shoulder after it; see GRADE_SHOULDER's obituary
 *                          above for the measurements that removed one.
 *   §5.2 black level     — a toe lift that dies out by code 46 so it cannot
 *                          touch the ramp fit, and which sets where black sits
 *   §5.3 saturation      — the defining curve's SHAPE verbatim, at an amplitude
 *                          fitted to §5.3's target table, weighted by the pixel's
 *                          own chroma (vibrance) and applied as a chroma scale
 *                          about luma so it cannot move the histogram
 *   §5.4 split tone      — a 3-way corrector inside the spec's ±0.03–0.06, with
 *                          weight shapes fitted to §5.4's B−R-by-bucket row
 *                          rather than to the wheel names. The offsets stay
 *                          small on the SHADOW side on purpose: the frame's
 *                          warmth is supposed to come from golden-hour lighting
 *                          on sandstone, and a LUT that manufactures it instead
 *                          turns every shadow blue including the bounce-warmed
 *                          ones, which §5.4 calls a defect.
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

  // Toe: +0.012 at black (code 3), +0.0006 by code 46, nothing above. Small
  // enough that the bottom fifteen codes stay REACHABLE — see GRADE_BLACK_LIFT
  // for the measurement that says an additive floor here is what removed the
  // frame's blacks — and large enough that a real surface still never lands on
  // code 0, which is reserved for letterbox bars.
  d += ${GRADE_BLACK_LIFT.toFixed(4)} * exp2(-d * 16.6);

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
  // .toFixed(3), and it is not cosmetic. GRADE_SAT_BOOST is 3.0, and JS
  // interpolates that as the string "3" — so this line emitted \`1.0 + 3 * vib\`,
  // an int-times-float in GLSL ES 3.0, which is a hard compile error. The grade
  // program then failed to link and EVERY shot in the repo came back pure white.
  // Any constant in this file that happens to land on a whole number has the same
  // trap waiting for it; formatting at the interpolation site is what closes it.
  float boost = 1.0 + ${GRADE_SAT_BOOST.toFixed(3)} * vib
    * (1.0 - smoothstep(${GRADE_SAT_LO}, ${GRADE_SAT_HI}, L))
    * smoothstep(0.02, 0.12, L);
  // Chroma scale about luma — boosting and desaturating are the same operation
  // with the multiplier either side of 1, and neither may move L.
  d = vec3(L) + (d - vec3(L)) * (boost * (1.0 - w * 0.88));

  // --- §5.4 split tone --------------------------------------------------
  // The weight SHAPES matter as much as the offsets, because §5.4's target is a
  // B−R-by-luma-bucket curve that PEAKS at display 96–144 and eases back to
  // near-neutral at both ends: −4…+6 at 0–24, −48…−24 at 96–144, −22…−8 at
  // 216–240, −10…0 above 240. A monotone smoothstep(0.70, 1.0) highlight weight
  // — which is what used to be here — puts its maximum on the one bucket the
  // spec wants neutral, i.e. it tints the sun disc and leaves the 192–216 band,
  // where the warmth actually belongs, untouched. Hence the roll-off term.
  float shadowW = 1.0 - smoothstep(0.0, 0.25, L);
  float highW = smoothstep(0.58, 0.86, L) * (1.0 - 0.55 * smoothstep(0.90, 1.0, L));
  float midW = (1.0 - shadowW) * (1.0 - highW);
  d += vec3(-0.010, -0.004, 0.014) * shadowW;
  // Midtone gamma at 0.6× §5.4's stated value. §5.4 is explicit that the warmth
  // is supposed to be EARNED from golden-hour light on sandstone and that a LUT
  // which manufactures it is a defect; when this was written the lighting was
  // still neutral and the full value was carrying the whole load. It no longer
  // is — measured on the current roster the midtone B−R already runs −50 to −70
  // against §5.4's −48…−24, i.e. the scene now over-delivers — so the corrector
  // steps back rather than stacking on top of it.
  vec3 gamma = vec3(0.018, 0.004, -0.024) * midW;
  d = pow(max(d, vec3(0.0)), 1.0 / (1.0 + gamma));
  // Highlight gain at the top of §5.4's stated ±0.03–0.06 envelope rather than
  // its bottom. Measured on round-1 frames the highlights ran COOL — level_alpha
  // read B−R +11.7 at 144–192 and +4.6 at 192–216 against targets of −42…−20 and
  // −30…−14 — because the bright end of a hazy frame is sky, and sky is blue. A
  // ±0.014 corrector moves that by five codes and is invisible; this moves it by
  // fifteen, which is the whole width of the miss that a LUT is entitled to fix.
  // The rest has to come from the aerial-perspective in-scatter carrying the sun
  // chroma, which is not this file's to set.
  d *= 1.0 + vec3(0.038, 0.010, -0.034) * highW;

  return ironSrgbDecode(clamp(d, 0.0, 1.0));
}
`;
