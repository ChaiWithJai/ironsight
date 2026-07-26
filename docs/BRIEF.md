# IRONSIGHT — Project Brief

**Read this file in full before touching any code. It is the shared contract for every agent on this project.**

## What we are building

`IRONSIGHT` — a browser-native, first-person military shooter built on Three.js, targeting the
visual and tactile quality bar of a modern AAA Battlefield title. Single map, Conquest mode,
bots, destructible cover, full weapon feel, cinematic rendering.

One canvas. No server. No downloaded art assets. Everything — every texture, every mesh, every
sound — is **generated procedurally in code at load time**. That constraint is not a limitation
to apologise for; it is the design. It is also what makes the repo self-contained and what makes
the accompanying skills reusable.

## The setting

**"HARBOUR REACH"** — a Mediterranean/Levantine coastal town at golden hour. Sun low and hard off
the water, long shadows raking across sandstone and stucco, dust and pollen suspended in the air,
palms moving in an onshore wind. A stone breakwater, a half-sunk freighter, a market square, a
minaret, a fuel depot. Three capture points: **ALPHA** (market square), **BRAVO** (harbour cranes),
**CHARLIE** (old fort on the headland).

Colour language: warm sandstone and ochre against desaturated teal shadow and sea. High dynamic
range — blown highlights on the water, deep but never crushed shadows, strong aerial perspective
pushing the headland into haze.

## The reference corpus

`reference/` holds real Battlefield frames, pulled down locally as a calibration target. It is
gitignored — never committed, never shipped — and **no pixel, texture, mesh, font or level layout
from it enters the build.** We study it to learn which *properties* to reproduce with our own
procedural code.

| Directory | Contents | Use it for |
|---|---|---|
| `reference/gameplay/` | **135 real in-game player screenshots** (BF6, 2042, BFV, REDSEC). Real HUD, real first-person framing, real in-engine lighting. | **This is the ground truth.** HUD layout, viewmodel framing, achievable in-engine look. |
| `reference/battlefield/` | 48 official press screenshots. Staged, no HUD, often third-person. | Lighting *ambition* only. Do not take framing or UI cues from these. |

The distinction matters: press shots are bullshots rendered at cinematic settings with no HUD and
impossible camera angles. The gameplay captures are what the game actually looks like while you
play it, and that — plus its HUD — is what we are matching.

Derived specs, which are law once written:
- `docs/LOOK_SPEC.md` — the rendering and art-direction target, as implementable numbers.
- `docs/HUD_SPEC.md` — the HUD, specified element by element.
- `docs/REFERENCE_INDEX.md` — which reference frame to blind-A/B each of our shots against.

## The quality bar

The test is not "does it look good for a browser game." The test is:

> If you showed this frame to someone with no context, would they believe it was a screenshot
> from a shipped AAA console/PC title — or would they immediately clock it as a WebGL demo?

And, operationally, the blind A/B: `./tools/compare.sh --ours <shot> --ref <reference>` builds a
two-panel sheet labelled only A and B with the sides randomised. A critic who cannot reliably
pick ours out is the goal state.

Things that instantly betray a hobby WebGL demo, all of which are **defects** on this project:

- Flat untextured or single-colour surfaces; visible tiling; obvious UV stretching
- No micro-detail — surfaces that stay smooth as the camera approaches
- Hard, aliased shadow edges; shadow acne; peter-panning; a single shadow cascade
- Uniform ambient light; no bounce, no occlusion in creases and corners
- Skies that are a gradient; clouds that are a scrolling texture
- Geometry that meets the ground with a hard seam and no debris, dirt or transition
- Perfect right angles and perfectly straight edges everywhere; zero wear, chipping or grime
- Particles that are round white blobs with additive blending
- A viewmodel that floats, does not react to movement, and has no recoil follow-through
- UI that looks like default HTML — system fonts, pure white, no hierarchy
- Everything in focus, evenly lit, at the same level of contrast

Things that read as AAA and are therefore **requirements**:

- Physically-based shading with real energy conservation, and materials that respond correctly
  at grazing angles
