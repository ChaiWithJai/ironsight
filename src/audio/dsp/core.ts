/**
 * AUDIO — DSP primitives.
 *
 * OWNER: AUDIO. Pure functions and tiny stateful filters over `Float32Array`.
 * Nothing in here touches WebAudio: every cue in the game is rendered to a
 * plain typed array at bake time, so the synthesis is identical whether it runs
 * on the main thread, in a worker, or under the software rasteriser in the
 * capture harness.
 *
 * DETERMINISM: `makeNoise(seed)` is an xorshift32 seeded from an integer the
 * caller drew from `ctx.rng`. It is not `Math.random()` and it is not a second
 * source of randomness in the project — it is a *stream expander*. A rifle shot
 * needs ~20 000 noise samples; taking those through the `Rng` interface would
 * cost a megacall per cue and, worse, would make the number of samples one cue
 * consumes part of the global sequence, so adding a cue would shift every later
 * cue's character. One integer per cue from the real RNG, expanded locally, is
 * both cheaper and more stable under edit.
 */

/** White noise in [-1, 1). One multiply and two shifts per sample. */
export function makeNoise(seed: number): () => number {
  // Never let the state reach 0: xorshift is absorbing there.
  let s = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // >>> 0 then scale: uniform over the full 32-bit range, mean ~0.
    return ((s >>> 0) / 2147483648 - 1) as number;
  };
}

/** Deterministic scalar stream over the same generator, in [0, 1). */
export function makeUniform(seed: number): () => number {
  const n = makeNoise(seed);
  return (): number => n() * 0.5 + 0.5;
}

