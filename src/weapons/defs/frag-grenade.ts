/**
 * `frag` — the fragmentation grenade. WEAPONS owns this file.
 *
 * Every tunable for the throwable lives here, the same rule the four ballistic
 * weapons follow: NO MAGIC NUMBER ESCAPES `src/weapons/defs/`. The system in
 * `src/weapons/throwables.ts` reads this table and contains no constants of its
 * own beyond pool sizes.
 *
 * THE TWO DAMAGE CHANNELS, AND WHY THERE ARE TWO
 * ----------------------------------------------
 * A frag kills soldiers and inconveniences walls. If one number drove both,
 * either a grenade one-shots a concrete barrier or it tickles a man standing on
 * top of it. Shipped shooters carry a separate "vs structure" figure for exactly
 * this reason, and so does this: `peakDamage` (anti-personnel, falls off over
 * `damageRadius`) and `structureDamage` (applied flat inside the much smaller
 * `breachRadius`, then multiplied by the material's own `explosiveMultiplier`).
 *
 * The structure figure is sized against `src/level/colliders.ts`, which gives a
 * destructible `volume x healthPerM3` HP:
 *
 *   brick   1150 HP/m3, x4.8  ->  900 x 4.8 = 4320  breaches up to 3.7 m3
 *   concrete 1700 HP/m3, x4.2 ->  900 x 4.2 = 3780  breaches up to 2.2 m3
 *   sandbag  900 HP/m3, x3.4  ->  900 x 3.4 = 3060  breaches up to 3.4 m3
 *
 * ...so one frag opens a hole in a parapet, a sandbag emplacement or a stucco
 * partition, and a heavy concrete barrier takes two. Damage ACCUMULATES in
 * `DestructionService`, so the second one always finishes the job.
 *
 * THE FUSE STARTS WHEN THE PIN IS PULLED, NOT WHEN THE GRENADE LEAVES THE HAND.
 * That is what makes cooking a mechanic rather than a delay: hold it and it
 * detonates sooner after it lands, at the cost of holding a live grenade. At
 * `maxCook` it leaves the hand on its own at full power — a cook-off that kills
 * the thrower is authentic and unteachable, and it would make every scripted and
 * headless run of this feature end in a suicide.
 */
import { SurfaceId, type SoundId, type ThrowableId } from '@/engine/types';

export interface ThrowableDef {
  readonly id: ThrowableId;
  readonly name: string;
  /** Units carried on a fresh spawn. Matches the HUD throwable row's stock. */
  readonly capacity: number;

  /* ---- the fuse ------------------------------------------------------- */
  /** Seconds from PIN PULL to detonation, in the hand or in the air. */
  readonly fuseSeconds: number;
  /**
   * Longest hold before the throw releases itself, seconds. Below `fuseSeconds`
   * by enough that a full cook still arcs clear of the thrower.
   */
  readonly maxCook: number;
  /** Seconds after a throw before the next one can be started. */
  readonly refractorySeconds: number;

  /* ---- the throw ------------------------------------------------------ */
  /** m/s along the aim axis at full power. */
  readonly throwSpeed: number;
  /**
   * Fraction of `throwSpeed` a single-tick TAP throws at. A tap should place a
   * grenade over the crate in front of you, not at your feet and not across the
   * square, and it must never be zero: an intent producer that sets the button
   * for one tick — the harness, a scripted soak, a gamepad with a flaky
   * contact — would otherwise drop a live grenade on the thrower's boots.
   */
  readonly minPower: number;
  /** Seconds of hold over which power ramps `minPower` -> 1. */
  readonly chargeSeconds: number;
  /** Degrees the launch axis is lifted above the aim axis. The arc. */
  readonly launchLoftDeg: number;
  /** Share of the thrower's own velocity added to the launch. */
  readonly inheritVelocity: number;
  /** Metres in front of the eye the grenade appears. Clear of the own capsule. */
  readonly muzzleForward: number;
  /** Metres below the eye it appears. A hand, not a forehead. */
  readonly muzzleDrop: number;
  /** rad/s of tumble imparted on release, so it does not fly like a bullet. */
  readonly spinRateRad: number;

  /* ---- the body ------------------------------------------------------- */
  readonly radius: number;
  readonly massKg: number;
  /** 0 = dead thud, 1 = superball. A steel body on stone is lively but not bouncy. */
  readonly restitution: number;
  readonly friction: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly surface: SurfaceId;

