/**
 * AUDIO — the layer vocabulary every cue is built from.
 *
 * OWNER: AUDIO. A gunshot is not a waveform, it is an EVENT with four or five
 * physically distinct components arriving a few milliseconds apart:
 *
 *   TRANSIENT  the pressure front. Sub-millisecond rise, essentially an impulse
 *              through the muzzle's own resonance. This is what makes a shot
 *              read as a shot rather than as a "boom"; lose it to a slow attack
 *              or a smeared filter and the whole thing turns into a click or a
 *              thud, which the brief calls out by name.
 *   BODY       the expanding blast: broadband noise shaped by two or three
 *              band-passes whose centres FALL over the first 60 ms as the
 *              pressure wave loses energy at the top first.
 *   THUMP      the low-frequency displacement. A swept sine from ~110 Hz down,
 *              plus low-passed noise. It is the "weight" in the brief's bar and
 *              it is almost all of what survives at 200 m.
 *   MECHANICS  bolt carrier, spring, ejector. Two to four sharp resonant clicks
 *              at 8–45 ms, which is why a rifle sounds mechanical and a
 *              firework does not.
 *   ROOM       a short local decay baked into the cue so a shot has body even
 *              in the anechoic case; the environmental tail is a convolution
 *              send on top of this, not a replacement for it.
 *
 * Every helper here ADDS into an existing buffer, so a cue is a list of layers
 * and a mix, never a monolithic loop.
 */
import { Allpass, Biquad, Comb, clamp, dbToGain, envAD, envExp, makeNoise, TWO_PI } from './core';

/** Filter retune interval. 32 samples ≈ 0.67 ms at 48 k — inaudible stepping. */
const RETUNE = 32;

export interface TransientSpec {
  /** Seconds from the start of the buffer. */
  readonly at: number;
  readonly gainDb: number;
  /** Muzzle/port resonance the pressure front excites, Hz. */
  readonly hz: number;
  readonly q: number;
  /** -60 dB time, seconds. Typically 2–8 ms. */
  readonly decay: number;
  /** Blend of raw impulse (0) to fully resonant (1). */
  readonly resonance?: number;
}

/**
 * A single-sample impulse driven through a resonant band-pass, plus a fraction
 * of the raw impulse so the very top octave survives. The raw component is what
 * gives the "snap"; the resonant component is what gives it a calibre.
 */
export function layerTransient(out: Float32Array, fs: number, spec: TransientSpec, seed: number): void {
  const start = Math.max(0, Math.floor(spec.at * fs));
  const n = Math.min(out.length - start, Math.ceil(spec.decay * 4 * fs) + 8);
  if (n <= 0) return;
  const bp = new Biquad().bandpass(fs, spec.hz, spec.q);
  const hp = new Biquad().highpass(fs, spec.hz * 0.35, 0.7);
  const g = dbToGain(spec.gainDb);
  const res = spec.resonance ?? 0.75;
  const noise = makeNoise(seed);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    // 3-sample excitation, not 1: a lone Dirac is a spectrally flat click that
    // survives no filter chain and reads as digital.
    const drive = i < 3 ? (1 - i / 3) * (1 + noise() * 0.25) : 0;
    const e = envExp(t, spec.decay);
    const y = res * bp.process(drive) + (1 - res) * hp.process(drive);
    out[start + i] += y * e * g;
  }
}

export interface NoiseBandSpec {
  readonly at: number;
  readonly gainDb: number;
  /** Band centre at t=0, Hz. */
  readonly hz0: number;
  /** Band centre at the end of the decay, Hz. Below hz0 for a blast. */
  readonly hz1: number;
  readonly q: number;
  /** Rise time, seconds. 0.0004 for a muzzle blast. */
  readonly attack: number;
  readonly decay: number;
  /** Envelope curvature; higher is more percussive. */
  readonly curve?: number;
  /** Extra low-pass on the whole band, Hz. Use for cloth and sand. */
  readonly lowpassHz?: number;
}

/** Swept band-passed noise. The workhorse: blast bodies, impacts, footsteps. */
export function layerNoiseBand(out: Float32Array, fs: number, spec: NoiseBandSpec, seed: number): void {
  const start = Math.max(0, Math.floor(spec.at * fs));
  const total = spec.attack + spec.decay;
  const n = Math.min(out.length - start, Math.ceil(total * fs) + 4);
  if (n <= 0) return;
  const noise = makeNoise(seed);
  const bp = new Biquad();
  const lp = spec.lowpassHz ? new Biquad().lowpass(fs, spec.lowpassHz, 0.707) : null;
  const g = dbToGain(spec.gainDb);
  const curve = spec.curve ?? 4;
  for (let i = 0; i < n; i++) {
    if (i % RETUNE === 0) {
      const k = i / n;
      // Exponential interpolation: pitch is logarithmic, so a linear sweep in
      // Hz audibly stalls at the top and rushes at the bottom.
      const hz = spec.hz0 * Math.pow(spec.hz1 / spec.hz0, k);
      bp.bandpass(fs, hz, spec.q);
    }
    const t = i / fs;
    let y = bp.process(noise());
    if (lp) y = lp.process(y);
    out[start + i] += y * envAD(t, spec.attack, spec.decay, curve) * g;
  }
}

