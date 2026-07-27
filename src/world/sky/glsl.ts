/**
 * Shared GLSL for the SKY lane.
 *
 * OWNER: SKY.
 *
 * Three consumers compile these strings: the bake shaders that raymarch the
 * transmittance / multiple-scattering / sky-view tables, the sky dome, and the
 * aerial-perspective chunk injected into every world surface. They share source
 * rather than each re-deriving the physics, because the one thing that must not
 * drift is the colour the far headland converges to versus the colour of the
 * sky immediately above it — a mismatch there is visible instantly and reads as
 * "the fog does not match the sky", which is the classic tell this lane exists
 * to eliminate.
 *
 * Units: radiance in cd/m² INSIDE these functions, scaled to renderer-linear by
 * `IRON_SKY_SCALE` at the very end of whichever shader uses them.
 */
import {
  ANCHOR,
  HAZE_CHANNEL,
  HAZE_ELEV_POW,
  HAZE_ELEV_POW_BROAD,
  HAZE_ELEV_POW_SUN,
  HAZE_FLOOR,
  HAZE_GROUND_BAND,
  HAZE_GROUND_OCC,
  HAZE_INSCATTER_BUILD,
  HAZE_INSCATTER_NEAR,
  HAZE_K,
  HAZE_P,
  HAZE_ROLLIN,
  HAZE_SCALE_HEIGHT,
  HAZE_TMIN,
  SKY_SCALE,
} from '@/world/sky/model';

const f = (n: number): string => {
  const s = n.toPrecision(8);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};
const v3 = (a: readonly number[] | ArrayLike<number>): string => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

/* ==========================================================================
 * 1. Planetary atmosphere — the physics the LUTs are baked from.
 * ========================================================================== */

/**
 * Rayleigh, Mie and ozone for a standard clear atmosphere, in m⁻¹.
 *
 * Rayleigh is the real λ⁻⁴ triple at 680/550/440 nm; Mie is grey in scattering
 * with a 1.11 extinction/scattering ratio (a real aerosol absorbs a little); the
 * ozone tent is what keeps the zenith from going purple at low sun, and leaving
 * it out is the single most common reason a hand-rolled Rayleigh sky looks
 * wrong at exactly the hour this game is set at.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
#define IRON_PI 3.14159265359

/**
 * EVERYTHING IN THIS BLOCK IS IN KILOMETRES, AND THAT IS NOT A STYLE CHOICE.
 *
 * In metres a planet radius squared is 4.0e13, which a 24-bit mantissa resolves
 * to about 5e6 — five thousand kilometres of error in the discriminant of every
 * ray/sphere intersection. The first build of this lane did the maths in metres
 * and the entire sky-view table came back zero because every ray decided it had
 * left the atmosphere immediately. In kilometres the same quantity is 4.0e7,
 * resolved to ~4, and the scalar (r, mu) forms below never square a radius
 * against a path length at all.
 */
const float IRON_RG = 6360.0;             // planet radius, km
const float IRON_RT = 6460.0;             // atmosphere top, km
const vec3  IRON_RAY_S = vec3(5.802e-3, 13.558e-3, 33.100e-3);   // per km
const float IRON_RAY_H = 8.0;
const float IRON_MIE_S = 3.996e-3;
const float IRON_MIE_E = 4.440e-3;
const float IRON_MIE_H = 1.2;
const vec3  IRON_OZO_A = vec3(0.650e-3, 1.881e-3, 0.085e-3);
/** Extraterrestrial solar illuminance, lux. Turns the unitless integral into cd/m². */
const float IRON_SOLAR_LX = 127000.0;

/** Densities at altitude h (KILOMETRES), x=Rayleigh y=Mie z=ozone. */
vec3 ironDensity(float h, float mieScale) {
  float r = exp(-h / IRON_RAY_H);
  float m = exp(-h / IRON_MIE_H) * mieScale;
  // Ozone as a 30 km-wide tent centred at 25 km — the standard piecewise fit.
  float o = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  return vec3(r, m, o);
}

vec3 ironExtinction(float h, float mieScale) {
  vec3 d = ironDensity(h, mieScale);
  return IRON_RAY_S * d.x + vec3(IRON_MIE_E) * d.y + IRON_OZO_A * d.z;
}

