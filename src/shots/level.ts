/**
 * LEVEL's shot file. Owned by LEVEL and by nobody else.
 *
 * MUST PROVE: ALPHA / BRAVO / CHARLIE establishing shots, ground transitions, no hard seams.
 *
 * Empty on purpose until LEVEL lands. Registering a shot that renders nothing
 * would put a black PNG in the review packet and cost a critic a round trip, so
 * this file stays a valid empty module until there is something to look at.
 *
 * To add yours, call `registerShot` from `@/engine/harness`:
 *
 *   import { registerShot } from '@/engine/harness';
 *   registerShot({
 *     name: 'level',
 *     description: 'one line saying what this shot proves',
 *     frames: 32,
 *     setup(ctx) {
 *       ctx.setTimeOfDay(17.4);
 *       ctx.setOverlays({ viewmodel: false, hud: false });
 *       ctx.poseCamera([x, y, z], [tx, ty, tz], 45);
 *     },
 *   });
 *
 * Keep it thin: pose, force state, return. No module-level side effects, no
 * top-level throws, no imports outside your lane — a compile error here breaks
 * the capture tool for all sixteen lanes at once.
 *
 * Camera poses are LITERAL COORDINATES here. `ShotContext` exposes only
 * `setTimeOfDay`/`setWeather`/`poseCamera`/`setOverlays`/`setPlayerState`/`seed` —
 * there is no route from a shot file to a service, and importing `@/level/**` to
 * reach `LevelService.cameraPose` breaks boundary CI. `MACRO_TERRAIN` from
 * `@/engine/macro` is on the shared-import list if you need ground height.
 */
export {};
