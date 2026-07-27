/**
 * LevelService — HARBOUR REACH.
 *
 * OWNER: LEVEL. This file is the ORCHESTRATOR and nothing else: it decides the
 * order things are built in, turns the one `LevelBuild` into meshes and
 * colliders, runs the two bakes, and publishes the result. Every piece of
 * geometry lives in `kit/`, `dressing.ts`, `district.ts` or `landmarks/`.
 *
 * BUILD ORDER, AND WHY IT IS THIS ORDER
 * -------------------------------------
 *  1. LANDMARKS FIRST. They own their footprints (`KEEP_CLEAR` in `layout.ts`)
 *     and the district subdivider drops any plot that overlaps one. Building
 *     them first is not required by the data — the keep-clear circles are static
 *     — but it means the RNG stream reaches the town in the same state no matter
 *     how the landmarks change, so a fort edit does not reshuffle the town.
 *     (That is why each subsystem draws from its OWN forked stream.)
 *  2. STREETS, then the town, then the street furniture. Furniture last because
 *     it is the only thing that needs to know where the buildings ended up.
 *  3. The two bakes, over the finished collider/deck/cover lists.
 *
 * DETERMINISM
 * -----------
 * The level is seeded from a FIXED constant, not from `ctx.rng`. Level data must
 * not move when another lane changes how many random numbers it draws, and a
 * capture that re-poses the camera must not re-roll the town. `resetLevel` is
 * therefore a no-op for geometry; what it does reset is the visibility state
 * DESTRUCTION leaves behind.
 *
 * DRAW CALLS
 * ----------
 * The whole town is SEVENTEEN draws — one per material in `materials.ts` — because
 * everything is appended into one vertex stream per material by `MeshBuilder`.
 * That is what makes "detail density is final quality" affordable: adding a
 * thousand shutters costs triangles and costs nothing else.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  Team,
  type AssetRegistry,
  type BootContext,
  type CameraRigPose,
  type CapturePointDef,
  type CoverSlot,
  type DestructibleDef,
  type LevelService,
  type NavmeshData,
  type QualitySettings,
  type Rng,
  type SpawnPointDef,
  type StaticColliderDef,
  type Vec3,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import { createRng } from '@/engine/rng';
import { LevelBuild } from '@/level/build';
import { MAT_KEYS, createLevelMaterials } from '@/level/materials';
import { NAV_BOUNDS, POINTS, SPAWNS, ALPHA_SQUARE, CRANES, FUEL_DEPOT, QUAY } from '@/level/layout';
import { buildSquare, buildStreets, buildTown, dressStreets, generatePlots } from '@/level/district';
import {
  buildBreakwater, buildContainerYard, buildCrane, buildFuelDepot, buildQuay, buildWarehouse,
} from '@/level/landmarks/harbour';
import { buildMarketHall, buildMinaret, buildMosque, buildSquareTerrace } from '@/level/landmarks/town';
import { buildFort } from '@/level/landmarks/fort';
import { buildFreighter } from '@/level/landmarks/freighter';
import { CoverIndex, bakeCoverSlots } from '@/level/cover-bake';
import { bakeNavmesh, type NavBakeStats } from '@/level/navmesh-bake';
import { defineChunkAssets, finaliseColliders } from '@/level/colliders';
import { CAMERA_POSES, CAMERA_POSE_NAMES } from '@/level/cameras';

/**
 * The one seed the whole level is generated from. 'HRCH'. Changing it reshuffles
 * every building in the town, which is a level-design decision, not a tuning one.
 */
const LEVEL_SEED = 0x48524348;

interface BuiltLevel {
  readonly root: THREE.Object3D;
  readonly colliders: readonly StaticColliderDef[];
  readonly destructibles: readonly DestructibleDef[];
  readonly coverSlots: readonly CoverSlot[];
  readonly coverIndex: CoverIndex;
  readonly navmesh: NavmeshData;
  readonly exclusions: readonly { x: number; z: number; radius: number }[];
  readonly bounds: THREE.Box3;
  readonly stats: LevelStats;
}

interface LevelStats {
  readonly triangles: number;
  readonly draws: number;
  readonly plots: number;
  readonly colliders: number;
  readonly destructibles: number;
  readonly occluders: number;
  readonly coverSlots: number;
  readonly nav: NavBakeStats;
}

