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
  QualityTier,
  SurfaceId,
  type AssetKey,
  type AssetRegistry,
  type DestructibleDef,
  type DestructionShard,
  type MeshAsset,
  type QualitySettings,
  type Rng,
  type ShardedMeshAsset,
  type StaticColliderDef,
  type Vec3,
} from '@/engine/types';

/** The five fracture sets the whole level shares. */
export type FractureClass = 'concrete' | 'brick' | 'stucco' | 'wood' | 'sandbag';

const CHUNK_KEYS = new Map<FractureClass, AssetKey<MeshAsset>>();

/**
 * Pre-fractured shards, one set per material class.
 *
 * Runtime fracture is a frame-hitch generator and is banned (architecture
 * §11.5), so the shards are baked once here and every destructible instance
 * re-uses the same set with a different transform. Five sets rather than one per
 * object is the whole reason destruction fits in the budget.
 *
 * THE SET IS BAKED IN A UNIT BOX, AND THAT IS LOAD-BEARING. One set has to serve
 * a 5 m garden wall, a 2 m sandbag emplacement and a 0.9 m crate. The shards are
 * therefore laid out inside a 1 m cube — which is what this asset's `bounds`
 * says — and PHYS re-proportions them into the solid that actually broke using
 * `DestructibleDef.extent`: centres per axis so the rubble covers the real
 * footprint, shapes uniformly so a thin wall does not shed wafers.
 *
 * WHAT `shards` IS FOR, AND WHY IT USED TO BE ABSENT. `DestructionService`
 * spawns rubble from `ShardedMeshAsset.shards` and from nothing else. This bake
 * returned a plain `MeshAsset` — twenty-four hulls in `collision` and one merged
 * display geometry — so `shardsOf()` found no shards, the chunk pool never
 * spawned, and every wall in HARBOUR REACH collapsed with `chunksSpawned: 0`.
 * The shards were being generated all along; they were in the wrong shape to be
 * seen. The type is now on the contract, so this bake states them directly.
 *
 * The shard shape is an irregular convex bipyramid: cheap, closed, convex, and
 * it tumbles believably because its inertia tensor is not a cube's. It does not
 * need to tile back into the original volume — nobody ever sees the unbroken
 * state and the broken state at the same time — it needs to look like broken
 * masonry when it lands.
 */
