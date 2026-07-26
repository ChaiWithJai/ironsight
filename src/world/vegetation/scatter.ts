/**
 * Where things grow. OWNER: VEG.
 *
 * Everything here is a PURE FUNCTION of world position — no state, no sequence,
 * no allocation. That is deliberate and it is what makes camera-relative grass
 * possible: a tile 40 m ahead of the player must generate the same plants
 * whether the player walked to it or spawned next to it, and a sequential RNG
 * cannot promise that because the answer would depend on the order tiles were
 * first visited. The engine `Rng` is used for everything built once in a known
 * order (meshes, the tree scatter); the per-tile grass draw uses the hash below,
 * which is deterministic by construction rather than by discipline.
 *
 * THE MASKS
 * ---------
 * Slope, altitude and moisture, exactly as the lane brief asks, plus the two
 * that stop it looking like a spreadsheet:
 *
 *  - PATCHINESS. A 180 m-wavelength moisture field. Uniform grass over a whole
 *    map is the loudest procedural-vegetation tell there is; real dry-country
 *    ground cover comes in patches with bare ground between them, because the
 *    water does.
 *  - DRAINAGE. Hollows collect water and grow grass; ridges shed it and grow
 *    scrub. Evaluated from the local curvature of the height field, so it lands
 *    on the terrain rather than beside it.
 */
import type { MacroTerrain, TerrainService } from '@/engine/types';

/* ------------------------------------------------------------------ hashing */

/**
 * Stateless 2D hash, [0,1). Three-round integer mix; the constants are the
 * usual large odd primes and the shifts are chosen so a ±1 change in either
 * input changes every output bit.
 */
