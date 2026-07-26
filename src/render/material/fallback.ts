/**
 * TextureSets for the surfaces the bake has no recipe and no alias for.
 *
 * OWNER: RCORE.
 *
 * `MaterialLibrary.get` returns undefined for the long tail — glass, water,
 * flesh, rubber, foliage, grating — and the documented fallback is "the caller
 * uses its analytic profile rather than showing a black square". A FLAT colour
 * is the first entry on the brief's defect list, so the fallback here is a real
 * three-octave field with a height, a normal, a roughness and an AO, generated
 * on the CPU from the seeded RNG at 128². That is small, but these are surfaces
 * that are either tiny in frame (a scope lens), overwritten by a lane's own
 * surface shader (water), or genuinely near-featureless (glass), and 128² of
 * real variation beats 4² of nothing at every distance.
 */
import * as THREE from 'three';
import { SurfaceId, type Rng, type TextureSet } from '@/engine/types';

const EDGE = 128;

interface FallbackRecipe {
  /** Linear base colour. */
  readonly color: readonly [number, number, number];
  /** Linear second colour the macro field blends toward. */
  readonly color2: readonly [number, number, number];
  readonly roughness: number;
  readonly roughVariation: number;
  /** Height amplitude in the packed 0..1 height channel. */
  readonly relief: number;
  /** Cells across the tile at the three scales. */
  readonly freq: readonly [number, number, number];
  readonly metalness: number;
  /** World metres per repeat. */
  readonly tiling: number;
}

const FALLBACKS: Partial<Record<SurfaceId, FallbackRecipe>> = {
  [SurfaceId.Glass]: {
    color: [0.045, 0.055, 0.052], color2: [0.06, 0.07, 0.068],
    roughness: 0.08, roughVariation: 0.04, relief: 0.02, freq: [2, 7, 26], metalness: 0, tiling: 1.5,
  },
  [SurfaceId.Water]: {
    color: [0.02, 0.05, 0.055], color2: [0.03, 0.07, 0.075],
    roughness: 0.08, roughVariation: 0.06, relief: 0.10, freq: [3, 11, 37], metalness: 0, tiling: 4.0,
  },
  [SurfaceId.Foliage]: {
    color: [0.055, 0.095, 0.032], color2: [0.10, 0.13, 0.05],
    roughness: 0.62, roughVariation: 0.16, relief: 0.22, freq: [2, 9, 44], metalness: 0, tiling: 0.6,
  },
  [SurfaceId.Bark]: {
    color: [0.10, 0.075, 0.055], color2: [0.055, 0.042, 0.032],
    roughness: 0.88, roughVariation: 0.12, relief: 0.42, freq: [2, 6, 40], metalness: 0, tiling: 0.9,
  },
  [SurfaceId.Rubber]: {
    color: [0.030, 0.031, 0.034], color2: [0.042, 0.043, 0.046],
    roughness: 0.72, roughVariation: 0.10, relief: 0.14, freq: [3, 14, 52], metalness: 0, tiling: 0.8,
  },
  [SurfaceId.Flesh]: {
    color: [0.24, 0.13, 0.10], color2: [0.30, 0.17, 0.13],
    roughness: 0.52, roughVariation: 0.12, relief: 0.10, freq: [3, 13, 48], metalness: 0, tiling: 0.5,
  },
  [SurfaceId.Grating]: {
    color: [0.055, 0.058, 0.060], color2: [0.085, 0.086, 0.088],
    roughness: 0.62, roughVariation: 0.14, relief: 0.30, freq: [2, 8, 30], metalness: 1, tiling: 1.2,
  },
};

/** The recipe used when a surface has neither a bake nor a row above. */
const GENERIC: FallbackRecipe = {
  color: [0.19, 0.17, 0.14], color2: [0.26, 0.23, 0.19],
  roughness: 0.82, roughVariation: 0.12, relief: 0.20, freq: [3, 12, 44], metalness: 0, tiling: 1.6,
};

/* --------------------------------------------------------------- noise ---- */

/** Tileable value noise over a `cells`-periodic lattice. */
function makeLattice(cells: number, rng: Rng): Float32Array {
  const v = new Float32Array(cells * cells);
  for (let i = 0; i < v.length; i++) v[i] = rng.next();
  return v;
}

