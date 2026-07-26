/**
 * `dmr_marksman` — the semi-automatic marksman rifle. WEAPONS owns this file.
 *
 * The departure from the service rifle: three times the kick, a quarter of the
 * spread, a 4× optic and a 260 ms ADS you feel. It is the weapon that makes
 * `BallisticsDef.dragCoefficient` visible — at 400 m the drop is ~1.6 m and the
 * flight time is a third of a second, so leading a moving target is real.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

const MASS_KG = 4.6;

/**
 * A semi-auto's pattern is short by construction — nobody fires twelve aimed
 * shots in two seconds — so it is authored as four distinct steps and then
 * clamps. Almost pure vertical: a heavy in-line rifle in a shoulder pocket has
 * very little to yaw about.
 */
const RECOIL: RecoilPattern = {
  steps: [
    [1.30, 0.05],
    [1.42, -0.11],
    [1.48, 0.13],
    [1.52, -0.07],
  ],
  randomPitch: 0.08,
  randomYaw: 0.10,
  recovery: recoverySpring(MASS_KG),
  recoveryDelay: 0.12,
  // Higher than the AR: a marksman rifle that walks off target after three
  // shots cannot do the job the class exists for.
  recoveredFraction: 0.88,
  adsMultiplier: 0.74,
};

const SPREAD: SpreadDef = {
  baseHip: 3.9,
  // Effectively zero at the sight: the DMR's accuracy story is that a scoped
  // shot goes exactly where the reticle is, and its cost is the fire rate.
  baseAds: 0.035,
  crouchMultiplier: 0.72,
  proneMultiplier: 0.52,
  perShot: 0.44,
  max: 6.2,
  decay: 4.8,
  movementFactor: 0.40,
  airborneMultiplier: 3.2,
};

export function dmrMarksman(mesh: AssetKey<MeshAsset>): WeaponDef {
  return {
    id: 'dmr_marksman',
    name: 'SR-12 MARKSMAN',
    class: 'dmr',
    fireModes: [FireMode.Semi],
    // The mechanical ceiling, not the trigger rate: semi still needs a release.
    rpm: 380,
    burstCount: 1,
    magazine: 20,
    reserve: 100,
    pelletsPerShot: 1,
    reloadTactical: 2.45,
    reloadEmpty: 3.30,
    deployTime: 0.72,
    spread: SPREAD,
    recoil: RECOIL,
    view: viewFeel({ massKg: MASS_KG, kickScale: 2.35, adsScale: 0.22, bobScale: 1.15 }),
    ads: adsBlock({
      id: 'dmr_marksman',
      time: 0.262,
      // 4× glass: the world FOV drops to a third and DOF gates on `adsBlend`.
      fovMultiplier: 0.30,
      sensitivityMultiplier: 0.34,
      magnification: 4,
      // Longer eye relief than a red dot — a scoped rifle is held further out,
      // and the eyepiece has to clear the brow.
      eyeRelief: 0.205,
      hip: v3(0.140, -0.148, -0.240),
      hipRotation: v3(0.036, 0.106, -0.036),
    }),
    ballistics: ballistics({
      muzzleVelocity: 840,
      massKg: 0.0097,
      // A heavier, better-shaped bullet keeps far more of its speed than 5.56.
      retainedAt300: 0.86,
      damage: [
        { distance: 0, damage: 58 },
        { distance: 60, damage: 58 },
        { distance: 180, damage: 50 },
        { distance: 400, damage: 44 },
        { distance: 900, damage: 40 },
      ],
      penetrationEnergy: 2400,
      maxPenetrations: 3,
      // A marksman does not advertise his position: no tracers, ever.
      tracerEvery: 0,
      maxRange: 1400,
    }),
    mesh,
    sounds: soundSet('w.dmr.fire'),
    muzzle: muzzleBlock('dmr_marksman', 940_000, 4.4, 12),
    ejection: { offset: v3(0.028, 0.012, 0.070), velocity: v3(3.1, 1.7, 0.6) },
  };
}
