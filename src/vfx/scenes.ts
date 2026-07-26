/**
 * VFX — scripted shot scenes.
 *
 * OWNER: VFX. This is the lane-private hook `src/shots/vfx.ts` calls, the same
 * pattern WEAPONS (`forceWeaponState`), AI, HUD and GAME use: `ShotContext`
 * cannot reach a service, so a lane that needs to POSE ITS OWN SUBSYSTEM for a
 * capture exports a function from inside its own directory and imports it from
 * its own shot file.
 *
 * DETERMINISM. A scene is a pure function of elapsed sim time. It fires its
 * cues when a monotonically increasing clock crosses a threshold, so the same
 * shot at the same frame count produces the same frame — which is the whole
 * point of the capture harness. Nothing here reads wall time, and every random
 * draw comes from the lane's forked RNG, which the reset chain rewinds.
 *
 * WHERE THE EFFECTS GO. Impacts and explosions are placed by RAYCAST against
 * the real level, not by hard-coded coordinates: the shot then lands on
 * whatever LEVEL actually built there, picks up that surface's real
 * `SurfaceId`, and keeps working when the level changes under it. A hard-coded
 * impact point is a shot that silently starts floating in mid-air.
 */
import * as THREE from 'three';
import {
  DecalKind,
  LAYER_SOLID,
  SurfaceId,
  type FrameCtx,
  type QueryFilter,
  type RayHit,
} from '@/engine/types';
import { makeRayHit } from '@/vfx/debris';
import { groundDust, impactBurst, muzzleFlash, muzzleSmoke } from '@/vfx/library';
import { vfxInstance, type IronVfx, type ScriptedScene } from '@/vfx/system';

const FILTER: QueryFilter = { groups: LAYER_SOLID, solid: true };

/** Where a scene wants to put something, and what it turned out to be. */
interface Landing {
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly surface: SurfaceId;
  readonly hit: boolean;
}

/**
 * Cast from the camera along a yaw/pitch offset and report what is there.
 * Falls back to a plausible point at `fallbackDistance` when the ray misses,
 * so a scene never disappears because the level moved.
 */
function castFromCamera(
  ctx: FrameCtx,
  yawOffset: number,
  pitchOffset: number,
  maxDistance: number,
  fallbackDistance: number,
  hit: RayHit,
  out: Landing,
): Landing {
  const cam = ctx.camera;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.rotation);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.rotation);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.rotation);
  dir.addScaledVector(right, Math.tan(yawOffset)).addScaledVector(up, Math.tan(pitchOffset)).normalize();

  const physics = ctx.services.physics;
  const mutable = out as { point: THREE.Vector3; normal: THREE.Vector3; surface: SurfaceId; hit: boolean };
  if (physics.raycast(cam.position, dir, maxDistance, FILTER, hit)) {
    mutable.point.copy(hit.point);
    mutable.normal.copy(hit.normal);
    mutable.surface = hit.surface;
    mutable.hit = true;
  } else {
    mutable.point.copy(cam.position).addScaledVector(dir, fallbackDistance);
    mutable.normal.copy(dir).multiplyScalar(-1);
    mutable.surface = SurfaceId.Sandstone;
    mutable.hit = false;
  }
  return out;
}

function landing(): Landing {
  return {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    surface: SurfaceId.Sandstone,
    hit: false,
  };
}

/** One-shot cue: fires the frame its time is first crossed, and never again. */
class Cue {
  private fired = false;
  constructor(private readonly at: number) {}
  due(elapsed: number): boolean {
    if (this.fired || elapsed < this.at) return false;
    this.fired = true;
    return true;
  }
}

/* ============================================================================
 * MUZZLE FLASH
 * ========================================================================= */

/**
 * Four rounds at 720 rpm (83 ms apart) with the grab landing 17 ms after the
 * last. That is the LOOK_SPEC §8.1 point exactly: the flash is 30 ms and the
 * blast puff is 350–600 ms, so a mid-burst frame shows ONE flash and THREE
 * generations of propellant smoke — which is what a real burst looks like and
 * what a single-flash screenshot never shows.
 *
 * The muzzle comes from `ViewmodelRig.muzzleWorld()`, so the flash is attached
 * to the weapon WEAPONS actually built rather than to a guessed offset — and
 * the shot leaves the viewmodel visible, because a flash floating in mid-air
 * proves nothing and `weapon_recoil_midburst` is exactly the frame this lane
 * exists to complete.
 */
class MuzzleScene implements ScriptedScene {
  readonly seconds = 0.4;
  private readonly cues = [new Cue(0.05), new Cue(0.133), new Cue(0.216), new Cue(0.30)];
  private readonly ambienceCue = new Cue(0);
  private readonly muzzle = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly hit = makeRayHit();
  private readonly land = landing();

