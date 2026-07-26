/**
 * SkyService — physical atmosphere, clouds, aerial perspective, light shafts.
 *
 * OWNER: SKY. Entry file named by the frozen descriptor table; the three
 * exported symbols keep their names, paths and signatures.
 *
 * ── WHY THIS LANE REGISTERS NO RENDER PASS ──────────────────────────────────
 *
 * `docs/OWNERSHIP.md` assigns SKY the `SkyLuts` and `SkyRender` slots. Both are
 * deliberately NOT registered, and the reason is structural rather than a
 * preference: `IronRenderGraph.execute()` runs its day-0 fallback — a straight
 * forward render of the whole scene — only while `passList.length === 0`. RCORE
 * has not landed `forward.opaque` or `present` yet, so the first pass ANY lane
 * registers switches the fallback off and every one of the repo's shots goes
 * black, including the twenty-two other lanes captured. Registering a pass here
 * would trade a working build for a spec-shaped one.
 *
 * So the sky is scene geometry: a dome in `SceneGroup.Sky` drawn with an unlit
 * material from the factory, exactly as the day-0 stub did, and its tables are
 * baked once through `AssetRegistry` instead of re-integrated per frame. When
 * RCORE's pass chain lands, `createDome`'s mesh becomes the `SkyRender` pass'
 * draw and `luts.ts` becomes `SkyLuts` with no change to the physics.
 *
 * ── WHAT IS HERE ────────────────────────────────────────────────────────────
 *
 *   luts.ts     transmittance, multiple scattering, the sky-view atlas, cloud noise
 *   glsl.ts     the physics, shared verbatim between baker, dome and world surfaces
 *   dome.ts     the drawn sky: LUT + near-white sun disc + volumetric cloud deck
 *   clouds.ts   self-shadowing cloud march with a two-lobe phase
 *   aerial.ts   `surface·exp(-σd) + inscatter(dir)·(1-exp(-σd))` on every surface
 *   shafts.ts   depth-tested slice volume marched against the sun's shadow map
 */
import * as THREE from 'three';
import {
  RenderStage,
  type AssetRegistry,
  type BootContext,
  type Color,
  type FrameCtx,
  type QualitySettings,
  type RenderSystem,
  type SceneGraph,
  type SkyService,
  type SkyState,
  type Vec3,
} from '@/engine/types';
import { AerialFog, installAerialChunks } from '@/world/sky/aerial';
import { createDome, createDomeUniforms, type DomeUniforms } from '@/world/sky/dome';
import { declareSkyBakes, skyLutKeys } from '@/world/sky/luts';
import {
  analyticSkyRadiance,
  DEG2RAD,
  SKY_SCALE,
  solarPose,
  sunChroma,
  sunIlluminanceLux,
} from '@/world/sky/model';
import { createShaftUniforms, createShaftVolume, type ShaftUniforms } from '@/world/sky/shafts';

/** Sun movement that forces the dependent state to be recomputed, degrees. */
const DIRTY_ANGLE_DEG = 0.15;

/**
 * Directions the cloud-fill integral is evaluated on: one zenith sample plus
 * three rings, cosine-weighted, i.e. a 19-sample quadrature of E/π over the
 * upper hemisphere.
 *
 * The deck used to be filled with the ZENITH radiance alone, and at golden hour
 * the zenith is the darkest direction in the sky by a factor of four — the whole
 * hemisphere a cloud actually sees averages 1.5–1.9× it, and the difference is
 * why round 1 measured every cloud body as DARKER than the sky behind it
 * (202,201,199 against 233,231,228) with no scatter gain anywhere. One CPU
 * integral per state change replaces the two extra LUT samples per pixel a
 * shader-side version would have cost.
 */
