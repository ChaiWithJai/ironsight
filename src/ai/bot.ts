/**
 * One bot's whole mind, in one flat record.
 *
 * OWNER: AI.
 *
 * Everything per-bot lives here rather than in a Map per subsystem: the tick
 * order is perception → squad → brain → aim → intent, all of them touching the
 * same soldier, and one dense array iterated in spawn order is both the fastest
 * and the ONLY deterministic way to walk them (architecture §9.2 — never
 * iterate a Map keyed by object identity in gameplay code).
 */
import * as THREE from 'three';
import {
  BotBehaviour,
  Stance,
  Team,
  type BotProfile,
  type CoverSlot,
  type EntityId,
  type PlayerIntent,
  type Vec3,
  type WeaponId,
} from '@/engine/types';
import { PathRequest } from '@/ai/pathfind';

/** What the bot believes about one enemy. Decays; never deleted while in range. */
export interface ThreatMemory {
  entity: EntityId;
  /** Last position the bot actually observed or inferred, NOT the true one. */
  readonly lastKnown: Vec3;
  readonly lastVelocity: Vec3;
  /** 0..1 detection accumulator. Crosses 1 → the bot "has" him. */
  confidence: number;
  visible: boolean;
  lastSeenTime: number;
  firstSeenTime: number;
  /** Sim time at which this bot is allowed to fire at this target. */
  reactionAt: number;
  distance: number;
  /** How long the target has held still — the grenade trigger. */
  staticSince: number;
  /** Heard, not seen: the position is coarse and worth investigating, not shooting. */
  heardOnly: boolean;
}

export type GoalKind = 'idle' | 'objective' | 'cover' | 'flank' | 'regroup' | 'investigate' | 'retreat';

export class Bot {
  entity: EntityId = 0 as EntityId;
  team: Team = Team.Coalition;
  squad = 0;
  name = '';
  profile: Readonly<BotProfile>;
  weapon: WeaponId = 'ar_service';
  alive = true;
  /** Spawn index. The stable integer key every deterministic sort uses. */
  readonly slot: number;

  behaviour: BotBehaviour = BotBehaviour.Idle;
  behaviourSince = 0;
  target: EntityId = 0 as EntityId;
  readonly memories: ThreatMemory[] = [];

  /** Pathing. */
  readonly path = new PathRequest();
  pathGeneration = -1;
  corridorIndex = 0;
  /**
   * Which `path.generation` `corridorIndex` is counting through.
   *
   * The corridor is only rewound when a NEW solve lands, never when one is
   * requested: a bot that blanked its corridor on every re-path spent the
   * whole service time — up to a second and a half — with nothing to walk
   * along, which is most of what "the bots don't move" looked like.
   */
  corridorGeneration = -1;
  readonly goal = new THREE.Vector3();
  goalKind: GoalKind = 'idle';
  goalStale = 0;
  repathAt = 0;

  /**
   * Wedge detection.
   *
   * A bot writing a full-magnitude wish that the character controller cannot
   * turn into displacement is INVISIBLE to everything else in this lane: the
   * corridor is valid, the goal is valid, perception is fine, and the man
   * simply stands in a doorway leaning on a wall. Measured on HARBOUR REACH
   * before this existed: two bots held one spot for 3 558 and 2 999 ticks of a
   * 3 600-tick run — 59 s of a 60 s match — with `moveX/moveZ` at magnitude 1
   * the whole time. Nothing re-planned, because from the planner's point of
   * view nothing had gone wrong.
   *
   * `stuckAnchor` is the last position at which real progress was made and
   * `stuckSince` is when it was made. `intent.ts` compares against them every
   * tick that the bot actually wants to move.
   */
  readonly stuckAnchor = new THREE.Vector3();
  stuckSince = 0;
  /** Which rung of the escape ladder the current wedge is on. */
  stuckAttempt = 0;
  /** Sim time until which the escape heading overrides the goal heading. */
  unstickUntil = 0;

  /** Cover. */
  cover: CoverSlot | null = null;
  coverIndex = -1;
  /**
   * When the current slot was claimed. A soldier who picks one wall and stands
   * behind it for the rest of the round is a statue with a peek animation; the
   * brain re-claims past `COVER_TENURE_S` so he works a second angle.
   */
  coverSince = 0;
  /** 0 = fully behind cover, 1 = fully exposed. Drives the peek rhythm. */
  exposure = 0;
  peekUntil = 0;
  hideUntil = 0;

  /** Aim. */
  aimYaw = 0;
  aimPitch = 0;
  aimYawVel = 0;
  aimPitchVel = 0;
  readonly aimPoint = new THREE.Vector3();
  readonly aimAt = new THREE.Vector3();
  /** Per-bot error-cone phases, drawn once at spawn from the bot's own stream. */
  errPhaseA = 0;
  errPhaseB = 0;
  errFreqA = 0.7;
  errFreqB = 1.9;
  /** 0..1, 1 = settled on target. Scales spread and gates the trigger. */
  settle = 0;

