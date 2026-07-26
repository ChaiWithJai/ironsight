/**
 * Scalar maths shared by every lane. CORE owns this file.
 *
 * Nothing here allocates and nothing here reads the clock — these are pure
 * functions so they are safe to call from simulation code where determinism is
 * a hard requirement.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, clamped. Returns 0 when the range is degenerate. */
export function invLerp(a: number, b: number, v: number): number {
  const d = b - a;
  return d === 0 ? 0 : clamp01((v - a) / d);
}

export function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  return lerp(outA, outB, invLerp(inA, inB, v));
}

/** Hermite 3t²-2t³. C1 continuous — fine for masks, visibly kinked for motion. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Ken Perlin's C2 variant. Use this whenever the derivative is also blended. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Frame-rate independent exponential approach. `halfLife` is the time for the
 * remaining error to halve, which is the only smoothing parameter that behaves
 * identically at 30 and 144 fps.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

/** Shortest signed angular difference in radians, in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Uniform Catmull-Rom through p1→p2. Used for camera splines and LUT resampling. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Deterministic integer hash (FNV-1a over the low bytes). Not a PRNG. */
export function hashInt(x: number): number {
  let h = 0x811c9dc5;
  let v = x >>> 0;
  for (let i = 0; i < 4; i++) {
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    v >>>= 8;
  }
  return h >>> 0;
}

/** FNV-1a over a string. The label hash behind `Rng.fork`. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= s.charCodeAt(i) >>> 8;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Next power of two ≥ v. Render-target and atlas sizing. */
export function nextPow2(v: number): number {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}