/**
 * Distance along a ray to a sphere of radius R, from a point at radius r whose
 * cos-zenith is mu. Negative when the ray misses or the sphere is behind.
 *
 * The discriminant is grouped as (R-r)(R+r) so the catastrophic cancellation of
 * R*R - r*r never happens: both factors are exact and their product carries the
 * full mantissa of a number that is genuinely small.
 */
float ironDistToSphere(float r, float mu, float R) {
  float disc = (R - r) * (R + r) + r * r * mu * mu;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -r * mu - s;
  float t1 = -r * mu + s;
  if (t1 < 0.0) return -1.0;
  return t0 > 0.0 ? t0 : t1;
}

/** Radius after travelling t km along a ray from (r, mu). */
float ironStepR(float r, float mu, float t) {
  return sqrt(max(1.0, t * t + 2.0 * r * mu * t + r * r));
}

/** Cos-zenith of the SUN at that new point, given nu = dot(viewDir, sunDir). */
float ironStepMuS(float r, float muS, float nu, float t, float rNew) {
  return clamp((r * muS + t * nu) / rNew, -1.0, 1.0);
}

/** Cos-zenith of the VIEW ray at that new point. */
float ironStepMu(float r, float mu, float t, float rNew) {
  return clamp((r * mu + t) / rNew, -1.0, 1.0);
}

/** True when the sun is below the local horizon at (r, muS). */
bool ironSunOccluded(float r, float muS) {
  // The horizon's cos-zenith at radius r; below it the ground is in the way.
  float horizon = -sqrt(max(0.0, 1.0 - (IRON_RG / r) * (IRON_RG / r)));
  return muS < horizon;
}

/** Rayleigh phase. */
float ironPhaseR(float c) { return (3.0 / (16.0 * IRON_PI)) * (1.0 + c * c); }

/** Henyey-Greenstein. LOOK_SPEC §3.2 fixes g = 0.72 for the haze forward lobe. */
float ironPhaseHG(float c, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (4.0 * IRON_PI * max(1e-4, d * sqrt(d)));
}

/**
 * Two-lobe Mie phase: a broad forward lobe plus a narrow aureole. A single HG
 * cannot be both 8° wide at the sun and still lift the whole sun-side horizon,
 * and the reference frames show both at once.
 */
float ironPhaseMie(float c, float g) {
  return mix(ironPhaseHG(c, g), ironPhaseHG(c, 0.94), 0.22);
}
`;

/* ==========================================================================
 * 2. Transmittance LUT parameterisation, shared by the baker and the sampler.
 * ========================================================================== */

export const TRANSMITTANCE_GLSL = /* glsl */ `
/**
 * (radius, cos view-zenith) → LUT uv. Bruneton's distance-to-horizon mapping,
 * with every squared radius written as a difference of factors so it survives
 * float32.
 */
vec2 ironTransmittanceUv(float r, float mu) {
  float H = sqrt(max(0.0, (IRON_RT - IRON_RG) * (IRON_RT + IRON_RG)));
  float rho = sqrt(max(0.0, (r - IRON_RG) * (r + IRON_RG)));
  float d = max(0.0, ironDistToSphere(r, mu, IRON_RT));
  float dMin = IRON_RT - r;
  float dMax = rho + H;
  return vec2(clamp((d - dMin) / max(1e-6, dMax - dMin), 0.0, 1.0), clamp(rho / max(1e-6, H), 0.0, 1.0));
}

/** Inverse of the above; the baker walks the table with it. */
void ironTransmittanceParams(vec2 uv, out float r, out float mu) {
  float H = sqrt(max(0.0, (IRON_RT - IRON_RG) * (IRON_RT + IRON_RG)));
  float rho = H * uv.y;
  r = sqrt(rho * rho + IRON_RG * IRON_RG);
  float dMin = IRON_RT - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}
