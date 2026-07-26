/**
 * Vision cones, line of sight, hearing and the memory that decays.
 *
 * OWNER: AI.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a bot never reads a target's true
 * position. It reads `ThreatMemory.lastKnown`, which is only refreshed while
 * the target is actually visible, extrapolates it for a second and a half along
 * the last observed velocity, and then goes stale. Everything downstream —
 * aiming, flanking, grenades, suppression — is built on that belief, which is
 * why a bot can be flanked at all.
 *
 * Detection is an ACCUMULATOR, not a boolean: closing distance, moving,
 * standing and shooting all raise the rate; range, foliage, crouch and being
 * still lower it. Crossing 1.0 arms `reactionAt`, and only then may the trigger
 * be pulled — that gap is the difference between a soldier and an aimbot.
 */
import * as THREE from 'three';
import { Stance, type EntityId, type NoiseEvent } from '@/engine/types';
import type { Bot, ThreatMemory } from '@/ai/bot';
import type { ActorView, AiWorld } from '@/ai/world';

const EYE_A = new THREE.Vector3();
const EYE_B = new THREE.Vector3();
const TO_TARGET = new THREE.Vector3();

/** Seconds of dead reckoning before a memory stops moving and starts rotting. */
const EXTRAPOLATE_SECONDS = 1.5;
/** A memory older than this is forgotten outright. */
const FORGET_SECONDS = 14;

export function eyePosition(actor: ActorView, out: THREE.Vector3): THREE.Vector3 {
  return out.set(actor.state.position.x, actor.state.position.y + actor.state.eyeHeight, actor.state.position.z);
}

/**
 * One perception pass for one bot. `elapsed` is the time since THIS bot was
 * last perceived, not the tick dt — perception is round-robin, so a bot
 * processed every fourth tick must integrate four ticks of detection or its
 * effective reaction time silently quadruples.
 */
export function perceive(bot: Bot, world: AiWorld, elapsed: number): void {
  const self = world.actorOf(bot.entity);
  if (!self || !bot.alive) return;
  eyePosition(self, EYE_A);
  const facingX = -Math.sin(self.state.yaw);
  const facingZ = -Math.cos(self.state.yaw);
  const coneCos = Math.cos((bot.profile.visionConeDeg * 0.5 * Math.PI) / 180);
  const range = bot.profile.visionRange;
  const difficulty = world.difficulty;

  for (const actor of world.actors) {
    if (actor.entity === bot.entity) continue;
    if (actor.team === bot.team) continue;
    if (!actor.state.alive) {
      const dead = bot.memoryOf(actor.entity);
      if (dead) dead.confidence = 0;
      continue;
    }
    TO_TARGET.set(
      actor.state.position.x - self.state.position.x,
      0,
      actor.state.position.z - self.state.position.z,
    );
    const distance = TO_TARGET.length();
    if (distance > range) continue;
    const inv = distance > 1e-4 ? 1 / distance : 0;
    const dot = (TO_TARGET.x * facingX + TO_TARGET.z * facingZ) * inv;
    // Peripheral vision: outside the cone a bot still notices something very
    // close, which is what stops him being knifed by a man standing beside him.
    const inCone = dot >= coneCos || distance < 6;
    let vis = 0;
    if (inCone) {
      eyePosition(actor, EYE_B);
      vis = world.visibility(EYE_A, EYE_B);
      if (vis > 0 && actor.state.stance === Stance.Prone) vis *= 0.55;
    }

    const memory = bot.memoryFor(actor.entity, world.time);
    memory.distance = distance;
    if (vis > 0.25) {
      // Rate falls off with range and rises with how much the target is doing.
      const rangeTerm = 1 - Math.min(1, distance / range) * 0.75;
      const motionTerm = 0.55 + Math.min(1, actor.state.groundSpeed / 4.5) * 0.75;
      const stanceTerm = actor.state.stance === Stance.Stand ? 1 : actor.state.stance === Stance.Crouch ? 0.78 : 0.55;
      const skill = 0.6 + difficulty * 0.9;
      memory.confidence = Math.min(1.6, memory.confidence + rangeTerm * motionTerm * stanceTerm * skill * vis * elapsed * 2.1);
      if (!memory.visible) memory.firstSeenTime = world.time;
      memory.visible = memory.confidence >= 1;
      if (memory.visible) {
        if (memory.reactionAt === Infinity) {
          // Reaction is a delay from FIRST CONFIRMED SIGHT, scaled by skill.
          memory.reactionAt = world.time + bot.profile.reactionTime * (1.55 - difficulty * 0.85);
        }
        const moved = TO_TARGET.set(
          actor.state.position.x - memory.lastKnown.x,
          0,
          actor.state.position.z - memory.lastKnown.z,
        ).length();
        if (moved > 0.7) memory.staticSince = world.time;
        memory.lastKnown.copy(actor.state.position);
        memory.lastVelocity.copy(actor.state.velocity);
        memory.lastSeenTime = world.time;
        memory.heardOnly = false;
      }
    } else {
      memory.visible = false;
      // Losing sight does not lose the contact: confidence bleeds down over a
      // couple of seconds, which is the window a bot keeps shooting at a doorway.
      memory.confidence = Math.max(0, memory.confidence - elapsed * 0.42);
      if (memory.confidence < 1) memory.reactionAt = Infinity;
    }
  }

  // Age every memory, including ones for targets now out of range entirely.
  for (let i = bot.memories.length - 1; i >= 0; i--) {
    const memory = bot.memories[i];
    if (!memory.visible) {
      const age = world.time - memory.lastSeenTime;
      if (age > FORGET_SECONDS) {
        bot.memories.splice(i, 1);
        continue;
      }
      if (age < EXTRAPOLATE_SECONDS && !memory.heardOnly) {
        memory.lastKnown.addScaledVector(memory.lastVelocity, elapsed);
      }
    }
  }
}

