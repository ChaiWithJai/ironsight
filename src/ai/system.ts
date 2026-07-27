/**
 * AiService — the bot pool, the think scheduler, and the seam that makes a bot
 * indistinguishable from a player to the rest of the engine.
 *
 * OWNER: AI. Entry file: `createAiService` / `registerAiBakes` / `resetAi` are
 * named and pathed by the frozen descriptor table.
 *
 * WHAT THIS FILE IS AND IS NOT
 * ----------------------------
 * It is the ORCHESTRATOR. Every actual decision lives in a sibling: perception
 * in `perception.ts`, utility scoring and the peek rhythm in `brain.ts`, squad
 * orders in `squad.ts`, human-like aim in `aim.ts`, and the translation into
 * `PlayerIntent` in `intent.ts`. This file owns the pool, the per-tick order the
 * five of them run in, the LOD'd think budget, and the world snapshot they all
 * read so they cannot disagree with each other mid-tick.
 *
 * THE ONE LINE THAT MAKES BOTS AND THE PLAYER SHARE A CODE PATH is in
 * `spawnBot`:
 *
 *     player.attachController(entity, team, this.intentSource);
 *
 * After that, GAME's single `TickPhase.Intent` system calls
 * `intentSource.sample(entity, ctx, out)` for that entity every tick forever.
 * WE NEVER CALL `sample()` OURSELVES and we register nothing at `Intent` or
 * `Movement` — those two phases belong to GAME exclusively (architecture §3.4).
 * `sample` therefore does one thing: copy out the intent this lane's
 * `TickPhase.Ai` system wrote LAST tick. Ai runs after Intent and before
 * Movement, so a brain reads last tick's world and writes into the intent that
 * is sampled next tick, which is exactly the one-frame latency a person has.
 *
 * COST IS FLAT BY CONSTRUCTION. Perception and scoring are round-robin over a
 * fixed stride derived from `quality.ai.perceptionHz`, widened by distance from
 * the local player, so 24 bots cost the same per tick as 24 bots do — never a
 * spike when they all notice something at once. Aim, fire control and intent DO
 * run every tick for every bot, because a 4 Hz trigger fires in visible clumps
 * and a 4 Hz aim is a servo stepping across the target.
 */
import * as THREE from 'three';
import {
  BotBehaviour,
  Btn,
  LAYER_SOLID,
  RenderStage,
  Stance,
  Team,
  TickPhase,
  type AiService,
  type AssetRegistry,
  type BootContext,
  type BotProfile,
  type BotView,
  type EntityId,
  type FrameCtx,
  type FxEmitter,
  type IntentSource,
  type NoiseEvent,
  type PlayerIntent,
  type PlayerState,
  type QualitySettings,
  type Rng,
  type Services,
  type SimBus,
  type SpawnPointDef,
  type SquadOrder,
  type TickCtx,
  type Vec3,
  type WeaponDef,
} from '@/engine/types';
import { Bot } from '@/ai/bot';
import { Brain } from '@/ai/brain';
import { AiDebugDraw } from '@/ai/debug';
import { desiredAimPoint, solveAim } from '@/ai/aim';
import { copyIntent, writeIntent } from '@/ai/intent';
import { LosGrid } from '@/ai/los';
import { navRuntime, type NavRuntime } from '@/ai/nav';
import { HitboxStack } from '@/ai/hitbox';
import { forgetEntity, hear, perceive, selectTarget } from '@/ai/perception';
import { BOT_PROFILES, SQUAD_COMPOSITION } from '@/ai/profiles';
import { SquadDirector } from '@/ai/squad';
import { SoldierRenderer } from '@/ai/character/render';
import { buildSoldierModel } from '@/ai/character/soldier';
import type { ActorView, AiWorld } from '@/ai/world';

/** Callsigns, so the killfeed and the debug overlay read as people. */
const CALLSIGNS: readonly string[] = [
  'HAWK', 'DUSTY', 'RAVEN', 'MOSS', 'KILO', 'BRICK', 'SABLE', 'OTTER',
  'CINDER', 'RIGGS', 'VULCAN', 'MARLOW', 'DELTA', 'PONCHO', 'TALLY', 'GRIST',
  'ASHER', 'NOMAD', 'CROW', 'WREN', 'SLATE', 'FENN', 'DRAKE', 'HOLLIS',
];

/**
 * How long a killed bot's body stays in the world. Long enough for the fall to
 * finish and for a player to see who he shot; short enough that a firefight
 * does not accumulate a hundred bodies at 24 bots and a 5 s respawn.
 */
const CORPSE_SECONDS = 9;

/**
 * Ranges for the LOD ladder shot, in metres. Straddles both switch distances
 * (`soldier.ts` hands over at 22 m and 55 m) so a critic sees the model on both
 * sides of each transition in the same frame.
 */
const LOD_LADDER: readonly number[] = [6, 13, 21, 32, 46, 68];

/**
 * How far a spawn point may be nudged to land on walkable navmesh. Wide enough
 * to clear the kerb or planter an authored point sits inside, narrow enough
 * that a bot never enters the map on the wrong side of a wall.
 *
 * MEASURED, NOT GUESSED. Nine of HARBOUR REACH's ten spawn points sit 1.4 m
 * from the nearest polygon — the half-cell quantisation of the field, i.e.
 * effectively on it. The tenth, the BRAVO-linked Coalition spawn at (40, 22),
 * is authored on the quay lip and is 15 m from any walkable polygon. At the
 * old 6 m bound a bot entering there had no walkable heading in any direction,
 * could not be rescued by the off-mesh recovery either, and stood still for the
 * entire match — measured 0.04 m travelled in 60 s. A bot 15 m from where LEVEL
 * meant him to be is a smaller failure than a bot who never moves.
 */
const SPAWN_SNAP_M = 18;

/* -------------------------------------------------------------------- spot */

/** Half-angle of the spot reticle, as a cosine. 7° — generous, not a laser. */
const SPOT_CONE_COS = Math.cos((7 * Math.PI) / 180);
/** Furthest a player may call a contact. */
const SPOT_RANGE_M = 260;
/** How far down the sightline a spot that hit nobody plants its report. */
const SPOT_BLIND_M = 45;
/** Squadmates this far from the player are told; the rest read it off the ledger. */
const SPOT_SHARE_M = 110;

/** Scratch for the spawn snap. Dedicated, so it cannot alias the tick's. */
const SPAWN_ENTRY = new THREE.Vector3();
const SPAWN_LANDED = new THREE.Vector3();

/** Ticks between perception passes at the base rate, before LOD widening. */
function strideFor(perceptionHz: number): number {
  return Math.max(1, Math.round(60 / Math.max(1, perceptionHz)));
}

let instance: IronAi | null = null;

class IronAi implements AiService {
  readonly profiles = BOT_PROFILES;

  private readonly botList: Bot[] = [];
  /** Retired bodies still falling. Simulated by nobody, drawn by the renderer. */
  private readonly corpses: Bot[] = [];
  /** `botList` then `corpses`, rebuilt on change so the render path allocates nothing. */
  private readonly drawList: Bot[] = [];
  private readonly byEntity = new Map<number, Bot>();
  private readonly views: BotView[] = [];
  private readonly squads = new SquadDirector();
  private readonly brain = new Brain(this.squads);
  private readonly los = new LosGrid();
  private readonly services: Services;
  private readonly rng: Rng;
  private readonly nav: NavRuntime;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly hitboxes: HitboxStack;

