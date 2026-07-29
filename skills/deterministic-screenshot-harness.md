---
name: deterministic-screenshot-harness
description: >
  Build a screenshot harness that renders bit-reproducible frames on any machine, GPU or software,
  so "did this change make it look worse?" becomes an answerable question. Use when a project needs
  automated visual review, a frame-diff regression gate, or any capture loop that an LLM critic or a
  CI job compares over time. Proven in IRONSIGHT: 48–65 shots capture exit-0, bit-stable across runs.
status: PROVEN — this is load-bearing infrastructure that works today and is the reason the whole
  visual review loop exists.
---

# Deterministic screenshot harness

## Why this is a skill and not just a screenshot script

The naive version — "start the app, wait a bit, grab the canvas" — is worthless the moment you want
to answer *whether a change made the frame worse*, because the two frames you diff differ for a dozen
reasons that have nothing to do with your change: TAA history depth, auto-exposure adaptation, wall-
clock-dependent particle counts, RNG drift, GPU-vs-software rasteriser differences. IRONSIGHT's
harness exists to strip every one of those out, and the payoff is that a PNG diff of 0.00% *means
something*: nothing changed. A non-zero diff means something really did.

This is the single most transferable piece of the project. Everything else — the blind critic loop,
the multi-agent lanes, the entire "make it look AAA" workflow — stands on it.

## The two invariants (this is the whole trick)

From `src/engine/harness.ts` (the file is LOCKED — its contract is deliberately tiny so it survives
while everything around it churns):

1. **Frame budget is counted in FRAMES, never wall-clock.** A shot that needs 24 frames for TAA to
   converge gets exactly 24 frames whether that takes 200 ms on a discrete GPU or 40 s under
   SwiftShader. See the `capture()` loop: `for (let i = 0; i < frames; i++) driver.stepFrame(dt)`
   with `dt = spec.dt ?? 1/60` — a **fixed** timestep, not the real inter-frame delta.
2. **While a capture is in flight the normal `requestAnimationFrame` loop is suspended and every
   stochastic system is fed a fixed seed and a fixed dt**, so two runs of the same shot are
   bit-comparable. `driver.setLoopSuspended(true)` parks the rAF loop; `driver.context.seed(...)`
   reseeds the RNG *and* runs a full reset chain (below).

Under the harness, `dt = 1/60` yields exactly one simulation tick per rendered frame with the render
interpolation factor `alpha = 0` on every frame, so interpolation is a no-op during capture *by
design* (`docs/ARCHITECTURE.md` §3.3, §8). That is what makes a captured frame equal to a live frame
at the same simulated instant.

## The contract surface

The harness talks to the engine through one small interface (`HarnessDriver` in
`src/engine/harness.ts`): `context: ShotContext`, `stepFrame(dt)`, `setLoopSuspended(v)`,
`flush(): Promise<void>`. A shot is a `ShotSpec { name, description, setup(ctx), frames?, dt? }`.
Shots self-register via `registerShot`, and `src/shots/index.ts` picks them up with
`import.meta.glob(['./*.ts','!./index.ts'], { eager: true })` so no shared registry file is ever
edited by two authors (see the multi-agent-lane-architecture skill).

Keep shot files **trivially thin**: pose the camera, force state, return. No module-level side
effects, no top-level throws, no imports outside the shot's own lane. A single shot file with a
compile error breaks the capture tool for *every* lane at once.

## The reset chain — the part people forget, and it costs them

`docs/ARCHITECTURE.md` §8.1 is the hard-won lesson: **the harness does not know about your
subsystem.** Persistent decals, debris, destroyed walls, TAA history, exposure adaptation, bot
positions and particle pools all leak from one capture into the next, which makes a shot's result
depend on capture *order* and sends visual critics chasing ghosts.

So `ShotContext.seed(n)` runs a reset chain: `rng.reseed(n)` → `graph.resetHistories()` → explicit
resets of the five stateful services (destruction, vfx, ballistics, ai, mode) → then every
subsystem's `reset(seed)` hook in boot order. Design rules that fall out of this:

- **Every stateful subsystem must implement a `reset(seed)` that drops transient state.** It is not
  optional and the integration pass cannot retrofit it for you.
- **The acceptance test for "is my reset complete?" is: capture every shot twice in different orders
  and diff the PNGs. Identical bytes, or the reset chain is incomplete.**
