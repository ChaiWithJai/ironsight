/**
 * The physics proving grounds, and the seed protocol that arms them. OWNER: PHYS.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * A shot file may pose the camera and nothing else: `ShotContext` exposes
 * `setTimeOfDay` / `setWeather` / `poseCamera` / `setOverlays` /
 * `setPlayerState` / `seed`, and boundary CI forbids `src/shots/**` from
 * importing a lane. So a lane that needs a SCENE to photograph — a stair to walk
 * up, a wall to blow down — has exactly one channel from the shot file to
 * itself: the seed.
 *
 * THE PROTOCOL. `ShotContext.seed(n)` runs the whole reset chain and ends in
 * `resetPhysics(n)`. A seed whose high sixteen bits are 0x5048 ('PH') is read as
 * a SCENARIO SELECTOR, and its low bits name the proving ground to build. Any
 * other seed — including the 0x1205 the harness resets with before every shot —
 * tears the proving ground down and leaves the world exactly as every other
 * lane's shot expects to find it. That is the load-bearing half of this: PHYS's
 * furniture must never appear in SKY's frame.
 *
 * The arena sits at (150, 24) on the terrace east of the market: outside every
 * one of LEVEL's blocks, on ground the macro field takes from 2.0 m to 3.6 m
 * across the footprint, which the slab resolves as a cut-and-fill terrace.
 *
 * EVERYTHING HERE IS DETERMINISTIC BY CONSTRUCTION: layout comes off a
 * fixed-seed stream (`physicsLayoutRng`), never the engine RNG; the rubble is
 * BUILT at rest rather than dropped and settled, so it does not depend on how
 * many frames a shot happens to render; and the collapse fires on a RELATIVE
 * tick count from the moment the scenario was armed, not on `ctx.tick`, which
 * keeps counting across captures.
 */
import * as THREE from 'three';
import {
  CollisionGroup,
  DamageKind,
  HitZone,
  LAYER_SOLID,
  NULL_ENTITY,
  Sim,
  SurfaceId,
  type BodyHandle,
  type CharacterController,
  type EntityId,
  type EntityStore,
  type TickCtx,
} from '@/engine/types';
import { physicsLayoutRng } from '@/physics/world';
import type { PhysicsSystem } from '@/physics/system';
import { destructionSystem } from '@/physics/destruction/system';
import { templateDef, templateHalf } from '@/physics/destruction/defs';
import type { Ragdoll } from '@/physics/ragdoll';

/** 'PH' in the high sixteen bits marks a seed as a scenario selector. */
const SCENARIO_TAG = 0x5048;

/** Character on a stair and on two slopes, a settled rubble pile, a ragdoll. */
export const SEED_STACK = 0x50480001;
/** A pre-fractured cover wall, blown down mid-capture. */
export const SEED_WALL = 0x50480002;

/** Arena origin on the terrace east of the market square. */
const ARENA_X = 150;
const ARENA_Z = 24;
/** Top of the slab. The macro terrain runs 2.0–3.6 m across the footprint, so
 *  the slab is a cut-and-fill terrace: proud at the south edge, buried at the north. */
const PAD_Y = 3.7;

/** Relative tick at which `destruction_wall` detonates its charge. */
const COLLAPSE_TICK = 34;

type ScenarioId = 'stack' | 'wall';

interface Walker {
  readonly controller: CharacterController;
  readonly direction: THREE.Vector3;
  readonly speed: number;
  readonly vertical: THREE.Vector3;
}

interface Active {
  readonly id: ScenarioId;
  readonly system: PhysicsSystem;
  readonly entities: EntityStore;
  readonly bodies: BodyHandle[];
  readonly walkers: Walker[];
  readonly ragdolls: Ragdoll[];
  readonly owned: EntityId[];
  startTick: number;
  wallEntity: EntityId;
  fired: boolean;
}

let pending: ScenarioId | null = null;
let active: Active | null = null;

/** Read the seed the reset chain was given, and remember what to build. */
export function armScenario(seed: number): void {
  if ((seed >>> 16) !== SCENARIO_TAG) {
    pending = null;
    return;
  }
  switch (seed >>> 0) {
    case SEED_STACK:
      pending = 'stack';
      break;
    case SEED_WALL:
      pending = 'wall';
      break;
    default:
      pending = null;
  }
}

/**
 * Drop the arena. Bodies go through the table so the spawn-key order of whatever
 * is built next is unaffected; entities are released back to the store.
 */