  private renderer: SoldierRenderer | null = null;
  private debug: AiDebugDraw | null = null;
  /** `registry.isNull('weapons')`, latched at `afterBoot` so the tick is free. */
  private weaponsNull = true;
  private difficultyValue = 0.5;
  private nextSlot = 0;
  private losBuiltFrom = -1;
  /**
   * Ticks since the last reset, NOT `TickCtx.tick`. The think round-robin is
   * phased off this, and the engine's tick counter is not rewound between
   * captures — so scheduling off it makes which bots think on which frame of a
   * shot depend on how long the page idled first, and two runs of the same shot
   * produce different PNGs. Reset in `dropTransient`.
   */
  private tickIndex = 0;
  /** Set by `forceState`; makes the AI shot legible without a service route. */
  private tableau = '';

  /** Reused scratch, because this runs 60 times a second forever. */
  private readonly scratch = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly actorPool: ActorView[] = [];
  private readonly world: AiWorld;

  readonly intentSource: IntentSource = {
    kind: 'bot',
    /**
     * Copy out what `TickPhase.Ai` decided last tick. It deliberately does NOT
     * think here: GAME calls this at `TickPhase.Intent`, which runs BEFORE our
     * own phase, so thinking here would read a world one phase staler than the
     * one the brain is designed against and would also put 24 brains inside
     * another lane's system.
     */
    sample: (entity: EntityId, _ctx: TickCtx, out: PlayerIntent): void => {
      const bot = this.byEntity.get(entity as number);
      if (!bot) {
        out.moveX = 0;
        out.moveZ = 0;
        out.lookYaw = 0;
        out.lookPitch = 0;
        out.buttons = 0;
        out.pressed = 0;
        out.released = 0;
        out.weaponSlot = -1;
        out.aimAt = null;
        return;
      }
      copyIntent(bot.intent, out);
    },
  };

  constructor(ctx: BootContext, nav: NavRuntime) {
    this.services = ctx.services;
    this.nav = nav;
    // A named fork, so adding or removing a draw in another lane cannot shift
    // this lane's stream. `reseed` on the root propagates into forks, which is
    // what makes the harness reset chain reach us at all.
    this.rng = ctx.services.rng.fork('ai');
    this.hitboxes = new HitboxStack(() => this.services.physics);

    this.world = {
      time: 0,
      dt: 1 / 60,
      tick: 0,
      actors: [],
      bots: this.botList,
      difficulty: this.difficultyValue,
      nav: this.nav,
      services: this.services,
      quality: ctx.quality.settings,
      rng: this.rng,
      fx: ctx.services.fx as FxEmitter,
      sim: ctx.services.events as SimBus,
      weaponsLive: false,
      visibility: (from: Vec3, to: Vec3): number => this.visibility(from, to),
      coverClaimed: (index, by): boolean => {
        for (const other of this.botList) {
          if (other !== by && other.alive && other.coverIndex === index) return true;
        }
        return false;
      },
      actorOf: (entity: EntityId): ActorView | undefined => this.actorOf(entity),
    };

    // Hearing. `noise.emitted` is the bus route and `notifyNoise` is the direct
    // one for emitters that are not on the bus; both land here, and the
    // contract forbids an emitter from using both, because the same gunshot
    // counted twice puts every hearing threshold out by 6 dB.
    this.unsubscribe.push(this.services.events.on('noise.emitted', (e) => this.onNoise(e)));
    // CONTACT. A rifle going off is the loudest statement in the game about
    // where the enemy is, and until now nothing above the individual bot's
    // hearing did anything with it: a bot flinched, and his squad — and the
    // squad next to his — carried on walking to a flag on the far side of the
    // map. Both teams are told, because "my mate is shooting at something over
    // there" and "someone is shooting at me from over there" are the same
    // report from opposite ends.
    this.unsubscribe.push(
      this.services.events.on('damage.applied', (e) => {
        const victim = this.services.player.stateOf(e.target);
        if (!victim) return;
        // Where the round CAME FROM is what a squad wants, and `direction` is
        // the unit vector attacker → target, so stepping back along it from the
        // hit point is the best estimate available without naming the shooter.
        this.scratch
          .copy(victim.position)
          .addScaledVector(this.scratchB.copy(e.direction).setY(0).normalize(), -22);
        this.squads.noteContact(victim.team, this.scratch, this.world.time, 3);
        const shooter = this.services.player.stateOf(e.attacker);
        if (shooter) this.squads.noteContact(shooter.team, victim.position, this.world.time, 2);
      }),
    );
    this.unsubscribe.push(
      this.services.events.on('entity.killed', (e) => {
        const bot = this.byEntity.get(e.victim as number);
        if (bot) {
          bot.alive = false;
          bot.deathTime = this.world.time;
          bot.behaviour = BotBehaviour.Dead;
          bot.trigger = false;
          bot.intent.buttons = 0;
        }
        for (const other of this.botList) forgetEntity(other, e.victim);
      }),
    );
    // Destruction opened or closed a route; the graph and the cover book both
    // have to be told, and only DESTRUCTION knows when.
    this.unsubscribe.push(this.services.events.on('nav.dirty', (e) => this.nav.invalidate(e.min, e.max)));
  }

  /* ------------------------------------------------------------ contract --- */

  get bots(): readonly Readonly<BotView>[] {
    return this.views;
  }

  get count(): number {
    return this.botList.length;
  }

  profile(id: string): Readonly<BotProfile> | undefined {
    return BOT_PROFILES.find((p) => p.id === id);
  }

  spawnBot(team: Team, profile: Readonly<BotProfile>, spawn: Readonly<SpawnPointDef>): EntityId {
    const player = this.services.player;
    const entity = this.services.entities.create('bot');
    const slot = this.nextSlot++;
    const bot = new Bot(slot, profile);
    bot.entity = entity;
    bot.team = team;
    // Four-man squads, numbered per team, so `squadKey` in `squad.ts` never
    // collides across teams and the role assignment is stable.
    let sameTeam = 0;
    for (const other of this.botList) if (other.team === team) sameTeam++;
    bot.squad = Math.floor(sameTeam / SQUAD_COMPOSITION.length);
    bot.name = CALLSIGNS[slot % CALLSIGNS.length] + (slot >= CALLSIGNS.length ? `-${Math.floor(slot / CALLSIGNS.length) + 1}` : '');
    bot.weapon = profile.preferredWeapons[0] ?? 'ar_service';
    // Error-cone phases are drawn ONCE, at spawn, from the lane stream: two bots
    // sharing a phase wobble in lockstep and the squad reads as one animation.
    bot.errPhaseA = this.rng.next() * Math.PI * 2;
    bot.errPhaseB = this.rng.next() * Math.PI * 2;
    bot.errFreqA = 0.55 + this.rng.next() * 0.4;
    bot.errFreqB = 1.6 + this.rng.next() * 0.7;
    bot.thinkPhase = slot;
    bot.spawnTime = this.world.time;

    const weapon = this.weaponDef(bot);
    bot.magazine = weapon?.magazine ?? 30;
    bot.ammo = bot.magazine;
    bot.reserve = weapon?.reserve ?? 210;

    this.botList.push(bot);
    this.byEntity.set(entity as number, bot);
    this.views.push(makeView(bot));
    this.rebuildDrawList();

    // ENTER THE WORLD ON GROUND THE NAVMESH AGREES IS WALKABLE.
    //
    // `SpawnPointDef.position` is LEVEL's, authored against the massing rather
    // than against the navmesh, and a bot dropped onto a spot with no polygon
    // under it is a bot with no walkable heading in any direction — every ray
    // he casts fails on its first step. Measured before this snap: five of
    // eighteen bots stood off the mesh for 100% of a 30 s run and travelled
    // 0.00 m between them while writing a full-magnitude wish every tick.
    //
    // The snap is bounded: past `SPAWN_SNAP_M` the nearest walkable ground is
    // somewhere else entirely and moving him there would be worse than
    // honouring the level's intent.
    const entry = SPAWN_ENTRY.copy(spawn.position);
    if (this.nav.sample(spawn.position, SPAWN_SNAP_M, SPAWN_LANDED)) {
      entry.copy(SPAWN_LANDED);
      // Keep whatever clearance LEVEL asked for above its own floor. The
      // navmesh height is a plane fit and sits a few centimetres either side of
      // the collision surface; starting BELOW it puts the capsule in the ground
      // and the controller then has to resolve a penetration on frame one.
      entry.y = Math.max(entry.y, spawn.position.y);
    }

    // THE LINE. Without it the bot is never sampled and never moves, and
    // nothing throws to say so.
    player.attachController(entity, team, this.intentSource);
    player.teleport(entity, entry, spawn.yaw, 0);
    bot.aimYaw = spawn.yaw;
    bot.aimPitch = 0;
    // Seed the aim point ahead of him so the first tick does not swing the whole
    // body around from a zeroed target.
    bot.aimAt.set(
      entry.x - Math.sin(spawn.yaw) * 40,
      entry.y + 1.6,
      entry.z - Math.cos(spawn.yaw) * 40,
    );
    bot.intent.aimAt = bot.aimAt;
    this.services.weapons.equip(entity, bot.weapon);
    this.services.events.emit('entity.spawned', {
      entity,
      archetype: 'bot',
      team,
      // Cloned: the sim bus is DEFERRED, and `SpawnPointDef.position` belongs to
      // LEVEL. A subscriber reading it next tick would otherwise see wherever
      // that vector had got to, not where this bot entered the map.
      position: entry.clone(),
    });
    return entity;
  }

