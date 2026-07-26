/**
 * Shared authoring helpers for the `WeaponDef` tables. WEAPONS owns this file.
 *
 * NO MAGIC NUMBER ESCAPES `src/weapons/defs/`. Every constant that controls how
 * a weapon feels — spread, recoil, the sway and bob gains, the ADS curve — is a
 * field of `WeaponDef`, and the rig composes them. That is the whole reason
 * `WeaponFeelState.update` is specified as "one place": a feel change is a data
 * edit here, not a hunt through four files.
 *
 * The helpers below exist because most of a weapon's feel is a CONSEQUENCE of
 * two physical facts — how heavy it is and how fast it cycles — and deriving
 * the springs from mass keeps a heavy gun heavy in every one of the eight
 * places heaviness shows up.
 */
import * as THREE from 'three';
import {
  HitZone,
  type AdsDef,
  type BallisticsDef,
  type DamageCurvePoint,
  type SpringParams,
  type Vec3,
  type ViewFeelDef,
  type WeaponId,
  type WeaponSoundSet,
} from '@/engine/types';
import { muzzleZOf, sightPointOf } from '@/weapons/models/build';

export const v3 = (x: number, y: number, z: number): Vec3 => new THREE.Vector3(x, y, z);

/**
 * Hit-zone multipliers. One table for every weapon in the game: a rifle that
 * headshots for 2.6× and a DMR that headshots for 3.1× is a balance decision
 * nobody can hold in their head, and the brief is not asking for one.
 */
export const ZONE_MULTIPLIERS: Readonly<Record<HitZone, number>> = {
  /** An unrigged prop or the world: AI owns the only rig that reports a zone. */
  [HitZone.None]: 1.0,
  [HitZone.Head]: 2.55,
  [HitZone.Torso]: 1.0,
  [HitZone.Stomach]: 1.05,
  [HitZone.Arm]: 0.82,
  [HitZone.Leg]: 0.78,
};

/**
 * A spring whose response scales with the mass of the thing it is moving.
 *
 * `damping` deliberately sits at 0.55–0.75 rather than 1.0: a critically-damped
 * kick returns to zero and stops, which reads as a snap-back. Underdamped, the
 * muzzle overshoots BELOW the line of sight on the way home and settles from
 * underneath, and that undershoot is the single most recognisable property of
 * good recoil in a shipped shooter.
 */
export function kickSpring(massKg: number, damping = 0.62): SpringParams {
  return {
    // ~1100 for a 3 kg carbine, ~800 for a 7 kg LMG: a heavier weapon takes
    // longer to come back, because it does.
    stiffness: 3300 / massKg,
    damping,
    mass: 1,
  };
}

/** Sway is a slower, softer spring than kick — it LAGS, it does not snap. */
export function swaySpring(massKg: number): SpringParams {
  return { stiffness: 175 / Math.sqrt(massKg), damping: 0.78, mass: 1 };
}

/** The sim-side recoil recovery spring. Slower than the cosmetic one. */
export function recoverySpring(massKg: number): SpringParams {
  return { stiffness: 62 / Math.sqrt(massKg), damping: 0.92, mass: 1 };
}

export interface FeelOptions {
  readonly massKg: number;
  /** Metres of muzzle rise per shot, cosmetic. Scales the whole kick. */
  readonly kickScale: number;
  readonly adsScale: number;
  readonly bobScale: number;
}

/**
 * The cosmetic feel block. Everything here is in metres/radians of VIEWMODEL
 * offset and never touches where a bullet goes.
 */
export function viewFeel(o: FeelOptions): ViewFeelDef {
  const k = o.kickScale;
  return {
    cameraKick: kickSpring(o.massKg, 0.58),
    // Pitch up, a little yaw off the bore axis, a touch of roll. Roll is what
    // makes a kick read as a weapon being fired by a person rather than a
    // turret moving on rails.
    cameraKickImpulse: v3(0.0135 * k, -0.0034 * k, 0.0052 * k),
    weaponKick: kickSpring(o.massKg, 0.55),
    // Straight back into the shoulder and slightly up-right: the receiver
    // travels rearward far more than it rises, which is what separates recoil
    // from "the gun pivots about the muzzle".
    weaponKickPos: v3(0.0034 * k, 0.0048 * k, 0.0165 * k),
    weaponKickRot: v3(0.052 * k, -0.014 * k, 0.020 * k),
    sway: {
      // Metres and radians of offset per rad/s of look rate. The weapon trails
      // the look, so the gains are NEGATED where they are applied.
      gain: v3(0.055, 0.042, 0.085),
      spring: swaySpring(o.massKg),
      maxOffset: 0.05,
      adsScale: o.adsScale,
    },
    bob: {
      // x = lateral, y = vertical, z = roll (radians). A figure-eight, not a
      // sine: the vertical runs at twice the lateral frequency, which is what
      // makes it read as two footfalls per cycle.
      walk: v3(0.0125 * o.bobScale, 0.0092 * o.bobScale, 0.0125 * o.bobScale),
      sprint: v3(0.0295 * o.bobScale, 0.0215 * o.bobScale, 0.0420 * o.bobScale),
      // 0.62 cycles per metre ≈ a 1.6 m stride, so bob stays in step with
      // footfalls at ANY speed instead of drifting against them.
      cyclesPerMetre: 0.62,
      landImpulse: 0.115,
      adsScale: 0.22,
    },
    lean: { maxDeg: 14, offset: 0.14, speed: 7.5 },
    // Never perfectly still. 0.22 Hz is a resting respiration rate; the
    // amplitude is ~1 mm, invisible as motion and unmistakable as life.
    breathe: { amplitude: 0.0011, frequencyHz: 0.22, holdScale: 0.12 },
    sprintPose: {
      // Muzzle down and canted across the body — the universal "not ready to
      // fire" read, and the pose the sprint-to-fire penalty is paid out of.
      position: v3(0.012, -0.062, 0.045),
      rotation: v3(-0.42, 0.52, 0.30),
      blendTime: 0.19,
    },
  };
}

