---
name: procedural-pbr-bakery
description: >
  Generate every texture, mesh and sound in a real-time app at load time in code, with zero binary
  art assets and zero runtime network requests. Use when you want a bundle that is a few JS files
  and an HTML page, when you need deterministic assets a screenshot harness can reproduce, or when
  you want CPU/GPU noise parity so physics and the vertex shader agree. Proven in IRONSIGHT: a whole
  military-shooter town bakes on-machine in ~30–60 s. Honest caveat: the pipeline is proven; the
  surface *look* still sits below the project's own visual bar.
status: PROVEN as a PIPELINE — bakes run, shots capture, the zero-asset/zero-network invariant holds
  exactly. The material tuning (mesoscale/micro detail, water) is below the visual bar — see honesty.
---

# Procedural PBR bakery

## What is proven, in one sentence

IRONSIGHT ships **zero binary art assets** — no textures, meshes, audio, or fonts — and makes **zero
runtime network requests**; the terrain, buildings, grass, sky, weapon, HUD font atlas and every
sound are generated in code in the first ~30–60 s, and the shipped bundle is three JS files plus an
HTML page (`README.md`). That property is real and CI-enforced (a boundary rule bans any
`from '….png|glb|mp3|…'` import; see the multi-agent-lane-architecture skill). This skill is how.

## The two devices, and the rule for choosing (`docs/ARCHITECTURE.md` §6)

- **`GpuBakeDevice`** — anything that ends up as a *texture*: fullscreen procedural fragment shaders,
  MRT bakes, ping-pong `iterate()` for erosion/flow, layer writes into `DataArrayTexture` /
  `Data3DTexture`, octahedral impostor rendering. `src/bake/gpu-device.ts`.
- **`WorkerPool`** — anything that ends up as a *typed array*: meshes, navmesh, audio PCM.
  `src/bake/worker-pool.ts`.

Two non-negotiable properties of the worker pool: payloads are **transferable `ArrayBuffer`s, never
`SharedArrayBuffer`** (the dev server sets no COOP/COEP headers, and the bake must not depend on
headers only the capture server sends), and **`run()` must fall back to inline main-thread execution**
when `workerCount` is 0 or worker construction fails — no bake step may be *blocked* on workers
existing. Under SwiftShader (the capture path) `workerCount` is 0 and every job runs inline; the pool
also returns results in **input order, not completion order**, so the output is deterministic.

## Declaration is separate from execution — and that is what makes it fit a budget

`AssetRegistry.define()` (`src/bake/registry.ts`) is **declaration only**: it throws on a duplicate id
and throws if called after `bakeAll` has run, because the scheduler must see the *whole cost total up
front*. `bakeAll` topo-sorts over `dependsOn` (Kahn's algorithm, **tie-broken by declaration order**
so the sequence — and every forked RNG stream inside it — is byte-identical on every machine), then
plans degradation once, then runs. This is why a lane's bakes are declared in a free
`register<Key>Bakes(assets, quality)` function that runs *before* any service instance exists (see the
lane-architecture skill).

**Over-budget policy: degrade resolution, never drop a step.** When Σcost exceeds
`BakeProfile.unitCeiling`, `src/bake/units.ts` halves `grantedTexelSize` on the most-expensive steps
first (deterministic order, floor 128²), because *a missing material is a defect; a 256² material is
merely softer.* The whole lane is sized by one hard constraint: `tools/capture.mjs` fails at 300 s
waiting for `ready`, and SwiftShader runs fragment shaders 20–60× slower — so the ceiling must be
enforced from day one, not retrofitted after four lanes have each added 300 units of work.

## Caching: cache typed arrays, not textures (`src/bake/cache.ts`)

Only **worker** jobs are cached (IndexedDB, keyed by `hash(job, payload, profile)`). A baked texture
is a live `WebGLTexture` that cannot survive a reload and would cost more to read back than to
re-render, so textures are never cached. Caching is **deliberately off inside the capture harness** —
Playwright's fresh profile means a cache would never hit, and a blocking IndexedDB open is 300 s
wasted. Every failure mode (private browsing, quota, corruption) resolves to null and the bake just
runs. The consequence for anyone sizing this: **the capture path always cold-bakes**, so the
cold-bake budget is what you must fit, not the warm dev path.

## Two bake-time rules that are not optional

1. **Toksvig roughness mipping** (`src/bake/mips.ts`, `MipMode.RoughnessToksvig`). Whenever a normal
   map is mipped, fold its per-mip normal variance into the matching roughness mip (via the
   GGX→Blinn power round-trip). Without it, distant metal, glass and stucco sparkle and TAA either
   smears or boils it — a bake-time problem with a bake-time solution, unfixable at resolve time. A
   subtle trap the code records: mip taps must use `texture()` with clamped base/max level, **not
   `texelFetch`**, because GL drivers disagree whether the lod argument is absolute or base-relative,
   which silently samples the wrong level and produces banding visible only on a 512² bake.
