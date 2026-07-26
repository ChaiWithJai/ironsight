/**
 * TerrainService. Owned by TERRAIN.
 *
 * Assembly only: the heightfield lives in `field.ts`, the LOD mesh in
 * `chunks.ts`, the published maps in `maps.ts` and the shading in `shader.ts`.
 *
 * THE INVARIANT THIS FILE EXISTS TO KEEP: `heightAt` is the function the terrain
 * geometry is built from. Not a copy of it, not a shader port of it — the same
 * call. `TerrainChunks` evaluates `TerrainField.height` per vertex on the CPU
 * and uploads the result; nothing in this lane displaces a vertex in a shader,
 * so the GPU and the physics collider cannot disagree by construction. The
 * shader adds relief only through the NORMAL, which is the other half of the
 * contract: position detail finer than the collider cell is exactly what makes
 * players float over bumps and sink into dips.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeKind,
  RenderStage,
  SurfaceId,
  type AssetKey,
  type AssetRegistry,
  type BootContext,
  type FrameCtx,
  type QualitySettings,
  type TerrainService,
  type Vec3,
} from '@/engine/types';
import { clamp } from '@/engine/math/curves';
import { FIELD_HALF, TerrainField } from '@/world/terrain/field';
import { TerrainChunks } from '@/world/terrain/chunks';
import { SHORE_RANGE_METRES, buildMaps, paintGroundTransitions, type TerrainMaps } from '@/world/terrain/maps';
import { createTerrainMaterial } from '@/world/terrain/shader';

interface TerrainBake {
  readonly field: TerrainField;
  readonly maps: TerrainMaps;
}

let bakeKey: AssetKey<TerrainBake> | undefined;
let live: HarbourTerrain | undefined;

class HarbourTerrain implements TerrainService {
  readonly ready = true;
  readonly bounds: THREE.Box3;
  readonly seaLevel: number;
  readonly collisionHeightfield: Readonly<{ data: Float32Array; size: number; scale: Vec3 }>;
  readonly heightMap: THREE.Texture;
  readonly splatMap: THREE.Texture;
  readonly shoreMask: THREE.Texture;
  readonly groundAlbedoMap: THREE.Texture;
  readonly mapRect: Readonly<{ minX: number; minZ: number; sizeX: number; sizeZ: number }>;
  readonly shoreRangeMetres = SHORE_RANGE_METRES;

  private readonly chunks: TerrainChunks;
  private readonly grad = { gx: 0, gz: 0 };

  constructor(
    private readonly field: TerrainField,
    private readonly maps: TerrainMaps,
    chunks: TerrainChunks,
  ) {
    this.chunks = chunks;
    this.seaLevel = field.seaLevel;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-FIELD_HALF, -40, -FIELD_HALF),
      new THREE.Vector3(FIELD_HALF, 120, FIELD_HALF),
    );
    this.heightMap = maps.heightMap;
    this.splatMap = maps.splatMap;
    this.shoreMask = maps.shoreMask;
    this.groundAlbedoMap = maps.groundAlbedo;
    this.mapRect = maps.rect;
    // The physics heightfield is the SAME SAMPLES the camera sees — no resample,
    // no second evaluation of the field, only a transpose into rapier's
    // column-major layout. `scale` gives the world extents; the samples are
    // already metres, so the Y multiplier is 1.
    this.collisionHeightfield = {
      data: field.transposedForPhysics(),
      size: field.res + 1,
      scale: new THREE.Vector3(FIELD_HALF * 2, 1, FIELD_HALF * 2) as Vec3,
    };
  }

  heightAt(x: number, z: number): number {
    return this.field.height(x, z);
  }

  normalAt(x: number, z: number, out: Vec3): Vec3 {
    this.field.gradient(x, z, this.grad);
    const len = Math.hypot(this.grad.gx, 1, this.grad.gz);
    return out.set(-this.grad.gx / len, 1 / len, -this.grad.gz / len);
  }

  /** Radians from vertical, which is what nav slope limits and AI want. */
  slopeAt(x: number, z: number): number {
    return Math.atan(this.field.slope(x, z));
  }

  /**
   * Read back the SAME splat the shader reads, so a footstep cue, an impact
   * decal and the pixel under the player's boot always agree about what the
   * ground is made of. Deriving it from the rules a second time would be a
   * second implementation that drifts.
   */
  surfaceAt(x: number, z: number): SurfaceId {
    const { size, rect, splatData } = this.maps;
    const i = clamp(Math.floor(((x - rect.minX) / rect.sizeX) * size), 0, size - 1);
    const j = clamp(Math.floor(((z - rect.minZ) / rect.sizeZ) * size), 0, size - 1);
    const t = (j * size + i) * 4;
    const sand = splatData[t];
    const scrub = splatData[t + 1];
    const rock = splatData[t + 2];
    const transition = splatData[t + 3];
    if (transition > 150) return SurfaceId.Gravel;
    if (rock >= sand && rock >= scrub) return SurfaceId.Sandstone;
    if (sand >= scrub) return this.field.shoreDistance(x, z) < 1.6 ? SurfaceId.WetSand : SurfaceId.Sand;
    return SurfaceId.Dirt;
  }

  /**
   * Fixed-step march, bisected once a crossing is bracketed. Not a physics
   * query: AI line-of-sight and VFX ground snapping call it thousands of times
   * a second and cannot afford a rapier round trip.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, out: Vec3): number {
    const step = Math.max(0.4, maxDistance / 320);
    let prevT = 0;
    let prevD = origin.y - this.field.height(origin.x, origin.z);
    for (let t = step; t <= maxDistance; t += step) {
      const px = origin.x + direction.x * t;
      const py = origin.y + direction.y * t;
      const pz = origin.z + direction.z * t;
      const d = py - this.field.height(px, pz);
      if (d <= 0 && prevD > 0) {
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) * 0.5;
          if (
            origin.y + direction.y * mid - this.field.height(origin.x + direction.x * mid, origin.z + direction.z * mid) <=
            0
          ) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        out.set(origin.x + direction.x * hi, origin.y + direction.y * hi, origin.z + direction.z * hi);
        return hi;
      }
      prevT = t;
      prevD = d;
    }
    return -1;
  }

  update(ctx: FrameCtx): void {
    const p = ctx.camera.position;
    this.chunks.update(p.x, p.z);
  }

  forceRebuild(x: number, z: number): void {
    this.chunks.update(x, z, true);
  }

  paintTransitions(colliders: Parameters<typeof paintGroundTransitions>[1]): void {
    paintGroundTransitions(this.maps, colliders, this.field);
  }

  get stats(): Readonly<{ nodes: number; triangles: number; draws: number }> {
    return this.chunks.stats;
  }
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * Everything expensive already ran in the bake step; this wires the mesh, the
 * material and the LOD system to services that only exist now.
 */
