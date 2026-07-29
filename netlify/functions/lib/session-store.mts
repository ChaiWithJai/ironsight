import { getDatabase } from '@netlify/database';

type Database = ReturnType<typeof getDatabase>;

export interface LearnerRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly consentVersion: string | null;
  readonly hasRecovery: boolean;
}

export interface MergeCounts {
  readonly worlds: number;
  readonly runs: number;
  readonly publications: number;
}

export interface SessionRepository {
  /** Reads a learner by id, or null if it does not exist (e.g. purged). */
  find(id: string): Promise<LearnerRecord | null>;
  /** Creates a fresh anonymous learner, recording the consent it affirmed. */
  create(consentVersion: string): Promise<LearnerRecord>;
  /** Refreshes last_seen_at; records consent only if not already present. */
  touch(id: string, consentVersion?: string): Promise<LearnerRecord | null>;
  /** Stores the hash of a learner-held recovery secret (replacing any prior). */
  setRecoveryHash(id: string, recoveryHash: string): Promise<void>;
  /** Finds the learner a recovery hash maps to, or null. */
  findByRecoveryHash(recoveryHash: string): Promise<LearnerRecord | null>;
  /**
   * Reassigns every record owned by `orphanId` to `canonicalId`, writes a
   * non-identifying merge audit, and deletes the orphan learner row. Ordered so
   * foreign keys hold at every step and safe to re-run if interrupted.
   */
  merge(canonicalId: string, orphanId: string): Promise<MergeCounts>;
}

function toRecord(row: {
  id: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  consent_version: string | null;
  recovery_hash: string | null;
}): LearnerRecord {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    consentVersion: row.consent_version,
    hasRecovery: row.recovery_hash != null,
  };
}

type LearnerRow = {
  id: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  consent_version: string | null;
  recovery_hash: string | null;
};

export function createSessionRepository(db: Database = getDatabase()): SessionRepository {
  return {
    async find(id) {
      const rows = await db.sql<LearnerRow>`
        SELECT id, created_at, last_seen_at, consent_version, recovery_hash
        FROM anonymous_learners WHERE id = ${id} LIMIT 1
      `;
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async create(consentVersion) {
      const id = crypto.randomUUID();
      const rows = await db.sql<LearnerRow>`
        INSERT INTO anonymous_learners (id, created_at, last_seen_at, consent_version, consent_at)
        VALUES (${id}, NOW(), NOW(), ${consentVersion}, NOW())
        RETURNING id, created_at, last_seen_at, consent_version, recovery_hash
      `;
      const row = rows[0];
      if (!row) throw new Error('database did not return the created learner');
      return toRecord(row);
    },

    async touch(id, consentVersion) {
      const consent = consentVersion ?? null;
      const rows = await db.sql<LearnerRow>`
        UPDATE anonymous_learners
        SET last_seen_at = NOW(),
            consent_version = COALESCE(consent_version, ${consent}::text),
            consent_at = CASE WHEN consent_at IS NULL AND ${consent}::text IS NOT NULL
                              THEN NOW() ELSE consent_at END
        WHERE id = ${id}
        RETURNING id, created_at, last_seen_at, consent_version, recovery_hash
      `;
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async setRecoveryHash(id, recoveryHash) {
      await db.sql`
        UPDATE anonymous_learners
        SET recovery_hash = ${recoveryHash}, recovery_set_at = NOW()
        WHERE id = ${id}
      `;
    },

    async findByRecoveryHash(recoveryHash) {
      const rows = await db.sql<LearnerRow>`
        SELECT id, created_at, last_seen_at, consent_version, recovery_hash
        FROM anonymous_learners WHERE recovery_hash = ${recoveryHash} LIMIT 1
      `;
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async merge(canonicalId, orphanId) {
      // Reassign owned records first so the orphan's outgoing foreign keys are
      // gone before we delete it. Each statement is idempotent: a retry after a
      // partial failure simply reassigns whatever is still pointing at orphan.
      const worlds = await db.sql<{ id: string }>`
        UPDATE worlds SET creator_id = ${canonicalId}
        WHERE creator_id = ${orphanId} RETURNING id
      `;
      const runs = await db.sql<{ id: string }>`
        UPDATE course_runs SET learner_id = ${canonicalId}
        WHERE learner_id = ${orphanId} RETURNING id
      `;
      const publications = await db.sql<{ id: string }>`
        UPDATE publications SET learner_id = ${canonicalId}
        WHERE learner_id = ${orphanId} RETURNING id
      `;
      const counts: MergeCounts = {
        worlds: worlds.length,
        runs: runs.length,
        publications: publications.length,
      };
      await db.sql`
        INSERT INTO identity_merges (canonical_id, merged_worlds, merged_runs, merged_publications)
        VALUES (${canonicalId}, ${counts.worlds}, ${counts.runs}, ${counts.publications})
      `;
      await db.sql`DELETE FROM anonymous_learners WHERE id = ${orphanId}`;
      return counts;
    },
  };
}
