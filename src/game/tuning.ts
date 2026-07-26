/**
 * GAME — every locomotion, damage and Conquest constant, in one place.
 *
 * OWNER: GAME.
 *
 * Feel is a set of numbers with reasons. A magic number buried in a movement
 * integrator is a number nobody dares change; a magic number in a table with a
 * sentence next to it is a tuning knob. Every value here is either (a) derived
 * from a physical quantity, (b) copied from the capsule so two systems cannot
 * disagree, or (c) an authored perceptual choice with the perception written
 * down.
 *
 * THE CAPSULE IS THE ROOT OF THE TREE. Eye height, hitbox stack, muzzle offset,
 * step height, vault reach and camera dip all derive from it. AI reads it back
 * through `PlayerService.configOf` and must never author its own.
 */
import { Stance, type CharacterConfig } from '@/engine/types';

/* ------------------------------------------------------------------ capsule */

/**
 * The soldier. Radius 0.32 m is a 64 cm shoulder cylinder — wide enough that a
 * player cannot thread a 0.7 m gap that looks impassable, narrow enough for a
 * standard 0.9 m doorway with clearance either side.
 *
 * Heights are eye-level-driven: a 1.8 m standing capsule puts the eye at 1.62 m,
 * which is the median adult eye height and the number every FPS since Half-Life
 * has converged on because it makes a 2.4 m ceiling read as a room.
 */
export const CAPSULE = {
  radius: 0.32,
  standHeight: 1.8,
  crouchHeight: 1.28,
  proneHeight: 0.63,
  /** Too small jitters against a wall, too large floats off it. */
  skinWidth: 0.02,
  /** Above this the surface is a wall, not a ramp. 50° is a steep but climbable dune. */
  maxSlopeDeg: 50,
  /** Kerbs, low rubble and a 0.3 m stair riser are stepped, not vaulted. */
  stepHeight: 0.35,
  /** Keeps the capsule glued over a crest instead of launching off it. */
  snapToGroundDistance: 0.4,
} as const satisfies Omit<CharacterConfig, 'entity' | 'position' | 'group' | 'collidesWith'>;

/**
 * Eye offset below the crown of the capsule — helmet crown to eyes. DERIVED, so
 * an eye height can never drift from the collider and put the camera inside a
 * wall the collider says was cleared. Identical to the value the null player
 * uses, so nothing shifts as GAME replaces it.
 */
export const EYE_DROP = 0.18;

export const CAPSULE_HEIGHT: Readonly<Record<Stance, number>> = {
  [Stance.Stand]: CAPSULE.standHeight,
  [Stance.Crouch]: CAPSULE.crouchHeight,
  [Stance.Prone]: CAPSULE.proneHeight,
};

/* ----------------------------------------------------------------- movement */

/**
 * Ground speed by stance, m/s. 4.2 m/s is a fast military walk — the speed at
 * which a 60 m street crossing takes 14 s, which is the pacing Conquest is
 * balanced around.
 */
export const STANCE_SPEED: Readonly<Record<Stance, number>> = {
  [Stance.Stand]: 4.2,
  [Stance.Crouch]: 2.1,
  [Stance.Prone]: 0.9,
};

/** Sprint is forward-only and costs stamina. 6.5 m/s ≈ a loaded soldier's dash. */
export const SPRINT_MULTIPLIER = 1.55;
/**
 * Tactical sprint: weapon carried low across the chest, ~23% faster again, and
 * it costs double stamina. It is the "I am committed and cannot fight" gear, so
 * it must be visibly a different animation state, not just a number.
 */
export const TACTICAL_SPRINT_MULTIPLIER = 1.9;
/** Seconds of held sprint before tactical engages. Long enough to be a choice. */
export const TACTICAL_SPRINT_DELAY = 0.85;

/** Directional penalties. Backpedalling is slow; strafing is nearly full speed. */
export const BACKPEDAL_SCALE = 0.72;
export const STRAFE_SCALE = 0.88;
/** Aiming down sights. Slow enough to be a commitment, not a crawl. */
export const ADS_SPEED_SCALE = 0.52;

/**
 * Quake-family accelerate/friction, because forty years of shooters have proved
 * it is the model that feels like a body rather than a cursor.
 *
 * `GROUND_ACCEL` is a multiplier on the target speed: effective acceleration is
 * `accel × wishSpeed` = 5.5 × 4.2 ≈ 23 m/s², so a standing start reaches full
 * walk in 0.18 s. Under 15 m/s² reads as wading; over 40 m/s² reads as a mouse
 * cursor with no mass.
 */
