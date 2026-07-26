/**
 * PlayerService — locomotion for EVERY intent-driven entity, and the dispatch
 * that makes bots and the human share one code path.
 *
 * OWNER: GAME.
 *
 * THIS LANE OWNS PER-ENTITY INTENT DISPATCH. Nobody else may register a system
 * at `TickPhase.Intent` or `TickPhase.Movement`. The two systems below are the
 * whole of it:
 *
 *   Intent    for each entity in `PlayerService.controlled`, in attach order,
 *             call `source.sample(entity, ctx, that entity's intent)`. The
 *             human's source is `InputService.source`; a bot's is
 *             `AiService.intentSource`, handed over by AI when it calls
 *             `attachController` inside `spawnBot`.
 *   Movement  intent → acceleration / friction / air control →
 *             `CharacterController.move()`, applying the translation rapier
 *             RETURNS, never the delta you asked for. No forces are ever applied
 *             to a character body.
 *
 * A bot is not a second kind of mover. It is an entity in the same table with a
 * different `IntentSource`, which is why a feel change lands for 24 bots and the
 * player at the same instant (architecture decision #6).
 *
 * WHERE THE WORK ACTUALLY LIVES. This file is the SERVICE: the table, the
 * dispatch, the entity/component bookkeeping and the harness hooks. The physics
 * of moving a body is `locomotion.ts`, the world queries behind vault and stance
 * are `probe.ts`, the numbers are `tuning.ts`, and damage/respawn is
 * `damage.ts`. Keeping the service thin is what lets all four be read on their
 * own.
 *
 * DEGRADATION. `PhysicsService.ready` is false until PHYS lands its rapier
 * world, so a `CharacterController` is created LAZILY, the first tick physics
 * reports ready. Until then `locomotion.ts` resolves ground and obstacles
 * analytically against `MACRO_TERRAIN` and the probe's box set — the same thing
 * the day-0 null player did, so nothing a lane framed today moves when rapier
 * arrives.
 */
import * as THREE from 'three';
import {
  RenderStage,
  Stance,
  Team,
  TickPhase,
  type AssetRegistry,
  type BootContext,
  type CharacterConfig,
  type EntityId,
  type FrameCtx,
  type IntentSource,
  type PlayerIntent,
  type PlayerService,
  type PlayerState,
  type QualitySettings,
  type Services,
  type TickCtx,
  type Vec3,
} from '@/engine/types';
import { Actor, Health, TeamTag, Transform, Velocity } from '@/engine/components';
import { MACRO_TERRAIN } from '@/engine/macro';
import { DEG2RAD, clamp01 } from '@/engine/math/curves';
import { ActorTable } from '@/game/registry';
import { WorldProbe } from '@/game/probe';
import { DamageSystem } from '@/game/damage';
import {
  createActor,
  eyeHeightFor,
  respawnActor,
  stepActor,
  type GameActor,
  type LocomotionHooks,
} from '@/game/locomotion';
import { CAPSULE } from '@/game/tuning';
import { ScenarioDirector, type ScenarioHost } from '@/game/scenario';
import { composeTelemetry, TelemetryPanel } from '@/game/debug/telemetry';

/**
 * The local player's start pose: the quay at BRAVO, looking down the breakwater.
 *
 * IDENTICAL TO THE DAY-0 NULL PLAYER'S, on purpose. Every lane whose shot does
 * not call `poseCamera` inherits this viewpoint, so changing it here would
 * silently re-frame a dozen other lanes' captures.
 */
const SPAWN_X = 18;
const SPAWN_Z = 44;
const SPAWN_YAW = -2.35;
const SPAWN_PITCH = -0.06;

/**
 * Camera trauma per point of damage taken. 40 HP — a solid burst — is a 0.28
 * shake, which is felt without making the frame unreadable; a headshot-adjacent
 * 90 is 0.63 and genuinely disorienting, which is the point.
 */
const TRAUMA_PER_HP = 0.007;

