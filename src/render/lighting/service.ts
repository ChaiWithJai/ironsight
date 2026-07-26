/**
 * LightingService — the sun, the sky ambient, the cascades, the occlusion and
 * the punctual lights, as one photometric rig.
 *
 * OWNER: LIGHT.
 *
 * THE SHAPE OF THE LANE
 * ---------------------
 *   photometry.ts   the numbers: blackbody sun ramp, air-mass DNI, derived exposure
 *   sky-ambient.ts  the two-lobe environment cube + PMREM + SH9
 *   csm.ts          cascade fit, texel snapping, atlas render
 *   gtao.ts         half-res depth/normal + two-radius horizon occlusion
 *   clustered.ts    punctual light pool
 *   shading.ts      the forward lighting model, injected into every lit material
 *
 * ONE DIRECTIONAL LIGHT AND NOTHING ELSE. LOOK_SPEC §2.2 forbids fill and rim
 * lights outright, so the only other emitters in an exterior frame are real
 * ones with real positions, and they all arrive through `addLight`/`flash`.
 * There is deliberately no `AmbientLight` and no `HemisphereLight` in this file:
 * ambient comes from `Scene.environment`, which is an integrated sky.
 *
 * WHERE THE WORK HAPPENS. The rig is a `RenderSystem` at `RenderStage.Scene`,
 * i.e. before `RenderGraph.execute()` at `Submit`. Shadow cascades and the
 * occlusion buffer are produced there, through `RenderGraph.drawScene` and
 * `RenderGraph.fullscreen` so the graph keeps ownership of every render-target
 * binding. This is a deliberate departure from `ARCHITECTURE` §4.2's "register a
 * RenderPass" rule and it is worth stating why: `IronRenderGraph.execute` falls
 * back to a straight forward render **only while `passList` is empty**, so a
 * lane that registers the first pass in the repo silently blackens every other
 * lane's shot. Producing our buffers before the graph runs is correct under both
 * the fallback and the finished pass chain, and costs one extra ordering
 * constraint instead of a repo-wide outage.
 */
import * as THREE from 'three';
import {
  RenderStage,
  SceneGroup,
  type AssetRegistry,
  type BootContext,
  type Color,
  type FrameCtx,
  type LightHandle,
  type LightingService,
  type LocalLight,
  type QualitySettings,
  type QualityService,
  type RenderSystem,
  type Services,
  type SunState,
  type Vec3,
} from '@/engine/types';
import {
  SUN_ANGULAR_RADIUS,
  SUN_PENUMBRA_SLOPE,
  derivedExposure,
  directNormalIlluminance,
  skyDiffuseIlluminance,
  sunColourAtElevation,
} from '@/render/lighting/photometry';
import { ShadowCascades } from '@/render/lighting/csm';
import { Gtao } from '@/render/lighting/gtao';
import { LocalLightPool } from '@/render/lighting/clustered';
import { SkyAmbient } from '@/render/lighting/sky-ambient';
import {
  V_ATLAS,
  V_MISC,
  V_SCREEN,
  V_SUN,
  M_VIEW_INVERSE,
  bindTextures,
  installShadingModel,
  shadingUniforms,
} from '@/render/lighting/shading';

/** Sun movement that forces an environment rebake. `ARCHITECTURE` B6/B7. */
const REBAKE_DEGREES = 0.15;

/**
 * Minimum penumbra, in cascade texels. Below roughly one and a half texels a
 * contact shadow aliases into a staircase, which is more visible than the
 * physically-correct hardness it is trying to preserve.
 */
const MIN_PENUMBRA_TEXELS = 1.5;

class IronLighting implements LightingService {
  private readonly light = new THREE.DirectionalLight(0xffffff, 0);
  private readonly target = new THREE.Object3D();
  private readonly cascades: ShadowCascades;
  private readonly gtao = new Gtao();
  private readonly pool = new LocalLightPool();
  private readonly ambient: SkyAmbient;

  private readonly dir = new THREE.Vector3(0, 1, 0);
  private readonly bakedDir = new THREE.Vector3(0, -1, 0);
  private readonly colour = new THREE.Color(1, 1, 1);
  private readonly viewInverse = new THREE.Matrix4();
  private readonly materials = new Set<THREE.Material>();

  private environmentDirty = true;
  private materialsDirty = 0;

