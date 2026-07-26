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
import { Btn, Stance, type PlayerIntent } from '@/engine/types';
import type { Bot } from '@/ai/bot';
import type { AiWorld } from '@/ai/world';
import { NavLink } from '@/ai/navgraph';

const DESIRED = new THREE.Vector3();
const CORNER = new THREE.Vector3();
const AVOID = new THREE.Vector3();
const PROBE = new THREE.Vector3();
const LANDED = new THREE.Vector3();

/** How close counts as "reached this corner". */
const CORNER_RADIUS = 1.15;
const GOAL_RADIUS = 0.9;
/** Bots inside this distance push each other apart. */
const SEPARATION = 1.55;

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
  if (path.status === 'ready' && bot.corridorIndex < path.cornerCount) {
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
    // No corridor yet: only walk straight at the goal if the ground actually
    // goes there, otherwise stand and wait for the queue rather than grinding
    // into a wall.
    PROBE.copy(self.state.position);
    CORNER.set(bot.goal.x, bot.goal.y, bot.goal.z);
    if (distanceToGoal > 1.5 && !world.nav.raycastWalkable(PROBE, CORNER, LANDED)) {
      DESIRED.multiplyScalar(0.15);
    }
  }

  if (distanceToGoal > 0.05) DESIRED.multiplyScalar(1 / Math.max(distanceToGoal, 1e-4));

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
