/**
 * PCG32 (XSH-RR, 64/32) — the only source of randomness in the repo.
 * CORE owns this file. `Math.random()` is a build-breaking defect.
 *
 * WHY PCG AND NOT `Math.random()` OR A ONE-LINER LCG
 * --------------------------------------------------
 * Screenshots are the review loop, so every stochastic decision in the frame —
 * bullet spread, particle jitter, wind phase, wear masks, bot chatter — has to
 * replay identically on a workstation and under SwiftShader. That needs a
 * generator we own the state of. PCG32 is ~15 arithmetic ops, passes TestU01
 * BigCrush, and has a jumpable 2^64 period, which a 32-bit xorshift does not.
 *
 * JavaScript has no 64-bit integers outside BigInt (which is ~40× slower here),
 * so the 64-bit state is carried as two uint32 halves and the multiply is done
 * with the schoolbook 16-bit decomposition below. `tools/` verifies this against
 * a BigInt reference implementation.
 *
 * NAMED SUB-STREAMS
 * -----------------
 * `fork(label)` derives an independent stream by hashing the label into both the
 * seed and the PCG increment (which selects one of 2^63 distinct sequences).
 * This is the whole point: if VFX adds one extra `next()` call, TERRAIN's erosion
 * pattern must not move. Forks are memoised per label, so re-forking the same
 * label returns the same stream and `reseed()` on the parent deterministically
 * re-derives every child. Use your LANE NAME as the label.
 */
import type { Rng, Vec3 } from '@/engine/types';
import { hashString } from '@/engine/math/curves';

/** 6364136223846793005 = 0x5851F42D_4C957F2D, the canonical PCG32 multiplier. */
const MULT_LO = 0x4c957f2d;
const MULT_HI = 0x5851f42d;

/** Unsigned 32×32 → high 32 bits, via 16-bit limbs. `Math.imul` gives the low half. */
function umulhi(a: number, b: number): number {
  const ah = a >>> 16;
  const al = a & 0xffff;
  const bh = b >>> 16;
  const bl = b & 0xffff;
  const w0 = al * bl;
  const t = ah * bl + (w0 >>> 16);
  const w1 = t & 0xffff;
  const w2 = t >>> 16;
  const t2 = al * bh + w1;
  return (ah * bh + w2 + (t2 >>> 16)) >>> 0;
}

export class Pcg32 implements Rng {
  readonly label: string;

  private stateHi = 0;
  private stateLo = 0;
  private incHi = 0;
  private incLo = 0;
  private seedValue = 0;
  private readonly streamHash: number;
  private readonly children = new Map<string, Pcg32>();

  /** Cached second normal from the Box-Muller pair; -1 sentinel means "empty". */
  private gaussianSpare = 0;
  private gaussianHasSpare = false;

  constructor(seed: number, label = 'root', streamHash = 0x9e3779b9) {
    this.label = label;
    this.streamHash = streamHash >>> 0;
    this.reseed(seed);
  }

  get seed(): number {
    return this.seedValue;
  }

  reseed(seed: number): void {
    this.seedValue = seed >>> 0;
    // The increment must be odd; its high bits select the sequence.
    this.incLo = ((this.streamHash << 1) | 1) >>> 0;
    this.incHi = (this.streamHash ^ 0x5bf03635) >>> 0;
    this.stateHi = 0;
    this.stateLo = 0;
    this.step();
    this.addSeed(this.seedValue);
    this.step();
    this.gaussianHasSpare = false;
    // Children are derived from the parent seed, so a parent reseed must
    // propagate or the reset chain leaves half the world on stale streams.
    for (const [label, child] of this.children) {
      child.reseed(mixSeed(this.seedValue, label));
    }
  }

  /** state = state * MULT + inc, in 64 bits across two uint32 halves. */
  private step(): void {
    const sLo = this.stateLo;
    const sHi = this.stateHi;
    const lo = Math.imul(sLo, MULT_LO) >>> 0;
    const hi = (umulhi(sLo, MULT_LO) + Math.imul(sLo, MULT_HI) + Math.imul(sHi, MULT_LO)) >>> 0;
    const newLo = (lo + this.incLo) >>> 0;
    const carry = newLo < lo ? 1 : 0;
    this.stateLo = newLo;
    this.stateHi = (hi + this.incHi + carry) >>> 0;
  }

  private addSeed(seed: number): void {
    const newLo = (this.stateLo + seed) >>> 0;
    const carry = newLo < this.stateLo ? 1 : 0;
    this.stateLo = newLo;
    this.stateHi = (this.stateHi + carry) >>> 0;
  }