  readonly sunState = {
    direction: new THREE.Vector3(0, 1, 0),
    color: new THREE.Color(1, 1, 1),
    illuminanceLux: 0,
    angularRadius: SUN_ANGULAR_RADIUS,
    elevationDeg: 0,
    azimuthDeg: 0,
  };
  skyIlluminanceLux = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly services: Services,
    quality: QualityService,
  ) {
    installShadingModel(quality.settings);
    this.cascades = new ShadowCascades(quality.settings);
    this.ambient = new SkyAmbient(renderer);

    // `castShadow = false` is not an oversight. Three's shadow map is one map
    // with one fixed-radius PCF kernel; the cascaded PCSS path in `shading.ts`
    // replaces it wholesale, and leaving three's enabled would pay for a second
    // full depth render of the scene every frame to produce a map nothing reads.
    this.light.castShadow = false;
    this.light.target = this.target;
    const group = services.scene.group(SceneGroup.Sky);
    group.add(this.light);
    group.add(this.target);
  }

  /* ------------------------------------------------------ LightingService */

  get sun(): Readonly<SunState> {
    return this.sunState;
  }

  get ambientSH(): Float32Array {
    return this.ambient.sh;
  }

  get environment(): THREE.Texture {
    return this.ambient.environment;
  }

  get cascadeMatrices(): Float32Array {
    return this.cascades.matrices;
  }

  get cascadeSplits(): Float32Array {
    return this.cascades.splits;
  }

  get maxLocalLights(): number {
    return this.pool.maxLights;
  }

  get activeLights(): number {
    return this.pool.activeCount;
  }

  addLight(light: LocalLight): LightHandle {
    return this.pool.add(light);
  }

  updateLight(handle: LightHandle, patch: Partial<LocalLight>): void {
    this.pool.update(handle, patch);
  }

  removeLight(handle: LightHandle): void {
    this.pool.remove(handle);
  }

  flash(position: Vec3, color: Color, intensityCd: number, radius: number, seconds: number): void {
    this.pool.flash(position, color, intensityCd, radius, seconds);
  }

  /* ---------------------------------------------------------------- frame */

  requestRebake(): void {
    this.environmentDirty = true;
  }

  reset(): void {
    this.pool.clear();
    this.environmentDirty = true;
    this.materialsDirty = 0;
    this.materials.clear();
  }

  update(ctx: FrameCtx, quality: Readonly<QualitySettings>): void {
    const sky = this.services.sky;
    const u = shadingUniforms();

    // ---- the sun ------------------------------------------------------------
    sky.sunDirection(this.dir);
    if (this.dir.lengthSq() < 1e-8) this.dir.set(0, 1, 0);
    this.dir.normalize();
    const elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(this.dir.y, -1, 1)));
    const azimuth = THREE.MathUtils.radToDeg(Math.atan2(this.dir.x, this.dir.z));
    const turbidity = Math.max(1.5, sky.state.turbidity);

    // The chromaticity comes from the measured ramp, the magnitude from air
    // mass. Overcast steals from the beam and gives to the dome, which is what
    // makes the HAZE preset a physical state rather than a second colour table.
    const overcast = THREE.MathUtils.clamp(sky.state.overcast, 0, 1);
    const dni = directNormalIlluminance(elevation, turbidity) * (1 - 0.92 * overcast);
    const skyLux = skyDiffuseIlluminance(elevation, turbidity) * (1 + 0.9 * overcast);
    const horizontal = Math.max(0, dni * Math.sin(THREE.MathUtils.degToRad(elevation)));
    const total = horizontal + skyLux;

    sunColourAtElevation(elevation, this.colour);
    this.sunState.direction.copy(this.dir);
    this.sunState.color.copy(this.colour);
    this.sunState.illuminanceLux = dni;
    this.sunState.elevationDeg = elevation;
    this.sunState.azimuthDeg = azimuth;
    this.skyIlluminanceLux = skyLux;

    // Three ≥ r155 shades `E · cosθ · albedo / π` with `intensity` as
    // illuminance, so lux goes in unmodified and the exposure below is the only
    // thing standing between it and the display.
    this.light.color.copy(this.colour);
    this.light.intensity = dni;
    this.light.position.copy(ctx.camera.position).addScaledVector(this.dir, 500);
    this.target.position.copy(ctx.camera.position);
    this.light.updateMatrixWorld(true);
    this.target.updateMatrixWorld(true);
    this.light.visible = dni > 1;

    // ---- exposure, derived (LOOK_SPEC §2.1) ---------------------------------
    // Only while the RENDERER still owns tonemapping. Once RCORE's post chain
    // calls `setTonemapOwnedByGraph`, its Exposure pass is the authority and
    // writing here would be two systems fighting over one float.
    if (this.renderer.toneMapping !== THREE.NoToneMapping) {
      this.renderer.toneMappingExposure = derivedExposure(total);
    }

    // ---- ambient ------------------------------------------------------------
    if (this.environmentDirty || this.bakedDir.angleTo(this.dir) > THREE.MathUtils.degToRad(REBAKE_DEGREES)) {
      this.ambient.rebake(sky, this.dir, this.colour, skyLux, total);
      this.bakedDir.copy(this.dir);
      this.environmentDirty = false;
      this.services.scene.root.environment = this.ambient.environment;
    }
    // Re-assert every frame: another lane clearing `Scene.environment` would
    // otherwise silently take every shadowed face back to black, which is
    // exactly the wave-1 defect this lane exists to fix.
    if (this.services.scene.root.environment !== this.ambient.environment) {
      this.services.scene.root.environment = this.ambient.environment;
    }

    // ---- shared uniform block ----------------------------------------------
    this.viewInverse.copy(ctx.camera.world.matrixWorld);
    this.viewInverse.toArray(u.matrices, M_VIEW_INVERSE * 16);

    u.vectors[V_SUN * 4] = this.dir.x;
    u.vectors[V_SUN * 4 + 1] = this.dir.y;
    u.vectors[V_SUN * 4 + 2] = this.dir.z;
    u.vectors[V_SUN * 4 + 3] = this.light.visible ? 1 : 0;

    u.vectors[V_ATLAS * 4] = this.cascades.atlasSize;
    u.vectors[V_ATLAS * 4 + 1] = 1 / this.cascades.atlasSize;
    u.vectors[V_ATLAS * 4 + 2] = SUN_PENUMBRA_SLOPE;
    u.vectors[V_ATLAS * 4 + 3] = MIN_PENUMBRA_TEXELS;

    const graph = this.services.graph;
    u.vectors[V_SCREEN * 4] = 1 / Math.max(1, graph.width);
    u.vectors[V_SCREEN * 4 + 1] = 1 / Math.max(1, graph.height);
    u.vectors[V_SCREEN * 4 + 2] = quality.gtao.enabled ? 1 : 0;
    u.vectors[V_SCREEN * 4 + 3] = Math.min(4, quality.shadows.cascadeCount);

    u.vectors[V_MISC * 4 + 1] = 0.7; // how much of the short-radius AO to add on top
    u.vectors[V_MISC * 4 + 2] = quality.shadows.maxDistance * 0.82; // cascade fade start

    // ---- buffers ------------------------------------------------------------
    this.pool.tick(ctx);
    if (this.light.visible) {
      this.cascades.update(ctx, graph, this.services.scene, this.renderer, this.dir, quality);
    }
    if (quality.gtao.enabled) {
      this.gtao.update(ctx, graph, this.services.scene, this.renderer, quality);
    }

    // ---- samplers -----------------------------------------------------------
    // Rescanning the scene every frame would cost more than the bind itself, and
    // materials appear in bursts (a lane's first draw, a destruction event), so
    // rescan on a short cadence and bind every frame.
    if (this.materialsDirty <= 0) {
      this.collectMaterials();
      this.materialsDirty = 12;
    }
    this.materialsDirty--;
    bindTextures(
      this.renderer,
      this.materials,
      this.light.visible ? this.cascades.texture : null,
      quality.gtao.enabled ? this.gtao.texture : null,
    );
  }

  private collectMaterials(): void {
    this.materials.clear();
    this.services.scene.root.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      if (Array.isArray(material)) for (const m of material) this.materials.add(m);
      else this.materials.add(material);
    });
  }

  dispose(): void {
    this.cascades.dispose();
    this.gtao.dispose();
    this.ambient.dispose();
  }
}

