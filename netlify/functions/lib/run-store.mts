import { getStore } from '@netlify/blobs';
import { getDatabase } from '@netlify/database';

/**
 * Durable course-run persistence: runs, mission attempts (with idempotency,
 * ordering, evaluator version and evidence), and reflections.
 *
 * Design invariants:
 *  - Postgres is the source of truth. Netlify Blobs holds an immutable copy of
 *    each attempt's evidence; a Blob failure never fails the write.
 *  - Every mutation upserts the anonymous learner first so a run can be started
 *    before the learner has published a world.
 *  - Attempt submission is idempotent on (run_id, idempotency_key): a retried
 *    or duplicated submit returns the original attempt, never a second row.
 */

type Database = ReturnType<typeof getDatabase>;

interface ArtifactStore {
  set(
    key: string,
    value: string,
    options?: { metadata?: Record<string, unknown>; onlyIfNew?: boolean },
  ): Promise<unknown>;
}

export type RunStatus = 'active' | 'completed' | 'abandoned';
export type EvidenceStatus = 'inline' | 'stored' | 'skipped';
export type Evidence = Record<string, number | string | boolean>;

export interface RunRow {
  readonly id: string;
  readonly learnerId: string;
  readonly worldId: string | null;
  readonly courseVersion: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly lastActivityAt: string;
  /** True when start returned a pre-existing active run rather than creating one. */
  readonly resumed: boolean;
}

export interface AttemptRow {
  readonly id: string;
  readonly runId: string;
  readonly missionId: string;
  readonly attemptNumber: number;
  readonly idempotencyKey: string | null;
  readonly evaluatorVersion: string;
  readonly passed: boolean;
  readonly evidence: Evidence;
  readonly evidenceStatus: EvidenceStatus;
  readonly evidenceBytes: number;
  readonly evidenceSha256: string;
  readonly evidenceBlobKey: string | null;
  readonly createdAt: string;
  /** True when an idempotent replay returned the original attempt. */
  readonly replayed: boolean;
}

export interface ReflectionRow {
  readonly id: string;
  readonly runId: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly rubricVersion: string | null;
  readonly evaluatorVersion: string | null;
  readonly response: string;
  readonly rubric: unknown;
  readonly updatedAt: string;
}

export interface RunDetail extends RunRow {
  readonly attempts: readonly AttemptRow[];
  readonly reflections: readonly ReflectionRow[];
}

export interface StartRunInput {
  readonly learnerId: string;
  readonly courseVersion: string;
  readonly worldId?: string | null;
}

export interface AttemptInput {
  readonly runId: string;
  readonly missionId: string;
  readonly idempotencyKey: string;
  readonly evaluatorVersion: string;
  readonly passed: boolean;
  readonly evidence: Evidence;
}

export interface ReflectionInput {
  readonly runId: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly rubricVersion?: string | null;
  readonly evaluatorVersion?: string | null;
  readonly response: string;
  readonly rubric?: unknown;
}

export interface RunRepository {
  startRun(input: StartRunInput): Promise<RunRow>;
  getRun(id: string): Promise<RunDetail | null>;
  completeRun(id: string, learnerId: string): Promise<RunRow | null>;
  recordAttempt(input: AttemptInput): Promise<AttemptRow>;
  saveReflection(input: ReflectionInput): Promise<ReflectionRow>;
}

const PG_UNIQUE_VIOLATION = '23505';

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface AttemptDbRow {
  id: string;
  run_id: string;
  mission_id: string;
  attempt_number: number;
  idempotency_key: string | null;
  evaluator_version: string;
  passed: boolean;
  evidence: Evidence;
  evidence_status: EvidenceStatus;
  evidence_bytes: number | null;
  evidence_sha256: string | null;
  artifact_blob_key: string | null;
  created_at: Date | string;
}

