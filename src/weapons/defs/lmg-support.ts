/**
 * `lmg_support` — the belt-fed support weapon. WEAPONS owns this file.
 *
 * The departure from the service rifle: 100 rounds, a six-second reload, and a
 * recoil pattern that WANDERS rather than climbing. The class fantasy is
 * suppression, so the design cost is that the first shot out of a sprint is
 * hopeless and the twentieth from prone is not.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, carried, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

const MASS_KG = 7.8;

/**
 * Twenty steps of low-amplitude wander. Each step is smaller than the AR's, but
 * the pattern never settles into a straight line — the horizontal component
 * changes sign four times — so a long burst is controllable only by a player
 * who is actively working the correction. That is the difference between a
 * suppression weapon and a rifle with a big magazine.
 */
const RECOIL: RecoilPattern = {
  steps: [
    [0.52, 0.00],
    [0.50, 0.10],
    [0.47, 0.20],
    [0.43, 0.26],
    [0.39, 0.22],
    [0.36, 0.09],
    [0.34, -0.09],
    [0.32, -0.24],
    [0.31, -0.31],
    [0.30, -0.27],
    [0.29, -0.12],
    [0.28, 0.07],
    [0.28, 0.23],
    [0.27, 0.30],
    [0.27, 0.25],
    [0.26, 0.10],
    [0.26, -0.10],
    [0.26, -0.25],
    [0.25, -0.29],
    [0.25, -0.18],
  ],
  randomPitch: 0.07,
  randomYaw: 0.11,
  recovery: recoverySpring(MASS_KG),
  recoveryDelay: 0.07,
  recoveredFraction: 0.55,
  // Deployed on the bipod the pattern halves. This is the number the class is
  // balanced on: it makes a stationary gunner genuinely different from a
  // moving one, without a separate deploy mechanic.
  adsMultiplier: 0.58,
};

const SPREAD: SpreadDef = {
  baseHip: 4.4,
  baseAds: 0.32,
  crouchMultiplier: 0.74,
  // Prone is where this weapon lives, so prone is where the reward is.
  proneMultiplier: 0.44,
  perShot: 0.085,
  max: 6.6,
  decay: 4.0,
  movementFactor: 0.34,
  airborneMultiplier: 3.6,
};

export function lmgSupport(mesh: AssetKey<MeshAsset>): WeaponDef {
  return {
    id: 'lmg_support',
    name: 'M250 SUPPORT',
    class: 'lmg',
    fireModes: [FireMode.Auto],
    rpm: 650,
    burstCount: 3,
    magazine: 100,
    // FOUR BELTS, not seven. The class trade is the opposite of the rifle's:
    // half the reloads, twice the rounds, and each reload costs 5.2-6.6 s. 500
    // rounds is a genuine suppression budget and the reason to carry it.
    reserve: carried(100, 4),
    pelletsPerShot: 1,
    // A belt is not a magazine: there is no tactical reload worth the name, so
    // the two timings are close together and both are punishing.
    reloadTactical: 5.20,
    reloadEmpty: 6.60,
    deployTime: 1.05,
    spread: SPREAD,
    recoil: RECOIL,
    view: viewFeel({ massKg: MASS_KG, kickScale: 1.28, adsScale: 0.42, bobScale: 1.35 }),
    ads: adsBlock({
      id: 'lmg_support',
      // Well outside the brief's 180–220 ms rifle band, deliberately: the ADS
      // time IS the weight of the weapon in the player's hands.
      time: 0.312,
      fovMultiplier: 0.84,
      sensitivityMultiplier: 0.78,
      magnification: 1,
      eyeRelief: 0.245,
      // Solved against the same framing contract as `ar-service.ts`: optic at
      // (67%, 68.5%) — deliberately the LOWEST of the four, because a 7 kg
      // belt-fed gun is carried below the line of sight and that is most of
      // what makes it read as heavy before it has even been fired.
      hip: v3(0.097, -0.104, -0.408),
      hipRotation: v3(0.095, 0.092, -0.034),
    }),
    ballistics: ballistics({
      muzzleVelocity: 850,
      massKg: 0.0095,
      retainedAt300: 0.84,
      damage: [
        { distance: 0, damage: 30 },
        { distance: 40, damage: 30 },
        { distance: 120, damage: 24 },
        { distance: 260, damage: 19 },
        { distance: 600, damage: 17 },
      ],
      penetrationEnergy: 2050,
      maxPenetrations: 3,
      // Every fifth round, and it is a feature: an LMG's tracer stream is what
      // makes suppression legible to the person being suppressed.
      tracerEvery: 5,
      maxRange: 1100,
    }),
    mesh,
    sounds: soundSet('w.lmg.fire'),
    muzzle: muzzleBlock('lmg_support', 780_000, 4.1, 16),
    ejection: { offset: v3(0.034, 0.006, 0.055), velocity: v3(2.9, 1.1, 0.4) },
  };
}
