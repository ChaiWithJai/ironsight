/**
 * `smg_compact` — the close-quarters PDW. WEAPONS owns this file.
 *
 * The departure from the service rifle: the fastest ADS and the fastest reload
 * in the game, twice the hip-fire accuracy, and damage that falls off a cliff
 * past 40 m. Everything about it is tuned so that the answer to "who wins at
 * 8 m" is the SMG and the answer to "who wins at 80 m" is anything else.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, carried, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

const MASS_KG = 2.7;

/**
 * Fast and shallow. At 900 rpm the shots are 67 ms apart, which is inside the
 * recovery delay, so the pattern is what the player sees and the recovery
 * spring barely gets a word in until the trigger comes off.
 */
const RECOIL: RecoilPattern = {
  steps: [
    [0.31, -0.10],
    [0.33, -0.18],
    [0.34, -0.22],
    [0.33, -0.16],
    [0.32, -0.02],
    [0.31, 0.14],
    [0.30, 0.24],
    [0.30, 0.27],
    [0.29, 0.21],
    [0.29, 0.06],
    [0.28, -0.11],
    [0.28, -0.21],
  ],
  randomPitch: 0.09,
  randomYaw: 0.12,
  recovery: recoverySpring(MASS_KG),
  recoveryDelay: 0.075,
  recoveredFraction: 0.70,
  adsMultiplier: 0.86,
};

const SPREAD: SpreadDef = {
  // Half the AR's hip cone: this is the weapon you fire from the hip.
  baseHip: 1.55,
  baseAds: 0.34,
  crouchMultiplier: 0.88,
  proneMultiplier: 0.80,
  perShot: 0.095,
  max: 4.6,
  decay: 8.2,
  // Barely punished for moving, which is the other half of the class identity.
  movementFactor: 0.11,
  airborneMultiplier: 1.7,
};

export function smgCompact(mesh: AssetKey<MeshAsset>): WeaponDef {
  return {
    id: 'smg_compact',
    name: 'PW-9 COMPACT',
    class: 'smg',
    fireModes: [FireMode.Semi, FireMode.Burst, FireMode.Auto],
    rpm: 900,
    burstCount: 3,
    magazine: 32,
    // Same seven spares as the rifle. The SMG empties them faster at 900 rpm,
    // which is the cost of the fire rate rather than a shorter war.
    reserve: carried(32, 7),
    pelletsPerShot: 1,
    reloadTactical: 1.72,
    reloadEmpty: 2.34,
    deployTime: 0.38,
    spread: SPREAD,
    recoil: RECOIL,
    view: viewFeel({ massKg: MASS_KG, kickScale: 0.72, adsScale: 0.44, bobScale: 0.86 }),
    ads: adsBlock({
      id: 'smg_compact',
      time: 0.148,
      fovMultiplier: 0.86,
      sensitivityMultiplier: 0.82,
      magnification: 1,
      eyeRelief: 0.215,
      // Solved against the same framing contract as `ar-service.ts`: optic at
      // (67%, 67%), held closer and higher than the rifle because a PDW is
      // shouldered short and its optic sits 6 mm lower over the bore.
      hip: v3(0.087, -0.086, -0.344),
      hipRotation: v3(0.095, 0.095, -0.036),
    }),
    ballistics: ballistics({
      muzzleVelocity: 400,
      massKg: 0.0075,
      // A subsonic-ish pistol round is draggy and slow: 0.28 s to 100 m, which
      // is long enough that a sprinting target genuinely has to be led.
      retainedAt300: 0.70,
      damage: [
        { distance: 0, damage: 24 },
        { distance: 14, damage: 24 },
        { distance: 34, damage: 17 },
        { distance: 60, damage: 12 },
        { distance: 200, damage: 10 },
      ],
      // Pistol calibre stops at the first wall, and that is the point.
      penetrationEnergy: 260,
      maxPenetrations: 1,
      tracerEvery: 6,
      maxRange: 400,
    }),
    mesh,
    sounds: soundSet('w.smg.fire'),
    muzzle: muzzleBlock('smg_compact', 420_000, 2.9, 6),
    ejection: { offset: v3(0.026, 0.008, 0.048), velocity: v3(2.3, 1.4, 0.4) },
  };
}