export const GROUND_ACCEL = 5.5;
/** Deceleration is deliberately snappier than acceleration: stopping is a skill. */
export const GROUND_FRICTION = 5.6;
/**
 * Friction is applied against `max(speed, STOP_SPEED)` so the last metre per
 * second does not take forever — without this floor an exponential decay never
 * actually stops and the player skates.
 */
export const STOP_SPEED = 2.0;

/**
 * Air control. The wish-speed CAP is the important half: you may steer, but you
 * may not accelerate past 1.4 m/s of new velocity in the air, so a jump commits
 * you to your take-off vector. That is what stops bunny-hopping from being the
 * fastest way across the map.
 */
export const AIR_ACCEL = 2.6;
export const AIR_WISH_SPEED_CAP = 1.4;
/** Trace friction in the air keeps a long fall from feeling frictionless. */
export const AIR_DRAG = 0.06;

/**
 * Gravity scale. Real 9.81 m/s² gives a floaty 0.9 s hang time for a jump that
 * clears a crate; 1.85× lands it in 0.65 s, which reads as a heavy soldier and
 * still clears the same crate.
 */
export const GRAVITY_SCALE = 1.85;
/** Metres of apex over the take-off foot. Clears a 0.5 m sandbag, not a wall. */
export const JUMP_HEIGHT = 0.95;
/** Ticks of grace after walking off a ledge in which a jump still fires. 6 ≈ 100 ms. */
export const COYOTE_TICKS = 6;
/** Ticks a jump press is remembered while airborne, so an early press still lands. */
export const JUMP_BUFFER_TICKS = 7;
/** Seconds before a second jump is allowed. Stops machine-gun hopping. */
export const JUMP_COOLDOWN = 0.28;

/* -------------------------------------------------------------------- slide */

/** Minimum speed to enter a slide. Below sprint speed you just crouch. */
export const SLIDE_ENTRY_SPEED = 5.2;
/** Entry impulse — a slide is FASTER than the sprint that fed it, briefly. */
export const SLIDE_ENTRY_BOOST = 1.16;
export const SLIDE_MAX_SPEED = 8.4;
/** Slide friction, m/s². Much lower than standing friction; that is the point. */
export const SLIDE_FRICTION = 3.3;
/** Downhill acceleration factor: a slide down a ramp genuinely gains speed. */
export const SLIDE_SLOPE_ACCEL = 13.0;
/** Slides end below this. 2.6 m/s is a walk; carrying on looks like a bug. */
export const SLIDE_EXIT_SPEED = 2.6;
export const SLIDE_MAX_TIME = 1.5;
/** Seconds before another slide may start. Stops slide-spam locomotion. */
export const SLIDE_COOLDOWN = 0.65;
/** Steering authority while sliding, rad/s. Enough to curve, not to turn. */
export const SLIDE_STEER_RATE = 1.15;

/* ------------------------------------------------------- vault and mantle */

/**
 * Ledge bands, measured from the feet.
 *
 *  waist  0.45–1.10 m → VAULT: one hand down, legs swing through, momentum kept
 *  chest  1.10–1.75 m → MANTLE: two hands, pull-up, momentum spent
 *
 * Below 0.45 m the step-up in the character controller handles it silently;
 * above 1.75 m a soldier with 25 kg of kit is not getting up there.
 */
export const VAULT_MIN_HEIGHT = 0.45;
export const VAULT_MAX_HEIGHT = 1.1;
export const MANTLE_MAX_HEIGHT = 1.75;
/** How far ahead the obstacle may be for the traversal to trigger. */
export const VAULT_REACH = 0.95;
/** Clear standing space needed BEYOND the ledge, or you would mantle into a wall. */
export const VAULT_LANDING_CLEARANCE = 0.55;
/** Seconds. A vault is a flow move; a mantle is a commitment you can be shot in. */
export const VAULT_DURATION = 0.42;
export const MANTLE_DURATION = 0.78;
/** Fraction of entry speed kept on exit. A vault flows; a mantle stops you dead. */
export const VAULT_EXIT_SPEED_SCALE = 0.86;
export const MANTLE_EXIT_SPEED = 1.2;
/** Auto-vault when sprinting into a ledge at speed, as every modern shooter does. */
export const AUTO_VAULT_SPEED = 4.6;

