/**
 * THE HEIGHTFIELD. Owned by TERRAIN.
 *
 * One grid, one sampler, one truth. `TerrainField.height()` is the function the
 * chunk meshes are built from, the function the collision heightfield IS, and
 * the function the published `heightMap` texture is rasterised from — so the
 * contract's "heightAt must be LITERALLY what the GPU displaces with" is
 * satisfied by construction rather than by keeping two implementations in step.
 * NOTHING in this lane displaces a vertex in a shader. Everything the shader
 * adds below the grid cell is normal-only, which is the other half of that same
 * contract: position detail finer than the collider cell is what makes players
 * float over bumps.
 *
 * Composition, in order:
 *
 *   1. MACRO_TERRAIN            the frozen silhouette (CORE, src/engine/macro.ts)
 *   2. + analytic detail        strata, gullies, dunes, the beach scarp
 *   3. + droplet erosion        deposition fans and channels, clamped to ±2.6 m
 *   4. × protection mask        zero inside capture terraces and on the moles
 *
 * Step 4 is not cosmetic. LEVEL placed every building by evaluating
 * MACRO_TERRAIN, so anywhere a building stands the visual ground must still be
 * the macro height to the millimetre or the town floats. The mask is also what
 * honours macro.ts's stated contract — "erosion may carve channels and add
 * detail, but it must not move the macro silhouette by more than a couple of
 * metres".
 */
import type { NoiseLib, Rng } from '@/engine/types';
import { MACRO_ANCHORS, MACRO_TERRAIN } from '@/engine/macro';
import { clamp, clamp01, smoothstep } from '@/engine/math/curves';

/** Half-extent of the detailed field, in metres. Beyond this it is pure macro. */
export const FIELD_HALF = 512;
/** Metres over which detail tapers to nothing at the field edge, so the grid
 *  and the analytic macro agree EXACTLY where the sampler switches between them. */
const EDGE_TAPER = 40;
/** Hard cap on how far erosion alone may move the macro silhouette. */
const EROSION_CLAMP = 2.6;
/**
 * Hard cap on the TOTAL departure from the macro silhouette — detail plus
 * erosion, everywhere on the map.
 *
 * macro.ts asks for "not more than a couple of metres". PHYS is stricter and it
 * is the one that actually enforces: `verifyTerrain()` casts at four asymmetric
 * probe points and rejects the whole terrain collider if any of them disagrees
 * with `MACRO_TERRAIN.height` by more than 1.5 m, which takes the game's ground
 * collision with it. 1.35 m leaves margin for the Catmull-Rom interpolant's
 * overshoot between grid samples and is applied as a SOFT clamp, so the field
 * approaches the limit asymptotically instead of growing plateaus at it.
 */
const DEVIATION_LIMIT = 1.2;

/** Mask that pins the ground to the macro height under everything LEVEL built. */
function protectionAt(x: number, z: number): number {
  let p = 1;
  for (const a of [MACRO_ANCHORS.alpha, MACRO_ANCHORS.bravo, MACRO_ANCHORS.charlie]) {
    const d = Math.hypot(x - a.x, z - a.z);
    p *= smoothstep(a.radius * 0.72, a.radius * 1.38, d);
  }
  p *= smoothstep(9, 22, segmentDistance(x, z, 26, -14, 148, -102)); // breakwater
  p *= smoothstep(8, 19, segmentDistance(x, z, -96, -6, -150, -58)); // west spur
  return p;
}

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz;
  const t = len2 > 0 ? clamp01(((x - ax) * vx + (z - az) * vz) / len2) : 0;
  return Math.hypot(x - (ax + vx * t), z - (az + vz * t));
}

export interface FieldBuildOptions {
  /** Cells per axis across the 1024 m detailed field. */
  readonly resolution: number;
  /** Droplet budget scales off this; the bake profile's number. */
  readonly erosionIterations: number;
}

export class TerrainField {
  /** (res+1)² samples, row-major in Z. Metres. THIS ARRAY IS THE TERRAIN. */
  readonly data: Float32Array;
  readonly res: number;
  readonly cell: number;
  readonly seaLevel = MACRO_TERRAIN.seaLevel;
  private readonly stride: number;

  constructor(
    private readonly noise: NoiseLib,
    private readonly rng: Rng,
    opts: FieldBuildOptions,
  ) {
    this.res = opts.resolution;
    this.cell = (FIELD_HALF * 2) / this.res;
    this.stride = this.res + 1;
    this.data = new Float32Array(this.stride * this.stride);
    this.build(opts.erosionIterations);
  }

  /* ------------------------------------------------------------- sampling -- */