  /**
   * Retire a bot. GAME's `BotDirector` calls this the instant `entity.killed`
   * lands, so the contract's meaning — "this bot is no longer part of the
   * population" — takes effect immediately: he leaves `bots`, `count`, the
   * squad and every other bot's memory on this call.
   *
   * The BODY lingers for `CORPSE_SECONDS` and is drawn (and only drawn) through
   * the death-fall in `character/render.ts`, after which the controller and the
   * entity are released for real. Freeing everything on the same frame is what
   * makes soldiers pop out of existence at the moment they are shot, which is a
   * worse artefact than any of the ones it saves.
   */
  despawn(entity: EntityId): void {
    const bot = this.byEntity.get(entity as number);
    if (!bot) return;
    this.nav.cancelPath(bot.path);
    this.hitboxes.release(entity);
    this.byEntity.delete(entity as number);
    const i = this.botList.indexOf(bot);
    if (i >= 0) {
      this.botList.splice(i, 1);
      this.views.splice(i, 1);
    }
    for (const other of this.botList) forgetEntity(other, entity);
    if (bot.alive) {
      bot.alive = false;
      bot.deathTime = this.world.time;
    }
    bot.behaviour = BotBehaviour.Dead;
    bot.trigger = false;
    bot.intent.buttons = 0;
    bot.intent.moveX = 0;
    bot.intent.moveZ = 0;
    this.corpses.push(bot);
    this.rebuildDrawList();
  }

  /** Release a lingering body for good. */
  private reap(bot: Bot): void {
    const i = this.corpses.indexOf(bot);
    if (i >= 0) this.corpses.splice(i, 1);
    this.services.player.releaseController(bot.entity);
    this.services.entities.destroy(bot.entity);
    this.rebuildDrawList();
  }

  private rebuildDrawList(): void {
    this.drawList.length = 0;
    for (const bot of this.botList) this.drawList.push(bot);
    for (const bot of this.corpses) this.drawList.push(bot);
  }

  despawnAll(): void {
    // Copy first: `despawn` mutates the list it would otherwise be iterating.
    for (const bot of [...this.botList]) this.despawn(bot.entity);
    for (const bot of [...this.corpses]) this.reap(bot);
    this.botList.length = 0;
    this.views.length = 0;
    this.corpses.length = 0;
    this.drawList.length = 0;
    this.byEntity.clear();
    this.squads.clear();
    this.nextSlot = 0;
    this.hitboxes.releaseAll();
    this.renderer?.clear();
  }

  setDifficulty(value: number): void {
    this.difficultyValue = Math.max(0, Math.min(1, value));
  }

  notifyNoise(event: NoiseEvent): void {
    this.onNoise(event);
  }

  orderFor(bot: EntityId): SquadOrder | null {
    const found = this.byEntity.get(bot as number);
    return found ? this.squads.orderFor(found) : null;
  }

  /**
   * Harness hook. `ShotContext` has no route to a service, so `src/shots/ai.ts`
   * reaches this through a lane-private accessor rather than through the
   * harness — see `poseAiTableau` at the bottom of this file.
   */
  forceState(state: string): void {
    this.tableau = state;
    // The LOD ladder is a MODEL shot, not a behaviour shot: the reasoning
    // overlay would draw a corridor and a cover marker across the very
    // silhouettes it exists to let a critic judge.
    if (this.debug) this.debug.enabled = state !== '' && state !== 'live' && state !== 'lods';
    if (state === '' || state === 'live') return;
    if (state === 'lods') {
      this.buildLodLadder();
      return;
    }
    this.buildTableau(state);
  }