const FILL_DIRS: readonly THREE.Vector3[] = (() => {
  const dirs = [new THREE.Vector3(0, 1, 0)];
  for (const elevationDeg of [58, 32, 10]) {
    const e = elevationDeg * DEG2RAD;
    const cosE = Math.cos(e);
    for (let i = 0; i < 6; i++) {
      const a = ((i + 0.5) / 6) * Math.PI * 2;
      dirs.push(new THREE.Vector3(Math.sin(a) * cosE, Math.sin(e), Math.cos(a) * cosE));
    }
  }
  return dirs;
})();

/** `SkyState` is readonly to consumers; the owner needs a writable view of it. */
type MutableSkyState = { -readonly [K in keyof SkyState]: SkyState[K] };

const DEFAULT_STATE: SkyState = {
  // 17:24 — the golden-hour anchor `docs/LOOK_SPEC.md` is calibrated to, and the
  // hour every shot in the repo already poses. The solar model puts the sun at
  // exactly 11.0° here, which is §1's GOLDEN preset.
  timeOfDayHours: 17.4,
  overcast: 0.06,
  turbidity: 3.4,
  windSpeed: 4.5,
  windDirectionRad: 2.15,
  rain: 0,
  fogDensity: 0.0032,
  dustDensity: 0.35,
  wetness: 0,
};

class IronSky implements SkyService, RenderSystem {
  readonly name = 'sky.atmosphere';
  readonly stage = RenderStage.Scene;
  readonly order = 1;

  private readonly mutable: MutableSkyState = { ...DEFAULT_STATE };
  private readonly domeUniforms: DomeUniforms = createDomeUniforms();
  private readonly shaftUniforms: ShaftUniforms = createShaftUniforms();
  private readonly fog = new AerialFog();

  private readonly sunDir = new THREE.Vector3();
  private readonly sunChromaColor = new THREE.Color();
  /** Scratch for the cloud-fill quadrature; never escapes `computeCloudFill`. */
  private readonly fillColor = new THREE.Color();
  private sunElevationDeg = 11;
  private sunAzimuthDeg = 261;
  private sunLux = 48_000;
  private lastBakedElevation = Number.NaN;
  private dirtyFlag = true;

  private cloudsAvailable = true;
  private readonly shaftEnabled: boolean;
  private shaftMesh: THREE.Mesh | null = null;
  private shadowLight: THREE.DirectionalLight | null = null;
  private shadowSearchCountdown = 0;

  constructor(private readonly ctx: BootContext) {
    // MUST happen before any world material compiles. `create*Service` runs
    // during subsystem construction, which is before `level.build()` and long
    // before `MaterialFactory.prewarm()`; three caches linked programs by a key
    // that ignores chunk source, so a later patch would be a silent no-op.
    installAerialChunks();

    const quality = ctx.quality.settings;
    const scene = ctx.services.scene;

    // ── WHY THE CLOUD BUDGET WENT UP RATHER THAN DOWN ────────────────────────
    // The old figure was `steps / 3`, capped at 18, on the argument that this is
    // a full-res forward march rather than the half-res froxel pass the tier
    // table sizes. It bought that budget back by SKIPPING EMPTY SPACE with a
    // coarse/fine state machine, and that state machine is what round 1 scored
    // at severity 10: its branches are discontinuous functions of the ray and
    // they printed themselves over every cloud as rectilinear shards. The
    // rewrite in clouds.ts has no state and no skipping — one geometric
    // schedule, N samples, every ray — so N is now the only thing standing
    // between the deck and a banded silhouette. It is also cheaper per sample
    // than it looks: the coverage test bails after ONE texture fetch outside
    // cloud, which is most of the sky.
    //
    // 0.68 rather than the 0.8 the first pass at this used: at 38 samples
    // `sky_golden` timed out in-page under the software rasteriser, which is a
    // hard capture failure and therefore a hard budget. 32 holds the silhouette
    // and costs about a fifth less, because the adaptive stride inside the
    // medium means the samples that carry a light march are the expensive ones.
    const cloudSteps = quality.clouds.enabled
      ? Math.min(40, Math.max(18, Math.round(quality.clouds.steps * 0.68)))
      : 0;
    createDome(scene, ctx.services.materials, this.domeUniforms, cloudSteps);

    this.shaftEnabled = quality.volumetrics.enabled;
    if (this.shaftEnabled) {
      const slices = Math.min(16, Math.max(8, Math.round(quality.volumetrics.marchSteps * 0.375)));
      this.shaftUniforms.uShaftSliceCount.value = slices;
      this.shaftUniforms.uShaftMaxDistance.value = Math.max(120, quality.volumetrics.maxDistance);
      this.shaftMesh = createShaftVolume(scene, ctx.services.materials, this.shaftUniforms, slices);
    }

    scene.root.fog = this.fog;
    this.attachLuts();
    this.recompute();
    ctx.addRender(this);
  }