export function teardownScenario(): void {
  const scene = active;
  active = null;
  if (!scene) return;
  for (const walker of scene.walkers) walker.controller.dispose();
  for (const doll of scene.ragdolls) doll.dispose();
  for (const handle of scene.bodies) scene.system.destroyBody(handle);
  for (const entity of scene.owned) scene.entities.destroy(entity);
}

/** Called from `TickPhase.PrePhysics`. Builds on the first tick, then scripts. */
export function tickScenario(system: PhysicsSystem, ctx: TickCtx): void {
  if (pending && !active) {
    active = pending === 'stack' ? buildStack(system, ctx) : buildWall(system, ctx);
    pending = null;
    // The arena's colliders were inserted after the last step and are invisible
    // to every query until the next one. The walkers are about to ground-probe
    // against them THIS tick, so the acceleration structure has to be rebuilt
    // now — see `PhysicsSystem.primeQueries`.
    system.primeQueries();
  }
  const scene = active;
  if (!scene) return;

  const relative = ctx.tick - scene.startTick;
  driveWalkers(scene, ctx.dt);

  if (scene.id === 'wall' && !scene.fired && relative >= COLLAPSE_TICK) {
    scene.fired = true;
    detonate(scene, ctx);
  }
}

/* ------------------------------------------------------------------ props */

interface PropOptions {
  readonly surface: SurfaceId;
  readonly group?: CollisionGroup;
  /** Rotation about +Z, radians. Positive tilts the +X end upwards. */
  readonly tiltZ?: number;
  readonly yaw?: number;
}

/**
 * One static box: a rapier collider and the mesh that shows it, from a single
 * pair of half-extents. Collider and render geometry are still two
 * representations — they just happen to be generated from the same numbers here,
 * which is the honest case for a slab.
 */
function addBox(
  system: PhysicsSystem,
  scene: Active,
  centre: THREE.Vector3,
  half: THREE.Vector3,
  opts: PropOptions,
): THREE.Mesh {
  const quat = new THREE.Quaternion();
  if (opts.tiltZ) quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), opts.tiltZ);
  else if (opts.yaw) quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), opts.yaw);
  const matrix = new THREE.Matrix4().compose(centre, quat, new THREE.Vector3(1, 1, 1));
  const handle = system.addStatic({
    matrix,
    shape: { kind: 'box', half: half.clone() },
    surface: opts.surface,
    group: opts.group ?? CollisionGroup.StaticGeo,
  });
  scene.bodies.push(handle);
  const geometry = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
  return system.visuals.addStaticMesh(geometry, opts.surface, matrix);
}

/** A loose block of masonry, resting where it is put. */
function addRubbleBlock(
  system: PhysicsSystem,
  scene: Active,
  centre: THREE.Vector3,
  half: THREE.Vector3,
  quat: THREE.Quaternion,
  surface: SurfaceId,
): void {
  const handle = system.createBody({
    mode: 'dynamic',
    entity: NULL_ENTITY,
    position: centre,
    rotation: quat,
    shapes: [{ kind: 'box', half: half.clone() }],
    surface,
    group: CollisionGroup.Debris,
    collidesWith: LAYER_SOLID,
    linearDamping: 0.1,
    angularDamping: 0.4,
    canSleep: true,
  });
  scene.bodies.push(handle);
  const record = system.table.record(handle);
  if (!record) return;
  system.visuals.addBodyMesh(record, new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2), surface);
}

/** The slab both proving grounds stand on. */
function addPad(system: PhysicsSystem, scene: Active, halfX: number, halfZ: number): void {
  addBox(
    system,
    scene,
    new THREE.Vector3(ARENA_X, PAD_Y - 0.7, ARENA_Z),
    new THREE.Vector3(halfX, 0.7, halfZ),
    { surface: SurfaceId.Concrete, group: CollisionGroup.StaticGeo },
  );
}

/* ------------------------------------------------------- stack scenario */

function newScene(id: ScenarioId, system: PhysicsSystem, ctx: TickCtx): Active {
  return {
    id,
    system,
    entities: ctx.entities,
    bodies: [],
    walkers: [],
    ragdolls: [],
    owned: [],
    startTick: ctx.tick,
    wallEntity: NULL_ENTITY,
    fired: false,
  };
}

