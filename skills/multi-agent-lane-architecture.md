---
name: multi-agent-lane-architecture
description: >
  Structure a codebase so many agents (or many humans) can build against one renderer/engine in
  parallel without destroying each other's work. Use when fanning out a large build across parallel
  workers, when integration keeps producing black-screen merge disasters, or when you need
  contract-first development that surfaces integration failures as compile errors instead of runtime
  mysteries. Proven in IRONSIGHT: ~16 lanes, 203 subagents, ~101k lines of TypeScript, one renderer.
status: PROVEN — this architecture is what made a 16-lane parallel build tractable. It is the "why"
  behind the whole codebase.
---

# Multi-agent lane architecture

## The problem it solves

Point a dozen agents at one Three.js renderer and let them import freely, and you get a black screen
and a merge conflict, every time. Parallel agents writing into one shared frame will quietly destroy
it: two lanes edit the same registry, one lane's `Math.random()` shifts another lane's RNG sequence,
a hand-rolled material bypasses the shared shader injection and looks subtly wrong, a
`setRenderTarget` outside the render lane corrupts a later pass's input. None of these throw. They
show up at integration as "why is the frame black" hours later.

IRONSIGHT's answer is to make the *seams* the primary artifact and negotiate them up front in a file
that typechecks, so **integration failures surface as compile errors rather than as a black screen.**

## The three structural rules (`docs/ARCHITECTURE.md` §0)

**Rule 1 — Rings, one-way.** Three concentric rings with strictly one-way dependencies:

- **CONTRACT** (`src/engine/types.ts`, ~3,500 lines) — types, enums, frozen tables. No behaviour.
- **CORE** — the loop, services, clock, rng, events, entities, quality, scenegraph, driver. Knows
  the boot order and nothing else's guts.
- **LANES** — ~15 subsystems with **disjoint file sets**, each exposing exactly one service. They
  **never import each other.**

A lane may import `@/engine/types`, `@/engine/harness`, `three`, its physics lib, and its own
directory — nothing else. If it needs something from another lane, that thing is already a method on
a service in `types.ts`; if it genuinely is not, the lane appends *narrowly* to the matching section
of `types.ts` and says so in its report.

**Rule 2 — No shared file is ever edited twice.** `src/bootstrap/subsystems.ts`,
`src/bootstrap/nulls.ts` and `src/shots/index.ts` are written once, by CORE, on day 0, and never
touched again. The trick that makes this hold:
- `subsystems.ts` holds one descriptor per lane, each **wired on day 0 to three named exports of that
  lane's entry file, all present as no-ops from the start.** A lane ships by filling in the *body*,
  never by editing the table. A frozen table cannot grow a hook later — so every hook is pre-wired.
- `src/shots/index.ts` uses `import.meta.glob(['./*.ts','!./index.ts'], { eager: true })`, so lanes
  only ever *create* `src/shots/<lane>.ts`. That glob "is worth more to this project than any amount
  of merge discipline."

**Rule 3 — Null services, day one.** `src/bootstrap/nulls.ts` contains a working null implementation
of *every* service: flat terrain at y=0, a physics service whose rays always miss, a silent audio
service, a game mode returning plausible fake state. **Any lane can boot the entire engine with 27
nulls and one real service and still take a screenshot.** This is the literal difference between
sixteen parallel agents and sixteen serialised ones — nobody waits for anybody.

## The three named exports — the whole of a lane's wiring

Every lane's entry file exports exactly three symbols (`docs/ARCHITECTURE.md` §2.1,
`docs/OWNERSHIP.md`):

```ts
export function create<Key>Service(ctx: BootContext): <Key>Service   // build + register tick/render systems
export function register<Key>Bakes(assets, quality): void            // DECLARE bake steps only, never bake
export function reset<Key>(seed: number): void                       // drop transient state (see harness skill)
```

Why the last two are free functions, not methods: `registerBakes` runs *after* the asset registry
and *before* any service instance exists, because the bake scheduler must see the whole cost total up
front to apply a unit ceiling by degrading resolution instead of discovering it is over budget half
way through. And `reset` must be reachable from the frozen table whether or not `create` ever ran. A
lane that needs its instance inside either hook keeps it in a module-scoped variable that `create`
assigns, and tolerates `null`.

**Every `create` receives the full `BootContext`** — a factory that ignores it cannot register a
tick, reach baked assets, fork the RNG, or add to the scene, i.e. cannot do its job.

## Register cross-cutting things in `afterBoot`, not in the factory body

`dependsOn` declares *construction-time* dependencies only. It cannot describe "my render pass will
read `SceneDepth` nine months from now." So passes are registered in `BootContext.afterBoot(fn)`,
which CORE runs after the last subsystem is constructed and before `RenderGraph.validate()`
(`docs/ARCHITECTURE.md` §2.2). Registering in the factory body relies on table order and silently
attaches to the *null* graph if the tie-break ever changes: `addPass` returns normally, your passes
never run, nothing throws, the shot is black.

