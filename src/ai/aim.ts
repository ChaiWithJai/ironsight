/**
 * Human-like aim: latency, a spring that overshoots, a slow error cone, and a
 * trigger that will not break until the sights have settled.
 *
 * OWNER: AI.
 *
 * `PlayerIntent.aimAt` is AUTHORITATIVE and GAME applies no smoothing of its
 * own (types.ts §3), so every bit of aim dynamics is here. That is deliberate:
 * two smoothers in series is a reaction time nobody can find.
 *
 * The four things that make it read as a person rather than a turret:
 *  1. `reactionAt` from perception — nothing moves until the man has reacted.
 *  2. A second-order spring with damping < 1, so the sights swing PAST the
 *     target and come back. Critically damped aim reads as a servo.
 *  3. A slow, smooth error cone (two incommensurate sines, per-bot phase) that
 *     the bot never corrects, scaled by difficulty, movement and suppression.
 *  4. A settle gate on the trigger: shooting mid-swing is what makes a bot feel
 *     like it is cheating in reverse — spraying at nothing.
 */
import * as THREE from 'three';
import { Stance } from '@/engine/types';
import type { Bot, ThreatMemory } from '@/ai/bot';
import type { ActorView, AiWorld } from '@/ai/world';

const DEG = Math.PI / 180;
const AIM_TMP = new THREE.Vector3();
const LEAD_TMP = new THREE.Vector3();

/** Metres per second of a service rifle round; the lead solver's constant. */
const NOMINAL_MUZZLE_MPS = 860;

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Where the bot WANTS to look, in world space. Writes into `bot.aimPoint`. */
export function desiredAimPoint(bot: Bot, world: AiWorld, memory: ThreatMemory | null, self: ActorView): void {
  if (memory) {
    const eyeY = 1.45;
    // Centre mass, not the head: a bot that aims at the head by default is a
    // bot that headshots, and one that headshots instantly is worse than none.
    bot.aimPoint.set(memory.lastKnown.x, memory.lastKnown.y + eyeY * 0.82, memory.lastKnown.z);
    if (!memory.heardOnly) {
      const flight = Math.min(0.6, memory.distance / NOMINAL_MUZZLE_MPS + 0.06);
      // Lead quality is a difficulty dial: a recruit under-leads badly.
      const quality = 0.25 + world.difficulty * 0.8;
      LEAD_TMP.copy(memory.lastVelocity).multiplyScalar(flight * quality);
      bot.aimPoint.add(LEAD_TMP);
    }
    return;
  }
  // Nothing to shoot: look along the path, which is what makes a moving squad
  // sweep its arcs instead of staring at the horizon.
  const corner = bot.path.status === 'ready' && bot.corridorIndex < bot.path.cornerCount
    ? bot.path.corners[bot.corridorIndex].position
    : null;
  if (corner) {
    bot.aimPoint.set(corner.x, self.state.position.y + self.state.eyeHeight * 0.95, corner.z);
    return;
  }
  const forwardX = -Math.sin(bot.aimYaw);
  const forwardZ = -Math.cos(bot.aimYaw);
  bot.aimPoint.set(
    self.state.position.x + forwardX * 20,
    self.state.position.y + self.state.eyeHeight,
    self.state.position.z + forwardZ * 20,
  );
}

/**
 * Integrate the aim spring one tick and write `bot.aimAt`. Returns the angular
 * error to the desired point in radians, which is what gates the trigger.
 */
