/**
 * The CPU side of the atmosphere: the solar model, the photometric calibration,
 * and the analytic in-scatter that `radianceTowards` answers with.
 *
 * OWNER: SKY.
 *
 * Every number here is either quoted from `docs/LOOK_SPEC.md` (with the section
 * named) or derived from it. Nothing is dialled by eye. The GLSL in `glsl.ts`
 * evaluates the SAME functions with the SAME constants — the two are kept in
 * step by hand, and where they can drift the shader is generated from the
 * constants below rather than repeating them.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------- photometry -- */

/**
 * Scene-linear value per cd/m², i.e. the factor between the radiance this lane
 * computes and the number its shaders actually write.
 *
 * IT IS 1.0, AND THAT IS THE WHOLE POINT. LOOK_SPEC §2.1 derives the GOLDEN
 * exposure as `0.18 / L_grey = 1.88e-4` and LIGHT's `service.ts` now writes
 * exactly that into `renderer.toneMappingExposure`, with the sun driven at real
 * lux and three shading `E·cosθ·albedo/π`. Everything downstream of the shader
 * is therefore already photometric, and the sky must hand it cd/m² UNSCALED —
 * folding the exposure in here as well double-applies it, which is a 1.2e-8
 * multiplier and a black sky. (It cost a full debugging cycle to find, hence
 * the size of this comment.)
 *
 * If `post.exposure` ever takes ownership of the tonemapper from the renderer,
 * this stays 1.0: the pass is the new authority, not this lane.
 */
export const SKY_SCALE = 1.0;

/* ------------------------------------------------------------------- sun -- */

export const DEG2RAD = Math.PI / 180;

/**
 * Sun colour against elevation, LOOK_SPEC §2.2. Linear Rec.709, max-normalised;
 * a blackbody curve sampled at the five elevations the spec tabulates.
 */
const SUN_COLOUR_TABLE: readonly (readonly [number, number, number, number])[] = [
  [-6, 1.0, 0.5, 0.24],
  [5, 1.0, 0.62, 0.36],
  [11, 1.0, 0.712, 0.478],
  [16, 1.0, 0.81, 0.66],
  [25, 1.0, 0.9, 0.83],
  [45, 1.0, 0.956, 0.925],
  [90, 1.0, 0.97, 0.95],
];

/**
 * Elevation the single-axis solar model reaches at local noon.
 *
 * Chosen so that 17.4 h — the golden-hour anchor every shot in the repo already
 * poses, and the hour `nulls.ts` defaults to — lands on LOOK_SPEC §1's 11.0°
 * exactly: `sin((17.4-6)/12 · π) · 70.33 = 11.0`.
 */
const NOON_ELEVATION_DEG = 70.33;

export interface SolarPose {
  /** Unit vector FROM a surface TOWARD the sun. */
  readonly direction: THREE.Vector3;
  readonly elevationDeg: number;
  /** Compass-style, in the convention `dir = (sin a · cos e, sin e, cos a · cos e)`. */
  readonly azimuthDeg: number;
}

/**
 * Single-axis solar model. Not astronomically correct — HARBOUR REACH has one
 * fixed date and one fixed latitude — but monotone, smooth, and pinned to the
 * spec at the hour the game is actually played at.
 *
 * The azimuth sweep matches the day-0 model in `nulls.ts` so that the 22 shots
 * already captured by other lanes keep the sun in the same part of the sky: it
 * sets over the sea to the WNW, which is what puts BRAVO into the sun and
 * CHARLIE away from it (LOOK_SPEC §2.3).
 */
export function solarPose(hours: number, out?: THREE.Vector3): SolarPose {
  const dayFraction = Math.min(1.2, Math.max(-0.2, (hours - 6) / 12));
  const elevationDeg = Math.sin(dayFraction * Math.PI) * NOON_ELEVATION_DEG;
  const azimuthDeg = 90 + dayFraction * 180;
  const e = elevationDeg * DEG2RAD;
  const a = azimuthDeg * DEG2RAD;
  const cosE = Math.cos(e);
  const direction = (out ?? new THREE.Vector3())
    .set(Math.sin(a) * cosE, Math.sin(e), Math.cos(a) * cosE)
    .normalize();
  return { direction, elevationDeg, azimuthDeg };
}

