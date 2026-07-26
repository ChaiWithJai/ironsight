/**
 * GAME — the deterministic demo scenarios behind `PlayerService.setForcedState`.
 *
 * OWNER: GAME.
 *
 * THE PROBLEM THIS SOLVES. `ShotContext` has no route to a service, and the
 * reset chain suppresses live input for the whole capture, so a shot file cannot
 * drive the player. The one hook it does have is `setPlayerState(name)`, which
 * lands on `PlayerService.setForcedState` — so that string is GAME's whole
 * scripting surface, and this file is what it drives.
 *
 * Two kinds of scenario live here:
 *
 *   POSES      'ads' | 'firing' | 'crouch' | 'prone' | 'dead' — the names the
 *              contract already documents. They pin the local actor's stance or
 *              life state and script nothing.
 *   RUNS       'sprint' | 'slide' | 'vault' | 'assault' — a scripted intent
 *              stream over a fixed number of ticks, plus whatever world the run
 *              needs (a wall to vault, bodies on a flag).
 *
 * EVERYTHING IS KEYED TO THE TICK COUNTER, never to wall-clock and never to a
 * frame count: the harness renders exactly one fixed-dt tick per `stepFrame`,
 * so "tick 37 of the scenario" is the same world state on a workstation and
 * under SwiftShader, which is the whole basis of the review loop.
 *
 * A run is also PRIMED rather than accelerated from rest where that matters. A
 * vault needs the actor already at sprint speed a known distance from the ledge;
 * spending 90 ticks accelerating into it would triple every capture's cost and
 * make the trigger point depend on friction tuning. Priming is a teleport plus a
 * velocity, both exact, and the locomotion integrator runs unmodified from there.
 */
import * as THREE from 'three';
import {
  Btn,
  CollisionGroup,
  DamageKind,
  HitZone,
  MaterialFeature,
  RenderLayer,
  SceneGroup,
  Stance,
  SurfaceId,
  Team,
  type BodyHandle,
  type EntityId,
  type PlayerIntent,
  type Services,
  type TickCtx,
  type Vec3,
} from '@/engine/types';
import { MACRO_ANCHORS, MACRO_TERRAIN } from '@/engine/macro';
import { eyeHeightFor, type GameActor } from '@/game/locomotion';
import type { ProbeBox, WorldProbe } from '@/game/probe';
import { CAPSULE, CAPSULE_HEIGHT } from '@/game/tuning';

/** Named scenarios. Anything else is treated as a pose and pins nothing. */
export type ScenarioId = 'sprint' | 'slide' | 'vault' | 'assault';

const RUNS: readonly string[] = ['sprint', 'slide', 'vault', 'assault'];

/**
 * What a scenario is allowed to do to the player service. Deliberately narrow,
 * and deliberately an interface rather than an import: `player.ts` constructs
 * this class, so a back-import would be a module cycle.
 */
export interface ScenarioHost {
  readonly services: Services;
  readonly probe: WorldProbe;
  readonly localEntity: EntityId;
  actorOf(entity: EntityId): GameActor | null;
  /** A body under GAME's own control, for scenarios that need a crowd. */
  spawnExtra(team: Team, position: Vec3, yaw: number): EntityId;
  clearExtras(): void;
  teleport(entity: EntityId, position: Vec3, yaw: number, pitch: number): void;
  /** Set planar velocity directly. Only a scenario may do this. */
  prime(entity: EntityId, vx: number, vz: number): void;
}

/**
 * Headings. `forwardFromYaw` is (−sin, 0, −cos), so +x is yaw = −π/2 and −x is
 * +π/2 — not the other way round, which is the sign error this constant exists
 * to stop anyone making twice.
 */
const YAW_EAST = -Math.PI / 2;
const YAW_WEST = Math.PI / 2;

/**
 * The locomotion runs head WEST along the BRAVO quay, at z = 6.
 *
 * The quay plateau is dead flat over a 58 m core centred on (−26, 6), so the
 * whole run is on level ground and none of what the shot shows is terrain noise.
 * West rather than east for two reasons: the town massing is east, and a run
 * INTO a wall of buildings frames a black slab instead of the move; and at 17.4
 * the sun is low in the west, so running toward it puts lit faces and the sea
 * in front of the camera rather than the shadowed side of everything.
 */