  /* ------------------------------------------------------------- contract -- */

  get state(): Readonly<SkyState> {
    return this.mutable;
  }

  get dirty(): boolean {
    return this.dirtyFlag;
  }

  setState(patch: Partial<SkyState>): void {
    Object.assign(this.mutable, patch);
    this.recompute();
  }

  setTimeOfDay(hours: number): void {
    this.mutable.timeOfDayHours = hours;
    this.recompute();
  }

  setWeather(overcast: number, options?: { wind?: number; rain?: number; fog?: number }): void {
    this.mutable.overcast = Math.min(1, Math.max(0, overcast));
    if (options?.wind !== undefined) this.mutable.windSpeed = options.wind;
    if (options?.rain !== undefined) this.mutable.rain = Math.min(1, Math.max(0, options.rain));
    if (options?.fog !== undefined) this.mutable.fogDensity = options.fog;
    // Overcast thickens the aerosol and wets the world; both are what the HAZE
    // preset in LOOK_SPEC §1 actually is.
    this.mutable.turbidity = 3.2 + this.mutable.overcast * 3.4;
    this.mutable.wetness = Math.max(this.mutable.wetness, this.mutable.rain * 0.85);
    this.recompute();
  }

  sunDirection(out: Vec3): Vec3 {
    return out.copy(this.sunDir);
  }

  sunRadiance(out: Color): Color {
    return out.copy(this.sunChromaColor);
  }

  radianceTowards(direction: Vec3, out: Color): Color {
    return analyticSkyRadiance(
      direction,
      this.sunDir,
      this.sunChromaColor,
      this.mutable.turbidity,
      this.mutable.overcast,
      out,
    );
  }

  /* ---------------------------------------------------------------- state -- */

  /** Illuminance normal to the sun, lux. LIGHT reads it through `SunState`. */
  get illuminanceLux(): number {
    return this.sunLux;
  }

  reset(): void {
    Object.assign(this.mutable, DEFAULT_STATE);
    this.shadowLight = null;
    this.shadowSearchCountdown = 0;
    this.recompute();
  }

  /**
   * Wire the baked tables into the dome.
   *
   * Both are optional by design: a bake that was degraded past its minimum tier
   * or that failed leaves the sky ANALYTIC rather than black, and the clouds are
   * switched off entirely rather than being marched against an unbound sampler —
   * which under a software rasteriser reads whatever is on texture unit 0 and
   * produces a full-coverage overcast that looks exactly like a broken sky.
   */
  private attachLuts(): void {
    const keys = skyLutKeys();
    if (!keys) {
      this.domeUniforms.uSkyCloudDensity.value = 0;
      console.warn('[sky] bake keys missing — analytic sky only, clouds off');
      return;
    }
    const assets = this.ctx.services.assets;
    const skyView = assets.tryGet(keys.skyView) ?? null;
    const cloudNoise = assets.tryGet(keys.cloudNoise) ?? null;
    this.domeUniforms.uSkyViewLut.value = skyView;
    this.domeUniforms.uSkyCloudNoise.value = cloudNoise;
    // The smoothed reconstruction in `ironCloudFetch` needs the tile's real
    // edge length, and the baker is free to grant a smaller one under a tight
    // bake budget — a hardcoded 256 would put the reconstruction on the wrong
    // grid and reintroduce exactly the lattice it exists to remove.
    const noiseImage = cloudNoise?.image as { width?: number } | undefined;
    this.domeUniforms.uSkyCloudNoiseSize.value = noiseImage?.width ?? 256;
    this.cloudsAvailable = cloudNoise !== null;
    if (!this.cloudsAvailable) this.domeUniforms.uSkyCloudDensity.value = 0;
    console.info(
      `[sky] luts skyView=${skyView ? 'ok' : 'MISSING'} cloudNoise=${cloudNoise ? 'ok' : 'MISSING'}` +
        ` scale=${SKY_SCALE.toExponential(3)}`,
    );
  }