export class IronPlayer implements PlayerService, ScenarioHost {
  readonly table = new ActorTable();
  readonly probe: WorldProbe;
  readonly localEntity: EntityId;

  private readonly local: GameActor;
  private readonly damage: DamageSystem;
  private readonly scenario: ScenarioDirector;
  private readonly panel: TelemetryPanel;
  private readonly hooks: LocomotionHooks;
  private readonly tmp = new THREE.Vector3();
  private readonly extras: EntityId[] = [];
  private forced: string | null = null;

  constructor(
    readonly services: Services,
    private readonly entityFactory: () => EntityId,
  ) {
    this.probe = new WorldProbe(services);
    this.scenario = new ScenarioDirector(this);
    this.panel = new TelemetryPanel(services.scene, services.materials);

    this.localEntity = entityFactory();
    services.entities.localPlayer = this.localEntity;
    this.local = this.register(
      this.localEntity,
      Team.Coalition,
      services.input.source,
      this.tmp.set(SPAWN_X, MACRO_TERRAIN.height(SPAWN_X, SPAWN_Z), SPAWN_Z),
      SPAWN_YAW,
    );
    this.local.state.pitch = SPAWN_PITCH;

    this.hooks = {
      // Bots do not shake the camera. `CameraRig.addTrauma` is the contract
      // method for exactly this and is the only writer of camera shake, so the
      // call goes straight there rather than through an FxBus event nothing
      // currently subscribes to.
      trauma: (actor, amount, frequencyHz): void => {
        if (actor.entity !== this.localEntity) return;
        this.services.camera.addTrauma(amount, frequencyHz);
      },
      fallDamage: (actor, impactSpeed, ctx): void => this.damage.fallDamage(actor, impactSpeed, ctx),
    };

    this.damage = new DamageSystem(this.table, services, (actor, info) => {
      if (actor.entity !== this.localEntity) return;
      this.services.camera.addTrauma(clamp01(info.amount * TRAUMA_PER_HP), 30);
    });
  }

  /* ------------------------------------------------------------- the contract */

  get state(): Readonly<PlayerState> {
    return this.local.state;
  }

  get controlled(): readonly EntityId[] {
    return this.table.entities;
  }

  stateOf(entity: EntityId): Readonly<PlayerState> | null {
    return this.table.get(entity)?.state ?? null;
  }

  configOf(entity: EntityId): Readonly<CharacterConfig> | null {
    return this.table.get(entity)?.config ?? null;
  }

  intentOf(entity: EntityId): Readonly<PlayerIntent> | null {
    return this.table.get(entity)?.intent ?? null;
  }

  attachController(entity: EntityId, team: Team, source: IntentSource): void {
    const existing = this.table.get(entity);
    if (existing) {
      // Idempotent by contract: re-attaching swaps the source and NOTHING else,
      // so AI re-arming a bot mid-round cannot teleport it back to its spawn.
      existing.source = source;
      existing.team = team;
      existing.state.team = team;
      return;
    }
    // A bot with no spawn of its own starts on the local player's tile; AI
    // teleports it the moment it has a real `SpawnPointDef`.
    const at = this.tmp.copy(this.local.state.position);
    this.register(entity, team, source, at, this.local.state.yaw);
  }

  releaseController(entity: EntityId): void {
    if (entity === this.localEntity) return; // the human is never detached
    const actor = this.table.remove(entity);
    if (!actor) return;
    actor.controller?.dispose();
    actor.controller = null;
  }

  teleport(entity: EntityId, position: Vec3, yaw: number, pitch: number): void {
    const actor = this.table.get(entity);
    if (!actor) return;
    respawnActor(actor, position, yaw);
    actor.state.pitch = pitch;
    actor.config.position.copy(position);
  }

  applyAimPunch(entity: EntityId, pitchDeg: number, yawDeg: number): void {
    const actor = this.table.get(entity);
    if (!actor) return;
    // Latched, not applied: `applyLook` consumes it at the top of the next tick
    // so recoil deflects the aim the player just made rather than racing the
    // look input that produced the shot.
    actor.punchPitch += pitchDeg * DEG2RAD;
    actor.punchYaw += yawDeg * DEG2RAD;
  }