export const TWO_PI = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(g, 1e-6));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* ============================================================================
 * Biquad — RBJ cookbook coefficients, direct form II transposed.
 * ========================================================================= */

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
  }

  lowpass(fs: number, freq: number, q: number): this {
    const w = (TWO_PI * clamp(freq, 10, fs * 0.49)) / fs;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
    this.set((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
    return this;
  }

  highpass(fs: number, freq: number, q: number): this {
    const w = (TWO_PI * clamp(freq, 5, fs * 0.49)) / fs;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
    this.set((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
    return this;
  }

  /** Constant skirt gain — peak gain is `q`, which is what a resonance wants. */
  bandpass(fs: number, freq: number, q: number): this {
    const w = (TWO_PI * clamp(freq, 10, fs * 0.49)) / fs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * Math.max(q, 0.05));
    this.set(alpha, 0, -alpha, 1 + alpha, -2 * cw, 1 - alpha);
    return this;
  }

  peaking(fs: number, freq: number, q: number, gainDb: number): this {
    const A = Math.pow(10, gainDb / 40);
    const w = (TWO_PI * clamp(freq, 10, fs * 0.49)) / fs;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
    this.set(1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A);
    return this;
  }

  highshelf(fs: number, freq: number, gainDb: number): this {
    const A = Math.pow(10, gainDb / 40);
    const w = (TWO_PI * clamp(freq, 10, fs * 0.49)) / fs;
    const cw = Math.cos(w);
    const sq = 2 * Math.sqrt(A) * (Math.sin(w) / 2) * Math.SQRT2;
    this.set(
      A * (A + 1 + (A - 1) * cw + sq),
      -2 * A * (A - 1 + (A + 1) * cw),
      A * (A + 1 + (A - 1) * cw - sq),
      A + 1 - (A - 1) * cw + sq,
      2 * (A - 1 - (A + 1) * cw),
      A + 1 - (A - 1) * cw - sq,
    );
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** One-pole low-pass. Cheap enough to retune every sample for a filter sweep. */
export class OnePole {
  private a = 0;
  private y = 0;

  setCutoff(fs: number, freq: number): this {
    this.a = Math.exp((-TWO_PI * clamp(freq, 1, fs * 0.49)) / fs);
    return this;
  }

  process(x: number): number {
    this.y = x * (1 - this.a) + this.y * this.a;
    return this.y;
  }
}

/** Removes the DC step a one-sided noise burst or a swept sine leaves behind. */
export class DcBlock {
  private x1 = 0;
  private y1 = 0;

  process(x: number): number {
    const y = x - this.x1 + 0.9975 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** Feedback comb with a one-pole damper in the loop — a Schroeder tail unit. */
export class Comb {
  private readonly buf: Float32Array;
  private idx = 0;
  private store = 0;

  constructor(
    lengthSamples: number,
    private readonly feedback: number,
    private readonly damp: number,
  ) {
    this.buf = new Float32Array(Math.max(1, lengthSamples | 0));
  }

  process(x: number): number {
    const y = this.buf[this.idx];
    this.store = y * (1 - this.damp) + this.store * this.damp;
    this.buf[this.idx] = x + this.store * this.feedback;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

/** Schroeder allpass — diffuses without colouring the magnitude response. */
export class Allpass {
  private readonly buf: Float32Array;
  private idx = 0;

  constructor(
    lengthSamples: number,
    private readonly g: number,
  ) {
    this.buf = new Float32Array(Math.max(1, lengthSamples | 0));
  }

  process(x: number): number {
    const b = this.buf[this.idx];
    const y = -x + b;
    this.buf[this.idx] = x + b * this.g;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

/* ============================================================================
 * Envelopes
 * ========================================================================= */

/**
 * Percussive envelope: near-instant rise, exponential fall. `attack` in seconds
 * is a genuine rise time, not a linear ramp — a gunshot's pressure front is
 * sub-millisecond and a linear attack of even 3 ms audibly softens it into a
 * "pop" instead of a "crack".
 */
export function envAD(t: number, attack: number, decay: number, curve = 4): number {
  if (t < 0) return 0;
  if (t < attack) return attack <= 0 ? 1 : t / attack;
  const x = (t - attack) / Math.max(decay, 1e-5);
  if (x >= 1) return 0;
  return Math.exp(-curve * x) * (1 - x);
}

/** Exponential decay to -60 dB over `tau60` seconds. */
export function envExp(t: number, tau60: number): number {
  return t < 0 ? 0 : Math.exp((-6.907755 * t) / Math.max(tau60, 1e-5));
}

/* ============================================================================
 * Buffer helpers
 * ========================================================================= */

export function mixInto(dst: Float32Array, src: Float32Array, offset: number, gain: number): void {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = 0; i < n; i++) dst[offset + i] += src[i] * gain;
}

export function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > p) p = a;
  }
  return p;
}

/**
 * Peak-normalise to `target` and return the pre-normalisation peak, so cue
 * authors work in dB against a known reference instead of guessing amplitudes.
 */
export function normalise(buf: Float32Array, target = 0.94): number {
  const p = peakOf(buf);
  if (p <= 1e-7) return p;
  const g = target / p;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return p;
}

/** Raised-cosine fade at both ends. Loop points and buffer starts must not click. */
export function fadeEdges(buf: Float32Array, fadeIn: number, fadeOut: number): void {
  const n = buf.length;
  const a = Math.min(fadeIn | 0, n >> 1);
  const b = Math.min(fadeOut | 0, n >> 1);
  for (let i = 0; i < a; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / a);
  for (let i = 0; i < b; i++) buf[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / b);
}

/**
 * Cross-fade the head of a loop over its own tail so it seams. Halves the
 * usable length; ambience beds are baked long enough to absorb that.
 */
export function seamLoop(buf: Float32Array, overlapSamples: number): Float32Array {
  const n = buf.length;
  const ov = Math.min(overlapSamples | 0, n >> 2);
  const out = new Float32Array(n - ov);
  out.set(buf.subarray(0, out.length));
  for (let i = 0; i < ov; i++) {
    const t = i / ov;
    const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
    out[i] = out[i] * w + buf[n - ov + i] * (1 - w);
  }
  return out;
}

/**
 * Soft-clip. A layered gunshot sums four full-amplitude layers and would
 * otherwise hard-clip on the transient; tanh keeps the loudness and adds the
 * even-order warmth a real recording chain has.
 */
export function softClip(buf: Float32Array, drive = 1): void {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / Math.tanh(drive);
}
