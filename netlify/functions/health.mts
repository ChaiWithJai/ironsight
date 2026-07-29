import type { Config, Context } from '@netlify/functions';
import { getDatabase } from '@netlify/database';
import { createLogger, requestIdFrom } from './lib/log.mts';
import { observeSchema, type SchemaProbe } from './lib/migrations.mts';

/**
 * GET /api/health — liveness + migration observability.
 *
 * Returns 200 when the database is reachable and every expected table exists,
 * 503 otherwise. The body carries the schema observation (present/missing
 * tables and the latest migration) and the request id, and never exposes any
 * learner data. Emits one structured line per check so a deploy can be verified
 * from the Netlify function log alone, and escalates to `migration.degraded`
 * when the schema is incomplete.
 */
export function createHealthHandler(db: SchemaProbe = getDatabase() as unknown as SchemaProbe) {
  return async (request: Request): Promise<Response> => {
    const requestId = requestIdFrom(request);
    const log = createLogger({ requestId, service: 'health' });
    const startedAt = Date.now();
    try {
      const schema = await observeSchema(db);
      const durationMs = Date.now() - startedAt;
      log.info('health.check', {
        ready: schema.ready,
        latestMigration: schema.latestMigration,
        missing: schema.missing,
        durationMs,
      });
      if (!schema.ready) {
        log.error('migration.degraded', {
          latestMigration: schema.latestMigration,
          missing: schema.missing,
        });
      }
      return Response.json(
        { status: schema.ready ? 'ok' : 'degraded', schema, requestId },
        {
          status: schema.ready ? 200 : 503,
          headers: { 'cache-control': 'no-store', 'x-request-id': requestId },
        },
      );
    } catch (error) {
      log.error('health.unavailable', { error, durationMs: Date.now() - startedAt });
      return Response.json(
        { status: 'unavailable', requestId },
        { status: 503, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
      );
    }
  };
}

export default async (request: Request, _context: Context): Promise<Response> =>
  createHealthHandler()(request);

export const config: Config = {
  path: '/api/health',
  method: ['GET'],
};