`;

/* ==========================================================================
 * 3. The haze medium — aerial perspective, §3.2, and the analytic sky it
 *    converges to. Compiled into BOTH the dome and the world-surface chunk.
 * ========================================================================== */

export const HAZE_GLSL = /* glsl */ `
const float IRON_HAZE_K = ${f(HAZE_K)};
const float IRON_HAZE_P = ${f(HAZE_P)};
const float IRON_HAZE_D0 = ${f(HAZE_ROLLIN)};
const float IRON_HAZE_HS = ${f(HAZE_SCALE_HEIGHT)};
const float IRON_HAZE_FLOOR = ${f(HAZE_FLOOR)};
/** See HAZE_TMIN / HAZE_INSCATTER_* in model.ts for what these two are for. */
const float IRON_HAZE_TMIN = ${f(HAZE_TMIN)};
const float IRON_HAZE_IN_NEAR = ${f(HAZE_INSCATTER_NEAR)};
const float IRON_HAZE_IN_BUILD = ${f(HAZE_INSCATTER_BUILD)};
const float IRON_HAZE_GOCC = ${f(HAZE_GROUND_OCC)};
const float IRON_HAZE_GBAND = ${f(HAZE_GROUND_BAND)};
/** Horizon-band width, as an exponent. See HAZE_ELEV_POW in model.ts. */
const float IRON_HAZE_EPOW = ${f(HAZE_ELEV_POW)};
const float IRON_HAZE_EPOW_SUN = ${f(HAZE_ELEV_POW_SUN)};
const float IRON_HAZE_EPOW_BROAD = ${f(HAZE_ELEV_POW_BROAD)};
const vec3  IRON_HAZE_CH = ${v3(HAZE_CHANNEL)};
const vec3  IRON_ANCHOR_ZENITH = ${v3(ANCHOR.zenith)};
const vec3  IRON_ANCHOR_UPPER = ${v3(ANCHOR.elev30Anti)};
const vec3  IRON_ANCHOR_H_ANTI = ${v3(ANCHOR.horizonAnti)};
const vec3  IRON_ANCHOR_H_CROSS = ${v3(ANCHOR.horizonCross)};
const vec3  IRON_ANCHOR_H_SUN = ${v3(ANCHOR.horizonSun)};
const float IRON_SKY_SCALE = ${f(SKY_SCALE)};

/**
 * Optical depth of the boundary-layer haze over 'dist' metres of a ray running
 * from height 'y0' to height 'y1'. See 'model.ts' for the fit, for why the
 * exponent is 0.61 rather than the spec's two-term σ, and for why the roll-in
 * factor exists (short answer: k·d^p asserts an INFINITE σ at d = 0, and that
 * is what puts a veil on a wall five metres from the lens).
 */
vec3 ironHazeTau(float dist, float y0, float y1, float sigmaScale) {
  float yMid = 0.5 * (y0 + y1);
  float hf = IRON_HAZE_FLOOR + (1.0 - IRON_HAZE_FLOOR) * exp(-max(0.0, yMid) / IRON_HAZE_HS);
  float d = max(dist, 0.01);
  float rollIn = pow(d / (d + IRON_HAZE_D0), 1.0 - IRON_HAZE_P);
  float base = IRON_HAZE_K * pow(d, IRON_HAZE_P) * rollIn * hf * sigmaScale;
  return base * IRON_HAZE_CH;
}

/**
 * Multiplier on the haze density from the low-frequency structure real air has.
 *
 * The rubric's first calibration note is that no reference frame contains clear
 * air, and its complement — which is the part that is easy to miss — is that no
 * reference frame contains UNIFORM air either. Haze over water arrives in drifts
 * and streamers hundreds of metres across, so the same wall reads veiled at one
 * end and clear at the other. A perfectly smooth exponential veil is a fog
 * constant no matter how well its exponent is fitted, and it is one of the
 * things that reads as a draw-distance blanket rather than as weather.
 *
 * Three decorrelated sinusoids at 0.67 / 0.89 / 2.0 km, mean exactly 1.0, so the
 * §3.2 fit is unchanged on average and the CPU-side hazeTau() stays the right
 * answer for calibration. The height gate keeps it inside the boundary layer:
 * above ~200 m the air is genuinely well mixed and a modulation up there would
 * read as banding on the headland.
 *
 * Evaluated at the MIDPOINT of the eye→surface segment, which is the correct
 * single-sample stand-in for an integral of a field that varies far more slowly
 * than the path length.
 */
float ironHazeDrift(vec3 mid) {
  float a = sin(mid.x * 0.00710 + mid.z * 0.00430);
  float b = sin(mid.z * 0.00940 - mid.x * 0.00260 + 2.1);
  float c = sin((mid.x + mid.z) * 0.00310 + 4.7);
  float band = a * 0.45 + b * 0.35 + c * 0.20;
  float gate = exp(-max(0.0, mid.y) / 95.0);
  return 1.0 + 0.24 * band * gate;
}

/**
 * The radiance the haze in-scatter SATURATES to, in cd/m².
 *
 * Built from LOOK_SPEC §2.4's five measured directions rather than from a
 * gradient: hue is carried by the anchors and never by an elevation ramp, which
 * is the §3.1 test ("anything that changes hue with elevation reads as a
 * gradient"). Only the horizon triple changes with azimuth, which is what
 * produces the warm sun-side / cool seaward split the brief is built around.
 */