export function hash2(x: number, y: number, seed: number): number {
  let h = (x | 0) * 0x27d4eb2d + (y | 0) * 0x165667b1 + seed * 0x9e3779b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise over a unit lattice. */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

/** Two octaves is enough for a mask; more just costs time nobody sees. */
function fbm2(x: number, y: number, seed: number): number {
  return valueNoise(x, y, seed) * 0.66 + valueNoise(x * 2.31 + 11.7, y * 2.31 - 4.3, seed + 91) * 0.34;
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/* --------------------------------------------------------------- exclusions */

interface Disc {
  x: number;
  z: number;
  r: number;
  /** 0 = hard carve-out, >0 = a soft flatten that recovers. */
  strength: number;
  /** Seconds of sim time at which this entry expires; Infinity for permanent. */
  until: number;
}

/**
 * Carve-outs, disturbances and scorch marks in one spatially-hashed set.
 *
 * A linear scan is fine for the 200-odd permanent exclusions LEVEL hands over
 * until you multiply it by the fifteen thousand candidate points a field
 * rebuild tests, at which point it is three million distance checks per rebuild.
 * A 24 m bucket grid takes it to a handful.
 */
export class ExclusionField {
  private readonly discs = new Map<number, Disc>();
  private readonly buckets = new Map<number, number[]>();
  private nextId = 1;
  private version = 0;
  private static readonly CELL = 24;

  /** Bumped whenever the set changes, so the field runtime knows to rebuild. */
  get revision(): number {
    return this.version;
  }

  add(x: number, z: number, r: number, strength = 0, until = Infinity): number {
    const id = this.nextId++;
    this.discs.set(id, { x, z, r, strength, until });
    for (const key of this.keysFor(x, z, r)) {
      const list = this.buckets.get(key);
      if (list) list.push(id);
      else this.buckets.set(key, [id]);
    }
    this.version++;
    return id;
  }

  remove(id: number): void {
    const d = this.discs.get(id);
    if (!d) return;
    this.discs.delete(id);
    for (const key of this.keysFor(d.x, d.z, d.r)) {
      const list = this.buckets.get(key);
      if (!list) continue;
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
    }
    this.version++;
  }

  /** Drop everything whose lifetime has run out. Returns true if anything went. */
  expire(now: number): boolean {
    let changed = false;
    for (const [id, d] of this.discs) {
      if (d.until <= now) {
        this.remove(id);
        changed = true;
      }
    }
    return changed;
  }

  clearTransient(): void {
    for (const [id, d] of [...this.discs]) {
      if (d.until !== Infinity) this.remove(id);
    }
  }

  /**
   * Survival factor at a point: 1 outside everything, 0 in the core of a hard
   * exclusion. Edges are feathered over 1.2 m so a building does not stand in a
   * perfect circle of bare ground — the circle is the tell, not the gap.
   */
  factor(x: number, z: number): number {
    const list = this.buckets.get(this.key(Math.floor(x / ExclusionField.CELL), Math.floor(z / ExclusionField.CELL)));
    if (!list || list.length === 0) return 1;
    let f = 1;
    for (const id of list) {
      const d = this.discs.get(id);
      if (!d) continue;
      const dist = Math.hypot(x - d.x, z - d.z);
      if (dist >= d.r) continue;
      const inner = smoothstep(d.r, Math.max(0, d.r - 1.2), dist);
      f *= 1 - inner * (1 - d.strength);
      if (f <= 0.001) return 0;
    }
    return f;
  }

  private key(cx: number, cz: number): number {
    // Cantor-ish pairing folded into 32 bits. Collisions only cost a few extra
    // distance tests, never correctness, because `factor` re-tests the radius.
    return ((cx & 0xffff) << 16) | (cz & 0xffff);
  }

  private *keysFor(x: number, z: number, r: number): Generator<number> {
    const c = ExclusionField.CELL;
    const x0 = Math.floor((x - r) / c);
    const x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c);
    const z1 = Math.floor((z + r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) yield this.key(cx, cz);
    }
  }
}

/* -------------------------------------------------------------------- masks */

export type SpeciesId = 'palm' | 'olive' | 'scrub' | 'agave';

/** Ground sample, reused so the mask evaluation allocates nothing. */
export interface Ground {
  height: number;
  /** 0 = flat, 1 = vertical. `sin` of the slope angle. */
  slope: number;
  /** Metres inland of the waterline; negative offshore. */
  shore: number;
  /** 0..1, dry to damp. */
  moisture: number;
}

export class VegMasks {
  private readonly macro: MacroTerrain;
  private terrain: TerrainService | null = null;

  constructor(macro: MacroTerrain) {
    this.macro = macro;
  }

  /**
   * TERRAIN publishes its eroded heightfield some time after we are
   * constructed. Until it does we place against `MACRO_TERRAIN`, which both
   * lanes evaluate, so the plants are on the ground the first time the two are
   * composed rather than after a fix-up pass.
   */
  useTerrain(terrain: TerrainService | null): void {
    this.terrain = terrain !== null && terrain.ready ? terrain : null;
  }

  heightAt(x: number, z: number): number {
    return this.terrain ? this.terrain.heightAt(x, z) : this.macro.height(x, z);
  }

  sample(x: number, z: number, out: Ground): Ground {
    const h = this.heightAt(x, z);
    // Central differences at 2 m — the scale a plant actually cares about.
    const hx = this.heightAt(x + 2, z) - this.heightAt(x - 2, z);
    const hz = this.heightAt(x, z + 2) - this.heightAt(x, z - 2);
    const grad = Math.hypot(hx, hz) / 4;
    out.height = h;
    out.slope = grad / Math.sqrt(1 + grad * grad);
    out.shore = this.macro.shoreDistance(x, z);

    // Drainage: a hollow reads lower than the mean of its neighbours.
    const hollow = (this.heightAt(x + 9, z) + this.heightAt(x - 9, z) + this.heightAt(x, z + 9) + this.heightAt(x, z - 9)) / 4 - h;
    // Large-scale patchiness plus drainage plus a mild sea-breeze humidity
    // gradient that dies off inland.
    const patch = fbm2(x / 178, z / 178, 0x5eed);
    out.moisture = Math.min(
      1,
      Math.max(
        0,
        0.16 + patch * 0.62 + smoothstep(-0.4, 2.4, hollow) * 0.30 - smoothstep(120, 480, out.shore) * 0.22,
      ),
    );
    return out;
  }

  /**
   * Ground-cover density, 0..1. Grass, thatch and mat all scale off this, so
   * the three layers agree about where the field is and there is no place where
   * the mat says "meadow" and the blades say "bare rock".
   */
  grassDensity(g: Ground): number {
    if (g.height < 0.75) return 0;                                // beach and below
    if (g.slope > 0.72) return 0;                                 // bare rock
    const alt = smoothstep(0.75, 2.6, g.height) * (1 - smoothstep(46, 78, g.height));
    const flat = 1 - smoothstep(0.22, 0.66, g.slope);
    // A narrow band of salt-tolerant dune grass right behind the berm survives
    // the moisture test that everything else fails, and it is the thing that
    // stops the beach ending in a hard line.
    const dune = smoothstep(2, 12, g.shore) * (1 - smoothstep(22, 46, g.shore)) * 0.45;
    const moist = Math.max(dune, Math.pow(g.moisture, 1.35));
    return alt * flat * moist;
  }

  /** Per-species suitability, 0..1, before the exclusion field is applied. */
  speciesDensity(species: SpeciesId, g: Ground): number {
    if (g.height < 1.0) return 0;
    switch (species) {
      case 'palm':
        // Date palms are planted, not wild: near the waterfront, the quay and
        // the market, on flat ground, and they want their feet in the water
        // table.
        return (
          smoothstep(1.0, 2.6, g.height) *
          (1 - smoothstep(13, 22, g.height)) *
          (1 - smoothstep(0.16, 0.34, g.slope)) *
          (1 - smoothstep(90, 210, g.shore)) *
          (0.35 + 0.65 * g.moisture)
        );
      case 'olive':
        // Terraced groves on the inland shoulder. Olives tolerate slope and
        // drought and dislike salt spray, so they start where the palms stop.
        return (
          smoothstep(7, 14, g.height) *
          (1 - smoothstep(52, 74, g.height)) *
          (1 - smoothstep(0.34, 0.60, g.slope)) *
          smoothstep(60, 150, g.shore) *
          (0.45 + 0.55 * (1 - g.moisture))
        );
      case 'scrub':
        // Everywhere the other three are not. Scrub is the map's connective
        // tissue and the reason no ground reads as empty.
        return (
          smoothstep(1.4, 3.2, g.height) *
          (1 - smoothstep(62, 90, g.height)) *
          (1 - smoothstep(0.52, 0.78, g.slope)) *
          (0.30 + 0.70 * (1 - g.moisture))
        );
      case 'agave':
        // Rocky, steep, dry — the edges of the headland and the fort ramparts.
        return (
          smoothstep(1.6, 4.0, g.height) *
          (1 - smoothstep(64, 92, g.height)) *
          smoothstep(0.14, 0.34, g.slope) *
          (1 - smoothstep(0.62, 0.80, g.slope)) *
          (0.5 + 0.5 * (1 - g.moisture))
        );
      default:
        return 0;
    }
  }
}
