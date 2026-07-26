/**
 * TerrainService.
 *
 * OWNER: TERRAIN. Day-0 stub: the null terrain from `src/bootstrap/nulls.ts`
 * (whose `heightAt` is MACRO_TERRAIN, not a flat plane) plus a coarse triangle
 * mesh of that same analytic field, split into surface groups by slope and
 * shore distance so the beach, the town terrace and the headland read as
 * different materials.
 *
 * TERRAIN: delete `buildPlaceholderMesh`, keep `createTerrainService`'s
 * signature and this path.
 *
 * THE INVARIANT YOU INHERIT: `heightAt` must be LITERALLY the function the
 * terrain vertex shader displaces with. Both come from `NoiseLib`, which ships
 * matched CPU and GLSL over one permutation table. Any shader displacement
 * finer than the physics collider cell must be NORMAL-ONLY — position offsets
 * finer than the collider are what make players float over bumps and sink into
 * dips, and it is invisible until someone walks on it.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  RenderLayer,
  SceneGroup,
  SurfaceId,
  type AssetRegistry,
  type BootContext,
  type MaterialFactory,
  type QualitySettings,
  type SceneGraph,
  type TerrainService,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import { createNullTerrain, trackNull } from '@/bootstrap/nulls';

/** Vertices per axis. 129² = 16 641 verts, 32 768 triangles — one draw. */
const GRID = 128;

function buildPlaceholderMesh(scene: SceneGraph, materials: MaterialFactory): void {
  const b = MACRO_TERRAIN.bounds;
  const spanX = b.maxX - b.minX;
  const spanZ = b.maxZ - b.minZ;
  const verts = GRID + 1;

  const position = new Float32Array(verts * verts * 3);
  const uv = new Float32Array(verts * verts * 2);

  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const t = j * verts + i;
      const x = b.minX + (i / GRID) * spanX;
      const z = b.minZ + (j / GRID) * spanZ;
      position[t * 3] = x;
      position[t * 3 + 1] = MACRO_TERRAIN.height(x, z);
      position[t * 3 + 2] = z;
      // One UV repeat per 8 m so a detail texture has somewhere sane to land.
      uv[t * 2] = x / 8;
      uv[t * 2 + 1] = z / 8;
    }
  }

  // Bucket triangles by dominant surface so each becomes its own draw group.
  // Three buckets, in the order the material array below expects.
  const buckets: number[][] = [[], [], []];
  const centre = new THREE.Vector3();
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * verts + i;
      const c = a + 1;
      const d = a + verts;
      const e = d + 1;
      for (const tri of [[a, d, c], [c, d, e]]) {
        centre.set(0, 0, 0);
        for (const v of tri) {
          centre.x += position[v * 3] / 3;
          centre.y += position[v * 3 + 1] / 3;
          centre.z += position[v * 3 + 2] / 3;
        }
        // Slope from the two in-plane edges of the quad, which is exact for a
        // grid and far cheaper than a normal per triangle.
        const dy = Math.abs(position[d * 3 + 1] - position[a * 3 + 1]) + Math.abs(position[c * 3 + 1] - position[a * 3 + 1]);
        const cell = spanX / GRID;
        const slope = dy / cell;
        const shore = MACRO_TERRAIN.shoreDistance(centre.x, centre.z);
        const bucket = slope > 0.55 ? 2 : shore < 12 ? 0 : 1;
        buckets[bucket].push(tri[0], tri[1], tri[2]);
      }
    }
  }

  const index = new Uint32Array(buckets[0].length + buckets[1].length + buckets[2].length);
  const geometry = new THREE.BufferGeometry();
  let offset = 0;
  const groups: { start: number; count: number; material: number }[] = [];
  for (let g = 0; g < buckets.length; g++) {
    index.set(buckets[g], offset);
    groups.push({ start: offset, count: buckets[g].length, material: g });
    offset += buckets[g].length;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  for (const g of groups) geometry.addGroup(g.start, g.count, g.material);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const surfaceMaterials = [SurfaceId.Sand, SurfaceId.Dirt, SurfaceId.Rubble].map((surface) =>
    materials.create({
      id: `terrain.placeholder.${surface}`,
      surface,
      layer: 0,
      features: MaterialFeature.Triplanar,
      roughness: surface === SurfaceId.Sand ? 0.94 : 0.88,
      metalness: 0,
    }),
  );

  const mesh = new THREE.Mesh(geometry, surfaceMaterials);
  mesh.name = 'terrain(placeholder)';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.layers.set(RenderLayer.WorldOpaque as number);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  scene.group(SceneGroup.Terrain).add(mesh);
  scene.addStatic(mesh, {
    bounds: geometry.boundingBox ?? new THREE.Box3(),
    layer: RenderLayer.WorldOpaque,
    castsShadow: true,
    // The terrain is not an occluder candidate: it is one object covering the
    // whole screen, so its screen AABB would occlude everything behind the
    // camera's own footprint. Occluders must be discrete and box-like.
    occluder: false,
  });
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * TERRAIN: replace the BODY of this file, keep this signature and this path.
 */
export function createTerrainService(ctx: BootContext): TerrainService {
  buildPlaceholderMesh(ctx.services.scene, ctx.services.materials);
  return trackNull(createNullTerrain());
}

/**
 * The heightfield (fBm then 64 hydraulic erosion iterations on a 2048 R32F
 * ping-pong, with ONE readback for the physics collider), plus splat, curvature,
 * AO and macro break-up. Steps 3 and 4 of the bake table, 280 units at `full`.
 */
export function registerTerrainBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The placeholder mesh is evaluated from MACRO_TERRAIN at construction.
}

/** Harness reset chain: clipmap centre and LOD hysteresis, nothing else. */
export function resetTerrain(_seed: number): void {
  // The placeholder mesh is static.
}
