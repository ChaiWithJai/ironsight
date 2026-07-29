---
name: procedural-architecture-grammar
description: >
  Generate a whole believable town — walls with openings, arches, roofs, stairs, balconies,
  landmarks like cranes and a fort — from code, as a handful of draw calls, seeded so editing one
  building does not reshuffle the rest, with colliders and destructible tagging derived from the same
  geometry. Use when procedurally generating architecture or level geometry, when you need a large
  static world in few draws, or when deriving physics/nav from generated meshes. Proven in IRONSIGHT:
  HARBOUR REACH builds, stands, and captures cleanly.
status: PROVEN as a generation technique — the town builds deterministically and renders in ~15–17
  draws. Honest gaps: several collider/destructible tagging bugs (masonry unbreachable, crane footings
  collider-only, step treads mis-tagged) and the overall frame sits below the visual bar.
---

# Procedural architecture grammar

## The substrate: one vertex stream per material (`src/level/kit/builder.ts`)

The whole town is built with a hand-rolled `MeshBuilder` that appends into **one vertex stream per
material**, so HARBOUR REACH — a full Mediterranean coastal town — draws in roughly **15–17 draw
calls**. That draw-call discipline is the reason a procedural town is affordable at all; per-draw CPU
overhead, not the GPU, is the real 1080p ceiling (`docs/ARCHITECTURE.md` §11). Primitives worth
lifting:

- **`quad` / `quadOrtho`** build a Gram-Schmidt texture frame — the fix for black arch-spandrel
  slivers where a naive UV frame degenerates.
- **`chamferBox`** (a 44-triangle bevelled box) is called out as "the single highest-yield shape
  change" — a bevelled edge catches a highlight and instantly reads as built rather than
  programmer-art, for 20 extra triangles.
- **Per-instance UV phase** (`setUvShift`) so 200 sandbags or 40 windows do not share one identical
  stain — the cheapest possible break in obvious repetition.
- **A recorded winding trap**: every `cylinder` (silos, tanks, drums) was rendering **inside-out**
  until the winding was fixed; and `tube` looks identical but has the *opposite* handedness and is
  correct — "do NOT fix it." A perfect example of an integration-only bug that a screenshot reveals
  and a unit test does not.

## The grammar: openings make a wall read as a building (`src/level/kit/wall.ts`)

A wall is not a box — it is a wall with a vocabulary of **openings** (window, door, arch, vent, void,
bricked-up), plus glass panes, shutters (0–3, including one hanging off a single hinge), balconies,
awnings, and a **recess/reveal** so the facade has depth. The presence of variation *and* of small
broken things (the one crooked shutter) is what tips a facade from "generated" to "lived in." Kit
modules compose upward: `kit/detail.ts`, `kit/ground.ts`, `kit/wall.ts`.

## Landmarks, each on its own RNG stream (`src/level/harbour-reach.ts`, `landmarks/`)

The set pieces — harbour (quay, seawall, lattice-truss gantry cranes, warehouses, container yard, fuel
depot), town (market hall, mosque, minaret), the old fort, and a half-sunk freighter wreck — are each
built from **its own forked RNG stream**, seeded from a fixed level seed (`0x48524348`, 'HRCH'). The
payoff: editing one landmark does not reshuffle the whole town, because every other stream draws the
same numbers as before. This is the same forked-RNG determinism the bake pipeline relies on, applied
to authoring.

## Macro shape is a shared analytic function (`src/engine/macro.ts`)

`MACRO_TERRAIN` is a CORE-owned, **frozen analytic silhouette** (sines, gaussians, smoothsteps — no
noise lib, no state, worker-safe) evaluated by *both* the terrain (as the base layer under erosion)
and the level (to place buildings). Because both sides evaluate the same function, LEVEL, VEG, WATER
and AI can place things correctly *before* TERRAIN's eroded heightfield exists, and the buildings sit
on the ground the first time they are composed. The contract is that erosion must not move the macro
silhouette by more than a couple of metres; LEVEL cross-checks `terrain.heightAt` against the macro
and falls back on a disagreement > 6 m.

## Colliders and destructibles are derived, not authored (`src/level/colliders.ts`)

A whole-level pass emits colliders and tags destructibles from the same geometry: it enforces an
occluder budget, validates degenerate/NaN/below-seabed boxes, and classifies which solids are
breakable. Colliders are a **deliberate second representation** (boxes and convex hulls for ~90% of
built geometry, trimesh only for the freighter/cranes/fort) — never `mesh.geometry`, whose trimesh
cost for a whole town would be ruinous. Destructibles are extracted into `BatchedMesh` instances that
the destruction system can hide, and thinned to a budget by a `volume·coverValue` score. Five baked
Voronoi fracture sets in a unit box are re-proportioned per solid.

## Honesty — proven vs the known bugs

- **Proven:** the town builds deterministically, stands, renders in ~15–17 draws, and captures
  exit-0. The generation grammar and the forked-RNG authoring are genuinely reusable.
- **Known tagging bugs (all confirmed in code, all from `HANDOFF.md` §A0):**
  1. **Masonry/concrete cannot practically be breached** — health ~1150/m³ with a modest explosive
     multiplier; 10–12 frags leave it intact. Whether that is correct design or a bug is an *open
     product decision* (issue #3), not a settled feature.
  2. **Three BRAVO crane footings are collider-only** — some crane geometry and container loads are
     emitted deliberately without a collider or nav, so the geometry stays standing when it "breaks."
     The boot log names every collider-only destructible.
  3. **Flat ALPHA step treads are mis-tagged destructible** — `classifyFor()` tags low sandstone/
     rubble boxes (≤ 2.2 m) as breakable masonry, and flat step treads fall inside that window, so
     fragging the ALPHA terrace deletes a flight of steps.
- **Below the visual bar:** the whole frame self-assesses at ~6.0/8.5. The architecture geometry is
  not itself among the named worst defects (those are lighting/post/material), but a future author
  should not treat these shapes as a finished AAA art pass.

## Key files
- `src/level/kit/builder.ts` — `MeshBuilder`, `chamferBox`, `quadOrtho`, per-instance UV phase, the
  winding traps. `src/level/kit/wall.ts` — the opening grammar.
- `src/level/harbour-reach.ts` — build orchestration, per-landmark forked streams, the level seed.
- `src/level/landmarks/` — harbour, town, fort, freighter.
- `src/engine/macro.ts` — the shared analytic macro silhouette.
- `src/level/colliders.ts` — derived colliders + destructible classification (and the three bugs).