  /** Fire control shadow. Authoritative only while WEAPONS is null. */
  ammo = 30;
  magazine = 30;
  reserve = 210;
  reloadEndTime = -1;
  nextShotTime = 0;
  burstLeft = 0;
  burstPauseUntil = 0;
  trigger = false;
  wantsAds = false;
  grenadeCooldownUntil = 0;
  throwingUntil = -1;
  /** `Btn.Reload` is HELD until this time, so the edge GAME sees is a real edge. */
  reloadPressUntil = -1;

  /** Locomotion + presentation. */
  stance: Stance = Stance.Stand;
  wantsSprint = false;
  gaitPhase = 0;
  /** 0..1 low-passed ground speed, so the walk cycle does not stutter. */
  gaitSpeed = 0;
  suppression = 0;
  deathTime = -1;
  /** Sim time of the last shot; the muzzle-flash and recoil pose read it. */
  lastShotTime = -1;
  recoil = 0;

  /**
   * Sim time this bot entered the world. THE CLOCK EVERY COSMETIC OSCILLATOR ON
   * THIS BOT RUNS ON, and the reason is determinism: the harness reseeds the RNG
   * before a capture but does NOT rewind `ctx.time`, so anything driven by
   * absolute sim time — the aim error cone above all — produces a different
   * frame depending on how long the page happened to idle before the shot was
   * taken. Phrased as `time - spawnTime` it is identical every run.
   */
  spawnTime = 0;

  /** Think scheduling. */
  thinkPhase = 0;
  lastThinkTime = -1;

  /** The struct `intentSource.sample` copies out. Written by `intent.ts`. */
  readonly intent: PlayerIntent = {
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    pressed: 0,
    released: 0,
    weaponSlot: -1,
    aimAt: null,
  };
  /** Buttons held last tick, so `pressed`/`released` edges are real edges. */
  prevButtons = 0;

  constructor(slot: number, profile: Readonly<BotProfile>) {
    this.slot = slot;
    this.profile = profile;
  }

  memoryOf(entity: EntityId): ThreatMemory | undefined {
    for (const m of this.memories) if (m.entity === entity) return m;
    return undefined;
  }

  memoryFor(entity: EntityId, time: number): ThreatMemory {
    const found = this.memoryOf(entity);
    if (found) return found;
    const memory: ThreatMemory = {
      entity,
      lastKnown: new THREE.Vector3(),
      lastVelocity: new THREE.Vector3(),
      confidence: 0,
      visible: false,
      // `time`, NOT a large negative sentinel. `perceive` deletes any memory
      // that is not yet VISIBLE and whose age exceeds `FORGET_SECONDS`, and a
      // memory born at -1000 is already 1000 s old — so it was destroyed at the
      // end of the very pass that created it, the detection accumulator could
      // never carry confidence from one pass to the next, and a bot could only
      // ever notice a target that crossed the whole threshold in a single
      // round-robin slice.
      lastSeenTime: time,
      firstSeenTime: time,
      reactionAt: Infinity,
      distance: Infinity,
      staticSince: time,
      heardOnly: true,
    };
    this.memories.push(memory);
    // Six is a working set, not a limit on how many enemies exist: a soldier
    // tracking more than half a dozen contacts is not modelling attention.
    if (this.memories.length > 6) {
      let worst = 0;
      for (let i = 1; i < this.memories.length; i++) {
        if (this.memories[i].confidence < this.memories[worst].confidence) worst = i;
      }
      this.memories.splice(worst, 1);
    }
    return memory;
  }

  clearMind(): void {
    this.memories.length = 0;
    this.target = 0 as EntityId;
    this.behaviour = BotBehaviour.Idle;
    this.cover = null;
    this.coverIndex = -1;
    this.coverSince = 0;
    this.exposure = 0;
    this.corridorIndex = 0;
    this.corridorGeneration = -1;
    this.pathGeneration = -1;
    this.stuckSince = 0;
    this.stuckAttempt = 0;
    this.unstickUntil = 0;
    this.path.status = 'failed';
    this.path.cornerCount = 0;
    this.trigger = false;
    this.burstLeft = 0;
    this.reloadEndTime = -1;
    this.recoil = 0;
    this.suppression = 0;
    this.intent.buttons = 0;
    this.intent.pressed = 0;
    this.intent.released = 0;
    this.intent.moveX = 0;
    this.intent.moveZ = 0;
    this.intent.aimAt = null;
    this.prevButtons = 0;
  }
}
