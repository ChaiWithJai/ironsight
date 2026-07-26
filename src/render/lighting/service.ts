/**
 * LightingService.
 *
 * OWNER: LIGHT. This is the day-0 stub: it returns the null lighting service
 * from `src/bootstrap/nulls.ts` and, so that every other lane can see its own
 * work before the real shadow path exists, drives one `THREE.DirectionalLight`
 * (with a texel-snapped shadow camera) and one hemisphere fill from the sky
 * service's sun direction.
 *
 * LIGHT: delete `PlaceholderSunRig` entirely, keep `createLightingService`'s
 * signature and this path. Everything below the null delegation is scaffolding.
 *
 * The one piece worth keeping in mind when you replace it: golden hour is the
 * WORST case for cascaded shadows. A sun 6–10° up makes the frustum extremely
 * oblique, texel density collapses along the light direction, and the bias a
 * raking sandstone wall needs will peter-pan the contact shadow under a crate.
 * The snapping below is the minimum viable version of the fix — snap the light
 * target to a WORLD-SPACE texel grid so the shadow does not crawl when the
 * camera moves. Do not lose that when you switch to cascades.
 */
import * as THREE from 'three';
import {
  RenderStage,
  SceneGroup,
  type AssetRegistry,
  type BootContext,
  type FrameCtx,
  type LightingService,
  type QualitySettings,
  type QualityService,
  type RenderSystem,
  type SceneGraph,
  type Services,
} from '@/engine/types';
import { createNullLighting, trackNull } from '@/bootstrap/nulls';

/** Metres of the world covered by the single day-0 shadow cascade. */
const SHADOW_EXTENT = 90;
const SHADOW_MAP_SIZE = 2048;

class PlaceholderSunRig implements RenderSystem {
  readonly name = 'lighting.placeholderSun';
  readonly stage = RenderStage.Scene;
  readonly order = 5;

  private readonly sun = new THREE.DirectionalLight(0xffd9a8, 3.4);
  private readonly fill = new THREE.HemisphereLight(0x9dc0e0, 0x5a4a34, 0.55);
  private readonly target = new THREE.Object3D();
  private readonly dir = new THREE.Vector3();
  private readonly colour = new THREE.Color();

  constructor(
    scene: SceneGraph,
    private readonly services: Services,
    private readonly lighting: ReturnType<typeof createNullLighting>,
    quality: QualityService,
  ) {
    const group = scene.group(SceneGroup.Sky);
    this.sun.castShadow = true;
    const size = Math.min(SHADOW_MAP_SIZE, quality.settings.shadows.tileSizes[0]);
    this.sun.shadow.mapSize.set(size, size);
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = SHADOW_EXTENT * 6;
    // Slope-scaled bias: a constant bias that hides acne on a floor peter-pans
    // a wall, and at golden hour almost every lit surface is a raking wall.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;
    this.sun.target = this.target;
    group.add(this.sun);
    group.add(this.target);
    group.add(this.fill);
  }

  update(ctx: FrameCtx): void {
    const sky = this.services.sky;
    sky.sunDirection(this.dir);
    sky.sunRadiance(this.colour);

    // Illuminance → a three intensity. Three's DirectionalLight is not
    // photometric, so this is a perceptual mapping, not a conversion: 18 klx
    // (the golden-hour anchor) should land near 3.4 with AgX tonemapping.
    const elevation = Math.max(0, this.dir.y);
    const lux = 25_000 * Math.pow(elevation, 0.55);
    this.lighting.setSun(this.dir, this.colour, lux);
    this.sun.color.copy(this.colour);
    this.sun.intensity = 0.35 + 3.2 * Math.pow(elevation, 0.5);
    this.fill.intensity = 0.25 + 0.5 * Math.pow(elevation, 0.35);
    // Sky fill cools as the sun drops; the brief's colour language is warm
    // sandstone against desaturated teal shadow, and this is where the teal
    // comes from before real SH ambient exists.
    this.fill.color.setRGB(0.42 + elevation * 0.2, 0.56 + elevation * 0.18, 0.82);

    // Follow the camera, snapped to a WORLD-SPACE texel grid. Without the snap
    // the whole shadow map resamples every frame and the entire scene crawls.
    const texelWorld = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
    const cam = ctx.camera.position;
    const snapX = Math.round(cam.x / texelWorld) * texelWorld;
    const snapZ = Math.round(cam.z / texelWorld) * texelWorld;
    const snapY = Math.round(cam.y / texelWorld) * texelWorld;
    this.target.position.set(snapX, snapY, snapZ);
    this.target.updateMatrixWorld(true);
    this.sun.position.set(
      snapX + this.dir.x * SHADOW_EXTENT * 3,
      snapY + this.dir.y * SHADOW_EXTENT * 3,
      snapZ + this.dir.z * SHADOW_EXTENT * 3,
    );
    this.sun.updateMatrixWorld(true);
  }
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * LIGHT: replace the BODY of this file, keep this signature and this path.
 */
export function createLightingService(ctx: BootContext): LightingService {
  const lighting = trackNull(createNullLighting());
  ctx.addRender(new PlaceholderSunRig(ctx.services.scene, ctx.services, lighting, ctx.quality));
  return lighting;
}

/** The PCSS blocker kernel and any static shadow-noise textures land here. */
export function registerLightingBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The placeholder sun rig bakes nothing.
}

/**
 * Harness reset chain. GTAO, SSR and volumetrics all keep temporal history, and
 * `flash()` lights from the previous capture must not survive into this one.
 */
export function resetLighting(_seed: number): void {
  // The placeholder sun rig holds no transient state.
}