const RUN_Z = 6;
const RUN_GROUND = MACRO_TERRAIN.height(-40, RUN_Z);

/**
 * The vault obstacle: a 0.4 m thick, 0.9 m high parapet, approached from the
 * east. 0.9 m is squarely inside the vault band (0.45–1.10 m) and well clear of
 * both the step-up below it and the mantle band above, so the shot proves the
 * probe CLASSIFIED, not just that it triggered.
 */
const WALL_FAR_X = -40;
const WALL_NEAR_X = -39.6;
const WALL_HEIGHT = 0.9;

interface ScriptedKill {
  readonly atTick: number;
  readonly victim: number;
  readonly killer: number;
}

export class ScenarioDirector {
  private id: ScenarioId | null = null;
  private pose: string | null = null;
  private startTick = -1;
  private readonly props: THREE.Object3D[] = [];
  private readonly extras: EntityId[] = [];
  private readonly kills: ScriptedKill[] = [];
  private nextKill = 0;
  private wallBox: { min: Vec3; max: Vec3 } | null = null;
  private wallBody: BodyHandle | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(private readonly host: ScenarioHost) {}

  get active(): boolean {
    return this.id !== null || this.pose !== null;
  }

  get scenario(): ScenarioId | null {
    return this.id;
  }

  get label(): string {
    return this.id ?? this.pose ?? 'NONE';
  }

  /** Ticks since the scenario was armed, or −1 before the first tick ran. */
  elapsedTicks(ctx: TickCtx): number {
    return this.startTick < 0 ? 0 : ctx.tick - this.startTick;
  }

  /* -------------------------------------------------------------- arm/disarm */

  arm(name: string | null): void {
    this.disarm();
    if (name === null || name === 'idle') return;
    if (!RUNS.includes(name)) {
      // A pose pins state AFTER locomotion runs, every tick — see `applyPose`.
      // Doing it once here would be undone by the first `stepActor`.
      this.pose = name;
      return;
    }
    this.id = name as ScenarioId;
    this.startTick = -1;
    switch (this.id) {
      case 'sprint':
        this.stageRun(-8, 0, 0);
        break;
      case 'slide':
        // Primed at sprint speed: the slide entry gate is a SPEED gate
        // (`SLIDE_ENTRY_SPEED`), so a run that starts from rest would just
        // crouch for the first second and the shot would prove nothing.
        this.stageRun(-8, 6.6, 0);
        break;
      case 'vault':
        this.buildWall();
        // 4.2 m out. The ledge probe reaches `VAULT_REACH + radius` = 1.27 m,
        // so the traversal fires around tick 29 and runs 25 ticks. Pitched 16°
        // down because that is where the parapet IS at the moment the vault
        // commits — 1.3 m ahead and 0.7 m below the eye. Level, the obstacle is
        // off the bottom of the frame and the shot is a picture of the horizon.
        this.stageRun(WALL_NEAR_X + 4.2, 6.6, -0.19);
        break;
      case 'assault':
        this.stageAssault();
        break;
    }
  }

  disarm(): void {
    this.id = null;
    this.pose = null;
    this.startTick = -1;
    this.nextKill = 0;
    this.kills.length = 0;
    this.host.probe.clearBoxes();
    if (this.wallBody !== null) {
      this.host.services.physics.destroyBody(this.wallBody);
      this.wallBody = null;
    }
    this.wallBox = null;
    this.host.clearExtras();
    this.extras.length = 0;
    for (const prop of this.props) {
      prop.removeFromParent();
      const mesh = prop as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    }
    this.props.length = 0;
  }

  /* ------------------------------------------------------------------ staging */

  private stageRun(x: number, speed: number, pitch: number): void {
    const start = this.tmp.set(x, RUN_GROUND, RUN_Z);
    this.host.teleport(this.host.localEntity, start, YAW_WEST, pitch);
    // Westward, so the primed velocity is −x. Priming with the wrong sign is a
    // run that decelerates into a wall it never reaches.
    if (speed !== 0) this.host.prime(this.host.localEntity, -speed, 0);
  }