function sampleLattice(v: Float32Array, cells: number, x: number, y: number): number {
  const fx = x * cells;
  const fy = y * cells;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let tx = fx - ix;
  let ty = fy - iy;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const wrap = (n: number): number => ((n % cells) + cells) % cells;
  const x0 = wrap(ix);
  const x1 = wrap(ix + 1);
  const y0 = wrap(iy);
  const y1 = wrap(iy + 1);
  const a = v[y0 * cells + x0];
  const b = v[y0 * cells + x1];
  const c = v[y1 * cells + x0];
  const d = v[y1 * cells + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/**
 * Build the canonical two-sampler set plus a wear map, with the SAME channel
 * packing the bake uses — so the uber material cannot tell a fallback from a
 * baked set and there is no second code path in the shader.
 */
/**
 * The roughness a set's blue channel is centred on. The uber material treats
 * the texture's roughness as a DEVIATION from this, so a lane's authored
 * roughness survives while the texture's variation is preserved; a fallback set
 * knows its own centre exactly, and the baked sets are centred on the mean of
 * the six shipped recipes.
 */
const ROUGH_CENTRE = new WeakMap<object, number>();

/** 0.76 is the mean base roughness of BAKE's six shipped material recipes. */
export const BAKED_ROUGH_CENTRE = 0.76;

export function roughCentreOf(set: TextureSet): number {
  return ROUGH_CENTRE.get(set) ?? BAKED_ROUGH_CENTRE;
}

export function buildFallbackTextureSet(surface: SurfaceId, rng: Rng): TextureSet {
  const r = FALLBACKS[surface] ?? GENERIC;
  const stream = rng.fork(`fallback.${surface}`);
  const lat = r.freq.map((c) => ({ cells: Math.max(2, c), data: makeLattice(Math.max(2, c), stream) }));

  const height = new Float32Array(EDGE * EDGE);
  const albedo = new Uint8Array(EDGE * EDGE * 4);
  const nra = new Uint8Array(EDGE * EDGE * 4);
  const wear = new Uint8Array(EDGE * EDGE * 4);

  const toSrgb = (linear: number): number => {
    const c = Math.max(0, Math.min(1, linear));
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  };

  for (let y = 0; y < EDGE; y++) {
    for (let x = 0; x < EDGE; x++) {
      const u = x / EDGE;
      const v = y / EDGE;
      const macro = sampleLattice(lat[0].data, lat[0].cells, u, v);
      const meso = sampleLattice(lat[1].data, lat[1].cells, u, v);
      const micro = sampleLattice(lat[2].data, lat[2].cells, u, v);
      const i = y * EDGE + x;
      height[i] = 0.5 + (macro - 0.5) * r.relief + (meso - 0.5) * r.relief * 0.55 + (micro - 0.5) * r.relief * 0.22;

      const blend = Math.max(0, Math.min(1, macro * 0.8 + meso * 0.35 - 0.07));
      const value = 0.9 + meso * 0.16 + micro * 0.08;
      for (let c = 0; c < 3; c++) {
        const lin = (r.color[c] + (r.color2[c] - r.color[c]) * blend) * value;
        albedo[i * 4 + c] = toSrgb(lin);
      }
      const rough = Math.max(0.03, Math.min(1, r.roughness + (meso - 0.5) * r.roughVariation * 2));
      nra[i * 4 + 2] = Math.round(rough * 255);
    }
  }

  // Normal, AO and curvature from the finished height field — the same
  // derivation the bake uses, so the normal cannot disagree with the height and
  // parallax stays stable.
  const at = (x: number, y: number): number => height[((y + EDGE) % EDGE) * EDGE + ((x + EDGE) % EDGE)];
  for (let y = 0; y < EDGE; y++) {
    for (let x = 0; x < EDGE; x++) {
      const i = y * EDGE + x;
      const hl = at(x - 1, y);
      const hr = at(x + 1, y);
      const hd = at(x, y - 1);
      const hu = at(x, y + 1);
      const nx = (hl - hr) * 6;
      const ny = (hd - hu) * 6;
      const len = Math.hypot(nx, ny, 1);
      nra[i * 4] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      nra[i * 4 + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      // Laplacian: positive = crease, negative = edge.
      const lap = hl + hr + hu + hd - 4 * height[i];
      const convex = Math.max(0, Math.min(1, -lap * 26));
      const concave = Math.max(0, Math.min(1, lap * 26));
      const ao = Math.max(0, Math.min(1, 1 - concave * 0.7));
      nra[i * 4 + 3] = Math.round(ao * 255);
      albedo[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, height[i])) * 255);
      wear[i * 4] = Math.round(convex * 255);
      wear[i * 4 + 1] = Math.round(concave * 255);
      wear[i * 4 + 2] = Math.round(ao * 255);
      wear[i * 4 + 3] = Math.round(convex * 255);
    }
  }

  const tex = (data: Uint8Array, colorSpace: string): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, EDGE, EDGE);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  const set: TextureSet = {
    albedoHeight: tex(albedo, THREE.SRGBColorSpace),
    normalRoughAo: tex(nra, THREE.NoColorSpace),
    wear: tex(wear, THREE.NoColorSpace),
    tiling: r.tiling,
    metalness: r.metalness,
  };
  ROUGH_CENTRE.set(set, r.roughness);
  return set;
}
