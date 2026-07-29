import { getStore } from '@netlify/blobs';
import { getDatabase } from '@netlify/database';
import type { WorldProfile } from '../../../src/engine/world-profile.ts';
import { pseudonym, silentLogger, type Logger } from './log.mts';

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
  create(profile: WorldProfile, learnerId: string, log?: Logger): Promise<WorldRow>;
  find(id: string, log?: Logger): Promise<WorldRow | null>;
}

export function createWorldRepository(
  db: Database = getDatabase(),
  artifacts: ArtifactStore = getStore('teaching-artifacts'),
): WorldRepository {
  return {
    async create(profile, learnerId, log = silentLogger()) {
      const learner = pseudonym(learnerId);
      const id = crypto.randomUUID();
      const artifactKey = `worlds/${id}/profile.json`;
      let storedArtifact: string | null = artifactKey;
      try {
        await log.time(
          'blob.export',
          () =>
            artifacts.set(artifactKey, `${JSON.stringify(profile, null, 2)}\n`, {
              onlyIfNew: true,
              metadata: { kind: 'world-profile', worldId: id, immutable: true },
            }),
          { worldId: id },
        );
      } catch (error) {
        storedArtifact = null;
        log.warn('blob.export_unavailable', { worldId: id, error });
      }

      await log.time(
        'db.upsert_learner',
        () => db.sql`
          INSERT INTO anonymous_learners (id, last_seen_at)
          VALUES (${learnerId}, NOW())
          ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
        `,
        { learner },
      );
      const rows = await log.time(
        'db.insert_world',
        () => db.sql<{ id: string; profile: WorldProfile; created_at: Date | string }>`
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
        `,
        { worldId: id, learner, blobExported: storedArtifact !== null },
      );
      const row = rows[0];
      if (!row) throw new Error('database did not return the created world');
      return {
        id: row.id,
        profile: row.profile,
        createdAt: new Date(row.created_at).toISOString(),
      };
    },

    async find(id, log = silentLogger()) {
      const rows = await log.time(
        'db.find_world',
        () => db.sql<{ id: string; profile: WorldProfile; created_at: Date | string }>`
          SELECT id, profile, created_at FROM worlds WHERE id = ${id} LIMIT 1
        `,
        { worldId: id },
      );
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