function buildStack(system: PhysicsSystem, ctx: TickCtx): Active {
  const scene = newScene('stack', system, ctx);
  const rng = physicsLayoutRng('stack');
  addPad(system, scene, 17, 9.5);

  // A twelve-tread stone stair. 240 mm rise / 360 mm going is a real exterior
  // stair, and it is deliberately BELOW the 350 mm step height in GAME's capsule
  // config: the controller must climb it without the player ever pressing jump,
  // and without the one-frame hitch that betrays a step-up implemented by
  // teleporting the capsule.
  // THE FLIGHT ASCENDS TOWARDS −X, i.e. AWAY from the shot camera's side of the
  // arena. That is a framing decision with a real cost if you get it backwards:
  // the landing at the head of the flight is 2.9 m tall, so a camera on the
  // uphill side sees a blank wall where the treads should be, and the one thing
  // the shot exists to prove is invisible.
  const treads = 12;
  const rise = 0.24;
  const going = 0.36;
  const stairFoot = ARENA_X - 4.7;
  for (let i = 0; i < treads; i++) {
    const h = (i + 1) * rise;
    addBox(
      system,
      scene,
      new THREE.Vector3(stairFoot - going * i - going * 0.5, PAD_Y + h * 0.5, ARENA_Z - 5.5),
      new THREE.Vector3(going * 0.5, h * 0.5, 2.0),
      { surface: SurfaceId.Sandstone },
    );
  }
  // The landing the stair arrives at. Autostep needs somewhere to STAND at the
  // top or the last tread is refused.
  const landingTop = PAD_Y + treads * rise;
  addBox(
    system,
    scene,
    new THREE.Vector3(stairFoot - going * treads - 2.2, (PAD_Y + landingTop) * 0.5, ARENA_Z - 5.5),
    new THREE.Vector3(2.2, (landingTop - PAD_Y) * 0.5, 2.0),
    { surface: SurfaceId.Sandstone },
  );

  // Two ramps: one comfortably inside the 50° climb limit, one comfortably
  // outside it. Side by side, so a critic can see the controller take one and
  // refuse the other in a single frame.
  addRamp(system, scene, ARENA_X + 1, 7, THREE.MathUtils.degToRad(24), SurfaceId.Concrete);
  addRamp(system, scene, ARENA_X + 8.5, 2.5, THREE.MathUtils.degToRad(55), SurfaceId.Concrete);

  // A settled rubble pile. BUILT at rest rather than dropped: a pile that has to
  // settle during the capture would look different at 40 frames and at 80, and
  // the shot would stop being a physics proof and start being a timing test.
  const pileX = ARENA_X - 6;
  const pileZ = ARENA_Z + 4.5;
  const rows: readonly { count: number; y: number; spread: number; size: number }[] = [
    { count: 7, y: 0.26, spread: 3.1, size: 0.26 },
    { count: 5, y: 0.72, spread: 2.2, size: 0.22 },
    { count: 3, y: 1.1, spread: 1.3, size: 0.19 },
  ];
  const quat = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const t = row.count === 1 ? 0 : i / (row.count - 1) - 0.5;
      const half = new THREE.Vector3(
        row.size * rng.range(0.8, 1.4),
        row.size * rng.range(0.6, 1.0),
        row.size * rng.range(0.8, 1.3),
      );
      axis.set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
      // Small rotations only: a block resting on a pile is nearly flat, and a
      // uniformly random orientation reads as scattered dice, not as masonry.
      quat.setFromAxisAngle(axis, rng.range(-0.28, 0.28));
      addRubbleBlock(
        system,
        scene,
        new THREE.Vector3(
          pileX + t * row.spread + rng.range(-0.2, 0.2),
          PAD_Y + row.y + half.y,
          pileZ + rng.range(-0.9, 0.9),
        ),
        half,
        quat.clone(),
        rng.bool(0.35) ? SurfaceId.Concrete : SurfaceId.Sandstone,
      );
    }
  }

  // The ragdoll, dropped a hand's width above the pile so it drapes over it
  // inside the first second rather than arriving as a folded heap.
  const entity = ctx.entities.create('phys.ragdoll');
  scene.owned.push(entity);
  const doll = system.spawnRagdoll(
    entity,
    new THREE.Vector3(pileX + 2.6, PAD_Y + 1.35, pileZ - 0.4),
    -1.9,
    new THREE.Vector3(-40, 0, 28),
  );
  scene.ragdolls.push(doll);
  for (const segment of doll.segments) {
    const geometry =
      segment.halfHeight > 0
        ? new THREE.CapsuleGeometry(segment.radius, segment.halfHeight * 2, 4, 10)
        : new THREE.SphereGeometry(segment.radius, 12, 8);
    system.visuals.addBodyMesh(segment.record, geometry, SurfaceId.Fabric);
  }

  // Three soldiers, one per surface: the stair, the walkable ramp, the
  // unwalkable one. Each starts a stride short of its obstacle and walks into it
  // at 3 m/s, so at the grab the stair-climber is two thirds of the way up.
  addWalker(system, scene, ctx, new THREE.Vector3(stairFoot + 0.9, PAD_Y + 0.05, ARENA_Z - 5.5), 3.0, -1);
  addWalker(system, scene, ctx, new THREE.Vector3(ARENA_X - 1.2, PAD_Y + 0.05, ARENA_Z - 5.5), 3.0, 1);
  addWalker(system, scene, ctx, new THREE.Vector3(ARENA_X + 6.4, PAD_Y + 0.05, ARENA_Z - 5.5), 3.0, 1);
  return scene;
}