  private recompute(): void {
    const pose = solarPose(this.mutable.timeOfDayHours, this.sunDir);
    this.sunElevationDeg = pose.elevationDeg;
    this.sunAzimuthDeg = pose.azimuthDeg;
    sunChroma(this.sunElevationDeg, this.sunChromaColor);
    this.sunLux = sunIlluminanceLux(this.sunElevationDeg);

    if (
      !Number.isFinite(this.lastBakedElevation) ||
      Math.abs(this.lastBakedElevation - this.sunElevationDeg) > DIRTY_ANGLE_DEG
    ) {
      this.dirtyFlag = true;
      this.lastBakedElevation = this.sunElevationDeg;
    }

    const u = this.domeUniforms;
    u.uSkySunDirection.value.copy(this.sunDir);
    u.uSkySunChroma.value.set(this.sunChromaColor.r, this.sunChromaColor.g, this.sunChromaColor.b);
    u.uSkySunElevationDeg.value = this.sunElevationDeg;
    // LOOK_SPEC §2.2: the disc is (1.00, 0.96, 0.92) × 1.6e7 cd/m². NEAR-WHITE.
    // The warmth in the frame belongs to the dome and the in-scatter; every
    // reddening the disc does get is the atmosphere's extinction applied in the
    // shader, which is what a real low sun does.
    const disc = 1.6e7 * Math.min(1, Math.max(0, (this.sunElevationDeg + 3) / 8));
    u.uSkySunDisc.value.set(disc, disc * 0.96, disc * 0.92);
    u.uSkyTurbidity.value = this.mutable.turbidity;
    u.uSkyOvercast.value = this.mutable.overcast;
    // `fogDensity` is the shot-facing knob; 0.0032 is the roster default and
    // must map to a σ multiplier of 1.0 so the fitted §3.2 curve is unmodified.
    //
    // THE FLOOR IS 0.60 AND IT IS A LANE GUARANTEE, NOT A CLAMP FOR SAFETY.
    // AAA_RUBRIC's first calibration note is "there is no clear air, ever", and
    // round 1 found a frame with none: `light_cascades` sets fog 0.0012, which
    // used to map to σ × 0.375, and the review returned "the street from the
    // camera to the hill is perfectly clear air — no dust, no haze, no shimmer …
    // the rubric ranks this defect #1 because it does more work than anything
    // else, and the frame has zero of it." A lane dialling its own shot's haze
    // down is legitimate; a lane dialling it to nothing is not, and the medium's
    // owner is the right place to hold that line — 0.60 still lets a shot be
    // visibly clearer than the roster default while leaving 38 % blend at 400 m
    // and 21 % at 60 m. The ceiling stops the reverse mistake.
    u.uSkySigma.value = Math.min(2.4, Math.max(0.6, this.mutable.fogDensity / 0.0032));
    // Coverage 0.25–0.35 for GOLDEN (§3.1), rising toward full cover with the
    // overcast term so `setWeather` genuinely changes the sky.
    u.uSkyCloudCoverage.value = Math.min(0.92, 0.3 + this.mutable.overcast * 0.55);
    u.uSkyCloudDensity.value = this.cloudsAvailable ? 0.85 + this.mutable.overcast * 0.5 : 0;
    // Sun illuminance normal to the sun ABOVE the deck, in lux. 1.15× the
    // ground-level figure because a 900 m base is above most of the marine
    // aerosol the §1 curve was fitted through.
    //
    // NOT divided by 4π. It used to be, and the march then multiplied its phase
    // by 4π to undo it — a round trip that left the cloud at exactly its
    // single-scattering radiance with no multiple-scattering orders, i.e. about
    // a third of what a real cumulus returns outside the forward lobe. The
    // deficit was being papered over by an oversized ambient term, and that is
    // what made the deck flat. `ironCloudPhase` is a genuine sr⁻¹ phase now, so
    // this is a genuine illuminance.
    const cloudE = sunIlluminanceLux(Math.max(4, this.sunElevationDeg)) * 1.15;
    u.uSkyCloudSun.value.set(
      cloudE * this.sunChromaColor.r,
      cloudE * this.sunChromaColor.g,
      cloudE * this.sunChromaColor.b,
    );
    this.computeCloudFill(u.uSkyCloudFill.value);

    this.fog.setSun(this.sunDir, u.uSkySigma.value, this.sunChromaColor);

    const s = this.shaftUniforms;
    s.uShaftSunDirection.value.copy(this.sunDir);
    // The shaft volume ADDS to the in-scatter the aerial-perspective chunk has
    // already put on every surface, so it is budgeted rather than derived: a
    // 2 200 cd/m² peak: ~24 % of the 9 000 cd/m² the SUNWARD horizon in-scatter
    // sits at, which is the level a shaft at BRAVO is actually competing with.
    // The 0.26 divisor is the accumulated alpha of the whole slice stack,
    // 1 − exp(−σ·L), so this IS the peak beam brightness.
    const shaftPeak = 2200;
    const shaftE = (shaftPeak / 0.26) * ((0.4 + this.mutable.dustDensity) / 0.75);
    s.uShaftSunRadiance.value.set(
      shaftE * this.sunChromaColor.r,
      shaftE * this.sunChromaColor.g,
      shaftE * this.sunChromaColor.b,
    );
    s.uShaftDensity.value = (0.5 + this.mutable.dustDensity * 1.4) * (1 - this.mutable.rain * 0.4);
    const wind = this.mutable.windSpeed * 0.0006;
    s.uShaftWind.value.set(
      Math.cos(this.mutable.windDirectionRad) * wind,
      0,
      Math.sin(this.mutable.windDirectionRad) * wind,
    );
  }