- Layered material detail: base albedo → mesoscale variation → micro-normal → wear masks driven
  by curvature/ao/height, so nothing repeats visibly at any distance
- Cascaded shadow maps with stable texel snapping, slope-scaled bias, soft contact-hardening
  penumbrae
- Ambient occlusion that darkens contact points, plus indirect light with directional variation
- A physical sky with real Rayleigh/Mie scattering, aerial perspective, and volumetric light
- Filmic tonemapping with correct colour management, bloom that only blooms genuinely bright
  things, and subtle lens character (vignette, aberration, grain) used with restraint
- Temporal antialiasing that resolves cleanly, plus motion blur tied to actual per-object motion
- Weapon feel: recoil with recovery, sway coupled to look input, bob coupled to velocity,
  ADS transition with FOV and hand-position change, muzzle flash that lights the world
- Sound that has weight, distance falloff, and environmental tails

## Hard technical constraints

| Constraint | Value |
|---|---|
| Renderer | Three.js `0.185.x`, WebGL2 |
| Language | TypeScript, `strict: true`. `npm run typecheck` must pass with zero errors. |
| Bundler | Vite 7 |
| Physics | `@dimforge/rapier3d-compat` |
| Assets | **Zero binary art assets.** No `.gltf`, `.png`, `.hdr`, `.mp3` in the repo. Everything procedural. |
| Network | **Zero runtime network requests.** No CDNs, no fonts, no analytics. |
| Node | Nothing to configure. Every `npm` script that needs a modern runtime routes through `tools/with-node.sh`, which picks a node ≥ 20.19 itself (override with `IRONSIGHT_NODE_BIN`). `npm run typecheck` runs on whatever `node` you have. `./tools/shoot.sh` picks node ≥ 20 for playwright the same way. |
| Target frame budget | 16.6 ms at 1080p on a discrete GPU; must degrade gracefully via the quality tiers. |

## Commands

```bash
npm run verify           # typecheck + boundary CI + build. THIS is the gate.
npm run typecheck        # must be clean before you finish
npm run boundaries       # tools/check-boundaries.mjs — never weaken it to pass
npm run build            # must succeed
./tools/shoot.sh --list  # list registered shots
./tools/shoot.sh NAME    # capture one shot to tools/shots/NAME.png
./tools/shoot.sh         # capture all shots
```

`npm run verify` is green right now and must stay green. If the boundary check
fails, fix the code — the rules in `tools/check-boundaries.mjs` are the ones that
keep a dozen parallel agents from silently breaking each other.

`./tools/shoot.sh` builds, serves `dist/`, drives headless Chromium and writes PNGs. It exits
non-zero on build failure, uncaught page errors or console errors — so a green shoot is also a
smoke test. It is **slow** (software rasteriser): budget ~10–60 s per shot. Capture the one or
two shots you care about, not all of them, while iterating.

## The capture harness

`src/engine/harness.ts` is **locked** — do not edit it. It exposes `registerShot({...})`. Every
subsystem must register at least one shot that isolates its work, in `src/shots/<area>.ts`, so
the visual critics can review your area without hunting for a camera angle.

Shots are deterministic: the render loop is suspended, the RNG is reseeded, and an exact number
of fixed-dt frames is rendered before the grab. Never make a shot depend on wall-clock time.

## Rules of engagement for agents

1. **Stay in your lane.** You own the files listed in your task. Do not edit files owned by
   another subsystem — if you need something from them, it is already in the interfaces in
   `src/engine/types.ts`; if it genuinely is not, add to that file narrowly and say so in your
   report.
2. **`npm run typecheck` must pass when you finish.** Not "mostly". Zero errors.
3. **Look at your own work.** Capture your shot and actually `Read` the PNG before declaring
   done. If you have not looked at a rendered frame, you are not finished.
4. **No placeholders, no TODOs, no `// implement later`.** Ship the real thing.
5. **Comment the non-obvious.** Explain the physics or the perceptual reason for a magic number,
   not what the line does.
6. **Report honestly.** If something is not working, say so. A truthful "SSR is unstable at
   grazing angles" is worth more than a false "done".
