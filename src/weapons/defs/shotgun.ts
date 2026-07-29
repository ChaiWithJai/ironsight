/**
 * `shotgun` — the 12-gauge pump breacher. WEAPONS owns this file.
 *
 * Issue #3 names this weapon explicitly: it used to resolve through `resolveId`
 * to `smg_compact`, which meant "shotgun" in the loadout fired an SMG's ballistics
 * out of an SMG's mesh with an SMG's sound. This is the real thing — nine
 * pellets, a pattern wide enough that MOST of the class fantasy lives in
 * `SpreadDef` rather than in `BallisticsDef.damage`, and a fire rate capped by
 * the pump stroke rather than by any trigger mechanism.
 *
 * THE FIRE MODE IS `Semi`, DELIBERATELY, NOT A NEW MODE. A pump gun cycles once
 * per trigger pull exactly like a semi-auto pistol does — the difference is
 * that a human hand does the cycling instead of gas pressure — and `rpm` below
 * is set low enough (70) that the 857 ms between shots reads as "you have to
 * work the pump," without the engine needing a fifth `FireMode` for one weapon.
 */
import { FireMode, type AssetKey, type MeshAsset, type RecoilPattern, type SpreadDef, type WeaponDef } from '@/engine/types';
import { adsBlock, ballistics, carried, muzzleBlock, recoverySpring, soundSet, v3, viewFeel } from '@/weapons/defs/shared';

const MASS_KG = 3.6;

/**
 * Four steps and they clamp hard, because nobody fires more than four rounds
 * before reloading is the faster option. The kick is roughly six times the
 * SMG's — a 12-gauge shell dumps far more momentum into the shoulder than any
 * rifle round this game models — and the randomness is the widest of any
 * weapon, because a pump gun is never shouldered identically twice.
 */
const RECOIL: RecoilPattern = {
  steps: [
    [2.60, 0.05],
    [2.72, -0.09],
    [2.78, 0.11],
    [2.70, -0.07],
  ],
  randomPitch: 0.18,
  randomYaw: 0.20,
  recovery: recoverySpring(MASS_KG),
  recoveryDelay: 0.14,
  recoveredFraction: 0.72,
  adsMultiplier: 0.85,
};

/**
 * THE SHOT PATTERN LIVES HERE, NOT IN `BallisticsDef`. `ballistics.fire()`
 * samples every pellet from the SAME cone `WeaponState.currentSpreadDeg`
 * describes (see `src/weapons/ballistics.ts`), so `baseHip`/`baseAds` are not
 * "how steady is the shooter" the way they are for a rifle — they are the
 * buckshot pattern's diameter at range. A tight pattern (a rifle's 0.2°) would
 * make nine pellets land within a coin at 10 m; 5.4° hip / 2.2° ADS spreads
 * them across roughly a person's torso width by 8-10 m, which is where a
 * shotgun is supposed to stop being a guaranteed one-shot.
 */
const SPREAD: SpreadDef = {
  baseHip: 5.4,
  baseAds: 2.2,
  // Stance barely matters for a pattern this wide; the small multipliers here
  // are honest rather than a copy-pasted rifle number.
  crouchMultiplier: 0.90,
  proneMultiplier: 0.82,
  perShot: 0.20,
  max: 6.0,
  decay: 10.0,
  movementFactor: 0.10,
  airborneMultiplier: 1.4,
};

export function shotgunBreacher(mesh: AssetKey<MeshAsset>): WeaponDef {
  return {
    id: 'shotgun',
    name: 'TS-12 BREACHER',
    class: 'shotgun',
    fireModes: [FireMode.Semi],
    rpm: 70,
    burstCount: 1,
    magazine: 7,
    // Four tube-loads of spares. A pump gun's whole design cost is that
    // topping it off is slow — see `reloadTactical`/`reloadEmpty` — so a
    // shooter who commits to it commits to fewer total engagements per
    // reload, not to less total ammunition.
    reserve: carried(7, 4),
    // NINE PELLETS. Each one runs the full ballistics/penetration/damage pipe
    // as its own independent projectile — the class fantasy is "up to nine
    // separate rolls of the dice," not one shot with a damage multiplier.
    pelletsPerShot: 9,
    // Slower than every magazine-fed weapon in the game, and that is the
    // point: the tube has no bulk reload, only shell-by-shell, and the
    // engine's one reload phase stands in for that whole slow process.
    reloadTactical: 3.4,
    reloadEmpty: 4.8,
    deployTime: 0.62,
    spread: SPREAD,
    recoil: RECOIL,
    view: viewFeel({ massKg: MASS_KG, kickScale: 1.9, adsScale: 0.50, bobScale: 1.15 }),
    ads: adsBlock({
      id: 'shotgun',
      // Slow and barely worth it: a shotgun's aimed and hip patterns overlap
      // at the ranges it is actually used, so ADS buys composure, not range.
      time: 0.28,
      fovMultiplier: 0.92,
      sensitivityMultiplier: 0.90,
      magnification: 1,
      // The reflex sits low and close over a saddle-clamped receiver rail
      // (`models/build.ts`'s `shotgun` shape), so the eye sits a little closer
      // to it than to the AR's rail-mounted holo.
      eyeRelief: 0.250,
      hip: v3(0.093, -0.100, -0.352),
      hipRotation: v3(0.098, 0.100, -0.038),
    }),
    ballistics: ballistics({
      // 12-gauge 00 buckshot: ~380 m/s, ~1.5 g per pellet.
      muzzleVelocity: 380,
      massKg: 0.0015,
      // Round lead pellets are draggy and shed velocity fast — irrelevant
      // past `maxRange` below, but authored honestly rather than left at a
      // rifle's figure because the field goes unused.
      retainedAt300: 0.55,
      // Per-PELLET damage. At 0-8 m all nine can land, and 9 × 16 is a clean
      // one-shot kill against 100 HP — the shotgun's entire promised
      // identity at breaching range. By 25 m the pattern (not this curve) has
      // already spread most pellets past a torso-sized hitbox, and by 45 m
      // what is left of a stray pellet barely qualifies as a graze.
      damage: [
        { distance: 0, damage: 16 },
        { distance: 8, damage: 16 },
        { distance: 14, damage: 9 },
        { distance: 25, damage: 5 },
        { distance: 45, damage: 3 },
      ],
      // Buckshot does not punch through cover — it is the one weapon in the
      // roster with zero penetrations.
      penetrationEnergy: 150,
      maxPenetrations: 0,
      // No tracers: buckshot is not tracer-loaded and a stream of nine
      // simultaneous ribbons would be visual noise, not information.
      tracerEvery: 0,
      maxRange: 70,
    }),
    mesh,
    sounds: soundSet('w.shotgun.fire'),
    // The biggest flash and the most smoke in the game — a 12-gauge shell
    // burns far more powder per shot than any rifle round modelled here.
    muzzle: muzzleBlock('shotgun', 900_000, 4.6, 20),
    // A 12-gauge hull is bigger and heavier than a rifle casing and tumbles
    // out slower.
    ejection: { offset: v3(0.030, 0.010, 0.058), velocity: v3(2.0, 1.0, 0.3) },
  };
}