/**
 * A ramp whose TOP FACE runs from `(x0, PAD_Y)` to `(x0 + run, PAD_Y + rise)`.
 * Composed from the top face rather than from the box centre: the thing that has
 * to be exact is where the character's feet land, and offsetting a rotated box
 * by hand is how ramps end up with their heel buried in the slab.
 */
function addRamp(
  system: PhysicsSystem,
  scene: Active,
  x0: number,
  run: number,
  angleRad: number,
  surface: SurfaceId,
): void {
  const rise = Math.tan(angleRad) * run;
  const thickness = 0.25;
  const halfLength = run / Math.cos(angleRad) / 2;
  const topCentre = new THREE.Vector3(x0 + run * 0.5, PAD_Y + rise * 0.5, ARENA_Z - 5.5);
  // Step back along the ramp's own up-normal to find the box centre.
  const normal = new THREE.Vector3(-Math.sin(angleRad), Math.cos(angleRad), 0);
  const centre = topCentre.clone().addScaledVector(normal, -thickness * 0.5);
  addBox(system, scene, centre, new THREE.Vector3(halfLength, thickness * 0.5, 2.0), {
    surface,
    tiltZ: angleRad,
  });
}

function addWalker(
  system: PhysicsSystem,
  scene: Active,
  ctx: TickCtx,
  position: THREE.Vector3,
  speed: number,
  facingX: number,
): void {
  const entity = ctx.entities.create('phys.walker');
  scene.owned.push(entity);
  const controller = system.createKinematicCharacter({
    entity,
    radius: 0.32,
    standHeight: 1.8,
    crouchHeight: 1.28,
    proneHeight: 0.63,
    position,
    skinWidth: 0.02,
    maxSlopeDeg: 50,
    stepHeight: 0.35,
    snapToGroundDistance: 0.4,
    group: CollisionGroup.Character,
    collidesWith: LAYER_SOLID | CollisionGroup.Character,
  });
  scene.walkers.push({
    controller,
    direction: new THREE.Vector3(Math.sign(facingX) || 1, 0, 0),
    speed,
    vertical: new THREE.Vector3(),
  });
  // The capsule mesh is offset to the capsule CENTRE: the body origin is at the
  // feet (see character.ts), and a mesh drawn there would put the soldier's
  // waist through the floor.
  system.visuals.addBodyMesh(
    controller.body,
    new THREE.CapsuleGeometry(0.32, 1.8 - 0.64, 6, 14),
    SurfaceId.Kevlar,
    new THREE.Vector3(0, 0.9, 0),
  );
}

/**
 * The locomotion a walker needs and no more: constant ground speed, gravity, and
 * whatever the controller permits. This is deliberately NOT GAME's locomotion —
 * the point of the shot is the CONTROLLER, and a scripted walk isolates it from
 * acceleration curves, stamina and stance blending.
 */
function driveWalkers(scene: Active, dt: number): void {
  const delta = new THREE.Vector3();
  for (const walker of scene.walkers) {
    if (walker.controller.grounded) {
      // A small downward bias while grounded keeps the capsule glued over a
      // crest instead of launching off the nose of every stair tread.
      walker.vertical.y = -Sim.GRAVITY * dt * 0.5;
    } else {
      walker.vertical.y -= Sim.GRAVITY * dt;
    }
    delta.copy(walker.direction).multiplyScalar(walker.speed * dt);
    delta.y += walker.vertical.y * dt;
    const result = walker.controller.move(delta, dt);
    if (result.grounded) walker.vertical.y = 0;
  }
}

/* -------------------------------------------------------- wall scenario */