export function createTerrainService(ctx: BootContext): TerrainService {
  const bake = bakeKey ? ctx.assets.tryGet(bakeKey) : undefined;
  if (!bake) {
    throw new Error(
      'TerrainService: the terrain field bake did not run. registerTerrainBakes must be called before bakeAll.',
    );
  }

  const materials = ctx.services.materials;
  const material = createTerrainMaterial({
    materials,
    maps: bake.maps,
    sand: materials.textures(SurfaceId.Sand),
    rock: materials.textures(SurfaceId.Sandstone),
  });

  const chunks = new TerrainChunks(bake.field, ctx.services.scene, material);
  const service = new HarbourTerrain(bake.field, bake.maps, chunks);
  live = service;

  // Build a cut immediately so the very first frame — and every shot, which
  // poses the camera and renders without ever walking — has real ground under
  // it rather than an empty geometry.
  service.forceRebuild(0, 0);

  ctx.addRender({
    name: 'terrain.lod',
    stage: RenderStage.Scene,
    update: (frame) => service.update(frame),
  });

  // LEVEL is guaranteed built by afterBoot, and its colliders are the only
  // honest answer to "where does built geometry actually meet the ground".
  ctx.afterBoot((services) => {
    const colliders = services.level.collectColliders();
    if (colliders.length > 0) service.paintTransitions(colliders);
  });

  return service;
}

/**
 * Steps 3 and 4 of the bake table: the heightfield (macro → analytic detail →
 * droplet erosion) and the splat / shore / ground-albedo maps derived from it.
 *
 * Deliberately CPU, not GPU. The architecture's sketch was a 2048² GPU
 * ping-pong with one readback for the physics collider, and `allowReadback` is
 * FALSE under the software rasteriser the capture harness runs on — which would
 * leave physics reading a heightfield the GPU never handed back. Doing it on the
 * CPU keeps one array that is simultaneously the mesh source, the collider and
 * the texture, and droplet erosion is cheap enough (about 2 s at 1024²) that the
 * GPU version would buy nothing but a divergence risk.
 */
export function registerTerrainBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  if (bakeKey) return;
  bakeKey = assets.define<TerrainBake>('terrain.field', AssetKind.Data, {
    kind: BakeKind.MainThread,
    version: 3,
    cost: 280,
    async run(ctx) {
      const resolution = Math.min(1024, Math.max(256, ctx.profile.terrainHeightRes));
      ctx.progress(0.02, 'terrain: macro + detail');
      const field = new TerrainField(ctx.noise, ctx.rng.fork('terrain.erosion'), {
        resolution,
        erosionIterations: ctx.profile.erosionIterations,
      });
      await ctx.yieldFrame();
      ctx.progress(0.72, 'terrain: splat + shore');
      const maps = buildMaps(field, ctx.noise, quality.terrain.splatSize);
      await ctx.yieldFrame();
      ctx.progress(1, 'terrain: ready');
      return { field, maps };
    },
    dispose(value) {
      value.maps.heightMap.dispose();
      value.maps.splatMap.dispose();
      value.maps.shoreMask.dispose();
      value.maps.groundAlbedo.dispose();
    },
  });
}

/**
 * Harness reset. The field, the maps and the material are immutable across
 * captures — the only per-capture state is the LOD cut, which is rebuilt from
 * wherever the next shot's camera lands. Forcing it here means a shot can never
 * inherit the previous shot's tessellation.
 */
export function resetTerrain(_seed: number): void {
  live?.forceRebuild(0, 0);
}