function defineChunkSet(
  assets: AssetRegistry,
  cls: FractureClass,
  surface: SurfaceId,
  shardCount: number,
): AssetKey<MeshAsset> {
  return assets.define<MeshAsset>(`level.chunks.${cls}`, AssetKind.Mesh, {
    kind: BakeKind.WorkerMesh,
    version: 2,
    // Cheap: a couple of dozen little hulls of ~24 triangles each. The cost
    // number matters because the scheduler degrades the lowest-priority steps
    // first and this one genuinely can be degraded — coarser shards are still
    // shards.
    cost: 14,
    cacheable: true,
    run: (): ShardedMeshAsset => {
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

      // A jittered lattice filling the unit box. Uniform random centres clump,
      // and a clump reads as a bug rather than as masonry.
      const ly = Math.max(1, Math.round(Math.cbrt(shardCount)));
      const lx = Math.max(1, Math.round(Math.sqrt(shardCount / ly)));
      const lz = Math.max(1, Math.round(shardCount / (lx * ly)));

      const shards: DestructionShard[] = [];
      const collision: MeshAsset['collision'][number][] = [];
      // The merged display geometry the `MeshAsset` half of the contract wants.
      // Nothing in the destruction path reads it; it exists so the asset is a
      // valid mesh for anyone who only wants to look at rubble.
      const mergedPos: number[] = [];
      const mergedNrm: number[] = [];
      const mergedUv: number[] = [];
      const mergedIdx: number[] = [];

      for (let ix = 0; ix < lx; ix++) {
        for (let iy = 0; iy < ly; iy++) {
          for (let iz = 0; iz < lz; iz++) {
            const cellX = 1 / lx;
            const cellY = 1 / ly;
            const cellZ = 1 / lz;
            const cx = (ix + 0.5) * cellX - 0.5 + (rand() - 0.5) * cellX * 0.5;
            const cy = (iy + 0.5) * cellY - 0.5 + (rand() - 0.5) * cellY * 0.5;
            const cz = (iz + 0.5) * cellZ - 0.5 + (rand() - 0.5) * cellZ * 0.5;
            const sx = cellX * 0.5 * (0.7 + rand() * 0.5);
            const sy = cellY * 0.5 * (0.7 + rand() * 0.5);
            const sz = cellZ * 0.5 * (0.7 + rand() * 0.5);

            const sides = 4 + Math.floor(rand() * 2.99);
            const eq: [number, number, number][] = [];
            for (let k = 0; k < sides; k++) {
              const a = (k / sides) * Math.PI * 2 + rand() * 0.5;
              const j = 0.62 + rand() * 0.42;
              eq.push([Math.cos(a) * sx * j, (rand() - 0.5) * sy * 0.5, Math.sin(a) * sz * j]);
            }
            const top: [number, number, number] = [(rand() - 0.5) * sx * 0.4, sy, (rand() - 0.5) * sz * 0.4];
            const bot: [number, number, number] = [(rand() - 0.5) * sx * 0.4, -sy, (rand() - 0.5) * sz * 0.4];

            const pts = new Float32Array((eq.length + 2) * 3);
            let w = 0;
            for (const p of [...eq, top, bot]) {
              pts[w++] = p[0];
              pts[w++] = p[1];
              pts[w++] = p[2];
            }

            const positions: number[] = [];
            const normals: number[] = [];
            const uvs: number[] = [];
            const push = (
              p: [number, number, number],
              q: [number, number, number],
              r: [number, number, number],
            ): void => {
              const ax = q[0] - p[0], ay = q[1] - p[1], az = q[2] - p[2];
              const bx = r[0] - p[0], by = r[1] - p[1], bz = r[2] - p[2];
              let nx = ay * bz - az * by;
              let ny = az * bx - ax * bz;
              let nz = ax * by - ay * bx;
              const l = Math.hypot(nx, ny, nz) || 1;
              nx /= l; ny /= l; nz /= l;
              for (const v of [p, q, r]) {
                positions.push(v[0], v[1], v[2]);
                normals.push(nx, ny, nz);
                // UVs in metres, like every other surface in this lane, phased
                // per shard so two pieces of the same wall do not carry the
                // identical stain in the identical place.
                uvs.push(v[0] * 2 + cx * 3, v[2] * 2 + cz * 3);
              }
            };
            for (let k = 0; k < eq.length; k++) {
              const j = (k + 1) % eq.length;
              push(eq[k], eq[j], top);
              push(eq[j], eq[k], bot);
            }

            // Bipyramid volume: two cones over the same polygon. Shoelace in the
            // XZ plane for the base area. This is what gives the shard its MASS.
            let area = 0;
            for (let k = 0; k < eq.length; k++) {
              const j = (k + 1) % eq.length;
              area += eq[k][0] * eq[j][2] - eq[j][0] * eq[k][2];
            }
            area = Math.abs(area) * 0.5;
            const volume = Math.max(1e-5, (2 / 3) * area * sy);

            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
            g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
            g.computeBoundingBox();
            g.computeBoundingSphere();

            shards.push({
              geometry: g,
              collider: { kind: 'convex', points: pts },
              centre: new THREE.Vector3(cx, cy, cz) as unknown as Vec3,
              volumeM3: volume,
            });
            collision.push({ kind: 'convex', points: pts });

            for (let v = 0; v < positions.length / 3; v++) {
              mergedIdx.push(mergedPos.length / 3);
              mergedPos.push(positions[v * 3] + cx, positions[v * 3 + 1] + cy, positions[v * 3 + 2] + cz);
              mergedNrm.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
              mergedUv.push(uvs[v * 2], uvs[v * 2 + 1]);
            }
          }
        }
      }

      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mergedPos), 3));
      merged.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(mergedNrm), 3));
      merged.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mergedUv), 2));
      merged.setIndex(new THREE.BufferAttribute(new Uint32Array(mergedIdx), 1));
      merged.computeBoundingBox();
      merged.computeBoundingSphere();

      return {
        lods: [merged],
        screenErrors: [0],
        collision,
        // THE UNIT BOX. PHYS divides the solid's own half-extents by this to get
        // the per-axis spread, so it has to be the box the shards were laid out
        // in and not the bounds of the geometry that happened to come out.
        bounds: new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
        surface,
        shards,
      };
    },
    dispose: (value) => {
      for (const lod of value.lods) lod.dispose();
      for (const shard of (value as Partial<ShardedMeshAsset>).shards ?? []) shard.geometry.dispose();
    },
  });
}

/**
 * Shards per set, by tier. THE TIER CHUNK BUDGET IS TWO KNOBS, NOT ONE, and this
 * is the bake-time half: how many pieces a wall is broken into is baked
 * geometry and cannot be decided later, while `QualitySettings.destruction
 * .maxChunks` limits how many of them may be live bodies at once. The costs
 * they control are different — geometry memory versus solver time — so they are
 * set independently, exactly as PHYS does for its own templates.
 */
