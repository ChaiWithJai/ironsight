import { getStore } from '@netlify/blobs';
import { getDatabase } from '@netlify/database';
import type { WorldProfile } from '../../../src/engine/world-profile.ts';
import { timeAsync, type StoreTiming } from './metrics.mts';

export interface WorldRow {
  readonly id: string;
  readonly profile: WorldProfile;
  readonly createdAt: string;
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
  // `timing` is an optional out-parameter the caller (worlds.mts) owns and
  // logs after the request completes. It carries only durations and a
  // success/failure flag — never query text, bindings, or blob contents.
  create(profile: WorldProfile, learnerId: string, timing?: StoreTiming): Promise<WorldRow>;
  find(id: string, timing?: StoreTiming): Promise<WorldRow | null>;
}

export function createWorldRepository(
  db: Database = getDatabase(),
  artifacts: ArtifactStore = getStore('teaching-artifacts'),
): WorldRepository {
  return {
    async create(profile, learnerId, timing) {
      const id = crypto.randomUUID();
      const artifactKey = `worlds/${id}/profile.json`;
      let storedArtifact: string | null = artifactKey;
      if (timing) timing.blobAttempted = true;
      const blobTimed = await timeAsync(async () => {
        try {
          await artifacts.set(artifactKey, `${JSON.stringify(profile, null, 2)}\n`, {
            onlyIfNew: true,
            metadata: { kind: 'world-profile', worldId: id, immutable: true },
          });
          return true;
        } catch (error) {
          storedArtifact = null;
          console.warn('[worlds] immutable Blob export unavailable; database publication continues', error);
          return false;
        }
      });
      if (timing) {
        timing.blobMs = blobTimed.ms;
        timing.blobFailed = !blobTimed.value;
      }

      const dbTimed = await timeAsync(async () => {
        await db.sql`
          INSERT INTO anonymous_learners (id, last_seen_at)
          VALUES (${learnerId}, NOW())
          ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
        `;
        return db.sql<{ id: string; profile: WorldProfile; created_at: Date | string }>`
          INSERT INTO worlds (
            id, creator_id, profile, civilization, sigil, era,
            alpha_name, bravo_name, charlie_name, artifact_blob_key
          )
          VALUES (
            ${id}, ${learnerId}, ${JSON.stringify(profile)}::jsonb,
            ${profile.civilization}, ${profile.sigil}, ${profile.era},
            ${profile.places.ALPHA}, ${profile.places.BRAVO}, ${profile.places.CHARLIE},
            ${storedArtifact}
          )
          RETURNING id, profile, created_at
        `;
      });
      if (timing) timing.dbMs = dbTimed.ms;
      const row = dbTimed.value[0];
      if (!row) throw new Error('database did not return the created world');
      return {
        id: row.id,
        profile: row.profile,
        createdAt: new Date(row.created_at).toISOString(),
      };
    },

    async find(id, timing) {
      const dbTimed = await timeAsync(async () =>
        db.sql<{ id: string; profile: WorldProfile; created_at: Date | string }>`
          SELECT id, profile, created_at FROM worlds WHERE id = ${id} LIMIT 1
        `,
      );
      if (timing) timing.dbMs = dbTimed.ms;
      const row = dbTimed.value[0];
      return row
        ? {
            id: row.id,
            profile: row.profile,
            createdAt: new Date(row.created_at).toISOString(),
          }
        : null;
    },
  };
}
