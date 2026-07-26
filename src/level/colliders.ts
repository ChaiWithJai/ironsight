/**
 * STATIC COLLIDER EMISSION AND DESTRUCTIBLE TAGGING.
 *
 * OWNER: LEVEL.
 *
 * Every emitter in this lane calls `LevelBuild.solid()` or `LevelBuild.collider()`
 * as it goes, so by the time the build finishes the collider list already exists.
 * This file is the pass that runs over it AFTERWARDS and does the three things
 * that can only be decided once you can see the whole level at once:
 *
 *  1. ENFORCE THE OCCLUDER BUDGET. The software occlusion raster takes 48
 *     occluders. Lanes tag optimistically — there are ~90 tagged boxes in a
 *     finished build — so the budget is applied here by keeping the 48 with the
 *     largest silhouette area and clearing the rest. Silently overflowing the
 *     raster is a class of bug where distant geometry pops for reasons nobody
 *     can reproduce.
 *  2. TAG DESTRUCTIBLES. Which colliders DESTRUCTION is allowed to break, with
 *     what health and what fracture set. This is a whole-level decision because
 *     it is a BUDGET: `QualitySettings.destruction.maxChunks` is shared, and a
 *     map where every crate is destructible spends the entire chunk budget on
 *     crates and has none left for the cover wall that matters.
 *  3. VALIDATE. Degenerate boxes, NaN transforms and colliders under the seabed
 *     are all cheap to produce by accident in a procedural build and expensive
 *     to debug once rapier has them: a zero-extent box is an instant solver
 *     explosion, and a NaN matrix takes the whole physics world with it.
 *
 * WHAT IS DESTRUCTIBLE, AND WHY IT IS A SHORT LIST
 * ------------------------------------------------
 * Destruction is only interesting when it CHANGES A SIGHTLINE. So the list is:
 * cover you fight behind (sandbags, jersey barriers, low walls, crates) and the
 * light infill panels between structural piers. Load-bearing masonry, the fort
 * curtain, the quay, the cranes and the hull of the freighter are all permanent
 * — not because they could not be broken, but because a map where the player can
 * delete the level geometry is a map with no level design left in it.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeKind,
  CollisionGroup,
  SurfaceId,
  type AssetKey,
  type AssetRegistry,
  type DestructibleDef,
  type MeshAsset,
  type Rng,
  type StaticColliderDef,
} from '@/engine/types';

/** The five fracture sets the whole level shares. */
export type FractureClass = 'concrete' | 'brick' | 'stucco' | 'wood' | 'sandbag';

const CHUNK_KEYS = new Map<FractureClass, AssetKey<MeshAsset>>();

/**
 * Pre-fractured Voronoi shards, one set per material class.
 *
 * Runtime fracture is a frame-hitch generator and is banned (architecture
 * §11.5), so the shards are baked once here and every destructible instance
 * re-uses the same set with a different transform. Five sets rather than one per
 * object is the whole reason destruction fits in the budget.
 *
 * The shard shape is a jittered convex cell: a random point cloud on a shrunken
 * box, hulled by taking the cloud itself as the convex collider and a coarse
 * triangulated shell as the render geometry. It does not need to tile back into
 * the original volume — nobody ever sees the unbroken state and the broken state
 * at the same time — it needs to look like broken concrete when it lands.
 */
