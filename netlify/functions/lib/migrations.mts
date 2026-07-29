/**
 * Migration observability.
 *
 * Netlify applies `netlify/database/migrations/*` immediately before publish, so
 * a deploy can succeed while the schema the code expects silently does not
 * exist — exactly the "publish succeeded but the migration didn't" failure the
 * runbook warns about. This module lets a deploy prove otherwise: it compares
 * the tables the code depends on against `information_schema` and reports which
 * are present, which are missing, and the latest migration the code was built
 * against.
 *
 * The expected set is maintained here by hand alongside each migration rather
 * than read from disk, because bundled Functions do not ship the SQL files.
 */

/** Tables the Functions depend on. Keep in step with the migrations. */
export const EXPECTED_TABLES = [
  'anonymous_learners',
  'worlds',
  'course_runs',
  'mission_attempts',
  'reflections',
  'publications',
] as const;

/** Latest migration this build was authored against (file stem, no extension). */
export const LATEST_MIGRATION = '20260729134500_teaching_platform';

export interface SchemaObservation {
  /** True only when every expected table exists. */
  ready: boolean;
  latestMigration: string;
  present: readonly string[];
  missing: readonly string[];
}

/** Minimal structural surface of the Netlify database client used here. */
export interface SchemaProbe {
  sql<Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]>;
}

/**
 * Observe applied schema by listing public tables and diffing against the set
 * the code requires. Reads no learner data — only `information_schema`.
 */
export async function observeSchema(db: SchemaProbe): Promise<SchemaObservation> {
  const rows = await db.sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `;
  const found = new Set(rows.map((row) => row.table_name));
  const present = EXPECTED_TABLES.filter((table) => found.has(table));
  const missing = EXPECTED_TABLES.filter((table) => !found.has(table));
  return { ready: missing.length === 0, latestMigration: LATEST_MIGRATION, present, missing };
}
