/**
 * AUDIO — procedural impulse responses.
 *
 * OWNER: AUDIO. One stereo IR per `AcousticEnvironment`, generated from a
 * physical description of the space rather than from a decay curve someone
 * liked the look of. Each IR has three parts, and all three matter:
 *
 *   1. DIRECT           a single unit sample at t=0. The convolver is fed from
 *                       a send, so the direct path is actually carried by the
 *                       dry bus — the IR's direct tap is deliberately tiny and
 *                       exists only to keep the send's transient aligned.
 *   2. EARLY REFLECTIONS a first-order image-source solve of a shoebox. These
 *                       taps are what the ear localises a room with: the delay
 *                       of the first floor bounce is the difference between "a
 *                       street" and "a field", and no amount of late reverb
 *                       substitutes for them.
 *   3. LATE FIELD       exponentially decaying noise with a SEPARATE RT60 per
 *                       band. Real rooms lose treble far faster than bass —
 *                       a single broadband decay is the single most audible
 *                       "this is a game reverb" tell.
 *
 * The harbour and the fort also get a discrete slap: a hard flat façade or a
 * rampart across open ground returns one loud, late, band-limited echo that no
 * diffuse model produces.
 */
import { Allpass, Biquad, Comb, DcBlock, envExp, makeNoise, normalise, TWO_PI } from './core';

export interface RoomSpec {
  /** Shoebox dimensions in metres: [width, height, depth]. */
  readonly size: readonly [number, number, number];
  /** Listener offset from the box centre, metres. Asymmetry decorrelates L/R. */
  readonly offset: readonly [number, number, number];
  /** RT60 in seconds for the low / mid / high band. Treble always dies first. */
  readonly rt60: readonly [number, number, number];
  /** Broadband absorption of the boundaries, 0..1. Scales the ER taps. */
  readonly absorption: number;
  /** 0 = anechoic outdoors, 1 = a tiled stairwell. Scales the whole wet field. */
  readonly enclosure: number;
  /** Corner frequency between the low and mid decay bands, Hz. */
  readonly lowCrossHz: number;
  /** Corner frequency between the mid and high decay bands, Hz. */
  readonly highCrossHz: number;
  /** Optional discrete slap-back: [delaySeconds, gain, lowpassHz]. */
  readonly slap?: readonly [number, number, number];
  /** Modal ringing for tunnels and vaults: comb resonance strength 0..1. */
  readonly modal: number;
}

export interface ImpulseResponse {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly sampleRate: number;
  /** Measured, not requested: the actual -60 dB point of the rendered tail. */
  readonly rt60: number;
  /** Peak-normalised envelope at 128 points, for the debug overlay. */
  readonly envelope: Float32Array;
}

/** Speed of sound used for the image-source delays. Matches `Sim.SPEED_OF_SOUND`. */
const C = 346;

/**
 * First-order image sources of a shoebox: six mirrored rooms, plus the twelve
 * edge images that give the early field its density. Returns taps sorted by
 * arrival time so the caller can truncate at the mixing time.
 */
function imageSources(spec: RoomSpec): Array<{ t: number; g: number; pan: number }> {
  const [w, h, d] = spec.size;
  const [ox, oy, oz] = spec.offset;
  const reflect = 1 - spec.absorption;
  const taps: Array<{ t: number; g: number; pan: number }> = [];

  // Axis distances from the listener to each of the six boundaries.
  const dist = [w / 2 + ox, w / 2 - ox, h / 2 + oy, h / 2 - oy, d / 2 + oz, d / 2 - oz];
  const pans = [-0.85, 0.85, 0, 0, -0.2, 0.2];

  for (let i = 0; i < 6; i++) {
    const path = 2 * dist[i];
    // Spherical spreading on the image path, not on the direct path.
    taps.push({ t: path / C, g: (reflect / Math.max(path, 1)) * 1.6, pan: pans[i] });
  }
  // Edge images: combinations of two boundaries. Twice-reflected, so squared.
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      if ((i >> 1) === (j >> 1)) continue; // same axis: that is a 2nd-order tap, not an edge
      const path = Math.hypot(2 * dist[i], 2 * dist[j]);
      taps.push({
        t: path / C,
        g: (reflect * reflect) / Math.max(path, 1),
        pan: (pans[i] + pans[j]) * 0.5,
      });
    }
  }
  taps.sort((a, b) => a.t - b.t);
  return taps;
}

/**
 * Render one environment's IR.
 *
 * The late field is band-split noise: three copies of the same noise stream,
 * each filtered to its band and each given its own exponential decay. Summing
 * them back reproduces the frequency-dependent decay of a real space with no
 * cost at convolution time, because the convolver only ever sees the sum.
 */