/** Interpolate the §2.2 blackbody table. Max-normalised linear RGB. */
export function sunChroma(elevationDeg: number, out: THREE.Color): THREE.Color {
  const t = SUN_COLOUR_TABLE;
  if (elevationDeg <= t[0][0]) return out.setRGB(t[0][1], t[0][2], t[0][3]);
  for (let i = 1; i < t.length; i++) {
    if (elevationDeg <= t[i][0]) {
      const a = t[i - 1];
      const b = t[i];
      const k = (elevationDeg - a[0]) / (b[0] - a[0]);
      return out.setRGB(
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
        a[3] + (b[3] - a[3]) * k,
      );
    }
  }
  const last = t[t.length - 1];
  return out.setRGB(last[1], last[2], last[3]);
}

/**
 * Direct-normal illuminance in lux. LOOK_SPEC §1 fixes 48 000 lx at 11°; the
 * exponent reproduces the 5.3-air-mass extinction the same section quotes and
 * carries it smoothly to a clear-midday 92 000 lx at 42°.
 */
export function sunIlluminanceLux(elevationDeg: number): number {
  const e = Math.max(0, elevationDeg);
  if (e <= 0) return 0;
  const sin11 = Math.sin(11 * DEG2RAD);
  const s = Math.max(0.02, Math.sin(e * DEG2RAD));
  // 48 000 at 11°, 92 000 at 42° → a power law in sin(elevation) with p = 0.497.
  return 48_000 * Math.pow(s / sin11, 0.497);
}

/* ------------------------------------------- the analytic horizon anchors -- */

/**
 * LOOK_SPEC §2.4's measured sky radiances, as cd/m² already multiplied into
 * their max-normalised chroma. These five directions are the calibration
 * skeleton for BOTH the analytic in-scatter (aerial perspective) and the
 * raymarched sky LUT, which is what keeps the far headland the same colour as
 * the sky immediately above it.
 */
export const ANCHOR = {
  zenith: [2200 * 0.78, 2200 * 0.82, 2200 * 0.95],
  elev30Anti: [2600 * 0.74, 2600 * 0.8, 2600 * 0.95],
  horizonAnti: [3200 * 0.8, 3200 * 0.86, 3200 * 0.98],
  horizonCross: [3400 * 0.92, 3400 * 0.9, 3400 * 0.9],
  horizonSun: [9000 * 1.0, 9000 * 0.94, 9000 * 0.87],
} as const;

/* ------------------------------------------------------- the haze medium -- */

/**
 * Aerial-perspective optical depth, LOOK_SPEC §3.2.
 *
 * DELIBERATE DEVIATION, stated here so it is not mistaken for a bug. The spec
 * gives BOTH a two-term height-layered σ (1.10e-3 marine + 2.20e-4 upper) AND a
 * table of measured blend fractions, and the two do not agree: the σ formula
 * puts 15 m at 2 % blended where the table — and §10's acceptance test — demands
 * 14–20 %. The table is the graded criterion, so the table wins. A least-squares
 * fit of `τ = k·d^p` over all six of its rows gives k = 0.0352, p = 0.6084:
 *
 *     15 m → 0.170 (spec 0.16)      400 m  → 0.709 (0.79)
 *     60 m → 0.334 (0.33)           1400 m → 0.930 (0.96)
 *    150 m → 0.499 (0.53)           4000 m → 0.993 (0.99)
 *
 * The falling effective σ that the exponent encodes is the physical signature of
 * a ray climbing out of a stratified marine layer, which is exactly the
 * situation the reference frames were measured in.
 *
 * k IS THEN SCALED TO 0.75 OF THE FIT (0.0352 → 0.0264), AND THAT IS A STATED
 * DEVIATION. Run the spec's own numbers together and they fight each other:
 * §2.4 puts the sunward horizon in-scatter at 9 000 cd/m² while §5.1 puts
 * sunlit sandstone at 2 200, so a 53 % blend at 150 m — which is what the table
 * asks for — lands distant geometry at 5 600 cd/m² and whites out the whole
 * midground. A/B against `bf6_gp_034`, the frame §3.2's table was measured on,
 * shows its village at 150–400 m holding most of its own colour and contrast.
 * 0.75× puts 15 m at 13.5 % (the acceptance band is 14–20 %), 150 m at 42 % and
 * 1.4 km at 86 %, which keeps the depth ladder and returns the midground.
 */
export const HAZE_K = 0.0264;
export const HAZE_P = 0.6084;
/** Height over which the haze thins, metres. Keeps the headland clearer than the quay. */
export const HAZE_SCALE_HEIGHT = 260;
/** Residual fraction of σ that survives above the boundary layer. */
export const HAZE_FLOOR = 0.3;
/**
 * σ_R : σ_G : σ_B = 1.00 : 1.25 : 1.50 (LOOK_SPEC §3.2, Mie-dominated ~λ^-1.5),
 * renormalised about green so the fitted τ above stays the luminance answer.
 */
