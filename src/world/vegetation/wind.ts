/**
 * THE WIND FIELD — one coherent field, evaluated identically on the CPU and in
 * the vertex shader.
 *
 * OWNER: VEG. `VegetationService.windAt` is this file, so flora, cloth, smoke,
 * particles and audio all agree on gust phase (LOOK_SPEC §8.7). Static
 * vegetation in a frame that has drifting smoke is an instant tell, and so is
 * vegetation whose gusts do not match the smoke's.
 *
 * THE SHAPE OF THE FIELD, AND WHY IT IS NOT A SINE
 * -----------------------------------------------
 * Everything moving in lockstep is worse than nothing moving. Real wind over a
 * field has three separable scales and all three are visible in a still frame:
 *
 *  1. A MEAN onshore flow. Every plant leans the same way. This is what makes a
 *     field read as "windy" rather than "wobbling".
 *  2. GUSTS that travel as a wave. A gust is a band of higher speed advecting
 *     downwind at 2–3× the mean speed, so a field shows moving stripes of
 *     deeper bend. Implemented as travelling plane waves in `dot(p, dir)`:
 *     the argument is (distance along wind − phase speed × time), which is
 *     exactly a wave moving downwind. Three incommensurate wavelengths
 *     (26 / 71 / 147 m) so the pattern never visibly repeats inside the map.
 *  3. FLUTTER — per-plant, uncorrelated, high frequency. Driven by a hash of
 *     the instance's world origin, which is why two palms 3 m apart never move
 *     together.
 *
 * The direction also wanders slowly (±13°), because a wind field whose gusts
 * change speed but never direction reads as a volume slider.
 *
 * ONE SOURCE OF THE NUMBERS. `glslField()` emits GLSL built from the same
 * constants this module evaluates in TypeScript. A CPU/GPU disagreement here
 * puts the smoke drift and the palm lean in different directions, which looks
 * like a VFX bug and is a vegetation one.
 */

/** Onshore, from the sea (−Z) toward the town (+Z), canted east. Unit length. */
const DIR_X = 0.4147;
const DIR_Z = 0.9100;

/** Mean wind speed, m/s. A light-to-moderate Mediterranean onshore breeze. */
const BASE_SPEED = 3.7;

/**
 * Travelling gust waves: [wavelength m, phase speed m/s, amplitude, phase rad].
 * Phase speeds are 2–3.4× the mean flow, which is the observed ratio for gust
 * fronts and is what makes the stripes read as *moving through* the field
 * rather than as the field oscillating in place.
 */
const GUSTS: readonly (readonly [number, number, number, number])[] = [
  [26.0, 11.4, 0.30, 0.0],
  [71.0, 8.1, 0.21, 1.73],
  [147.0, 6.2, 0.13, 4.11],
];

/** Slow direction wander, radians, and its wavelength/speed. */
const YAW_AMP = 0.23;
const YAW_WAVELENGTH = 118.0;
const YAW_SPEED = 4.4;

const TAU = Math.PI * 2;

/** Result of a field evaluation: a horizontal velocity in m/s. */
export interface WindSample {
  x: number;
  z: number;
  /** Scalar speed, m/s. Bend amplitude is driven by this, not by the vector. */
  speed: number;
}

/**
 * Gust multiplier on the mean speed at a point. Kept separate from `evaluate`
 * because the deform shader needs exactly this scalar and nothing else.
 */
function gustScale(x: number, z: number, t: number): number {
  const along = x * DIR_X + z * DIR_Z;
  let g = 1;
  for (const [wavelength, speed, amp, phase] of GUSTS) {
    g += amp * Math.sin(TAU * ((along - t * speed) / wavelength) + phase);
  }
  // Wind never actually reverses in a breeze; clamp the trough rather than
  // letting three sines sum to a negative speed.
  return Math.max(0.18, g);
}

function yawAt(x: number, z: number, t: number): number {
  const along = x * DIR_X + z * DIR_Z;
  return YAW_AMP * Math.sin(TAU * ((along - t * YAW_SPEED) / YAW_WAVELENGTH) + 0.8);
}

/**
 * The field. `strength` is the weather multiplier (SkyService weather wind),
 * held here so every consumer of `windAt` sees the same storm.
 */
export class WindField {
  strength = 1;

  /** Horizontal wind velocity, m/s, at a world point and time. */
  evaluate(x: number, z: number, t: number, out: WindSample): WindSample {
    const speed = BASE_SPEED * gustScale(x, z, t) * this.strength;
    const yaw = yawAt(x, z, t);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    out.x = (DIR_X * c - DIR_Z * s) * speed;
    out.z = (DIR_X * s + DIR_Z * c) * speed;
    out.speed = speed;
    return out;
  }

  /**
   * Normalised bend drive, 0..1, for a plant of the given stiffness. Bend
   * saturates: a blade of grass that is already flat cannot get flatter, and a
   * linear speed→bend mapping is what makes shader wind look like jelly.
   */
  bend(speed: number, stiffness: number): number {
    const drive = speed / (12 * stiffness);
    return drive / (1 + drive);
  }
}

/** Reference time the static per-instance wind pose is baked at. See `glslField`. */
export const WIND_POSE_TIME = 0;

/**
 * GLSL for the same field, emitted with a caller-supplied symbol prefix so two
 * deform chunks never collide at global scope.
 *
 * Emits:
 *   float <p>Hash(vec2)          — per-instance decorrelation
 *   vec2  <p>Wind(vec2 p, float t)  — horizontal velocity, m/s
 *   float <p>Bend(float speed, float stiffness)
 */
export function glslField(prefix: string, strengthUniform: string): string {
  const gustTerms = GUSTS.map(
    ([wavelength, speed, amp, phase]) =>
      `  g += ${amp.toFixed(4)} * sin(6.2831853 * ((along - t * ${speed.toFixed(4)}) / ${wavelength.toFixed(
        4,
      )}) + ${phase.toFixed(4)});`,
  ).join('\n');

  return /* glsl */ `
// --- IRONSIGHT vegetation wind field (generated from src/world/vegetation/wind.ts)
const vec2 ${prefix}Dir = vec2(${DIR_X.toFixed(6)}, ${DIR_Z.toFixed(6)});
const float ${prefix}Base = ${BASE_SPEED.toFixed(4)};

float ${prefix}Hash(vec2 p) {
  // Integer-free hash: stable across drivers, and the large primes keep two
  // instances 0.25 m apart fully decorrelated.
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float ${prefix}Gust(vec2 p, float t) {
  float along = dot(p, ${prefix}Dir);
  float g = 1.0;
${gustTerms}
  return max(0.18, g);
}

vec2 ${prefix}Wind(vec2 p, float t) {
  float along = dot(p, ${prefix}Dir);
  float speed = ${prefix}Base * ${prefix}Gust(p, t) * ${strengthUniform};
  float yaw = ${YAW_AMP.toFixed(4)} * sin(6.2831853 * ((along - t * ${YAW_SPEED.toFixed(
    4,
  )}) / ${YAW_WAVELENGTH.toFixed(4)}) + 0.8);
  float c = cos(yaw), s = sin(yaw);
  return vec2(${prefix}Dir.x * c - ${prefix}Dir.y * s, ${prefix}Dir.x * s + ${prefix}Dir.y * c) * speed;
}

float ${prefix}Bend(float speed, float stiffness) {
  float drive = speed / (12.0 * stiffness);
  return drive / (1.0 + drive);
}
`;
}