export function solveAim(bot: Bot, world: AiWorld, self: ActorView, engaged: boolean): number {
  const dt = world.dt;
  const eyeX = self.state.position.x;
  const eyeY = self.state.position.y + self.state.eyeHeight;
  const eyeZ = self.state.position.z;
  AIM_TMP.set(bot.aimPoint.x - eyeX, bot.aimPoint.y - eyeY, bot.aimPoint.z - eyeZ);
  const flat = Math.hypot(AIM_TMP.x, AIM_TMP.z);
  const targetYaw = Math.atan2(-AIM_TMP.x, -AIM_TMP.z);
  const targetPitch = Math.atan2(AIM_TMP.y, Math.max(0.05, flat));

  const spring = bot.profile.aimSpring;
  // Turning to a contact behind you is a whole-body movement and is slower than
  // a 5° correction; the spring alone would snap 180° as fast as it snaps 5°.
  const yawError = wrapPi(targetYaw - bot.aimYaw);
  const gross = Math.min(1, Math.abs(yawError) / 1.2);
  const stiffness = spring.stiffness * (1 - gross * 0.45);
  const damping = 2 * spring.damping * Math.sqrt(stiffness * spring.mass);

  bot.aimYawVel += ((stiffness * yawError - damping * bot.aimYawVel) / spring.mass) * dt;
  bot.aimPitchVel += ((stiffness * wrapPi(targetPitch - bot.aimPitch) - damping * bot.aimPitchVel) / spring.mass) * dt;
  // Rate limit: no human snaps faster than about 6 rad/s with a rifle up.
  const maxRate = engaged ? 7.5 : 4.5;
  bot.aimYawVel = Math.max(-maxRate, Math.min(maxRate, bot.aimYawVel));
  bot.aimPitchVel = Math.max(-maxRate, Math.min(maxRate, bot.aimPitchVel));
  bot.aimYaw = wrapPi(bot.aimYaw + bot.aimYawVel * dt);
  bot.aimPitch = Math.max(-1.2, Math.min(1.2, bot.aimPitch + bot.aimPitchVel * dt));

  const error = Math.hypot(wrapPi(targetYaw - bot.aimYaw), targetPitch - bot.aimPitch);
  // Settled means "on target AND not still swinging".
  const swing = Math.min(1, Math.hypot(bot.aimYawVel, bot.aimPitchVel) / 1.4);
  bot.settle = Math.max(0, 1 - Math.min(1, error / (3.5 * DEG)) * 0.7 - swing * 0.5);

  // ---- deliberate inaccuracy ---------------------------------------------
  // Spawn-relative, never absolute: see `Bot.spawnTime`. Two captures of the
  // same shot must put the same wobble on the same soldier.
  const t = world.time - bot.spawnTime;
  const wobble =
    (Math.sin(t * bot.errFreqA + bot.errPhaseA) + 0.62 * Math.sin(t * bot.errFreqB + bot.errPhaseB)) / 1.62;
  const wobble2 =
    (Math.cos(t * bot.errFreqB * 0.83 + bot.errPhaseB) + 0.55 * Math.sin(t * bot.errFreqA * 1.37 + bot.errPhaseA)) / 1.55;
  const distanceScale = Math.max(0.35, Math.min(1.6, (bot.memoryOf(bot.target)?.distance ?? 40) / 50));
  const movePenalty = 1 + Math.min(1, self.state.groundSpeed / 4.2) * 0.9;
  const stanceBonus = self.state.stance === Stance.Crouch ? 0.72 : self.state.stance === Stance.Prone ? 0.5 : 1;
  const suppressPenalty = 1 + bot.suppression * 1.4;
  const skill = 1.65 - world.difficulty * 1.05;
  const cone =
    bot.profile.aimErrorDeg * DEG * distanceScale * movePenalty * stanceBonus * suppressPenalty * skill +
    bot.recoil * 0.6 * DEG;

  const finalYaw = bot.aimYaw + wobble * cone;
  const finalPitch = Math.max(-1.25, Math.min(1.25, bot.aimPitch + wobble2 * cone * 0.7));
  const cosP = Math.cos(finalPitch);
  // `aimAt` is a POINT, and GAME snaps yaw/pitch straight to it, so it must be
  // far enough away that the eye-to-point direction is the direction we mean.
  const reach = 60;
  bot.aimAt.set(
    eyeX - Math.sin(finalYaw) * cosP * reach,
    eyeY + Math.sin(finalPitch) * reach,
    eyeZ - Math.cos(finalYaw) * cosP * reach,
  );
  bot.intent.aimAt = bot.aimAt;
  return error;
}

/**
 * May the trigger break this tick? Reaction latency, settle, ammunition and
 * the burst rhythm all have to agree.
 */
export function canPullTrigger(bot: Bot, world: AiWorld, memory: ThreatMemory | null, error: number): boolean {
  if (!memory || !bot.alive) return false;
  if (memory.heardOnly) return false;
  if (world.time < memory.reactionAt) return false;
  if (bot.reloadEndTime > world.time || bot.ammo <= 0) return false;
  if (world.time < bot.burstPauseUntil) return false;
  // 2.2° is about a torso at 25 m: tight enough that a bot does not fire at a
  // wall, loose enough that he does not wait for a perfect solution.
  const gate = 2.2 * DEG + (memory.distance > 60 ? 0.4 * DEG : 0);
  return error < gate && bot.settle > 0.35;
}
