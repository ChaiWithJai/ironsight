---
name: rendering-lanes-below-bar-traps
description: >
  The genuinely-reusable engineering decisions and hard-won traps from IRONSIGHT's real-time
  rendering lanes — physical sky and aerial perspective, cascaded shadows and GTAO, filmic AgX
  grading, Gerstner water, and wind-driven vegetation. Use this for the PITFALLS and the mechanism
  choices, NOT as a recipe for AAA visuals. These lanes are engineering-complete but the project
  self-assesses their rendered result BELOW its own visual bar (~6.0 / 8.5), so their tuning is not
  a proven target to copy.
status: DELIBERATELY NOT a per-technique "achieve AAA X" skill. HANDOFF.md §7B forbids writing those
  from a below-bar codebase. This file captures what IS proven — the traps and the architectural
  decisions — and is explicit about what is not.
---

# Rendering lanes: below-bar traps (read this instead of five AAA recipes)

## Why this file exists and is shaped this way

The original skills brief listed `physical-sky-and-aerial-perspective`,
`cascaded-shadows-and-gtao`, `filmic-grade-and-tonemapping`, `gerstner-water` and
`wind-driven-vegetation` as candidate skills. **They are consolidated here instead of shipped as five
standalone "how to achieve AAA X" skills, on purpose.** `HANDOFF.md` §7B is explicit: *"Do not write
these until the quality bar is actually met — a skill claiming to teach AAA rendering, written from a
3.8/8.5 codebase, is worse than no skill."* The project sits at ~6.0 against an 8.5 bar with 0/8 hero
shots passing, and the critic score is inside its own noise floor. So a recipe promising AAA sky or
water would be dishonest.

But these lanes did produce genuinely hard-won, transferable material: sound mechanism choices and
specific traps that cost real days. Throwing that away would waste the most expensive lessons in the
project. This file preserves them, cited, and clearly labelled — the *traps* and the *decisions* are
reusable; the *tuning numbers* are a below-bar starting point, not a target.

**One warning up front for anyone continuing these lanes:** the intuitive mental model of some of
these features does not match the code. Aerial perspective is analytic in-shader, *not* a 3D LUT.
GTAO bent normals are a declared-but-unimplemented stub. There is no dedicated temporal-AO denoise
(it is spatial bilateral plus TAA). Grade is procedural GLSL, not a `.cube` LUT. Grounding new work
on the intuitive model will misdescribe the actual code.

---

## Physical sky & aerial perspective (`src/world/sky/`)

**Reusable decisions.** A Hillaire-style atmosphere baked to three LUTs *once at load* —
transmittance (256×64), multiple-scattering (32×32, the `L₂/(1−f_ms)` second-order term), and a
sky-view *atlas* of 24 sun-elevation slices — so **time of day becomes a texture coordinate instead
of a per-frame re-integration**, and the lane registers no per-frame render pass at all. Sun colour is
a 7-entry blackbody elevation ramp (`model.ts`), with the sun *disc* kept near-white and the
reddening left to atmospheric extinction. A dirty flag (`DIRTY_ANGLE_DEG = 0.15`) gates the per-frame
uniform refresh.

**Trap / deviation.** Aerial perspective is **applied analytically in-shader** by overriding Three's
fog chunks and evaluating `surface·exp(-τ) + inscatter·(1−exp(-τ))` in linear space before the
tonemapper — the froxel/3D-LUT approach was deliberately declined. The sun pose is smuggled through a
`THREE.Fog`'s three scalar fields. If you expected a 3D aerial LUT, it does not exist here.

**Below-bar reality.** The named defect is an **over-strong near-field blue veil** (`README.md`).
The code has *multiple targeted fixes* for it — a haze-inscatter build-up, a surface-radiance-
normalised local-visibility gate with a physical floor, a `HAZE_ROLLIN` divergence cap — but the code
comments themselves admit the visibility term is a stand-in until a real sky-visibility/AO signal
exists. So: honestly attacked, not proven cleared.

---

## Cascaded shadows & GTAO (`src/render/lighting/csm.ts`, `gtao.ts`, `shading.ts`)

