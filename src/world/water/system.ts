/**
 * WaterService — the sea of HARBOUR REACH.
 *
 * OWNER: WATER.
 *
 * WHAT IS HERE
 *   spectrum.ts     a Gerstner hierarchy from a Phillips spectrum, three bands
 *   seabed.ts       the depth field the shoreline, absorption and shoaling read
 *   ocean-mesh.ts   a camera-centred radial grid, 40 cm under the eye to 8 km
 *   glsl.ts         displacement with analytic derivatives; Fresnel-weighted
 *                   reflection against refraction; Beer-Lambert transmission to
 *                   a lit seabed; sun glitter with the sun's real solid angle;
 *                   foam from four physical sources; aerial perspective
 *   passes.ts       the SceneColorCopy blit, the MRT forward draw, underwater
 *   this file       the service, the per-frame update, and the wiring
 *
 * TWO THINGS THAT BIT, AND HOW THEY ARE HANDLED
 *
 * 1. WATER SPANS TWO LANES. RCORE owns the ordering of pass 14 and this lane
 *    owns its content — but the day-0 `RenderGraph` also has a fallback that
 *    forward-renders the whole scene ONLY WHILE NO PASS IS REGISTERED. A lane
 *    that registers a pass into an otherwise empty graph silently turns off
 *    every other lane's rendering. So the passes here are registered if and only
 *    if RCORE's forward pipeline is genuinely live, probed with
 *    `graph.has(RTId.SceneColor)` inside `afterBoot`. When it is not, the water
 *    still draws — `RenderLayer.Water` is in the fallback's layer set — it just
 *    reflects the sky probe instead of the screen and writes no velocity.
 *
 * 2. SSR IS UNSTABLE ON WATER AT GRAZING ANGLES, and pretending otherwise is
 *    how you get a smeared band along the horizon that looks worse than no
 *    reflection at all. Both screen-space paths here fade to the analytic sky by
 *    confidence, by roughness and by screen border, and the fade is deliberately
 *    early.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeKind,
  RTId,
  RenderLayer,
  QualityTier,
  RenderStage,
  SceneGroup,
  SurfaceId,
  type AnyAssetKey,
  type AssetKey,
  type AssetRegistry,
  type BootContext,
  type FrameCtx,
  type GpuUniform,
  type MaterialFactory,
  type QualitySettings,
  type RenderSystem,
  type Rng,
  type SceneGraph,
  type Services,
  type Vec3,
  type WaterService,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import {
  DISPLACING_COUNT,
  WAVE_COUNT,
  buildWaveTable,
  sampleWaveHeight,
  sampleWaveNormal,
  type WaveTable,
} from '@/world/water/spectrum';
import { bakeSeabedField, type SeabedField } from '@/world/water/seabed';
import { OCEAN_GRID, buildOceanGrid } from '@/world/water/ocean-mesh';
import { waterFragmentShader, waterVertexShader, type WaterShaderConfig } from '@/world/water/glsl';
import { ForwardWaterPass, SceneColorCopyPass, UnderwaterPass } from '@/world/water/passes';

/** Concurrent splash rings. Six is more than a frame ever shows. */
const MAX_RINGS = 6;

/**
 * Significant wave height for HARBOUR REACH, metres.
 *
 * 0.82 m is a working Mediterranean harbour on a breezy afternoon: a long heave
 * under the freighter, chop with visible crests, and surf on the beach that is
 * knee-high rather than picturesque. The local 4.5 m/s breeze alone would give
 * about 0.1 m, which is a puddle; the swell arrives from the open water west of
 * the headland and has nothing to do with today's wind.
 */
const SIGNIFICANT_HEIGHT = 0.82;
/** Peak of `ironWaterSwash`, which is the shoreline sheet rising and falling. */
const SWASH_AMPLITUDE = 0.46;
/** Ceiling of `ironWaterShoal` — Green's-law gain as a swell feels the bottom. */
const SHOAL_MAX_GAIN = 1.9;

/**
 * LOOK_SPEC §2.1: `toneMappingExposure = 0.18 / L_grey`, L_grey = 957 cd/m² for
 * the GOLDEN preset. This lane emits photometric radiance and converts ONCE,
 * here, and the conversion is derived rather than dialled — see
 * `radianceScale()`.
 */
