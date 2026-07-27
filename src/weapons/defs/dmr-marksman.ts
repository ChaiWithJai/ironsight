/**
 * `dmr_marksman` — the semi-automatic marksman rifle. WEAPONS owns this file.
 *
 * The departure from the service rifle: three times the kick, a quarter of the
 * spread, a 4× optic and a 260 ms ADS you feel. It is the weapon that makes
 * `BallisticsDef.dragCoefficient` visible — at 400 m the drop is ~1.6 m and the
 * flight time is a third of a second, so leading a moving target is real.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, carried, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

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
    // Seven spares again: a marksman fires far fewer rounds per kill, so the
    // same magazine count is a much longer fight. 160 rounds total.
    reserve: carried(20, 7),
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
      // Solved against the same framing contract as `ar-service.ts`: optic at
      // (65%, 65%) and pushed 2.5 cm further out than the rifle, because a 20"
      // marksman rifle is genuinely longer and a shooter holds it further from
      // the chest to balance it.
      hip: v3(0.085, -0.098, -0.409),
      hipRotation: v3(0.105, 0.104, -0.044),
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