  /**
   * Six soldiers on one sightline at 7 → 88 m, and a camera at eye height at the
   * near end. Every LOD switch (22 m and 55 m) falls between two of them, so one
   * frame shows the full-gear model, the merged-torso model and the four-pixel
   * silhouette, and the transitions can be judged against their neighbours
   * rather than against memory of a different shot.
   */
  private buildLodLadder(): void {
    const points = this.services.level.capturePoints;
    if (points.length === 0) return;
    if (this.los.empty) this.los.build(this.nav.obstacles);
    const point = points.find((p) => p.id === 'ALPHA') ?? points[0];
    const origin = new THREE.Vector3();
    const landed = new THREE.Vector3();
    const at = new THREE.Vector3();
    const eye = new THREE.Vector3();

    // Sixteen compass headings out of the flag; take the first whose whole
    // 90 m run is walkable and unobstructed. Fixed order, so the answer does
    // not move when the level does — it just picks a different street.
    let heading = -1;
    let radius = 14;
    let bestScore = -1;
    const sky = new THREE.Vector3();
    // Sixteen headings at three stand-off radii, in a fixed order. Harbour Reach
    // is a dense town: there is no guarantee ANY street off the flag runs 88 m
    // clear, so this takes the best available run rather than insisting on a
    // perfect one, and the ladder is placed for however many rungs it found.
    for (const r of [14, 22, 30]) {
      for (let h = 0; h < 16; h++) {
        const a = (h / 16) * Math.PI * 2;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        origin.set(point.centre.x - dx * r, point.centre.y, point.centre.z - dz * r);
        if (!this.nav.sample(origin, 16, landed)) continue;
        eye.set(landed.x, landed.y + 1.65, landed.z);
        // OPEN SKY AT THE CAMERA. A market arcade satisfies "unobstructed line
        // of sight down 90 m" perfectly and is also a dark tunnel — the first
        // version of this search chose one and the LOD shot came back as six
        // silhouettes nobody could grade. Only the camera is tested: requiring
        // it at every rung as well finds nothing at all in this town.
        sky.set(eye.x, eye.y + 26, eye.z);
        if (this.los.visibility(eye, sky) <= 0.5) continue;
        let clear = 0;
        for (const d of LOD_LADDER) {
          at.set(landed.x + dx * d, 0, landed.z + dz * d);
          if (!this.nav.sample(at, 5, origin)) break;
          origin.y += 1.2;
          if (this.los.visibility(eye, origin) <= 0.5) break;
          clear++;
        }
        if (clear > bestScore) {
          bestScore = clear;
          heading = h;
          radius = r;
        }
        if (clear === LOD_LADDER.length) break;
      }
      if (bestScore === LOD_LADDER.length) break;
    }
    if (heading < 0 || bestScore < 4) return;

    const a = (heading / 16) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    origin.set(point.centre.x - dx * radius, point.centre.y, point.centre.z - dz * radius);
    if (!this.nav.sample(origin, 16, landed)) return;
    const base = landed.clone();
    // Facing the camera, so the frame shows the chest rig and not six packs.
    const yaw = Math.atan2(dx, dz);

    for (let i = 0; i < LOD_LADDER.length; i++) {
      const d = LOD_LADDER[i];
      // A metre of lateral stagger per man: six soldiers on one exact line
      // occlude each other into a single silhouette at the far end.
      const lateral = (i % 2 === 0 ? 1 : -1) * (0.9 + i * 0.35);
      at.set(base.x + dx * d - dz * lateral, 0, base.z + dz * d + dx * lateral);
      if (!this.nav.sample(at, 6, landed)) continue;
      const profile = BOT_PROFILES[i % BOT_PROFILES.length];
      const team = i % 2 === 0 ? Team.Coalition : Team.Insurgent;
      const entity = this.spawnBot(team, profile, {
        team,
        position: landed.clone(),
        yaw,
        linkedPoint: point.id,
      });
      const bot = this.byEntity.get(entity as number);
      if (!bot) continue;
      // Posed, not fighting: rifle up, no contact, no path. This shot is about
      // the mesh, and a bot that walks out of frame during the warm-up frames
      // is a shot that captures a different thing every time the LOD distances
      // are touched.
      bot.behaviour = BotBehaviour.Idle;
      bot.settle = 1;
      bot.exposure = 1;
      bot.stance = i === 3 ? Stance.Crouch : Stance.Stand;
      bot.goal.set(0, 0, 0);
      bot.goalKind = 'idle';
      bot.aimYaw = yaw;
      bot.aimAt.set(base.x - dx * 30, landed.y + 1.5, base.z - dz * 30);
    }

    this.tableauPose = {
      position: [base.x, base.y + 1.65, base.z],
      target: [base.x + dx * 40, base.y + 1.5, base.z + dz * 40],
    };
  }

  /* --------------------------------------------------------------- world --- */

  private readonly actorByEntity = new Map<number, ActorView>();

  private actorOf(entity: EntityId): ActorView | undefined {
    return this.actorByEntity.get(entity as number);
  }

  private visibility(from: Vec3, to: Vec3): number {
    // PHYS is the authority whenever it is live. The null physics answers every
    // ray "clear", and a bot that sees through buildings never takes cover,
    // never flanks and never suppresses — i.e. every behaviour this lane exists
    // to produce silently stops being exercised.
    if (this.services.physics.ready) {
      return this.services.physics.visibility(from, to, LAYER_SOLID);
    }
    if (this.los.empty) return 1;
    return this.los.visibility(from, to);
  }

  private onNoise(event: NoiseEvent): void {
    // Gunfire and explosions are squad-level intelligence, not just a flinch.
    // Footsteps are not: a man walking is heard at 12 m and would pin every
    // squad in the game to wherever its own point man happens to be standing.
    //
    // ONLY THE OTHER SIDE IS TOLD. Reporting a gunshot to the shooter's own
    // team as well looks symmetric and is a trap: the position of my own rifle
    // is BEHIND me, so every burst my squad fires becomes an attractor to the
    // rear and the team walks backwards into itself. Measured: doing both
    // halved the kills (5 → 1) and pushed Regroup from 4.8% to 17.5% of all
    // bot-ticks. A squad learns that its mates are fighting from
    // `hasContactPoint` in `squad.ts`, which reports the ENEMY's position and
    // therefore pulls forward.
    if (event.kind === 'gunshot' || event.kind === 'explosion') {
      const enemy = event.team === Team.Coalition ? Team.Insurgent : Team.Coalition;
      this.squads.noteContact(enemy, event.position, this.world.time, 1.5);
    }
    for (const bot of this.botList) {
      if (!bot.alive) continue;
      const state = this.services.player.stateOf(bot.entity);
      if (!state) continue;
      this.scratch.copy(state.position);
      hear(bot, event, this.world, this.scratch);

      // Being SHOT AT is not the same as hearing a shot. GAME raises
      // `PlayerState.suppression` on a genuine near miss, which is the
      // authority — but a rifle going off inside 14 m makes a soldier flinch
      // whether or not that particular round was close, and without this a
      // whole firefight can run with every bot's aim cone at its calm value.
      if (event.kind !== 'footstep' && event.team !== bot.team) {
        const distance = this.scratch.distanceTo(event.position);
        const near = event.kind === 'explosion' ? 26 : 14;
        if (distance < near) {
          const strength = (1 - distance / near) * (event.kind === 'explosion' ? 0.75 : 0.32);
          bot.suppression = Math.min(1, bot.suppression + strength);
        }
      }
    }
  }

  /**
   * `T` — SPOT. The one place in this lane the human player gives an order.
   *
   * `Btn.Spot` reached the input layer and was consumed by nothing, so pressing
   * it did nothing at all. It is read here rather than in GAME because what a
   * spot MEANS is entirely an AI concept: it is a contact report, and this lane
   * owns the ledger those go into.
   *
   * What it does NOT do is hand anyone a free kill. The spotted man becomes a
   * KNOWN position for the player's team — `heardOnly: false`, confidence just
   * under the sight threshold — so squadmates move on him, take angles and
   * suppress, but every one of them still has to acquire him visually before
   * `fireControl` will pull a trigger. A spot that granted `visible` would turn
   * the whole team into an aimbot on one keystroke.
   */
  private pollSpot(): void {
    const player = this.services.player;
    const local = player.localEntity;
    const intent = player.intentOf(local);
    if (!intent || (intent.pressed & Btn.Spot) === 0) return;
    const self = player.stateOf(local);
    if (!self || !self.alive || self.team === Team.Neutral) return;
    this.applySpot(local, self);
  }

  /**
   * The payload of a spot, split from the keypress so it can be exercised
   * without a keyboard. `pollSpot` above is the edge detector and nothing else.
   */
  private applySpot(local: EntityId, self: Readonly<PlayerState>): EntityId | null {
    const player = this.services.player;
    const cosPitch = Math.cos(self.pitch);
    const dirX = -Math.sin(self.yaw) * cosPitch;
    const dirY = Math.sin(self.pitch);
    const dirZ = -Math.cos(self.yaw) * cosPitch;
    const eyeX = self.position.x;
    const eyeY = self.position.y + self.eyeHeight;
    const eyeZ = self.position.z;

    // `PlayerService.controlled` rather than `world.actors`: the actor list is
    // rebuilt at the top of this lane's tick, and a spot must not depend on
    // having been asked at the right point of the frame.
    let spotted: EntityId | null = null;
    let spottedState: Readonly<PlayerState> | null = null;
    let bestDot = SPOT_CONE_COS;
    for (const entity of player.controlled) {
      if (entity === local) continue;
      const state = player.stateOf(entity);
      if (!state || !state.alive || state.team === self.team || state.team === Team.Neutral) continue;
      const actor = { entity, state };
      const dx = actor.state.position.x - eyeX;
      const dy = actor.state.position.y + actor.state.eyeHeight * 0.6 - eyeY;
      const dz = actor.state.position.z - eyeZ;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 1e-3 || distance > SPOT_RANGE_M) continue;
      const dot = (dx * dirX + dy * dirY + dz * dirZ) / distance;
      if (dot <= bestDot) continue;
      this.scratch.set(eyeX, eyeY, eyeZ);
      this.scratchB.set(actor.state.position.x, actor.state.position.y + actor.state.eyeHeight, actor.state.position.z);
      if (this.visibility(this.scratch, this.scratchB) <= 0.4) continue;
      bestDot = dot;
      spotted = actor.entity;
      spottedState = actor.state;
    }

