/**
 * NavService — the navmesh AI thinks on.
 *
 * OWNER: AI. Entry file: `createNavService` / `registerNavBakes` / `resetNav`
 * are named and pathed by the frozen descriptor table.
 *
 * WHERE THE MESH COMES FROM, IN ORDER OF PREFERENCE
 *   1. `NavService.build(data)` — LEVEL's own voxelise/region/contour bake,
 *      handed over when `src/level/navmesh-bake.ts` lands. It wins outright.
 *   2. This lane's bake: `ai.navfield` computes the walkable-height field from
 *      the frozen macro silhouette during the bake phase (no services exist
 *      then), and `createNavService` stamps LEVEL's colliders into it and
 *      merges the result into a portal graph.
 *
 * Both end up in the same `NavGraph`, so the pathfinder, the cover book and
 * every bot are indifferent to which one ran.
 *
 * THE BAKE IS A REAL STEP, NOT A LIE: it is declared with `assets.define`, it
 * reports progress, and it yields a frame every 48 rows. It dispatches to
 * BAKE's worker pool when one exists and computes inline when it does not —
 * which is the contract's mandated fallback, not a degradation.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeKind,
  CollisionGroup,
  type AssetKey,
  type AssetRegistry,
  type BootContext,
  type ColliderShape,
  type LevelService,
  type NavService,
  type NavmeshData,
  type QualitySettings,
  type Rng,
  type StaticColliderDef,
  type Vec3,
} from '@/engine/types';
import { NAV_FIELD_DESC, buildNavField, type NavField } from '@/ai/navfield';
import {
  DEFAULT_AGENT,
  NavGraph,
  buildFromField,
  buildFromNavmeshData,
  type NavAgent,
  type NavObstacle,
} from '@/ai/navgraph';
import { PathQueue, PathRequest, type PathCorner } from '@/ai/pathfind';
import { CoverBook } from '@/ai/cover';

/**
 * The lane-private face of the nav service. `system.ts` needs the graph, the
 * queue and the cover book; nothing outside `src/ai/` ever sees them.
 */
export interface NavRuntime extends NavService {
  readonly graph: NavGraph;
  readonly queue: PathQueue;
  readonly cover: CoverBook;
  readonly agent: NavAgent;
  readonly obstacles: readonly NavObstacle[];
  /** Advance the time-sliced path queue. Called once per tick by `AiService`. */
  stepQueue(nodeBudget: number, maxStarts: number): void;
  submitPath(request: PathRequest, from: Vec3, to: Vec3): void;
  cancelPath(request: PathRequest): void;
}

let fieldKey: AssetKey<NavField> | null = null;
let instance: IronNav | null = null;

const MAX_CORNERS = 32;

class IronNav implements NavRuntime {
  readonly graph = new NavGraph();
  readonly queue = new PathQueue();
  readonly cover = new CoverBook();
  readonly agent: NavAgent = DEFAULT_AGENT;
  private readonly obstacleList: NavObstacle[] = [];
  private field: NavField | null = null;
  private level: LevelService | null = null;
  private readonly scratch = new THREE.Vector3();
  private readonly corners: PathCorner[] = [];

  get obstacles(): readonly NavObstacle[] {
    return this.obstacleList;
  }

  get ready(): boolean {
    return this.graph.ready;
  }

  attach(level: LevelService, field: NavField | null): void {
    this.level = level;
    this.field = field;
    this.rebuild();
  }

  /** Full rebuild from the field + the level's current colliders. */
  rebuild(): void {
    const level = this.level;
    if (!level || !this.field) return;
    this.obstacleList.length = 0;
    gatherObstacles(level, this.obstacleList);
    const built = buildFromField(this.field, this.obstacleList, this.agent);
    copyGraph(built, this.graph);
    this.queue.setGraph(this.graph);
    this.cover.rebuild(level, this.obstacleList, this.graph, this.agent);
  }

  build(data: NavmeshData): void {
    const built = buildFromNavmeshData(data, this.agent, Math.max(0.5, data.cellSize || 1));
    copyGraph(built, this.graph);
    this.queue.setGraph(this.graph);
    if (this.level) this.cover.rebuild(this.level, this.obstacleList, this.graph, this.agent);
  }

  sample(position: Vec3, radius: number, out: Vec3): boolean {
    return this.graph.sample(position, radius, out);
  }

