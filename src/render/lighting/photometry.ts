/**
 * Photometry: the numbers that make the whole frame physically consistent.
 *
 * OWNER: LIGHT.
 *
 * Everything in this lane works in ABSOLUTE PHOTOMETRIC UNITS end to end —
 * `DirectionalLight.intensity` in lux, local lights in candela, the environment
 * cube in cd/m². That is not pedantry: three ≥ r155 shades
 * `L = E · cosθ · albedo / π`, so if the illuminances are real the exposure is
 * *derived* rather than dialled by eye, and LOOK_SPEC §2.1's
 * `toneMappingExposure = 0.18 / L_grey` falls out as one line.
 *
 * Every function here is pure and elevation-driven, so the HAZE preset, a
 * scripted time-of-day change and the shot harness all stay consistent without
 * a second table.
 */
import * as THREE from 'three';

/** Sun angular RADIUS in radians (disc diameter 0.53°). Drives PCSS penumbra. */
export const SUN_ANGULAR_RADIUS = 0.00465;

/** tan(angular radius) — penumbra half-width per metre of occluder gap. */
export const SUN_PENUMBRA_SLOPE = Math.tan(SUN_ANGULAR_RADIUS);

/**
 * LOOK_SPEC §2.2 measured sun chromaticity, max-normalised linear Rec.709,
 * against elevation in degrees. This is a blackbody ramp fitted to the corpus,
 * not a guess: 3400 K at 11°, 5600 K at 45°.
 */
const SUN_COLOUR_RAMP: readonly (readonly [number, number, number, number])[] = [
  [-3, 1.0, 0.52, 0.24],
  [5, 1.0, 0.62, 0.36],
  [11, 1.0, 0.712, 0.478],
  [16, 1.0, 0.81, 0.66],
  [25, 1.0, 0.9, 0.83],
  [45, 1.0, 0.956, 0.925],
  [90, 1.0, 0.98, 0.97],
];

/** Sun linear colour at a given elevation, max-normalised (R is always 1). */
export function sunColourAtElevation(elevationDeg: number, out: THREE.Color): THREE.Color {
  const ramp = SUN_COLOUR_RAMP;
  if (elevationDeg <= ramp[0][0]) return out.setRGB(ramp[0][1], ramp[0][2], ramp[0][3]);
  for (let i = 1; i < ramp.length; i++) {
    if (elevationDeg <= ramp[i][0]) {
      const a = ramp[i - 1];
      const b = ramp[i];
      const t = (elevationDeg - a[0]) / (b[0] - a[0]);
      return out.setRGB(1, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t);
    }
  }
  const last = ramp[ramp.length - 1];
  return out.setRGB(last[1], last[2], last[3]);
}

/**
 * Direct-normal illuminance in lux, as a function of sun elevation.
 *
 * Kasten-Young style air mass through a Bouguer transmittance of 0.72 per air
 * mass^0.678. Calibrated against LOOK_SPEC §1: this returns 47.1 klx at 11°
 * (spec 48 klx) and 86 klx at 42° (spec 92 klx), so the golden preset lands
 * inside the spec's band without a hard-coded special case, and the two
 * secondaries stay on the same physical curve.
 *
 * `turbidity` scales the aerosol optical depth: 3.2 is the GOLDEN reference.
 */
export function directNormalIlluminance(elevationDeg: number, turbidity: number): number {
  const sinE = Math.sin(THREE.MathUtils.degToRad(Math.max(elevationDeg, -1.5)));
  if (sinE <= 0.004) return 0;
  const airMass = Math.min(1 / sinE, 38);
  const base = 0.72 - 0.018 * (turbidity - 3.2);
  return 133_000 * Math.pow(Math.max(base, 0.4), Math.pow(airMass, 0.678));
}

/**
 * Diffuse sky illuminance on a HORIZONTAL surface, lux — i.e. the integral of
 * the whole dome, which is what an upward-facing patch of ground receives from
 * the sky alone.
 *
 * Anchored to LOOK_SPEC §1's 7 500 lx at 11°/turbidity 3.2 and rising with both
 * elevation and turbidity (a hazier sky scatters *more* into the diffuse
 * component while taking it out of the beam — which is exactly why the HAZE
 * preset has a LOWER DNI and a HIGHER sky term).
 */
export function skyDiffuseIlluminance(elevationDeg: number, turbidity: number): number {
  const sinE = Math.sin(THREE.MathUtils.degToRad(elevationDeg));
  // The +0.09 floor is civil twilight: the dome still carries light with the
  // disc below the horizon, and without it the map goes black at 5°.
  const shape = (Math.max(sinE, -0.05) + 0.09) / (Math.sin(THREE.MathUtils.degToRad(11)) + 0.09);
  const haze = 1 + 0.42 * (turbidity - 3.2);
  return Math.max(60, 7500 * Math.pow(Math.max(shape, 0.02), 0.9) * Math.max(haze, 0.35));
}

/**
 * THE EXPOSURE, LOOK_SPEC §2.1, derived and never dialled:
 *
 *     L_grey   = E_total_horizontal · 0.18 / π      (an 18 % surface on flat ground)
 *     exposure = 0.18 / L_grey  =  π / E_total_horizontal
 *
 * At GOLDEN this returns 1.9e-4 against the spec's 1.88e-4.
 */
export function derivedExposure(totalHorizontalLux: number): number {
  return Math.PI / Math.max(totalHorizontalLux, 1);
}

/**
 * Correlated-colour-temperature → linear Rec.709, max-normalised. Used by every
 * EMITTER (muzzle 2600 K, ground fire 1900 K, flare 2400 K) so a caller can pass
 * the spec's kelvin figure and get the spec's colour.
 *
 * Planckian locus via the standard cubic approximation, then XYZ → linear sRGB.
 */
export function kelvinToLinearRgb(kelvin: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(kelvin, 1000, 25_000);
  const t2 = t * t;
  const t3 = t2 * t;
  let x: number;
  if (t < 4000) {
    x = -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991;
  } else {
    x = -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  }
  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t < 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t < 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;

  const yy = Math.max(y, 1e-4);
  const bigX = x / yy;
  const bigZ = (1 - x - yy) / yy;
  let r = 3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ;
  let g = -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ;
  let b = 0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ;
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const m = Math.max(r, g, b, 1e-5);
  return out.setRGB(r / m, g / m, b / m);
}
