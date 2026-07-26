#!/usr/bin/env node
/**
 * Boundary CI. Owned by CORE. Declared by docs/OWNERSHIP.md, enforced here.
 *
 * A dozen agents work in parallel on this repo against a shared contract. Every
 * rule below exists because breaking it silently produces a failure that is
 * expensive to diagnose later:
 *
 *  - cross-lane imports turn "replace one stub" into a merge conflict, and make
 *    the boot-order topological sort a lie
 *  - Math.random() destroys shot reproducibility, which is the foundation the
 *    entire visual critic loop stands on
 *  - ad-hoc THREE materials bypass the material factory, so they miss the shared
 *    detail-normal / wear / fog / motion-vector injection and look subtly wrong
 *  - onBeforeCompile outside the factory produces uncontrolled shader
 *    permutations and unpredictable compile hitches
 *  - setRenderTarget outside the render lane fights the render graph's resource
 *    lifetimes and silently corrupts a later pass's input
 *  - wall-clock reads make the fixed-timestep sim non-deterministic
 *
 * Usage:  npm run boundaries
 *         node tools/check-boundaries.mjs --json
 *
 * Exit code 1 on any violation, so it can gate `npm run verify`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SRC = join(ROOT, 'src');
const JSON_OUT = process.argv.includes('--json');

/**
 * Lane directories. An import that crosses from one lane into another is a
 * violation; everything may import from the shared seams listed in SHARED.
 */
const LANES = [
  'engine', 'bootstrap', 'render', 'world', 'game', 'physics', 'audio', 'ui', 'shots', 'gfx',
];
/**
 * Importable by anyone. These are the deliberate shared seams: the contract
 * layer, the locked harness, pure math/RNG utilities, the world-scale constants
 * both terrain and water must agree on, and the null-service fallbacks every
 * lane degrades to. Adding to this list widens what a dozen agents can couple
 * to, so it stays short and every entry is justified.
 */
const SHARED = [
  'engine/types',
  'engine/harness',
  'engine/math',
  'engine/rng',
  'engine/units',
  'engine/clock',
  'engine/macro',
  // Shared ECS component declarations (Health, Transform, …). These are data
  // definitions every gameplay lane reads and writes through the ComponentStore;
  // routing them via a service would be indirection for its own sake.
  'engine/components',
  'bootstrap/nulls',
  // engine.ts reads the descriptor table to drive the boot topological sort.
  // Mildly inverted — the core knowing the concrete table — but the table names
  // only contract interfaces, so no lane implementation leaks through it.
  'bootstrap/subsystems',
];

/**
 * The composition root. `bootstrap/` exists precisely to name every lane's
 * factory in one place, so the cross-lane rule cannot apply to it — that is its
 * whole job. Nothing else may import a lane's implementation.
 */
const COMPOSITION_ROOT = 'bootstrap';

