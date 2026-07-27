/**
 * Goals → `PlayerIntent`. The seam where a bot becomes indistinguishable from a
 * player as far as the rest of the engine is concerned.
 *
 * OWNER: AI.
 *
 * Nothing in this file moves anything. It fills in the same eight fields the
 * keyboard fills in, and GAME's `TickPhase.Movement` system turns them into
 * acceleration, friction and one `CharacterController.move()` — for the human
 * and for all 24 bots, through one code path (architecture decision #6).
 *
 * THE COORDINATE TRAP, WRITTEN DOWN ONCE: `moveX`/`moveZ` are YAW-LOCAL and are
 * resolved against the yaw the entity will have AFTER this tick's look is
 * applied. Because `aimAt` is authoritative, that yaw is exactly
 * `atan2(-dx, -dz)` of the eye→aimAt vector, so the desired world direction is
 * projected onto THAT basis and not onto the yaw the bot happens to have now.
 * Get it wrong and a bot that turns and walks in the same tick strafes into a
 * wall — which looks like a pathing bug and is not one.
 */
import * as THREE from 'three';
import { Btn, Stance, type PlayerIntent, type Vec3 } from '@/engine/types';
import type { Bot } from '@/ai/bot';
import type { AiWorld } from '@/ai/world';
import { NavLink } from '@/ai/navgraph';

const DESIRED = new THREE.Vector3();
const CORNER = new THREE.Vector3();
const AVOID = new THREE.Vector3();
const PROBE = new THREE.Vector3();
const LANDED = new THREE.Vector3();
const RECOVER = new THREE.Vector3();

/** How close counts as "reached this corner". */
const CORNER_RADIUS = 1.15;
const GOAL_RADIUS = 0.9;
/** Bots inside this distance push each other apart. */
const SEPARATION = 1.55;

/**
 * How far ahead the local steer asks "is the ground walkable this way".
 *
 * IT MUST BE A STRIDE, NOT THE WHOLE JOURNEY. The version this replaced probed
 * `raycastWalkable(position → goal)` — a straight line to an objective 110–230 m
 * away, across a Mediterranean town full of buildings — and then crawled at 15%
 * speed whenever that ray was blocked. It is blocked essentially always:
 * measured 0 successes in 60 328 calls. Probing 9 m instead, on the same map in
 * the same run, succeeds 43% of the time straight ahead and far more often once
 * the fan below is allowed to turn. A long ray answers a question no walking
 * animal asks.
 */
const LOCAL_PROBE_M = 9;
/**
 * Headings tried, in order, when the straight line to the goal is blocked, in
 * radians either side of it. Fixed order and fixed values: this runs inside the
 * simulation and must not consume the RNG stream or two captures of the same
 * shot diverge.
 */
const DETOUR_FAN: readonly number[] = [
  0.42, -0.42, 0.85, -0.85, 1.27, -1.27, 1.7, -1.7,
];
/** How far to look for walkable ground when a bot ends up off the navmesh. */
const OFF_MESH_SEARCH_M = 10;

/**
 * Turn a desired heading into one the ground actually supports.
 *
 * `direction` is a unit XZ vector, rewritten in place. Probes `reach` metres
 * along it; if that is blocked, sweeps the fan either side and takes the first
 * heading that clears. If nothing clears at full reach it falls back to the
 * furthest point the straight probe DID reach, so a bot in a dead end still
 * walks up to the wall and lets separation and the next corridor sort it out —
 * which is a bot that looks like it is trying, rather than a bot standing in an
 * alley at 15% throttle for forty seconds.
 *
 * Returns true when a clear heading was found.
 */
function steerLocally(from: Vec3, direction: THREE.Vector3, reach: number, world: AiWorld): boolean {
  const nav = world.nav;
  PROBE.copy(from);
  const dx = direction.x;
  const dz = direction.z;
  CORNER.set(from.x + dx * reach, from.y, from.z + dz * reach);
  if (nav.raycastWalkable(PROBE, CORNER, LANDED)) return true;

  // How far did the straight line get before it stopped? Kept before the fan
  // overwrites `LANDED`.
  const straightX = LANDED.x - from.x;
  const straightZ = LANDED.z - from.z;
  const straightReach = Math.hypot(straightX, straightZ);

  for (const offset of DETOUR_FAN) {
    const sin = Math.sin(offset);
    const cos = Math.cos(offset);
    const rx = dx * cos - dz * sin;
    const rz = dx * sin + dz * cos;
    CORNER.set(from.x + rx * reach, from.y, from.z + rz * reach);
    if (!nav.raycastWalkable(PROBE, CORNER, LANDED)) continue;
    direction.set(rx, 0, rz);
    return true;
  }

  // Nothing clears. Walk at whatever the straight probe managed rather than
  // stopping dead — but only if it is far enough to be a step, not a twitch.
  if (straightReach > 0.35) {
    direction.set(straightX / straightReach, 0, straightZ / straightReach);
  }
  return false;
}

