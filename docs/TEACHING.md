# TEACHING.md — turning IRONSIGHT into a JAMStack academy

**Owner:** Jai Bhagat · DharmicData.org
**Goal:** teach what's possible with the JAMStack (JavaScript, APIs, Markup) by making it *fun* —
using worldbuilding of a civilization: symbols, characters, time and places that capture attention
and imagination first, then teach.

This document answers three questions: **how**, **why this repo**, and **how we keep the loop
fast and the entropy contained.**

---

## 1. Why this repository is a teaching goldmine

IRONSIGHT looks like a game, but structurally it is the most extreme JAMStack demonstration
possible, and every one of its invariants is already a lesson:

| Repo fact | JAMStack lesson it teaches |
|---|---|
| Builds to static HTML, CSS and JavaScript artifacts | **This is the whole stack.** No server, no database, no backend — and it's a AAA-aspiring FPS. |
| Zero binary assets; every texture/mesh/sound/font generated in-browser | **JavaScript is a full creative medium.** The client is a build machine. |
| Zero network requests at runtime | The "A" in JAM can happen **at build time** — data is baked in, served from a CDN edge. |
| One seeded PCG32 RNG, `Math.random()` is a CI failure | **Determinism** — same seed, same world, forever. State fits in a URL. |
| Deterministic screenshot harness (`tools/capture.mjs`) | Visual regression testing — "did it get worse?" is an *answerable question*. |
| Boundary CI (`tools/check-boundaries.mjs`) | Architecture as executable rules — entropy containment you can run. |

The pedagogy writes itself: **the game world IS the worldbuilding device.** Harbour Reach is a
civilization generated from a seed. Its terrain, buildings, people (bots), and history (the match)
are all *consequences of code*. We teach by letting learners hold the seed.

## 2. The worldbuilding frame (the DharmicData method)

Capture imagination first, teach second. The mapping:

| Story element | Engine reality | Chapter |
|---|---|---|
| **Time / Fate** — the seed from which all history unfolds | `src/engine/rng.ts` (PCG32, forked streams) | I. The Seed |
| **Places** — the land rises from mathematics | fBm noise → heightfields (`src/bake/noise.ts`, terrain bake) | II. The Land |
| **Characters** — people act, settle, contest | bots emitting `PlayerIntent`, fixed-tick simulation | III. The People |
| **Symbols / Records** — the civilization's ledger | build-time JSON data, the "A" in JAM | IV. The Ledger |
| **Law / Dharma** — what keeps the world coherent | `npm run verify`, boundaries, shot harness | V. The Gate |

Each chapter is: *a field mission with observable proof* → *a live toy* (JavaScript, seeded,
deterministic) → *immediate feedback and durable progress* → *a story beat* (Markdown) →
*a "lift the curtain" section* pointing at the real engine file that does the same thing at scale.

## 3. The implementation: a `learn` lane

The academy remains a lightweight parallel lane, but it imports real engine seams and treats
deterministic systems as learning mechanics rather than illustrations:

```
learn/index.html          second Vite entry → deploys at /learn/
src/learn/
├── main.ts               shell: hash routing, chapter nav, demo mounting, __LEARN__ probe
├── course.ts             mission contracts, observable assessment, immediate feedback
├── md.ts                 ~100-line Markdown renderer (Markup is a lesson, not a dependency)
├── proc.ts               seeded hashing / value noise / fBm / name generator (shared by demos)
├── theme.css             golden-hour academy styling
├── chronicle.json        the civilization's ledger — imported AT BUILD TIME (the "A" lesson)
├── lessons/*.md          chapter narratives, imported with ?raw at build time
└── demos/*.ts            one live deterministic demo per chapter
```

Rules the lane obeys (and *teaches by obeying*):

- **No `Math.random()`** — every demo runs on `Pcg32` from `@/engine/rng` (a SHARED seam).
- **No wall clock** — animation advances by frame/tick counters only.
- **No runtime network** — `chronicle.json` and all lessons are imported at build time.
- **`learn` is registered in the boundary CI's lane table** — it may import only the shared seams.
- **`?frozen` mode** — every page renders a pixel-stable state for the screenshot harness.

## 4. Low-hanging fruit inventory (ranked by effort → payoff)

1. **The RNG as a toy** (hours). `Pcg32` is dependency-free, deterministic, forkable. A seed input
   + star-chart canvas demonstrates "same seed, same universe" — the single most magical, most
   shareable JAMStack demo possible. State-in-URL falls out for free. → *Chapter I.*
2. **fBm terrain on a 2D canvas** (hours). Value noise + a palette + hillshading = a living map,
   no WebGL required. Sliders for sea level and octaves make it a *toy*. → *Chapter II.*
3. **Build-time JSON as "the API"** (an hour). `import chronicle from './chronicle.json'` — then
   show the raw JSON in the page. The whole JAMStack data story in one toggle. → *Chapter IV.*
4. **The existing verify/capture infrastructure as curriculum** (an hour of prose). The blind A/B
   loop, the boundary CI, the frame-counted screenshot harness — these are *already written*; the
   lesson is pointing at them. → *Chapter V.*
