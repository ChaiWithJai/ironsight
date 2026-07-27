/**
 * `ar_service` — the service rifle. WEAPONS owns this file.
 *
 * This is the game's reference weapon: everything else is tuned as a departure
 * from it. 720 rpm, 30 rounds, a recoil pattern that climbs for five and then
 * walks right, and a 195 ms ADS.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, carried, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

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
    // Seven spare magazines — the rifleman's basic load, and the reference the
    // other three weapons are balanced against. See `carried` in `shared.ts`.
    reserve: carried(30, 7),
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
      /*
       * ROUND 5 TOOK EYE RELIEF FROM 0.235 TO 0.300, AND IT IS A COMPOSITION
       * NUMBER RATHER THAN AN ERGONOMIC ONE.
       *
       * `adsBlock` puts the sight point exactly this far in front of the eye, so
       * this single figure sets how much of the frame the optic owns. At 0.235
       * the 56 mm housing subtended 23 % of frame HEIGHT. The corpus's only
       * clean iron-sight ADS frame, `bf2042_gp_000`, puts its sight at 12 %, and
       * `bf6_gp_004`'s holo at 14 %; 23 % is not a sight picture, it is a sight
       * filling the screen, and it drags two other things with it. The rear of
       * the receiver ended up level with the eye, so the near field was an
       * exploding 30 %-wide wedge of receiver top at 80 mm — the worst distance
       * in the frame for the DOF near clamp — and the support hand, 22 cm out,
       * fell entirely behind that wedge.
       *
       * 0.300 puts the housing at 17 %, the receiver's breech face 60 mm in
       * front of the eye rather than level with it, and the weapon column at
       * roughly the width the reference frames carry. Nothing about the weapon
       * changed; the eye moved back, which is what a shooter's head does.
       */
      eyeRelief: 0.300,
      // SOLVED, not dialled in, and then checked against a render. Through the
      // viewmodel camera's fixed 55° vertical FOV at 16:9 this puts the optic at
      // (66%, 58.5%), the muzzle up and inboard of it at (55%, 59%) and the
      // support hand at (55%, 69%) — the layout of
      // `reference/gameplay/bf6_gp_004.jpg`.
      //
      // The two numbers that matter are the ones that are NOT obvious. `z` is
      // what sets apparent SIZE: the optic ends up 32 cm from the eye, and at
      // 26 cm the weapon is so large it stops reading as a held object. `y` sets
      // the DOWN-ANGLE onto the rail — 14.6° here. Push it to 22° and the frame
      // is all receiver top face, which is the least informative surface on the
      // weapon and the one with no silhouette at all.
      //
      // The values before this sat the optic at (87%, 82%) — in the corner of
      // the screen, which is worse than no viewmodel at all.
      hip: v3(0.088, -0.090, -0.386),
      hipRotation: v3(0.100, 0.100, -0.040),
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