  /**
   * Catmull-Rom over the grid. Bilinear would put a crease along every cell
   * diagonal, and at LOD0 the triangles are smaller than a cell — the mesh
   * would show the interpolant rather than the terrain. C1 is worth the 16 taps
   * because normals, physics and the mesh all read this one function.
   */
  height(x: number, z: number): number {
    const gx = (x + FIELD_HALF) / this.cell;
    const gz = (z + FIELD_HALF) / this.cell;
    if (gx < 1 || gz < 1 || gx > this.res - 2 || gz > this.res - 2) {
      return MACRO_TERRAIN.height(x, z);
    }
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const d = this.data;
    const s = this.stride;
    let c0 = 0;
    let c1 = 0;
    let c2 = 0;
    let c3 = 0;
    for (let k = -1; k <= 2; k++) {
      const row = (iz + k) * s + ix;
      const v = cubic(d[row - 1], d[row], d[row + 1], d[row + 2], fx);
      if (k === -1) c0 = v;
      else if (k === 0) c1 = v;
      else if (k === 1) c2 = v;
      else c3 = v;
    }
    return cubic(c0, c1, c2, c3, fz);
  }

  /** Central-difference gradient of `height`, in metres per metre. */
  gradient(x: number, z: number, out: { gx: number; gz: number }): void {
    const e = this.cell * 0.5;
    out.gx = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e);
    out.gz = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
  }

  /** |∇h|. Not an angle — the splat rules and the LOD rules both want the slope. */
  slope(x: number, z: number): number {
    const g = { gx: 0, gz: 0 };
    this.gradient(x, z, g);
    return Math.hypot(g.gx, g.gz);
  }

  /** Discrete Laplacian over one cell. Positive = concave (a channel floor). */
  curvature(x: number, z: number): number {
    const e = this.cell;
    const h = this.height(x, z);
    return (
      (this.height(x + e, z) + this.height(x - e, z) + this.height(x, z + e) + this.height(x, z - e) - 4 * h) /
      (e * e)
    );
  }

  /**
   * Signed distance to the waterline, positive inland. First-order `h/|∇h|`,
   * the same construction `MacroTerrain.shoreDistance` uses, so the CPU answer
   * and the published R8 mask cannot drift apart in sign or scale.
   */
  shoreDistance(x: number, z: number): number {
    const h = this.height(x, z) - this.seaLevel;
    const g = { gx: 0, gz: 0 };
    this.gradient(x, z, g);
    return h / Math.max(Math.hypot(g.gx, g.gz), 0.012);
  }

  /**
   * The same samples, laid out the way rapier's heightfield wants them.
   *
   * `TerrainField.data` is row-major in Z (`iz * stride + ix`) because that is
   * the order every raster in this lane walks. rapier builds its heightfield
   * from a COLUMN-MAJOR nalgebra matrix — element (row i = z, column j = x) at
   * `j * (nrows + 1) + i` — so handing it our array directly transposes the map
   * across its diagonal. That mirrors the headland into the sea, which is
   * invisible at the four corners of a square and is exactly what PHYS's
   * asymmetric verification probe exists to catch.
   *
   * A copy rather than a different internal layout: it is 4 MB once, it is a
   * pure function of the same array, and it keeps every rasteriser loop in the
   * lane reading in the order it writes.
   */
  transposedForPhysics(): Float32Array {
    const n = this.stride;
    const out = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      const row = iz * n;
      for (let ix = 0; ix < n; ix++) out[ix * n + iz] = this.data[row + ix];
    }
    return out;
  }

  /* -------------------------------------------------------------- building -- */

  private build(erosionIterations: number): void {
    const n = this.stride;
    const count = n * n;
    const shaped = new Float32Array(count);
    const mask = new Float32Array(count);
    const base = new Float32Array(count);

    // Pass 1 — the frozen macro silhouette at every sample.
    for (let j = 0; j < n; j++) {
      const z = -FIELD_HALF + j * this.cell;
      for (let i = 0; i < n; i++) {
        base[j * n + i] = MACRO_TERRAIN.height(-FIELD_HALF + i * this.cell, z);
      }
    }

    // Pass 2 — analytic detail. Slope and shore distance come from finite
    // differences of pass 1 rather than from four more macro evaluations, which
    // is a 4× saving on the single most expensive loop in the terrain bake.
    for (let j = 0; j < n; j++) {
      const z = -FIELD_HALF + j * this.cell;
      for (let i = 0; i < n; i++) {
        const t = j * n + i;
        const x = -FIELD_HALF + i * this.cell;
        const h = base[t];
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(n - 1, i + 1);
        const j0 = Math.max(0, j - 1);
        const j1 = Math.min(n - 1, j + 1);
        const gx = (base[j * n + i1] - base[j * n + i0]) / ((i1 - i0) * this.cell);
        const gz = (base[j1 * n + i] - base[j0 * n + i]) / ((j1 - j0) * this.cell);
        const slope = Math.hypot(gx, gz);
        const shore = h / Math.max(slope, 0.012);
        const edge = smoothstep(0, EDGE_TAPER, FIELD_HALF - Math.max(Math.abs(x), Math.abs(z)));
        const m = protectionAt(x, z) * edge;
        mask[t] = m;
        shaped[t] = h + this.detail(x, z, h, slope, shore) * m;
      }
    }

    const pre = shaped.slice();
    this.erode(shaped, erosionIterations);

    // Pass 3 — fold the erosion delta back in, clamped and masked. Erosion runs
    // on the shaped field (so it follows the gullies detail seeded) but only its
    // DELTA is kept, which is what keeps the macro silhouette inside its budget.
    for (let t = 0; t < count; t++) {
      const under = smoothstep(-4, 1.5, base[t]); // droplets do not carve a seabed
      const d = clamp(shaped[t] - pre[t], -EROSION_CLAMP, EROSION_CLAMP);
      const total = pre[t] - base[t] + d * mask[t] * under;
      this.data[t] = base[t] + DEVIATION_LIMIT * Math.tanh(total / DEVIATION_LIMIT);
    }
  }

  /**
   * Analytic detail, in metres. Everything here is deterministic in (x, z): it
   * is evaluated once into the grid, but it must stay a pure function so the
   * grid can be rebuilt at any resolution and still describe the same terrain.
   */
  private detail(x: number, z: number, h: number, slope: number, shore: number): number {
    const nz = this.noise;
    // Rock reads off BOTH slope and altitude: the headland is rock because it is
    // high, a gully wall is rock because it is steep.
    const rock = clamp01(smoothstep(0.28, 0.62, slope) + smoothstep(15, 32, h) * 0.75);
    // The beach band: from 14 m offshore (the wet ramp) to 28 m inland.
    const beach = (1 - smoothstep(4, 28, shore)) * smoothstep(-14, -3, shore);
    const terrace = clamp01(1 - rock) * smoothstep(20, 46, shore);

    let d = 0;

    // CLIFF STRATA. Ridged multifractal for the fracture pattern, plus a bedding
    // term keyed on ALTITUDE rather than on the plan position — that is what
    // makes sedimentary rock read as horizontal layers wrapping a headland
    // instead of as noise pasted on a slope.
    if (rock > 0.01) {
      const fracture = nz.ridged2(x * 0.031, z * 0.031, 4, 0x51a3) - 0.45;
      const bedding = Math.sin(h * 0.92 + nz.fbm2(x * 0.02, z * 0.02, 3, 2, 0.5, 0x77c1) * 2.4);
      d += rock * (fracture * 0.92 + bedding * 0.22);
      // Gully seeds. Erosion deepens what is already concave, so a shallow
      // ridged network here becomes a dendritic channel network after step 3.
      d -= rock * Math.pow(clamp01(nz.ridged2(x * 0.0125, z * 0.0125, 3, 0x2f19)), 2) * 0.72;
    }

    // The terrace: long, low undulation so the town's ground plane is never a
    // billiard table, at a wavelength (55 m) longer than any building footprint.
    if (terrace > 0.01) {
      d += terrace * nz.fbm2(x * 0.018, z * 0.018, 4, 2, 0.5, 0x9d41) * 0.55;
      d += terrace * nz.fbm2(x * 0.11, z * 0.11, 2, 2, 0.5, 0x1bb7) * 0.13;
    }

    // The beach: wind ripple across the dry sand, and the SWASH SCARP.
    if (beach > 0.01) {
      d += beach * nz.fbm2(x * 0.135, z * 0.135, 3, 2, 0.5, 0x33ef) * 0.2;
      // A real beach has a step where the swash cuts the berm. It buys two
      // things: the coastal silhouette a flat ramp cannot give, and — because
      // the waterline crossing is now ~4× steeper — a waterline whose lateral
      // position is 4× less sensitive to vertical quantisation, which is most
      // of the fix for the sawtooth shore.
      const along = nz.fbm2(x * 0.045, z * 0.045, 3, 2, 0.5, 0x60d3);
      const cuspPhase = shore - 1.6 - along * 2.6;
      d += 0.62 * beach * (smoothstep(-0.4, 2.6, cuspPhase) - 0.5);
      // Cusps: a scalloped waterline at 18–40 m along-shore wavelength. The
      // shoreline is the most-looked-at silhouette on this map and a straight
      // one is as wrong as a jagged one.
      d += 0.28 * beach * along * (1 - smoothstep(0, 9, Math.abs(shore)));
    }

    return d;
  }

  /**
   * Droplet hydraulic erosion. Deterministic: every droplet's launch point comes
   * from the lane's own RNG stream, so a capture is reproducible.
   *
   * Chosen over a grid solver because it produces dendritic channels and
   * deposition fans at a tenth of the cost — the visual payload here is the
   * alluvial fan where a gully meets the terrace, which a grid diffusion does
   * not make at all.
   */
  private erode(grid: Float32Array, iterations: number): void {
    const n = this.stride;
    const drops = Math.max(1, Math.round(((this.res * this.res) / 400) * iterations));
    const inertia = 0.055;
    const capacityFactor = 3.4;
    const minSlope = 0.012;
    const erodeSpeed = 0.34;
    const depositSpeed = 0.28;
    const evaporate = 0.024;
    const gravity = 5.0;
    const maxLifetime = 42;

    // Deposition brush: a 2-cell cone, so material lands as a fan rather than
    // in the single cell the droplet happened to occupy.
    const brush: { o: number; w: number }[] = [];
    let brushSum = 0;
    for (let bz = -2; bz <= 2; bz++) {
      for (let bx = -2; bx <= 2; bx++) {
        const r = Math.hypot(bx, bz);
        if (r > 2.4) continue;
        const w = 1 - r / 2.4;
        brush.push({ o: bz * n + bx, w });
        brushSum += w;
      }
    }
    for (const b of brush) b.w /= brushSum;

    for (let d = 0; d < drops; d++) {
      let px = this.rng.range(2, this.res - 2);
      let pz = this.rng.range(2, this.res - 2);
      let dirX = 0;
      let dirZ = 0;
      let speed = 1;
      let water = 1;
      let sediment = 0;

      for (let life = 0; life < maxLifetime; life++) {
        const nx = Math.floor(px);
        const nz2 = Math.floor(pz);
        const fx = px - nx;
        const fz = pz - nz2;
        const t = nz2 * n + nx;
        const h00 = grid[t];
        const h10 = grid[t + 1];
        const h01 = grid[t + n];
        const h11 = grid[t + n + 1];
        // Bilinear gradient in CELL units; the cell is 1 m at the default
        // resolution, so the tuning constants above read as metres.
        const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
        const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
        const oldH = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;

        dirX = dirX * inertia - gx * (1 - inertia);
        dirZ = dirZ * inertia - gz * (1 - inertia);
        const len = Math.hypot(dirX, dirZ);
        if (len < 1e-5) break;
        dirX /= len;
        dirZ /= len;
        px += dirX;
        pz += dirZ;
        if (px < 2 || pz < 2 || px > this.res - 2 || pz > this.res - 2) break;

        const newH = sampleBilinear(grid, n, px, pz);
        const deltaH = newH - oldH;
        const capacity = Math.max(-deltaH, minSlope) * speed * water * capacityFactor;

        if (sediment > capacity || deltaH > 0) {
          // Uphill: drop everything that will not fit in the hollow behind.
          const amount = deltaH > 0 ? Math.min(deltaH, sediment) : (sediment - capacity) * depositSpeed;
          sediment -= amount;
          grid[t] += amount * (1 - fx) * (1 - fz);
          grid[t + 1] += amount * fx * (1 - fz);
          grid[t + n] += amount * (1 - fx) * fz;
          grid[t + n + 1] += amount * fx * fz;
        } else {
          const amount = Math.min((capacity - sediment) * erodeSpeed, -deltaH);
          for (const b of brush) {
            const o = t + b.o;
            if (o < 0 || o >= grid.length) continue;
            grid[o] -= amount * b.w;
          }
          sediment += amount;
        }

        speed = Math.sqrt(Math.max(0, speed * speed - deltaH * gravity));
        water *= 1 - evaporate;
        if (water < 0.01) break;
      }
    }
  }
}

/** Catmull-Rom basis. Mild overshoot at a cliff lip, which is what a lip does. */
function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

function sampleBilinear(grid: Float32Array, stride: number, gx: number, gz: number): number {
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const t = iz * stride + ix;
  return (
    grid[t] * (1 - fx) * (1 - fz) +
    grid[t + 1] * fx * (1 - fz) +
    grid[t + stride] * (1 - fx) * fz +
    grid[t + stride + 1] * fx * fz
  );
}