  findPath(from: Vec3, to: Vec3, out: Vec3[]): number {
    if (!this.graph.ready || out.length === 0) return 0;
    const n = this.queue.solveNow(from, to, this.corners, Math.min(out.length, MAX_CORNERS));
    for (let i = 0; i < n; i++) out[i].copy(this.corners[i].position);
    return n;
  }

  raycastWalkable(from: Vec3, to: Vec3, out: Vec3): boolean {
    return this.graph.raycastWalkable(from, to, this.agent, out);
  }

  randomPointNear(position: Vec3, radius: number, rng: Rng, out: Vec3): boolean {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = rng.next() * Math.PI * 2;
      // sqrt keeps the distribution uniform over the disc rather than clustered
      // at the centre, which otherwise makes every "wander" goal a tiny step.
      const r = Math.sqrt(rng.next()) * radius;
      this.scratch.set(position.x + Math.cos(a) * r, position.y, position.z + Math.sin(a) * r);
      if (this.graph.sample(this.scratch, 1.5, out)) return true;
    }
    return this.graph.sample(position, radius, out);
  }

  invalidate(min: Vec3, max: Vec3): void {
    if (!this.graph.ready || !this.level) return;
    this.obstacleList.length = 0;
    gatherObstacles(this.level, this.obstacleList);
    this.graph.reblock(min, max, this.obstacleList, this.agent);
    this.cover.rebuild(this.level, this.obstacleList, this.graph, this.agent);
  }

  stepQueue(nodeBudget: number, maxStarts: number): void {
    this.queue.step(nodeBudget, maxStarts, MAX_CORNERS);
  }

  submitPath(request: PathRequest, from: Vec3, to: Vec3): void {
    this.queue.submit(request, from, to);
  }

  cancelPath(request: PathRequest): void {
    this.queue.cancel(request);
  }

  dropTransient(): void {
    this.queue.clear();
  }
}

function copyGraph(from: NavGraph, into: NavGraph): void {
  into.polyCount = from.polyCount;
  into.ringStart = from.ringStart;
  into.ringXyz = from.ringXyz;
  into.centres = from.centres;
  into.flags = from.flags;
  into.adjStart = from.adjStart;
  into.adjPoly = from.adjPoly;
  into.adjKind = from.adjKind;
  into.adjPortal = from.adjPortal;
  into.adjPenalty = from.adjPenalty;
  into.minX = from.minX;
  into.minZ = from.minZ;
  into.cellSize = from.cellSize;
  into.nx = from.nx;
  into.nz = from.nz;
  into.cellPoly = from.cellPoly;
}

/* ---------------------------------------------------------------- obstacles */

const OBSTACLE_BOX = new THREE.Box3();
const OBSTACLE_MIN = new THREE.Vector3();
const OBSTACLE_MAX = new THREE.Vector3();
const MAX_OBSTACLES = 4000;

function pushBox(out: NavObstacle[], box: THREE.Box3): void {
  if (out.length >= MAX_OBSTACLES) return;
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
  out.push({ minX: box.min.x, minZ: box.min.z, maxX: box.max.x, maxZ: box.max.z, minY: box.min.y, maxY: box.max.y });
}

function shapeBounds(shape: ColliderShape, out: THREE.Box3): boolean {
  switch (shape.kind) {
    case 'box':
      out.set(OBSTACLE_MIN.copy(shape.half).negate(), OBSTACLE_MAX.copy(shape.half));
      break;
    case 'sphere':
      out.set(OBSTACLE_MIN.set(-shape.radius, -shape.radius, -shape.radius), OBSTACLE_MAX.set(shape.radius, shape.radius, shape.radius));
      break;
    case 'capsule':
    case 'cylinder': {
      const h = shape.halfHeight + (shape.kind === 'capsule' ? shape.radius : 0);
      out.set(OBSTACLE_MIN.set(-shape.radius, -h, -shape.radius), OBSTACLE_MAX.set(shape.radius, h, shape.radius));
      break;
    }
    case 'convex':
    case 'trimesh': {
      const points = shape.kind === 'convex' ? shape.points : shape.vertices;
      if (points.length < 3) return false;
      out.makeEmpty();
      // Stride the sample for very large meshes: a nav obstacle is an AABB, and
      // 40 k vertices give the same box as every 8th one.
      const stride = points.length > 30000 ? 24 : 3;
      for (let i = 0; i + 2 < points.length; i += stride) {
        out.expandByPoint(OBSTACLE_MIN.set(points[i], points[i + 1], points[i + 2]));
      }
      break;
    }
    case 'heightfield':
      // The ground is not an obstacle; the field already knows where it is.
      return false;
  }
  if ('offset' in shape && shape.offset) out.translate(shape.offset);
  return true;
}