  /**
   * ALPHA, with three Coalition inside the disc and two Insurgents pushing in —
   * a genuinely contested flag, counted by the same occupancy loop the live mode
   * runs, not a number pasted into the runtime struct.
   */
  private stageAssault(): void {
    // ALPHA as the LEVEL says it is, falling back to the macro anchor every lane
    // agrees on before LEVEL lands. Staging bodies at the macro position after
    // LEVEL has moved the flag would put five soldiers in a side street and the
    // occupancy count would legitimately be zero.
    const def = this.host.services.level.capturePoints.find((p) => p.id === 'ALPHA');
    const a = def
      ? { x: def.centre.x, z: def.centre.z, radius: def.radius }
      : { x: MACRO_ANCHORS.alpha.x, z: MACRO_ANCHORS.alpha.z, radius: 22 };
    const ground = (x: number, z: number): number =>
      this.host.services.terrain.ready
        ? this.host.services.terrain.heightAt(x, z)
        : MACRO_TERRAIN.height(x, z);

    // Everyone stands on the OPEN PAVING south-east of the market hall, not on
    // the flag's geometric centre. The hall occupies the middle of the square,
    // and five soldiers standing inside a colonnade is a picture of a colonnade.
    // Placement is polar around the flag so it survives LEVEL moving it.
    const px = a.x + 2;
    const pz = a.z + 18;
    this.host.teleport(this.host.localEntity, this.tmp.set(px, ground(px, pz), pz), YAW_EAST - 1.1, -0.05);

    const place = (team: Team, radius: number, angle: number, yaw: number): EntityId => {
      const x = a.x + Math.cos(angle) * radius;
      const z = a.z + Math.sin(angle) * radius;
      const entity = this.host.spawnExtra(team, this.tmpB.set(x, ground(x, z), z), yaw);
      this.extras.push(entity);
      this.addMarker(x, ground(x, z), z, team);
      return entity;
    };

    // Two more Coalition inside (the local player is the third), pushing up from
    // the south side of the square.
    place(Team.Coalition, 19, 1.05, YAW_EAST - 1.2);
    place(Team.Coalition, 16, 1.35, YAW_EAST - 1.2);
    // Two Insurgents inside, holding the west side of the paving: this is what
    // makes the point CONTESTED rather than capturing, and it is derived from
    // where their bodies are, not asserted into the runtime struct.
    place(Team.Insurgent, 19, 2.35, YAW_EAST - 1.2);
    place(Team.Insurgent, 22, 2.15, YAW_EAST - 1.2);

    // Two more OUTSIDE the disc, as the killfeed's victims — killing an occupant
    // would change the very occupancy the shot exists to show.
    const victimA = place(Team.Insurgent, 34, 0.25, YAW_EAST + Math.PI);
    const victimB = place(Team.Insurgent, 37, 0.62, YAW_EAST + Math.PI);
    const killer = this.host.localEntity;
    this.kills.push({ atTick: 3, victim: victimA as number, killer: killer as number });
    this.kills.push({ atTick: 11, victim: victimB as number, killer: killer as number });

    this.host.services.mode.forceState('assault');
  }