vec3 ironHazeRadiance(vec3 dir, vec3 sunDir, vec3 sunChroma, float turbidity, float overcast) {
  float up = clamp(dir.y, -1.0, 1.0);
  // THE EXPONENT IS 5, NOT 2.2, AND THAT IS THE ROUND-5 SEVERITY-10 FIX.
  // 2.2 is a horizon band forty degrees deep, so every first-person camera on
  // the roster framed nothing but horizon band and three rounds of critics
  // reported the result as "the zenith is achromatic". See HAZE_ELEV_POW in
  // model.ts for the arithmetic and for LOOK_SPEC §3.1's own measured column,
  // which puts the achromatic band at a few degrees rather than forty.
  //
  // THE min() IS LOAD-BEARING AND ITS ABSENCE WAS THE MILKY-FOREGROUND BUG.
  // This function is called by the aerial-perspective chunk with the WORLD
  // SURFACE's view direction, and every surface below the eyeline — which is
  // the whole lower half of a first-person frame, i.e. all the near geometry —
  // has dir.y < 0, so (1 - up) exceeds 1. mix() does not clamp: it happily
  // EXTRAPOLATES past the horizon anchor. At the bottom of a 55° frame
  // (dir.y ≈ −0.46) g reached 2.30 and the 9 000 cd/m² sunward anchor was
  // handed out as 18 500; looking down at your own feet it reached 3.43 and
  // 27 700. Against 2 200 cd/m² sunlit sandstone that is a 4× in-scatter, so
  // even the correct 13 % blend at 15 m whited the foreground out. The saturation
  // radiance of the medium cannot exceed its horizon value — clamp it there.
  float g = min(1.0, pow(max(0.0, 1.0 - up), IRON_HAZE_EPOW));

  vec2 dh = dir.xz;
  vec2 sh = sunDir.xz;
  float dl = length(dh);
  float sl = length(sh);
  float cosAz = (dl > 1e-4 && sl > 1e-4) ? dot(dh, sh) / (dl * sl) : 0.0;

  // BELOW-EYELINE OCCLUSION OF THE AMBIENT ANCHORS. With a g = 0.72 forward
  // lobe the light a scattering volume returns to the eye comes preferentially
  // from the direction the ray is heading; below the eyeline that direction is
  // the sea, at an albedo of 0.06, not the sky. The medium in front of the water
  // is therefore genuinely dimmer than the medium in front of the sky — and it
  // is the ONLY thing that can draw a horizon, because both sides of that line
  // saturate to this same function and their directions differ by a
  // milliradian. See HAZE_GROUND_OCC in model.ts for the full argument and for
  // the deliberate sharpening of the transition. The aureole and the Rayleigh
  // term below are single scattering OF THE SUN and are not occluded by what is
  // underneath the ray.
  float aboveEye = smoothstep(-IRON_HAZE_GBAND, IRON_HAZE_GBAND, up);
  float groundOcc = mix(IRON_HAZE_GOCC, 1.0, aboveEye);
  // The sun terms get HALF the occlusion. They are single scattering of the sun
  // and their source is not the ground, so the argument above does not apply to
  // them in full — but the medium in front of a surface still has a finite path
  // where the medium in front of the sky does not, and on the sunward side the
  // aureole is most of the in-scatter, so leaving them untouched left the sea
  // and the sky meeting at the same value on exactly the azimuth where the
  // horizon matters most.
  float sunOcc = mix(0.5 + 0.5 * IRON_HAZE_GOCC, 1.0, aboveEye);

  // THE SUNWARD EXCESS DECAYS FASTER WITH ELEVATION THAN THE DOME DOES, AND
  // THAT IS THE ROUND-4 PLATEAU FIX.
  //
  // §2.4's 9 000 cd/m² is a HORIZON row — "within 20° of the sun AZIMUTH" — and
  // at the horizon azimuth and angle-from-the-sun are the same quantity, so the
  // spec cannot distinguish them. Carrying that row up the dome on the same g as
  // the rest of the anchors does distinguish them, wrongly: it hands the full
  // sunward excess to every direction at the sun's azimuth regardless of how far
  // above the sun it is, and Mie forward scattering falls off with the ANGLE FROM
  // THE SUN, not with azimuth. The visible result was the round-4 finding —
  // "roughly x700-1500 / y0-400, about 15 % of the frame at near-clip white
  // carrying no information" — because every contre-jour shot on the roster
  // frames 0–25° of elevation on the sun's azimuth and all of it was being
  // handed the horizon row.
  //
  // Splitting the sunward anchor into "the cross-sun dome" plus "the forward
  // scattering excess on top of it", and giving only the EXCESS the tighter
  // exponent, leaves the horizon exactly on §2.4 (both exponents are 1 at
  // up = 0) and pulls 20° of elevation above the sun down by a third.
  float gSun = min(1.0, pow(max(0.0, 1.0 - up), IRON_HAZE_EPOW_SUN));
  // TWO ELEVATION TERMS, NOT ONE. The tight exponent above is the aerosol band
  // and it must stay tight (round 5), but on its own it flattens the entire dome
  // above ~30° onto the zenith triple — measured S 0.513 at both 30° and 88°,
  // sixty degrees of sky with no gradient in it. The broad term underneath it is
  // the 1/cos limb brightening a real dome has: zenith → a paler, slightly
  // brighter upper-air anchor, running the full height. See
  // HAZE_ELEV_POW_BROAD / ANCHOR.elev30Anti in model.ts.
  float gBroad = min(1.0, pow(max(0.0, 1.0 - up), IRON_HAZE_EPOW_BROAD));
  vec3 upper = mix(IRON_ANCHOR_ZENITH, IRON_ANCHOR_UPPER, gBroad);
  vec3 anti  = mix(upper, IRON_ANCHOR_H_ANTI, g) * groundOcc;
  vec3 cross_ = mix(upper, IRON_ANCHOR_H_CROSS, g) * groundOcc;
  vec3 sunward = (mix(upper, IRON_ANCHOR_H_CROSS, g)
                + (IRON_ANCHOR_H_SUN - IRON_ANCHOR_H_CROSS) * gSun) * groundOcc;

  // The azimuthal blend is pow(cos, 5) toward the sun and pow(cos, 1.5) away.
  //
  // A plain cosine is WRONG here and it is worth saying why, because it is a
  // one-line change that decides whether the frame reads as golden hour or as
  // milk. LOOK_SPEC §2.4 quotes 9 000 cd/m² "within 20° of the sun azimuth" and
  // 3 400 at 90°: a cosine still hands out 90 % of the sunward anchor at 26° off
  // and 50 % at 60°, so every surface in the sunward HALF of the frame gets an
  // in-scatter four times its own luminance and the whole midground goes white.
  // pow 5 gives 0.70 at 20° and 0.20 at 40°, which is the measured falloff.
  // The anti-sun side is genuinely broad and keeps a gentle exponent.
  float toSun = pow(max(0.0, cosAz), 5.0);
  float toAnti = pow(max(0.0, -cosAz), 1.5);
  vec3 base = mix(mix(cross_, sunward, toSun), anti, toAnti);

  float c = clamp(dot(dir, sunDir), -1.0, 1.0);
  // Forward lobe: haze near the sun azimuth outshines the sky (§3.2 property 2).
  //
  // A SINGLE HG at g = 0.76 and a coefficient of 1440 cd/m², NOT the two-lobe
  // phase the sky LUT uses. The 9 000 cd/m² sun-side horizon anchor already
  // contains most of the forward brightening; the narrow aureole lobe on top of
  // it peaks at 20× the anchor and blows the whole sunward half of the frame to
  // white. This adds about +3 500 at the sun and +840 at 20° off, which is the
  // 1.21× the spec actually measures for the far ridge.
  float aureole = ironPhaseHG(c, 0.76) * 1440.0 * (turbidity / 3.4) * (1.0 - overcast * 0.75);
  // Explicit λ⁻⁴ term: anti-sun distance goes bluer AND more saturated than the
  // horizon sky it sits against (§3.2 property 3). A lerp-to-fog-colour cannot.
  vec3 rayleigh = ironPhaseR(c) * 3.0e3 * vec3(0.30, 0.70, 1.60);

  vec3 col = base + (aureole * sunChroma + rayleigh) * sunOcc;
  if (overcast > 0.0) {
    float grey = dot(col, vec3(0.3333));
    col = mix(col, vec3(grey, grey, grey * 1.02), overcast * 0.8);
  }
  return col;
}

