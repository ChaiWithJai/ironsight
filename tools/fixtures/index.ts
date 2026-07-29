/**
 * Barrel for every shared test fixture / factory in this directory. Import
 * from here (`../fixtures/index.ts` or `../../tools/fixtures/index.ts`)
 * rather than the individual files, so adding a new fixture module only
 * means adding one export line, not updating every consumer's import list.
 *
 * See docs/OWNERSHIP.md and issue #3 ("Add fixtures and test-data factories
 * shared by unit, local integration, Deploy Preview, and staging smoke") for
 * why this exists and who is expected to reach for it.
 */
export * from './world-profile.ts';
export * from './course-run.ts';