  /**
   * Harness hook. The ONE string a shot file can send this lane — `ShotContext`
   * has no route to a service — so it carries both the contract's documented
   * poses and GAME's own scripted runs. See `src/game/scenario.ts`.
   */
  setForcedState(state: string | null): void {
    this.forced = state;
    this.scenario.arm(state);
    this.panel.setVisible(this.scenario.active);
  }

  /* --------------------------------------------------------- ScenarioHost */

  actorOf(entity: EntityId): GameActor | null {
    return this.table.get(entity) ?? null;
  }

  spawnExtra(team: Team, position: Vec3, yaw: number): EntityId {
    const entity = this.entityFactory();
    this.register(entity, team, HOLD_SOURCE, position, yaw);
    this.extras.push(entity);
    return entity;
  }

  clearExtras(): void {
    for (const entity of this.extras) {
      this.releaseController(entity);
      // Destroyed as well as released: a capture that re-arms a scenario would
      // otherwise leak one entity id per body per shot, and the ids are what the
      // callsign generator and every deterministic sort key are derived from.
      this.services.entities.destroy(entity);
    }
    this.extras.length = 0;
  }

  prime(entity: EntityId, vx: number, vz: number): void {
    const actor = this.table.get(entity);
    if (!actor) return;
    actor.velocity.set(vx, 0, vz);
    actor.state.velocity.copy(actor.velocity);
    actor.state.groundSpeed = Math.hypot(vx, vz);
  }

  /* ------------------------------------------------------------ registration */

  private register(
    entity: EntityId,
    team: Team,
    source: IntentSource,
    position: Vec3,
    yaw: number,
  ): GameActor {
    const actor = createActor(entity, team, source, this.table.claimSlot(), position, yaw);
    this.table.add(actor);

    // Shared components, so WEAPONS finds the health it subtracts from, AI finds
    // the team it scores against, and the render side finds a transform to
    // interpolate — all without any of them knowing this file exists.
    const entities = this.services.entities;
    entities.store(Health).add(entity, { current: 100, max: 100, dead: false, lastDamageTick: -1 });
    // Name is filled on the first tick, NOT here: `mode` is constructed after
    // `player` (it declares `dependsOn: ['level', 'player']`), so reading it
    // from this constructor is a hard boot failure — and the service registry
    // catches it rather than handing back a half-built object, which is why the
    // callsign is deferred instead of guessed at.
    entities.store(TeamTag).add(entity, { team, name: '', squad: 0 });
    const transform = entities.store(Transform).add(entity);
    transform.curr.copy(position);
    transform.prev.copy(position);
    entities.store(Velocity).add(entity);
    entities.store(Actor).add(entity, {
      eyeHeight: eyeHeightFor(CAPSULE.standHeight),
      yaw,
      pitch: 0,
      bodyHandle: -1,
      controller: entity,
    });
    return actor;
  }

  /* -------------------------------------------------------- TickPhase.Intent */

  sampleIntents(ctx: TickCtx): void {
    this.scenario.begin(ctx);
    this.scenarioSeconds = this.scenario.elapsedTicks(ctx) * ctx.dt;
    // Dense array, attach order, always. This walk feeds movement, damage,
    // capture occupancy and every RNG draw downstream of them — if it ever
    // reorders, two runs of the same shot stop producing the same PNG.
    for (const actor of this.table.actors) {
      if (this.scenario.script(actor.entity, ctx, actor.intent)) continue;
      actor.source.sample(actor.entity, ctx, actor.intent);
    }
  }

  /* ------------------------------------------------------ TickPhase.Movement */