/**
 * Chroma pre-expansion for the ATMOSPHERIC terms, about their own luminance.
 *
 * LOOK_SPEC §2.4 gives the sunward horizon as 9 000 cd/m² at chroma
 * (1.00, 0.94, 0.87) and states it must DISPLAY as (250, 232, 210) — B−R = −40,
 * S = 0.16. Fed exactly that, this renderer returns (248, 243, 235): B−R = −13,
 * S = 0.054, so three quarters of the golden hour's warmth is gone from the one
 * shot named after it. The corpus sides with the spec — bfv_gp_036's sun-side
 * sky measures (249, 226, 206), S = 0.175 — and §5.3's own table allows S up to
 * 0.24 in the 192–216 luma bucket.
 *
 * The loss is the transfer curve, not the model: an AgX-shaped tonemap converges
 * every channel on white as it climbs its shoulder, and a golden-hour sky spends
 * its whole angular extent up there. Nothing about the atmosphere is wrong, so
 * the atmosphere is not the place to fix it — the sky is handed forward with its
 * chroma pre-expanded about its own luminance by the inverse of what the
 * shoulder takes back off it.
 *
 * KEYED ON WARM CHROMA, NOT ON ABSOLUTE RADIANCE. Keying it on cd/m² was tried
 * first and is wrong for a recordable reason: RCORE ships an exposure pass, so
 * the display luminance a given radiance lands at is a per-shot quantity, and one
 * fixed cd/m² threshold ramped in on sky_golden and not on light_cascades. The
 * chroma sign does not move with exposure. It is also the sharper statement of
 * the defect — the anti-sun half of the dome already measures S 0.19 against the
 * reference's 0.21 and must not be touched at all, and every direction that needs
 * the correction is one where R > B.
 *
 * IT LIVES HERE, BESIDE 'ironHazeRadiance', AND NOT IN THE DOME, BECAUSE OF THE
 * INVARIANT AT THE TOP OF THIS SECTION. 'ironHazeRadiance' is the radiance the
 * aerial-perspective integral saturates to AND the radiance the dome's marine
 * boundary layer saturates to; that is the whole reason one function is compiled
 * into both shaders. A distant ridge and the sky one pixel above it differ in
 * view direction by a milliradian, so whatever is done to one of those two
 * values must be done to the other or the skyline acquires a chroma step that
 * no amount of distance can dissolve. Round 2 introduced this correction on the
 * dome side only and did exactly that: on 'sky_golden' the sky came back warm
 * (B−R −15) while the hazed-out headland underneath it stayed neutral (B−R −4),
 * which reads as a cut-out rather than a horizon. Apply it at the SOURCE, in the
 * one function both sides share, and the step cannot exist by construction.
 *
 * APPLIED TO THE SCATTERING ONLY — not to the sun disc, and not to the cloud
 * deck. Both are composited after it. The first build applied it to the finished
 * dome and the cloud deck came back a uniform tangerine: a cumulus lit by a
 * 3 400 K sun is legitimately the warmest thing in the frame, so it sat at the
 * top of the ramp and got the full 2.6×, which is a correction for a horizon band
 * being applied to an object that is not one.
 *
 * Luminance is preserved by construction, so no radiance in §2.4's table moves.
 *
 * ── THE COOL BRANCH, AND WHY THE ASYMMETRY DID NOT SURVIVE ROUND 3 ──────────
 *
 * Round 3, severity 8, on 'level_alpha': "the sky is achromatic. At zenith it
 * measures RGB(198.5, 201.2, 202.2), a saturation of 1.8 %. A physical Rayleigh
 * sky at this elevation should be 25–45 % saturated overhead … the horizon
 * warming is already directionally correct, R > B at y = 240, so the Mie lobe is
 * doing something; the failure is entirely in the Rayleigh term at high zenith
 * angles."
 *
 * The Rayleigh term is not the failure — the same dome measures 55 % at the
 * zenith on 'sky_clouds', where the sun is 11° higher and the sky lands two
 * stops lower on the transfer. What changes between those two frames is WHERE ON
 * THE SHOULDER the sky sits, and that is the exact mechanism this function was
 * written for. It was only ever wired to the warm half.
 *
 * The asymmetry was defensible when it was written: the one frame it had been
 * measured on put the anti-sun sky at S 0.19 against the corpus' 0.21, i.e.
 * already right, and an unconditional expansion would have overshot it. It is
 * not defensible across the roster, because a sky at display 0.77 is high enough
 * on AgX's shoulder to lose three quarters of its chroma whichever side of
 * neutral it sits on, and a WARM-ONLY correction guarantees that every frame
 * whose sky is blue rather than gold comes back grey.
 *
 * The cool ramp is deliberately the gentler of the two — 2.1× against 2.6×, and
 * it starts at |B−R| = 0.06·Y rather than 0.02·Y — so the achromatic horizon
 * band §3.1 measures at S 0.04 is untouched by construction and only genuinely
 * blue sky is expanded. It also lands on the right side of §3.2's third property
 * ("anti-sun distance goes BLUER and more saturated than the horizon sky it sits
 * against"), because the aerial-perspective chunk shares this function.
 */