class LightingRig implements RenderSystem {
  readonly name = 'lighting.rig';
  readonly stage = RenderStage.Scene;
  /**
   * Early in `Scene`, because the shadow atlas and the occlusion buffer must be
   * finished before anything else in the stage decides what it can see, and long
   * before `Submit`.
   */
  readonly order = 5;

  constructor(
    private readonly lighting: IronLighting,
    private readonly quality: QualityService,
  ) {}

  update(ctx: FrameCtx): void {
    this.lighting.update(ctx, this.quality.settings);
  }
}

let instance: IronLighting | null = null;

/** Factory referenced by `src/bootstrap/subsystems.ts`. */
export function createLightingService(ctx: BootContext): LightingService {
  const lighting = new IronLighting(ctx.renderer, ctx.services, ctx.quality);
  instance = lighting;
  ctx.addRender(new LightingRig(lighting, ctx.quality));
  return lighting;
}

/**
 * PCSS kernels are generated in the shader (a Vogel disc rotated by interleaved
 * gradient noise), so there is no blocker LUT to bake. The environment cube is
 * built from `SkyService` at run time and rebaked whenever the sun moves, which
 * is a per-frame decision rather than a boot-time asset.
 */
export function registerLightingBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Nothing to declare: this lane's only baked product is the environment cube,
  // and it depends on SkyService state that does not exist at bake time.
}

/**
 * Harness reset chain. Muzzle flashes from the previous capture must not survive
 * into this one, and the environment must be rebuilt because the shot's
 * `setTimeOfDay` runs before the first frame.
 */
export function resetLighting(_seed: number): void {
  instance?.reset();
}