/**
 * Is this bot standing on no navmesh polygon at all, and if so which way is the
 * nearest ground he could be standing on?
 *
 * `raycastWalkable(p, p)` degenerates to exactly the "is there a polygon here"
 * test — see `NavGraph.raycastWalkable`, which short-circuits a zero-length ray
 * to `polyAt(x, z) >= 0`. It matters because EVERY ray from an off-mesh
 * position fails on its first step, so a bot who has been pushed off the mesh
 * has no walkable heading in any direction and the fan above cannot rescue him.
 * Measured before this existed: four of eighteen bots stood off the mesh for
 * 100% of a 30 s run and travelled 0.00 m.
 *
 * Writes the recovery heading into `out` and returns true only when the bot is
 * both off-mesh and has somewhere to go.
 */
function offMeshRecovery(from: Vec3, world: AiWorld, out: THREE.Vector3): boolean {
  const nav = world.nav;
  PROBE.copy(from);
  if (nav.raycastWalkable(PROBE, PROBE, LANDED)) return false;
  if (!nav.sample(from, OFF_MESH_SEARCH_M, LANDED)) return false;
  const ox = LANDED.x - from.x;
  const oz = LANDED.z - from.z;
  const len = Math.hypot(ox, oz);
  if (len < 0.2) return false;
  out.set(ox / len, 0, oz / len);
  return true;
}