vec3 ironSkyChroma(vec3 c) {
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float bias = (c.r - c.b) / max(lum, 1.0);
  float warm = clamp(bias, 0.0, 1.0);
  float cool = clamp(-bias, 0.0, 1.0);
  // The two branches are separate ramps because the two failures are separate
  // and were measured on different frames — see the COOL BRANCH note above.
  //
  // ── ROUND 4 RESCALED THE COOL BRANCH, BECAUSE ITS PREMISE MOVED ────────────
  //
  // 2.4 was fitted against a dome whose upper half was sitting two and a half
  // stops below §2.4's table (see the round-4 note in dome.ts) and whose blue
  // was therefore being read off a near-black sky. With the level fixed, the
  // same 2.4 measured S 0.70 at the zenith against §2.4's 0.17 and the corpus'
  // 0.21 — an expansion designed to undo shoulder compression, applied to a
  // value that is no longer anywhere near the shoulder. 1.30 restores the
  // measured target; the warm branch is untouched because the sun-side horizon
  // genuinely does sit at display 0.95 and genuinely does lose its chroma there.
  // ── ROUND 5 PUT THE COOL BRANCH BACK UP, AGAINST A MEASUREMENT ────────────
  //
  // 0.30 was fitted on the sky_diag frames, which are ~95 % sky by area, so the
  // auto-exposure metered the dome itself and landed it at display 0.45 — well
  // down AgX's linear section, where almost no chroma is lost and 0.30 was
  // plenty. Every GRADED frame is 20–35 % sky metered off dark sandstone, which
  // puts the same radiance at display 0.73–0.79: on the shoulder, and then
  // through RCORE's 1 - 0.88*smoothstep(0.62, 0.95, L) chroma taper on top.
  // Measured end to end on level_alpha, linear saturation 0.385 at the top of
  // frame arrives as display 0.136 — a 2.8× loss that 0.30 cannot cover.
  //
  // 1.20 restores it: the same direction leaves here at linear S 0.67 and lands
  // at display S 0.24, inside the finding's 0.20–0.35 band. The ramp still
  // starts at |B−R| = 0.04·Y so §3.1's achromatic horizon band (S 0.04) is
  // untouched by construction — only sky that is genuinely blue is expanded,
  // and the warm branch, which is fitted against a different failure on a
  // different part of the transfer, does not move.
  float gain = mix(1.0, 2.6, smoothstep(0.02, 0.13, warm))
             + mix(0.0, 1.20, smoothstep(0.04, 0.30, cool));
  return max(vec3(0.0), mix(vec3(lum), c, gain));
}
`;

/* ==========================================================================
 * 4. Sky-view atlas addressing. 64 azimuth × 96 zenith per sun-elevation
 *    slice, 24 slices stacked vertically.
 * ========================================================================== */

export const SKYVIEW_W = 64;
export const SKYVIEW_H = 96;
export const SKYVIEW_SLICES = 24;
/** Sun elevation covered by the slice axis, degrees. */
export const SKYVIEW_ELEV_MIN = -8;
export const SKYVIEW_ELEV_MAX = 80;

export const SKYVIEW_GLSL = /* glsl */ `
const float IRON_SV_W = ${f(SKYVIEW_W)};
const float IRON_SV_H = ${f(SKYVIEW_H)};
const float IRON_SV_SLICES = ${f(SKYVIEW_SLICES)};
const float IRON_SV_EMIN = ${f(SKYVIEW_ELEV_MIN)};
const float IRON_SV_EMAX = ${f(SKYVIEW_ELEV_MAX)};