  /* ---- the burst ------------------------------------------------------ */
  /** Damage at or inside `lethalRadius`, before line-of-sight attenuation. */
  readonly peakDamage: number;
  /** Metres of full-damage core. */
  readonly lethalRadius: number;
  /** Metres at which anti-personnel damage reaches zero. */
  readonly damageRadius: number;
  /** Falloff exponent between the two radii. >1 keeps the edge survivable. */
  readonly falloffExponent: number;
  /**
   * Metres of blast that damages STRUCTURE. Much smaller than `damageRadius`:
   * fragments travel, overpressure against masonry does not.
   */
  readonly breachRadius: number;
  readonly structureDamage: number;
  /** Joules quoted on the DamageInfo. Ragdoll impulse and chip spall read it. */
  readonly energyJ: number;
  /** Peak impulse handed to `PhysicsService.applyRadialImpulse`, N.s. */
  readonly impulseNs: number;
  /** Metres the burst origin is lifted off the resting body for LOS + falloff. */
  readonly burstHeight: number;
  /** dB SPL at 1 m, for `noise.emitted`. A grenade is ~164 dB. */
  readonly loudnessDb: number;

  /* ---- presentation --------------------------------------------------- */
  /**
   * `radius` handed to `FxEventMap['explosion']`. NOT the damage radius —
   * `src/vfx/library.ts` derives the visible fireball as `radius * 0.62` clamped
   * to 3.2-9 m, and 12 is the figure `VfxId 'explosion.large'` itself passes.
   * Keeping them equal is what makes a thrown frag read as the same explosion
   * the VFX lane's own hero shot captures.
   */
  readonly vfxRadius: number;
  /** `energyJ` handed to the same event. 900 000 is `explosion.large`'s. */
  readonly vfxEnergyJ: number;
  /** Ground ejecta chunk count for `FxEventMap['debrisBurst']`. */
  readonly debrisCount: number;
  /** Camera trauma at the epicentre, falling to 0 at `damageRadius * 2.5`. */
  readonly shakeTrauma: number;
  readonly shakeHz: number;
  /** Cue played at the moment the pin is pulled. */
  readonly pinSound: SoundId;
}

/**
 * M67-class. 3.4 s fuse, ~15 m casualty radius on paper — trimmed to 8.2 here,
 * because a paper casualty radius includes fragments that arrive through a
 * doorway and a game that models that is a game where nobody leaves cover.
 */
export const FRAG: ThrowableDef = {
  id: 'frag',
  name: 'M67 FRAG',
  capacity: 3,

  fuseSeconds: 3.4,
  // 2.45 s of cook leaves 0.95 s of flight at minimum — roughly 18 m at the
  // authored throw speed, which is far enough that a full cook is a commitment
  // rather than a suicide.
  maxCook: 2.45,
  refractorySeconds: 0.85,

  throwSpeed: 20.5,
  minPower: 0.55,
  chargeSeconds: 0.35,
  launchLoftDeg: 11,
  inheritVelocity: 0.55,
  muzzleForward: 0.55,
  muzzleDrop: 0.16,
  spinRateRad: 7.5,

  radius: 0.031,
  massKg: 0.4,
  // Measured off nothing; tuned. 0.22 gives two or three decreasing bounces on
  // stone and a single dead one on sand, which is what a steel body does.
  restitution: 0.22,
  friction: 0.62,
  // ROLLING RESISTANCE, WHICH RAPIER DOES NOT HAVE. A sphere on a slope under
  // Coulomb friction alone rolls forever, so a grenade that lands on a ramp is
  // still travelling when its fuse runs out and goes off fifteen metres from
  // where the player put it. Linear damping is small enough not to rob the
  // flight (0.10 costs ~10% of a 1 s throw) and the angular term is what
  // actually stops the roll.
  linearDamping: 0.1,
  angularDamping: 3.0,
  surface: SurfaceId.BareMetal,

  peakDamage: 135,
  lethalRadius: 2.4,
  damageRadius: 8.2,
  falloffExponent: 1.7,

  breachRadius: 3.5,
  structureDamage: 900,
  energyJ: 42_000,
  impulseNs: 900,
  burstHeight: 0.35,
  loudnessDb: 164,

  vfxRadius: 12,
  vfxEnergyJ: 900_000,
  debrisCount: 26,
  shakeTrauma: 0.85,
  shakeHz: 14,
  pinSound: 'w.bolt',
};

/** The frozen table, so a second throwable is a one-line addition. */
export const THROWABLES: Readonly<Record<ThrowableId, ThrowableDef>> = { frag: FRAG };