function buildWall(system: PhysicsSystem, ctx: TickCtx): Active {
  const scene = newScene('wall', system, ctx);
  addPad(system, scene, 14, 9.5);

  const destruction = destructionSystem();
  const def = templateDef('cover_wall_sandstone');
  const half = templateHalf('cover_wall_sandstone');

  // Three bays of the same garden wall, RUNNING NORTH–SOUTH so their faces look
  // east and west. That is a lighting decision, not an arbitrary one: the sun at
  // golden hour is low in the west, so a wall running east–west has neither face
  // lit and the whole collapse renders as silhouettes against the sky.
  const yaw = Math.PI * 0.5;
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const centre = new THREE.Vector3(ARENA_X, PAD_Y + half.y, ARENA_Z);
  const near = centre.clone().setZ(ARENA_Z - half.x * 2 - 0.3);
  const far = centre.clone().setZ(ARENA_Z + half.x * 2 + 0.3);
  for (const position of [near, far]) {
    addBox(system, scene, position, half, { surface: SurfaceId.Sandstone, yaw });
  }

  const matrix = new THREE.Matrix4().compose(centre, spin, new THREE.Vector3(1, 1, 1));
  const wallHandle = system.addStatic({
    matrix,
    shape: { kind: 'box', half: half.clone() },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
    destructible: def,
  });
  scene.bodies.push(wallHandle);
  const wallMesh = system.visuals.addStaticMesh(
    new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
    SurfaceId.Sandstone,
    matrix,
  );

  const entity = ctx.entities.create('phys.destructible');
  scene.owned.push(entity);
  scene.wallEntity = entity;
  if (destruction && def) {
    destruction.register(entity, def, wallHandle);
    destruction.attachVisual(entity, wallMesh);
  }

  // What the collapse reveals, all of it EAST of the wall and none of it visible
  // over an intact 2.4 m bay: a fuel drum, a low barrier and a crate — three
  // things you would want to shoot at the moment your cover stops being cover.
  addBox(
    system,
    scene,
    new THREE.Vector3(ARENA_X + 5.2, PAD_Y + 0.45, ARENA_Z - 0.6),
    new THREE.Vector3(0.32, 0.45, 0.32),
    { surface: SurfaceId.PaintedMetal },
  );
  addBox(
    system,
    scene,
    new THREE.Vector3(ARENA_X + 6.4, PAD_Y + 0.55, ARENA_Z + 2.2),
    new THREE.Vector3(1.1, 0.55, 0.35),
    { surface: SurfaceId.Concrete, yaw: 1.4 },
  );
  addBox(
    system,
    scene,
    new THREE.Vector3(ARENA_X + 4.2, PAD_Y + 0.35, ARENA_Z - 4.4),
    new THREE.Vector3(0.5, 0.35, 0.5),
    { surface: SurfaceId.Wood, yaw: 0.4 },
  );

  // Sandbags at the foot of the near face, so the debris has something to break
  // over rather than a bare slab.
  for (let i = 0; i < 3; i++) {
    addBox(
      system,
      scene,
      new THREE.Vector3(ARENA_X - 1.4, PAD_Y + 0.18, ARENA_Z - 3.4 + i * 0.72),
      new THREE.Vector3(0.24, 0.18, 0.36),
      { surface: SurfaceId.Sandbag, yaw: 0.08 * i },
    );
  }
  return scene;
}

/**
 * The charge. A 40 mm-class detonation against the near face of the middle bay:
 * enough energy through `explosiveMultiplier` to take a 2400 HP masonry wall in
 * one hit, applied at a point that is off-centre so the wall does not collapse
 * symmetrically — a perfectly symmetric collapse is the single clearest tell
 * that a destruction system is scripted rather than simulated.
 */
function detonate(scene: Active, ctx: TickCtx): void {
  const destruction = destructionSystem();
  if (!destruction || scene.wallEntity === NULL_ENTITY) return;
  const point = new THREE.Vector3(ARENA_X - 0.24, PAD_Y + 0.85, ARENA_Z - 1.1);
  const normal = new THREE.Vector3(-1, 0, 0);
  destruction.applyDamage({
    target: scene.wallEntity,
    attacker: NULL_ENTITY,
    amount: 620,
    kind: DamageKind.Explosion,
    zone: HitZone.None,
    point,
    normal,
    direction: new THREE.Vector3(1, 0, 0),
    surface: SurfaceId.Sandstone,
    weapon: null,
    energyJ: 42000,
    penetrated: false,
  });
  // The blast keeps pushing after the wall has already become chunks: the shards
  // spawned this tick get their outward impulse from the pool, and this adds the
  // pressure front that carries the whole face outward together.
  scene.system.applyRadialImpulse(point, 5.5, 26, CollisionGroup.Debris);
  ctx.fx.emit('explosion', {
    point: point.clone(),
    radius: 5.5,
    energyJ: 42000,
    source: NULL_ENTITY,
  });
  ctx.fx.emit('cameraShake', { trauma: 0.55, frequencyHz: 14 });
}