/**
 * View zenith → v, with a sqrt fold about the horizon so half the table's rows
 * sit in the 20° where all the interesting structure is. Matches the baker.
 */
float ironSvZenithToV(float cosZenith) {
  float a = asin(clamp(cosZenith, -1.0, 1.0));           // altitude angle, -pi/2..pi/2
  float t = sqrt(abs(a) / (IRON_PI * 0.5));
  return 0.5 + 0.5 * sign(a) * t;
}

float ironSvVToSinAltitude(float v) {
  float s = (v - 0.5) * 2.0;
  float a = sign(s) * s * s * (IRON_PI * 0.5);
  return sin(a);
}
`;

/**
 * Manual bilinear + slice interpolation over the atlas.
 *
 * `texelFetch` rather than a filtered sample on purpose: the atlas stacks 24
 * independent slices in one texture, so hardware bilinear would bleed the
 * bottom row of one sun elevation into the top row of the next, and the fetch
 * also removes any dependence on `OES_texture_float_linear` being present on
 * the capture machine.
 */
export const SKYVIEW_SAMPLE_GLSL = /* glsl */ `
vec4 ironSvFetch(sampler2D lut, vec2 texel, int slice) {
  float x = clamp(texel.x, 0.5, IRON_SV_W - 0.5);
  float y = clamp(texel.y, 0.5, IRON_SV_H - 0.5);
  vec2 p = vec2(x, y) - 0.5;
  vec2 fr = fract(p);
  ivec2 i0 = ivec2(floor(p));
  ivec2 i1 = min(i0 + ivec2(1), ivec2(int(IRON_SV_W) - 1, int(IRON_SV_H) - 1));
  int rowBase = slice * int(IRON_SV_H);
  vec4 a = texelFetch(lut, ivec2(i0.x, rowBase + i0.y), 0);
  vec4 b = texelFetch(lut, ivec2(i1.x, rowBase + i0.y), 0);
  vec4 c = texelFetch(lut, ivec2(i0.x, rowBase + i1.y), 0);
  vec4 d = texelFetch(lut, ivec2(i1.x, rowBase + i1.y), 0);
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}