**The marquee reusable technique — golden-hour cascade stability.** A **sphere** fit of each frustum
slice (rotation-invariant, unlike a box fit) whose centre is **snapped to a world-space texel grid in
light space**. This is *the* fix for the worst case the whole project warns about
(`docs/ARCHITECTURE.md` §11): a sun 6–10° up makes cascade frusta extremely oblique, texel density
collapses along the light direction, and without world-space snapping the entire frame crawls as the
camera moves. Tier-driven splits and **per-cascade update cadence** (`[1,1,2,4]` — distant cascades
amortised, keeping last frame's atlas) are a real perf lever. The atlas stores **metres-from-plane in
a 32-bit-float channel**, which is what lets the fragment side compute a physical PCSS penumbra. A
double-sided depth material is a deliberate fix for single-sheet occluders casting no shadow.

**GTAO reusable bit.** A ground-truth cosine-arc horizon integral marched at **three radii in one
pass** — far (~10 m, sky occlusion), near (~0.55 m, contact), micro (~0.13 m, pebble-scale) — packed
into separate channels, with contact shadows as a separate short screen-space sun-ray march.

**Traps / deviations.** **Bent normals are a stub** — the type, the quality flag and the asset key
all exist, but nothing writes or reads a bent-normal buffer. **There is no temporal AO denoise** — the
only denoise is a spatial depth/normal bilateral resolve, and the per-frame dither relies on the TAA
pass to average it (so any temporal AO obligation is inherited by TAA, not owned here).

**Below-bar reality.** The two headline critic defects were *no cast shadows in `level_bravo`* and *no
AO on debris*. Both have plausible root-cause fixes in code (the double-sided depth material; the
micro-occlusion radius and shortened contact offset) but **neither is proven reversed against the bar**
— there is no in-repo capture showing `level_bravo` now reads darker at the wall than in the open.

---

## Filmic grade & tonemapping (`src/render/color.ts`, `passes/`)

**Reusable decisions, and the one that generalises best.** **Use AgX, not the ACES RRT, for a warm
palette.** The code carries the explicit reasoning: the ACES RRT pushes warm sandstone/ochre straight
into orange hue-clipping at the top of the range — the "everything is orange" hobby-stack tell. The
AgX transform is *ported into the pass* so `WebGLRenderer.toneMapping` cannot silently drift it.
Exposure is **derived, not dialled** — an anchor `EV = log2(L_grey/0.18)` from a photometric grey
target, with the auto-exposure pass metering a centre-weighted log-average and clamping ±0.75 EV
around the anchor (and using the converged clamped meter, not the frozen anchor, under deterministic
capture). Bloom threshold is **defined in scene-linear-after-exposure** (`BLOOM_THRESHOLD_LINEAR`),
re-derived from the composed curve, *precisely because* a literal "1.05" from a spec is a different
tonemapper's white point — so only genuinely bright things bloom regardless of scene luminance. A
subtle fix worth stealing: the **vignette was moved in front of the tone curve** as a scene-linear
exposure reduction, because applied after the grade it capped every frame below display white.

**Trap / deviation.** There is **no 3D grade LUT** — the grade (black point, contrast about a pivot,
vibrance, split-tone, white-point shoulder) is procedural GLSL. If a downstream task expects a `.cube`
to edit, the honest artefact is the shader.

**Below-bar reality.** The named defects were a **compressed histogram** and, on some shots,
*over*-corrected saturation. The code widened the IQR (metered exposure, luminance-domain contrast S,
white-point shoulder) and openly *concedes in comments* that p75 still exceeds the spec ceiling on
sky-heavy frames and flags the >250 clip fraction as a deliberate stated deviation. Improved and
honestly bounded, not cleared. This is also the lane most exposed to the GLSL int-literal trap
(grading constants get retuned constantly, and `3.0`→`"3"` un-exposes every frame) — see the
lane-architecture skill.

---

## Gerstner water (`src/world/water/`) — the weakest lane, per the authors

**Reusable technique.** A **Gerstner sum-of-sines from a Phillips spectrum** (explicitly *not* an
FFT): four bands, 31 components, only the coarsest 15 displacing geometry while ripples are normal-only
per-fragment, amplitudes renormalised to a chosen significant wave height, steepness capped to prevent
self-intersection. The genuinely hard part done right is the **CPU/GPU twin**: because Gerstner
displaces *horizontally*, height at `(x,z)` is not a direct evaluation, so the CPU buoyancy sampler is
a 3-iteration fixed-point root find that must agree with the GLSL sum "to the last term." Foam is
physically sourced (Jacobian-fold whitecaps requiring *both* a high crest and a steep face, plus a
shoreline surf collar following the terrain shore mask).

**Traps / deviations — several, and honest.** **MRT crest-motion velocity is built but hard-disabled**
(`system.ts`): the MRT framebuffer's depth attachment is not the prepass depth buffer, so ~32% of
ocean fragments were being depth-killed — this is one of the project's named integration traps (water
writing velocity in the wrong space). So the sea currently writes only camera-motion velocity via a
proxy plane. **Refraction and the scene-colour copy are conditional** on a fully-live pipeline and
degrade to a sky-probe reflection otherwise. **Buoyancy, splash and the underwater pass are complete
but dormant** — the API exists, nothing in gameplay calls `water.splash()` or reads `isSubmerged`.