- Forked RNG streams (`rng.fork(label)`) are rewound automatically because forks are memoised per
  label and `reseed()` recurses. What is *not* rewound is anything you *copied out* of a fork and
  cached (a jitter table built once in a constructor keeps last capture's numbers). Rebuild it in
  `reset`, or draw it fresh each frame.
- Freeze temporal feedback loops during capture. IRONSIGHT reads a **locked EV** for auto-exposure
  whenever `FrameCtx.deterministic` is true (`src/render/passes/exposure.ts`, `docs/ARCHITECTURE.md`
  §8.2), and hard-disables dynamic resolution. Any new temporal effect (SSR, GTAO, clouds,
  volumetrics) inherits the obligation to *converge inside the shot's frame count* or declare a
  higher `frames` on its `ShotSpec`.

## The 465× lesson: do not assume headless has no GPU

`HANDOFF.md` §4 — the single highest-leverage fact in the project. Capture used to take **698 s per
shot** because the harness forced ANGLE→SwiftShader on the assumption that headless Chromium on macOS
has no GPU path. That was wrong: `headless-new` reaches ANGLE's Metal backend directly. Fixed in
`tools/capture.mjs`; capture dropped to **1.5 s per shot, a 465× speedup.**

Why it matters beyond speed: under SwiftShader an agent could afford *one* capture per turn, so it
had to reason about what its change probably did. At 1.5 s it can capture, look, adjust and
re-capture dozens of times per turn. If you build a harness like this, **tell every downstream agent
explicitly how cheap a capture now is** — otherwise they keep working as if captures were expensive.
Keep an escape hatch (`IRONSIGHT_SOFTWARE_GL=1`) to force the software path for a GPU-less machine or
to distinguish a driver artefact from a real bug. Never mix backends within one comparison set —
pixel values differ slightly.

## A green capture doubles as a smoke test

`./tools/shoot.sh` exits non-zero on a build failure, an uncaught page error, or *any* console
error. This is free coverage: the same run that produces review images also proves the app boots,
the render graph runs, and a frame lands without throwing. IRONSIGHT's `core.ts` shot exists purely
as that smoke test — "the engine boots, the graph runs, a frame lands."

## THE trap: the harness photographs SYSTEMS, not MECHANICS

This is the most important honest caveat in the whole project (`README.md`, `HANDOFF.md` §2.2).
**A deterministic screenshot proves a system can be rendered. It proves nothing about whether a
player can trigger it.** Twelve rounds of visual critics scored the *look* of an `ai_firefight`
frame without ever noticing that the bots in it did not move. Worse, IRONSIGHT's capture path calls
`DestructionService.reset()`, which clears the destructible registry that only world-build
repopulates — so **inside the screenshot harness and the soak harness alike, every wall is an inert
static collider and destruction cannot be observed at all.** A human playing live is unaffected.

The correct response is not to distrust the harness but to *pair it with a behaviour instrument*.
IRONSIGHT added `tools/soak.sh` — a headless fixed-timestep simulation that runs the sim forward
without rendering and reports distance travelled, frozen-tick fraction per bot, targets acquired,
shots fired, capture progress. That instrument found three real bugs the screenshots had hidden for
the entire project. **Build both. A pretty frame and a moving simulation are different claims.**

## Reproducing this in a new project

1. Define a tiny locked driver contract: advance one fixed-dt frame, suspend the main loop, flush GPU
   work, and one `ShotContext` for posing (camera, time-of-day, forced state, seed).
2. Make randomness flow through one seedable RNG with named forks; ban `Math.random()` in CI.
3. Count the warm-up in frames, not milliseconds.
4. Implement a reset chain seeded before every shot, and make "capture twice, diff bytes" a gate.
5. Freeze every temporal feedback loop (exposure, TAA, dynamic-res) under a `deterministic` flag.
6. Make a failed/erroring capture exit non-zero so it is also a smoke test.
7. **Build a separate behaviour instrument** and never let a rendered frame stand in for a mechanic.

## Key files
- `src/engine/harness.ts` — the locked contract (`ShotSpec`, `ShotContext`, `HarnessDriver`, the
  `capture()` reset-then-render loop).
- `src/engine/driver.ts` — the engine-side implementation and the reset chain.
- `tools/capture.mjs` — Playwright driver; the ANGLE-vs-SwiftShader fix; the 300 s ready timeout.
- `tools/shoot.sh` — CLI wrapper; non-zero on any console error.
- `src/shots/index.ts` + `src/shots/<lane>.ts` — the glob loader and thin per-lane shot files.
- `docs/ARCHITECTURE.md` §3.3, §8, §9 — interpolation-is-a-no-op, the reset chain, determinism
  non-negotiables.