function attemptRow(row: AttemptDbRow, replayed: boolean): AttemptRow {
  return {
    id: String(row.id),
    runId: row.run_id,
    missionId: row.mission_id,
    attemptNumber: row.attempt_number,
    idempotencyKey: row.idempotency_key,
    evaluatorVersion: row.evaluator_version,
    passed: row.passed,
    evidence: row.evidence,
    evidenceStatus: row.evidence_status,
    evidenceBytes: row.evidence_bytes ?? 0,
    evidenceSha256: row.evidence_sha256 ?? '',
    evidenceBlobKey: row.artifact_blob_key,
    createdAt: iso(row.created_at),
    replayed,
  };
}

export function createRunRepository(
  db: Database = getDatabase(),
  evidenceStore: ArtifactStore = getStore('teaching-evidence'),
): RunRepository {
  async function upsertLearner(learnerId: string): Promise<void> {
    await db.sql`
      INSERT INTO anonymous_learners (id, last_seen_at)
      VALUES (${learnerId}, NOW())
      ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
    `;
  }

  return {
    async startRun({ learnerId, courseVersion, worldId = null }) {
      await upsertLearner(learnerId);

      // Resume: return the learner's existing active run for this course, and
      // refresh its activity + optional world link. One statement, so a
      // double-tap across tabs cannot fork two active runs.
      const resumed = await db.sql<{
        id: string; learner_id: string; world_id: string | null; course_version: string;
        status: RunStatus; started_at: Date | string; completed_at: Date | string | null;
        last_activity_at: Date | string;
      }>`
        UPDATE course_runs
        SET last_activity_at = NOW(),
            world_id = COALESCE(${worldId}, world_id)
        WHERE learner_id = ${learnerId}
          AND course_version = ${courseVersion}
          AND status = 'active'
        RETURNING id, learner_id, world_id, course_version, status,
                  started_at, completed_at, last_activity_at
      `;
      if (resumed[0]) {
        const r = resumed[0];
        return {
          id: r.id, learnerId: r.learner_id, worldId: r.world_id, courseVersion: r.course_version,
          status: r.status, startedAt: iso(r.started_at),
          completedAt: r.completed_at ? iso(r.completed_at) : null,
          lastActivityAt: iso(r.last_activity_at), resumed: true,
        };
      }

      const id = crypto.randomUUID();
      const created = await db.sql<{
        id: string; learner_id: string; world_id: string | null; course_version: string;
        status: RunStatus; started_at: Date | string; completed_at: Date | string | null;
        last_activity_at: Date | string;
      }>`
        INSERT INTO course_runs (id, learner_id, world_id, course_version, status)
        VALUES (${id}, ${learnerId}, ${worldId}, ${courseVersion}, 'active')
        RETURNING id, learner_id, world_id, course_version, status,
                  started_at, completed_at, last_activity_at
      `;
      const r = created[0];
      if (!r) throw new Error('database did not return the created run');
      return {
        id: r.id, learnerId: r.learner_id, worldId: r.world_id, courseVersion: r.course_version,
        status: r.status, startedAt: iso(r.started_at),
        completedAt: r.completed_at ? iso(r.completed_at) : null,
        lastActivityAt: iso(r.last_activity_at), resumed: false,
      };
    },

    async getRun(id) {
      const runs = await db.sql<{
        id: string; learner_id: string; world_id: string | null; course_version: string;
        status: RunStatus; started_at: Date | string; completed_at: Date | string | null;
        last_activity_at: Date | string;
      }>`
        SELECT id, learner_id, world_id, course_version, status,
               started_at, completed_at, last_activity_at
        FROM course_runs WHERE id = ${id} LIMIT 1
      `;
      const run = runs[0];
      if (!run) return null;

      const attempts = await db.sql<AttemptDbRow>`
        SELECT id, run_id, mission_id, attempt_number, idempotency_key,
               evaluator_version, passed, evidence, evidence_status,
               evidence_bytes, evidence_sha256, artifact_blob_key, created_at
        FROM mission_attempts WHERE run_id = ${id}
        ORDER BY created_at ASC, attempt_number ASC
      `;
      const reflections = await db.sql<{
        id: string; run_id: string; prompt_id: string; prompt_version: string;
        rubric_version: string | null; evaluator_version: string | null;
        response: string; rubric: unknown; updated_at: Date | string;
      }>`
        SELECT id, run_id, prompt_id, prompt_version, rubric_version,
               evaluator_version, response, rubric, updated_at
        FROM reflections WHERE run_id = ${id} ORDER BY updated_at ASC
      `;

      return {
        id: run.id, learnerId: run.learner_id, worldId: run.world_id,
        courseVersion: run.course_version, status: run.status,
        startedAt: iso(run.started_at),
        completedAt: run.completed_at ? iso(run.completed_at) : null,
        lastActivityAt: iso(run.last_activity_at), resumed: false,
        attempts: attempts.map((a) => attemptRow(a, false)),
        reflections: reflections.map((r) => ({
          id: r.id, runId: r.run_id, promptId: r.prompt_id, promptVersion: r.prompt_version,
          rubricVersion: r.rubric_version, evaluatorVersion: r.evaluator_version,
          response: r.response, rubric: r.rubric, updatedAt: iso(r.updated_at),
        })),
      };
    },

    async completeRun(id, learnerId) {
      const rows = await db.sql<{
        id: string; learner_id: string; world_id: string | null; course_version: string;
        status: RunStatus; started_at: Date | string; completed_at: Date | string | null;
        last_activity_at: Date | string;
      }>`
        UPDATE course_runs
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW()),
            last_activity_at = NOW()
        WHERE id = ${id} AND learner_id = ${learnerId}
          AND status IN ('active', 'completed')
        RETURNING id, learner_id, world_id, course_version, status,
                  started_at, completed_at, last_activity_at
      `;
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, learnerId: r.learner_id, worldId: r.world_id, courseVersion: r.course_version,
        status: r.status, startedAt: iso(r.started_at),
        completedAt: r.completed_at ? iso(r.completed_at) : null,
        lastActivityAt: iso(r.last_activity_at), resumed: false,
      };
    },

    async recordAttempt({ runId, missionId, idempotencyKey, evaluatorVersion, passed, evidence }) {
      // Idempotent replay: a resubmit with the same key returns the original.
      const existing = await db.sql<AttemptDbRow>`
        SELECT id, run_id, mission_id, attempt_number, idempotency_key,
               evaluator_version, passed, evidence, evidence_status,
               evidence_bytes, evidence_sha256, artifact_blob_key, created_at
        FROM mission_attempts
        WHERE run_id = ${runId} AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `;
      if (existing[0]) return attemptRow(existing[0], true);

      const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
      const evidenceBytes = new TextEncoder().encode(serialized).byteLength;
      const evidenceSha256 = await sha256Hex(serialized);

      // Immutable evidence export. The idempotency key makes the Blob key
      // naturally write-once; a Blob outage degrades to 'skipped', it never
      // blocks the authoritative DB write.
      const blobKey = `runs/${runId}/attempts/${idempotencyKey}.json`;
      let evidenceStatus: EvidenceStatus = 'stored';
      let storedBlobKey: string | null = blobKey;
      try {
        await evidenceStore.set(blobKey, serialized, {
          onlyIfNew: true,
          metadata: {
            kind: 'mission-evidence',
            runId,
            missionId,
            evaluatorVersion,
            passed,
            sha256: evidenceSha256,
            immutable: true,
          },
        });
      } catch (error) {
        evidenceStatus = 'skipped';
        storedBlobKey = null;
        console.warn('[runs] immutable evidence Blob unavailable; DB attempt continues', error);
      }

      // attempt_number is server-assigned, contiguous per (run, mission). A rare
      // race between two distinct keys can collide on the ordering unique index;
      // recompute and retry a bounded number of times.
      for (let tries = 0; tries < 4; tries++) {
        try {
          const inserted = await db.sql<AttemptDbRow>`
            INSERT INTO mission_attempts (
              run_id, mission_id, attempt_number, idempotency_key,
              evaluator_version, passed, evidence,
              evidence_bytes, evidence_sha256, evidence_status, artifact_blob_key
            )
            VALUES (
              ${runId}, ${missionId},
              (SELECT COALESCE(MAX(attempt_number), 0) + 1
                 FROM mission_attempts
                WHERE run_id = ${runId} AND mission_id = ${missionId}),
              ${idempotencyKey}, ${evaluatorVersion}, ${passed},
              ${JSON.stringify(evidence)}::jsonb,
              ${evidenceBytes}, ${evidenceSha256}, ${evidenceStatus}, ${storedBlobKey}
            )
            ON CONFLICT DO NOTHING
            RETURNING id, run_id, mission_id, attempt_number, idempotency_key,
                      evaluator_version, passed, evidence, evidence_status,
                      evidence_bytes, evidence_sha256, artifact_blob_key, created_at
          `;
          if (inserted[0]) {
            // Keep the run visibly progressing without a second round-trip.
            await db.sql`UPDATE course_runs SET last_activity_at = NOW() WHERE id = ${runId}`;
            return attemptRow(inserted[0], false);
          }
          // No row inserted: a concurrent request won the idempotency race.
          const raced = await db.sql<AttemptDbRow>`
            SELECT id, run_id, mission_id, attempt_number, idempotency_key,
                   evaluator_version, passed, evidence, evidence_status,
                   evidence_bytes, evidence_sha256, artifact_blob_key, created_at
            FROM mission_attempts
            WHERE run_id = ${runId} AND idempotency_key = ${idempotencyKey}
            LIMIT 1
          `;
          if (raced[0]) return attemptRow(raced[0], true);
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code === PG_UNIQUE_VIOLATION && tries < 3) continue; // ordering race — recompute
          throw error;
        }
      }
      throw new Error('could not assign a stable attempt number after retries');
    },

    async saveReflection({ runId, promptId, promptVersion, rubricVersion = null, evaluatorVersion = null, response, rubric = null }) {
      const id = crypto.randomUUID();
      const rows = await db.sql<{
        id: string; run_id: string; prompt_id: string; prompt_version: string;
        rubric_version: string | null; evaluator_version: string | null;
        response: string; rubric: unknown; updated_at: Date | string;
      }>`
        INSERT INTO reflections (
          id, run_id, prompt_id, prompt_version, rubric_version,
          evaluator_version, response, rubric, updated_at
        )
        VALUES (
          ${id}, ${runId}, ${promptId}, ${promptVersion}, ${rubricVersion},
          ${evaluatorVersion}, ${response},
          ${rubric === null ? null : JSON.stringify(rubric)}::jsonb, NOW()
        )
        ON CONFLICT (run_id, prompt_id) DO UPDATE SET
          prompt_version = EXCLUDED.prompt_version,
          rubric_version = EXCLUDED.rubric_version,
          evaluator_version = EXCLUDED.evaluator_version,
          response = EXCLUDED.response,
          rubric = EXCLUDED.rubric,
          updated_at = NOW()
        RETURNING id, run_id, prompt_id, prompt_version, rubric_version,
                  evaluator_version, response, rubric, updated_at
      `;
      const r = rows[0];
      if (!r) throw new Error('database did not return the saved reflection');
      await db.sql`UPDATE course_runs SET last_activity_at = NOW() WHERE id = ${runId}`;
      return {
        id: r.id, runId: r.run_id, promptId: r.prompt_id, promptVersion: r.prompt_version,
        rubricVersion: r.rubric_version, evaluatorVersion: r.evaluator_version,
        response: r.response, rubric: r.rubric, updatedAt: iso(r.updated_at),
      };
    },
  };
}
