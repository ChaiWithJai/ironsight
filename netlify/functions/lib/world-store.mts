import { getStore } from '@netlify/blobs';
import { getDatabase } from '@netlify/database';
import type { WorldProfile } from '../../../src/engine/world-profile.ts';

export type WorldStatus = 'published' | 'withdrawn';

export interface WorldRow {
  readonly id: string;
  readonly profile: WorldProfile;
  readonly createdAt: string;
  readonly status: WorldStatus;
  /** Set when this world was published as a revision of an earlier one. */
  readonly supersedesId: string | null;
}

/** The shape a learner sees when listing their own portfolio. */
export interface WorldSummary {
  readonly id: string;
  readonly civilization: string;
  readonly sigil: string;
  readonly era: string;
  readonly status: WorldStatus;
  readonly supersedesId: string | null;
  readonly createdAt: string;
  readonly withdrawnAt: string | null;
}

export interface DisposalRequest {
  /** When present, only these ids are considered — every one must be disposable. */
  readonly ids?: readonly string[];
  /** Only sweep disposable rows at least this many hours old. */
  readonly olderThanHours?: number;
  /** Report what would be removed without deleting anything. */
  readonly dryRun?: boolean;
}

export interface DisposalResult {
  readonly dryRun: boolean;
  readonly disposed: readonly string[];
}

interface ArtifactStore {
  set(
    key: string,
    value: string,
    options?: { metadata?: Record<string, unknown>; onlyIfNew?: boolean },
  ): Promise<unknown>;
}

type Database = ReturnType<typeof getDatabase>;

export interface WorldRepository {
  create(
    profile: WorldProfile,
    learnerId: string,
    options?: { disposable?: boolean },
  ): Promise<WorldRow>;
  /** Publish an immutable revision of a world the learner owns. Null if not owned. */
  revise(
    predecessorId: string,
    profile: WorldProfile,
    learnerId: string,
    options?: { disposable?: boolean },
  ): Promise<WorldRow | null>;
  find(id: string): Promise<WorldRow | null>;
  listByCreator(learnerId: string): Promise<WorldSummary[]>;
  /** Withdraw a world the learner owns. 'not_found' covers wrong-owner and missing. */
  withdraw(
    id: string,
    learnerId: string,
    reason?: string,
  ): Promise<{ outcome: 'withdrawn' | 'already' | 'not_found'; row?: WorldRow }>;
  /** Maintenance-only: hard-delete rows flagged disposable, with an audit trail. */
  disposeDisposable(request: DisposalRequest): Promise<DisposalResult>;
}

type RawWorld = {
  id: string;
  profile: WorldProfile;
  created_at: Date | string;
  status: WorldStatus;
  supersedes_id: string | null;
};

function toRow(raw: RawWorld): WorldRow {
  return {
    id: raw.id,
    profile: raw.profile,
    createdAt: new Date(raw.created_at).toISOString(),
    status: raw.status,
    supersedesId: raw.supersedes_id,
  };
}

