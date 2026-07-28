# IRONSIGHT

A browser-native first-person shooter built on Three.js, aiming at the visual and tactile bar of a
modern AAA military shooter. One map, Conquest, bots, destructible cover.

**Everything is generated procedurally in code at load time.** No textures, no meshes, no audio
files, no fonts — the repo contains zero binary art assets and the game makes zero network requests
at runtime. That is why the first load spends ~30–60 s on a bake progress bar: it is building every
material, mesh, sound and font atlas on your machine.

---

## Play it

```bash
npm install
npm run dev
```

Open the URL Vite prints (default <http://localhost:5173>), wait for the bake, then **click the
canvas to lock the pointer**. `Esc` releases it.

> First load bakes for ~30–60 s. Subsequent loads hit the cache and are much faster.
> Requires a WebGL2 browser. Chrome/Edge give the best results; Safari works but is slower.

### Controls

| | |
|---|---|
| **Move** | `W` `A` `S` `D` |
| **Look** | Mouse (click canvas to capture) |
| **Fire** | Left mouse |
| **Aim down sights** | Right mouse (hold) |
| **Sprint** | `Shift` |
| **Jump / vault** | `Space` |
| **Crouch** | `Ctrl` or `C` |
| **Prone** | `Z` |
| **Reload** | `R` |
| **Lean left / right** | `Q` / `E` |
| **Throw grenade** | `G` (hold to cook, release to throw) |
| **Use / interact** | `F` — resupply at an ammo crate on any capture point |
| **Swap weapon** | `X`, or `1`–`9` — **currently does nothing**; the loadout stays on the rifle |
| **Fire mode** | `B` |
| **Spot** | `T` |
| **Scoreboard** | `Tab` (hold) |
| **Spawn / deploy menu** | `M` |

Gamepad is supported on the standard W3C mapping.

#### Bound but NOT yet implemented

These keys are in the binding table and reach the input layer, but nothing consumes them yet.
Pressing them does nothing:

| | |
|---|---|
| **Melee** `V` | Not wired to the damage model. |

### What is NOT yet a playable mechanic

Some systems are fully built and visible in the captured shots, but **cannot currently be triggered
by a player**. Being explicit so the screenshots do not oversell the game.

The table below was re-measured by driving the shipped build in a browser with real keyboard and
mouse events and reading the counters back — not by reading the code. See "How the table was
checked" underneath.

| System | Built? | Reachable in play? |
|---|---|---|
| Bullet impacts, decals, surface-correct debris | yes | **yes** |
| Destructible cover (collider removed, cover lost, dust) | yes | **yes** — shooting cover damages it and eventually collapses it; a frag breaches it outright |
| Explosions (fireball, pressure ring, debris, smoke column) | yes | **yes** — `G` throws a frag that arcs, bounces, detonates and lights the world |
| HUD combat feedback (hitmarkers, killfeed, damage chips, kill banner) | yes | **yes** — driven by real `damage.applied` / `killfeed` events, not by the demo timeline |
| Ammo resupply | yes | **yes** — a crate on each capture point; `F` or a short dwell |
| Bot combat | yes | **yes** — bots path, engage and kill each other; 2–6 kills per 60 s 9v9 soak |
| Melee | no | **no** — `V` reaches the input layer and nothing consumes it |

Both of destruction's long-standing rough edges are now closed, measured live (not in either
instrument — see below):

- A collapsed piece of LEVEL cover **spawns real debris**. `DestructibleDef.chunks` now resolves to
  a `ShardedMeshAsset`, so `shardsOf()` finds the shard set `src/level/colliders.ts` bakes instead of
  an empty list. Measured: 18 chunks per collapse at tier HIGH, 90 across five collapses.
- The **intact mesh of a breached LEVEL wall now goes**. `StaticColliderDef.visuals` carries the
  batch instances the cover was drawn as, `PhysicsService.addStatic` forwards them to
  `DestructionService.attachBatchInstance`, and the collapse calls `SceneGraph.hideBatchInstance`.
  Measured at boot: 241 of 244 destructibles have geometry attached; the 3 that do not are crane
  footings and are named in a boot warning.

#### How the table was checked