function shardsForTier(tier: QualityTier): number {
  switch (tier) {
    case QualityTier.Low:
      return 12;
    case QualityTier.Medium:
      return 16;
    case QualityTier.Ultra:
      return 30;
    default:
      return 22;
  }
}

/** Called from `registerLevelBakes`. Idempotent across a harness reset. */
export function defineChunkAssets(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  if (CHUNK_KEYS.size > 0) return;
  const n = shardsForTier(quality.tier);
  CHUNK_KEYS.set('concrete', defineChunkSet(assets, 'concrete', SurfaceId.Concrete, n));
  CHUNK_KEYS.set('brick', defineChunkSet(assets, 'brick', SurfaceId.Rubble, n));
  CHUNK_KEYS.set('stucco', defineChunkSet(assets, 'stucco', SurfaceId.Stucco, n));
  CHUNK_KEYS.set('wood', defineChunkSet(assets, 'wood', SurfaceId.Wood, n));
  CHUNK_KEYS.set('sandbag', defineChunkSet(assets, 'sandbag', SurfaceId.Sandbag, n));
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

/**
 * Half-extents of a collider's bounding box, for `DestructibleDef.extent`. A
 * cylinder reports its radius on both horizontal axes, which is what the shard
 * spread wants — rubble comes off the whole footprint, not off a square.
 */
function halfExtentOf(def: StaticColliderDef): Vec3 {
  const s = def.shape;
  if (s.kind === 'box') return new THREE.Vector3(s.half.x, s.half.y, s.half.z) as unknown as Vec3;
  if (s.kind === 'cylinder' || s.kind === 'capsule') {
    return new THREE.Vector3(s.radius, s.halfHeight, s.radius) as unknown as Vec3;
  }
  if (s.kind === 'sphere') return new THREE.Vector3(s.radius, s.radius, s.radius) as unknown as Vec3;
  return new THREE.Vector3(0.5, 0.5, 0.5) as unknown as Vec3;
}

/**
 * "Is this world point inside the solid?", for attributing loose geometry to the
 * collider that represents it.
 *
 * The margin absorbs the couple of centimetres a chamfer, a jitter or a
 * settlement sag puts outside the collider box — a sandbag emplacement's bags
 * are authored with ±8 % scale and ±9° of yaw inside a squared-off collider —
 * without being loose enough to swallow the ground the wall stands on.
 *
 * Anything that is not a box or a cylinder returns a test that always fails:
 * silently claiming triangles against a shape we cannot check is how a wall
 * takes a piece of the building behind it with it when it falls.
 */
export function insideTest(
  def: StaticColliderDef,
  margin: number,
): (x: number, y: number, z: number) => boolean {
  const inverse = new THREE.Matrix4().copy(def.matrix).invert();
  const p = new THREE.Vector3();
  const s = def.shape;
  if (s.kind === 'box') {
    const hx = s.half.x + margin;
    const hy = s.half.y + margin;
    const hz = s.half.z + margin;
    return (x, y, z) => {
      p.set(x, y, z).applyMatrix4(inverse);
      return Math.abs(p.x) <= hx && Math.abs(p.y) <= hy && Math.abs(p.z) <= hz;
    };
  }
  if (s.kind === 'cylinder' || s.kind === 'capsule') {
    const r2 = (s.radius + margin) * (s.radius + margin);
    const hy = s.halfHeight + s.radius + margin;
    return (x, y, z) => {
      p.set(x, y, z).applyMatrix4(inverse);
      return Math.abs(p.y) <= hy && p.x * p.x + p.z * p.z <= r2;
    };
  }
  return () => false;
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
  /**
   * WHICH colliders were tagged, by index into `colliders`. The caller needs
   * this to hand each one its drawn geometry: the tagging decision is a
   * whole-level budget taken here, but only the orchestrator holds the meshes.
   */
  readonly chosen: readonly number[];
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
  const chosenIndices: number[] = [];
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
      // The shard sets are baked in a 1 m cube and shared by every instance of
      // the class; this is what re-proportions them into THIS solid, so a 5 m
      // wall drops rubble along five metres and a crate drops it inside itself.
      extent: halfExtentOf(out[index]),
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
    chosenIndices.push(index);
  }
  // Ascending, so the caller can walk it beside its own parallel arrays.
  chosenIndices.sort((a, b) => a - b);

  return {
    colliders: out,
    destructibles,
    chosen: chosenIndices,
    stats: { total: out.length, destructible: destructibles.length, occluders, rejected },
  };
}
