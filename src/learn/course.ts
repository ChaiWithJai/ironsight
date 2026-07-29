/**
 * Observable learning contracts for the academy.
 *
 * A chapter is not complete because it was viewed. It is complete when the
 * learner changes the world in a way that demonstrates the chapter's idea.
 * Demos report plain evidence; this file owns the assessment rules and feedback.
 */

export type MissionEvidence = Record<string, number | string | boolean>;

/**
 * The course's published version. Sent with every durable run so a learner's
 * history is pinned to the exact curriculum they took — and so a future rewrite
 * ships as `chronicle-<date>` beside this one rather than silently mutating it.
 */
export const COURSE_VERSION = 'chronicle-2026-07-29';

export interface MissionResult {
  complete: boolean;
  feedback: string;
}

export interface Mission {
  id: string;
  objective: string;
  task: string;
  success: string;
  /**
   * Version of THIS mission's pass/fail rubric. Persisted on every attempt so a
   * later rubric change never silently reinterprets evidence graded under an
   * earlier one. Bump when `evaluate` or the success criteria change.
   */
  evaluatorVersion: string;
  evaluate(evidence: MissionEvidence): MissionResult;
}

export const MISSIONS: Record<string, Mission> = {
  seed: {
    id: 'seed',
    objective: 'Prove that a whole world can be addressed by one deterministic value.',
    task: 'Change the seed and create a second named world. Notice that the URL carries your choice.',
    success: 'A non-default seed produces a new world while both scribes still agree pixel for pixel.',
    evaluatorVersion: 'seed@2026-07-29',
    evaluate(evidence) {
      const changed = evidence.seedChanged === true;
      const deterministic = evidence.pixelDiff === 0;
      return {
        complete: changed && deterministic,
        feedback: changed
          ? deterministic
            ? 'World addressed. The seed changed, the URL changed, and both scribes still agree.'
            : 'You changed fate, but the scribes disagree. Determinism has broken.'
          : 'Your move: choose “next fate” or enter a different seed.',
      };
    },
  },
  land: {
    id: 'land',
    objective: 'Use procedural parameters as creative and performance constraints.',
    task: 'Shape a defensible archipelago: use 6+ octaves, raise the sea to at least 0.48, and keep 5–35% land.',
    success: 'The measured terrain satisfies all three constraints at the same time.',
    evaluatorVersion: 'land@2026-07-29',
    evaluate(evidence) {
      const interacted = evidence.interacted === true;
      const sea = Number(evidence.seaLevel ?? 0);
      const octaves = Number(evidence.octaves ?? 0);
      const land = Number(evidence.landFraction ?? 1);
      const complete = interacted && sea >= 0.48 && octaves >= 6 && land >= 0.05 && land <= 0.35;
      const needs = [
        sea < 0.48 ? 'raise the sea to 0.48+' : '',
        octaves < 6 ? 'use 6+ octaves' : '',
        land < 0.05 ? 'recover some land' : '',
        land > 0.35 ? 'submerge more land' : '',
      ].filter(Boolean);
      return {
        complete,
        feedback: complete
          ? `Archipelago secured: ${(land * 100).toFixed(1)}% land at sea ${sea.toFixed(2)}, ${octaves} octaves.`
          : interacted
            ? `Keep shaping: ${needs.join(' · ') || 'move a control to test your design'}.`
            : 'Your move: the terrain responds immediately; start with sea level, then add detail.',
      };
    },
  },
  people: {
    id: 'people',
    objective: 'Distinguish deterministic simulation time from wall-clock time.',
    task: 'Advance at least three seasons. Read the tick count, then use rebirth to verify history can restart.',
    success: 'The learner advances the simulation to tick 60 or later.',
    evaluatorVersion: 'people@2026-07-29',
    evaluate(evidence) {
      const interacted = evidence.interacted === true;
      const tick = Number(evidence.tick ?? 0);
      return {
        complete: interacted && tick >= 60,
        feedback:
          interacted && tick >= 60
            ? `History made: tick ${tick}. The same seed and tick can reproduce this moment.`
            : `Advance ${Math.max(0, 60 - tick)} more ticks; the clock on the wall is irrelevant here.`,
      };
    },
  },
  ledger: {
    id: 'ledger',
    objective: 'Recognize an API as a stable data contract, not necessarily a live server.',
    task: 'Open the raw ledger and compare its JSON shape with the rendered eras.',
    success: 'The learner reveals the build-time JSON object used by the interface.',
    evaluatorVersion: 'ledger@2026-07-29',
    evaluate(evidence) {
      const open = evidence.rawVisible === true;
      return {
        complete: open,
        feedback: open
          ? 'Contract revealed. The cards and the raw JSON are two views of the same build-time data.'
          : 'Your move: reveal the raw ledger beneath the era cards.',
      };
    },
  },
  gate: {
    id: 'gate',
    objective: 'Use executable constraints to prove that a creative system remains reproducible.',
    task: 'Run the three gate rituals and inspect the evidence behind every verdict.',
    success: 'All three independently computed rituals pass after the learner runs them.',
    evaluatorVersion: 'gate@2026-07-29',
    evaluate(evidence) {
      const ran = evidence.gateRun === true;
      const passed = Number(evidence.passed ?? 0);
      const total = Number(evidence.total ?? 3);
      return {
        complete: ran && passed === total,
        feedback: ran
          ? passed === total
            ? `${passed}/${total} gates green. The world is reproducible enough to compare, teach, and change.`
            : `${passed}/${total} gates passed. Read the failed rite before changing the world.`
          : 'Your move: run the gates. A claim becomes knowledge only when the machine can check it.',
      };
    },
  },
};
