/**
 * Scene organisation, the static registry and the 32 m sector grid.
 * CORE owns this file.
 *
 * three's own scene graph is a tree with per-frame matrix propagation and
 * per-object frustum culling. We keep it (the renderer needs it) but we do NOT
 * rely on it for visibility: a flat registry of AABBs is what culling.ts sorts,
 * frustum-tests and rasterises occluders against, and a flat array is the only
 * structure whose iteration order is stable enough for reproducible captures.
 *
 * The 32 m sector size is chosen against the map: Harbour Reach's street width
 * and building footprint mean a sector usually holds one building plus its
 * dressing, so a sector reject removes a coherent visual unit rather than
 * slicing one in half.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  type Box3,
  type DynamicHandle,
  type GeometrySpec,
  type Mat4,
  type SceneGraph,
  type StaticHandle,
  type StaticRegistration,
} from '@/engine/types';
import { buildBatches, geometryFromSpec } from '@/engine/batching';

export const SECTOR_SIZE = 32;
/** Sectors per axis in the addressing scheme. 256 × 32 m = 8.2 km of range. */
const SECTOR_AXIS = 256;
const SECTOR_HALF = SECTOR_AXIS / 2;

export interface StaticEntry {
  handle: StaticHandle;
  object: THREE.Object3D;
  layer: RenderLayer;
  castsShadow: boolean;
  occluder: boolean;
  lodGroup: number;
  fadeDistance: number;
  sector: number;
  /** World AABB, flattened so the culler never dereferences a Box3. */
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** Bounding sphere, derived once. Cheap first-pass rejection. */
  cx: number; cy: number; cz: number; radius: number;
  visible: boolean;
}

/**
 * A per-frame-moving object. Deliberately a SEPARATE list from `StaticEntry`:
 * the sector grid and the occlusion raster both assume a fixed AABB, so a
 * dynamic in the static list would either be culled against a stale box or force
 * a re-sector every frame. `bounds` is read live, never copied, so a lane that
 * moves its mesh updates one Box3 in place.
 */
export interface DynamicEntry {
  handle: DynamicHandle;
  object: THREE.Object3D;
  layer: RenderLayer;
  /** Null ⇒ never frustum-culled: camera-attached or world-spanning. */
  bounds: Box3 | null;
  visible: boolean;
}

export class EngineSceneGraph implements SceneGraph {
  readonly root = new THREE.Scene();

  private readonly groups = new Map<SceneGroup, THREE.Group>();
  private readonly statics: StaticEntry[] = [];
  private readonly byHandle = new Map<number, StaticEntry>();
  private readonly dynamics: DynamicEntry[] = [];
  private readonly byDynamicHandle = new Map<number, DynamicEntry>();
  private nextHandle = 1;
  private nextDynamicHandle = 1;

  readonly statsValue = {
    sectors: 0,
    visible: 0,
    culledFrustum: 0,
    culledOcclusion: 0,
    culledDistance: 0,
  };

  constructor() {
    this.root.name = 'ironsight';
    // The render graph submits in a precomputed material order; three's own
    // per-frame sort costs ~0.4 ms of CPU we cannot spare and would fight the
    // explicit ordering the graph relies on.
    this.root.matrixAutoUpdate = true;
    for (const name of Object.values(SceneGroup)) {
      const g = new THREE.Group();
      g.name = name;
      // Groups are pure organisation and never move, so skip the per-frame
      // matrix decompose for every one of them.
      g.matrixAutoUpdate = false;
      g.updateMatrix();
      this.root.add(g);
      this.groups.set(name, g);
    }
  }

  group(name: SceneGroup): THREE.Group {
    const g = this.groups.get(name);
    if (!g) throw new Error(`unknown scene group "${name}"`);
    return g;
  }

  addStatic(object: THREE.Object3D, opts: StaticRegistration): StaticHandle {
    const handle = this.nextHandle++ as StaticHandle;
    const b = opts.bounds;
    const cx = (b.min.x + b.max.x) * 0.5;
    const cy = (b.min.y + b.max.y) * 0.5;
    const cz = (b.min.z + b.max.z) * 0.5;
    const entry: StaticEntry = {
      handle,
      object,
      layer: opts.layer,
      castsShadow: opts.castsShadow,
      occluder: opts.occluder === true,
      lodGroup: opts.lodGroup ?? -1,
      fadeDistance: opts.fadeDistance ?? Number.POSITIVE_INFINITY,
      sector: this.sectorAt(cx, cz),
      minX: b.min.x, minY: b.min.y, minZ: b.min.z,
      maxX: b.max.x, maxY: b.max.y, maxZ: b.max.z,
      cx, cy, cz,
      radius: Math.hypot(b.max.x - cx, b.max.y - cy, b.max.z - cz),
      visible: true,
    };
    this.statics.push(entry);
    this.byHandle.set(handle as number, entry);
    object.castShadow = opts.castsShadow;
    return handle;
  }