/* ------------------------------------------------------------------- stance */

/**
 * Stance transition times, seconds. Going DOWN is always faster than coming UP:
 * dropping is gravity plus intent, standing is a lift. Prone is slow enough that
 * committing to it in the open is a real decision.
 */
export const STANCE_TIME: Readonly<Record<string, number>> = {
  '0>1': 0.2, // stand → crouch
  '1>0': 0.3, // crouch → stand
  '0>2': 0.62, // stand → prone
  '2>0': 0.95, // prone → stand
  '1>2': 0.42, // crouch → prone
  '2>1': 0.6, // prone → crouch
};

/* ------------------------------------------------------------------ stamina */

/** Seconds of continuous sprint from full. 9 s ≈ 60 m, one street. */
export const SPRINT_STAMINA_DRAIN = 1 / 9;
export const TACTICAL_STAMINA_DRAIN = 1 / 5.5;
/** Regen is slower than drain and delayed, so sprint has a real economy. */
export const STAMINA_REGEN = 1 / 7;
export const STAMINA_REGEN_DELAY = 0.75;
export const JUMP_STAMINA_COST = 0.09;
export const VAULT_STAMINA_COST = 0.13;
/** Sprint locks out at empty and stays locked until this much has come back. */
export const STAMINA_SPRINT_UNLOCK = 0.22;

/* ------------------------------------------------------------- camera feel */

/**
 * Every number here is deliberately at the low end. Camera motion should be
 * FELT, not noticed: the moment a viewer can describe the effect, it is too big.
 * The test is a 1080p still — if the horizon is visibly tilted in a walk cycle,
 * halve it.
 */
export const VIEW = {
  /** Landing dip spring. ~0.45 s to settle; overshoots slightly on the way back. */
  landSpring: { stiffness: 190, damping: 0.62, mass: 1 },
  /** Vertical speed at which a landing starts to register at all, m/s. */
  landThreshold: 2.8,
  /** Vertical speed producing the maximum dip. Beyond this is fall damage. */
  landFullSpeed: 12,
  /** Metres of maximum landing dip. 16 cm is a deep knee bend. */
  landMaxDip: 0.16,
  /** Trauma sent to the CameraRig on a full-force landing. */
  landMaxTrauma: 0.34,

  /** Step bob amplitude, metres, at walk and at sprint. Sub-centimetre by design. */
  stepBobWalk: 0.007,
  stepBobSprint: 0.016,
  /** Metres per footfall. A 4.2 m/s walk is ~4.4 steps/s at 0.95 m stride. */
  strideWalk: 0.95,
  strideSprint: 1.35,
  /** Lateral sway per step, metres. Half the vertical, or it reads as a limp. */
  stepSwayScale: 0.45,

  /** Radians of roll per unit of strafe input. 1.1° — barely conscious. */
  strafeRoll: 1.1 * (Math.PI / 180),
  /** Roll at full lean. Matches the viewmodel's lean, which is authored at 14°. */
  leanRoll: 14 * (Math.PI / 180),
  /** Extra roll while sliding, into the slide direction. */
  slideRoll: 4.5 * (Math.PI / 180),
  /** Half-life of the roll damp, seconds. Short enough to feel connected. */
  rollHalfLife: 0.085,

  /** Eye drop added while sliding, metres, on top of the crouch capsule. */
  slideDrop: 0.1,
  /** Half-life of the eye-height follow on a stance change, seconds. */
  eyeHalfLife: 0.055,
} as const;

/** Metres of lean offset at full lean. The capsule does not move; the eye does. */
export const LEAN_OFFSET = 0.34;
/** Seconds to reach full lean. */
export const LEAN_TIME = 0.16;

/* ------------------------------------------------------------------- damage */

/**
 * Hit-zone multipliers, used ONLY when the firing weapon has no table of its
 * own. `BallisticsDef.zoneMultipliers` is authored by WEAPONS and wins whenever
 * it is available — two lanes owning one number is how a headshot ends up worth
 * 2.4× in the damage log and 1.8× on the killfeed.
 */