2. **CPU/GPU noise parity** (`src/bake/noise.ts` ↔ `src/bake/glsl/`). `TerrainService.heightAt` must
   be *literally* the function the terrain vertex shader displaces with, or players float over bumps
   and sink into dips. Both come from one `NoiseLib`; the mechanism is Wellons' `lowbias32` integer
   hash reproduced bit-for-bit in JS with `Math.imul` + `>>> 0` and a 24-bit unorm exactly
   representable in a float32 mantissa. The integer hash exists *precisely because* `fract(sin(x))`
   cannot be reproduced identically CPU-side. The only legal divergence is float32/float64 rounding
   (~1e-7). Any shader displacement finer than the physics collider cell must be normal-only.

## The uber material: one `onBeforeCompile` for the whole app (`src/render/material/`)

Every lit surface in the repo is one `MeshPhysicalMaterial` customised by the **single
`onBeforeCompile` in the codebase** (CI greps for it), which string-replaces Three's chunk include
points with `IRON_*` chunks. This is what lets sixteen lanes share one lighting model and inherit
cascades, clustered lights, fog/aerial and tonemapping for free — and it is why hand-rolled
`ShaderMaterial`s are CI-banned (they silently lose all four). Load-bearing details:

- **`customProgramCacheKey` must be set** from the spec id + feature bits + defines, because Three's
  default cache key is the *source text* of `onBeforeCompile`, which is identical for every material —
  so without it, two materials with different `#define`s silently share one program.
- **Feature bits that only change a uniform define nothing and are free.** Only bits that change GLSL
  become `#define` permutations. `create()` throws when the permutation cache hits the cap
  (`quality.budgets.shaderPrograms`) with an explicit "reuse a spec id or raise the cap — do not
  smuggle in a variant." The cap being wrong (set to 24 before any lane existed, real count 44) was a
  classic integration-only failure.
- **`registerDeform` is the motion-vector contract.** The identical vertex GLSL is injected into the
  forward, depth, shadow and velocity materials, so shadows and motion vectors cannot disagree with
  the lit pass. The registry rejects a `prevPosition` containing `;` because it must be an expression,
  not statements. `registerSurface` (fragment) rejects `discard` — alpha-testing must go through
  `MaterialSpec.alphaTest` so the depth prepass and forward pass agree.
- **The frozen `SurfaceProfile` table** (`src/render/material/surfaces.ts`) is the shared "what is
  this made of" vocabulary read by five lanes that never talk to each other — WEAPONS, VFX, AUDIO, AI,
  PHYS — carrying density, penetration, hardness, ricochet, friction, restitution and acoustics per
  `SurfaceId`, plus a base-colour palette so an unbaked frame reads as the right *film* rather than
  grey clay.

## The GLSL traps every procedural-shader bake will hit (CI-enforced — see lane skill)

- **Whole-valued constants interpolated into GLSL float maths**: `const S = 3.0` → `"3"` → GLSL ES
  3.00 has no int→float, the pass fails to link, its draw is dropped, every frame comes out unexposed.
  Latent: safe at 1.42, breaks at 2.0. Route through `.toFixed(n)`.
- **Reserved words that look like variables** (`patch`, `sample`, `filter`, `input`, `output`,
  `common`, `active`): "Illegal use of reserved word" at an assembled-shader line matching nothing in
  your source.
- **Backticks in GLSL template-literal comments** silently terminate the string.
- **`EXT_color_buffer_float` must be explicitly requested** or every float target falls back to 8-bit
  and a bake becomes framebuffer-incomplete (a black texture in *every* material). Three requests it
  only for some format paths; the bake device re-requests it idempotently.

## Honesty — what is proven vs below the bar

- **Proven:** the pipeline. Bakes run, 48–65 deterministic shots capture exit-0, the zero-asset and
  zero-network invariants hold exactly, CPU/GPU noise parity is a real correctness win the physics
  depends on, and the whole thing fits the 300 s cold-bake budget under software rendering.
- **Below the bar:** the *surface look*. The project self-assesses at ~6.0 against an 8.5 bar
  (`README.md`), with named material-related defects: a large near-camera foreground object reading as
  a flat gradient with no mesoscale detail, and water weaker than the rest of the frame. The
  `DataArrayTexture` surface arrays described in the architecture are allocated but **never sampled**
  — the uber material binds each material's own `TextureSet` instead (a documented deviation to keep
  per-material resolution). And a recorded lesson worth internalising: several early "tiling" defects
  (a diagonal lattice on sand, turtle-shell boulders) were the *shader drawing the artefact*, not the
  texture repeating — driving a recessed mortar joint and a tonal field off one amplitude parameter.
  **Do not cite this skill as proof of AAA material quality; cite it as proof the generation pipeline
  works and is deterministic.**

## Key files
- `src/bake/registry.ts` (`define`, `bakeAll`, topo sort, degradation planning) ·
  `src/bake/gpu-device.ts` · `src/bake/worker-pool.ts` (inline fallback, input-order results) ·
  `src/bake/units.ts` (unit-ceiling degradation) · `src/bake/cache.ts` · `src/bake/mips.ts`
  (Toksvig) · `src/bake/noise.ts` + `src/bake/glsl/` (CPU/GPU parity).
- `src/render/material/factory.ts` · `iron-material.ts` (the single `onBeforeCompile`) ·
  `chunks.ts` · `deform.ts` · `surfaces.ts`.
- `docs/ARCHITECTURE.md` §6, §11; `tools/check-boundaries.mjs` (the CI rules above).
