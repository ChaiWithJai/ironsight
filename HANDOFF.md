# IRONSIGHT — HANDOFF

**Read this first if you are picking this project up in a new session.**
Then read `docs/BRIEF.md`, `docs/ARCHITECTURE.md`, `docs/OWNERSHIP.md`.

---

## 1. What this is

A browser-native first-person shooter built on Three.js, targeting the visual and tactile quality
bar of a modern AAA Battlefield title. Single map (**HARBOUR REACH** — Mediterranean coastal town,
golden hour), Conquest with three capture points, bots, destructible cover, full weapon feel.

**Zero binary art assets. Zero runtime network requests.** Every texture, mesh and sound is
generated procedurally in code at load time. That constraint is the design, and it is what makes
the accompanying skills reusable.

There are two deliverables:
1. The game.
2. A suite of reusable AAA-game-dev **skills** in `skills/` — **NOT YET WRITTEN. See §7.**

---

## 2. Current state, honestly

| | |
|---|---|
| Code | ~79 k lines, 246 TS files, 12 commits |
| Gates | `npm run verify` (typecheck + boundary CI + build) — green |
| Shots | 48 registered, all capture exit-0 |
| Critic score | **3.80 / 8.5** weighted, **0/8** hero shots passing |
| Verdict from blind critics | still "hobby-webgl-demo" on most frames |

**The engine works. The game runs. It does not yet look AAA.** Do not let the size of the codebase
or the quality of the infrastructure fool you — the visual bar is not met, and the critics are
right about why.

### Critic trajectory

| loop | round 1 | round 2 | round 3 |
|---|---|---|---|
| Software-rasteriser loop | 2.99 | 3.27 | 3.80 |
| GPU loop | *(was running at handoff — check `git log`)* | | |

The first loop gained +0.27/round against a 4.7-point gap. That was not going to converge, and the
reason was iteration rate, not agent quality — see §4.

---

## 3. The five things that make this project work

Understand these before changing anything. Each was expensive to learn.

**1. `src/engine/harness.ts` is LOCKED.** It is the screenshot contract. Shots are deterministic
because the render loop is suspended, the RNG reseeded, and an exact number of **fixed-dt frames**
rendered before the grab. Frame budget is counted in FRAMES, never wall-clock — that is what makes
a shot reproducible across machines and rasterisers.

**2. `src/engine/types.ts` is the contract layer.** ~3.5 k lines. A dozen agents work in parallel
against it without reading each other's implementations. `src/bootstrap/subsystems.ts`,
`src/bootstrap/nulls.ts` and `src/shots/index.ts` are FROZEN — every lane ships three named exports
(`create*`, `register*Bakes`, `reset*`) at a fixed path, and the composition root imports them by
name.

**3. `docs/OWNERSHIP.md` is the anti-collision map.** Every file belongs to exactly one lane.
Violating it is the single most destructive thing an agent can do here.

**4. Boundary CI (`tools/check-boundaries.mjs`) is load-bearing, not cosmetic.** It blocks
cross-lane imports, `Math.random()` (which would destroy shot determinism and therefore the whole
critic loop), ad-hoc materials that bypass the factory, stray `setRenderTarget`, wall-clock reads,
network calls, binary asset imports, any import of `reference/`, and two GLSL bug classes that have
each cost a build outage more than once. **Never weaken it to make code pass.**

**5. The critic loop is blind, and that is the point.** `tools/compare.sh` composites our frame
beside a real one at identical size, labelled only A and B, sides randomised, answer key written to
`tools/compare/.keys/`. **Critics must never open `.keys/` before recording a verdict.** It is very
easy to rate your own work generously.

---

## 4. The single highest-leverage fact

**Capture used to take 698 s per shot. It now takes 1.5 s. A 465× speedup.**

The harness forced ANGLE→SwiftShader on the assumption that headless Chromium on macOS has no GPU
path. **That was wrong** — headless-new reaches ANGLE's Metal backend directly. Fixed in
`tools/capture.mjs` (commit `a88dc71`).

Why this matters more than it sounds: under SwiftShader a fix agent could afford *one* capture per
turn, so it had to reason about what its change probably did. Now it can capture, look, adjust and
re-capture dozens of times. **Tell every agent this explicitly** — otherwise they work as if
captures were still expensive.