export function createWorldRepository(
  db: Database = getDatabase(),
  artifacts: ArtifactStore = getStore('teaching-artifacts'),
): WorldRepository {
  // The immutable Blob export is best-effort: a Blob failure must not sink a
  // durable Database publication (the audit still records the missing artifact).
  async function exportArtifact(id: string, profile: WorldProfile): Promise<string | null> {
    const artifactKey = `worlds/${id}/profile.json`;
    try {
      await artifacts.set(artifactKey, `${JSON.stringify(profile, null, 2)}\n`, {
        onlyIfNew: true,
        metadata: { kind: 'world-profile', worldId: id, immutable: true },
      });
      return artifactKey;
    } catch (error) {
      console.warn('[worlds] immutable Blob export unavailable; database publication continues', error);
      return null;
    }
  }

  async function recordEvent(event: {
    worldId: string;
    actorId: string | null;
    actorKind: 'learner' | 'maintenance';
    action: 'published' | 'revised' | 'withdrawn' | 'disposed';
    reason?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await db.sql`
      INSERT INTO world_events (world_id, actor_id, actor_kind, action, reason, detail)
      VALUES (
        ${event.worldId}, ${event.actorId}, ${event.actorKind}, ${event.action},
        ${event.reason ?? null}, ${JSON.stringify(event.detail ?? {})}::jsonb
      )
    `;
  }

  async function insertWorld(
    profile: WorldProfile,
    learnerId: string,
    options: { disposable: boolean; supersedesId: string | null },
  ): Promise<WorldRow> {
    const id = crypto.randomUUID();
    const artifactKey = await exportArtifact(id, profile);

    await db.sql`
      INSERT INTO anonymous_learners (id, last_seen_at)
      VALUES (${learnerId}, NOW())
      ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
    `;
    const rows = await db.sql<RawWorld>`
      INSERT INTO worlds (
        id, creator_id, profile, civilization, sigil, era,
        alpha_name, bravo_name, charlie_name, artifact_blob_key,
        supersedes_id, disposable
      )
      VALUES (
        ${id}, ${learnerId}, ${JSON.stringify(profile)}::jsonb,
        ${profile.civilization}, ${profile.sigil}, ${profile.era},
        ${profile.places.ALPHA}, ${profile.places.BRAVO}, ${profile.places.CHARLIE},
        ${artifactKey}, ${options.supersedesId}, ${options.disposable}
      )
      RETURNING id, profile, created_at, status, supersedes_id
    `;
    const row = rows[0];
    if (!row) throw new Error('database did not return the created world');

    await recordEvent({
      worldId: row.id,
      actorId: learnerId,
      actorKind: 'learner',
      action: options.supersedesId ? 'revised' : 'published',
      detail: {
        artifactExported: artifactKey !== null,
        disposable: options.disposable,
        ...(options.supersedesId ? { supersedes: options.supersedesId } : {}),
      },
    });
    return toRow(row);
  }

  return {
    async create(profile, learnerId, options) {
      return insertWorld(profile, learnerId, {
        disposable: options?.disposable ?? false,
        supersedesId: null,
      });
    },

    async revise(predecessorId, profile, learnerId, options) {
      const owned = await db.sql<{ id: string }>`
        SELECT id FROM worlds WHERE id = ${predecessorId} AND creator_id = ${learnerId} LIMIT 1
      `;
      if (!owned[0]) return null;
      return insertWorld(profile, learnerId, {
        disposable: options?.disposable ?? false,
        supersedesId: predecessorId,
      });
    },

    async find(id) {
      const rows = await db.sql<RawWorld>`
        SELECT id, profile, created_at, status, supersedes_id FROM worlds WHERE id = ${id} LIMIT 1
      `;
      return rows[0] ? toRow(rows[0]) : null;
    },

    async listByCreator(learnerId) {
      const rows = await db.sql<{
        id: string;
        civilization: string;
        sigil: string;
        era: string;
        status: WorldStatus;
        supersedes_id: string | null;
        created_at: Date | string;
        withdrawn_at: Date | string | null;
      }>`
        SELECT id, civilization, sigil, era, status, supersedes_id, created_at, withdrawn_at
        FROM worlds
        WHERE creator_id = ${learnerId}
        ORDER BY created_at DESC
      `;
      return rows.map((row) => ({
        id: row.id,
        civilization: row.civilization,
        sigil: row.sigil,
        era: row.era,
        status: row.status,
        supersedesId: row.supersedes_id,
        createdAt: new Date(row.created_at).toISOString(),
        withdrawnAt: row.withdrawn_at ? new Date(row.withdrawn_at).toISOString() : null,
      }));
    },

    async withdraw(id, learnerId, reason) {
      // Scope the write to the owner so a wrong learner can never withdraw another's
      // world; the follow-up SELECT tells a real no-op apart from a wrong owner.
      const updated = await db.sql<RawWorld>`
        UPDATE worlds
        SET status = 'withdrawn', withdrawn_at = NOW()
        WHERE id = ${id} AND creator_id = ${learnerId} AND status = 'published'
        RETURNING id, profile, created_at, status, supersedes_id
      `;
      if (updated[0]) {
        await recordEvent({
          worldId: id,
          actorId: learnerId,
          actorKind: 'learner',
          action: 'withdrawn',
          reason: reason ?? null,
        });
        return { outcome: 'withdrawn', row: toRow(updated[0]) };
      }
      const existing = await db.sql<{ status: WorldStatus }>`
        SELECT status FROM worlds WHERE id = ${id} AND creator_id = ${learnerId} LIMIT 1
      `;
      return existing[0] ? { outcome: 'already' } : { outcome: 'not_found' };
    },

    async disposeDisposable(request) {
      const dryRun = request.dryRun ?? false;
      const ids = request.ids && request.ids.length > 0 ? [...request.ids] : null;
      const olderThanHours = request.olderThanHours ?? 0;

      // The predicate NEVER omits `disposable = true`: even an explicit id list can
      // only remove rows a publisher flagged disposable, so this endpoint can never
      // become a broad delete surface even if the token leaks.
      const candidates = await db.sql<{
        id: string;
        civilization: string;
        created_at: Date | string;
      }>`
        SELECT id, civilization, created_at
        FROM worlds
        WHERE disposable = TRUE
          AND created_at <= NOW() - (${olderThanHours}::double precision * INTERVAL '1 hour')
          AND (${ids}::uuid[] IS NULL OR id = ANY(${ids}::uuid[]))
        ORDER BY created_at ASC
      `;
      const disposed = candidates.map((row) => row.id);
      if (dryRun || disposed.length === 0) return { dryRun, disposed };

      for (const row of candidates) {
        // Snapshot into the audit log BEFORE deleting, since world_events is not
        // foreign-keyed and must outlive the row it describes.
        await recordEvent({
          worldId: row.id,
          actorId: null,
          actorKind: 'maintenance',
          action: 'disposed',
          reason: 'canary/test disposal',
          detail: {
            civilization: row.civilization,
            createdAt: new Date(row.created_at).toISOString(),
          },
        });
      }
      // Course runs may reference a world without cascade; detach then hard-delete.
      await db.sql`UPDATE course_runs SET world_id = NULL WHERE world_id = ANY(${disposed}::uuid[])`;
      await db.sql`DELETE FROM publications WHERE world_id = ANY(${disposed}::uuid[])`;
      await db.sql`DELETE FROM worlds WHERE id = ANY(${disposed}::uuid[]) AND disposable = TRUE`;
      return { dryRun, disposed };
    },
  };
}