/**
 * Sky radiance in cd/m² above the boundary layer, from the baked table.
 * rgb carries Rayleigh + multiple scattering with the (smooth) Rayleigh phase
 * already applied; a carries the Mie integral with its phase FACTORED OUT, so
 * the aureole stays sharp at 64 azimuth samples instead of being smeared into
 * a 3°-wide blur.
 */
vec3 ironSkyViewLut(sampler2D lut, vec3 dir, vec3 sunDir, float sunElevationDeg, vec3 sunChroma) {
  vec2 dh = dir.xz;
  vec2 sh = sunDir.xz;
  float dl = length(dh);
  float sl = length(sh);
  float cosAz = (dl > 1e-4 && sl > 1e-4) ? clamp(dot(dh, sh) / (dl * sl), -1.0, 1.0) : 1.0;
  float u = acos(cosAz) / IRON_PI;
  float v = ironSvZenithToV(dir.y);

  float sf = clamp((sunElevationDeg - IRON_SV_EMIN) / (IRON_SV_EMAX - IRON_SV_EMIN), 0.0, 1.0)
           * (IRON_SV_SLICES - 1.0);
  int s0 = int(floor(sf));
  int s1 = min(s0 + 1, int(IRON_SV_SLICES) - 1);
  float sk = sf - float(s0);

  vec2 texel = vec2(u * IRON_SV_W, v * IRON_SV_H);
  vec4 t0 = ironSvFetch(lut, texel, s0);
  vec4 t1 = ironSvFetch(lut, texel, s1);
  vec4 t = mix(t0, t1, sk);

  float c = clamp(dot(dir, sunDir), -1.0, 1.0);
  // 'a' is the channel-averaged Mie integral: the baker collapses it so the
  // phase can be applied here at full angular resolution. Its hue is restored
  // with a UNIT-MEAN sun chroma, which conserves the energy the baker measured
  // while putting the reddening back. The approximation is that the scattering
  // point sees the same sun colour the camera does — true within a few percent
  // near the horizon, which is the only place the Mie term is significant.
  vec3 chroma = sunChroma * 3.0 / max(1e-3, sunChroma.r + sunChroma.g + sunChroma.b);
  vec3 mie = vec3(t.a) * ironPhaseMie(c, 0.76) * chroma;
  return (t.rgb + mie) * IRON_SOLAR_LX;
}
`;

/** Everything the dome and the fog chunk both need, in dependency order. */
export const SKY_COMMON_GLSL = `${ATMOSPHERE_GLSL}\n${HAZE_GLSL}`;