  stepLocomotion(ctx: TickCtx): void {
    const physicsReady = this.services.physics.ready;
    for (const actor of this.table.actors) {
      if (physicsReady && !actor.controller) {
        // Lazily, and only once: `createCharacter` inserts a rapier body, and
        // rapier's solver is only deterministic for identical insertion
        // sequences — so the order is the table's, which is attach order.
        actor.controller = this.services.physics.createCharacter(actor.config);
        actor.controller.teleport(actor.state.position);
        actor.controller.setHeight(actor.capsuleHeight);
      }
      stepActor(actor, ctx, this.probe, this.hooks);
      this.scenario.applyPose(actor);
      this.syncComponents(actor, ctx);
    }
  }

  /**
   * Push the actor's state into the shared components, once per tick.
   *
   * `prev` is copied from `curr` BEFORE the new value is written, which is the
   * contract the render side's `lerp(prev, curr, alpha)` depends on. Under the
   * harness alpha is always 0 and this is a no-op — which is exactly why it has
   * to be right, because nothing in a capture will ever catch it being wrong.
   */
  private syncComponents(actor: GameActor, ctx: TickCtx): void {
    const s = actor.state;
    const transform = ctx.entities.store(Transform).get(actor.entity);
    if (transform) {
      transform.prev.copy(transform.curr);
      transform.curr.copy(s.position);
      transform.prevRot.copy(transform.currRot);
      (transform.currRot as THREE.Quaternion).setFromAxisAngle(UP, s.yaw);
    }
    const velocity = ctx.entities.store(Velocity).get(actor.entity);
    if (velocity) {
      (velocity.linear as THREE.Vector3).copy(actor.velocity);
      velocity.groundSpeed = s.groundSpeed;
    }
    const rig = ctx.entities.store(Actor).get(actor.entity);
    if (rig) {
      rig.eyeHeight = s.eyeHeight;
      rig.yaw = s.yaw;
      rig.pitch = s.pitch;
    }
    const tag = ctx.entities.store(TeamTag).get(actor.entity);
    if (tag) {
      tag.team = actor.team;
      if (tag.name === '') tag.name = ctx.services.mode.nameOf(actor.entity);
    }
  }

  /* --------------------------------------------------------------- telemetry */

  /**
   * `RenderStage.Presentation`. Reads simulation state and writes only pixels —
   * the one-way seam holds, because the panel never emits anything back.
   */
  updateTelemetry(ctx: FrameCtx): void {
    if (!this.scenario.active) return;
    composeTelemetry(this.panel, {
      label: this.scenario.label,
      elapsedSeconds: this.scenarioSeconds,
      actor: this.local,
      actorCount: this.table.size,
      services: this.services,
      killfeed: this.killfeed,
    });
    this.panel.update(ctx);
  }

  /** Simulation seconds since the scenario armed. Tick-derived, never wall-clock. */
  private scenarioSeconds = 0;
  private readonly killfeed: string[] = [];

  /* ------------------------------------------------------------------- admin */

  attachBuses(): void {
    this.damage.attach(this.services.events);
    // The panel's killfeed is built from the SIMULATION event, not the FxBus
    // one: `FxEventMap.killfeed` belongs to HUD, and two readers of one
    // presentation event is exactly the coupling the one-way seam exists to
    // prevent. `entity.killed` is the fact; the string is this lane's rendering
    // of it.
    this.unsubscribes.push(
      this.services.events.on('entity.killed', (e) => {
        const mode = this.services.mode;
        const line = `${mode.nameOf(e.killer)} ${e.headshot ? '>X<' : '>>>'} ${mode.nameOf(e.victim)}`;
        this.killfeed.unshift(line);
        if (this.killfeed.length > 6) this.killfeed.length = 6;
      }),
    );
  }

  private readonly unsubscribes: Array<() => void> = [];

  get damageSystem(): DamageSystem {
    return this.damage;
  }

  get forcedState(): string | null {
    return this.forced;
  }