  run(vfx: IronVfx, elapsed: number, ctx: FrameCtx): void {
    const cam = ctx.camera;
    this.dir.set(0, 0, -1).applyQuaternion(cam.rotation);
    ctx.services.viewmodel.muzzleWorld(this.muzzle);
    // A null or unbuilt viewmodel reports the origin; fall back to a hip-fired
    // rifle's geometry relative to the eye rather than firing from (0,0,0).
    if (this.muzzle.lengthSq() < 1e-6 || this.muzzle.distanceToSquared(cam.position) > 9) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.rotation);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.rotation);
      this.muzzle
        .copy(cam.position)
        .addScaledVector(this.dir, 0.82)
        .addScaledVector(right, 0.16)
        .addScaledVector(up, -0.15);
    }

    if (this.ambienceCue.due(elapsed)) {
      // A wreck burning 70 m down the street: the mid-plane luminance band and
      // a second emitter for the muzzle smoke to pick up, so the near-field
      // puff is lit from two directions rather than one.
      castFromCamera(ctx, 0.28, -0.02, 220, 70, this.hit, this.land);
      vfx.smokeColumn(this.land.point, 1.15, 30);
      vfx.embers(this.land.point, 1.1, 16);
    }

    const sink = vfx.vfxSink;
    for (const cue of this.cues) {
      if (!cue.due(elapsed)) continue;
      muzzleFlash(sink, this.muzzle, this.dir, false, 1);
      muzzleSmoke(sink, this.muzzle, this.dir);
      // The round has to land somewhere: an impact 30 m down the sightline puts
      // a second, small event in the mid-ground and proves the flash and the
      // impact are the same shot.
      castFromCamera(ctx, 0.015, -0.03, 90, 34, this.hit, this.land);
      impactBurst(sink, this.land.point, this.land.normal, this.dir, this.land.surface, 1400);
    }
  }
}

/* ============================================================================
 * EXPLOSION
 * ========================================================================= */

/**
 * Two bursts, 330 ms apart, so the frame carries the whole four-zone structure
 * at once: the near one is 83 ms old (core still over-range, body at full size,
 * ring expanding, debris in the air) and the far one is 415 ms old (core gone,
 * cooling shell deep red, soot cap separated and rising). Reading both in one
 * frame is the difference between "an explosion" and "an explosion I believe
 * has a physics to it".
 */
class ExplosionScene implements ScriptedScene {
  readonly seconds = 1.0;
  private readonly early = new Cue(0.0);
  private readonly late = new Cue(0.333);
  private readonly dustCue = new Cue(0.36);
  private readonly hit = makeRayHit();
  private readonly land = landing();

  run(vfx: IronVfx, elapsed: number, ctx: FrameCtx): void {
    const sink = vfx.vfxSink;
    if (this.early.due(elapsed)) {
      castFromCamera(ctx, -0.30, -0.09, 160, 46, this.hit, this.land);
      vfx.spawn('explosion.large', { position: this.land.point, scale: 1.0, intensity: 1.0 });
    }
    if (this.late.due(elapsed)) {
      // 24 m and a 10 m ball: the reference frame (bf2042_gp_027) puts a fuel
      // fireball at 65 m filling roughly a third of the frame height, and this
      // subtends the same angle. A 4 m ball at 40 m is accurate for a 40 mm
      // grenade and completely unreadable as a hero frame.
      castFromCamera(ctx, 0.10, -0.13, 120, 24, this.hit, this.land);
      vfx.spawn('explosion.fuel', { position: this.land.point, scale: 1.0, intensity: 1.0 });
      vfx.addDecal({
        kind: DecalKind.Scorch,
        position: this.land.point,
        normal: this.land.normal,
        sizeM: 7.5,
        rotationRad: 0.7,
        surface: this.land.surface,
        opacity: 0.9,
      });
    }
    if (this.dustCue.due(elapsed)) {
      // The displaced ground sheet, spawned a frame after the burst so it lags
      // the fireball the way a real pressure wave does.
      groundDust(sink, this.land.point, this.land.surface, 0.85, 9.0);
    }
  }
}

/* ============================================================================
 * IMPACTS AND DECALS
 * ========================================================================= */

/**
 * A burst walked across whatever is in front of the camera, plus 44 decals laid
 * down at t = 0 so the wall reads as having been under fire for a while rather
 * than having been hit six times.
 *
 * Every impact is placed by raycast, so the burst colour is the real
 * `SurfaceId` of the real geometry: sandstone throws ochre dust and almost no
 * sparks, bare metal throws a shower of sparks and almost no dust, and the
 * difference is visible in one frame. That is the surface-keyed requirement.
 */