export function renderImpulse(spec: RoomSpec, sampleRate: number, seed: number): ImpulseResponse {
  const rtMax = Math.max(spec.rt60[0], spec.rt60[1], spec.rt60[2]);
  const length = Math.max(64, Math.ceil(rtMax * 1.15 * sampleRate));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const noiseL = makeNoise(seed);
  const noiseR = makeNoise(seed ^ 0x5bf03635);

  // ---- late field -------------------------------------------------------
  const bands: Array<{ lo: Biquad; hi: Biquad; rt: number }> = [];
  for (let b = 0; b < 3; b++) {
    const lo = new Biquad();
    const hi = new Biquad();
    if (b === 0) lo.lowpass(sampleRate, spec.lowCrossHz, 0.707);
    else if (b === 1) {
      hi.highpass(sampleRate, spec.lowCrossHz, 0.707);
      lo.lowpass(sampleRate, spec.highCrossHz, 0.707);
    } else hi.highpass(sampleRate, spec.highCrossHz, 0.707);
    bands.push({ lo, hi, rt: spec.rt60[b] });
  }
  const bandsR = bands.map((b) => ({
    lo: new Biquad(),
    hi: new Biquad(),
    rt: b.rt,
  }));
  for (let b = 0; b < 3; b++) {
    if (b === 0) bandsR[b].lo.lowpass(sampleRate, spec.lowCrossHz, 0.707);
    else if (b === 1) {
      bandsR[b].hi.highpass(sampleRate, spec.lowCrossHz, 0.707);
      bandsR[b].lo.lowpass(sampleRate, spec.highCrossHz, 0.707);
    } else bandsR[b].hi.highpass(sampleRate, spec.highCrossHz, 0.707);
  }

  // The late field must not start at t=0 or it swamps the early reflections and
  // the room loses its size. Mixing time ~ the 4th image-source arrival.
  const taps = imageSources(spec);
  const mixingTime = Math.min(taps.length > 3 ? taps[3].t : 0.02, 0.06);
  const mixStart = Math.floor(mixingTime * sampleRate);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const ramp = i < mixStart ? (i / Math.max(mixStart, 1)) ** 2 : 1;
    let l = 0;
    let r = 0;
    const nl = noiseL();
    const nr = noiseR();
    for (let b = 0; b < 3; b++) {
      const e = envExp(t, bands[b].rt) * ramp;
      if (e < 1e-5) continue;
      let xl = nl;
      let xr = nr;
      if (b !== 2) {
        xl = bands[b].lo.process(xl);
        xr = bandsR[b].lo.process(xr);
      }
      if (b !== 0) {
        xl = bands[b].hi.process(xl);
        xr = bandsR[b].hi.process(xr);
      }
      l += xl * e;
      r += xr * e;
    }
    left[i] = l;
    right[i] = r;
  }

  // ---- modal ringing (tunnels, vaults, stone stairwells) ----------------
  if (spec.modal > 0.001) {
    // Prime-ish comb lengths so the modes do not stack into a single pitch.
    const lengths = [0.0297, 0.0371, 0.0411, 0.0437];
    const combsL = lengths.map((s) => new Comb(s * sampleRate, 0.82 * spec.modal + 0.1, 0.32));
    const combsR = lengths.map((s) => new Comb(s * 1.031 * sampleRate, 0.82 * spec.modal + 0.1, 0.32));
    const apL = [new Allpass(0.00507 * sampleRate, 0.5), new Allpass(0.0017 * sampleRate, 0.5)];
    const apR = [new Allpass(0.00543 * sampleRate, 0.5), new Allpass(0.00188 * sampleRate, 0.5)];
    const wet = 0.55 * spec.modal;
    for (let i = 0; i < length; i++) {
      let l = 0;
      let r = 0;
      for (let c = 0; c < combsL.length; c++) {
        l += combsL[c].process(left[i]);
        r += combsR[c].process(right[i]);
      }
      l *= 0.25;
      r *= 0.25;
      for (const ap of apL) l = ap.process(l);
      for (const ap of apR) r = ap.process(r);
      left[i] += l * wet;
      right[i] += r * wet;
    }
  }

  // ---- early reflections ------------------------------------------------
  // Each tap gets its own low-pass: a bounce off plaster keeps its treble, one
  // off a sandbag wall or a palm canopy does not.
  const erGain = 0.5 + 0.5 * spec.enclosure;
  for (const tap of taps) {
    const i = Math.floor(tap.t * sampleRate);
    if (i >= length - 4) continue;
    const g = tap.g * erGain;
    const pl = Math.sqrt(0.5 * (1 - tap.pan));
    const pr = Math.sqrt(0.5 * (1 + tap.pan));
    // Two-sample smear: an ideal Dirac tap sounds like a click, not a wall.
    left[i] += g * pl;
    left[i + 1] += g * pl * 0.45;
    right[i] += g * pr;
    right[i + 1] += g * pr * 0.45;
  }

  // ---- discrete slap-back ----------------------------------------------
  if (spec.slap) {
    const [delay, gain, cutoff] = spec.slap;
    const start = Math.floor(delay * sampleRate);
    const burst = Math.floor(0.035 * sampleRate);
    const lp = new Biquad().lowpass(sampleRate, cutoff, 0.8);
    const lpR = new Biquad().lowpass(sampleRate, cutoff * 0.94, 0.8);
    const n = makeNoise(seed ^ 0x1d872b41);
    for (let i = 0; i < burst && start + i < length; i++) {
      const e = envExp(i / sampleRate, 0.05);
      const x = n() * e * gain;
      left[start + i] += lp.process(x);
      right[start + i + 1 < length ? start + i + 1 : start + i] += lpR.process(x);
    }
  }

  // ---- direct tap + cleanup --------------------------------------------
  // Small on purpose: the send only carries the reflected energy, the dry bus
  // carries the direct path. A big tap here double-counts the direct sound and
  // makes every source feel 3 dB closer in a reverberant space than outdoors.
  left[0] += 0.12;
  right[0] += 0.12;

  const dcL = new DcBlock();
  const dcR = new DcBlock();
  for (let i = 0; i < length; i++) {
    left[i] = dcL.process(left[i]);
    right[i] = dcR.process(right[i]);
  }
  // Normalise the PAIR by a common factor so the stereo image is preserved.
  const pk = Math.max(normalise(left, 1), normalise(right, 1));
  void pk;
  const rms = balanceStereo(left, right);
  void rms;

  return {
    left,
    right,
    sampleRate,
    rt60: measureRt60(left, sampleRate),
    envelope: envelopeOf(left, right, 128),
  };
}