const GOLDEN_EXPOSURE = 1.88e-4;

/**
 * LOOK_SPEC §2.2's sun colour curve, as (elevation°, linear RGB max-normalised).
 * Interpolated rather than hard-coded at 11° so the HAZE preset and any
 * time-of-day a shot asks for stay on the same blackbody line.
 */
const SUN_TINT: readonly (readonly [number, number, number, number])[] = [
  [5, 1.0, 0.62, 0.36],
  [11, 1.0, 0.712, 0.478],
  [16, 1.0, 0.81, 0.66],
  [25, 1.0, 0.9, 0.83],
  [45, 1.0, 0.956, 0.925],
];

/**
 * Direct normal illuminance against solar elevation, as Beer's law through the
 * air mass: `E = E0·exp(-τ/sin θ)`.
 *
 * τ and E0 are not free parameters — they are the unique pair that puts the
 * curve through both of LOOK_SPEC §1's anchors, 48 000 lx at 11° and 92 000 lx
 * at 42°. That is what makes a shot at 16.9 h and a shot at 17.4 h consistent
 * with each other instead of two separately-tuned looks.
 */
const DNI_E0 = 119_230;
const DNI_TAU = 0.1735;

function sunIlluminance(sinElevation: number): number {
  if (sinElevation <= 0.001) return 0;
  return DNI_E0 * Math.exp(-DNI_TAU / Math.max(sinElevation, 0.045));
}

function sunTint(elevationDeg: number, out: THREE.Vector3): void {
  let i = 0;
  while (i < SUN_TINT.length - 2 && elevationDeg > SUN_TINT[i + 1][0]) i++;
  const a = SUN_TINT[i];
  const b = SUN_TINT[i + 1];
  const t = THREE.MathUtils.clamp((elevationDeg - a[0]) / (b[0] - a[0]), 0, 1);
  out.set(a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t);
}

/** Shoaling gain, the CPU twin of `ironWaterShoal`. */
function shoalFactor(depth: number): number {
  const damp = THREE.MathUtils.smoothstep(depth, 0, 0.55);
  const gain = 1 + 0.9 * (1 - THREE.MathUtils.smoothstep(depth, 1, 12));
  return damp * gain;
}


let seabedKey: AssetKey<SeabedField> | null = null;
let instance: IronWater | null = null;

class IronWater implements WaterService {
  readonly seaLevel = MACRO_TERRAIN.seaLevel;

  private readonly services: Services;
  private readonly rng: Rng;
  private readonly rngState: Uint32Array;
  private readonly field: SeabedField;
  private readonly quality: Readonly<QualitySettings>;
  private readonly materials: MaterialFactory;
  private readonly scene: SceneGraph;
  private material: THREE.Material | null = null;
  private mesh: THREE.Mesh | null = null;

  private table: WaveTable;
  private tableWind = Number.NaN;
  private tableSpeed = Number.NaN;

  private time = 0;
  private prevTime = 0;
  private submerged = false;
  private forcedUnderwater = false;
  private eyeDepth = 0;
  private ringWrite = 0;
  private readonly ringData = new Float32Array(MAX_RINGS * 4);
  private readonly underwaterTint = new THREE.Vector3();
  private readonly scratchNormal = { x: 0, y: 1, z: 0 };

