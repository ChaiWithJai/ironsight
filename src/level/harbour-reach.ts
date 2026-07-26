/**
 * LevelService — HARBOUR REACH.
 *
 * OWNER: LEVEL. Day-0 stub: the null level (three capture points derived from
 * the frozen macro anchors, the shared named camera poses, no colliders) plus a
 * block-out massing of ALPHA, BRAVO and CHARLIE so the map has scale, occluders
 * and something to cast shadows before real kit geometry exists.
 *
 * LEVEL: delete `buildPlaceholderMassing`, keep `createLevelService`'s signature
 * and this path. Land `layout.ts` FIRST as pure data — AI and GAME both unblock
 * on it, and the anchors in `@/engine/macro` are the centres the terrain is
 * already flattened around, so import them rather than retyping them.
 *
 * Note the `occluder: true` flags below: the software occlusion raster takes at
 * most 48 tagged occluders and it wants BOX-LIKE, DISCRETE volumes. Tagging a
 * sprawling or concave object makes it under-occlude at best and pop geometry at
 * worst — tag walls and buildings, never terrain, never a whole district.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  RenderLayer,
  SceneGroup,
  SurfaceId,
  type AssetRegistry,
  type BootContext,
  type LevelService,
  type MaterialFactory,
  type QualitySettings,
  type SceneGraph,
} from '@/engine/types';
import { MACRO_ANCHORS, MACRO_TERRAIN } from '@/engine/macro';
import { createNullLevel, trackNull } from '@/bootstrap/nulls';
import { createRng } from '@/engine/rng';

interface Massing {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  yaw: number;
  surface: SurfaceId;
}

/**
 * Deterministic block-out. Seeded from a FIXED constant rather than the engine
 * RNG: this is level data, and level data must not move when another lane
 * changes how many random numbers it draws.
 */
function massingPlan(): Massing[] {
  const rng = createRng(0x48524348, 'level.placeholder');
  const out: Massing[] = [];

  const district = (
    cx: number,
    cz: number,
    radius: number,
    count: number,
    minH: number,
    maxH: number,
    surface: SurfaceId,
  ): void => {
    for (let i = 0; i < count; i++) {
      // Golden-angle placement: even coverage with no visible ring or grid,
      // which a uniform random disc does not give you at these counts.
      const a = i * 2.39996323 + rng.range(-0.2, 0.2);
      const r = Math.sqrt((i + 0.5) / count) * radius;
      out.push({
        x: cx + Math.cos(a) * r,
        z: cz + Math.sin(a) * r,
        width: rng.range(7, 15),
        depth: rng.range(7, 14),
        height: rng.range(minH, maxH),
        yaw: Math.round(rng.range(-2, 2)) * 0.15 + rng.range(-0.06, 0.06),
        surface,
      });
    }
  };

  // ALPHA — market square: dense low stucco blocks ringing an open centre.
  district(MACRO_ANCHORS.alpha.x, MACRO_ANCHORS.alpha.z, 74, 22, 5, 13, SurfaceId.Stucco);
  // BRAVO — harbour: fewer, taller, metal-clad sheds and crane bases.
  district(MACRO_ANCHORS.bravo.x, MACRO_ANCHORS.bravo.z, 82, 12, 6, 20, SurfaceId.RustedMetal);
  // CHARLIE — the old fort: heavy sandstone masses on the headland.
  district(MACRO_ANCHORS.charlie.x, MACRO_ANCHORS.charlie.z, 48, 9, 8, 16, SurfaceId.Sandstone);
  // The town in between, so the three points do not read as three islands.
  district(20, 150, 130, 26, 5, 14, SurfaceId.Sandstone);

  return out;
}

function buildPlaceholderMassing(scene: SceneGraph, materials: MaterialFactory): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'level(placeholder)';
  scene.group(SceneGroup.Level).add(root);

  const bySurface = new Map<SurfaceId, THREE.Matrix4[]>();
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();

  for (const m of massingPlan()) {
    const ground = MACRO_TERRAIN.height(m.x, m.z);
    // Sink 1 m into the ground: a block that merely touches the terrain leaves
    // the hard geometry/ground seam the brief calls out as an instant tell.
    pos.set(m.x, ground + m.height / 2 - 1, m.z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), m.yaw);
    scale.set(m.width, m.height, m.depth);
    matrix.compose(pos, quat, scale);
    let list = bySurface.get(m.surface);
    if (!list) {
      list = [];
      bySurface.set(m.surface, list);
    }
    list.push(matrix.clone());
  }

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  for (const [surface, matrices] of bySurface) {
    const material = materials.create({
      id: `level.placeholder.${surface}`,
      surface,
      layer: 0,
      features: MaterialFeature.None,
      roughness: surface === SurfaceId.RustedMetal ? 0.72 : 0.9,
      metalness: surface === SurfaceId.RustedMetal ? 0.6 : 0,
    });
    const mesh = new THREE.InstancedMesh(unitBox, material, matrices.length);
    mesh.name = `massing.${surface}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(RenderLayer.WorldOpaque as number);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    root.add(mesh);
  }

  root.updateMatrixWorld(true);
  scene.addStatic(root, {
    bounds: new THREE.Box3().setFromObject(root),
    layer: RenderLayer.WorldOpaque,
    castsShadow: true,
    // Registered as ONE static rather than per-building: an InstancedMesh is a
    // single draw and per-instance culling would need per-instance registration,
    // which is exactly the BatchedMesh work LEVEL will do properly.
    occluder: false,
  });
  return root;
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * LEVEL: replace the BODY of this file, keep this signature and this path.
 */
export function createLevelService(ctx: BootContext): LevelService {
  const root = buildPlaceholderMassing(ctx.services.scene, ctx.services.materials);
  return trackNull(createNullLevel(root));
}

/**
 * Building, prop and landmark meshes (8 parallel worker jobs), the navmesh
 * voxelise/region/contour pass, and cover-slot extraction. Steps 7 and 12 of the
 * bake table. `layout.ts` is PURE DATA and must land before any of it.
 */
export function registerLevelBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The placeholder massing is generated inline from MACRO_ANCHORS.
}

/**
 * Harness reset chain. Destroyed geometry is DESTRUCTION's to restore, but the
 * batch-instance visibility mask that destruction flipped lives here.
 */
export function resetLevel(_seed: number): void {
  // The placeholder massing is static.
}