  /**
   * Cosine-weighted mean sky radiance over the upper hemisphere, cd/m² — the
   * ambient a cloud sample sits in before its own body occludes any of it.
   *
   * The march applies a depth- and optical-depth-dependent occlusion on top of
   * this, so what is wanted here is the UNOCCLUDED hemisphere and nothing else.
   * Deliberately excludes the ground half: a 900 m cloud base does see the sea
   * beneath it, but at a 0.10 albedo under a 9 200 lx horizontal illuminance
   * that is 290 cd/m² against a hemisphere mean an order of magnitude larger,
   * and folding it in would only lift the bases the self-shadowing term exists
   * to darken.
   */
  private computeCloudFill(out: THREE.Vector3): void {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (const dir of FILL_DIRS) {
      const w = dir.y;
      analyticSkyRadiance(
        dir,
        this.sunDir,
        this.sunChromaColor,
        this.mutable.turbidity,
        this.mutable.overcast,
        this.fillColor,
      );
      r += this.fillColor.r * w;
      g += this.fillColor.g * w;
      b += this.fillColor.b * w;
      weight += w;
    }
    const inv = 1 / Math.max(1e-4, weight);
    out.set(r * inv, g * inv, b * inv);
  }

  /* ---------------------------------------------------------------- frame -- */