function collidersToObstacles(defs: readonly StaticColliderDef[], out: NavObstacle[]): void {
  const blocking = CollisionGroup.StaticGeo | CollisionGroup.Prop | CollisionGroup.Vehicle | CollisionGroup.Debris;
  for (const def of defs) {
    if ((def.group & blocking) === 0) continue;
    if (!shapeBounds(def.shape, OBSTACLE_BOX)) continue;
    OBSTACLE_BOX.applyMatrix4(def.matrix);
    pushBox(out, OBSTACLE_BOX);
  }
}

/**
 * Obstacles for the stamp pass.
 *
 * `collectColliders()` is the CORRECT source — colliders are a deliberate
 * second representation and are what a bullet and a shoulder actually hit. The
 * render-tree fallback below exists because LEVEL's day-0 stub publishes a
 * block-out massing with no colliders at all, and a navmesh that walks straight
 * through twenty buildings would make every cover, flank and approach decision
 * in this lane untestable. It disappears the moment `collectColliders()`
 * returns anything.
 */
function gatherObstacles(level: LevelService, out: NavObstacle[]): void {
  collidersToObstacles(level.collectColliders(), out);
  if (out.length > 0) return;

  const instanceMatrix = new THREE.Matrix4();
  level.root.updateMatrixWorld(true);
  level.root.traverse((object) => {
    const mesh = object as THREE.Mesh & { isMesh?: boolean; isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (!local) return;
    if (mesh.isInstancedMesh) {
      const instanced = object as THREE.InstancedMesh;
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, instanceMatrix);
        instanceMatrix.premultiply(instanced.matrixWorld);
        OBSTACLE_BOX.copy(local).applyMatrix4(instanceMatrix);
        pushBox(out, OBSTACLE_BOX);
      }
    } else {
      OBSTACLE_BOX.copy(local).applyMatrix4(mesh.matrixWorld);
      pushBox(out, OBSTACLE_BOX);
    }
  });
}

/* -------------------------------------------------------- the three exports */

export function createNavService(ctx: BootContext): NavService {
  const nav = new IronNav();
  instance = nav;
  const field = fieldKey ? ctx.assets.tryGet(fieldKey) ?? null : null;
  ctx.report('nav: stamping colliders');
  nav.attach(ctx.services.level, field);
  return nav;
}

/**
 * Step 12 of the bake table: the walkable-height field. Obstacle stamping is
 * NOT here and cannot be — `registerBakes` runs before every subsystem exists,
 * so there is no `LevelService` to ask. It costs a fraction of the field pass
 * anyway.
 */
export function registerNavBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  // The nav grid is gameplay resolution, not texture resolution: it does not
  // degrade with the bake profile, because a coarser navmesh changes where bots
  // can walk, and that is a simulation change, not a softer image.
  const cellSize = quality.ai.maxBots <= 10 ? 1.25 : 1;
  fieldKey = assets.define<NavField>('ai.navfield', AssetKind.Nav, {
    kind: BakeKind.WorkerData,
    version: 1,
    cost: 110,
    cacheable: true,
    async run(bake) {
      const desc = { ...NAV_FIELD_DESC, cellSize };
      if (bake.workers.size > 0) {
        // BAKE's pool takes transferables only, and every array in `NavField`
        // is one. If the pool has no such job registered it throws, and the
        // inline path below is the contract's mandated fallback rather than a
        // consolation prize.
        try {
          return await bake.workers.run<typeof desc, NavField>('ai.navfield', desc);
        } catch {
          bake.progress(0, 'ai.navfield (inline)');
        }
      }
      return await buildNavField(desc, async (f) => {
        bake.progress(f);
        await bake.yieldFrame();
      });
    },
  });
}

export function resetNav(_seed: number): void {
  // The graph itself is deterministic and immutable between captures; what
  // leaks is the in-flight search queue and any polygon a previous capture's
  // destruction blocked.
  instance?.dropTransient();
}

/** Lane-private accessor. `src/ai/system.ts` is the only caller. */
export function navRuntime(): NavRuntime | null {
  return instance;
}