function defineChunkSet(assets: AssetRegistry, cls: FractureClass, surface: SurfaceId): AssetKey<MeshAsset> {
  return assets.define<MeshAsset>(`level.chunks.${cls}`, AssetKind.Mesh, {
    kind: BakeKind.WorkerMesh,
    version: 1,
    // Cheap: 24 little hulls of ~40 triangles each. The cost number matters
    // because the scheduler degrades the lowest-priority steps first and this
    // one genuinely can be degraded — coarser shards are still shards.
    cost: 14,
    cacheable: true,
    run: () => {
      const lods: THREE.BufferGeometry[] = [];
      const collision: MeshAsset['collision'][number][] = [];
      const bounds = new THREE.Box3();
      // Deterministic integer hash stream. `BakeRunContext` carries no RNG and
      // `Math.random` is banned repo-wide, so the shard shapes come from a
      // counter mixed with the class name — same input, same shards, forever.
      let h = 0;
      for (let i = 0; i < cls.length; i++) h = (h * 31 + cls.charCodeAt(i)) >>> 0;
      const rand = (): number => {
        h ^= h << 13; h >>>= 0;
        h ^= h >> 17;
        h ^= h << 5; h >>>= 0;
        return h / 4294967296;
      };

      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      const SHARDS = 24;
      for (let s = 0; s < SHARDS; s++) {
        // A shard is an irregular 6-vertex bipyramid: cheap, closed, convex,
        // and it tumbles believably because its inertia tensor is not a cube's.
        const sx = 0.09 + rand() * 0.26;
        const sy = 0.06 + rand() * 0.2;
        const sz = 0.09 + rand() * 0.26;
        const ox = (s % 6) * 0.9 - 2.25;
        const oz = Math.floor(s / 6) * 0.9 - 1.35;
        const eq: [number, number, number][] = [];
        const sides = 4 + Math.floor(rand() * 2);
        for (let k = 0; k < sides; k++) {
          const a = (k / sides) * Math.PI * 2 + rand() * 0.4;
          const j = 0.6 + rand() * 0.4;
          eq.push([ox + Math.cos(a) * sx * j, (rand() - 0.5) * sy * 0.5, oz + Math.sin(a) * sz * j]);
        }
        const top: [number, number, number] = [ox + (rand() - 0.5) * sx * 0.4, sy, oz + (rand() - 0.5) * sz * 0.4];
        const bot: [number, number, number] = [ox + (rand() - 0.5) * sx * 0.4, -sy, oz + (rand() - 0.5) * sz * 0.4];
        const pts: number[] = [];
        for (const p of [...eq, top, bot]) pts.push(p[0] - ox, p[1], p[2] - oz);
        collision.push({ kind: 'convex', points: new Float32Array(pts) });

        const push = (p: [number, number, number], q: [number, number, number], r: [number, number, number]): void => {
          const ax = q[0] - p[0], ay = q[1] - p[1], az = q[2] - p[2];
          const bx = r[0] - p[0], by = r[1] - p[1], bz = r[2] - p[2];
          let nx2 = ay * bz - az * by;
          let ny2 = az * bx - ax * bz;
          let nz2 = ax * by - ay * bx;
          const l = Math.hypot(nx2, ny2, nz2) || 1;
          nx2 /= l; ny2 /= l; nz2 /= l;
          for (const v of [p, q, r]) {
            const base = positions.length / 3;
            positions.push(v[0], v[1], v[2]);
            normals.push(nx2, ny2, nz2);
            uvs.push(v[0] * 2, v[2] * 2);
            indices.push(base);
          }
        };
        for (let k = 0; k < eq.length; k++) {
          const j = (k + 1) % eq.length;
          push(eq[k], eq[j], top);
          push(eq[j], eq[k], bot);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      if (g.boundingBox) bounds.copy(g.boundingBox);
      lods.push(g);
      return { lods, screenErrors: [0], collision, bounds, surface };
    },
    dispose: (value) => {
      for (const lod of value.lods) lod.dispose();
    },
  });
}

/** Called from `registerLevelBakes`. Idempotent across a harness reset. */
export function defineChunkAssets(assets: AssetRegistry): void {
  if (CHUNK_KEYS.size > 0) return;
  CHUNK_KEYS.set('concrete', defineChunkSet(assets, 'concrete', SurfaceId.Concrete));
  CHUNK_KEYS.set('brick', defineChunkSet(assets, 'brick', SurfaceId.Rubble));
  CHUNK_KEYS.set('stucco', defineChunkSet(assets, 'stucco', SurfaceId.Stucco));
  CHUNK_KEYS.set('wood', defineChunkSet(assets, 'wood', SurfaceId.Wood));
  CHUNK_KEYS.set('sandbag', defineChunkSet(assets, 'sandbag', SurfaceId.Sandbag));
}

interface ClassTemplate {
  readonly material: DestructibleDef['material'];
  readonly fracture: FractureClass;
  /** Health per cubic metre of collider volume. */
  readonly healthPerM3: number;
  readonly chipThreshold: number;
  readonly explosiveMultiplier: number;
  readonly debrisLifetime: number;
  readonly blocksLosWhenIntact: boolean;
  readonly coverValue: number;
}

/**
 * Health numbers are in the same units DESTRUCTION's `DamageInfo.amount` uses.
 * The ordering is what matters and it comes from what a rifle round should do:
 * a sandbag wall absorbs hundreds of rounds and dies to one rocket; a market
 * stall falls over if you look at it; a jersey barrier shrugs off small arms
 * entirely (the multiplier does the work, not the health).
 */
const CLASSES: Record<string, ClassTemplate> = {
  sandbag: {
    material: 'sandbag', fracture: 'sandbag', healthPerM3: 900, chipThreshold: 40,
    explosiveMultiplier: 3.4, debrisLifetime: 22, blocksLosWhenIntact: true, coverValue: 0.9,
  },
  concrete: {
    material: 'concrete', fracture: 'concrete', healthPerM3: 1700, chipThreshold: 90,
    explosiveMultiplier: 4.2, debrisLifetime: 30, blocksLosWhenIntact: true, coverValue: 0.95,
  },
  masonry: {
    material: 'brick', fracture: 'brick', healthPerM3: 1150, chipThreshold: 55,
    explosiveMultiplier: 4.8, debrisLifetime: 26, blocksLosWhenIntact: true, coverValue: 0.85,
  },
  stucco: {
    material: 'stucco', fracture: 'stucco', healthPerM3: 620, chipThreshold: 28,
    explosiveMultiplier: 5.5, debrisLifetime: 18, blocksLosWhenIntact: true, coverValue: 0.6,
  },
  wood: {
    material: 'wood', fracture: 'wood', healthPerM3: 260, chipThreshold: 14,
    explosiveMultiplier: 6.0, debrisLifetime: 16, blocksLosWhenIntact: false, coverValue: 0.35,
  },
};

/** Half-extent product → volume, for any shape we actually emit. */
function volumeOf(def: StaticColliderDef): number {
  const s = def.shape;
  if (s.kind === 'box') return 8 * s.half.x * s.half.y * s.half.z;
  if (s.kind === 'cylinder') return Math.PI * s.radius * s.radius * 2 * s.halfHeight;
  if (s.kind === 'capsule') return Math.PI * s.radius * s.radius * (2 * s.halfHeight + (4 / 3) * s.radius);
  if (s.kind === 'sphere') return (4 / 3) * Math.PI * s.radius * s.radius * s.radius;
  return 0;
}

/** Largest horizontal silhouette a collider can present, for the occluder sort. */
function silhouetteArea(def: StaticColliderDef): number {
  const s = def.shape;
  if (s.kind === 'box') return 4 * Math.max(s.half.x, s.half.z) * s.half.y;
  if (s.kind === 'cylinder') return 4 * s.radius * s.halfHeight;
  return 0;
}

function classifyFor(def: StaticColliderDef): ClassTemplate | null {
  // Only props and hand-placed static cover are ever destructible; the group is
  // the first filter because it is the one the emitters already set correctly.
  if (def.group !== CollisionGroup.StaticGeo && def.group !== CollisionGroup.Prop) return null;
  const s = def.shape;
  if (s.kind !== 'box' && s.kind !== 'cylinder') return null;
  const vol = volumeOf(def);
  // Anything over 12 m³ is structure, not cover.
  if (vol > 12 || vol < 0.02) return null;
  const height = s.kind === 'box' ? s.half.y * 2 : s.halfHeight * 2;
  if (height > 2.8) return null;

  switch (def.surface) {
    case SurfaceId.Sandbag:
      return CLASSES.sandbag;
    case SurfaceId.Concrete:
      return CLASSES.concrete;
    case SurfaceId.Sandstone:
    case SurfaceId.Rubble:
      // Only LOW sandstone — a boundary wall or a parapet, never a curtain.
      return height <= 2.2 ? CLASSES.masonry : null;
    case SurfaceId.Stucco:
    case SurfaceId.Plaster:
      return height <= 2.2 ? CLASSES.stucco : null;
    case SurfaceId.Wood:
    case SurfaceId.PaintedWood:
      return CLASSES.wood;
    default:
      return null;
  }
}

export interface ColliderPassStats {
  readonly total: number;
  readonly destructible: number;
  readonly occluders: number;
  readonly rejected: number;
}

export interface ColliderPassResult {
  readonly colliders: StaticColliderDef[];
  readonly destructibles: DestructibleDef[];
  readonly stats: ColliderPassStats;
}

const OCCLUDER_BUDGET = 48;
/**
 * Chunk budget across the whole map. `QualitySettings.destruction.maxChunks` is
 * the live ceiling; this is how many objects are ALLOWED to contribute to it, so
 * that the interesting ones still can late in a match.
 */
const MAX_DESTRUCTIBLES = 260;

/**
 * Run the whole-level pass. Returns a NEW array — the build's own list is left
 * alone so a reset can re-run this without re-running the build.
 */
export function finaliseColliders(
  raw: readonly StaticColliderDef[],
  rng: Rng,
  maxDestructibles = MAX_DESTRUCTIBLES,
): ColliderPassResult {
  const out: StaticColliderDef[] = [];
  const destructibles: DestructibleDef[] = [];
  let rejected = 0;

  // ---- validate ----------------------------------------------------------
  const el = new THREE.Vector3();
  for (const def of raw) {
    const m = def.matrix.elements;
    let bad = false;
    for (let i = 0; i < 16; i++) {
      if (!Number.isFinite(m[i])) {
        bad = true;
        break;
      }
    }
    if (!bad) {
      const s = def.shape;
      if (s.kind === 'box') {
        if (!(s.half.x > 1e-3 && s.half.y > 1e-3 && s.half.z > 1e-3)) bad = true;
      } else if (s.kind === 'cylinder' || s.kind === 'capsule') {
        if (!(s.radius > 1e-3 && s.halfHeight > 1e-4)) bad = true;
      } else if (s.kind === 'sphere') {
        if (!(s.radius > 1e-3)) bad = true;
      }
    }
    if (!bad) {
      el.setFromMatrixPosition(def.matrix);
      // −40 m is well under the macro seabed floor of −22 m; anything down there
      // is an authoring accident, not a submarine feature.
      if (el.y < -40) bad = true;
    }
    if (bad) {
      rejected++;
      continue;
    }
    out.push(def);
  }

  // ---- occluder budget ---------------------------------------------------
  const tagged: number[] = [];
  for (let i = 0; i < out.length; i++) if (out[i].occluder) tagged.push(i);
  let occluders = tagged.length;
  if (tagged.length > OCCLUDER_BUDGET) {
    tagged.sort((a, b) => silhouetteArea(out[b]) - silhouetteArea(out[a]));
    for (let i = OCCLUDER_BUDGET; i < tagged.length; i++) {
      const idx = tagged[i];
      out[idx] = { ...out[idx], occluder: false };
    }
    occluders = OCCLUDER_BUDGET;
  }

  // ---- destructible tagging ---------------------------------------------
  // Candidates first, then a deterministic thin to budget. Sorting by volume
  // keeps the SUBSTANTIAL cover destructible and drops the crates, which is the
  // right way round: blowing a hole in a barrier opens a sightline, blowing up a
  // crate is confetti.
  const candidates: { index: number; tpl: ClassTemplate; volume: number; score: number }[] = [];
  for (let i = 0; i < out.length; i++) {
    const tpl = classifyFor(out[i]);
    if (!tpl) continue;
    const volume = volumeOf(out[i]);
    candidates.push({ index: i, tpl, volume, score: volume * tpl.coverValue + rng.range(-1e-3, 1e-3) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.slice(0, maxDestructibles);
  for (let n = 0; n < chosen.length; n++) {
    const { index, tpl, volume } = chosen[n];
    const chunks = CHUNK_KEYS.get(tpl.fracture);
    if (!chunks) continue;
    const def: DestructibleDef = {
      id: `level.${tpl.material}.${n}`,
      material: tpl.material,
      health: Math.max(60, Math.round(volume * tpl.healthPerM3)),
      surface: out[index].surface,
      chunks,
      chipThreshold: tpl.chipThreshold,
      explosiveMultiplier: tpl.explosiveMultiplier,
      debrisLifetime: tpl.debrisLifetime,
      // Long enough that a wall you blew at the start of a push is still rubble
      // when you fall back through it, short enough that the bodies are freed.
      settleAfter: 4.5,
      blocksLosWhenIntact: tpl.blocksLosWhenIntact,
      coverValue: tpl.coverValue,
    };
    out[index] = { ...out[index], destructible: def };
    destructibles.push(def);
  }

  return {
    colliders: out,
    destructibles,
    stats: { total: out.length, destructible: destructibles.length, occluders, rejected },
  };
}
