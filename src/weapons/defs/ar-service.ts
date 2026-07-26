/**
 * `ar_service` — the service rifle. WEAPONS owns this file.
 *
 * This is the game's reference weapon: everything else is tuned as a departure
 * from it. 720 rpm, 30 rounds, a recoil pattern that climbs for five and then
 * walks right, and a 195 ms ADS.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

const MASS_KG = 3.4;

/**
 * The learnable pattern. Index clamps at the end, so a 30-round magazine's
 * last fifteen shots all sit on the final step and the player can hold one
 * correction instead of chasing a moving target.
 *
 * Shape, in order: five shots of near-vertical climb (the shooter has not
 * loaded the stock yet), then a hard walk RIGHT for four, then a slower walk
 * back LEFT. That right-then-left is the property that makes a pattern
 * memorisable — a pattern that only ever goes one way is indistinguishable
 * from a constant offset once the player learns to pull down.
 */
const RECOIL: RecoilPattern = {
  steps: [
    [0.44, 0.02],
    [0.46, -0.06],
    [0.48, 0.05],
    [0.47, 0.14],
    [0.44, 0.22],
    [0.40, 0.31],
    [0.37, 0.34],
    [0.34, 0.28],
    [0.32, 0.08],
    [0.30, -0.16],
    [0.29, -0.28],
    [0.28, -0.31],
    [0.27, -0.22],
    [0.27, -0.05],
    [0.26, 0.12],
  ],
  // Small enough that the pattern still dominates: at ±0.05° the shot-to-shot
  // scatter is a fifth of one pattern step, so a player who has learned the
  // pattern is rewarded and one who has not is not saved by luck.
  randomPitch: 0.05,
  randomYaw: 0.06,
  recovery: recoverySpring(MASS_KG),
  // 90 ms of hang before recovery starts. Without the delay, recovery fights
  // the next shot at 720 rpm (83 ms apart) and the climb flattens into mush.
  recoveryDelay: 0.09,
  // 62% comes back on its own; the other 38% is drift the player must pull
  // down. All-or-nothing at either end is the two failure modes: 1.0 makes
  // recoil free, 0.0 makes a 30-round magazine end pointing at the sky.
  recoveredFraction: 0.62,
  adsMultiplier: 0.82,
};

const SPREAD: SpreadDef = {
  baseHip: 2.35,
  baseAds: 0.19,
  crouchMultiplier: 0.82,
  proneMultiplier: 0.68,
  perShot: 0.115,
  max: 5.1,
  decay: 6.4,
  movementFactor: 0.24,
  airborneMultiplier: 2.4,
};

export function arService(mesh: AssetKey<MeshAsset>): WeaponDef {
  return {
    id: 'ar_service',
    name: 'MK17 SERVICE',
    class: 'ar',
    fireModes: [FireMode.Semi, FireMode.Auto],
    rpm: 720,
    burstCount: 3,
    magazine: 30,
    reserve: 180,
    pelletsPerShot: 1,
    // Tactical keeps the round in the chamber; empty costs the bolt release.
    // The 0.8 s difference is the whole reason a player counts their shots.
    reloadTactical: 2.15,
    reloadEmpty: 2.95,
    deployTime: 0.52,
    spread: SPREAD,
    recoil: RECOIL,
    view: viewFeel({ massKg: MASS_KG, kickScale: 1.0, adsScale: 0.34, bobScale: 1.0 }),
    ads: adsBlock({
      id: 'ar_service',
      time: 0.195,
      fovMultiplier: 0.78,
      sensitivityMultiplier: 0.72,
      magnification: 1,
      eyeRelief: 0.235,
      hip: v3(0.128, -0.132, -0.262),
      hipRotation: v3(0.028, 0.098, -0.030),
    }),
    ballistics: ballistics({
      muzzleVelocity: 880,
      massKg: 0.004,
      retainedAt300: 0.76,
      damage: [
        { distance: 0, damage: 26 },
        { distance: 24, damage: 26 },
        { distance: 55, damage: 21 },
        { distance: 110, damage: 16 },
        { distance: 300, damage: 14 },
      ],
      penetrationEnergy: 880,
      maxPenetrations: 2,
      tracerEvery: 4,
      maxRange: 900,
    }),
    mesh,
    sounds: soundSet('w.rifle.fire'),
    muzzle: muzzleBlock('ar_service', 620_000, 3.6, 8),
    ejection: { offset: v3(0.028, 0.010, 0.060), velocity: v3(2.6, 1.5, 0.5) },
  };
}