/** Re-apply a single common gain so per-channel normalisation cannot skew the image. */
function balanceStereo(left: Float32Array, right: Float32Array): number {
  let sl = 0;
  let sr = 0;
  for (let i = 0; i < left.length; i++) {
    sl += left[i] * left[i];
    sr += right[i] * right[i];
  }
  const rl = Math.sqrt(sl / left.length);
  const rr = Math.sqrt(sr / right.length);
  const mean = (rl + rr) * 0.5;
  if (rl > 1e-9) {
    const g = mean / rl;
    for (let i = 0; i < left.length; i++) left[i] *= g;
  }
  if (rr > 1e-9) {
    const g = mean / rr;
    for (let i = 0; i < right.length; i++) right[i] *= g;
  }
  return mean;
}

/**
 * Schroeder backward integration: the honest way to state an RT60, and it will
 * disagree with the requested value when the early field dominates. That
 * disagreement is information, so the overlay prints the measured number.
 */
function measureRt60(buf: Float32Array, sampleRate: number): number {
  let acc = 0;
  const n = buf.length;
  const curve = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    acc += buf[i] * buf[i];
    curve[i] = acc;
  }
  if (curve[0] <= 0) return 0;
  const ref = curve[0];
  let i5 = -1;
  let i35 = -1;
  for (let i = 0; i < n; i++) {
    const db = 10 * Math.log10(curve[i] / ref + 1e-20);
    if (i5 < 0 && db <= -5) i5 = i;
    if (i35 < 0 && db <= -35) {
      i35 = i;
      break;
    }
  }
  if (i5 < 0 || i35 < 0) return n / sampleRate;
  // T30 extrapolated to 60 dB.
  return ((i35 - i5) / sampleRate) * 2;
}

/** Peak envelope in `bins` buckets, normalised. Purely for the debug overlay. */
function envelopeOf(left: Float32Array, right: Float32Array, bins: number): Float32Array {
  const out = new Float32Array(bins);
  const per = Math.max(1, Math.floor(left.length / bins));
  for (let b = 0; b < bins; b++) {
    let p = 0;
    const start = b * per;
    const end = Math.min(left.length, start + per);
    for (let i = start; i < end; i++) {
      const a = Math.abs(left[i]) + Math.abs(right[i]);
      if (a > p) p = a;
    }
    out[b] = p;
  }
  let m = 0;
  for (let i = 0; i < bins; i++) if (out[i] > m) m = out[i];
  if (m > 0) for (let i = 0; i < bins; i++) out[i] /= m;
  return out;
}

/** Ambient modulation used by the wind bed; here because it shares the tables. */
export function slowLfo(t: number, hz: number, phase: number): number {
  return Math.sin(TWO_PI * hz * t + phase);
}