  removeStatic(handle: StaticHandle): void {
    const entry = this.byHandle.get(handle as number);
    if (!entry) return;
    this.byHandle.delete(handle as number);
    const i = this.statics.indexOf(entry);
    // Splice, not swap-pop: the culler's iteration order must be stable or a
    // destroyed wall changes the order everything else is tested in.
    if (i >= 0) this.statics.splice(i, 1);
  }

  /**
   * Register an object that moves every frame. It joins `layer`'s visible set —
   * which is what `RenderGraph.drawLayer` draws — WITHOUT entering the sector
   * grid or the occluder set.
   *
   * `object.layers` is set here rather than left to the caller: a mesh in the
   * dynamic list but on the wrong layer mask is drawn by nothing, and that
   * failure is silent.
   */
  addDynamic(object: THREE.Object3D, layer: RenderLayer, bounds?: Box3): DynamicHandle {
    const handle = this.nextDynamicHandle++ as DynamicHandle;
    const entry: DynamicEntry = { handle, object, layer, bounds: bounds ?? null, visible: true };
    this.dynamics.push(entry);
    this.byDynamicHandle.set(handle as number, entry);
    // The WHOLE subtree, not just the root: three does not inherit layer masks
    // down the tree, so a ribbon parented under a registered group would sit on
    // layer 0 and be drawn by nothing — silently.
    object.traverse((child) => {
      child.layers.set(layer as number);
      // Our culler is authoritative for registered objects, exactly as for
      // statics; three's own per-object test would re-cull against a bounding
      // sphere that a GPU-displaced mesh no longer fits inside.
      child.frustumCulled = false;
    });
    return handle;
  }

  removeDynamic(handle: DynamicHandle): void {
    const entry = this.byDynamicHandle.get(handle as number);
    if (!entry) return;
    this.byDynamicHandle.delete(handle as number);
    const i = this.dynamics.indexOf(entry);
    if (i >= 0) this.dynamics.splice(i, 1);
  }

  /** Live view for culling.ts. Never mutate from outside this module. */
  get entries(): readonly StaticEntry[] {
    return this.statics;
  }

  /** Live view for culling.ts. Never mutate from outside this module. */
  get dynamicEntries(): readonly DynamicEntry[] {
    return this.dynamics;
  }

  batch(specs: readonly { geometry: GeometrySpec; matrix: Mat4; material: THREE.Material }[]): THREE.Object3D {
    return buildBatches(specs);
  }

  hideBatchInstance(object: THREE.Object3D, instanceId: number): void {
    // BatchedMesh keeps a per-instance visibility flag, so a destroyed wall
    // leaves the batch WITHOUT a geometry rebuild — which is the whole reason
    // destruction can afford to be cheap.
    const batched = object as THREE.BatchedMesh;
    if (typeof batched.setVisibleAt === 'function') {
      batched.setVisibleAt(instanceId, false);
      return;
    }
    const instanced = object as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      // No per-instance visibility on InstancedMesh: collapse it to a point.
      const m = new THREE.Matrix4().makeScale(0, 0, 0);
      instanced.setMatrixAt(instanceId, m);
      instanced.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Sector index for a world position. Packed as `z * 256 + x` over a signed
   * grid, so it is a plain integer usable as a Map key or a typed-array index
   * without hashing a string.
   */
  sectorAt(x: number, z: number): number {
    const sx = Math.floor(x / SECTOR_SIZE) + SECTOR_HALF;
    const sz = Math.floor(z / SECTOR_SIZE) + SECTOR_HALF;
    const cx = sx < 0 ? 0 : sx >= SECTOR_AXIS ? SECTOR_AXIS - 1 : sx;
    const cz = sz < 0 ? 0 : sz >= SECTOR_AXIS ? SECTOR_AXIS - 1 : sz;
    return cz * SECTOR_AXIS + cx;
  }

  get stats(): Readonly<SceneGraph['stats']> {
    return this.statsValue;
  }

  /** Convenience for lanes that build a mesh and want it registered in one call. */
  addMesh(group: SceneGroup, mesh: THREE.Object3D, opts: Omit<StaticRegistration, 'bounds'> & { bounds?: THREE.Box3 }): StaticHandle {
    this.group(group).add(mesh);
    const bounds = opts.bounds ?? new THREE.Box3().setFromObject(mesh);
    return this.addStatic(mesh, { ...opts, bounds });
  }
}

export function createSceneGraph(): EngineSceneGraph {
  return new EngineSceneGraph();
}

export { geometryFromSpec };