## Boundary CI is load-bearing, not cosmetic (`tools/check-boundaries.mjs`)

The rules are only real if a machine enforces them. `npm run boundaries` (inside `npm run verify`)
fails the build on:
- an import from another lane's directory (the composition root `bootstrap/` is the sole exception);
- `Math.random(` anywhere in `src/` — it would destroy shot determinism and therefore the entire
  critic loop;
- `new THREE.Mesh*Material` / `new THREE.(Raw)ShaderMaterial` / `onBeforeCompile` outside the
  material factory — ad-hoc materials miss the shared detail/wear/fog/velocity injection and lose
  CSM, clustered lights, GTAO and motion vectors silently;
- `renderer.setRenderTarget` outside the render lane — it fights the graph's resource lifetimes;
- `performance.now(` / `Date.now(` outside the clock/profiler — wall-clock reads break the fixed
  timestep;
- runtime network (`fetch`, `WebSocket`, …) and binary-asset imports — the zero-asset, zero-network
  invariant;
- two GLSL bug classes (below).

**Never weaken a rule to make code pass — fix the code.** The boundary file's own comments record
that each rule exists because breaking it produces a silent, expensive-to-diagnose failure.

## The GLSL bug classes CI encodes (each cost a real outage — `HANDOFF.md` §8)

- **Backticks in GLSL template literals.** A shader *comment* quoting an expression in prose —
  `` // previous form was `1 - clamp(x,0,1)` `` — terminates the template string; the rest of the
  shader parses as TypeScript and the error surfaces far from the cause. Broke the build three times.
  Caught by `glsl-unescaped-backtick` (scoped to comment lines only, so it never cries wolf).
- **Whole-valued constants interpolated into GLSL float maths.** `const S = 3.0` stringifies as
  `"3"`; GLSL ES 3.00 has no implicit int→float, so `1.0 + ${S} * v` fails to compile, the pass never
  links, its draw is silently dropped, and *every frame comes out unexposed.* Latent: safe at 1.42,
  breaks the moment someone tunes it to 2.0. Caught by `glsl-int-literal`; route through `.toFixed(n)`.
- **GLSL ES 3.00 reserved words that look like ordinary names** (`patch`, `sample`, `filter`,
  `input`, `output`, `common`, `active`, …). `float patch = …` fails with "Illegal use of reserved
  word" at a line in the *assembled* shader that matches nothing in your source. Caught by
  `glsl-reserved-word`.

## Integration-only failures — run an integration pass after every parallel wave

The sobering honest lesson (`HANDOFF.md` §8): **every serious bug in the project passed typecheck,
boundaries and build, and existed only because lanes were finally composed in one frame** — a shader
permutation cap set to 24 before any lane existed when the real count was 44; arch voussoirs rotated
90° wrong at the haunches but correct at the crown; a depth prepass covering only opaque geometry so
TAA reprojected water and grass as *sky*; water writing velocity in NDC where the frame expects UV.
The contract prevents *merge* disasters; it does not prevent *semantic* mismatches at the seam.
Always schedule an explicit integration pass, and give it a screenshot to look at.

Two smaller but real operational traps: **parallel agents sharing `dist/` clobber each other** and
produce failures that look like code bugs — every agent sets `IRONSIGHT_DIST=dist-<lane>`. And an
agent killed mid-write leaves a characteristic signature (dangling imports, half-finished type
surfaces); the runbook is *commit immediately even if broken*, then finish the lane rather than
restart it.

## Sequencing that actually parallelises (`docs/ARCHITECTURE.md` §10)

The dependency graph has exactly two genuine serialisation points: the asset/bake registry and the
`MaterialFactory`. Land those first with the strongest agents; every content lane's output looks
wrong until the factory exists and is stable. Everything downstream fans out against the null
services. Global *tuning* (exposure, tonemap, cascade distances, bloom threshold) is explicitly **not
parallelisable** — each is a judgement about the whole frame and needs one owner looking at one PNG.

## Honest scope

This is the highest-confidence, most transferable pattern in IRONSIGHT — it is *proven* in the sense
that a 101k-line renderer was actually built this way by ~200 subagents. It is worth being clear
about what it does and does not buy: it buys **safe parallelism and compile-time integration**. It
does **not** buy correctness, and it does not buy quality — the same repo that proves this
architecture also sits below its own visual bar (~6.0/8.5) and shipped serious behavioural bugs.
Contract-first parallelism gets many hands onto one renderer without chaos; it is orthogonal to
whether the result is good.

## Key files
- `docs/ARCHITECTURE.md` §0–2, §10 — the three rules, the named-export contract, sequencing.
- `docs/OWNERSHIP.md` — the anti-collision map: every file to exactly one lane, the export table.
- `src/engine/types.ts` — the contract layer (sectioned, one named amender per section, append-only).
- `src/bootstrap/subsystems.ts`, `src/bootstrap/nulls.ts`, `src/shots/index.ts` — the three frozen
  shared files.
- `tools/check-boundaries.mjs` — the enforcement.
