/**
 * The shot loader. CORE owns this file. WRITTEN ONCE ON DAY 0, NEVER EDITED.
 *
 * `import.meta.glob` with `eager: true` pulls in every `src/shots/*.ts` at build
 * time. A lane adds a shot by CREATING `src/shots/<lane>.ts` — nobody ever edits
 * a shared registry, so sixteen lanes can land shots in parallel with zero merge
 * surface. This one line is worth more to the project than any amount of merge
 * discipline.
 *
 * Shot files must be TRIVIALLY THIN: pose the camera, force state, return. No
 * module-level side effects beyond the `registerShot` call, no top-level throws,
 * no imports outside your own lane. A single shot file with a compile error
 * breaks the capture tool for ALL SIXTEEN LANES SIMULTANEOUSLY.
 */
const modules = import.meta.glob(['./*.ts', '!./index.ts'], { eager: true });

/** Number of shot modules loaded. Surfaced in the boot log as a sanity check. */
export const SHOT_MODULE_COUNT = Object.keys(modules).length;

export const SHOT_MODULE_NAMES: readonly string[] = Object.keys(modules)
  .map((p) => p.replace(/^\.\//, '').replace(/\.ts$/, ''))
  .sort();