/** Module-scoped so `resetLevel` can reach it without `create` having run. */
let built: BuiltLevel | null = null;

/* ==========================================================================
 * BUILD
 * ======================================================================= */

/**
 * The ground the level is authored against.
 *
 * TERRAIN's `heightAt` is the surface the player actually stands on, so paving,
 * ground skirts and plinths must follow IT rather than the macro field — a skirt
 * laid on the macro field is exactly the hard seam this lane exists to remove.
 * The macro field is the fallback and the sanity check: TERRAIN is contracted
 * not to move the silhouette by more than a couple of metres, so a disagreement
 * larger than that is a bug in one of us and the frozen answer is the safe one.
 */
function groundSampler(terrainHeight: ((x: number, z: number) => number) | null): (x: number, z: number) => number {
  if (!terrainHeight) return (x, z) => MACRO_TERRAIN.height(x, z);
  return (x, z) => {
    const macro = MACRO_TERRAIN.height(x, z);
    const h = terrainHeight(x, z);
    if (!Number.isFinite(h) || Math.abs(h - macro) > 6) return macro;
    return h;
  };
}

function buildLevel(ctx: BootContext): BuiltLevel {
  const rootRng = createRng(LEVEL_SEED, 'level');
  const b = new LevelBuild(rootRng);

  const terrain = ctx.services.terrain;
  const ground = groundSampler(terrain ? (x, z) => terrain.heightAt(x, z) : null);

  // Each subsystem gets its own forked stream, so editing the fort cannot
  // reshuffle the town and a diff of one landmark stays a diff of one landmark.
  const fork = (label: string): Rng => rootRng.fork(label);

  // ---- 1. landmarks -------------------------------------------------------
  ctx.report('building level: harbour');
  const rHarbour = fork('harbour');
  buildQuay(b, ground, rHarbour);
  for (const c of CRANES) buildCrane(b, c.x, c.z, c.yaw, c.height, rHarbour);
  buildBreakwater(b, ground, rHarbour);
  // Three sheds along the landward edge of the quay apron, and the yard between
  // the western two. Positions are derived from the quay line so they cannot
  // drift off the apron if the coast is ever re-cut.
  const apronAt = (t: number, inland: number): { x: number; z: number } => {
    const e = QUAY.edge;
    const i = Math.min(e.length - 2, Math.floor(t * (e.length - 1)));
    const f = t * (e.length - 1) - i;
    const ax = e[i].x + (e[i + 1].x - e[i].x) * f;
    const az = e[i].z + (e[i + 1].z - e[i].z) * f;
    const dx = e[i + 1].x - e[i].x;
    const dz = e[i + 1].z - e[i].z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: ax - (dz / len) * inland, z: az + (dx / len) * inland };
  };
  const shedA = apronAt(0.14, 26);
  const shedB = apronAt(0.52, 27);
  const shedC = apronAt(0.86, 25);
  buildWarehouse(b, shedA.x, shedA.z, 16, 9, 0.28, ground, rHarbour);
  buildWarehouse(b, shedB.x, shedB.z, 13, 8, 0.24, ground, rHarbour);
  buildWarehouse(b, shedC.x, shedC.z, 11, 7.5, 0.18, ground, rHarbour);
  const yard = apronAt(0.33, 13);
  buildContainerYard(b, yard.x, yard.z, 22, 9, 0.26, ground, rHarbour);
  buildFuelDepot(b, FUEL_DEPOT.x, FUEL_DEPOT.z, FUEL_DEPOT.yaw, ground, rHarbour);

  ctx.report('building level: town');
  const rTown = fork('town-landmarks');
  buildSquareTerrace(b, ground, rTown);
  const hall = buildMarketHall(b, ground, rTown);
  buildMosque(b, ground, rTown);
  buildMinaret(b, ground, rTown);

  ctx.report('building level: fort');
  const charlieFloorY = buildFort(b, ground, fork('fort'));

  ctx.report('building level: wreck');
  buildFreighter(b, fork('freighter'));

  // ---- 2. the town --------------------------------------------------------
  ctx.report('building level: districts');
  const rDistrict = fork('districts');
  buildStreets(b, ground, rDistrict);
  const plots = generatePlots(ground, rDistrict);
  buildTown(b, plots, ground, rDistrict);
  buildSquare(b, ALPHA_SQUARE.x, ALPHA_SQUARE.z, ALPHA_SQUARE.hx, ALPHA_SQUARE.hz, ground, rDistrict, hall);
  dressStreets(b, ground, rDistrict);

  // ---- 3. geometry --------------------------------------------------------
  ctx.report('building level: meshes');
  const materials = createLevelMaterials(ctx.services.materials);
  const root = new THREE.Group();
  root.name = 'harbour-reach';
  const bounds = new THREE.Box3();
  let draws = 0;
  const triangles = b.stats.triangles;
  for (const key of MAT_KEYS) {
    const geometry = b.m(key).finish();
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, materials[key]);
    mesh.name = `level.${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.layers.set(RenderLayer.WorldOpaque as number);
    root.add(mesh);
    draws++;
    if (geometry.boundingBox) bounds.union(geometry.boundingBox);
  }
  root.updateMatrixWorld(true);
  ctx.services.scene.group(SceneGroup.Level).add(root);
  // ONE static registration for the whole level. Per-mesh registration would
  // buy nothing: each mesh already spans the map, so no frustum or occlusion
  // test can ever reject one. Real per-object culling is the BatchedMesh path,
  // and it is not worth 1 200 registrations to save 15 draws that are already
  // inside the budget.
  ctx.services.scene.addStatic(root, {
    bounds: bounds.clone(),
    layer: RenderLayer.WorldOpaque,
    castsShadow: true,
    occluder: false,
  });

  // ---- 4. bakes -----------------------------------------------------------
  ctx.report('building level: colliders');
  const pass = finaliseColliders(b.colliders, fork('colliders'));

  ctx.report('building level: cover');
  const coverSlots = bakeCoverSlots(b.coverBoxes, fork('cover'), {
    density: 0.45,
    maxSlots: 3000,
  });

  ctx.report('building level: navmesh');
  const nav = bakeNavmesh({
    bounds: NAV_BOUNDS,
    decks: b.navDecks,
    blockers: b.navBlockers,
    groundAt: ground,
  });

  // The capture points sit on the BUILT floor where there is one — CHARLIE's
  // courtyard is a levelled platform above the terrain, and a capture volume
  // anchored to the rock under it would sit half a storey below the fight.
  CHARLIE_FLOOR_Y = charlieFloorY;

  return {
    root,
    colliders: pass.colliders,
    destructibles: pass.destructibles,
    coverSlots,
    coverIndex: new CoverIndex(coverSlots),
    navmesh: nav.data,
    exclusions: b.vegExclusions,
    bounds,
    stats: {
      triangles,
      draws,
      plots: plots.length,
      colliders: pass.stats.total,
      destructibles: pass.stats.destructible,
      occluders: pass.stats.occluders,
      coverSlots: coverSlots.length,
      nav: nav.stats,
    },
  };
}

/**
 * CHARLIE's courtyard floor, set during the build.
 *
 * The fort levels a platform on the highest rock inside its enceinte, so the
 * floor is ~0.5 m above the macro plateau. The capture volume has to sit on the
 * floor: anchored to the terrain instead, its bottom edge is below the courtyard
 * and a player standing in the middle of the fort is out of the point.
 */
let CHARLIE_FLOOR_Y: number = POINTS.charlie.y;

/* ==========================================================================
 * PUBLISHED DATA
 * ======================================================================= */

function capturePoints(): CapturePointDef[] {
  return [
    {
      id: 'ALPHA',
      label: 'MARKET SQUARE',
      centre: new THREE.Vector3(POINTS.alpha.x, POINTS.alpha.y, POINTS.alpha.z) as unknown as Vec3,
      radius: POINTS.alpha.radius,
      height: POINTS.alpha.height,
      // ALPHA starts Coalition because they deploy on the east beach 60 m away
      // and CHARLIE starts Insurgent for the mirrored reason. BRAVO is neutral
      // and 130 m from both, which is where the first fight of every match is.
      initialOwner: Team.Coalition,
    },
    {
      id: 'BRAVO',
      label: 'HARBOUR CRANES',
      centre: new THREE.Vector3(POINTS.bravo.x, POINTS.bravo.y, POINTS.bravo.z) as unknown as Vec3,
      radius: POINTS.bravo.radius,
      height: POINTS.bravo.height,
      initialOwner: Team.Neutral,
    },
    {
      id: 'CHARLIE',
      label: 'OLD FORT',
      centre: new THREE.Vector3(POINTS.charlie.x, CHARLIE_FLOOR_Y, POINTS.charlie.z) as unknown as Vec3,
      radius: POINTS.charlie.radius,
      height: POINTS.charlie.height,
      initialOwner: Team.Insurgent,
    },
  ];
}

function spawnPoints(ground: (x: number, z: number) => number): SpawnPointDef[] {
  return SPAWNS.map((s) => ({
    team: s.team === 'coalition' ? Team.Coalition : Team.Insurgent,
    // Spawn 5 cm clear of the ground: exactly on it and the character
    // controller's first depenetration shove is upward, which reads as a hop.
    position: new THREE.Vector3(s.x, ground(s.x, s.z) + 0.05, s.z) as unknown as Vec3,
    yaw: s.yaw,
    linkedPoint: s.link,
  }));
}

/* ==========================================================================
 * SERVICE
 * ======================================================================= */

/** Factory referenced by `src/bootstrap/subsystems.ts`. */
export function createLevelService(ctx: BootContext): LevelService {
  const level = buildLevel(ctx);
  built = level;

  const terrain = ctx.services.terrain;
  const ground = groundSampler(terrain ? (x, z) => terrain.heightAt(x, z) : null);
  const points = capturePoints();
  const spawns = spawnPoints(ground);

  const playableBounds = new THREE.Box3(
    new THREE.Vector3(MACRO_TERRAIN.bounds.minX, -30, MACRO_TERRAIN.bounds.minZ),
    new THREE.Vector3(MACRO_TERRAIN.bounds.maxX, 140, MACRO_TERRAIN.bounds.maxZ),
  );

  // Everything that has to reach another lane's service happens AFTER boot —
  // `nav` and `vegetation` are constructed after `level` and calling them from
  // the factory body would silently hit the null implementations.
  ctx.afterBoot((services) => {
    services.nav.build?.(level.navmesh);
    for (const e of level.exclusions) {
      services.vegetation.addExclusion(
        new THREE.Vector3(e.x, ground(e.x, e.z), e.z) as unknown as Vec3,
        e.radius,
      );
    }
    const s = level.stats;
    ctx.report(
      `level: ${s.triangles} tris / ${s.draws} draws, ${s.plots} plots, ` +
      `${s.colliders} colliders (${s.destructibles} destructible, ${s.occluders} occluders), ` +
      `${s.coverSlots} cover slots, nav ${s.nav.triangles} polys in ${s.nav.regions} regions`,
    );
  });

  return {
    name: 'HARBOUR REACH',
    ready: true,
    root: level.root,
    capturePoints: points,
    spawnPoints: spawns,
    coverSlots: level.coverSlots,
    playableBounds,
    collectColliders: () => level.colliders,
    collectDestructibles: () => level.destructibles,
    findCover: (position, threat, maxRange) => level.coverIndex.find(position, threat, maxRange),
    cameraPose: (name): Readonly<CameraRigPose> | undefined => CAMERA_POSES.get(name),
    cameraPoseNames: CAMERA_POSE_NAMES,
  };
}

/**
 * Bake steps this lane declares. The fracture sets are the only thing LEVEL
 * needs from the asset pipeline — all of its geometry is generated inline in
 * `create`, on the main thread, because it has to be finished before PHYS builds
 * rapier colliders from it in the same boot phase.
 */
export function registerLevelBakes(assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  defineChunkAssets(assets);
}

/**
 * Harness reset chain.
 *
 * The geometry is NOT regenerated. It comes from `LEVEL_SEED` rather than from
 * the engine RNG, so a capture that reseeds is contractually entitled to the
 * same town — and rebuilding 550 000 triangles between shots would eat a
 * meaningful slice of the harness' 300 s ready budget for no change in output.
 *
 * What IS restored is visibility. DESTRUCTION hides level geometry when a wall
 * comes down (the whole level is fifteen merged meshes, so what it actually
 * hides is a batch instance or a child node), and a shot captured after a
 * previous shot blew a hole in ALPHA would otherwise inherit the hole. Sixteen
 * objects is cheap enough to walk unconditionally; tracking a dirty bit for it
 * would be a cache with one entry and two ways to go wrong.
 */
export function resetLevel(_seed: number): void {
  if (!built) return;
  built.root.traverse((o) => {
    o.visible = true;
  });
}
