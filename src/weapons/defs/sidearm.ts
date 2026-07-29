/**
 * `sidearm` — the 9 mm service pistol. WEAPONS owns this file.
 *
 * Issue #3 names this weapon explicitly alongside the shotgun: it used to
 * resolve through `resolveId` to `smg_compact`, so equipping the "sidearm" slot
 * handed a player an SMG in miniature rather than a genuine backup weapon.
 *
 * THE CLASS FANTASY IS SPEED, NOT POWER. Every stat below is weaker than
 * `smg_compact`'s — less damage, less magazine, a shorter reach — except the
 * one that defines a sidearm: `deployTime` is the fastest in the game, because
 * the entire reason to carry one is that it is already in your hand while the
 * primary is still reloading.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, carried, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

const MASS_KG = 0.95;

/**
 * Light and snappy: six shots of small, fast-recovering kick. A pistol this
 * size has almost nothing to brace it, so the pattern jitters more per shot
 * than the AR's relative to its own amplitude, but the whole thing is small
 * enough that a player who ignores it entirely is still hitting a torso at
 * pistol ranges.
 */
const RECOIL: RecoilPattern = {
  steps: [
    [0.62, 0.06],
    [0.66, -0.10],
    [0.68, 0.09],
    [0.66, -0.07],
    [0.64, 0.05],
    [0.62, -0.04],
  ],
  randomPitch: 0.11,
  randomYaw: 0.13,
  recovery: recoverySpring(MASS_KG),
  recoveryDelay: 0.05,
  recoveredFraction: 0.80,
  adsMultiplier: 0.88,
};

const SPREAD: SpreadDef = {
  // Wider hip cone than the SMG's: no stock, no shoulder brace, just a wrist.
  baseHip: 3.2,
  baseAds: 0.62,
  crouchMultiplier: 0.82,
  proneMultiplier: 0.70,
  perShot: 0.14,
  max: 4.2,
  decay: 9.0,
  movementFactor: 0.16,
  airborneMultiplier: 1.9,
};

export function sidearmService(mesh: AssetKey<MeshAsset>): WeaponDef {
  return {
    id: 'sidearm',
    name: 'PX-9 SIDEARM',
    class: 'pistol',
    fireModes: [FireMode.Semi],
    // The mechanical ceiling on a striker-fired trigger reset, not a
    // meaningful "fire rate" the way `Auto` weapons have one.
    rpm: 380,
    burstCount: 1,
    magazine: 15,
    // Three spares. Nobody fights a match on a sidearm alone — it exists to
    // bridge the gap while the primary reloads, and its own economy is
    // deliberately the smallest in the game.
    reserve: carried(15, 3),
    pelletsPerShot: 1,
    // The fastest reload AND the fastest deploy in the roster: a compact
    // single-stack-adjacent service pistol reloads and comes up in well under
    // half the time the service rifle needs.
    reloadTactical: 1.35,
    reloadEmpty: 1.65,
    deployTime: 0.28,
    spread: SPREAD,
    recoil: RECOIL,
    view: viewFeel({ massKg: MASS_KG, kickScale: 0.50, adsScale: 0.30, bobScale: 0.70 }),
    ads: adsBlock({
      id: 'sidearm',
      // The fastest ADS in the game: there is barely any weapon to bring up.
      time: 0.130,
      fovMultiplier: 0.90,
      sensitivityMultiplier: 0.88,
      magnification: 1,
      // A slide-mounted micro red dot sits close over a low-profile frame
      // (`models/build.ts`'s `pistol` shape) — the closest eye relief in the
      // roster, because there is far less gun between the eye and the sight.
      eyeRelief: 0.235,
      hip: v3(0.082, -0.078, -0.290),
      hipRotation: v3(0.090, 0.088, -0.032),
    }),
    ballistics: ballistics({
      // 9×19 mm: ~360 m/s, ~8 g bullet.
      muzzleVelocity: 360,
      massKg: 0.008,
      // A pistol bullet sheds velocity faster than any rifle round here —
      // it is the least aerodynamic projectile in the game.
      retainedAt300: 0.60,
      // The weakest damage curve in the roster, on purpose: a sidearm that
      // matched the SMG it is a fallback FOR would erase the reason to carry
      // a primary weapon at all.
      damage: [
        { distance: 0, damage: 20 },
        { distance: 12, damage: 20 },
        { distance: 30, damage: 14 },
        { distance: 70, damage: 10 },
        { distance: 150, damage: 8 },
      ],
      // Barely punches through anything, and never twice.
      penetrationEnergy: 150,
      maxPenetrations: 1,
      // No tracers: pistol ammunition is never tracer-loaded in this loadout.
      tracerEvery: 0,
      maxRange: 180,
    }),
    mesh,
    sounds: soundSet('w.pistol.fire'),
    // The smallest flash and the least smoke in the game — the least powder
    // burned per shot of any weapon modelled here.
    muzzle: muzzleBlock('sidearm', 260_000, 2.0, 4),
    // A small, light 9 mm casing, ejecting fast and close.
    ejection: { offset: v3(0.020, 0.007, 0.034), velocity: v3(2.0, 1.2, 0.4) },
  };
}
