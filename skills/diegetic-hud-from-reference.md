---
name: diegetic-hud-from-reference
description: >
  Build a game HUD that renders inside the 3D canvas (not the DOM), in a single draw call, from a
  code-generated SDF font, driven by real gameplay events — and specced by measuring real reference
  frames rather than guessing sizes. Use when building an in-engine HUD, a screenshot-capturable
  overlay, or any UI that must survive a deterministic capture harness. Proven in IRONSIGHT: the HUD
  responds to real hitmarkers, killfeed and damage via the event bus in live play.
status: PROVEN — the HUD renders in-canvas, its font is baked from code, and it is driven by real
  gameplay events (verified in live play). Honest gaps: a couple of self-flagged spec inconsistencies
  and one approximated damage number through cover.
---

# Diegetic HUD from reference

## Why the HUD lives in the canvas, not the DOM (`src/ui/system.ts`)

The HUD is drawn **into the WebGL canvas as an orthographic pass after tonemapping, at native
resolution** — "there is no DOM UI anywhere." The forcing reason is the capture harness:
`tools/capture.mjs` screenshots the *canvas only*, so a DOM HUD is invisible in every review shot. A
second reason is correctness — drawing UI *before* tonemap (a common hobby-stack tell) would grade and
bloom the interface; this HUD is authored in sRGB and never tonemapped, never graded, never bloomed,
never TAA'd. The pass is registered in `afterBoot` (`graph.addPass(new HudPass(...))`), not in the
factory body, for the reason every cross-cutting pass is (see the lane-architecture skill).

## One draw call for the entire interface (`src/ui/renderer.ts`)

The whole HUD is **one draw call**: an interleaved vertex stream (`HudBatch`) fed to a single material
whose fragment program branches on a per-vertex mode — SDF glyph, rounded box, diagonal-stripe hatch,
radial glow, minimap plate. A **premultiplied-alpha blend** expresses both normal alpha marks *and*
additive glow in one blend state, so no state changes are needed mid-interface. Two non-obvious
correctness notes the code records: the material is double-sided because y-down device pixels flip
triangle winding, and there is a `uToLinear` switch for when the target is sRGB-encoded.

## The font is baked from code, analytically (`src/bake/font.ts`)

There are **no font files** — no `.woff`, no `document.fonts`. Glyphs are defined as centre-line
polyline strokes ("skeleton plus pen"), and the SDF is computed **analytically** as the true signed
distance to a capsule chain — *not* an 8SSEDT of a rasterised glyph, which would be softer and
resolution-dependent. Lowercase folds to uppercase cells. Non-text shape vocabulary (ownership
circles/diamonds, skulls, pictograms) lives alongside in `src/ui/glyphs.ts`. This is what keeps the
"zero binary art assets" invariant true for typography, and it makes the atlas deterministic for the
capture harness.

## Driven by real gameplay events, not a demo timeline (`src/ui/state.ts`)

Every number comes off the contract: `GameMode.state`, `PlayerService`, `WeaponService`,
`LevelService`, and — crucially — the **`FxBus`** for killfeed, hitmarkers and damage direction. The
HUD state subscribes to real bus events (`fx.on('impact')`, `fx.on('hitmarker')`, killfeed, damage
taken, banner). A hitmarker is world-anchored on the victim; the damage number is recomputed from the
public damage curve because the `hitmarker` event carries no amount. The shot files that pose the HUD
for captures use the *same* `state` object; the only difference in live play is that the real bus
feeds it. This is why `HANDOFF.md` §A0 can claim, verified in live play, that "the HUD responds to
real gameplay (hitmarkers, kill banner, killfeed) via the FxBus" — it is not a scripted overlay.

This is the sharp contrast with the screenshot-harness trap (see that skill): a HUD posed for a
screenshot proves the *layout*; a HUD wired to the event bus and watched in live play proves the
*feedback loop*. IRONSIGHT built both, and only the second is a real claim.

## Spec by measurement, not by taste (`docs/HUD_SPEC.md`)

Every position, stroke weight, colour token and type-scale step was **measured off real reference
gameplay frames and written down as numbers**, then adapted — the spec contains measurements, not
third-party pixels. Load-bearing invariants it captured: ownership communicated by *shape* (a friendly
is a circle, an enemy a diamond) so the HUD reads under desaturation; a slashed zero; a frameless
minimap; ticket-bar fill direction; no scrim behind the killfeed. A resolution-independent unit
system (`1u = viewportHeight/100`, scaled by `hudScale`) so the layout holds at any canvas size.
Elements with no real-world referent (damage-direction indicator, bleedout) are explicitly flagged as
inventions rather than measurements — the same honesty discipline the whole project runs on.

## Honesty — proven vs rough edges

- **Proven:** in-canvas single-draw rendering, the analytic code-baked SDF font, and the event-bus
  wiring that makes the HUD respond to real combat in live play.
- **Rough edges (self-flagged in code/spec):** a glow-threshold direction inconsistency in
  `src/ui/theme.ts`; the through-cover damage number reads high because residual energy is not on the
  contract; and a handful of HUD elements are acknowledged inventions rather than reference
  measurements. None of these are visual-quality-bar defects — the HUD is not among the lanes flagged
  as below the 6.0/8.5 bar (those are LIGHT/POST/MATERIAL) — but a future author should close the spec
  inconsistencies before treating `HUD_SPEC.md` as gospel.

## Key files
- `src/ui/system.ts` — the orthographic HUD pass, `afterBoot` registration, service/bus wiring.
- `src/ui/renderer.ts` — the one-draw-call interleaved batch and its multi-mode fragment program.
- `src/ui/state.ts` — the FxBus subscriptions that make it react to real combat.
- `src/bake/font.ts` — the analytic code-baked SDF font; `src/ui/glyphs.ts` — shape vocabulary.
- `src/ui/theme.ts` — tokens; `docs/HUD_SPEC.md` — the measured spec.
