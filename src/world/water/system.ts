/**
 * WaterService.
 *
 * OWNER: WATER. Day-0 stub: the null water service plus a single flat quad at
 * sea level so the coastline reads and the map has a horizon.
 *
 * WATER: delete `buildPlaceholderSurface`, keep `createWaterService`'s signature
 * and this path.
 *
 * TWO THINGS THAT WILL BITE YOU, WORTH KNOWING BEFORE YOU START
 * -------------------------------------------------------------
 * 1. WATER SPANS TWO LANES. RCORE owns the ORDERING of pass 14
 *    (`PassOrder.ForwardWater`); you own its CONTENT. It is the only forward
 *    pass that writes `GVelocity` — Gerstner displacement genuinely moves the
 *    surface, and without motion vectors TAA smears every golden-hour highlight
 *    into a comet. It also needs `SceneColorCopy` blitted immediately before it
 *    as the refraction source; assuming `SceneColor` is readable in place gives
 *    a failure that looks exactly like a TAA bug.
 * 2. SSR is genuinely unstable on water at grazing angles. Plan to fade to the
 *    IBL cubemap by view angle and roughness rather than pretending it converges.
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
  type WaterService,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import { createNullWater, trackNull } from '@/bootstrap/nulls';

/** Extends well past the playable bounds so the sea meets the sky, not an edge. */
const SEA_EXTENT = 6000;

function buildPlaceholderSurface(scene: SceneGraph, materials: MaterialFactory): void {
  const geometry = new THREE.PlaneGeometry(SEA_EXTENT, SEA_EXTENT, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = materials.create({
    id: 'water.placeholder',
    surface: SurfaceId.Water,
    layer: 0,
    features: MaterialFeature.None,
    // Water is a dielectric with F0 ≈ 0.02 and essentially zero roughness at
    // this scale; the microfacet roughness in a real ocean comes entirely from
    // the displaced normals, which this quad does not have.
    roughness: 0.06,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water(placeholder)';
  mesh.position.y = MACRO_TERRAIN.seaLevel;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.layers.set(RenderLayer.Water as number);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  // Never culled: a single quad centred on the origin whose bounds always
  // intersect the frustum, and re-testing it every frame is pure cost.
  mesh.frustumCulled = false;
  scene.group(SceneGroup.Water).add(mesh);
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * WATER: replace the BODY of this file, keep this signature and this path.
 */
export function createWaterService(ctx: BootContext): WaterService {
  buildPlaceholderSurface(ctx.services.scene, ctx.services.materials);
  return trackNull(createNullWater());
}

/** Spectrum to four 256 displacement + normal cascades, FFT in the worker pool. */
export function registerWaterBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The placeholder surface is a flat lit plane.
}

/**
 * Harness reset chain. The Gerstner phase and the foam accumulation buffer both
 * persist; water also WRITES VELOCITY, so a stale previous displacement smears
 * the first frames of a capture in a way that looks exactly like a TAA bug.
 */
export function resetWater(_seed: number): void {
  // The placeholder surface has no phase.
}