Set `IRONSIGHT_SOFTWARE_GL=1` to force the old path (GPU-less machine, or to distinguish a driver
artefact from ours). Do not mix backends within one comparison set: pixel values differ slightly.

---

## 5. What is preserved, and what is not

### In git (safe)
Everything under `src/`, `docs/`, `tools/` including the vendored orchestration scripts in
`tools/workflows/`.

### On disk but NOT in git
- **`reference/` (77 MB, 187 images)** — gitignored deliberately: third-party imagery, never
  committed, never shipped. **Rebuild with `python3 tools/fetch-reference.py`.** Without it the
  critic loop has nothing to calibrate against and scores become incomparable with the ones in
  this document.
- **`tools/shots/*.png`, `tools/compare/*.png`** — regenerate with `./tools/shoot.sh`.

### Lost on session change (accept it)
Conversation context, and the agent transcripts under
`~/.claude/projects/<project>/<session-uuid>/`. The orchestration scripts themselves are vendored
into `tools/workflows/`, so the *method* survives even though the transcripts do not.

---

## 6. Runbook

```bash
npm install                          # once
python3 tools/fetch-reference.py     # once — rebuild the calibration corpus
npm run verify                       # typecheck + boundary CI + build. THE gate.
./tools/shoot.sh --list              # 48 registered shots
./tools/shoot.sh light_cascades      # ~1.5 s on GPU
./tools/shoot.sh                     # everything
./tools/compare.sh --ours tools/shots/X.png --ref reference/gameplay/Y.jpg --out tools/compare/z.png
```

Node: nothing to configure. Vite scripts route through `tools/with-node.sh`, which finds a
node ≥ 20.19 itself; `IRONSIGHT_NODE_BIN` overrides.

### Recovering from agents killed mid-write

This has happened once (usage limit) and cost hours. The runbook:

1. **Commit immediately**, even broken — `git add -A && git commit -m "WIP snapshot"`. An
   uncommitted broken tree is strictly worse than a committed one.
2. `npm run typecheck` and read the errors. Interrupted work leaves a characteristic signature:
   dangling imports of modules that were never written, and half-finished type surfaces.
3. **Do not re-run the lanes from scratch.** 24.5 k lines survived last time because the agents
   died during final verification, not at the start. Restart them with explicit *"your lane is
   partially built — read it, finish it, do not start over"* framing.
4. Watch for the GLSL backtick trap (§8) — it is the most common interruption artefact.

### Running the orchestration

`tools/workflows/*.js` are the exact scripts used, in order:
`foundation` → `contract-repair` → `sim-lanes` → `lanes-finish` → `reference-study` →
`visual-lanes` → `critic-loop` → `critic-loop-gpu`.

Re-run one with `Workflow({scriptPath: "tools/workflows/<file>.js"})`. They are plain JS, not TS.
**Beware:** they are template-literal heavy, and a backtick inside a prompt string will fail to
parse — the same bug class as §8.

---

## 7. What to do next, in priority order

### A. Finish the critic loop (in progress)
Re-run `tools/workflows/ironsight-critic-loop-gpu-*.js`. It fixes → re-shoots → blind-scores,
re-ranking each round from the critics' own severity findings, and exits when every hero shot
clears 8.5 with no axis below 8.0.

The dominant defects as of handoff, measured by blind critics:

| lane | severity | defect |
|---|---|---|
| LIGHT | 10 | **No cast shadows at all in `level_bravo`.** Measured: deck abutting the warehouse wall reads luminance 0.436, open deck 6 m out reads 0.420 — brighter at the wall, so the shadow term is absent and slightly *inverted*. `light_cascades` DOES have shadows, so it is distance/shot-specific: suspect a shadow-camera ortho frustum smaller than the level, or a far plane clipping before the ground. |
| LIGHT | 9 | **No ambient occlusion anywhere.** ~30 debris props read as decals painted on the ground because nothing darkens at contact. SSAO alone will not catch it at that pixel scale — add per-instance contact darkening. |
| RCORE-POST | 10 | **DOF focused on the wrong subject.** Focal plane sits on a 40 m warehouse; the lower 45% of frame — the dock the player stands on — is smeared past legibility. Focus at 6–10 m, cut CoC ~3×, clamp near-field CoC to 12–16 px. |
| RCORE-POST | 9 | **Histogram still compressed.** min 0.050 / max 0.955 / 54.1% of pixels in the middle 40%. Nothing blown, nothing black. Also: saturation has been *overcorrected* on some shots (buildings pushed red-salmon) — verify per-shot, the shots currently sit on opposite sides of correct. |
| RCORE-MATERIAL | 9 | **The largest, closest foreground object in `level_bravo` is untextured** — a flat orange gradient owning ~18% of pixels at ~1.5 m from camera, zero mesoscale, zero micro. Surfaces that go smooth as they approach the camera fail the rubric. |

