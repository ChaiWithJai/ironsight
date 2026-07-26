/**
 * The job table. OWNER: BAKE.
 *
 * These functions run UNCHANGED on a worker thread and on the main thread — the
 * pool picks. Nothing here may touch `document`, `THREE`, the GL context or the
 * engine services; the import graph is deliberately limited to plain maths so
 * the worker bundle stays small and the inline path cannot diverge.
 */
import { IronNoise, hashU } from '@/bake/noise';
import type {
  BlueNoiseRequest,
  BlueNoiseResponse,
  ImpulseRequest,
  ImpulseResponse,
  JobResult,
  NoiseFieldRequest,
  NoiseFieldResponse,
  Sdf2dRequest,
  Sdf2dResponse,
} from '@/bake/workers/protocol';

const noise = new IronNoise();

/* -------------------------------------------------------------- SDF (2D) -- */

interface Cell {
  dx: number;
  dy: number;
}

/**
 * 8SSEDT — Danielsson's signed sweep, two passes over the grid, EXACT Euclidean
 * distance for everything but a handful of pathological configurations.
 *
 * A jump-flood on the GPU is faster but quantises to the texel grid; text at
 * small sizes lives or dies on the sub-texel accuracy of its distance field, so
 * the font atlas takes the CPU route and pays for it with a worker.
 */
function edt(width: number, height: number, inside: Uint8Array, want: number): Float32Array {
  const INF = 1e9;
  const grid: Cell[] = new Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const on = inside[i] === want;
    grid[i] = on ? { dx: 0, dy: 0 } : { dx: INF, dy: INF };
  }
  const at = (x: number, y: number): Cell =>
    x < 0 || y < 0 || x >= width || y >= height ? { dx: INF, dy: INF } : grid[y * width + x];
  const d2 = (c: Cell): number => c.dx * c.dx + c.dy * c.dy;
  const compare = (c: Cell, x: number, y: number, ox: number, oy: number): Cell => {
    const o = at(x + ox, y + oy);
    const cand = { dx: o.dx + ox, dy: o.dy + oy };
    return d2(cand) < d2(c) ? cand : c;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = grid[y * width + x];
      c = compare(c, x, y, -1, 0);
      c = compare(c, x, y, 0, -1);
      c = compare(c, x, y, -1, -1);
      c = compare(c, x, y, 1, -1);
      grid[y * width + x] = c;
    }
    for (let x = width - 1; x >= 0; x--) {
      let c = grid[y * width + x];
      c = compare(c, x, y, 1, 0);
      grid[y * width + x] = c;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      let c = grid[y * width + x];
      c = compare(c, x, y, 1, 0);
      c = compare(c, x, y, 0, 1);
      c = compare(c, x, y, 1, 1);
      c = compare(c, x, y, -1, 1);
      grid[y * width + x] = c;
    }
    for (let x = 0; x < width; x++) {
      let c = grid[y * width + x];
      c = compare(c, x, y, -1, 0);
      grid[y * width + x] = c;
    }
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = Math.sqrt(d2(grid[i]));
  return out;
}

export function jobSdf2d(req: Sdf2dRequest): JobResult<Sdf2dResponse> {
  const { width, height, spread } = req;
  const coverage = new Uint8Array(req.coverage);
  const inside = new Uint8Array(width * height);
  for (let i = 0; i < inside.length; i++) inside[i] = coverage[i] >= 128 ? 1 : 0;
  const dOut = edt(width, height, inside, 1);
  const dIn = edt(width, height, inside, 0);
  const sdf = new Uint8Array(width * height);
  for (let i = 0; i < sdf.length; i++) {
    // Signed: positive inside. The half-texel shift puts the true glyph edge on
    // 0.5 rather than between two codes, which is where the shader's
    // `smoothstep(0.5 - w, 0.5 + w, d)` expects it.
    const signed = inside[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
    const t = signed / spread;
    sdf[i] = Math.max(0, Math.min(255, Math.round((t * 0.5 + 0.5) * 255)));
  }
  return { value: { sdf: sdf.buffer }, transfer: [sdf.buffer] };
}

/* ------------------------------------------------------------ blue noise -- */

/**
 * Spatiotemporal blue noise. One void-and-cluster tile, then `slices` temporal
 * offsets along the golden-ratio (R1) sequence — Wolfe's cheap STBN: each slice
 * is blue over space, and any fixed texel walks a low-discrepancy sequence over
 * time, which is what TAA and the 4-tap PCF need to converge rather than crawl.
 */
export function jobBlueNoise(req: BlueNoiseRequest): JobResult<BlueNoiseResponse> {
  const { size, slices, seed } = req;
  const tile = noise.blueNoiseTile(size, seed);
  const out = new Uint8Array(size * size * slices);
  const golden = 0.61803398875;
  for (let z = 0; z < slices; z++) {
    const offset = (z * golden) % 1;
    for (let i = 0; i < tile.length; i++) {
      out[z * size * size + i] = Math.round((((tile[i] / 255 + offset) % 1) * 255));
    }
  }
  return { value: { data: out.buffer }, transfer: [out.buffer] };
}

/* ----------------------------------------------------------- noise field -- */

/** A domain-warped fBm height field, R32F, for terrain-shaped CPU consumers. */
export function jobNoiseField(req: NoiseFieldRequest): JobResult<NoiseFieldResponse> {
  const { width, height, extent, octaves, warp, seed } = req;
  const out = new Float32Array(width * height);
  const period = Math.max(1, Math.round(extent));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x / width) * period;
      const v = (y / height) * period;
      out[y * width + x] = noise.warpedFbm2(u, v, period, warp, octaves, seed);
    }
  }
  return { value: { data: out.buffer }, transfer: [out.buffer] };
}