  /* ------------------------------------------------------------- uniforms */
  private readonly uWaterWaveA: GpuUniform<Float32Array>;
  private readonly uWaterWaveB: GpuUniform<Float32Array>;
  private readonly uWaterRings: GpuUniform<Float32Array> = { value: this.ringData };
  private readonly uWaterRingCount: GpuUniform<number> = { value: 0 };
  private readonly uWaterTime: GpuUniform<number> = { value: 0 };
  private readonly uWaterPrevTime: GpuUniform<number> = { value: 0 };
  private readonly uWaterSeaLevel: GpuUniform<number> = { value: MACRO_TERRAIN.seaLevel };
  private readonly uWaterOrigin: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3() };
  private readonly uWaterSeabed: GpuUniform<THREE.Texture>;
  private readonly uWaterFieldOrigin: GpuUniform<THREE.Vector2>;
  private readonly uWaterFieldSize: GpuUniform<THREE.Vector2>;
  private readonly uWaterFieldInvSize: GpuUniform<THREE.Vector2>;
  private readonly uWaterSunDir: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 1, 0) };
  private readonly uWaterSunIlluminance: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3() };
  private readonly uWaterSkyIlluminance: GpuUniform<number> = { value: 7500 };
  private readonly uWaterRadianceScale: GpuUniform<number> = { value: GOLDEN_EXPOSURE };
  private readonly uWaterVarianceLutA: GpuUniform<THREE.Vector2> = { value: new THREE.Vector2() };
  private readonly uWaterVarianceLutB: GpuUniform<THREE.Vector2> = { value: new THREE.Vector2() };
  private readonly uWaterVarianceLutC: GpuUniform<THREE.Vector4> = { value: new THREE.Vector4() };
  private readonly uWaterPixelAngle: GpuUniform<number> = { value: 0.001 };
  private readonly uWaterSandAlbedo: GpuUniform<THREE.Texture>;
  private readonly uWaterSandTiling: GpuUniform<number>;
  private readonly uWaterShoreMask: GpuUniform<THREE.Texture>;
  private readonly uWaterShoreRect: GpuUniform<THREE.Vector4> = { value: new THREE.Vector4(0, 0, 1, 1) };
  private readonly uWaterShoreDecode: GpuUniform<THREE.Vector2> = { value: new THREE.Vector2(120, 0) };
  private readonly uWaterViewProjection: GpuUniform<THREE.Matrix4> = { value: new THREE.Matrix4() };
  private readonly uWaterPrevViewProjection: GpuUniform<THREE.Matrix4> = { value: new THREE.Matrix4() };
  private readonly uWaterResolution: GpuUniform<THREE.Vector2> = { value: new THREE.Vector2(1920, 1080) };
  private readonly uWaterSceneColor: GpuUniform<THREE.Texture | null> = { value: null };
  private readonly uWaterSceneDepth: GpuUniform<THREE.Texture | null> = { value: null };
  private readonly uWaterDepthPlanes: GpuUniform<THREE.Vector2> = { value: new THREE.Vector2(0.1, 1200) };
  private readonly uWaterSsr: GpuUniform<THREE.Texture | null> = { value: null };

  private config: WaterShaderConfig = {
    mrt: false,
    refraction: false,
    ssrTexture: false,
    selfTonemap: true,
    maxRings: MAX_RINGS,
  };

  constructor(ctx: BootContext) {
    this.services = ctx.services;
    this.rng = ctx.rng.fork('water.spectrum');
    // Snapshotted at construction and restored before every rebuild, so the sea
    // is identical on every capture no matter how many times the wind changed on
    // the way there.
    this.rngState = this.rng.saveState();

    const cached = seabedKey ? ctx.assets.tryGet(seabedKey) : undefined;
    this.field = cached ?? bakeSeabedField();

    this.uWaterSeabed = { value: this.field.texture };
    const origin = -this.field.halfExtent;
    const size = this.field.halfExtent * 2;
    this.uWaterFieldOrigin = { value: new THREE.Vector2(origin, origin) };
    this.uWaterFieldSize = { value: new THREE.Vector2(size, size) };
    this.uWaterFieldInvSize = { value: new THREE.Vector2(1 / size, 1 / size) };

    const sand = ctx.services.materials.textures(SurfaceId.Sand);
    this.uWaterSandAlbedo = { value: sand.albedoHeight };
    this.uWaterSandTiling = { value: sand.tiling };
    this.uWaterShoreMask = { value: ctx.services.terrain.shoreMask };

    this.table = buildWaveTable(this.rng, 2.15, 4.5, SIGNIFICANT_HEIGHT);
    this.uWaterWaveA = { value: this.table.a };
    this.uWaterWaveB = { value: this.table.b };
    this.pushVarianceLut();

    this.quality = ctx.quality.settings;
    this.materials = ctx.services.materials;
    this.scene = ctx.services.scene;
    ctx.addRender(new WaterAnimationSystem(this));
    // EVERYTHING THAT DEPENDS ON THE GRAPH IS DEFERRED TO `afterBoot`, including
    // the material. The shader's feature defines are compile-time, and asking
    // `graph.has()` from a constructor asks it before the lane that writes those
    // resources has necessarily registered its passes — construction order puts
    // RCORE first today, but `dependsOn` does not say so and the topological sort
    // only guarantees declared edges. `afterBoot` runs after every subsystem
    // exists and before `validate()`, which is exactly the window this needs.
    ctx.afterBoot((services) => this.build(services));
  }

  /** Builds the material, the mesh and the passes. Runs once, in `afterBoot`. */
  private build(services: Services): void {
    const graph = services.graph;
    // BOTH halves, and the second one is the important one. `SceneColor` existing
    // says a forward pass writes somewhere; `LdrColor` existing says the post
    // chain is complete enough that what is in `SceneColor` is a finished, exposed
    // image. Screen-space refraction and SSR read that buffer as if it were the
    // world, so with only half the chain up they read a half-drawn frame and paint
    // it onto the sea. The analytic seabed and the sky probe are always right.
    const pipelineLive = graph.has(RTId.SceneColor) && graph.has(RTId.LdrColor);
    this.config = {
      // MRT IS OFF, AND THIS IS NOT A CAPABILITY DECISION — it is a depth one.
      //
      // `graph.mrtTarget([SceneColor, GVelocity])` hands back a framebuffer whose
      // DEPTH attachment is not the one the depth prepass and the forward opaque
      // pass filled. Measured: with the MRT path the ocean loses ~32 % of its
      // fragments to a depth test against that attachment's stale contents, in
      // broad ragged bands that follow where the wave field was on EARLIER FRAMES
      // — which is exactly what "the water reads as a flat pale sheet with no wave
      // detail" turned out to be, because a third of the wave detail was being
      // discarded before it shaded. Bands vanish and coverage goes to 100 % the
      // moment the pass writes through `graph.target(SceneColor)` instead.
      //
      // What it costs: `GVelocity` for the sea is then whatever the depth prepass
      // wrote for `RenderLayer.Water`, which is the still-water plane under the
      // camera's own motion — so TAA sees the sea translate correctly with the
      // player but does not see the crests move through it. `scene.ts` already
      // documents that approximation for its own pass. The trade is one frame of
      // TAA lag on a moving crest against a third of the ocean, and it is not
      // close.
      //
      // Restore this to `pipelineLive && graph.has(RTId.GVelocity)` the day the
      // MRT target shares the scene depth buffer.
      mrt: false,
      refraction: pipelineLive && graph.has(RTId.SceneDepth),
      ssrTexture: pipelineLive && graph.has(RTId.SsrColor),
      selfTonemap: !graph.has(RTId.LdrColor),
      maxRings: MAX_RINGS,
    };

    this.material = this.materials.createUnlit({
      id: 'water.ocean',
      vertexShader: waterVertexShader(this.config),
      fragmentShader: waterFragmentShader(this.config),
      uniforms: this.uniformRecord(),
      defines: {
        ...(this.config.mrt ? { IRON_WATER_MRT: 1 } : {}),
        ...(this.config.refraction ? { IRON_WATER_REFRACTION: 1 } : {}),
        ...(this.config.ssrTexture ? { IRON_WATER_SSR_TEXTURE: 1 } : {}),
        ...(this.config.selfTonemap ? { IRON_WATER_SELF_TONEMAP: 1 } : {}),
      },
      side: 'double',
      depthTest: true,
      // Opaque and depth-writing. The sea is not a transparency: everything the
      // eye receives through it — the seabed, the body colour, whatever the
      // refraction ray found — is integrated in the shader, in the right units,
      // with the right extinction. Blending would hand that integral to the
      // hardware, which cannot do Beer-Lambert, and would then need a sort.
      transparent: false,
      depthWrite: true,
      // Drawn into an HDR scene target: same rule as the sky dome, or the sea and
      // the sky next to it land in different colour spaces.
      toneMapped: true,
    });

    const geometry = buildOceanGrid(
      this.quality.tier >= QualityTier.High ? OCEAN_GRID.high : OCEAN_GRID.low,
      this.prepassDepthFloor(),
    );
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'water.ocean';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // The vertex shader builds world space from `uWaterOrigin`, not from the
    // model matrix — the grid follows the camera while the WAVES stay in world
    // space, and folding the follow into the matrix would put the camera's own
    // motion into the water's velocity.
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    this.scene.group(SceneGroup.Water).add(mesh);
    this.scene.addDynamic(mesh, RenderLayer.Water);
    this.mesh = mesh;

    this.registerPasses(services);
  }

  /**
   * How far below still water the depth prepass's proxy plane has to sit — see
   * the long note in `ocean-mesh.ts` for why there is one at all.
   *
   * This is the WORST-CASE TROUGH, not a margin someone liked the look of. A
   * Gerstner sum is deepest when every component's sine lines up at -1 at once,
   * which is the sum of the amplitudes; shoaling multiplies that by up to 1.9 as
   * the swell feels the bottom, and the swash sheet rides on top of the same
   * gain. Anything shallower than this number culls the deepest troughs; anything
   * deeper than it costs `SceneDepth` accuracy over open water for nothing.
   *
   * `buildWaveTable` renormalises to a fixed significant height whatever the wind
   * is doing, so this is stable across a `syncSpectrum` and the geometry never
   * needs rebuilding.
   */
  private prepassDepthFloor(): number {
    let amplitudeSum = 0;
    for (let i = 0; i < DISPLACING_COUNT; i++) amplitudeSum += Math.abs(this.table.b[i * 4]);
    return (amplitudeSum + SWASH_AMPLITUDE) * SHOAL_MAX_GAIN;
  }

  private uniformRecord(): Record<string, GpuUniform> {
    const u: Record<string, GpuUniform> = {
      uWaterWaveA: this.uWaterWaveA as GpuUniform,
      uWaterWaveB: this.uWaterWaveB as GpuUniform,
      uWaterRings: this.uWaterRings as GpuUniform,
      uWaterRingCount: this.uWaterRingCount as GpuUniform,
      uWaterTime: this.uWaterTime as GpuUniform,
      uWaterPrevTime: this.uWaterPrevTime as GpuUniform,
      uWaterSeaLevel: this.uWaterSeaLevel as GpuUniform,
      uWaterOrigin: this.uWaterOrigin as GpuUniform,
      uWaterSeabed: this.uWaterSeabed as GpuUniform,
      uWaterFieldOrigin: this.uWaterFieldOrigin as GpuUniform,
      uWaterFieldSize: this.uWaterFieldSize as GpuUniform,
      uWaterFieldInvSize: this.uWaterFieldInvSize as GpuUniform,
      uWaterSunDir: this.uWaterSunDir as GpuUniform,
      uWaterSunIlluminance: this.uWaterSunIlluminance as GpuUniform,
      uWaterSkyIlluminance: this.uWaterSkyIlluminance as GpuUniform,
      uWaterRadianceScale: this.uWaterRadianceScale as GpuUniform,
      uWaterVarianceLutA: this.uWaterVarianceLutA as GpuUniform,
      uWaterVarianceLutB: this.uWaterVarianceLutB as GpuUniform,
      uWaterVarianceLutC: this.uWaterVarianceLutC as GpuUniform,
      uWaterPixelAngle: this.uWaterPixelAngle as GpuUniform,
      uWaterSandAlbedo: this.uWaterSandAlbedo as GpuUniform,
      uWaterSandTiling: this.uWaterSandTiling as GpuUniform,
      uWaterShoreMask: this.uWaterShoreMask as GpuUniform,
      uWaterShoreRect: this.uWaterShoreRect as GpuUniform,
      uWaterShoreDecode: this.uWaterShoreDecode as GpuUniform,
      uWaterViewProjection: this.uWaterViewProjection as GpuUniform,
      uWaterPrevViewProjection: this.uWaterPrevViewProjection as GpuUniform,
      uWaterResolution: this.uWaterResolution as GpuUniform,
    };
    if (this.config.refraction) {
      u.uWaterSceneColor = this.uWaterSceneColor as GpuUniform;
      u.uWaterSceneDepth = this.uWaterSceneDepth as GpuUniform;
      u.uWaterDepthPlanes = this.uWaterDepthPlanes as GpuUniform;
    }
    if (this.config.ssrTexture) u.uWaterSsr = this.uWaterSsr as GpuUniform;
    return u;
  }

  private registerPasses(services: Services): void {
    const graph = services.graph;
    // See the header: registering a pass into an empty graph disables the day-0
    // fallback for EVERY lane. Only touch the graph when the real pipeline is up.
    if (!graph.has(RTId.SceneColor)) return;

    if (this.config.refraction) graph.addPass(new SceneColorCopyPass());

    const reads: (RTId | string)[] = [RTId.SceneColor];
    if (this.config.refraction) reads.push(RTId.SceneColorCopy, RTId.SceneDepth);
    if (this.config.ssrTexture) reads.push(RTId.SsrColor);
    graph.addPass(
      new ForwardWaterPass(this.config.mrt, reads, (w, h) => this.uWaterResolution.value.set(w, h)),
    );

    if (graph.has(RTId.ResolvedColor) && graph.has(RTId.SceneDepth)) {
      graph.addPass(
        new UnderwaterPass(() => ({
          submerged: this.submerged,
          eyeDepth: this.eyeDepth,
          tint: this.underwaterTint,
          murk: 1.35,
        })),
      );
    }
  }

  private pushVarianceLut(): void {
    const v = this.table.varianceLut;
    this.uWaterVarianceLutA.value.set(v[0], v[1]);
    this.uWaterVarianceLutB.value.set(v[2], v[3]);
    this.uWaterVarianceLutC.value.set(v[4], v[5], v[6], v[7]);
  }

  /**
   * Rebuild the spectrum when the wind genuinely changes. The wave DIRECTIONS
   * are baked into the table, so this is not something to do per frame — the
   * phase would jump — but a shot that asks for a different weather state must
   * get a sea running the right way.
   */
  private syncSpectrum(): void {
    const sky = this.services.sky.state;
    if (
      Math.abs(sky.windDirectionRad - this.tableWind) < 0.02 &&
      Math.abs(sky.windSpeed - this.tableSpeed) < 0.25
    ) {
      return;
    }
    this.tableWind = sky.windDirectionRad;
    this.tableSpeed = sky.windSpeed;
    this.rng.loadState(this.rngState);
    this.table = buildWaveTable(this.rng, sky.windDirectionRad, sky.windSpeed, SIGNIFICANT_HEIGHT);
    this.uWaterWaveA.value = this.table.a;
    this.uWaterWaveB.value = this.table.b;
    this.pushVarianceLut();
  }

  /**
   * Photometric radiance → whatever the frame's working space happens to be.
   *
   * DERIVED, NOT DIALLED, and the derivation is asked EVERY FRAME because the
   * answer changes the moment the post chain lands under us.
   *
   * The question is only ever "will anything downstream expose what I write?",
   * and the honest test for that is whether an enabled pass writes `LdrColor` —
   * i.e. whether `post.tonemap` exists. `renderer.toneMapping` is NOT that test:
   * `setTonemapOwnedByGraph` flips it to `NoToneMapping` as soon as the tonemap
   * pass is CONSTRUCTED, which during integration is a window in which nobody at
   * all is exposing the frame. In that window a photometric surface writes
   * thousands of cd/m² at an 8-bit buffer and the sea comes out pure white.
   *
   * Otherwise: LOOK_SPEC §2.1's `0.18 / L_grey`, divided back out by whatever
   * exposure the renderer is already applying itself.
   */
  private radianceScale(): number {
    if (this.services.graph.has(RTId.LdrColor)) return 1;
    const renderer = this.services.renderer.renderer;
    return GOLDEN_EXPOSURE / Math.max(renderer.toneMappingExposure, 1e-6);
  }

  update(ctx: FrameCtx): void {
    if (!this.mesh) return;
    this.syncSpectrum();

    this.prevTime = this.time;
    this.time = ctx.time;
    this.uWaterTime.value = this.time;
    this.uWaterPrevTime.value = this.prevTime;

    // The grid follows the eye; the waves do not.
    this.uWaterOrigin.value.set(ctx.camera.position.x, this.seaLevel, ctx.camera.position.z);

    /* --- sun and sky, in photometric units, from LOOK_SPEC §2.2 ---------- */
    const sunDir = this.uWaterSunDir.value;
    this.services.sky.sunDirection(sunDir);
    const sinElevation = THREE.MathUtils.clamp(sunDir.y, -1, 1);
    const elevationDeg = Math.asin(sinElevation) * THREE.MathUtils.RAD2DEG;
    const tint = this.uWaterSunIlluminance.value;
    sunTint(elevationDeg, tint);
    // Normalise by the tint's own luminance so "48 000 lx" stays 48 000 lx of
    // LUMINOUS flux however warm the sun has gone. Without this the golden-hour
    // sun is quietly two thirds as bright as the spec says it is.
    const tintLuma = Math.max(0.2126 * tint.x + 0.7152 * tint.y + 0.0722 * tint.z, 1e-3);
    tint.multiplyScalar(sunIlluminance(sinElevation) / tintLuma);
    // Sky diffuse on a horizontal surface. 7 500 lx at 11° is the GOLDEN anchor;
    // the exponent is the shallow elevation dependence a scattering integral has
    // once the sun is low — the dome stays lit well after the direct beam dies.
    const skyRef = Math.max(sinElevation, 0.02) / Math.sin(11 * THREE.MathUtils.DEG2RAD);
    this.uWaterSkyIlluminance.value = THREE.MathUtils.clamp(7500 * Math.pow(skyRef, 0.55), 260, 22000);

    this.uWaterRadianceScale.value = this.radianceScale();
    this.uWaterViewProjection.value.copy(ctx.camera.viewProjection);
    this.uWaterPrevViewProjection.value.copy(ctx.camera.prevViewProjection);
    this.uWaterDepthPlanes.value.set(ctx.camera.near, ctx.camera.far);

    // One pixel's angular size at the frame centre — the input to the filter that
    // turns unresolved ripples into roughness instead of into aliasing.
    const graph = this.services.graph;
    const height = Math.max(graph.height, 1);
    this.uWaterResolution.value.set(graph.width, height);
    this.uWaterPixelAngle.value =
      (2 * Math.tan(ctx.camera.fovDeg * THREE.MathUtils.DEG2RAD * 0.5)) / height;

    /* --- TERRAIN's shore mask, if it is a real one ----------------------- */
    const terrain = this.services.terrain;
    const mask = terrain.shoreMask;
    const image = mask.image as { width?: number } | undefined;
    const valid = (image?.width ?? 0) > 4 ? 1 : 0;
    this.uWaterShoreMask.value = mask;
    this.uWaterShoreRect.value.set(
      terrain.mapRect.minX,
      terrain.mapRect.minZ,
      terrain.mapRect.sizeX,
      terrain.mapRect.sizeZ,
    );
    this.uWaterShoreDecode.value.set(terrain.shoreRangeMetres, valid);

    /* --- screen-space sources -------------------------------------------- */
    if (this.config.refraction && graph.has(RTId.SceneColorCopy)) {
      this.uWaterSceneColor.value = graph.texture(RTId.SceneColorCopy);
      this.uWaterSceneDepth.value = graph.texture(RTId.SceneDepth);
    }
    if (this.config.ssrTexture && graph.has(RTId.SsrColor)) {
      this.uWaterSsr.value = graph.texture(RTId.SsrColor);
    }

    /* --- splash rings ----------------------------------------------------- */
    let live = 0;
    for (let i = 0; i < MAX_RINGS; i++) {
      const age = this.time - this.ringData[i * 4 + 2];
      if (this.ringData[i * 4 + 3] > 0 && age >= 0 && age < 3.6) live = MAX_RINGS;
    }
    this.uWaterRingCount.value = live;

    /* --- underwater ------------------------------------------------------- */
    const eye = ctx.camera.position;
    const surface = this.heightAt(eye.x, eye.z);
    this.eyeDepth = eye.y - surface;
    this.submerged = this.forcedUnderwater || (this.eyeDepth < 0 && eye.y > MACRO_TERRAIN.height(eye.x, eye.z));
    // The murk floor an eye under the surface sees: the body colour lit by the
    // downwelling light, in the same units and from the same model as the surface
    // shader's own scattering term.
    const down = this.uWaterSkyIlluminance.value + tint.y * Math.max(sinElevation, 0);
    const scale = this.uWaterRadianceScale.value;
    this.underwaterTint.set(0.011, 0.047, 0.055).multiplyScalar((down / Math.PI) * scale);
  }

  /* --------------------------------------------------------- WaterService */

  heightAt(x: number, z: number): number {
    const bed = MACRO_TERRAIN.height(x, z);
    const still = this.seaLevel - bed;
    if (still <= 0) return this.seaLevel;
    // Shoaling scales the amplitude; the horizontal Gerstner term is left alone,
    // which is a centimetre-level approximation at the shoreline and exact
    // everywhere a body actually floats.
    return this.seaLevel + sampleWaveHeight(this.table, x, z, this.time) * shoalFactor(still);
  }

  normalAt(x: number, z: number, out: Vec3): Vec3 {
    sampleWaveNormal(this.table, x, z, this.time, this.scratchNormal);
    return out.set(this.scratchNormal.x, this.scratchNormal.y, this.scratchNormal.z).normalize();
  }

  isSubmerged(point: Vec3): boolean {
    return point.y < this.heightAt(point.x, point.z) && point.y > MACRO_TERRAIN.height(point.x, point.z);
  }

  /**
   * A ring impulse. Energy maps to amplitude as √E because a splash's crest
   * height goes with the square root of the kinetic energy that made it: a rifle
   * round and a 40 mm grenade differ by 40× in joules and by 6× in ring height,
   * which is what the eye actually reads.
   */
  splash(position: Vec3, energyJ: number): void {
    const slot = this.ringWrite % MAX_RINGS;
    this.ringWrite++;
    const amp = THREE.MathUtils.clamp(Math.sqrt(Math.max(energyJ, 0)) * 0.0075, 0.015, 0.55);
    this.ringData[slot * 4] = position.x;
    this.ringData[slot * 4 + 1] = position.z;
    this.ringData[slot * 4 + 2] = this.time;
    this.ringData[slot * 4 + 3] = amp;
  }

  setUnderwater(active: boolean): void {
    this.forcedUnderwater = active;
  }

  /** Harness reset: rings, phase and the velocity latch all leak across shots. */
  dropTransientState(): void {
    this.ringData.fill(0);
    this.ringWrite = 0;
    this.uWaterRingCount.value = 0;
    this.time = 0;
    this.prevTime = 0;
    this.forcedUnderwater = false;
    this.submerged = false;
    // Force a spectrum rebuild so a shot that changed the weather gets its own
    // sea rather than the previous shot's.
    this.tableWind = Number.NaN;
    this.tableSpeed = Number.NaN;
  }
}