export interface AdsOptions {
  readonly id: WeaponId;
  /** Seconds. The brief's band is 180–220 ms for a rifle. */
  readonly time: number;
  readonly fovMultiplier: number;
  readonly sensitivityMultiplier: number;
  readonly magnification: number;
  /** Metres from the eye to the optic's aiming point at full ADS. */
  readonly eyeRelief: number;
  readonly hip: Vec3;
  readonly hipRotation: Vec3;
}

/**
 * The ADS block, with `adsOffset` DERIVED from the model's sight point.
 *
 * This is the one number in the whole lane that must be exact: if the optic's
 * aiming axis does not pass through the eye, the reticle sits off the screen
 * centre and every shot the player takes lands somewhere other than where the
 * sight says. Deriving it from `sightPointOf` means moving the optic 2 mm up
 * in `build.ts` re-aligns the sight instead of silently breaking it.
 */
export function adsBlock(o: AdsOptions): AdsDef {
  const sight = sightPointOf(o.id);
  return {
    time: o.time,
    // Eased, not linear. `outExpo` front-loads the movement so the sight is
    // most of the way up within 90 ms and settles into the last 10% — which is
    // what makes a 200 ms transition feel like 120 ms without being faster.
    curve: 'outExpo',
    fovMultiplier: o.fovMultiplier,
    sensitivityMultiplier: o.sensitivityMultiplier,
    hipOffset: o.hip,
    hipRotation: o.hipRotation,
    // Put the sight point exactly on the camera axis, `eyeRelief` in front.
    adsOffset: v3(0, -sight.y, -(o.eyeRelief + sight.z)),
    adsRotation: v3(0, 0, 0),
    magnification: o.magnification,
  };
}

export interface BallisticsOptions {
  readonly muzzleVelocity: number;
  readonly massKg: number;
  /** Fraction of muzzle velocity retained at 300 m. Drag is solved from it. */
  readonly retainedAt300: number;
  readonly damage: readonly DamageCurvePoint[];
  readonly penetrationEnergy: number;
  readonly maxPenetrations: number;
  readonly tracerEvery: number;
  readonly maxRange: number;
}

/**
 * Solve the drag coefficient from a retained-velocity figure instead of asking
 * an author for a `k` in a `dv/dt = −k·v²` model, which is a number nobody has
 * intuition for. For that model `v(t) = v0 / (1 + k·v0·t)`, so a 300 m time of
 * flight and a retained fraction pin `k` exactly.
 */
export function ballistics(o: BallisticsOptions): BallisticsDef {
  const r = Math.min(0.98, Math.max(0.4, o.retainedAt300));
  // Mean velocity over the run, used only to turn 300 m into a time of flight.
  const meanV = o.muzzleVelocity * (1 + r) * 0.5;
  const t300 = 300 / meanV;
  const dragCoefficient = (1 / r - 1) / (o.muzzleVelocity * t300);
  return {
    muzzleVelocity: o.muzzleVelocity,
    massKg: o.massKg,
    dragCoefficient,
    gravityScale: 1,
    maxRange: o.maxRange,
    damage: o.damage,
    zoneMultipliers: ZONE_MULTIPLIERS,
    penetrationEnergy: o.penetrationEnergy,
    maxPenetrations: o.maxPenetrations,
    tracerEvery: o.tracerEvery,
  };
}

export function soundSet(fire: WeaponSoundSet['fire']): WeaponSoundSet {
  return {
    fire,
    fireDistant: 'w.distant',
    tail: 'w.tail',
    dryFire: 'w.dry',
    magOut: 'w.magout',
    magIn: 'w.magin',
    bolt: 'w.bolt',
    ads: 'w.ads',
  };
}

/** Muzzle block, with the flash position derived from the barrel length. */
export function muzzleBlock(
  id: WeaponId,
  flashIntensityCd: number,
  flashRadius: number,
  smokeRate: number,
): {
  offset: Vec3;
  flashIntensityCd: number;
  flashRadius: number;
  flashDuration: number;
  smokeRate: number;
} {
  return {
    offset: v3(0, 0, muzzleZOf(id)),
    flashIntensityCd,
    flashRadius,
    // 28 ms: one to two frames at 60 Hz, which is what the flash actually is.
    // Anything longer reads as a lamp taped to the barrel.
    flashDuration: 0.028,
    smokeRate,
  };
}