5. **A tick-stepped agent sim** (a day). Villagers on the fBm map, seeking fertile land, founding
   named settlements — a miniature of the game's bot/intent architecture. → *Chapter III.*
6. **A URL-authored civilization** (hours). The forge changes identity, sigil, era, and place names,
   then publishes them as `URLSearchParams`. The same typed profile seam changes the real game's
   minimap and objective markers without changing simulation IDs. → *Transfer mission.*

Deliberately NOT low-hanging (deferred): embedding the live engine in lesson pages (30–60 s bake,
WebGL2 requirement, huge bundle); WYSIWYG lesson editing; learner accounts. The first server slice
is deliberately small: Functions validate the same `WorldProfile`, Database durably stores it, and
Blobs receives an immutable export.

## 5. The visual feedback loop — how fast, how reliable

**Fast:** `npm run dev` gives HMR on lesson prose, styles and demos in <1 s. The learn lane
imports neither three.js nor rapier, so its dev-server graph is tiny.

**Reliable:** `tools/learn-shots.mjs` (same skeleton as `capture.mjs`): builds, serves `dist/`,
drives headless Chromium to each chapter with `?frozen`, waits for `window.__LEARN__.ready`,
writes one PNG per chapter, and then completes all five missions through their real controls.
It **fails on any console error or unreachable mission**. Because every demo is a pure function
of `(seed, params, tick)`, the PNGs are stable byte-for-byte candidates for diffing.

The loop, end to end: edit lesson → HMR preview → `npm run verify` (types + boundaries + build)
→ `./tools/learn-shots.sh` (pixels). Total cold time ≈ build time + ~2 s/page.

The full-game bridge has a separate proportional gate: `npm run teach:smoke`. It first completes
the forge through semantic form controls, follows its generated link, pays the actual procedural
bake, verifies that the authored profile reached the real HUD, sends keyboard/mouse input, proves
movement and weapon events, then routes the existing combat drill through normal `PlayerIntent`,
ballistics, and damage. It writes forge/game screenshots and evidence JSON under ignored
`tools/teaching/`. The named-place mission stays a human/navigation check rather than being
auto-completed by teleporting the player onto a flag.

## 6. Testing strategy — containing entropy

Entropy enters a teaching site through three doors; each gets a gate:

1. **Code entropy** → the *existing* gates, extended, not duplicated: `tsc` covers the lanes
   (strict mode), `check-boundaries.mjs` knows `learn`, `teach`, and `forge`
   (shared-seams-only imports, no `Math.random`, no wall clock, no fetch), and `vite build` proves
   all three entries link.
   One command — `npm run verify` — stays THE gate.
2. **Content entropy** → lessons are **data, not code**. Markdown in, HTML out through one small
   renderer. A broken lesson cannot break a demo; a broken demo cannot break the game bundle.
3. **Interaction entropy** → demos report plain evidence to `course.ts`; evaluators decide
   completion, and the capture harness proves all five paths through real controls.
4. **Visual entropy** → determinism by construction (seeded RNG, tick-counted animation, `?frozen`
   capture states), so screenshots regress meaningfully instead of flaking. The lesson pages get
   the same treatment the engine gets, because the treatment is the curriculum.
5. **Persistence entropy** → one shared validator, repository migrations, relational writes for
   concurrent progress, immutable-only Blob artifacts, and three proportional layers: pure
   contract tests, Function↔Database/Blob integration, then Forge→stable ID→actual game acceptance
   with a forced API outage to prove URL fallback.

The principle throughout: **don't build a second quality system — enroll the new lane in the one
that already kept 203 subagents honest.**

## 7. The loop to the goal

Each iteration of this project should close the same loop:

```
imagine (story beat) → build (seeded toy) → verify (npm run verify) →
see (learn-shots PNGs) → author (can the forge earn 4/4?) → play (can the harness earn 5/5?) →
teach (does a human transfer the idea?) → repeat
```

Roadmap after this first pass:

- **v1.5 — the live field lab:** `/?teach=1` overlays observable missions on the shipped FPS.
  Movement, weapon fire, damage/destruction, and named-place visits come from real engine services
  and events. See `docs/VIDEO_ANALYSIS.md`; three of four paths have recorded automated evidence.
- **v1.6 — the civilization forge:** `/forge/` supplies the missing create-level transfer task.
  Four authored meanings are carried through a static URL into the real minimap and objective HUD;
  the production-browser smoke test proves the entire seam.
- **v2 — deeper toys:** erosion iterations as "the age of rains"; audio DSP as "the bells of the
  harbour" (WebAudio, still zero assets); the SDF font baker as "the scribes' glyphs".
- **v3 — the bridge:** deep-link lesson pages into the live game with a shared seed, so the map a
  learner shaped in Chapter II is the world they walk in.
- **v1.7 — durable publishing (implemented):** anonymous learners publish a validated civilization
  to Netlify Database, receive a stable ID, retain the complete URL fallback, and generate an
  immutable Blob export. Staging and production use separate projects, databases, and Blob scopes.
- **v4 — learner-owned publishing:** learners fork the repo, edit one `.md` and one world
  parameter, and deploy their civilization. The managed forge proves near transfer; an independent
  learner deployment remains the far-transfer assessment.