  /**
   * The parapet: a mesh, an analytic probe box, AND a real static collider.
   *
   * ALL THREE, and the third is not redundant. `WorldProbe` only consults its
   * analytic box list while `PhysicsService.ready` is false; the moment rapier
   * exists every query routes to it, and a parapet that lives only in the
   * analytic list becomes invisible to the ledge probe AND to collide-and-slide.
   * The symptom is a soldier sprinting straight through a wall you can see,
   * with the readout cheerfully saying SPRINT — which is exactly what this shot
   * did until the static body was added.
   */
  private buildWall(): void {
    const min = new THREE.Vector3(WALL_FAR_X, RUN_GROUND - 1.2, RUN_Z - 6);
    const max = new THREE.Vector3(WALL_NEAR_X, RUN_GROUND + WALL_HEIGHT, RUN_Z + 7);
    const box: ProbeBox = { min, max, surface: SurfaceId.Concrete };
    this.host.probe.addBox(box);
    this.wallBox = { min, max };
    this.ensureWallBody();

    const material = this.host.services.materials.create({
      id: 'game.scenario.parapet',
      surface: SurfaceId.Concrete,
      layer: 0,
      features: MaterialFeature.None,
      baseColor: 0xc4b79c,
      roughness: 0.88,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z),
      material,
    );
    mesh.name = 'game.scenario.parapet';
    mesh.position.set((min.x + max.x) * 0.5, (min.y + max.y) * 0.5, (min.z + max.z) * 0.5);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld(true);
    this.attachProp(mesh);

    // A taller block eight metres past the parapet. Purely compositional: with
    // nothing but flat quay behind it, a 0.9 m wall photographed from 1.2 m away
    // is a grey band across an empty frame and the viewer has no way to read its
    // height. Given something to be shorter than, it reads as waist-high.
    const backdrop = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.1, 5.5), material);
    backdrop.name = 'game.scenario.backdrop';
    backdrop.position.set(WALL_FAR_X - 8, RUN_GROUND + 3.1 * 0.5 - 0.35, RUN_Z - 1.5);
    backdrop.castShadow = true;
    backdrop.receiveShadow = true;
    backdrop.updateMatrixWorld(true);
    this.attachProp(backdrop);
  }

  /**
   * Register the parapet with rapier, once it exists. Called from `arm` and
   * again every tick until it takes: `PhysicsService.ready` flips when the world
   * finishes loading, which may be after the scenario was staged.
   */
  private ensureWallBody(): void {
    const physics = this.host.services.physics;
    if (this.wallBody !== null || this.wallBox === null || !physics.ready) return;
    const { min, max } = this.wallBox;
    const half = new THREE.Vector3(
      (max.x - min.x) * 0.5,
      (max.y - min.y) * 0.5,
      (max.z - min.z) * 0.5,
    );
    const matrix = new THREE.Matrix4().makeTranslation(
      (min.x + max.x) * 0.5,
      (min.y + max.y) * 0.5,
      (min.z + max.z) * 0.5,
    );
    this.wallBody = physics.addStatic({
      matrix,
      shape: { kind: 'box', half },
      surface: SurfaceId.Concrete,
      group: CollisionGroup.StaticGeo,
    });
  }

  /**
   * A soldier-sized proxy. AI owns the real rig; this exists so the assault shot
   * is a picture of five bodies around a flag rather than a picture of an empty
   * square that the numbers claim is contested.
   */
  private addMarker(x: number, y: number, z: number, team: Team): void {
    const material = this.host.services.materials.create({
      id: `game.scenario.marker.${team}`,
      surface: SurfaceId.Fabric,
      layer: 0,
      features: MaterialFeature.None,
      baseColor: team === Team.Coalition ? 0x3f6f8f : 0x8a4a32,
      roughness: 0.82,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(CAPSULE.radius * 1.5, CAPSULE.standHeight, CAPSULE.radius * 1.1),
      material,
    );
    mesh.name = `game.scenario.marker.${team}`;
    mesh.position.set(x, y + CAPSULE.standHeight * 0.5, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld(true);
    this.attachProp(mesh);
  }

  private attachProp(mesh: THREE.Mesh): void {
    this.host.services.scene.group(SceneGroup.Props).add(mesh);
    // Dynamic with no bounds: these live for one capture and are re-created on
    // the next arm, so paying for a static registration and its sector rebuild
    // would be worse than never culling six boxes.
    this.host.services.scene.addDynamic(mesh, RenderLayer.WorldOpaque);
    this.props.push(mesh);
  }

  /* -------------------------------------------------------------------- tick */

  /** Called once per tick, at the top of `TickPhase.Intent`. */
  begin(ctx: TickCtx): void {
    if (!this.active) return;
    this.ensureWallBody();
    if (this.startTick < 0) this.startTick = ctx.tick;
    const t = ctx.tick - this.startTick;
    while (this.nextKill < this.kills.length && this.kills[this.nextKill]!.atTick <= t) {
      const k = this.kills[this.nextKill++]!;
      this.fireScriptedKill(ctx, k.victim as EntityId, k.killer as EntityId);
    }
  }

  /**
   * Script `out` for `entity`, or return false to let its own `IntentSource`
   * run. Only ever takes over the LOCAL player: the extras are meant to stand
   * still and be counted.
   */
  script(entity: EntityId, ctx: TickCtx, out: PlayerIntent): boolean {
    if (!this.active) return false;
    const local = entity === this.host.localEntity;
    if (!local) {
      // Extras hold position: zero intent, but still sampled every tick so their
      // stance machine and stamina integrate exactly like everyone else's.
      zero(out);
      return true;
    }
    zero(out);
    const t = this.elapsedTicks(ctx);

    switch (this.id) {
      case 'sprint':
        out.moveZ = 1;
        out.buttons = Btn.Sprint;
        return true;
      case 'slide':
        out.moveZ = 1;
        out.buttons = Btn.Sprint;
        // Crouch is an EDGE for the slide gate and a HELD button for the stance,
        // so both bits are set on the entry tick and only the held bit after.
        if (t === SLIDE_ENTRY_TICK) out.pressed = Btn.Crouch;
        if (t >= SLIDE_ENTRY_TICK) out.buttons |= Btn.Crouch;
        return true;
      case 'vault':
        out.moveZ = 1;
        out.buttons = Btn.Sprint;
        return true;
      case 'assault':
        // Standing on the flag, weapon up. The capture is the subject, not the
        // locomotion, so the body holds still.
        out.buttons = Btn.Ads;
        return true;
      default:
        break;
    }

    // A pose. `sprint` is handled above as a run; the rest pin state in
    // `applyPose` and want an empty intent.
    return true;
  }

  /**
   * Applied after locomotion has run, so a pose wins over whatever it computed.
   * LOCAL PLAYER ONLY: `setForcedState` is documented as a local-player hook,
   * and pinning every bot in the match to prone because a shot asked for a
   * prone viewmodel would be a surprising amount of collateral.
   */
  applyPose(actor: GameActor): void {
    const pose = this.pose;
    if (pose === null || actor.entity !== this.host.localEntity) return;
    const s = actor.state;
    switch (pose) {
      case 'dead':
        s.alive = false;
        break;
      case 'crouch':
        pin(actor, Stance.Crouch);
        break;
      case 'prone':
        pin(actor, Stance.Prone);
        break;
      default:
        break;
    }
  }

  /**
   * A kill, routed through the real damage bus rather than poked into the score
   * table: that is what makes the ticket loss, the score award, the assist sweep
   * and the killfeed entry the SAME code path a live round takes.
   */
  private fireScriptedKill(ctx: TickCtx, victim: EntityId, killer: EntityId): void {
    const target = this.host.actorOf(victim);
    const source = this.host.actorOf(killer);
    if (!target) return;
    const point = target.state.position.clone();
    point.y += target.state.eyeHeight;
    const direction = source
      ? point.clone().sub(source.state.position).normalize()
      : new THREE.Vector3(0, 0, -1);
    ctx.sim.emit('damage.applied', {
      target: victim,
      attacker: killer,
      // Above 100 HP and above DOWN_INSTANT_KILL_DAMAGE, so the victim is killed
      // outright rather than downed — a downed body is still an occupant and
      // still alive, and would put nothing on the killfeed.
      amount: 145,
      kind: DamageKind.Bullet,
      zone: HitZone.Head,
      point,
      normal: direction.clone().negate(),
      direction,
      surface: SurfaceId.Kevlar,
      weapon: null,
      energyJ: 1800,
      penetrated: false,
    });
  }
}

/** Ticks into the slide run before the crouch edge. ~0.1 s of sprint first. */
const SLIDE_ENTRY_TICK = 6;

/**
 * Pin a stance instantly, capsule and eye included. Only a forced pose may do
 * this — the stance machine is a timed transition for a reason, and a shot that
 * wants "crouched" wants it on frame 0, not 0.2 s in.
 */
function pin(actor: GameActor, stance: Stance): void {
  actor.stance = stance;
  actor.stanceTarget = stance;
  actor.stanceFrom = stance;
  actor.stanceBlend = 1;
  actor.capsuleHeight = CAPSULE_HEIGHT[stance];
  actor.controller?.setHeight(actor.capsuleHeight);
  actor.state.stance = stance;
  actor.state.eyeHeight = eyeHeightFor(actor.capsuleHeight);
}

function zero(out: PlayerIntent): void {
  out.moveX = 0;
  out.moveZ = 0;
  out.lookYaw = 0;
  out.lookPitch = 0;
  out.buttons = 0;
  out.pressed = 0;
  out.released = 0;
  out.weaponSlot = -1;
  out.aimAt = null;
}
