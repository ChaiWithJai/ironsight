/**
 * VegetationService — GPU-instanced scatter, procedural plants, and the one
 * wind field the whole game shares.
 *
 * OWNER: VEG. Entry file: `src/bootstrap/subsystems.ts` imports these three
 * exports by name and by path and is frozen, so their names, signatures and
 * this path do not change.
 *
 * WHAT THIS LANE SHIPS
 * --------------------
 *  - `wind.ts`      one coherent wind field, CPU and GLSL from the same numbers
 *  - `scatter.ts`   slope / altitude / moisture masks + the exclusion field
 *  - `geometry.ts`  the strip and tube primitives every plant is made of
 *  - `plants.ts`    date palm, olive, dry scrub, agave — real branch structure
 *  - `grass.ts`     blade clusters, ground thatch, the distance mat
 *  - `materials.ts` the wind deform chunks and the five vegetation materials
 *  - `field.ts`     instancing, LOD ladders, camera-relative grass tiles
 *
 * THE TWO WARNINGS THIS FILE INHERITED, AND WHAT WAS DONE ABOUT THEM
 * ------------------------------------------------------------------
 * 1. "Anything you animate in a vertex shader MUST go through
 *    `registerDeform()` and MUST expose `IRON_PREV_POSITION`." Done, in
 *    `materials.ts`: four deform chunks, each of whose `prevPosition` is the
 *    same displacement function re-evaluated at last frame's time, written as a
 *    single self-contained GLSL call so it is legal in an expression slot.
 * 2. "Half-res GTAO and SSR handle palm fronds worse than almost anything."
 *    Mitigated by construction: this lane ships NO alpha-tested foliage. Every
 *    leaf is solid geometry, so there is no hashed-alpha edge for a bilateral
 *    upsample to smear and no dithered coverage for TAA to boil.
 */
