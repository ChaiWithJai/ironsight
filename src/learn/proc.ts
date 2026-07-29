/**
 * Shared procedural helpers for the academy demos. LEARN owns this file.
 *
 * Everything here is a pure function of its integer inputs — no Math.random,
 * no wall clock, no state. That is not just repo law (the boundary CI enforces
 * it); it is the curriculum: Chapter I teaches that a world can be a function
 * of a seed, and these are the functions.
 *
 * The engine has a far more capable noise library (src/bake/noise.ts, with
 * matching GLSL) — the demos re-implement a miniature version instead of
 * importing it, so the whole pipeline a learner is looking at fits in one
 * small file with no GPU anywhere.
 */
import type { Rng } from '@/engine/types';

/** Integer coordinate hash → uint32. xxhash-style avalanche over Math.imul. */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (ix | 0), 0x85ebca6b);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (iy | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** hash2 mapped to [0, 1). */
export function rand2(ix: number, iy: number, seed: number): number {
  return hash2(ix, iy, seed) * 2.3283064365386963e-10;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smoothed bilinear value noise in [0, 1). */
export function valueNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = rand2(ix, iy, seed);
  const b = rand2(ix + 1, iy, seed);
  const c = rand2(ix, iy + 1, seed);
  const d = rand2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal Brownian motion: octaves of value noise, each finer and fainter. */
export function fbm2(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2(x * freq, y * freq, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * The height function every Chapter II–III demo agrees on. One island-ish
 * falloff over fBm, exactly the trick the real terrain bake uses at scale
 * (there it is called MACRO_TERRAIN and it is frozen for the same reason this
 * is exported from one place: everyone must sample the SAME land).
 */
export function heightAt(u: number, v: number, seed: number, octaves: number): number {
  const n = fbm2(u * 6, v * 6, seed, octaves);
  const dx = u - 0.5;
  const dy = v - 0.5;
  const falloff = 1 - Math.min(1, (dx * dx + dy * dy) * 2.6);
  return Math.max(0, n * 0.75 + 0.25) * falloff;
}

/** Syllable looms for naming what the seed brings forth. */
const HEADS = ['Kal', 'Dhar', 'Ora', 'Veth', 'Mira', 'Saam', 'Ish', 'Auro', 'Bel', 'Tarn', 'Ny', 'Zeph'];
const HEARTS = ['a', 'i', 'u', 'e', 'o', 'aa', 'ai'];
const TAILS = ['pur', 'gar', 'nath', 'holm', 'reach', 'vada', 'keep', 'stan', 'mor', 'desh'];

/** A deterministic place-name drawn from an rng stream. */
export function placeName(rng: Rng): string {
  return rng.pick(HEADS) + rng.pick(HEARTS) + rng.pick(TAILS);
}

/** FNV-1a over a numeric sequence — the fingerprint used by the Gate's rituals. */
export function fingerprint(values: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) {
    // Fold each float's uint32 view in, byte by byte.
    const v = values[i];
    const scaled = Math.floor(v * 0xffffffff) >>> 0;
    for (let b = 0; b < 4; b++) {
      h ^= (scaled >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