export interface SweepSpec {
  readonly at: number;
  readonly gainDb: number;
  readonly hz0: number;
  readonly hz1: number;
  readonly decay: number;
  readonly attack?: number;
  /** Sweep shape: 1 linear in log-f, >1 falls faster early. */
  readonly bend?: number;
}

/**
 * Downward sine sweep — the low-frequency displacement of a muzzle blast or an
 * explosion. Phase is integrated, never `sin(2πf t)`: evaluating the latter with
 * a time-varying f produces a discontinuity you hear as a buzz.
 */
export function layerSweep(out: Float32Array, fs: number, spec: SweepSpec): void {
  const start = Math.max(0, Math.floor(spec.at * fs));
  const attack = spec.attack ?? 0.0008;
  const n = Math.min(out.length - start, Math.ceil((attack + spec.decay) * fs) + 4);
  if (n <= 0) return;
  const g = dbToGain(spec.gainDb);
  const bend = spec.bend ?? 1.6;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const k = Math.pow(clamp(t / (attack + spec.decay), 0, 1), bend);
    const hz = spec.hz0 * Math.pow(spec.hz1 / spec.hz0, k);
    phase += (TWO_PI * hz) / fs;
    out[start + i] += Math.sin(phase) * envAD(t, attack, spec.decay, 3.2) * g;
  }
}

export interface ModeSpec {
  readonly hz: number;
  readonly q: number;
  readonly decay: number;
  readonly gainDb: number;
}

/**
 * A struck resonator: N ringing modes excited by one short noise burst. This is
 * what separates metal from wood from glass. Modes are inharmonic on purpose —
 * a plate or a bell has no harmonic series, and spacing them by integer ratios
 * is exactly how a hit ends up sounding like a synthesised bell.
 */
export function layerModes(
  out: Float32Array,
  fs: number,
  at: number,
  exciteSeconds: number,
  modes: readonly ModeSpec[],
  seed: number,
): void {
  const start = Math.max(0, Math.floor(at * fs));
  let longest = 0;
  for (const m of modes) longest = Math.max(longest, m.decay);
  const n = Math.min(out.length - start, Math.ceil(longest * fs) + 8);
  if (n <= 0) return;
  const noise = makeNoise(seed);
  const filters = modes.map((m) => new Biquad().bandpass(fs, m.hz, m.q));
  const gains = modes.map((m) => dbToGain(m.gainDb));
  const exN = Math.max(1, Math.floor(exciteSeconds * fs));
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const drive = i < exN ? noise() * (1 - i / exN) : 0;
    let y = 0;
    for (let m = 0; m < modes.length; m++) {
      y += filters[m].process(drive) * envExp(t, modes[m].decay) * gains[m];
    }
    out[start + i] += y;
  }
}

/**
 * A short local room decay applied to the whole buffer in place — the near-field
 * reflections that belong to the CUE rather than to the environment. Four combs
 * and two allpasses; anything larger is the convolution send's job.
 */
export function layerRoom(out: Float32Array, fs: number, rt: number, wetDb: number, damp = 0.35): void {
  const wet = dbToGain(wetDb);
  const lengths = [0.0231, 0.0271, 0.0311, 0.0353];
  const combs = lengths.map((s) => new Comb(s * fs, Math.exp((-6.907755 * s) / Math.max(rt, 0.02)), damp));
  const aps = [new Allpass(0.0051 * fs, 0.5), new Allpass(0.0017 * fs, 0.5)];
  for (let i = 0; i < out.length; i++) {
    let y = 0;
    for (const c of combs) y += c.process(out[i]);
    y *= 0.25;
    for (const ap of aps) y = ap.process(y);
    out[i] += y * wet;
  }
}

/**
 * Air-absorption pre-filter for cues that are ALWAYS heard at range (`w.distant`
 * and `x.far`). The runtime model low-passes by distance as well; baking part of
 * it in lets those cues also lose their transient structure, which distance does
 * and a low-pass alone does not.
 */
export function smearTransients(buf: Float32Array, fs: number, spreadSeconds: number, seed: number): void {
  const taps = 24;
  const spread = Math.max(1, Math.floor(spreadSeconds * fs));
  const copy = Float32Array.from(buf);
  buf.fill(0);
  const rnd = makeNoise(seed);
  for (let k = 0; k < taps; k++) {
    const off = Math.floor(((rnd() * 0.5 + 0.5) ** 2) * spread);
    const g = (1 / taps) * (1 - k / (taps * 1.6));
    for (let i = 0; i < copy.length - off; i++) buf[i + off] += copy[i] * g;
  }
}

/** Band-limited pink-ish noise bed. Used by every ambience loop. */
export function fillPinkNoise(out: Float32Array, gain: number, seed: number): void {
  const noise = makeNoise(seed);
  // Paul Kellet's economy pink filter: -3 dB/oct to within 0.05 dB over 10 Hz–20 kHz.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = noise();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] += (b0 + b1 + b2 + w * 0.1848) * gain * 0.22;
  }
}