/* -------------------------------------------------------------- impulses -- */

/**
 * A synthetic room impulse response.
 *
 * Structure: direct + early reflections from an image-source-ish sparse tap
 * pattern, then an exponentially decaying velvet-noise tail filtered per octave
 * band. Per-band RT60 is what makes a stone courtyard sound like stone: the
 * high bands die in a third of the time the low bands do, and a single
 * broadband decay is the classic "reverb preset" tell.
 */
export function jobImpulse(req: ImpulseRequest): JobResult<ImpulseResponse> {
  const { sampleRate, seconds, rt60, predelay, diffusion, seed } = req;
  const n = Math.max(1, Math.floor(sampleRate * seconds));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let state = (seed | 0) >>> 0 || 1;
  const rand = (): number => {
    state = hashU(state);
    return (state & 0x00ffffff) / 16777216;
  };

  const bands = rt60.length;
  // One-pole band-splitters: cheap, phase-sloppy, and completely adequate for a
  // tail nobody hears in isolation.
  const bandZ = new Float32Array(bands * 2);
  const bandCut: number[] = [];
  for (let b = 0; b < bands; b++) bandCut.push(125 * Math.pow(2, b));

  const preSamples = Math.floor(predelay * sampleRate);
  // Direct sound.
  left[0] = 1;
  right[0] = 1;

  // Early reflections: 12 sparse taps whose spacing grows with predelay.
  const taps = 12;
  for (let i = 0; i < taps; i++) {
    const t = preSamples + Math.floor((i + rand()) * predelay * sampleRate * 0.8);
    if (t >= n) break;
    const g = (0.75 / (1 + i * 0.55)) * (0.5 + diffusion * 0.5);
    const pan = rand();
    left[t] += g * (1 - pan * 0.6) * (rand() > 0.5 ? 1 : -1);
    right[t] += g * (0.4 + pan * 0.6) * (rand() > 0.5 ? 1 : -1);
  }

  // Velvet-noise tail: one signed impulse per short block rather than dense
  // Gaussian noise. Same perceived density, a fraction of the energy, and no
  // low-frequency rumble to high-pass out afterwards.
  const blockLen = Math.max(2, Math.floor(sampleRate / (900 + diffusion * 2600)));
  for (let t = preSamples; t < n; t += blockLen) {
    const idx = t + Math.floor(rand() * blockLen);
    if (idx >= n) break;
    const time = idx / sampleRate;
    let amp = 0;
    for (let b = 0; b < bands; b++) {
      // -60 dB over rt60 seconds.
      amp += Math.pow(10, (-3 * time) / Math.max(0.02, rt60[b])) / bands;
    }
    const s = (rand() > 0.5 ? 1 : -1) * amp;
    const pan = rand();
    left[idx] += s * (0.5 + (1 - pan) * 0.5);
    right[idx] += s * (0.5 + pan * 0.5);
  }

  // Per-band shaping of the whole tail: run each band through its own one-pole
  // and re-weight by its RT60 so bright rooms stay bright.
  for (let ch = 0; ch < 2; ch++) {
    const buf = ch === 0 ? left : right;
    bandZ.fill(0);
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      let acc = 0;
      let prevLp = x;
      for (let b = 0; b < bands; b++) {
        const cut = bandCut[b];
        const a = Math.exp((-2 * Math.PI * cut) / sampleRate);
        const zi = ch * bands + b;
        bandZ[zi] = prevLp * (1 - a) + bandZ[zi] * a;
        const lp = bandZ[zi];
        const bandSignal = prevLp - lp;
        const time = i / sampleRate;
        acc += bandSignal * Math.pow(10, (-3 * time) / Math.max(0.02, rt60[b]));
        prevLp = lp;
      }
      acc += prevLp;
      buf[i] = acc;
    }
  }

  // Peak-normalise so cue authors work in dB rather than guesswork.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  if (peak > 0) {
    const g = 1 / peak;
    for (let i = 0; i < n; i++) {
      left[i] *= g;
      right[i] *= g;
    }
  }
  return {
    value: { left: left.buffer, right: right.buffer, sampleRate },
    transfer: [left.buffer, right.buffer],
  };
}

/* ------------------------------------------------------------- registry -- */

export const JOBS: Readonly<Record<string, (payload: never) => JobResult<unknown>>> = {
  'bake.sdf2d': jobSdf2d as (p: never) => JobResult<unknown>,
  'bake.blueNoise': jobBlueNoise as (p: never) => JobResult<unknown>,
  'bake.noiseField': jobNoiseField as (p: never) => JobResult<unknown>,
  'bake.impulse': jobImpulse as (p: never) => JobResult<unknown>,
};

export const JOB_NAMES = Object.freeze(Object.keys(JOBS));