    if (!spotted || !spottedState) {
      // Nothing under the reticle: still a directional call. "Contact, that
      // way" is a real thing a squad acts on, and it is what makes the key feel
      // connected even when the player was a few degrees off.
      this.scratch.set(eyeX + dirX * SPOT_BLIND_M, eyeY + dirY * SPOT_BLIND_M, eyeZ + dirZ * SPOT_BLIND_M);
      this.squads.noteContact(self.team, this.scratch, this.world.time, 2);
      return null;
    }

    this.squads.noteContact(self.team, spottedState.position, this.world.time, 4);
    for (const bot of this.botList) {
      if (!bot.alive || bot.team !== self.team) continue;
      const state = player.stateOf(bot.entity);
      if (!state) continue;
      if (sqDistance(state.position, self.position) > SPOT_SHARE_M * SPOT_SHARE_M) continue;
      const memory = bot.memoryFor(spotted, this.world.time);
      memory.lastKnown.copy(spottedState.position);
      memory.lastVelocity.copy(spottedState.velocity);
      memory.heardOnly = false;
      memory.lastSeenTime = this.world.time;
      memory.staticSince = this.world.time;
      memory.distance = Math.sqrt(sqDistance(state.position, spottedState.position));
      // Just under 1: a spot tells the squad WHERE, not that they can see him.
      // Crossing 1 here would arm `reactionAt` and let a man behind a wall be
      // shot through it.
      memory.confidence = Math.max(memory.confidence, 0.92);
    }
    return spotted;
  }

  private weaponDef(bot: Bot): Readonly<WeaponDef> | null {
    try {
      return this.services.weapons.def(bot.weapon);
    } catch {
      // A weapon table that does not know this id yet is not a reason to stop
      // the bot thinking; the shadow fire model has its own defaults.
      return null;
    }
  }

  /** Rebuild the ActorView list from `PlayerService.controlled`, in attach order. */
  private refreshActors(): void {
    const player = this.services.player;
    const controlled = player.controlled;
    const actors = this.world.actors;
    actors.length = 0;
    // The map is a LOOKUP, never an iteration source: five subsystems ask for
    // the same actor eight times a tick each, and the array beside it is what
    // anything order-sensitive walks (architecture §9.2).
    this.actorByEntity.clear();
    for (let i = 0; i < controlled.length; i++) {
      const entity = controlled[i];
      const state = player.stateOf(entity);
      if (!state) continue;
      let view = this.actorPool[actors.length] as Mutable<ActorView> | undefined;
      if (!view) {
        view = { entity, state, team: state.team, human: entity === player.localEntity };
        this.actorPool[actors.length] = view;
      }
      view.entity = entity;
      view.state = state;
      view.team = state.team;
      view.human = entity === player.localEntity;
      actors.push(view);
      this.actorByEntity.set(entity as number, view);
    }
  }

  /* ---------------------------------------------------------------- tick --- */

  tick(ctx: TickCtx): void {
    const world = this.world;
    world.time = ctx.time;
    world.dt = ctx.dt;
    world.tick = ctx.tick;
    world.difficulty = this.difficultyValue;
    world.quality = ctx.quality;
    world.weaponsLive = !this.weaponsNull;

    this.refreshActors();

    // The LOS broadphase is rebuilt only when the obstacle set actually changed
    // — destruction bumps it through `nav.invalidate`, and nothing else does.
    if (this.losBuiltFrom !== this.nav.obstacles.length) {
      this.los.build(this.nav.obstacles);
      this.losBuiltFrom = this.nav.obstacles.length;
    }

    // Time-slice the pathfinder BEFORE anyone reads a corridor, so a path that
    // completed this tick is followed this tick and not next one.
    const paths = Math.max(1, ctx.quality.ai.pathsPerTick);
    this.nav.stepQueue(768 * paths, paths);

    // Reap in reverse so a splice cannot skip the next body in the list.
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i];
      if (corpse.deathTime >= 0 && ctx.time - corpse.deathTime > CORPSE_SECONDS) this.reap(corpse);
    }

    if (this.botList.length === 0) return;
    this.tickIndex++;

    this.pollSpot();
    this.squads.update(world, this.services.level.capturePoints);

    const baseStride = strideFor(ctx.quality.ai.perceptionHz);
    const localState = this.services.player.stateOf(this.services.player.localEntity);

    for (let i = 0; i < this.botList.length; i++) {
      const bot = this.botList[i];
      const state = this.services.player.stateOf(bot.entity);
      if (!state) continue;
      const self = this.actorOf(bot.entity);
      if (!self) continue;

      if (!state.alive || !bot.alive) {
        if (bot.alive) {
          bot.alive = false;
          bot.deathTime = ctx.time;
        }
        bot.behaviour = BotBehaviour.Dead;
        bot.trigger = false;
        bot.gaitSpeed = 0;
        writeIntent(bot, world);
        continue;
      }

      // ---- LOD'd think ----------------------------------------------------
      // Distance is measured from the LOCAL PLAYER, not the camera: this is a
      // tick, the camera does not exist here, and a bot's think rate must not
      // change because a spectator looked away.
      let stride = baseStride;
      if (localState) {
        const d2 = sqDistance(state.position, localState.position);
        if (d2 > 160 * 160) stride = baseStride * 4;
        else if (d2 > 70 * 70) stride = baseStride * 2;
      }
      if ((this.tickIndex + bot.thinkPhase) % stride === 0) {
        const elapsed = bot.lastThinkTime < 0 ? ctx.dt : Math.max(ctx.dt, ctx.time - bot.lastThinkTime);
        bot.lastThinkTime = ctx.time;
        perceive(bot, world, elapsed);
        this.brain.think(bot, world, this.services.level.capturePoints);
      }

      // ---- every tick: aim, trigger, intent -------------------------------
      const memory = bot.target !== 0 ? bot.memoryOf(bot.target) ?? null : selectTarget(bot, world);
      const engaged = memory !== null && memory.visible;
      desiredAimPoint(bot, world, memory, self);
      const error = solveAim(bot, world, self, engaged);
      this.brain.fireControl(bot, world, memory, error, this.weaponDef(bot));

      // Suppression is felt from the body, not invented here: GAME's damage
      // model raises `PlayerState.suppression` on near misses, and the aim cone
      // in `aim.ts` reads `bot.suppression`.
      bot.suppression = Math.max(bot.suppression, state.suppression);

      writeIntent(bot, world);

      // ---- presentation state advanced in the TICK ------------------------
      // Gait phase belongs to the simulation so the walk cycle is identical on
      // frame 32 of a capture however many render frames preceded it.
      const speed = state.groundSpeed;
      const target = Math.min(1, speed / 4.2);
      bot.gaitSpeed += (target - bot.gaitSpeed) * Math.min(1, ctx.dt * 6);
      // Stride frequency rises with speed: 1.9 Hz walking, ~3.1 Hz sprinting.
      bot.gaitPhase = (bot.gaitPhase + ctx.dt * (1.9 + bot.gaitSpeed * 4.2) * bot.gaitSpeed) % (Math.PI * 2);

      const view = this.views[i] as Mutable<BotView>;
      view.entity = bot.entity;
      view.team = bot.team;
      view.name = bot.name;
      view.position = state.position;
      view.health = state.health;
      view.behaviour = bot.behaviour;
      view.target = bot.target;
      view.squad = bot.squad;
      this.scratchB.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
      (view.forward as THREE.Vector3).copy(this.scratchB);
    }
  }

  /**
   * `TickPhase.PrePhysics` — drive the per-zone hitboxes to this tick's pose,
   * after Movement has written it and before the one `world.step()`.
   *
   * A separate system rather than a tail on `tick()` because the phase is the
   * contract: run it at `Ai` and every hitbox is a tick behind the body it
   * belongs to, which shows up as bullets passing through a running man's chest.
   */
  syncHitboxes(): void {
    if (!this.services.physics.ready) return;
    const player = this.services.player;
    for (const bot of this.botList) {
      const state = player.stateOf(bot.entity);
      const config = player.configOf(bot.entity);
      if (!state || !config) continue;
      this.hitboxes.sync(bot.entity, config, state);
    }
  }

  /* -------------------------------------------------------------- render --- */

  attachPresentation(ctx: BootContext): void {
    const player = ctx.services.player;
    const config = player.configOf(player.localEntity);
    // Sized from GAME's capsule, never from constants of our own: a 5 cm
    // disagreement between the mesh and the capsule reads as a physics bug.
    const standHeight = config?.standHeight ?? 1.8;
    const radius = config?.radius ?? 0.34;
    const model = buildSoldierModel(ctx.services.materials, standHeight, radius);
    // Null when the whole-repo material permutation cap is already spent. The
    // bots still think, path, shoot and capture; they are simply invisible,
    // which is a far smaller failure than taking every lane's boot down with us.
    if (!model) return;
    this.renderer = new SoldierRenderer(
      model,
      ctx.services.scene,
      // Headroom over the tier's ceiling, not equal to it: the instance buffers
      // are matrices and cost nothing, and a shot tableau or a mid-round tier
      // drop that spawned one more bot than the buffer holds would silently
      // stop drawing him.
      Math.max(28, ctx.quality.settings.ai.maxBots + 4),
    );
    this.debug = new AiDebugDraw(ctx.services.scene, ctx.services.materials);
    this.debug.enabled = this.tableau !== '' && this.tableau !== 'live';
  }

  render(ctx: FrameCtx): void {
    if (!this.renderer) return;
    const player = this.services.player;
    const stateOf = (bot: Bot): Readonly<PlayerState> | null => player.stateOf(bot.entity);
    this.renderer.update(ctx, this.drawList, stateOf);
    this.scratch.copy(ctx.camera.position);
    // The debug overlay draws REASONING, and a corpse has none — it walks the
    // live list only.
    this.debug?.update(this.botList, this.nav, stateOf, this.scratch);
  }

  /* --------------------------------------------------------- shot tableau --- */

  /**
   * Pose a firefight that a still frame can be read. Everything here is a
   * deterministic function of the lane RNG (already reseeded by the harness
   * chain) and of the frozen level anchors, so two captures are identical.
   *
   * It does NOT freeze the bots — they are spawned with a live contact each and
   * then simulate normally, which is the point: the critic is looking at real
   * cover selection and a real peek rhythm, not at a mannequin arrangement.
   */
  private buildTableau(state: string): void {
    const points = this.services.level.capturePoints;
    if (points.length === 0) return;
    // ALPHA unless told otherwise: it is the densest massing on the map and
    // therefore the only point where cover behaviour is visible at all.
    const wanted = state === 'bravo' ? 'BRAVO' : state === 'charlie' ? 'CHARLIE' : 'ALPHA';
    const point = points.find((p) => p.id === wanted) ?? points[0];

    const attackers = 6;
    const defenders = 6;
    const spawn = new THREE.Vector3();
    const landed = new THREE.Vector3();

    // Attackers come in from the south-east on a shallow arc, defenders hold
    // the far side of the flag. The axis is fixed rather than random so the
    // shot camera below always looks down the length of the engagement.
    const axis = new THREE.Vector3(-0.72, 0, -0.69).normalize();

    const place = (
      team: Team,
      index: number,
      count: number,
      distance: number,
      spreadMetres: number,
      profileIndex: number,
    ): void => {
      const lateral = ((index - (count - 1) * 0.5) / Math.max(1, count - 1)) * spreadMetres;
      const side = new THREE.Vector3(-axis.z, 0, axis.x);
      const sign = team === Team.Coalition ? 1 : -1;
      spawn
        .copy(point.centre)
        .addScaledVector(axis, -distance * sign)
        .addScaledVector(side, lateral)
        // Depth stagger, toward the objective. A squad advancing in a straight
        // rank is the chorus-line tell; strung out over ~14 m is what a fire
        // team actually looks like, and it is also what puts one man inside
        // LOD 0 and another at LOD 1 in the same frame.
        .addScaledVector(axis, ((index % 3) * 5.5 + Math.floor(index / 3) * 2.5) * sign);
      if (!this.nav.sample(spawn, 22, landed)) landed.copy(spawn);
      const yaw = Math.atan2(-(axis.x * sign), -(axis.z * sign)) + Math.PI;
      const profile = BOT_PROFILES[profileIndex % BOT_PROFILES.length];
      this.spawnBot(team, profile, {
        team,
        position: landed.clone(),
        yaw,
        linkedPoint: point.id,
      });
    };

    // 32 m and 24 m either side of the flag rather than 46 and 34. The two
    // squads have to fit in ONE frame with a lens a human would use, and a 80 m
    // engagement at 52° puts both ends of it in the far third of the image with
    // sixty metres of empty road in front.
    for (let i = 0; i < attackers; i++) {
      place(Team.Coalition, i, attackers, 32, 17, SQUAD_COMPOSITION[i % SQUAD_COMPOSITION.length]);
    }
    for (let i = 0; i < defenders; i++) {
      place(Team.Insurgent, i, defenders, 24, 19, SQUAD_COMPOSITION[(i + 2) % SQUAD_COMPOSITION.length]);
    }

    // Give everyone a live contact so the first tick already has a fight in it
    // rather than twelve men walking toward a flag. The memory is seeded at the
    // OPPOSING side's centroid, which is what a squad that has just taken fire
    // actually believes, and perception corrects it within the second.
    const centroid = (team: Team, out: THREE.Vector3): boolean => {
      let n = 0;
      out.set(0, 0, 0);
      for (const bot of this.botList) {
        if (bot.team !== team) continue;
        const s = this.services.player.stateOf(bot.entity);
        if (!s) continue;
        out.add(s.position);
        n++;
      }
      if (n === 0) return false;
      out.multiplyScalar(1 / n);
      return true;
    };
    const coalitionCentre = new THREE.Vector3();
    const insurgentCentre = new THREE.Vector3();
    const haveC = centroid(Team.Coalition, coalitionCentre);
    const haveI = centroid(Team.Insurgent, insurgentCentre);

    for (const bot of this.botList) {
      const enemyCentre = bot.team === Team.Coalition ? insurgentCentre : coalitionCentre;
      if (!(bot.team === Team.Coalition ? haveI : haveC)) continue;
      const selfState = this.services.player.stateOf(bot.entity);
      const from = selfState ? selfState.position : enemyCentre;
      let nearest: Bot | null = null;
      let bestD2 = Infinity;
      for (const other of this.botList) {
        if (other.team === bot.team) continue;
        const s = this.services.player.stateOf(other.entity);
        if (!s) continue;
        // Nearest to THIS bot — the man he would actually have spotted first,
        // not the man closest to his enemy's centre of mass.
        const d2 = sqDistance(s.position, from);
        if (d2 < bestD2) {
          bestD2 = d2;
          nearest = other;
        }
      }
      if (!nearest) continue;
      // EVERY TIME BELOW IS RELATIVE TO `world.time`, NOT TO ZERO. The harness
      // does not rewind the clock between captures — `seed()` resets the RNG,
      // the graph histories and every lane's transient state, but `ctx.time`
      // keeps counting — so a memory stamped at absolute 0 is fourteen seconds
      // stale the instant it is created and is forgotten on the first tick.
      const now = this.world.time;
      const memory = bot.memoryFor(nearest.entity, now);
      const enemyState = this.services.player.stateOf(nearest.entity);
      memory.lastKnown.copy(enemyState ? enemyState.position : enemyCentre);
      memory.lastVelocity.set(0, 0, 0);
      memory.confidence = 1.05;
      memory.visible = true;
      memory.heardOnly = false;
      memory.lastSeenTime = now;
      memory.firstSeenTime = now;
      memory.staticSince = now;
      // The reaction clock still runs. A bot that opens fire on frame 0 is the
      // exact failure this lane's aim model exists to prevent, and the shot
      // should show that failure absent, not hidden.
      memory.reactionAt = now + bot.profile.reactionTime * (1.55 - this.difficultyValue * 0.85);
      memory.distance = Math.sqrt(bestD2);
      bot.target = nearest.entity;
      bot.behaviour = BotBehaviour.Engage;
      bot.stance = Stance.Stand;
    }

    this.settleTableauCover(coalitionCentre, insurgentCentre);
    this.tableauPose = this.solveTableauCamera(coalitionCentre, insurgentCentre);
  }

  /**
   * Put half of each squad into cover BEFORE the first tick.
   *
   * Not a cheat, and not a pose: a firefight that has been running for a minute
   * has half its men behind something, and the alternative is a shot that has to
   * warm up for four seconds of simulation — 240 rasterised frames — before the
   * behaviour it exists to prove becomes visible. Which slot each man gets comes
   * from the same `CoverBook.find` the brain calls, with the same claim
   * arbitration, so what the frame shows is the real chooser's real answer.
   *
   * The other half are left in the open, mid-advance. Twelve men all in cover
   * reads as a diorama; six in cover and six moving reads as a fight.
   */
  private settleTableauCover(coalitionCentre: THREE.Vector3, insurgentCentre: THREE.Vector3): void {
    const player = this.services.player;
    const claimedSlots = new Set<number>();
    const index = { value: -1 };
    const threat = new THREE.Vector3();
    for (const bot of this.botList) {
      // Deterministic split on the spawn slot, which is also what decides the
      // lean direction in `intent.ts`, so the men who peek alternate sides.
      if (bot.slot % 2 === 1) continue;
      const state = player.stateOf(bot.entity);
      if (!state) continue;
      threat.copy(bot.team === Team.Coalition ? insurgentCentre : coalitionCentre);
      const slot = this.nav.cover.find(state.position, threat, 20, (i) => claimedSlots.has(i), index);
      if (!slot) continue;
      // `index.value` is -1 when LEVEL owns the cover query; the claim set is
      // then meaningless and the arbitration falls back to distance alone.
      if (index.value >= 0) claimedSlots.add(index.value);
      bot.cover = slot;
      bot.coverIndex = index.value;
      bot.goal.copy(slot.position);
      bot.goalKind = 'cover';
      bot.behaviour = BotBehaviour.TakeCover;
      // Half of the men in cover are leaning out with the rifle up and half are
      // down behind it reloading — the two ends of the peek rhythm, in one frame.
      const peeking = bot.slot % 4 === 0;
      const now = this.world.time;
      bot.exposure = peeking ? 0.92 : 0.08;
      bot.peekUntil = peeking ? now + 1.3 : 0;
      bot.hideUntil = peeking ? 0 : now + 1.1;
      bot.behaviourSince = now;
      bot.stance = peeking ? Stance.Stand : Stance.Crouch;
      const yaw = Math.atan2(-(threat.x - slot.position.x), -(threat.z - slot.position.z));
      player.teleport(bot.entity, slot.position, yaw, 0);
      bot.aimYaw = yaw;
      bot.aimAt.set(
        slot.position.x - Math.sin(yaw) * 40,
        slot.position.y + 1.5,
        slot.position.z - Math.cos(yaw) * 40,
      );
    }
  }

  private tableauPose: TableauPose | null = null;

  get shotPose(): TableauPose | null {
    return this.tableauPose;
  }

  /**
   * Find a camera that can actually SEE the squad it is pointed at.
   *
   * Hand-written coordinates cannot survive here: the block-out massing is
   * generated, the navmesh decides where the bots end up standing, and a pose
   * authored against one of those ends up inside a wall when the other changes.
   * So the shot asks for a pose and this searches for one — over a fixed,
   * ordered candidate set, scored with the SAME `LosGrid` the bots see through,
   * which makes the answer deterministic and makes "the camera is in a
   * building" a state that cannot be reached.
   */
  private solveTableauCamera(coalition: THREE.Vector3, insurgent: THREE.Vector3): TableauPose | null {
    if (this.los.empty) this.los.build(this.nav.obstacles);
    let best: TableauPose | null = null;
    let bestScore = -Infinity;
    // BOTH shoulders. The engagement axis is fixed, but which end of it the
    // camera stands at is not, and the two ends are lit very differently at a
    // low sun and cluttered very differently by the town. Searching both and
    // scoring them against each other costs fifty extra ray tests at setup and
    // is the difference between a frame in a shadowed alley and one down a
    // sunlit street.
    for (const flip of [false, true]) {
      const friend = flip ? insurgent : coalition;
      const enemy = flip ? coalition : insurgent;
      const candidate = this.solveCameraFrom(friend, enemy);
      if (candidate && candidate.score > bestScore) {
        bestScore = candidate.score;
        best = candidate.pose;
      }
    }
    return best;
  }

  private solveCameraFrom(
    friend: THREE.Vector3,
    enemy: THREE.Vector3,
  ): { pose: TableauPose; score: number } | null {
    const dir = this.scratch.copy(enemy).sub(friend).setY(0);
    if (dir.lengthSq() < 1e-4) return null;
    dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const eye = new THREE.Vector3();
    const look = new THREE.Vector3();
    const probe = new THREE.Vector3();
    const sky = new THREE.Vector3();
    const view = new THREE.Vector3();
    const toBot = new THREE.Vector3();

    // The subject: the squad itself, plus the ground between the two squads,
    // which is where the fight visibly happens.
    look.copy(friend).addScaledVector(this.scratchB.copy(enemy).sub(friend), 0.42);

    let best: TableauPose | null = null;
    let bestScore = -Infinity;
    // Ordered coarse→fine. Nearer and lower is a better photograph; the score
    // only overrides that when the nearer pose cannot see anything.
    for (const distance of [8, 11, 14, 18, 23, 29]) {
      for (const lateral of [0, 7, -7, 13, -13]) {
        for (const height of [2.0, 3.0, 4.4, 7, 11]) {
          eye.copy(friend).addScaledVector(dir, -distance).addScaledVector(side, lateral);
          const ground = this.nav.sample(eye, 26, probe) ? probe.y : eye.y;
          eye.y = ground + height;
          if (this.insideObstacle(eye)) continue;

          // IN FRAME, not merely in line of sight. A bot behind the camera with
          // a clear ray between them is not in the photograph, and scoring it as
          // if it were is how a solver talks itself into a pose looking away from
          // its own subject. 24° is inside the 52° lens the shot file uses.
          view.copy(look).sub(eye).normalize();
          let seen = 0;
          let nearest = Infinity;
          let tooClose = 0;
          for (const bot of this.botList) {
            const state = this.services.player.stateOf(bot.entity);
            if (!state) continue;
            probe.set(state.position.x, state.position.y + 1.2, state.position.z);
            const d = eye.distanceTo(probe);
            if (d < 1e-3) continue;
            toBot.copy(probe).sub(eye).multiplyScalar(1 / d);
            if (toBot.dot(view) < 0.8829) continue;
            if (this.los.visibility(eye, probe) <= 0.5) continue;
            seen++;
            if (d < nearest) nearest = d;
            if (d < 6) tooClose++;
          }
          if (seen === 0) continue;
          probe.copy(look).setY(look.y + 1.6);
          const centreClear = this.los.visibility(eye, probe) > 0.5 ? 2 : 0;
          // Is there sky overhead? A camera under a market awning is technically
          // outdoors, sees the squad, and produces a frame with a black slab
          // across the top third. This is the cheapest test that catches it.
          sky.set(eye.x, eye.y + 26, eye.z);
          const openSky = this.los.visibility(eye, sky) > 0.5 ? 2.5 : 0;
          // The shot has to prove THREE LODs, so a pose that sees more men from
          // further away is worth less than one that sees slightly fewer with a
          // man inside 20 m — LOD 0 is where the gear silhouette is legible at
          // all, and a frame of 90 m specks proves nothing about the model.
          const lodBonus = (nearest < 18 ? 6 : 0) + (nearest < 30 ? 2 : 0);
          // Height is penalised hard. Every extra metre of camera tilts the
          // horizon up and trades soldiers for road: the frame this shot exists
          // to produce is shoulder height in a street, not a survey photograph.
          const score =
            seen * 2.5 + centreClear + openSky + lodBonus - tooClose * 2.5 - distance * 0.06 - height * 0.55;
          if (score > bestScore) {
            bestScore = score;
            best = {
              position: [eye.x, eye.y, eye.z],
              target: [look.x, look.y + 1.6, look.z],
            };
          }
        }
      }
    }
    return best ? { pose: best, score: bestScore } : null;
  }

  /** Is this point inside one of the boxes the navmesh was stamped from? */
  private insideObstacle(point: THREE.Vector3): boolean {
    for (const o of this.nav.obstacles) {
      // Skip district-scale boxes. An obstacle is an AABB, so a long wall, a
      // terrain trimesh or a whole block of buildings collapses into a volume
      // that contains most of the map — true as a "do not path through the
      // middle of it" hint, useless as "the camera is inside a building", and
      // without this guard one such collider rejects every candidate pose.
      if (o.maxX - o.minX > 45 || o.maxZ - o.minZ > 45) continue;
      if (
        point.x > o.minX - 0.6 &&
        point.x < o.maxX + 0.6 &&
        point.z > o.minZ - 0.6 &&
        point.z < o.maxZ + 0.6 &&
        point.y > o.minY - 0.6 &&
        point.y < o.maxY + 0.6
      ) {
        return true;
      }
    }
    return false;
  }

  dropTransient(): void {
    this.difficultyValue = 0.5;
    this.tableau = '';
    this.tableauPose = null;
    if (this.debug) this.debug.enabled = false;
    this.squads.clear();
    this.losBuiltFrom = -1;
    this.tickIndex = 0;
    this.world.actors.length = 0;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  setWeaponsNull(value: boolean): void {
    this.weaponsNull = value;
  }

}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A camera pose in the exact shape `ShotContext.poseCamera` takes. */
export interface TableauPose {
  readonly position: [number, number, number];
  readonly target: [number, number, number];
}