**Below-bar reality.** `README.md` names water as *"weaker than the rest of the frame,"* and the code
header is unusually candid about its two compromises (MRT off; SSR fades early at grazing angles).
**This is the clearest "do not write an AAA skill from this" case in the project.** The technique is
correctly chosen and documented; the result is the acknowledged weakest thing in the frame.

---

## Wind-driven vegetation (`src/world/vegetation/`)

**Reusable technique.** One **shared coherent wind field**, computed from the *same constants* on CPU
and in GLSL (`wind.ts`): a mean onshore flow plus three travelling gust plane-waves at incommensurate
wavelengths (26/71/147 m) so the gusting never obviously repeats, a slow yaw wander, and per-instance
flutter from a world-origin hash. Strength is latched once per frame and pushed to every veg material,
so wind cannot disagree between the physics-facing sampler and the shader. Species are procedural
tapered-strip/tube geometry (date palm, olive, dry scrub, agave), each returning two LOD ladders built
with **identical RNG draw order** so an LOD switch is invisible.

**Trap / deviation — a whole deliverable was not built.** There are **no alpha cards and no octahedral
impostors** — a called-out deviation. The far LOD is *decimated geometry*, not a baked octahedral
sheet (the palm's far LOD collapses each frond to a 3-triangle blade). "LOD fade" is **probabilistic
dither** (a stable per-instance cull past a fade radius), not a cross-fade. If a task assumes an
impostor atlas exists, it does not.

**Below-bar reality.** `README.md` names vegetation as *"sparse."* Zero bake units are spent on it. The
scatter/exclusion system (slope/altitude/moisture/shore masks, feathered exclusion discs, scorch/
disturbance) is well-built but the density is deliberately low and reads as sparse.

---

## The one honest takeaway

Every technique above is *architecturally sound and richly documented in code*, and every trap listed
cost real time to find — that is the reusable value. What is **not** reusable is any claim that these
lanes hit the visual bar. If you are continuing this project, the correct next step (per `HANDOFF.md`
§7B and issue #3) is to converge the delta-scored blind critic loop *first*, and only then promote any
of these into a standalone "achieve this look" skill — written from frames that actually pass.

## Key files
- Sky: `src/world/sky/luts.ts`, `model.ts`, `aerial.ts`, `system.ts`.
- Shadows/AO: `src/render/lighting/csm.ts`, `gtao.ts`, `shading.ts`; `src/engine/quality.ts` (tiers).
- Grade: `src/render/color.ts`; `src/render/passes/exposure.ts`, `bloom.ts`, `grade.ts`, `dof.ts`.
- Water: `src/world/water/spectrum.ts`, `glsl.ts`, `passes.ts`, `system.ts`.
- Vegetation: `src/world/vegetation/wind.ts`, `plants.ts`, `field.ts`, `scatter.ts`, `system.ts`.
- Context: `README.md` (the honest quality statement), `HANDOFF.md` §7B, `docs/AAA_RUBRIC.md`.