export function writeIntent(bot: Bot, world: AiWorld): void {
  const intent = bot.intent;
  const self = world.actorOf(bot.entity);
  intent.moveX = 0;
  intent.moveZ = 0;
  intent.lookYaw = 0;
  intent.lookPitch = 0;
  intent.weaponSlot = -1;

  if (!self || !bot.alive || !self.state.alive) {
    intent.buttons = 0;
    intent.pressed = 0;
    intent.released = bot.prevButtons;
    intent.aimAt = null;
    bot.prevButtons = 0;
    return;
  }

  // ---- follow the corridor -------------------------------------------------
  DESIRED.set(0, 0, 0);
  let distanceToGoal = 0;
  let linkAhead = NavLink.Walk;
  const path = bot.path;
  // A solve that landed since the last tick rewinds the corridor. Doing it here
  // rather than at submit time is what lets the previous corridor stay walkable
  // for the whole time the queue takes to answer.
  if (path.status === 'ready' && bot.corridorGeneration !== path.generation) {
    bot.corridorGeneration = path.generation;
    bot.corridorIndex = 0;
  }
  if (path.cornerCount > 0 && bot.corridorIndex < path.cornerCount) {
    // Consume corners we are already on top of. More than one per tick is
    // normal right after a string-pull that starts behind the bot.
    for (let guard = 0; guard < 4 && bot.corridorIndex < path.cornerCount; guard++) {
      CORNER.copy(path.corners[bot.corridorIndex].position);
      const last = bot.corridorIndex === path.cornerCount - 1;
      const flat = Math.hypot(CORNER.x - self.state.position.x, CORNER.z - self.state.position.z);
      if (flat > (last ? GOAL_RADIUS : CORNER_RADIUS)) break;
      bot.corridorIndex++;
    }
    if (bot.corridorIndex < path.cornerCount) {
      const corner = path.corners[bot.corridorIndex];
      DESIRED.set(corner.position.x - self.state.position.x, 0, corner.position.z - self.state.position.z);
      linkAhead = corner.link;
      distanceToGoal = DESIRED.length();
    }
  } else if (bot.goal.lengthSq() > 0) {
    DESIRED.set(bot.goal.x - self.state.position.x, 0, bot.goal.z - self.state.position.z);
    distanceToGoal = DESIRED.length();
    if (distanceToGoal > 0.05) {
      DESIRED.multiplyScalar(1 / distanceToGoal);
      steerLocally(self.state.position, DESIRED, Math.min(distanceToGoal, LOCAL_PROBE_M), world);
      // Re-expand: the block below normalises by `distanceToGoal`, and the fan
      // hands back a unit vector.
      DESIRED.multiplyScalar(distanceToGoal);
    }
  }

  if (distanceToGoal > 0.05) DESIRED.multiplyScalar(1 / Math.max(distanceToGoal, 1e-4));

  // ---- back onto the mesh --------------------------------------------------
  // Overrides the corridor as well as the local steer: a corridor whose first
  // corner is reached by walking through whatever pushed him off the mesh is
  // not a route he can take, and the recovery heading is the only one that is.
  if (offMeshRecovery(self.state.position, world, RECOVER)) {
    DESIRED.copy(RECOVER);
    distanceToGoal = Math.max(distanceToGoal, 2);
  }

  // ---- hold the cover ------------------------------------------------------
  const holdingCover =
    bot.cover !== null &&
    bot.goalKind === 'cover' &&
    Math.hypot(bot.cover.position.x - self.state.position.x, bot.cover.position.z - self.state.position.z) < 1.2;
  if (holdingCover && bot.cover) {
    // Leaning out is a lateral shuffle along the cover face, not a walk: the
    // bot slides toward the exposed side while peeking and back when hiding.
    const along = AVOID.set(-bot.cover.facing.z, 0, bot.cover.facing.x);
    const side = bot.slot % 2 === 0 ? 1 : -1;
    DESIRED.copy(along).multiplyScalar(side * (bot.exposure - 0.5) * 1.1);
    if (DESIRED.lengthSq() > 1) DESIRED.normalize();
    distanceToGoal = 0;
  }

  // ---- separation ----------------------------------------------------------
  AVOID.set(0, 0, 0);
  for (const other of world.bots) {
    if (other === bot || !other.alive) continue;
    const actor = world.actorOf(other.entity);
    if (!actor) continue;
    const dx = self.state.position.x - actor.state.position.x;
    const dz = self.state.position.z - actor.state.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > SEPARATION * SEPARATION || d2 < 1e-5) continue;
    const d = Math.sqrt(d2);
    AVOID.x += (dx / d) * (1 - d / SEPARATION);
    AVOID.z += (dz / d) * (1 - d / SEPARATION);
  }
  DESIRED.addScaledVector(AVOID, 0.85);
  const desiredLength = Math.hypot(DESIRED.x, DESIRED.z);
  if (desiredLength > 1) DESIRED.multiplyScalar(1 / desiredLength);

  // ---- project onto the yaw this tick will actually produce ----------------
  const eyeY = self.state.position.y + self.state.eyeHeight;
  const ax = bot.aimAt.x - self.state.position.x;
  const az = bot.aimAt.z - self.state.position.z;
  const yaw = Math.abs(ax) + Math.abs(az) > 1e-5 ? Math.atan2(-ax, -az) : self.state.yaw;
  void eyeY;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // forward = (−sin, −cos), right = (cos, −sin): the basis GAME resolves
  // `moveX`/`moveZ` against.
  intent.moveZ = DESIRED.x * -sin + DESIRED.z * -cos;
  intent.moveX = DESIRED.x * cos + DESIRED.z * -sin;
  const magnitude = Math.hypot(intent.moveX, intent.moveZ);
  if (magnitude > 1) {
    intent.moveX /= magnitude;
    intent.moveZ /= magnitude;
  }

  // ---- buttons -------------------------------------------------------------
  let buttons = 0;
  if (bot.trigger) buttons |= Btn.Fire;
  if (bot.wantsAds && bot.exposure > 0.5) buttons |= Btn.Ads;
  if (world.time < bot.reloadPressUntil) buttons |= Btn.Reload;
  if (world.time < bot.throwingUntil) buttons |= Btn.Grenade;
  if (bot.stance === Stance.Crouch) buttons |= Btn.Crouch;
  else if (bot.stance === Stance.Prone) buttons |= Btn.Prone;
  // Sprint: only in the open, only toward something far, never with a contact.
  const contact = bot.target !== 0 && (bot.memoryOf(bot.target)?.confidence ?? 0) > 0.5;
  bot.wantsSprint =
    !contact &&
    !holdingCover &&
    distanceToGoal > 9 &&
    intent.moveZ > 0.55 &&
    bot.stance === Stance.Stand &&
    self.state.stamina > 0.25;
  if (bot.wantsSprint) buttons |= Btn.Sprint;
  // A vault or a drop is a jump the instant the corner is close enough that the
  // character controller will meet the ledge inside this tick.
  if (linkAhead !== NavLink.Walk && distanceToGoal < 1.8) buttons |= Btn.Jump;

  intent.buttons = buttons;
  intent.pressed = buttons & ~bot.prevButtons;
  intent.released = bot.prevButtons & ~buttons;
  bot.prevButtons = buttons;
  intent.aimAt = bot.aimAt;
}

/** Copy a bot's computed intent into the struct GAME hands us. Never mutate ours. */
export function copyIntent(from: PlayerIntent, out: PlayerIntent): void {
  out.moveX = from.moveX;
  out.moveZ = from.moveZ;
  out.lookYaw = from.lookYaw;
  out.lookPitch = from.lookPitch;
  out.buttons = from.buttons;
  out.pressed = from.pressed;
  out.released = from.released;
  out.weaponSlot = from.weaponSlot;
  out.aimAt = from.aimAt;
}