/**
 * A noise the bot may have heard. Inverse-square attenuation against the
 * profile's hearing range, and the recalled position carries an error that
 * grows with distance — a bot who heard a rifle 60 m away knows the direction,
 * not the doorway.
 */
export function hear(bot: Bot, event: NoiseEvent, world: AiWorld, selfPosition: THREE.Vector3): void {
  if (!bot.alive || event.source === bot.entity) return;
  if (event.team === bot.team && event.kind !== 'explosion') return;
  const distance = selfPosition.distanceTo(event.position);
  if (distance < 0.5) return;
  // dB SPL at 1 m, attenuated by 20·log10(d). `hearingRange` is calibrated as
  // the distance at which a 140 dB gunshot is exactly at threshold.
  const heard = event.loudnessDb - 20 * Math.log10(distance);
  const threshold = 140 - 20 * Math.log10(Math.max(1, bot.profile.hearingRange));
  if (heard < threshold) return;

  const memory = bot.memoryFor(event.source, world.time);
  const strength = Math.min(1, (heard - threshold) / 18);
  const error = Math.min(14, distance * 0.16) * (1 - strength * 0.6);
  if (!memory.visible) {
    // Deterministic error: the bot's own stream, so two runs mishear identically.
    const a = world.rng.next() * Math.PI * 2;
    memory.lastKnown.set(
      event.position.x + Math.cos(a) * error,
      event.position.y,
      event.position.z + Math.sin(a) * error,
    );
    memory.lastVelocity.set(0, 0, 0);
    memory.heardOnly = true;
    memory.lastSeenTime = world.time - 0.35;
    memory.staticSince = world.time;
  }
  // Hearing alone never crosses the sight threshold: it turns the bot around
  // and makes him investigate, and vision does the confirming.
  memory.confidence = Math.max(memory.confidence, Math.min(0.85, 0.35 + strength * 0.5));
  memory.distance = distance;
}

/** The most dangerous contact this bot currently believes in, or null. */
export function selectTarget(bot: Bot, world: AiWorld): ThreatMemory | null {
  let best: ThreatMemory | null = null;
  let bestScore = -Infinity;
  for (const memory of bot.memories) {
    if (memory.confidence < 0.3) continue;
    const age = world.time - memory.lastSeenTime;
    if (age > FORGET_SECONDS) continue;
    // Close, visible and recently seen beats far, remembered and stale — and a
    // target the bot is already engaging gets a stickiness bonus so he does not
    // ping-pong between two men at the same range.
    let score = 120 - Math.min(120, memory.distance);
    if (memory.visible) score += 55;
    score -= age * 6;
    if (memory.entity === bot.target) score += 22;
    if (memory.heardOnly) score -= 18;
    if (score > bestScore) {
      bestScore = score;
      best = memory;
    }
  }
  return best;
}

export function forgetEntity(bot: Bot, entity: EntityId): void {
  for (let i = bot.memories.length - 1; i >= 0; i--) {
    if (bot.memories[i].entity === entity) bot.memories.splice(i, 1);
  }
  if (bot.target === entity) bot.target = 0 as EntityId;
}
