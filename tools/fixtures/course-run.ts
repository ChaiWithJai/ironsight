/**
 * Factories for the durable learner-outcome tables defined in
 * netlify/database/migrations/20260729134500_teaching_platform.sql:
 * anonymous_learners, course_runs, mission_attempts, reflections and
 * publications.
 *
 * No Functions or client sync implement these tables yet (see issue #3, "P0 —
 * durable runs, evidence, reflection, and publication"); these factories
 * exist so unit tests, local integration tests against the schema, and any
 * future Function implementation share one shape for these payloads instead
 * of each re-deriving the columns from the migration file by hand.
 *
 * Every field name here is a direct, deliberate match to a migration column;
 * keep them in lockstep if the migration changes.
 */

export type CourseRunStatus = 'active' | 'completed' | 'abandoned';
export type PublicationStatus = 'published' | 'withdrawn' | 'failed';

function id(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------- anonymous_learners

export interface AnonymousLearnerFixture {
  readonly id: string;
}

export function createAnonymousLearner(
  overrides: Partial<AnonymousLearnerFixture> = {},
): AnonymousLearnerFixture {
  return { id: overrides.id ?? id() };
}

// --------------------------------------------------------------- course_runs

export interface CourseRunFixture {
  readonly id: string;
  readonly learnerId: string;
  readonly worldId: string | null;
  readonly courseVersion: string;
  readonly status: CourseRunStatus;
  readonly completedAt: Date | null;
}

export function createCourseRun(overrides: Partial<CourseRunFixture> = {}): CourseRunFixture {
  return {
    id: overrides.id ?? id(),
    learnerId: overrides.learnerId ?? id(),
    worldId: overrides.worldId ?? null,
    courseVersion: overrides.courseVersion ?? 'academy-v1',
    status: overrides.status ?? 'active',
    completedAt: overrides.completedAt ?? null,
  };
}

// ----------------------------------------------------------- mission_attempts

export interface MissionAttemptFixture {
  readonly runId: string;
  readonly missionId: string;
  readonly attemptNumber: number;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly passed: boolean;
  readonly artifactBlobKey: string | null;
}

/**
 * `attemptNumber` defaults to 1 and must stay a positive integer — the
 * migration's `CHECK (attempt_number > 0)` and the `UNIQUE (run_id,
 * mission_id, attempt_number)` constraint both depend on it.
 */
export function createMissionAttempt(overrides: Partial<MissionAttemptFixture> = {}): MissionAttemptFixture {
  return {
    runId: overrides.runId ?? id(),
    missionId: overrides.missionId ?? 'named-place-navigation',
    attemptNumber: overrides.attemptNumber ?? 1,
    evidence: overrides.evidence ?? {
      route: ['ALPHA', 'BRAVO', 'CHARLIE'],
      elapsedMs: 42_000,
      evaluatorVersion: 'mission-eval-v1',
    },
    passed: overrides.passed ?? true,
    artifactBlobKey: overrides.artifactBlobKey ?? null,
  };
}

// -------------------------------------------------------------- reflections

export interface ReflectionFixture {
  readonly id: string;
  readonly runId: string;
  readonly promptId: string;
  readonly response: string;
  readonly rubric: Readonly<Record<string, unknown>> | null;
}

export function createReflection(overrides: Partial<ReflectionFixture> = {}): ReflectionFixture {
  return {
    id: overrides.id ?? id(),
    runId: overrides.runId ?? id(),
    promptId: overrides.promptId ?? 'why-this-place-v1',
    response: overrides.response ?? 'I put the market next to the harbour so goods reach it fast.',
    rubric: overrides.rubric ?? null,
  };
}

// -------------------------------------------------------------- publications

export interface PublicationFixture {
  readonly id: string;
  readonly worldId: string;
  readonly learnerId: string;
  readonly stablePath: string;
  readonly deployUrl: string | null;
  readonly status: PublicationStatus;
}

// Monotonic within a process so repeated calls without an explicit
// `stablePath` override still satisfy the migration's UNIQUE constraint.
let publicationSequence = 0;

export function createPublication(overrides: Partial<PublicationFixture> = {}): PublicationFixture {
  publicationSequence += 1;
  const worldId = overrides.worldId ?? id();
  return {
    id: overrides.id ?? id(),
    worldId,
    learnerId: overrides.learnerId ?? id(),
    stablePath: overrides.stablePath ?? `/w/fixture-${publicationSequence}-${worldId.slice(0, 8)}`,
    deployUrl: overrides.deployUrl ?? null,
    status: overrides.status ?? 'published',
  };
}