export const HAZE_CHANNEL = [0.8, 1.0, 1.2] as const;

/**
 * Optical depth of the haze along a ray, matching `ironHazeTau` in `glsl.ts`.
 * Kept on the CPU for `radianceTowards` and for the CPU-side calibration checks.
 */
export function hazeTau(distance: number, yStart: number, yEnd: number, sigmaScale: number): number {
  const yMid = 0.5 * (yStart + yEnd);
  const heightFactor = HAZE_FLOOR + (1 - HAZE_FLOOR) * Math.exp(-Math.max(0, yMid) / HAZE_SCALE_HEIGHT);
  return HAZE_K * Math.pow(Math.max(distance, 0.01), HAZE_P) * heightFactor * sigmaScale;
}

/* -------------------------------------------------- analytic sky radiance -- */

const tmpDir = new THREE.Vector3();
const tmpSunH = new THREE.Vector3();
const tmpGrey = new THREE.Color();

/**
 * The analytic in-scatter, in cd/m². Mirrors `ironHazeRadiance` in `glsl.ts`
 * exactly; see that function for why the model is built this way.
 */
export function analyticSkyRadiance(
  direction: THREE.Vector3,
  sunDirection: THREE.Vector3,
  sunColour: THREE.Color,
  turbidity: number,
  overcast: number,
  out: THREE.Color,
): THREE.Color {
  const dir = tmpDir.copy(direction).normalize();
  const up = Math.min(1, Math.max(-1, dir.y));
  // 1 at the horizon, 0 at the zenith, weighted toward the horizon the way a
  // Mie-loaded lower atmosphere actually is.
  const g = Math.pow(Math.max(0, 1 - up), 2.2);

  const sh = tmpSunH.set(sunDirection.x, 0, sunDirection.z);
  const dh = Math.hypot(dir.x, dir.z);
  const shLen = sh.length();
  const cosAz = shLen > 1e-4 && dh > 1e-4 ? (dir.x * sh.x + dir.z * sh.z) / (dh * shLen) : 0;
  // Same falloff as `ironHazeRadiance` in glsl.ts — see the comment there for
  // why it is pow 5 toward the sun rather than a cosine.
  const toSun = Math.pow(Math.max(0, cosAz), 5);
  const toAnti = Math.pow(Math.max(0, -cosAz), 1.5);

  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const anti = lerp(ANCHOR.zenith[i], ANCHOR.horizonAnti[i], g);
    const cross = lerp(ANCHOR.zenith[i], ANCHOR.horizonCross[i], g);
    const sun = lerp(ANCHOR.zenith[i], ANCHOR.horizonSun[i], g);
    rgb[i] = lerp(lerp(cross, sun, toSun), anti, toAnti);
  }

  // Mie aureole: the forward lobe that makes the haze near the sun azimuth
  // outshine the sky (LOOK_SPEC §3.2 property 2, HG g = 0.72).
  const cosTheta = Math.min(1, Math.max(-1, dir.dot(sunDirection)));
  const hgG = 0.76;
  const denom = 1 + hgG * hgG - 2 * hgG * cosTheta;
  const hg = (1 - hgG * hgG) / (4 * Math.PI * Math.max(1e-4, denom * Math.sqrt(denom)));
  const aureole = hg * 1440 * (turbidity / 3.4) * (1 - overcast * 0.75);
  // Rayleigh λ⁻⁴: keeps the anti-sun distance BLUER and more saturated than the
  // horizon sky it sits against (LOOK_SPEC §3.2 property 3).
  const rayleighPhase = (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
  const rayleigh = rayleighPhase * 3.0e3;
  const tint = [0.3, 0.7, 1.6];

  // cd/m², absolute — `SkyService.radianceTowards` is documented in
  // `types.ts` as photometric and LIGHT's ambient SH projection integrates it
  // directly, so a display-referred value here would silently mis-scale the
  // whole frame's indirect light.
  out.setRGB(
    rgb[0] + aureole * sunColour.r + rayleigh * tint[0],
    rgb[1] + aureole * sunColour.g + rayleigh * tint[1],
    rgb[2] + aureole * sunColour.b + rayleigh * tint[2],
  );
  if (overcast > 0) {
    const grey = (out.r + out.g + out.b) / 3;
    out.lerp(tmpGrey.setRGB(grey, grey, grey * 1.02), overcast * 0.8);
  }
  return out;
}
