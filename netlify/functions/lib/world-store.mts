import { getStore } from '@netlify/blobs';
import { getDatabase } from '@netlify/database';
import type { WorldProfile } from '../../../src/engine/world-profile.ts';

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
  create(profile: WorldProfile, learnerId: string): Promise<WorldRow>;
  find(id: string): Promise<WorldRow | null>;
}

export function createWorldRepository(
  db: Database = getDatabase(),
  artifacts: ArtifactStore = getStore('teaching-artifacts'),
): WorldRepository {
  return {
    async create(profile, learnerId) {
      const id = crypto.randomUUID();
      const artifactKey = `worlds/${id}/profile.json`;
      let storedArtifact: string | null = artifactKey;
      try {
        await artifacts.set(artifactKey, `${JSON.stringify(profile, null, 2)}\n`, {
          onlyIfNew: true,
          metadata: { kind: 'world-profile', worldId: id, immutable: true },
        });
      } catch (error) {
        storedArtifact = null;
        console.warn('[worlds] immutable Blob export unavailable; database publication continues', error);
      }

      await db.sql`
        INSERT INTO anonymous_learners (id, last_seen_at)
        VALUES (${learnerId}, NOW())
        ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
      `;
      const rows = await db.sql<{ id: string; profile: WorldProfile; created_at: Date | string }>`
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
      const row = rows[0];
      if (!row) throw new Error('database did not return the created world');
      return {
        id: row.id,
        profile: row.profile,
        createdAt: new Date(row.created_at).toISOString(),
      };
    },

    async find(id) {
      const rows = await db.sql<{ id: string; profile: WorldProfile; created_at: Date | string }>`
        SELECT id, profile, created_at FROM worlds WHERE id = ${id} LIMIT 1
      `;
      const row = rows[0];
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