function makeView(bot: Bot): BotView {
  return {
    entity: bot.entity,
    team: bot.team,
    name: bot.name,
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    health: 100,
    behaviour: bot.behaviour,
    target: 0 as EntityId,
    squad: bot.squad,
  };
}

function sqDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/* -------------------------------------------------------- the three exports */

export function createAiService(ctx: BootContext): AiService {
  const nav = navRuntime();
  if (!nav) {
    // `dependsOn: ['nav', 'level', 'player']` guarantees the nav descriptor ran,
    // so this is unreachable — but it is the one failure that would otherwise
    // present as "bots exist and never move", which costs a day to find.
    throw new Error('AiService: nav service was not constructed before ai (check subsystems.ts dependsOn).');
  }
  const ai = new IronAi(ctx, nav);
  instance = ai;

  ctx.addTick({
    name: 'ai.think',
    phase: TickPhase.Ai,
    order: 0,
    tick: (tick) => ai.tick(tick),
  });
  ctx.addTick({
    name: 'ai.hitboxes',
    phase: TickPhase.PrePhysics,
    order: 10,
    tick: () => ai.syncHitboxes(),
  });
  ctx.addRender({
    name: 'ai.soldiers',
    stage: RenderStage.Animation,
    order: 20,
    update: (frame) => ai.render(frame),
  });

  // Presentation is built after boot: it needs `MaterialFactory` (RCORE) and
  // `SceneGraph`, neither of which this lane may declare in the frozen
  // `dependsOn`, and it needs GAME's capsule to size the rig.
  ctx.afterBoot(() => {
    ai.setWeaponsNull(ctx.registry.isNull('weapons'));
    ai.attachPresentation(ctx);
  });

  ctx.report('ai: bot pool ready');
  return ai;
}

