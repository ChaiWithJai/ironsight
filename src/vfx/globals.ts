/**
 * VFX — the shared uniform block.
 *
 * OWNER: VFX. One set of live `GpuUniform` cells, handed to every material this
 * lane creates. `MaterialFactory.createUnlit` shallow-copies the record, so
 * every material ends up holding the SAME cell objects; mutating `.value` here
 * once per frame reaches all of them, which is exactly the ownership model
 * `types.ts` §0 describes for a uniform cell.
 *
 * WHAT THIS FILE IS REALLY FOR: it is the single place where the renderer's
 * light transport is translated into terms a participating medium can use.
 * Everything the particle shaders know about the world arrives through here.
 *
 * THE EXPOSURE SEAM, AND WHY IT IS DERIVED RATHER THAN DIALLED
 * ------------------------------------------------------------
 * `LightingService` publishes the sun in PHOTOMETRIC units (lux) as LOOK_SPEC
 * §2.1 requires. What the RENDERER is working in depends on which lanes have
 * shipped: the day-0 sun rig drove a `THREE.DirectionalLight` at intensity
 * ≈ 3.4 against `toneMappingExposure = 1.0`, while the real LIGHT + RCORE
 * chain drives 48 000 lx against ≈ 1.6e-4. Those two differ by four orders of
 * magnitude, so a medium lit with raw lux is either invisible or a white
 * screen, depending on the week.
 *
 * `workingIrradiance()` below removes the choice entirely. LOOK_SPEC §2.1
 * defines exposure as `0.18 / L_grey` with `L_grey = E_total · 0.18 / π`,
 * which inverts to
 *
 *     E_total(working units) = π / exposureScale
 *
 * and `exposureScale` is recoverable from `CameraState.exposureEv`, which is
 * frozen while `deterministic` and is published by whoever currently owns
 * exposure. So the lane asks "what total horizontal irradiance does this
 * frame's exposure imply?", splits it by the sun:sky RATIO LightingService
 * publishes (a ratio is unit-free), and is correct in both regimes with no
 * constant to maintain and nothing to re-tune when RCORE's exposure pass takes
 * over from the renderer.
 */
import * as THREE from 'three';
import type { GpuUniform, LightingService, SkyService, Vec3 } from '@/engine/types';
import { clamp, clamp01 } from '@/engine/math';

/**
 * EV100 → the linear exposure multiplier applied before the tonemapper.
 * `L · 2^-EV / 1.2` is the standard photometric relation; 1.2 is the
 * reflected-light calibration constant.
 */
export function exposureScaleFromEv(ev: number): number {
  return 1 / (1.2 * Math.pow(2, ev));
}

/** Emitter slots the particle shaders read. Four is what the phase loop costs. */
export const EMITTER_SLOTS = 4;

/** Scale a colour so its largest channel is 1: chroma without magnitude. */
function normaliseChroma(c: THREE.Color): void {
  const m = Math.max(c.r, c.g, c.b);
  if (m > 1e-6) c.multiplyScalar(1 / m);
  else c.setRGB(1, 1, 1);
}