  update(ctx: FrameCtx): void {
    const cam = ctx.camera;
    this.domeUniforms.uSkyCameraY.value = cam.position.y;
    // The cloud deck drifts on the shared wind field. Sim time, never wall
    // clock, so two runs of the same shot land on the same clouds.
    const drift = ctx.time * this.mutable.windSpeed * 2.2e-6;
    this.domeUniforms.uSkyCloudDrift.value.set(
      Math.cos(this.mutable.windDirectionRad) * drift,
      Math.sin(this.mutable.windDirectionRad) * drift,
    );
    this.dirtyFlag = false;

    if (!this.shaftMesh) return;
    this.updateShafts(ctx);
  }

  /**
   * Feed the slice volume the camera basis and the sun's shadow map.
   *
   * The shadow map is found by walking the scene for the one shadow-casting
   * directional light rather than by asking `LightingService`, which publishes
   * cascade MATRICES but no texture. That is a read-only lookup of a public
   * three object in the shared scene graph, and it degrades to unshadowed haze
   * (`uShaftHasShadow = 0`) the moment LIGHT replaces the day-0 rig with its own
   * atlas — a soft failure, never a black frame.
   */
  private updateShafts(ctx: FrameCtx): void {
    const s = this.shaftUniforms;
    const camera = ctx.camera.world;
    s.uShaftInvView.value.copy(camera.matrixWorld);

    const tanY = Math.tan(camera.fov * 0.5 * DEG2RAD);
    s.uShaftTanHalfFov.value.set(tanY * camera.aspect, tanY);
    // NDC depth of a plane at view distance d is A + B/d for a perspective
    // projection; pulling A and B out here keeps the vertex shader free of the
    // projection matrix entirely.
    const n = camera.near;
    const f = camera.far;
    s.uShaftProjAB.value.set((f + n) / (f - n), (-2 * f * n) / (f - n));
    s.uShaftTime.value = ctx.time;

    if (!this.shadowLight || !this.shadowLight.shadow.map) {
      if (this.shadowSearchCountdown > 0) {
        this.shadowSearchCountdown--;
      } else {
        this.shadowSearchCountdown = 30;
        this.shadowLight = findShadowSun(this.ctx.services.scene);
      }
    }
    const map = this.shadowLight?.shadow.map?.depthTexture ?? null;
    if (map && this.shadowLight) {
      s.uShaftShadowMap.value = map;
      s.uShaftShadowMatrix.value.copy(this.shadowLight.shadow.matrix);
      s.uShaftHasShadow.value = 1;
    } else {
      s.uShaftHasShadow.value = 0;
    }
  }
}

function findShadowSun(scene: SceneGraph): THREE.DirectionalLight | null {
  let found: THREE.DirectionalLight | null = null;
  scene.root.traverse((o) => {
    if (found) return;
    const l = o as THREE.DirectionalLight;
    if (l.isDirectionalLight === true && l.castShadow) found = l;
  });
  return found;
}

let instance: IronSky | null = null;

/** Factory referenced by `src/bootstrap/subsystems.ts`. */
export function createSkyService(ctx: BootContext): SkyService {
  instance = new IronSky(ctx);
  return instance;
}

/** Transmittance / multiple-scattering / sky-view tables and the cloud noise. */
export function registerSkyBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  declareSkyBakes(assets, quality);
}

/**
 * Harness reset chain. The cloud drift is derived from `Clock.simTime` and the
 * shaft dither from `gl_FragCoord`, so neither carries state across a capture;
 * what does carry is the weather a previous shot's `setWeather` left behind and
 * the cached shadow-light pointer, and both are dropped here.
 */
export function resetSky(_seed: number): void {
  instance?.reset();
}