export const FALLBACK_ZONE_MULTIPLIER: Readonly<Record<number, number>> = {
  [-1]: 1.0, // HitZone.None — an unzoned body hit
  [0]: 2.4, // Head
  [1]: 1.0, // Torso
  [2]: 1.15, // Stomach — organs, but no spine
  [3]: 0.82, // Arm
  [4]: 0.78, // Leg
};

/** Fraction of damage that survives a wall. Penetration should never be free. */
export const PENETRATION_DAMAGE_SCALE = 0.62;
/** Friendly fire is on, at a fraction — it must sting without being a grief tool. */
export const FRIENDLY_FIRE_SCALE = 0.35;

/** Metres of free fall before it hurts. ~2.6 m, i.e. one storey is survivable. */
export const FALL_DAMAGE_SPEED = 9.8;
/** Vertical speed at which a fall is always lethal, m/s (≈ 12 m drop). */
export const FALL_LETHAL_SPEED = 15.4;

/** Seconds out of combat before health regenerates. */
export const REGEN_DELAY = 5.5;
/** Health per second once regen starts. 100 HP in ~9 s. */
export const REGEN_RATE = 11;
/**
 * Regen stops here rather than at 100. A player who has been hit stays one
 * bullet worse off until they are revived or resupplied, which is what makes
 * a firefight leave a mark.
 */
export const REGEN_CEILING = 100;

/** Seconds spent downed before bleeding out. Long enough for a squadmate to reach you. */
export const BLEEDOUT_TIME = 21;
/** Damage in one hit above which you are killed outright rather than downed. */
export const DOWN_INSTANT_KILL_DAMAGE = 65;
/** Seconds a medic must be within `REVIVE_RANGE` to bring you back. */
export const REVIVE_TIME = 2.4;
export const REVIVE_RANGE = 2.2;
/** Health you come back with. Deliberately low: a revive is a second chance, not a reset. */
export const REVIVE_HEALTH = 35;

/** Suppression from a bullet passing within this radius, per event. */
export const SUPPRESSION_PER_NEAR_MISS = 0.28;
export const SUPPRESSION_DECAY = 0.55;
export const SUPPRESSION_RADIUS = 3.2;

/* ----------------------------------------------------------------- conquest */

export const CONQUEST = {
  ticketsPerTeam: 450,
  /** Seconds of round clock. 15 minutes is the Conquest standard. */
  roundSeconds: 900,
  warmupSeconds: 12,
  /**
   * Fraction of a point captured per second by ONE attacker. 1/11 s means a
   * lone soldier takes a neutral flag in 11 s and flips an enemy flag in 22 —
   * long enough that walking in alone is a commitment.
   */
  baseCaptureRate: 1 / 11,
  /**
   * Diminishing returns on numbers: rate × (1 + 0.62·(n−1)^0.75), capped. Four
   * attackers are ~2.5× a lone one, not 4×, so stacking a flag is worth doing
   * and not worth doing with the whole team.
   */
  occupantGain: 0.62,
  occupantExponent: 0.75,
  maxOccupantMultiplier: 3.2,
  /** Progress lost per second when a point is held by nobody and not fully owned. */
  decayRate: 1 / 26,
  /** Ticket bleed per second against the team holding FEWER points, by margin. */
  bleedByMargin: [0, 0.4, 1.0, 1.9] as const,
  /** Tickets lost when one of your team dies. */
  ticketsPerDeath: 1,
  /** Score awards. */
  scoreKill: 100,
  scoreHeadshot: 25,
  scoreAssist: 50,
  scoreCapture: 250,
  scoreNeutralise: 100,
  scoreDefend: 50,
  /** Seconds between death and being allowed to deploy again. */
  respawnSeconds: 5,
  /** Both teams under this ticket count with the clock expired ⇒ overtime. */
  overtimeTickets: 40,
} as const;

/* -------------------------------------------------------------------- spawn */

/** No spawn within this radius of a living enemy. */
export const SPAWN_ENEMY_RADIUS = 28;
/** ...or within this radius if the enemy can also see the spot. */
export const SPAWN_SIGHTLINE_RADIUS = 70;
/** Metres a squad spawn is offset behind its anchor, so you do not spawn inside them. */
export const SPAWN_SQUAD_OFFSET = 2.6;
/** Candidate ring radii for scattering base spawns, metres. */
export const SPAWN_SCATTER = [0, 3.5, 7, 11] as const;