function makePlaceholderDepth(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

/** A live emissive source: a fireball, a muzzle flash, a burning wreck. */
export interface VfxEmitter {
  readonly position: THREE.Vector3;
  /** Linear colour × luminous intensity, already in renderer units at 1 m. */
  readonly color: THREE.Color;
  /** Influence radius: beyond this the light is culled to zero. */
  radius: number;
  /** Physical radius of the emitting body. 1/r² is clamped at this. */
  readonly sourceRadius: number;
  intensity: number;
  /** Seconds remaining; ≤ 0 retires the slot. */
  ttl: number;
  /** Total lifetime, so the decay curve is a fraction rather than a rate. */
  readonly life: number;
  /** Peak intensity at t = 0. */
  readonly peak: number;
}

export class VfxGlobals {
  readonly uVfxTime: GpuUniform<number> = { value: 0 };
  readonly uVfxSunDir: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0.2, -1) };
  readonly uVfxSunIrradiance: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(3.2, 2.3, 1.5) };
  readonly uVfxSkyUp: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0.5, 0.6, 0.8) };
  readonly uVfxSkyDown: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0.3, 0.25, 0.18) };
  readonly uVfxHazeSun: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0.86, 0.74, 0.58) };
  readonly uVfxHazeAway: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0.44, 0.48, 0.56) };
  /** x = D0 metres, y = exponent, z = marine scale height, w = strength. */
  readonly uVfxFog: GpuUniform<THREE.Vector4> = { value: new THREE.Vector4(205, 0.668, 22, 1) };
  readonly uVfxCamRight: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(1, 0, 0) };
  readonly uVfxCamUp: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 1, 0) };
  readonly uVfxCamFwd: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, -1) };
  readonly uVfxCamPos: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3() };
  readonly uVfxEmitterPos: GpuUniform<THREE.Vector4[]> = {
    value: Array.from({ length: EMITTER_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)),
  };
  readonly uVfxEmitterCol: GpuUniform<THREE.Vector4[]> = {
    value: Array.from({ length: EMITTER_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)),
  };
  /**
   * Never null: a sampler bound to nothing is undefined behaviour on some
   * drivers and a console warning on the rest. The 1×1 stand-in is what the
   * shader samples while `uVfxDepthParams.w` is 0 and the fade is skipped.
   */
  readonly uVfxSceneDepth: GpuUniform<THREE.Texture> = { value: makePlaceholderDepth() };
  /** near, far, soft-fade metres, enabled. */
  readonly uVfxDepthParams: GpuUniform<THREE.Vector4> = { value: new THREE.Vector4(0.1, 2000, 0.55, 0) };
  readonly uVfxResolution: GpuUniform<THREE.Vector2> = { value: new THREE.Vector2(1920, 1080) };
  /** Mid-grey scene luminance, `0.18 / exposureScale`. See `glsl.ts`. */
  readonly uVfxEmissiveScale: GpuUniform<number> = { value: 1 };

  /** Live emitters, sorted by delivered irradiance each frame. */
  private readonly emitters: VfxEmitter[] = [];
  /**
   * This frame's lux → renderer-working-unit factor, derived in `syncLighting`.
   * 1.0 once the whole chain is photometric; ~3e-4 against the day-0 rig.
   */
  private luxToWorking = 1;

  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  private readonly scratchSky = new THREE.Color();

  /** The record handed to every `createUnlit` call in this lane. */
  get uniforms(): Record<string, GpuUniform> {
    return {
      uVfxTime: this.uVfxTime,
      uVfxSunDir: this.uVfxSunDir,
      uVfxSunIrradiance: this.uVfxSunIrradiance,
      uVfxSkyUp: this.uVfxSkyUp,
      uVfxSkyDown: this.uVfxSkyDown,
      uVfxHazeSun: this.uVfxHazeSun,
      uVfxHazeAway: this.uVfxHazeAway,
      uVfxFog: this.uVfxFog,
      uVfxCamRight: this.uVfxCamRight,
      uVfxCamUp: this.uVfxCamUp,
      uVfxCamFwd: this.uVfxCamFwd,
      uVfxCamPos: this.uVfxCamPos,
      uVfxEmitterPos: this.uVfxEmitterPos as unknown as GpuUniform,
      uVfxEmitterCol: this.uVfxEmitterCol as unknown as GpuUniform,
      uVfxSceneDepth: this.uVfxSceneDepth as unknown as GpuUniform,
      uVfxDepthParams: this.uVfxDepthParams,
      uVfxResolution: this.uVfxResolution,
      uVfxEmissiveScale: this.uVfxEmissiveScale,
    };
  }

  /**
   * Register an emissive source. VFX keeps its own registry IN ADDITION to
   * `LightingService.flash()`: the clustered lights light the WORLD, this
   * lights the MEDIUM. A fireball whose own smoke column is not lit from the
   * inside is the single most common way an explosion reads as a sprite.
   */
  addEmitter(
    position: Vec3,
    color: THREE.Color,
    intensityCd: number,
    radius: number,
    seconds: number,
    sourceRadius: number,
  ): void {
    // Stored in CANDELA and converted at publish time: `luxToWorking` is a
    // per-frame quantity and an emitter can outlive several frames of it.
    this.emitters.push({
      position: new THREE.Vector3().copy(position),
      color: new THREE.Color().copy(color),
      radius,
      sourceRadius: Math.max(0.05, sourceRadius),
      intensity: intensityCd,
      ttl: seconds,
      life: seconds,
      peak: intensityCd,
    });
    // Hard cap well above EMITTER_SLOTS: the extras still age out and can be
    // promoted into a slot when a brighter one expires.
    if (this.emitters.length > 32) this.emitters.splice(0, this.emitters.length - 32);
  }

  clearEmitters(): void {
    this.emitters.length = 0;
    for (let i = 0; i < EMITTER_SLOTS; i++) {
      this.uVfxEmitterPos.value[i].set(0, 0, 0, 0);
      this.uVfxEmitterCol.value[i].set(0, 0, 0, 0);
    }
  }

  /**
   * Age emitters and publish the four that matter most to the camera.
   * Selection is by delivered irradiance (intensity / distance²), not by
   * intensity alone — a 2.5e6 cd fireball 300 m away must not evict the muzzle
   * flash two metres from the lens.
   */
  updateEmitters(dt: number, cameraPos: THREE.Vector3): void {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.ttl -= dt;
      if (e.ttl <= 0) {
        this.emitters.splice(i, 1);
        continue;
      }
      // Explosions decay hard (LOOK_SPEC §2.7: 2.5e6 cd peak → 0 over 0.55 s).
      // Cubic, so the peak is genuinely a flash and not a lamp that fades.
      const remaining = clamp01(e.ttl / e.life);
      e.intensity = e.peak * remaining * remaining * remaining;
    }
    this.emitters.sort((a, b) => {
      const da = a.position.distanceToSquared(cameraPos) + 1;
      const db = b.position.distanceToSquared(cameraPos) + 1;
      return b.intensity / db - a.intensity / da;
    });
    for (let i = 0; i < EMITTER_SLOTS; i++) {
      const e = this.emitters[i];
      if (!e) {
        this.uVfxEmitterPos.value[i].set(0, 0, 0, 0);
        this.uVfxEmitterCol.value[i].set(0, 0, 0, 0);
        continue;
      }
      const w = e.intensity * this.luxToWorking;
      this.uVfxEmitterPos.value[i].set(e.position.x, e.position.y, e.position.z, e.radius);
      this.uVfxEmitterCol.value[i].set(e.color.r * w, e.color.g * w, e.color.b * w, e.sourceRadius);
    }
  }

  /**
   * Pull the frame's light transport out of LIGHT and SKY and convert it into
   * medium terms. Called once per frame at `RenderStage.Presentation`.
   */
  syncLighting(lighting: LightingService, sky: SkyService, exposureEv: number): void {
    const sun = lighting.sun;
    this.uVfxSunDir.value.copy(sun.direction).normalize();

    // LOOK_SPEC §2.1, inverted: the exposure this frame is being graded at
    // implies a total horizontal irradiance, in whatever units the renderer is
    // actually working in. Split it by the sun:sky ratio LIGHT publishes.
    // EV 0 means the exposure pass has not published yet — it happens on the
    // first frame after the harness resets histories. Falling through with it
    // would light one frame of a capture four orders of magnitude wrong, and
    // any particle BORN on that frame would carry the wrong colour for its
    // whole life. 12.376 is the GOLDEN preset (LOOK_SPEC §2.1).
    const ev = exposureEv > 0.5 ? exposureEv : 12.376;
    const exposureScale = Math.max(exposureScaleFromEv(ev), 1e-12);
    const totalWorking = Math.PI / exposureScale;
    // Emissive strengths in this lane are authored in MULTIPLES OF MID GREY,
    // which is the only way a fireball core can land on LOOK_SPEC §5.1's ramp
    // without knowing whether it is being graded at 1.0 or at 1.6e-4.
    this.uVfxEmissiveScale.value = 0.18 / exposureScale;
    const sunHorizontalLux = sun.illuminanceLux * Math.max(0, sun.direction.y);
    const totalLux = Math.max(1, sunHorizontalLux + lighting.skyIlluminanceLux);
    this.luxToWorking = totalWorking / totalLux;

    // Sun irradiance. `SunState.illuminanceLux` is NORMAL illuminance; a medium
    // element scatters what arrives along the sun vector, so no cosine here —
    // the phase function and the wrapped term in the shader do that job.
    const e = sun.illuminanceLux * this.luxToWorking;
    this.uVfxSunIrradiance.value.set(sun.color.r * e, sun.color.g * e, sun.color.b * e);

    // Sky: two lobes, as LOOK_SPEC §2.4 requires. The upper lobe is the dome
    // sampled straight up; the lower lobe is the GROUND BOUNCE, and it is not
    // grey — it carries the sandstone/sea albedo, which is what stops the
    // underside of a plume reading identically to its top.
    //
    // UNITS. `SkyService.radianceTowards` is documented as RADIANCE in cd/m²;
    // `skyIlluminanceLux` is an IRRADIANCE in lx. Multiplying one by the other
    // is a ~10⁴ error that shows up as a wall of white, so the radiance is used
    // for CHROMA only and the magnitude comes from the illuminance.
    const skyLux = lighting.skyIlluminanceLux * this.luxToWorking;
    this.scratchDir.set(0, 1, 0);
    sky.radianceTowards(this.scratchDir, this.scratchSky);
    normaliseChroma(this.scratchSky);
    this.uVfxSkyUp.value.set(
      this.scratchSky.r * skyLux,
      this.scratchSky.g * skyLux,
      this.scratchSky.b * skyLux,
    );

    // Bounce budget is 8–12 % of the direct sun irradiance on a surface fully
    // open to the ground (LOOK_SPEC §2.4), tinted toward dry sandstone, plus a
    // small share of the dome that a downward-facing element still sees.
    const bounce = e * 0.10;
    this.uVfxSkyDown.value.set(
      sun.color.r * bounce * 0.62 + this.scratchSky.r * skyLux * 0.18,
      sun.color.g * bounce * 0.50 + this.scratchSky.g * skyLux * 0.18,
      sun.color.b * bounce * 0.36 + this.scratchSky.b * skyLux * 0.18,
    );

    // In-scatter colours for the aerial-perspective integral. These ARE
    // radiances — the per-ray sky radiance is exactly what LOOK_SPEC §3.2
    // requires the in-scatter term to be — so they go in unscaled apart from
    // the working-unit conversion. A constant fog colour is the instant tell.
    this.scratchDir.copy(this.uVfxSunDir.value).setY(0.06).normalize();
    sky.radianceTowards(this.scratchDir, this.scratchColor);
    this.uVfxHazeSun.value.set(
      this.scratchColor.r * this.luxToWorking,
      this.scratchColor.g * this.luxToWorking,
      this.scratchColor.b * this.luxToWorking,
    );
    this.scratchDir.set(-this.uVfxSunDir.value.x, 0.08, -this.uVfxSunDir.value.z).normalize();
    sky.radianceTowards(this.scratchDir, this.scratchColor);
    this.uVfxHazeAway.value.set(
      this.scratchColor.r * this.luxToWorking,
      this.scratchColor.g * this.luxToWorking,
      this.scratchColor.b * this.luxToWorking,
    );

    // Atmosphere density. The exponent and D0 are the fit to LOOK_SPEC §3.2's
    // blend-fraction table; weather scales the strength around it.
    // Calibrated so the GOLDEN preset (dust 0.35, fog 0.0032, overcast 0.06)
    // lands at strength ≈ 1.0, i.e. exactly on the §3.2 blend-fraction table:
    // 0.16 at 15 m, 0.33 at 60 m, 0.53 at 150 m, 0.79 at 400 m. Weather moves
    // it around that; it does not multiply it.
    const state = sky.state;
    const strength = clamp(0.60 + state.dustDensity * 0.50 + state.fogDensity * 60 + state.overcast * 0.40, 0.45, 2.2);
    this.uVfxFog.value.set(205, 0.668, 22, strength);
  }

  /** Camera basis, used to build every billboard. */
  syncCamera(position: Vec3, quaternion: THREE.Quaternion, width: number, height: number): void {
    this.uVfxCamPos.value.copy(position);
    this.uVfxCamRight.value.set(1, 0, 0).applyQuaternion(quaternion);
    this.uVfxCamUp.value.set(0, 1, 0).applyQuaternion(quaternion);
    this.uVfxCamFwd.value.set(0, 0, -1).applyQuaternion(quaternion);
    this.uVfxResolution.value.set(width, height);
  }

  /** Wire up (or disable) the soft-particle depth fade for this frame. */
  syncDepth(depth: THREE.Texture | null, near: number, far: number, fadeMetres: number): void {
    if (depth) this.uVfxSceneDepth.value = depth;
    this.uVfxDepthParams.value.set(near, far, fadeMetres, depth ? 1 : 0);
  }
}