/**
 * `RenderStage.Animation` — "everything that moves a vertex". The Gerstner phase,
 * the grid's follow, the sun, the screen-space sources and the splash ring buffer
 * are all pushed here, before `RenderStage.Submit` draws with them.
 */
class WaterAnimationSystem implements RenderSystem {
  readonly name = 'water.animate';
  readonly stage = RenderStage.Animation;
  readonly order = 20;

  constructor(private readonly water: IronWater) {}

  update(ctx: FrameCtx): void {
    this.water.update(ctx);
  }
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 */
export function createWaterService(ctx: BootContext): WaterService {
  instance = new IronWater(ctx);
  return instance;
}

/**
 * The seabed depth field.
 *
 * A `MainThread` step because it produces a live `THREE.DataTexture` — a worker
 * could compute the samples but could not make the texture, and shipping the
 * typed array back across the boundary to build it on the main thread anyway
 * saves nothing at 410 k evaluations of an analytic function.
 */
export function registerWaterBakes(assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  seabedKey = assets.define<SeabedField>('water.seabed', AssetKind.Data, {
    kind: BakeKind.MainThread,
    version: 1,
    // ~40 ms of pure CPU. Small against the material bakes, and it must not be
    // degraded: the waterline is drawn from it.
    cost: 6,
    cacheable: false,
    dependsOn: [] as readonly AnyAssetKey[],
    run: () => bakeSeabedField(),
    dispose: (value) => value.texture.dispose(),
  });
}

/**
 * Harness reset chain. The Gerstner phase and the splash rings both persist, and
 * water WRITES VELOCITY — a stale previous displacement smears the first frames
 * of a capture in a way that looks exactly like a TAA bug.
 */
export function resetWater(_seed: number): void {
  instance?.dropTransientState();
}