`DestructionService.reset()` clears its registration table (`byEntity.clear()`) and only
`PhysicsService.addStatic` ever repopulates it, at world build. That reset runs at the top of every
`tools/shoot.sh` capture **and** every `tools/soak.sh` run — so **inside both of this repo's
automated instruments every wall in the map is an inert static collider**, and neither can see
destruction at all. Live play never resets, so a human is unaffected. Any future claim about
destruction has to be measured in a live page, or after PHYS re-registers on reset.

`globalThis.__DESTR__` is the readout for that: `summary()` reports how many destructibles have
geometry attached and how many are collider-only, `nearby(point, radius)` pairs each one's `intact`
flag with whether it is still `drawing`, and `intact: false, drawing: true` is precisely the defect
above. Same lane-private-probe pattern as `__THROWABLES__` and `__SOAK__`.

### The map — HARBOUR REACH

A Mediterranean coastal town at golden hour. Three capture points:

- **ALPHA** — the market square, under the arcade
- **BRAVO** — the harbour cranes and quay
- **CHARLIE** — the old fort on the headland

---

## Current state — read this before judging it

This project is **mid-development and does not yet meet its own quality bar.** Being specific rather
than vague about that:

- The engine, map, weapons, physics, bots, Conquest and HUD all work. 48 deterministic camera shots
  capture cleanly.
- Against a rubric scored by blind A/B comparison with real gameplay frames, it sits well short of
  the AAA target. `docs/AAA_RUBRIC.md` has the honest numbers and, importantly, an explanation of
  why the absolute scores drift between rounds and should be read as deltas.
- Known rough edges: over-strong near-field atmospheric scattering (a blue veil on several views),
  compressed contrast, sparse vegetation, and water that is weaker than the rest of the frame.

`HANDOFF.md` is the full state-of-the-project document, including what to work on next.

---

## Development

```bash
npm run verify      # typecheck + boundary CI + build. THE gate — keep it green.
npm run dev         # dev server with HMR
npm run build       # production build
npm run boundaries  # architectural rules only
```

### Looking at the game without playing it

The game registers ~48 deterministic camera shots. The harness suspends the render loop, reseeds
the RNG, renders an exact number of fixed-timestep frames and grabs the canvas — so a shot is
reproducible frame-for-frame on any machine.

```bash
./tools/shoot.sh --list           # list every registered shot
./tools/shoot.sh level_bravo      # capture one → tools/shots/level_bravo.png  (~1.5 s)
./tools/shoot.sh                  # capture all
```

A green shoot doubles as a smoke test: it exits non-zero on a build failure, an uncaught page error
or any console error.

### Comparing against reference

```bash
python3 tools/fetch-reference.py  # rebuild the local calibration corpus (gitignored)
./tools/compare.sh --ours tools/shots/level_bravo.png \
                   --ref  reference/gameplay/bf6_gp_020.jpg \
                   --out  tools/compare/sheet.png
```

Builds a two-panel sheet labelled only **A** and **B**, sides randomised, answer key written to
`tools/compare/.keys/`. The blind is the point — it is very easy to rate your own work generously.

### Notes

- **Node**: nothing to configure. Vite scripts route through `tools/with-node.sh`, which finds a
  node ≥ 20.19 itself. Override with `IRONSIGHT_NODE_BIN`.
- **Reference imagery** under `reference/` is third-party, gitignored, never committed and never
  shipped. No pixel, mesh, texture or layout from it enters the build.

---

## Documentation

| | |
|---|---|
| `HANDOFF.md` | **Start here.** Full project state, runbooks, traps, what to do next. |
| `docs/BRIEF.md` | The design contract every contributor works to. |
| `docs/ARCHITECTURE.md` | Module tree, render graph, frame lifecycle, bake pipeline. |
| `docs/OWNERSHIP.md` | Which files belong to which subsystem. The anti-collision map. |
| `docs/LOOK_SPEC.md` | Art-direction target as implementable numbers, measured from real frames. |
| `docs/HUD_SPEC.md` | The HUD, element by element. |
| `docs/AAA_RUBRIC.md` | How frames are scored, and why the scores drift. |
