/**
 * The frozen `BotProfile` table.
 *
 * OWNER: AI. `AiService.profiles` is the only way another lane reaches these —
 * GAME's `director.ts` balances bot counts and cannot import this file.
 *
 * The numbers are a difficulty ladder, not four flavours of the same soldier.
 * `reactionTime` is the gap between a target crossing the detection threshold
 * and the first shot leaving the barrel: below ~0.18 s a human reads it as an
 * aimbot, above ~0.7 s as a bot that has not noticed him. `aimErrorDeg` is the
 * steady-state cone at 50 m — 1° there is 0.9 m of miss, which is a torso.
 */
import type { BotProfile } from '@/engine/types';

export const BOT_PROFILES: readonly Readonly<BotProfile>[] = Object.freeze([
  {
    id: 'recruit',
    reactionTime: 0.62,
    aimErrorDeg: 3.4,
    // Soft and floppy: the aim visibly drifts past the target and comes back.
    aimSpring: { stiffness: 42, damping: 0.5, mass: 1 },
    burstDiscipline: 0.25,
    aggression: 0.32,
    coverPreference: 0.75,
    hearingRange: 32,
    visionRange: 85,
    visionConeDeg: 95,
    preferredWeapons: ['smg_compact', 'carbine'],
  },
  {
    id: 'regular',
    reactionTime: 0.38,
    aimErrorDeg: 1.9,
    aimSpring: { stiffness: 90, damping: 0.62, mass: 1 },
    burstDiscipline: 0.55,
    aggression: 0.5,
    coverPreference: 0.62,
    hearingRange: 45,
    visionRange: 120,
    visionConeDeg: 100,
    preferredWeapons: ['ar_service', 'carbine'],
  },
  {
    id: 'support',
    reactionTime: 0.44,
    aimErrorDeg: 2.4,
    aimSpring: { stiffness: 74, damping: 0.7, mass: 1.25 },
    // Long bursts, and the whole point of him: he suppresses rather than kills.
    burstDiscipline: 0.85,
    aggression: 0.6,
    coverPreference: 0.55,
    hearingRange: 42,
    visionRange: 110,
    visionConeDeg: 96,
    preferredWeapons: ['lmg_support'],
  },
  {
    id: 'veteran',
    reactionTime: 0.24,
    aimErrorDeg: 1.1,
    aimSpring: { stiffness: 150, damping: 0.78, mass: 0.9 },
    burstDiscipline: 0.72,
    aggression: 0.68,
    coverPreference: 0.5,
    hearingRange: 55,
    visionRange: 145,
    visionConeDeg: 108,
    preferredWeapons: ['ar_service', 'dmr_marksman'],
  },
  {
    id: 'marksman',
    reactionTime: 0.5,
    aimErrorDeg: 0.7,
    // Stiff and heavily damped: almost no overshoot, but slow onto the target.
    aimSpring: { stiffness: 170, damping: 0.92, mass: 1.4 },
    burstDiscipline: 0.95,
    aggression: 0.3,
    coverPreference: 0.82,
    hearingRange: 48,
    visionRange: 210,
    visionConeDeg: 70,
    preferredWeapons: ['dmr_marksman'],
  },
]);

/**
 * Squad composition, as indices into the table above. A four-man squad is one
 * veteran point man, two regulars and a support gun — the shape that makes a
 * firefight read as a squad rather than as four identical soldiers.
 */
export const SQUAD_COMPOSITION: readonly number[] = Object.freeze([3, 1, 1, 2]);

export function profileByIndex(index: number): Readonly<BotProfile> {
  return BOT_PROFILES[Math.abs(index) % BOT_PROFILES.length];
}