  /**
   * Harness reset. Everything transient about locomotion — position, velocity,
   * stance, stamina, suppression, the scenario and its props — plus every
   * controller AI attached during the previous capture, or bots leak across
   * shots as invisible movers that still capture flags.
   */
  resetTransient(): void {
    this.scenario.disarm();
    this.panel.setVisible(false);
    this.forced = null;
    this.killfeed.length = 0;
    this.scenarioSeconds = 0;
    for (const entity of [...this.table.entities]) this.releaseController(entity);
    this.extras.length = 0;
    this.probe.clearBoxes();
    respawnActor(
      this.local,
      this.tmp.set(SPAWN_X, MACRO_TERRAIN.height(SPAWN_X, SPAWN_Z), SPAWN_Z),
      SPAWN_YAW,
    );
    this.local.state.pitch = SPAWN_PITCH;
    this.local.stance = Stance.Stand;
    const health = this.services.entities.store(Health).get(this.localEntity);
    if (health) {
      health.current = 100;
      health.dead = false;
      health.lastDamageTick = -1;
    }
  }

  dispose(): void {
    this.damage.detach();
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.panel.dispose();
    this.scenario.disarm();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The source every GAME-owned extra runs on. It writes nothing, which is the
 * point: an extra exists to be counted by the capture loop and shot at, and a
 * body that stands still is a body whose position two runs of a shot agree on.
 */
const HOLD_SOURCE: IntentSource = {
  kind: 'bot',
  sample: (): void => {
    /* Extras hold position; `ScenarioDirector.script` zeroes their intent. */
  },
};

/* ========================================================================== *
 * The three named exports. `src/bootstrap/subsystems.ts` imports them BY NAME
 * and BY PATH, and it is frozen.
 * ========================================================================== */

let instance: IronPlayer | null = null;

export function createPlayerService(ctx: BootContext): PlayerService {
  const player = new IronPlayer(ctx.services, () => ctx.services.entities.create('soldier'));
  instance = player;
  player.attachBuses();

  ctx.addTick({
    name: 'game.intent',
    phase: TickPhase.Intent,
    order: 0,
    tick: (tick) => player.sampleIntents(tick),
  });
  ctx.addTick({
    name: 'game.movement',
    phase: TickPhase.Movement,
    order: 0,
    tick: (tick) => player.stepLocomotion(tick),
  });
  ctx.addTick(player.damageSystem);
  ctx.addRender({
    name: 'game.telemetry',
    stage: RenderStage.Presentation,
    order: 100,
    update: (frame) => player.updateTelemetry(frame),
  });

  return player;
}

/**
 * Soldier meshes, footstep surface tables and movement curve LUTs get declared
 * here. Runs after `assets` and before every other subsystem is constructed, so
 * there is no service to read — only the registry.
 *
 * GAME declares NOTHING. The soldier mesh and its hitbox stack belong to AI (it
 * owns the rig and is the only lane that can set `BodyDesc.zone`), footstep
 * banks belong to AUDIO, and the movement curves in `tuning.ts` are closed-form
 * — a LUT would be a cache of six multiplications with a bake-budget line item.
 */
export function registerPlayerBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Nothing to bake.
}

/**
 * Harness reset chain, at the top of EVERY capture.
 *
 * Tolerates `null`: this hook can fire before `createPlayerService` has run, and
 * does on the very first capture of a cold boot.
 */
export function resetPlayer(_seed: number): void {
  instance?.resetTransient();
}

/**
 * The lane-local actor table, for the GAME files that need per-entity state the
 * `PlayerService` contract deliberately does not expose — `conquest.ts` reads
 * `assistCredit` off a victim at the moment of a kill, because the sim bus is
 * deferred and the damage ledger it came from is already cleared by the time the
 * event is delivered.
 *
 * Module-scoped rather than a contract method on purpose: no OTHER lane may
 * reach a `GameActor`. Anything cross-lane goes through `PlayerService`.
 *
 * Returns null until the service is constructed, which is a real state — `reset`
 * and `registerBakes` both run before `create`.
 */
export function laneActors(): ActorTable | null {
  return instance?.table ?? null;
}

/** Lane-private handle, for GAME's own tooling. */
export function lanePlayer(): IronPlayer | null {
  return instance;
}