/**
 * Soldier mesh, rig and clips are built from `MaterialFactory` at `afterBoot`
 * rather than baked: the geometry is a few thousand vertices of merged
 * primitives (well under a millisecond) and it must be sized from GAME's
 * capsule, which does not exist when bake steps are declared.
 *
 * The expensive half of navigation IS a bake and is declared by `nav.ts`
 * (`ai.navfield`, step 12) — that is the step this lane pays for at load time.
 */
export function registerAiBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // No AI-owned bake steps; `registerNavBakes` declares this lane's only one.
}

export function resetAi(_seed: number): void {
  // `despawnAll()` has already run earlier in the chain (driver.ts calls it
  // explicitly). What is left is squad orders, difficulty, the debug overlay
  // and the think-rate phase — every one of which would otherwise make a
  // capture depend on the order shots were taken in.
  instance?.dropTransient();
}

/**
 * Lane-private accessor for `src/shots/ai.ts`.
 *
 * `ShotContext` exposes only `setTimeOfDay`/`setWeather`/`poseCamera`/
 * `setOverlays`/`setPlayerState`/`seed` and has no route to a service, so a
 * shot that needs a posed squad has exactly two options: key off a magic seed
 * value (invisible, and it breaks the moment someone re-seeds), or import the
 * lane it belongs to. The shot file and this file are both AI's, so the second
 * is the honest one. `src/shots/ai.ts` is the ONLY caller.
 */
export function poseAiTableau(state: string): TableauPose | null {
  instance?.forceState(state);
  return instance?.shotPose ?? null;
}