### B. Then write `skills/` — THE SECOND DELIVERABLE, NOT STARTED
The original brief: *each agent writes a skill file in a new `/skills` folder capturing every step
needed for a future agent to reproduce the exact level of quality they achieved.*

**Do not write these until the quality bar is actually met** — a skill claiming to teach AAA
rendering, written from a 3.8/8.5 codebase, is worse than no skill. Once the loop converges, have
each lane author a skill from what it actually did. Candidates, one per hard-won technique:

`procedural-pbr-bakery`, `physical-sky-and-aerial-perspective`, `cascaded-shadows-and-gtao`,
`filmic-grade-and-tonemapping`, `gpu-particles-and-vfx`, `gerstner-water`, `wind-driven-vegetation`,
`procedural-architecture-grammar`, `fps-weapon-feel`, `diegetic-hud-from-reference`,
`deterministic-screenshot-harness`, `multi-agent-lane-architecture`, `blind-ab-critic-loop`.

The last three are the meta-skills and arguably the most transferable — they are *why* the rest
was achievable at all.

---

## 8. Traps that have already cost this project hours

**Backticks in GLSL template literals.** Someone writes a shader comment quoting an expression in
prose — ``// the previous form was `1 - clamp(x, 0, 1)` `` — and the backtick terminates the
template string, so the rest of the shader parses as TypeScript and the error surfaces far from
the cause. Has broken the build **three times**. Now caught by boundary CI
(`glsl-unescaped-backtick`).

**Whole-valued constants interpolated into GLSL float maths.** `const S = 3.0` stringifies as
`"3"`, and GLSL ES 3.00 has no implicit int→float, so `1.0 + ${S} * v` fails to compile, the pass
never links, its draw is silently dropped, and *every frame comes out unexposed*. Latent, too: a
constant is safe at 1.42 and breaks the moment someone tunes it to 2.0. Caught by
`glsl-int-literal`.

**Integration-only failures.** Every serious bug in this project passed typecheck, boundaries and
build, and existed only because lanes were finally in one frame: a shader permutation cap set
before any lane existed (24 vs a measured 44); arch voussoirs rotated 90° wrong at the haunches but
correct at the crown; a depth prepass covering only opaque geometry, so TAA reprojected water and
grass as *sky*; water writing velocity in NDC where the frame uses UV; water decoding a linear-metres
depth target as hardware depth. **Always run an integration pass after a parallel wave.**

**Parallel agents sharing `dist/`.** They clobber each other and produce failures that look like
code bugs. Every agent sets `IRONSIGHT_DIST=dist-<lane>`.

**The reference corpus leaking into git.** `tools/compare/` A/B sheets composite a real Battlefield
frame beside ours, and were briefly tracked. Purged from history; `reference/` and `tools/compare/`
are both gitignored now. **Keep it that way.**

---

## 9. The two documents that are law

- **`docs/LOOK_SPEC.md`** (1.1 k lines) — the art-direction target, derived by measuring real
  gameplay frames. Photometric units end to end, a blackbody sun-colour ramp per elevation,
  exposure *derived* (`0.18 / L_grey`) rather than dialled by eye. Where it gives a number, use
  that number.
- **`docs/HUD_SPEC.md`** (1.3 k lines) — the HUD, element by element, with quantitative positions,
  stroke weights, colour tokens and motion curves, reverse-engineered from real frames.

Also `docs/AAA_RUBRIC.md` (how critics score) and `docs/REFERENCE_INDEX.md` (which reference frame
to blind-A/B each shot against).