  /** One raw uint32 draw. Everything else is a transform of this. */
  nextUint32(): number {
    const oldLo = this.stateLo;
    const oldHi = this.stateHi;
    this.step();

    // xorshifted = ((old >> 18) ^ old) >> 27, as a 32-bit value.
    const shLo = ((oldLo >>> 18) | (oldHi << 14)) >>> 0;
    const shHi = oldHi >>> 18;
    const xLo = (shLo ^ oldLo) >>> 0;
    const xHi = (shHi ^ oldHi) >>> 0;
    const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;

    const rot = oldHi >>> 27;
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
  }

  /**
   * Uniform [0, 1) with 32 bits of mantissa. We deliberately do NOT combine two
   * draws for 53 bits: one draw per value keeps sub-stream sequences short and
   * makes hand-verifying a divergent shot tractable.
   */
  next(): number {
    return this.nextUint32() * 2.3283064365386963e-10;
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    // Debiased bounded draw (Lemire-style rejection). Bias matters here: spread
    // cones and scatter grids are visibly lumpy with naive modulo.
    const threshold = (0x100000000 - maxExclusive) % maxExclusive;
    for (;;) {
      const r = this.nextUint32();
      if (r >= threshold) return r % maxExclusive;
    }
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  sign(): number {
    return (this.nextUint32() & 1) === 0 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error(`rng[${this.label}].pick from an empty array`);
    return items[this.int(items.length)];
  }

  /** Marsaglia polar method — no trig, and it gives two normals per rejection round. */
  gaussian(): number {
    if (this.gaussianHasSpare) {
      this.gaussianHasSpare = false;
      return this.gaussianSpare;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this.gaussianSpare = v * f;
    this.gaussianHasSpare = true;
    return u * f;
  }

  /** Uniform on the sphere via the cylindrical (Archimedes) projection. */
  unitVec3(out: Vec3): Vec3 {
    const z = this.next() * 2 - 1;
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.set(Math.cos(a) * r, Math.sin(a) * r, z);
    return out;
  }

  /**
   * Uniform inside a cone of half-angle `halfAngleRad` about `axis`. Uniform in
   * SOLID ANGLE, not in angle: sampling the angle linearly clusters shots at the
   * centre of the spread cone and makes every weapon feel more accurate than its
   * numbers say.
   */
  cone(axis: Vec3, halfAngleRad: number, out: Vec3): Vec3 {
    const cosMax = Math.cos(halfAngleRad);
    const cosTheta = 1 - this.next() * (1 - cosMax);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = this.next() * Math.PI * 2;

    // Build an orthonormal basis around `axis` without a branch-heavy up vector:
    // Duff et al. branchless ONB.
    const ax = axis.x;
    const ay = axis.y;
    const az = axis.z;
    const sgn = az >= 0 ? 1 : -1;
    const a = -1 / (sgn + az);
    const b = ax * ay * a;
    const t1x = 1 + sgn * ax * ax * a;
    const t1y = sgn * b;
    const t1z = -sgn * ax;
    const t2x = b;
    const t2y = sgn + ay * ay * a;
    const t2z = -ay;

    const cx = Math.cos(phi) * sinTheta;
    const cy = Math.sin(phi) * sinTheta;
    out.set(
      t1x * cx + t2x * cy + ax * cosTheta,
      t1y * cx + t2y * cy + ay * cosTheta,
      t1z * cx + t2z * cy + az * cosTheta,
    );
    return out.normalize();
  }

  fork(label: string): Rng {
    const existing = this.children.get(label);
    if (existing) return existing;
    const child = new Pcg32(mixSeed(this.seedValue, label), `${this.label}/${label}`, hashString(label));
    this.children.set(label, child);
    return child;
  }

  saveState(): Uint32Array {
    return Uint32Array.from([this.stateHi, this.stateLo, this.incHi, this.incLo, this.seedValue]);
  }

  loadState(state: Uint32Array): void {
    if (state.length < 5) throw new Error(`rng[${this.label}].loadState: bad state length ${state.length}`);
    this.stateHi = state[0] >>> 0;
    this.stateLo = state[1] >>> 0;
    this.incHi = state[2] >>> 0;
    this.incLo = state[3] >>> 0;
    this.seedValue = state[4] >>> 0;
    this.gaussianHasSpare = false;
  }
}

/** Deterministic (parentSeed, label) → child seed. Avalanche via xorshift-multiply. */
function mixSeed(parentSeed: number, label: string): number {
  let h = (parentSeed ^ hashString(label)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function createRng(seed: number, label = 'root'): Pcg32 {
  return new Pcg32(seed, label);
}