const RULES = [
  {
    id: 'no-math-random',
    // Deterministic capture is non-negotiable: every shot must be bit-identical
    // across runs, so all randomness flows through the seeded RNG streams.
    test: /\bMath\s*\.\s*random\s*\(/,
    allow: () => false,
    message: 'Math.random() breaks shot determinism — take a stream from ctx.rng instead.',
  },
  {
    id: 'no-adhoc-material',
    test: /\bnew\s+THREE\s*\.\s*Mesh[A-Za-z]*Material\b/,
    allow: (f) => f.startsWith(`render${sep}material${sep}`) || f === `render${sep}material.ts`,
    message: 'Construct materials through the MaterialFactory so they inherit detail/wear/fog/velocity injection.',
  },
  {
    id: 'no-adhoc-shader-material',
    // The doctrine and the enforcement have to agree. `MaterialFactory` is
    // declared THE single place a THREE.Material is created, but the old grep
    // only matched `Mesh*Material` — so a lane could ship a RawShaderMaterial,
    // pass CI, and quietly own an unlit surface outside the uber material with
    // no CSM, no clustered lights, no GTAO and no motion vectors. Unlit UI,
    // gizmos and the sky dome go through `MaterialFactory.createUnlit`.
    test: /\bnew\s+THREE\s*\.\s*(Raw)?ShaderMaterial\b/,
    allow: (f) => f.startsWith(`render${sep}`),
    message: 'Unlit/raw shaders go through MaterialFactory.createUnlit — see types.ts SECTION 10.',
  },
  {
    id: 'no-adhoc-onbeforecompile',
    test: /\bonBeforeCompile\b/,
    allow: (f) => f.startsWith(`render${sep}material${sep}`) || f === `render${sep}material.ts`,
    message: 'onBeforeCompile outside the material factory creates uncontrolled shader permutations.',
  },
  {
    id: 'no-adhoc-render-target',
    test: /\.\s*setRenderTarget\s*\(/,
    allow: (f) => f.startsWith(`render${sep}`) || f.startsWith(`engine${sep}`),
    message: 'Only the render lane may bind render targets — the graph owns resource lifetimes.',
  },
  {
    id: 'no-wall-clock',
    test: /\b(performance\s*\.\s*now|Date\s*\.\s*now)\s*\(/,
    allow: (f) =>
      f === `engine${sep}clock.ts` || f === `engine${sep}profiler.ts` || f === `engine${sep}debug.ts`,
    message: 'Wall-clock reads make the fixed-timestep sim non-deterministic — use ctx.time / ctx.tick.',
  },
  {
    id: 'no-runtime-network',
    test: /\b(fetch\s*\(|XMLHttpRequest|new\s+WebSocket|importScripts\s*\()/,
    allow: () => false,
    message: 'The build must make zero network requests — everything is generated procedurally.',
  },
  {
    id: 'no-binary-asset-import',
    test: /from\s+['"][^'"]+\.(png|jpe?g|hdr|exr|glb|gltf|fbx|mp3|ogg|wav|ktx2?|bin)['"]/,
    allow: () => false,
    message: 'Zero binary art assets — generate it in code.',
  },
  {
    id: 'no-reference-import',
    // Belt and braces: the reference corpus is a critique aid and must never be
    // reachable from the bundle.
    test: /['"][^'"]*reference\/(battlefield|gameplay)/,
    allow: () => false,
    message: 'reference/ is local critique material and must never be imported by src/.',
  },
];

/** Lines that are pure comment or inside a block comment are exempt. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const laneOf = (rel) => {
  const top = rel.split(sep)[0];
  return LANES.includes(top) ? top : null;
};

const violations = [];
const files = await walk(SRC);

for (const abs of files) {
  const rel = relative(SRC, abs);
  const raw = await readFile(abs, 'utf8');
  const code = stripComments(raw);
  const lines = code.split('\n');
  const rawLines = raw.split('\n');

  for (const rule of RULES) {
    if (rule.allow(rel)) continue;
    lines.forEach((line, i) => {
      if (rule.test.test(line)) {
        violations.push({
          rule: rule.id,
          file: `src/${rel}`,
          line: i + 1,
          text: rawLines[i]?.trim().slice(0, 120) ?? '',
          message: rule.message,
        });
      }
    });
  }

  // ---- cross-lane imports -------------------------------------------------
  const mine = laneOf(rel);
  if (!mine || mine === COMPOSITION_ROOT) continue;
  for (const m of code.matchAll(/(?:from|import)\s+['"](@\/[^'"]+|\.[^'"]+)['"]/g)) {
    const spec = m[1];
    let target;
    if (spec.startsWith('@/')) target = spec.slice(2);
    else target = relative(SRC, resolve(join(abs, '..'), spec)).split(sep).join('/');
    if (SHARED.some((s) => target === s || target.startsWith(s + '/'))) continue;
    const theirs = laneOf(target.split('/').join(sep));
    if (theirs && theirs !== mine) {
      const lineNo = code.slice(0, m.index).split('\n').length;
      violations.push({
        rule: 'no-cross-lane-import',
        file: `src/${rel}`,
        line: lineNo,
        text: rawLines[lineNo - 1]?.trim().slice(0, 120) ?? '',
        message: `lane "${mine}" imports lane "${theirs}" (${spec}) — go through engine/types.ts and the service registry.`,
      });
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ files: files.length, violations }, null, 2));
} else if (violations.length === 0) {
  console.log(`[boundaries] ${files.length} files checked — clean.`);
} else {
  const byRule = new Map();
  for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
  console.error(`[boundaries] ${violations.length} violation(s) across ${files.length} files:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`      ${v.text}`);
    console.error(`      -> ${v.message}\n`);
  }
  console.error('summary: ' + [...byRule].map(([r, n]) => `${r}=${n}`).join(' '));
}

process.exit(violations.length ? 1 : 0);