class ImpactScene implements ScriptedScene {
  readonly seconds = 0.6;
  private readonly decalCue = new Cue(0);
  private readonly cues: Cue[] = [];
  private readonly hit = makeRayHit();
  private readonly land = landing();
  private readonly incoming = new THREE.Vector3();

  constructor() {
    // Eight rounds over 260 ms — a controlled burst, not a hose.
    for (let i = 0; i < 8; i++) this.cues.push(new Cue(0.04 + i * 0.037));
  }

  run(vfx: IronVfx, elapsed: number, ctx: FrameCtx): void {
    const sink = vfx.vfxSink;
    const rng = vfx.vfxRng;

    if (this.decalCue.due(elapsed)) {
      // Accumulation: a scattered field, not a grid. Each decal is cast
      // separately so it lands ON the geometry and takes its normal, which is
      // what makes a decal conform rather than float.
      for (let i = 0; i < 44; i++) {
        const yaw = (rng.next() - 0.5) * 0.44;
        const pitch = (rng.next() - 0.5) * 0.22 + 0.045;
        castFromCamera(ctx, yaw, pitch, 90, 30, this.hit, this.land);
        if (!this.land.hit) continue;
        vfx.addDecal({
          kind: DecalKind.BulletStone,
          position: this.land.point,
          normal: this.land.normal,
          sizeM: 0.09 + rng.next() * 0.09,
          rotationRad: rng.range(0, Math.PI * 2),
          surface: this.land.surface,
          opacity: 0.65 + rng.next() * 0.3,
        });
      }
    }

    for (let i = 0; i < this.cues.length; i++) {
      if (!this.cues[i].due(elapsed)) continue;
      // Walk the burst left to right and up, the way recoil does. Aimed ABOVE
      // the arcade line so the rounds land on SUNLIT masonry: dust reads as the
      // surface's own ochre only when there is a sun term to carry the hue, and
      // a burst fired into a shaded arcade produces correct — and grey — dust.
      const yaw = -0.15 + i * 0.042;
      const pitch = 0.035 + i * 0.010;
      castFromCamera(ctx, yaw, pitch, 90, 30, this.hit, this.land);
      this.incoming.copy(this.land.point).sub(ctx.camera.position).normalize();
      impactBurst(sink, this.land.point, this.land.normal, this.incoming, this.land.surface, 1800);
      vfx.addDecal({
        kind: DecalKind.BulletStone,
        position: this.land.point,
        normal: this.land.normal,
        sizeM: 0.13,
        rotationRad: rng.range(0, Math.PI * 2),
        surface: this.land.surface,
        opacity: 0.95,
      });
    }
  }
}

/* ============================================================================
 * AMBIENT
 * ========================================================================= */

/**
 * No combat VFX at all — the point is that the frame is still 30–50 %
 * particulate, which is the single loudest property separating the reference
 * corpus from browser 3D. Two smoke columns give the aerial-perspective ladder
 * something to work on: one at ~70 m where the haze blend is ≈ 0.36, one at
 * ~260 m where it is ≈ 0.67.
 */
class AmbientScene implements ScriptedScene {
  readonly seconds = 0.5;
  private readonly cue = new Cue(0);
  private readonly hit = makeRayHit();
  private readonly land = landing();

  run(vfx: IronVfx, elapsed: number, ctx: FrameCtx): void {
    if (!this.cue.due(elapsed)) return;
    castFromCamera(ctx, -0.13, -0.05, 400, 85, this.hit, this.land);
    vfx.smokeColumn(this.land.point, 1.8, 46);
    castFromCamera(ctx, 0.21, -0.01, 900, 280, this.hit, this.land);
    vfx.smokeColumn(this.land.point, 4.6, 60);
  }
}

/* ========================================================================== */

export type VfxSceneName = 'muzzle' | 'explosion' | 'impacts' | 'ambient';

/**
 * Arm a scripted scene. Called from `src/shots/vfx.ts` inside `setup`, before
 * any frame is stepped; a null service (VFX not constructed) is a silent no-op
 * rather than a throw, because a shot file that throws breaks the capture tool
 * for all sixteen lanes at once.
 */
export function armVfxScene(name: VfxSceneName): void {
  const vfx = vfxInstance();
  if (!vfx) return;
  switch (name) {
    case 'muzzle':
      vfx.armScene(new MuzzleScene());
      break;
    case 'explosion':
      vfx.armScene(new ExplosionScene());
      break;
    case 'impacts':
      vfx.armScene(new ImpactScene());
      break;
    case 'ambient':
      vfx.armScene(new AmbientScene());
      break;
    default:
      vfx.armScene(null);
      break;
  }
}