import * as THREE from 'three';
import {
  RenderStage,
  type AssetRegistry,
  type BootContext,
  type ExclusionHandle,
  type FrameCtx,
  type QualitySettings,
  type RenderSystem,
  type Rng,
  type Services,
  type Vec3,
  type VegetationService,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import { buildPlantLibrary } from '@/world/vegetation/plants';
import { buildGrassAssets } from '@/world/vegetation/grass';
import { createVegetationMaterials, type VegMaterials } from '@/world/vegetation/materials';
import { ExclusionField, VegMasks } from '@/world/vegetation/scatter';
import { VegetationField } from '@/world/vegetation/field';
import { WindField, type WindSample } from '@/world/vegetation/wind';

/**
 * Nominal wind speed the field's own constants are authored against. The
 * weather system's `windSpeed` scales relative to this, so `setWeather` moves
 * flora, smoke and cloth together instead of only the ones that remembered to
 * subscribe.
 */
const NOMINAL_WIND = 4.5;

/** Straight up, for the sky-chromaticity probe. */
const UP = new THREE.Vector3(0, 1, 0);

class IronVegetation implements VegetationService {
  private readonly wind = new WindField();
  private readonly exclusions = new ExclusionField();
  private readonly masks = new VegMasks(MACRO_TERRAIN);
  private readonly materials: VegMaterials;
  private readonly field: VegetationField;
  private readonly services: Services;
  private readonly rng: Rng;
  private readonly sample: WindSample = { x: 0, z: 0, speed: 0 };
  private readonly skyColour = new THREE.Color();
  private initialised = false;

  constructor(ctx: BootContext) {
    this.services = ctx.services;
    this.rng = ctx.rng.fork('vegetation');
    this.materials = createVegetationMaterials(ctx.services.materials);

    const plants = buildPlantLibrary(this.rng.fork('meshes'));
    const grass = buildGrassAssets(this.rng.fork('grass'));
    this.field = new VegetationField(
      ctx.services.scene,
      plants,
      grass,
      this.materials,
      this.masks,
      this.exclusions,
      this.wind,
      ctx.quality.settings,
    );

    let tris = 0;
    for (const p of Object.values(plants)) {
      for (const g of p.foliage) tris += (g.getIndex()?.count ?? 0) / 3;
      for (const g of p.wood) tris += (g.getIndex()?.count ?? 0) / 3;
    }
    ctx.report(`vegetation: 4 species + grass, ${Math.round(tris)} source triangles`);

    ctx.addRender(this.windSystem());
    ctx.addRender(this.instanceSystem());
  }

  /* ------------------------------------------------------------ the contract */

  windAt(position: Vec3, time: number, out: Vec3): Vec3 {
    this.wind.evaluate(position.x, position.z, time, this.sample);
    return out.set(this.sample.x, 0, this.sample.z);
  }

  addExclusion(centre: Vec3, radius: number): ExclusionHandle {
    return this.exclusions.add(centre.x, centre.z, radius) as unknown as ExclusionHandle;
  }

  removeExclusion(handle: ExclusionHandle): void {
    this.exclusions.remove(handle as unknown as number);
  }

  /**
   * Bend a region: an explosion, a footfall, a rotor wash. Modelled as a
   * temporary partial exclusion rather than as a per-instance impulse, because
   * the grass buffer is rebuilt from the tile source and a per-instance state
   * would be thrown away with the next rebuild.
   */
  disturb(position: Vec3, radius: number, strength: number): void {
    const clamped = Math.min(1, Math.max(0, strength));
    this.exclusions.add(
      position.x,
      position.z,
      radius,
      1 - clamped * 0.75,
      this.services.clock.simTime + 1.2 + clamped * 2.5,
    );
    this.field.markDirty();
  }

  scorch(centre: Vec3, radius: number, seconds: number): void {
    this.exclusions.add(centre.x, centre.z, radius, 0, this.services.clock.simTime + seconds);
    this.field.markDirty();
  }

  densityAt(x: number, z: number): number {
    return this.field.densityAt(x, z);
  }

  get stats(): Readonly<{ grass: number; trees: number; impostors: number; drawCalls: number }> {
    return this.field.stats;
  }

  /* ------------------------------------------------------------- reset chain */

  dropTransient(): void {
    // Permanent carve-outs from LEVEL survive; disturbances and scorch marks do
    // not, or a shot captured after an explosion inherits the flattened grass.
    this.exclusions.clearTransient();
    this.field.markDirty();
  }

  /* ---------------------------------------------------------------- systems */

  /**
   * `RenderStage.Animation` — "wind phase", per ARCHITECTURE §3.2. Latches the
   * frame's wind strength ONCE and pushes it into every vegetation material, so
   * the CPU sway computed a few lines later and the GPU deform running at
   * submit read the same number. Sampling the weather independently in two
   * places is how a trunk and its own leaves end up leaning opposite ways.
   */
  private windSystem(): RenderSystem {
    return {
      name: 'vegetation.wind',
      stage: RenderStage.Animation,
      order: 20,
      update: (ctx: FrameCtx): void => {
        this.wind.strength = Math.max(0.15, ctx.services.sky.state.windSpeed / NOMINAL_WIND);
        const factory = ctx.services.materials;
        // THE PHOTOMETRIC HALF OF THE GRASS FIX. The blade chunk needs three
        // things the uber material does not hand it: where the sun is, how much
        // beam it is delivering, and how much sky irradiance an unoccluded
        // upward face is receiving. All three are read from LightingService and
        // SkyService rather than re-derived here, so the grass tracks the time
        // of day and the weather and cannot disagree with any other lit surface
        // in the frame about the state of the sky. See `materials.ts` for what
        // the chunk does with them and why the shared occlusion chain gets these
        // two terms wrong for one-centimetre geometry.
        const lighting = ctx.services.lighting;
        const sun = lighting.sun;
        const lit = sun.illuminanceLux > 1 ? 1 : 0;
        // Chromaticity from the sky's own radiance straight up, magnitude from
        // the lane that owns the photometry. Normalised so the two cannot
        // double-count each other's units.
        ctx.services.sky.radianceTowards(UP, this.skyColour);
        const skyNorm = Math.max(1e-4, (this.skyColour.r + this.skyColour.g + this.skyColour.b) / 3);
        const skyLux = lighting.skyIlluminanceLux;
        for (const [key, cells] of Object.entries(this.materials.cells)) {
          const material = this.materials.material[key as keyof VegMaterials['material']];
          if (cells.strength) {
            factory.setUniform(material, `uVegStrength_${key}`, this.wind.strength);
          }
          if (cells.sun) {
            cells.sun.value.set(sun.direction.x, sun.direction.y, sun.direction.z, lit);
            factory.setUniform(material, `uVegSun_${key}`, cells.sun.value);
          }
          if (cells.sky) {
            cells.sky.value.set(
              (this.skyColour.r / skyNorm) * skyLux,
              (this.skyColour.g / skyNorm) * skyLux,
              (this.skyColour.b / skyNorm) * skyLux,
              0,
            );
            factory.setUniform(material, `uVegSky_${key}`, cells.sky.value);
          }
          if (cells.beam) {
            cells.beam.value.set(
              sun.color.r * sun.illuminanceLux,
              sun.color.g * sun.illuminanceLux,
              sun.color.b * sun.illuminanceLux,
              0,
            );
            factory.setUniform(material, `uVegBeam_${key}`, cells.beam.value);
          }
        }
      },
    };
  }

  /** `RenderStage.Scene` — instance upload and LOD, per ARCHITECTURE §3.2. */
  private instanceSystem(): RenderSystem {
    return {
      name: 'vegetation.instances',
      stage: RenderStage.Scene,
      order: 20,
      update: (ctx: FrameCtx): void => {
        if (!this.initialised) {
          this.initialised = true;
          // Deferred to the first frame on purpose. LEVEL is constructed AFTER
          // us and hands over its exclusion volumes from its own `afterBoot`,
          // which runs after ours; scattering any earlier plants a palm inside
          // every building in the town. TERRAIN's eroded heightfield lands on
          // the same schedule.
          this.masks.useTerrain(ctx.services.terrain);
          this.field.buildTrees(this.rng.fork('scatter'));
          this.field.reconcileWithGraph(ctx.services.graph.passes.length);
        }
        this.field.update(ctx);
      },
    };
  }
}

let instance: IronVegetation | null = null;

/** Factory referenced by `src/bootstrap/subsystems.ts`. */
export function createVegetationService(ctx: BootContext): VegetationService {
  instance = new IronVegetation(ctx);
  return instance;
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 *
 * This lane declares NO bake steps, and that is a deliberate design decision
 * rather than an omission. Step 8 of the bake table budgets 180 units for
 * "vegetation meshes + octahedral impostor atlases"; we spend none of it:
 *
 *  - The meshes are a few hundred kilobytes of tapered strips generated on the
 *    main thread in single-digit milliseconds. Shipping them to a worker and
 *    transferring them back would cost more than building them.
 *  - There are no impostor ATLASES because there are no alpha cards. The far
 *    LOD is reduced geometry, not a baked octahedral sheet, so there is nothing
 *    to render offline. That is a real deviation and it is called out in the
 *    lane report.
 *
 * The 180 units are therefore returned to the ceiling, which under SwiftShader
 * (where the whole bake is 20–60× slower) is worth more than it sounds.
 */
export function registerVegetationBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Intentionally empty — see above.
}

/**
 * Harness reset chain, at the top of EVERY capture.
 *
 * The field itself is NOT regenerated: it is derived from a stateless hash of
 * world position plus `rng.fork('vegetation')`, and forks are rewound by the
 * chain automatically, so the same seed yields the same field by construction.
 * What must go is everything transient — disturbances and scorch marks — and
 * the dirty flag, so the first frame of the next capture rebuilds the instance
 * buffers from a clean field rather than inheriting the last shot's craters.
 */
export function resetVegetation(_seed: number): void {
  instance?.dropTransient();
}
