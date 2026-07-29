# Before Claude's teaching layer

This is the before-state Claude should have documented before adding `/learn/`. It prevents a
teaching plan from obscuring how much of the lesson already existed as a working game.

## Authoritative boundary

- Repository: `git@github.com:ChaiWithJai/ironsight.git`
- **Before commit:** `309d71d3fff96159fb4005ca598f337bb9f36b98`
- Claude academy commit: `1097016834b6eb59fbe40e2f8db21494b84dbae4`
- Relationship: `309d71d` is the sole parent of `1097016`.
- Claude's change: 26 files, 1,926 inserted lines. Before it, there was no `learn/` entry,
  `src/learn/` lane, `docs/TEACHING.md`, or academy screenshot harness.

Recreate it without relying on this document:

```bash
git worktree add ../ironsight-before 309d71d3fff96159fb4005ca598f337bb9f36b98
cd ../ironsight-before
npm ci
npm run verify
```

## What the game already made possible

At `309d71d`, IRONSIGHT was already the strongest teaching artifact in the repository:

### JavaScript as a creative runtime

- A playable browser-native first-person shooter built with Three.js and Rapier.
- A Mediterranean world with terrain, buildings, vegetation, water, sky, weapon, HUD, bots,
  physics, audio, Conquest rules, and three capture points.
- Procedural generation of every runtime texture, mesh, sound, and font.
- A 30–60 second in-browser bake that turned source code into the world.

### APIs as contracts and instruments

- A roughly 3,500-line contract layer in `src/engine/types.ts`.
- Player and bot intent routed through shared service contracts.
- Lane-private browser probes including `__DESTR__`, `__THROWABLES__`, and `__SOAK__`.
- Static, versioned configuration and gameplay tables compiled into the bundle.
- Zero runtime network requests from the game, enforced by boundary CI.

### Markup and static delivery

- The complete game shipped as static HTML and JavaScript suitable for CDN hosting.
- No application server, database, account, or save service was required to play.
- The deployed entry was a normal `index.html`, not a server-rendered shell.

### Playable mechanics, not just rendered systems

The before commit documented these as reachable through live browser input:

| Mechanic | Before-state evidence |
|---|---|
| Move, look, sprint, jump/vault, crouch, prone, lean | README control map and live game |
| Fire, aim, reload, fire mode, spot | README control map and input path |
| Bullet impact decals and surface debris | live gameplay counters |
| Throwable grenades and explosions | `G` input plus `__THROWABLES__` |
| Destructible wood, stucco, and sandbags | live-page `__DESTR__` probe |
| Ammo resupply | `F` or dwell at capture-point crates |
| Bot combat | measured 2–6 kills per 60-second 9v9 soak |
| Conquest at Alpha, Bravo, Charlie | game rules, HUD, capture state |
| Combat HUD feedback | real damage and killfeed events |

Melee and weapon swapping were explicitly bound but inert. Masonry and concrete were too strong
to breach in practical play. Those limits matter because the before-state was honest about the
difference between implemented, rendered, and reachable.

## The feedback machinery already present

Claude did not invent the entropy-containment story; the game had already paid for it:

- `npm run verify`: strict types, architectural boundaries, and a production build.
- `tools/check-boundaries.mjs`: cross-lane import, nondeterminism, wall-clock, network, material,
  shader, and asset gates.
- `src/engine/harness.ts` + `tools/capture.mjs`: fixed-frame deterministic camera captures.
- `tools/soak.mjs`: behavioral evidence for movement, targeting, firing, and stalls.
- `tools/compare.sh`: blinded, randomized A/B visual comparison.
- 65 deterministic registered shots in the later before-state documentation.

The most important prior lesson was also already known:

> The shot harness photographs systems, not mechanics.

Twelve visual-critic rounds missed immobile bots. Ten minutes of human play found four real bugs.
That is why a teaching refactor must preserve both visual evidence and reachable-behavior evidence.

## What Claude added, and what it did not

Claude correctly extracted five small demonstrations from the game's ideas: seed, land, people,
ledger, and gate. It also added excellent narrative framing and deterministic academy captures.

But Claude moved the lesson into a parallel miniature instead of first exposing the working game's
capabilities. Its capture harness opened each chapter and took a screenshot without touching a
control. No chapter had an observable learner objective, win condition, evaluator, feedback loop,
mastery state, or end-to-end learner-path check.

The proper historical sequence is therefore:

```text
309d71d  working procedural FPS + mature quality instruments
   ↓
1097016  five polished but unassessed academy demonstrations
   ↓
current  field missions + observable evidence + feedback + durable mastery
```

The next bridge should point back into the original game, because the game—not the miniature—is the
most convincing proof of what JAMStack can do.
