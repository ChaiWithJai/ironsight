/**
 * NoiseLib — the CPU half of the shared noise library.
 *
 * OWNER: BAKE. Every function here is the bit-matched twin of a chunk in
 * `src/bake/glsl/index.ts`: the same `lowbias32` integer hash, the same lattice,
 * the same quintic interpolant, the same per-octave seed schedule. The only
 * legal divergence is float64-vs-float32 rounding, which is ~1e-7 relative.
 *
 * That parity is a correctness requirement, not a nicety. `TerrainService.heightAt`
 * drives physics, navigation and vegetation scatter while the terrain vertex
 * shader displaces the mesh from the same field; if the two fork, players float
 * over bumps and sink into dips, and the bug presents three lanes from its cause.
 *
 * `Math.imul` plus `>>> 0` reproduces GLSL's `uint` arithmetic EXACTLY, which is
 * the whole reason the hash is integer rather than the usual `fract(sin(...))`.
 */
import type { NoiseLib, Rng, Vec2, Vec3 } from '@/engine/types';
import { NOISE_GLSL } from '@/bake/glsl/index';

/* ------------------------------------------------------------------- hash -- */

/** Wellons' lowbias32. Identical output to `ironHashU` in GLSL. */
export function hashU(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function hash2u(x: number, y: number, seed: number): number {
  return hashU((x + hashU((y + seed) >>> 0)) >>> 0);
}

function hash3u(x: number, y: number, z: number, seed: number): number {
  return hashU((x + hashU((y + hashU((z + seed) >>> 0)) >>> 0)) >>> 0);
}

/** 24 bits — exactly representable in a float32 mantissa, so both devices agree. */
function unorm(h: number): number {
  return (h & 0x00ffffff) / 16777216;
}

function hash2(x: number, y: number, seed: number): number {
  return unorm(hash2u(x, y, seed));
}

function hash3(x: number, y: number, z: number, seed: number): number {
  return unorm(hash3u(x, y, z, seed));
}

const TAU = 6.28318530718;

function wrap(v: number, period: number): number {
  return period > 0 ? ((v % period) + period) % period : v;
}

/* ------------------------------------------------------------ interpolants -- */

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function fadeD(t: number): number {
  return 30 * t * t * (t * (t - 2) + 1);
}

/* ------------------------------------------------------------------ result -- */

/** Scratch for gradient-returning calls, so the hot path allocates nothing. */
export interface Grad2 {
  x: number;
  y: number;
}

/** Scratch for 3D gradient-returning calls. */
export interface Grad3 {
  x: number;
  y: number;
  z: number;
}

export interface VoronoiResult {
  f1: number;
  f2: number;
  cellX: number;
  cellY: number;
  id: number;
}

/* ------------------------------------------------------------------- impl -- */

export class IronNoise implements NoiseLib {
  readonly glsl = NOISE_GLSL;

  /* ------------------------------------------------------------ value ---- */

  value2(x: number, y: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fade(fx);
    const uy = fade(fy);
    const s = seed >>> 0;
    const a = hash2(ix, iy, s);
    const b = hash2(ix + 1, iy, s);
    const c = hash2(ix, iy + 1, s);
    const d = hash2(ix + 1, iy + 1, s);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  }

  value3(x: number, y: number, z: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const ux = fade(x - ix);
    const uy = fade(y - iy);
    const uz = fade(z - iz);
    const s = seed >>> 0;
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const a = lerp(
      lerp(hash3(ix, iy, iz, s), hash3(ix + 1, iy, iz, s), ux),
      lerp(hash3(ix, iy + 1, iz, s), hash3(ix + 1, iy + 1, iz, s), ux),
      uy,
    );
    const b = lerp(
      lerp(hash3(ix, iy, iz + 1, s), hash3(ix + 1, iy, iz + 1, s), ux),
      lerp(hash3(ix, iy + 1, iz + 1, s), hash3(ix + 1, iy + 1, iz + 1, s), ux),
      uy,
    );
    return lerp(a, b, uz);
  }

  /* ----------------------------------------------------------- gradient ---- */

  /**
   * Gradient (Perlin) noise with its ANALYTIC derivative. `outGrad` receives
   * d/dx and d/dy. Twin of `ironPerlinD2`.
   *
   * Analytic derivatives are why normal maps out of this bake are exact instead
   * of a four-tap finite difference: a finite difference at texel scale is a
   * low-pass filter, and the visible result is a normal map that goes flat
   * exactly where the micro-detail matters most.
   */
  gradient2(x: number, y: number, seed: number, outGrad?: Grad2): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fade(fx);
    const uy = fade(fy);
    const dux = fadeD(fx);
    const duy = fadeD(fy);
    const s = seed >>> 0;

    const aa = hash2(ix, iy, s) * TAU;
    const ba = hash2(ix + 1, iy, s) * TAU;
    const ca = hash2(ix, iy + 1, s) * TAU;
    const da = hash2(ix + 1, iy + 1, s) * TAU;
    const gax = Math.cos(aa), gay = Math.sin(aa);
    const gbx = Math.cos(ba), gby = Math.sin(ba);
    const gcx = Math.cos(ca), gcy = Math.sin(ca);
    const gdx = Math.cos(da), gdy = Math.sin(da);

    const va = gax * fx + gay * fy;
    const vb = gbx * (fx - 1) + gby * fy;
    const vc = gcx * fx + gcy * (fy - 1);
    const vd = gdx * (fx - 1) + gdy * (fy - 1);

    const k1 = vb - va;
    const k2 = vc - va;
    const k3 = va - vb - vc + vd;
    const v = va + k1 * ux + k2 * uy + k3 * ux * uy;

    if (outGrad) {
      outGrad.x =
        (gax + ux * (gbx - gax) + uy * (gcx - gax) + ux * uy * (gax - gbx - gcx + gdx) + dux * (k1 + k3 * uy)) *
        1.4142136;
      outGrad.y =
        (gay + ux * (gby - gay) + uy * (gcy - gay) + ux * uy * (gay - gby - gcy + gdy) + duy * (k2 + k3 * ux)) *
        1.4142136;
    }
    return v * 1.4142136;
  }

  perlin2(x: number, y: number, seed: number): number {
    return this.gradient2(x, y, seed);
  }

  perlin2Tiled(x: number, y: number, period: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fade(fx);
    const uy = fade(fy);
    const s = seed >>> 0;
    const g = (cx: number, cy: number, ox: number, oy: number): number => {
      const a = hash2(wrap(cx, period), wrap(cy, period), s) * TAU;
      return Math.cos(a) * (fx - ox) + Math.sin(a) * (fy - oy);
    };
    const va = g(ix, iy, 0, 0);
    const vb = g(ix + 1, iy, 1, 0);
    const vc = g(ix, iy + 1, 0, 1);
    const vd = g(ix + 1, iy + 1, 1, 1);
    return ((va + (vb - va) * ux) * (1 - uy) + (vc + (vd - vc) * ux) * uy) * 1.4142136;
  }

  /**
   * 3D gradient noise with its analytic gradient in `outGrad`. Twin of
   * `ironPerlinD3`; the exact gradients are what make `curl3` divergence-free.
   */
  perlin3(x: number, y: number, z: number, seed: number, outGrad?: Grad3): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const ux = fade(fx), uy = fade(fy), uz = fade(fz);
    const dux = fadeD(fx), duy = fadeD(fy), duz = fadeD(fz);
    const s = seed >>> 0;

    // Eight corner gradients, area-uniform on the sphere (matches ironGrad3).
    const gx = new Float64Array(8);
    const gy = new Float64Array(8);
    const gz = new Float64Array(8);
    const val = new Float64Array(8);
    for (let cz = 0; cz <= 1; cz++) {
      for (let cy = 0; cy <= 1; cy++) {
        for (let cx = 0; cx <= 1; cx++) {
          const h = hash3u(ix + cx, iy + cy, iz + cz, s);
          const zz = unorm(h) * 2 - 1;
          const a = unorm(hashU(h)) * TAU;
          const r = Math.sqrt(Math.max(0, 1 - zz * zz));
          const vx = r * Math.cos(a);
          const vy = r * Math.sin(a);
          const idx = cx + cy * 2 + cz * 4;
          gx[idx] = vx;
          gy[idx] = vy;
          gz[idx] = zz;
          val[idx] = vx * (fx - cx) + vy * (fy - cy) + zz * (fz - cz);
        }
      }
    }
    const v000 = val[0], v100 = val[1], v010 = val[2], v110 = val[3];
    const v001 = val[4], v101 = val[5], v011 = val[6], v111 = val[7];
    const k0 = v000;
    const k1 = v100 - v000;
    const k2 = v010 - v000;
    const k3 = v001 - v000;
    const k4 = v000 - v100 - v010 + v110;
    const k5 = v000 - v010 - v001 + v011;
    const k6 = v000 - v100 - v001 + v101;
    const k7 = -v000 + v100 + v010 - v110 + v001 - v101 - v011 + v111;
    const v =
      k0 + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;

    if (outGrad) {
      const comp = (g: Float64Array): number =>
        g[0] +
        ux * (g[1] - g[0]) +
        uy * (g[2] - g[0]) +
        uz * (g[4] - g[0]) +
        ux * uy * (g[0] - g[1] - g[2] + g[3]) +
        uy * uz * (g[0] - g[2] - g[4] + g[6]) +
        uz * ux * (g[0] - g[1] - g[4] + g[5]) +
        ux * uy * uz * (-g[0] + g[1] + g[2] - g[3] + g[4] - g[5] - g[6] + g[7]);
      outGrad.x = (comp(gx) + dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz)) * 1.1547005;
      outGrad.y = (comp(gy) + duy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux)) * 1.1547005;
      outGrad.z = (comp(gz) + duz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy)) * 1.1547005;
    }
    return v * 1.1547005;
  }

  /* ------------------------------------------------------------ simplex ---- */

  /** True 2D simplex noise. Twin of `ironSimplexD2`. */
  simplex2(x: number, y: number, seed: number, outGrad?: Grad2): number {
    const F2 = 0.36602540378;
    const G2 = 0.2113248654;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const sd = seed >>> 0;

    let n = 0;
    let gxAcc = 0;
    let gyAcc = 0;
    const corner = (cx: number, cy: number, dx: number, dy: number): void => {
      const w = 0.5 - (dx * dx + dy * dy);
      if (w <= 0) return;
      const a = hash2(cx, cy, sd) * TAU;
      const gx = Math.cos(a);
      const gy = Math.sin(a);
      const w2 = w * w;
      const w4 = w2 * w2;
      const d = gx * dx + gy * dy;
      n += w4 * d;
      gxAcc += w4 * gx - 8 * w * w2 * d * dx;
      gyAcc += w4 * gy - 8 * w * w2 * d * dy;
    };
    corner(i, j, x0, y0);
    corner(i + i1, j + j1, x1, y1);
    corner(i + 1, j + 1, x2, y2);
    if (outGrad) {
      outGrad.x = gxAcc * 70;
      outGrad.y = gyAcc * 70;
    }
    return n * 70;
  }

  simplex3(x: number, y: number, z: number, seed: number): number {
    return this.perlin3(x, y, z, seed);
  }

  /* ---------------------------------------------------------------- fbm ---- */

  fbm2(x: number, y: number, octaves: number, lacunarity: number, gain: number, seed: number): number {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    let px = x;
    let py = y;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.perlin2(px, py, (seed + i * 131) >>> 0);
      norm += amp;
      px *= lacunarity;
      py *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  fbm2Tiled(x: number, y: number, period: number, octaves: number, gain: number, seed: number): number {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    let px = x;
    let py = y;
    let per = period;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.perlin2Tiled(px, py, per, (seed + i * 131) >>> 0);
      norm += amp;
      px *= 2;
      py *= 2;
      per *= 2;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Domain-warped fBm. Twin of `ironWarpedFbm2Tiled`. Two warp levels, because
   * one reads as wobbly and three costs three times as much for a difference
   * nobody can name.
   */
  warpedFbm2(x: number, y: number, period: number, amount: number, octaves: number, seed: number): number {
    const inner = Math.max(2, octaves - 2);
    const qx = this.fbm2Tiled(x, y, period, inner, 0.5, (seed + 17) >>> 0);
    const qy = this.fbm2Tiled(x + 5.2, y + 1.3, period, inner, 0.5, (seed + 91) >>> 0);
    const rx = this.fbm2Tiled(x + 4 * qx + 1.7, y + 4 * qy + 9.2, period, inner, 0.5, (seed + 233) >>> 0);
    const ry = this.fbm2Tiled(x + 4 * qx + 8.3, y + 4 * qy + 2.8, period, inner, 0.5, (seed + 409) >>> 0);
    return this.fbm2Tiled(x + amount * rx, y + amount * ry, period, octaves, 0.5, (seed + 5) >>> 0);
  }

  ridged2(x: number, y: number, octaves: number, seed: number): number {
    return this.ridgedMulti2(x, y, octaves, 2.03, 2.0, 1.0, seed);
  }

  /** Musgrave ridged multifractal. Twin of `ironRidgedMulti2`. */
  ridgedMulti2(
    x: number,
    y: number,
    octaves: number,
    lacunarity: number,
    gain: number,
    offset: number,
    seed: number,
  ): number {
    let sum = 0;
    let freq = 1;
    let amp = 0.5;
    let weight = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      let n = offset - Math.abs(this.perlin2(x * freq, y * freq, (seed + i * 131) >>> 0));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * gain));
      sum += n * amp;
      norm += amp;
      freq *= lacunarity;
      amp *= 0.5;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /* ------------------------------------------------------------- worley ---- */

  worley2(x: number, y: number, seed: number): { f1: number; f2: number; cell: number } {
    const r = this.voronoi2(x, y, 0, seed);
    return { f1: r.f1, f2: r.f2, cell: r.id };
  }

  /** F1/F2 plus the winning cell coordinates. Twin of `ironWorleyF`. */
  voronoi2(x: number, y: number, period: number, seed: number, out?: VoronoiResult): VoronoiResult {
    const res = out ?? { f1: 0, f2: 0, cellX: 0, cellY: 0, id: 0 };
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const s = seed >>> 0;
    let f1 = 8;
    let f2 = 8;
    let cx = 0;
    let cy = 0;
    let id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = ix + ox;
        const gy = iy + oy;
        const hx = period > 0 ? wrap(gx, period) : gx;
        const hy = period > 0 ? wrap(gy, period) : gy;
        const h = hash2u(hx, hy, s);
        const jx = unorm(h);
        const jy = unorm(hashU(h));
        const dx = ox + jx - fx;
        const dy = oy + jy - fy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          cx = gx;
          cy = gy;
          id = unorm(hash2u(hx, hy, (s + 977) >>> 0));
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    res.f1 = f1;
    res.f2 = f2;
    res.cellX = cx;
    res.cellY = cy;
    res.id = id;
    return res;
  }

  /* --------------------------------------------------------------- curl ---- */

  /**
   * Analytic curl of a three-component Perlin potential. Divergence-free to
   * float precision, which matters because a curl field with residual divergence
   * makes advected particles slowly clump into blobs over a few seconds.
   */
  curl3(x: number, y: number, z: number, seed: number, out: Vec3): Vec3 {
    const s = seed >>> 0;
    this.perlin3(x, y, z, s, GA);
    this.perlin3(x + 31.416, y, z, (s + 5171) >>> 0, GB);
    this.perlin3(x, y, z + 57.13, (s + 9161) >>> 0, GC);
    return out.set(GC.y - GB.z, GA.z - GC.x, GB.x - GA.y);
  }

  /* ------------------------------------------------------------ sampling ---- */

  /**
   * VOID-AND-CLUSTER blue noise, the real algorithm (Ulichney 1993). The output
   * has no low-frequency energy at all, which is what makes a 4-sample dither
   * pattern resolve cleanly under TAA instead of crawling. `size` must be a
   * power of two; 64² is the practical ceiling for a synchronous bake.
   *
   * Cost is O(size⁴) in the naive form; the Gaussian energy field is updated
   * incrementally instead, which is O(size² · r²) per placement.
   */
  blueNoiseTile(size: number, seed = 0x5eed): Uint8Array {
    const n = size * size;
    const energy = new Float32Array(n);
    const taken = new Uint8Array(n);
    const rank = new Int32Array(n).fill(-1);
    // sigma 1.5 texels is Ulichney's value; the kernel is truncated at 3 sigma
    // because beyond that the contribution is below the float32 noise floor.
    const sigma = 1.5;
    const radius = Math.min(size >> 1, Math.ceil(sigma * 3));
    const kernel: number[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        kernel.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
      }
    }
    const splat = (index: number, sign: number): void => {
      const px = index % size;
      const py = (index / size) | 0;
      let k = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const wy = ((py + dy) % size + size) % size;
        for (let dx = -radius; dx <= radius; dx++) {
          const wx = ((px + dx) % size + size) % size;
          energy[wy * size + wx] += sign * kernel[k];
          k++;
        }
      }
    };

    // Initial binary pattern: 1/10 of the pixels, placed by hash so the tile is
    // reproducible without touching the engine RNG (this runs inside a bake).
    const initialCount = Math.max(1, (n / 10) | 0);
    let placed = 0;
    for (let i = 0; placed < initialCount && i < n * 8; i++) {
      const idx = hashU((i + seed) >>> 0) % n;
      if (taken[idx]) continue;
      taken[idx] = 1;
      splat(idx, 1);
      placed++;
    }

    const tightestCluster = (): number => {
      let best = -1;
      let bestE = -Infinity;
      for (let i = 0; i < n; i++) {
        if (!taken[i]) continue;
        if (energy[i] > bestE) {
          bestE = energy[i];
          best = i;
        }
      }
      return best;
    };
    const largestVoid = (): number => {
      let best = -1;
      let bestE = Infinity;
      for (let i = 0; i < n; i++) {
        if (taken[i]) continue;
        if (energy[i] < bestE) {
          bestE = energy[i];
          best = i;
        }
      }
      return best;
    };

    // Phase 1 — relax the initial pattern until removing the tightest cluster
    // and filling the largest void is a fixed point.
    for (let iter = 0; iter < n; iter++) {
      const c = tightestCluster();
      taken[c] = 0;
      splat(c, -1);
      const v = largestVoid();
      if (v === c) {
        taken[c] = 1;
        splat(c, 1);
        break;
      }
      taken[v] = 1;
      splat(v, 1);
    }

    const snapshot = taken.slice();
    const snapshotEnergy = energy.slice();

    // Phase 2 — rank the initial pattern downward (tightest cluster first).
    let count = placed;
    for (let r = count - 1; r >= 0; r--) {
      const c = tightestCluster();
      taken[c] = 0;
      splat(c, -1);
      rank[c] = r;
    }

    // Phase 3 — rank upward from the initial pattern, filling voids.
    taken.set(snapshot);
    energy.set(snapshotEnergy);
    for (let r = count; r < n; r++) {
      const v = largestVoid();
      taken[v] = 1;
      splat(v, 1);
      rank[v] = r;
    }
    count = n;

    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.min(255, Math.round((rank[i] / (n - 1)) * 255));
    return out;
  }

  /**
   * Jittered stratified samples in the unit square, in row-major strata order.
   * Deterministic given `rng`. Stratification beats plain uniform sampling for
   * every scatter task in the project — grass placement, decal jitter, AO cones.
   */
  stratified2(count: number, rng: Rng, out?: Float32Array): Float32Array {
    const side = Math.max(1, Math.round(Math.sqrt(count)));
    const total = side * side;
    const dst = out && out.length >= total * 2 ? out : new Float32Array(total * 2);
    let k = 0;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        dst[k++] = (x + rng.next()) / side;
        dst[k++] = (y + rng.next()) / side;
      }
    }
    return dst;
  }

  /** R2 low-discrepancy sequence — the cheapest good 2D stratifier there is. */
  r2(index: number, out: Vec2): Vec2 {
    const g = 1.32471795724474602596;
    return out.set((0.5 + index / g) % 1, (0.5 + index / (g * g)) % 1);
  }
}

const GA: Grad3 = { x: 0, y: 0, z: 0 };
const GB: Grad3 = { x: 0, y: 0, z: 0 };
const GC: Grad3 = { x: 0, y: 0, z: 0 };
