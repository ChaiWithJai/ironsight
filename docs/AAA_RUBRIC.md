# The AAA Rubric

This is the standard the visual critics judge against. It exists so "make it look AAA" becomes a
list of falsifiable observations about a specific PNG rather than a matter of taste.

## How a critic must work

1. **Look at the image before reading anything about it.** Form a first impression cold.
2. **Answer the provenance question first**, in one line, before any analysis:
   > *Is this a frame from a shipped AAA title, or a WebGL/hobby demo?*
   Then: *what, specifically, gave it away?* The first thing you noticed is the most important
   finding in your whole review, because it is what a player would notice too.
3. **Then work the checklist below**, scoring each axis 0–10 and citing the specific pixels that
   justify the score. "Shadows are bad" is worthless. "The shadow under the crate at centre-left
   has a uniform 3px penumbra identical to the shadow of the 40m crane, so there is no
   contact-hardening and probably a single fixed-radius PCF kernel" is a finding.
4. **Be harsh.** A 7 is "competent indie". An 8 is "good mobile AAA". Only give a 9 or 10 for
   something you would genuinely accept in a marketing screenshot. Grade inflation on this
   project is a failure of your job — the loop only converges if your scores are honest.
5. **Every finding must be actionable**: name the file or subsystem responsible and the concrete
   change. Findings that cannot be acted on are noise.

## The reference set

`reference/battlefield/` holds 48 officially published store/press screenshots from Battlefield 6,
REDSEC, 2042, V and 1. They are **local only** — gitignored, never committed, never shipped, and
no pixel, texture, mesh or level layout from them enters the build. They exist for one purpose:
to calibrate the critics' eyes so "AAA" is measured against real frames rather than remembered
ones.

**Blind A/B is mandatory.** `./tools/compare.sh --ours <shot.png> --ref <reference.jpg> --out
<sheet.png>` composites our frame beside a reference at identical size, labelled only **A** and
**B**, with the side randomised. The answer key goes to `tools/compare/.keys/` — **critics must
never open that directory before recording a verdict.** It is very easy to rate your own work
generously when you know which panel is yours; the blind is what makes the score mean something.

### Calibration notes taken from the reference set

These are the properties that actually separate those frames from browser 3D. They are ranked by
how much they matter, and every one of them is achievable in WebGL:

1. **There is no clear air. Ever.** Every reference frame is 30–50% particulate by area — dust,
   smoke, humidity, spray, haze. Distant geometry is veiled almost to sky colour. This single
   property does more work than any amount of polygon density, and its absence is the loudest
   possible "hobby demo" signal.
2. **Aerial perspective is far stronger than feels right.** Mountains at distance sit within
   ~15% of pure sky colour. When it looks overdone in isolation, it is probably correct.
3. **The histogram is fully occupied.** Genuinely blown highlights (sky, sun on water, muzzle
   flash) coexist with deep shadows in the same frame. Nothing sits in a comfortable midtone band.
4. **Split-toned grade, never neutral.** Warm highlights against cool/teal shadows, consistently.
   A neutral grey-balanced frame reads as an untouched render.
5. **Depth of field is used aggressively**, especially with a near foreground element. Reference
   character shots have heavy bokeh on both foreground and background.
6. **Strong foreground framing.** Almost every frame has an out-of-focus occluder in the near
   field — a shoulder, a wall edge, a rock — anchoring depth. Empty-foreground compositions look
   flat and amateur by comparison.
7. **Nothing is clean.** Every surface carries grime, streaking, edge wear and colour variation.
8. **Clouds are volumetric objects** with self-shadowing and sun-side silver lining, not painted
   backdrops.
9. **Bloom is confined to true emitters** — muzzle flash, fire, specular glints on water. It is
   never a global haze over the image.
10. **Everything is mid-motion.** Debris in the air, smoke unfurling, vegetation moving. A static
    frame reads as dead even as a still.

### Where we can and cannot win

Be strategic about this. We will **not** beat a shipped title on character-model or facial detail,
and shots should not be composed to invite that comparison. We **can** match or beat it on
atmosphere, light transport, material response, grade and composition — which is precisely what
a first-person shooter's actual hero frame is made of: a viewmodel, an environment, and the air
between them. Compose our shots on our home turf and the comparison is genuinely fair.

Where a number appears below, it is the property to check for, not a value to hardcode.

---

## Axis 1 — Light transport (weight ×3)

The single biggest separator between AAA and hobby work. Check:

- **Sun/key light** is a single dominant, directional, warm source with a hard-ish edge. Shadow
  direction must be consistent across *every* object in frame, including particles and vegetation.
- **Contact hardening**: penumbra width grows with the distance between occluder and receiver. A
  crate touching the ground has a razor shadow at the contact point that softens over its length.
  Uniform-width shadows anywhere in frame = automatic fail on this axis.
- **Cascades**: no visible seam or resolution pop between near and far shadows. Look specifically
  at the 15–40 m band where cascades usually transition.
- **Shadow acne / peter-panning**: no surface stippling; no object floating above its own shadow.
- **Ambient occlusion**: darkening in every crease, corner, under every eave, where every object
  meets the ground. AO must be present but must *not* look like a grey outline drawn around
  objects — that is the classic SSAO halo artefact and is a defect.
- **Indirect light has direction and colour.** Ground bounce should tint the undersides of objects
  with the ground's albedo. Sky light should be cool and come from above. Flat uniform ambient is
  a fail.
- **Sky occlusion**: interiors and shaded sides must lose sky light, not just sun light.
- **Emissives** (muzzle flash, fires, lamps) must actually illuminate their surroundings, and the
  falloff must be inverse-square.

## Axis 2 — Materials and surface detail (weight ×3)

- **No visible tiling.** Walk the eye across every large surface — terrain, walls, water. If you
  can find the repeat, it fails. Look for the tell: an identical stain or crack appearing on a
  grid.
- **Multi-scale detail.** Every surface needs detail at three scales: silhouette/large forms,
  mesoscale (panel lines, bricks, cracks, stains), and micro (grain, pitting, roughness
  variation). Surfaces that go smooth as they approach the camera fail.
- **Roughness must vary spatially and meaningfully.** Uniform roughness reads as plastic. Wear
  should concentrate on edges and high-curvature areas; grime should collect in cavities and
  where water would run. Roughness variation is more important to realism than albedo variation.
- **Correct Fresnel.** Every dielectric must brighten at grazing angles. Check the far end of any
  large flat surface — if it does not gain a specular sheen towards the horizon, the BRDF is wrong.
- **Metals** are coloured in their specular and near-black in diffuse; **dielectrics** have
  uncoloured specular. Getting these backwards reads instantly as "wrong" even to non-experts.
- **Normal maps do real work**: surface detail must self-shade and shift as the light moves, not
  read as a printed pattern.
- **Edge treatment**: no perfectly sharp 90° edges on anything weathered. Real edges catch light
  as a thin bright line because they are chipped and rounded.
- **Colour variation within a material.** Two bricks in a wall are never the same colour.

## Axis 3 — Atmosphere and depth (weight ×2)

- **Aerial perspective**: distant geometry must desaturate and shift towards the sky colour with
  distance. This is the cheapest, strongest depth cue and its absence is very obvious.
- **The sky is a light source, not a backdrop.** Its colour must be present in the shadows.
- **Sky gradient must be physical** — Rayleigh blue overhead falling to a warm scattered horizon,
  with a Mie forward-scattering lobe around the sun. A vertical linear gradient is a fail.
- **Volumetrics**: light shafts and haze must be present where geometry occludes the sun, and must
  respond to the sun's position. Density should vary, not be a uniform fog constant.
- **Clouds** must have internal self-shadowing and silver-lined edges facing the sun. Flat lit
  clouds are a fail.
- **Depth layering**: foreground, midground and background must be separable by contrast and
  saturation alone, even in greyscale.

## Axis 4 — Composition and camera (weight ×2)

- **Dynamic range is used.** There must be genuinely bright and genuinely dark regions. A frame
  where everything sits in the middle 40% of the histogram reads flat and cheap.
- **Filmic response**: highlights roll off smoothly and desaturate towards white as they clip, as
  film does. Hard clipping to pure white, or highlights that stay saturated, reads as digital.
- **Bloom is earned**, not global. Only genuinely bright pixels bleed. A soft glow over the whole
  image is a fail.
- **Lens character with restraint**: subtle vignette, minimal chromatic aberration at the corners
  only, fine grain that sits under the detail rather than over it. If you can *notice* any of
  these individually, they are too strong.
- **Antialiasing resolves cleanly**: no crawling stair-steps on high-contrast edges, no ghosting
  trails behind moving objects, no smearing of thin geometry like railings, wires and grass.
- **Composition has a subject.** Depth cues, leading lines and light should route the eye. An
  evenly-interesting frame is an uninteresting frame.

## Axis 5 — World craft (weight ×2)

- **Nothing intersects wrongly.** No object clipping through another, no z-fighting, no geometry
  floating above the terrain or sunk into it.
- **Ground transitions**: where any object meets the ground there must be debris, dirt buildup,
  a decal or vegetation breaking the seam. A hard line between a wall and the ground is the
  single most common tell of an amateur scene.
- **Scale is believable and consistent.** Doors, steps, railings, windows must read at human
  scale, and must agree with each other and with the player's eye height.
- **Asymmetry and history.** Real places are not on a grid. Things sag, lean, have been repaired
  badly, have accumulated stuff. Perfect repetition of a prop with no rotation/scale/colour
  variation is a fail.
- **Density gradient**: detail should concentrate where the player goes and thin out with distance,
  but never fall off a cliff into empty polygons.
- **Silhouette reads**: the scene must be legible and navigable in greyscale. Cover must look like
  cover.

## Axis 6 — Motion, VFX and feel (weight ×2, judged on motion shots)

- **Weapon feel**: recoil must have an impulse *and a recovery curve*, not a snap-back. Sway must
  lag look input. Bob must be coupled to actual velocity and must settle when stopping.
- **ADS** changes FOV, hand position, and depth of field together, over a curve, not a linear lerp.
- **Muzzle flash** lights the world, casts shadows, lasts 1–2 frames, and is followed by smoke.
- **Particles** are never round white blobs. Smoke needs internal detail, self-shadowing, curl,
  and must dissipate rather than fade uniformly. Sparks need motion streaks and physics. Debris
  needs to be actual geometry that bounces.
- **Impacts** must produce a decal, a puff, sparks or dust of the correct material colour, and a
  sound — and the decal must conform to the surface it hit.
- **Secondary motion everywhere**: vegetation moving in wind with per-instance phase, cloth, dust
  drifting, water moving. A perfectly still world is a dead world.
- **Motion blur derived from real per-object velocity**, not a full-screen radial smear.

## Axis 7 — UI and presentation (weight ×1)

- **No default browser look.** No system font stack, no pure `#FFFFFF`, no default form controls.
- **Typographic hierarchy** with a deliberate type scale, real tracking, and a condensed/technical
  face appropriate to military UI.
- **The HUD is diegetic-adjacent and restrained**: it sits in the frame's periphery, uses opacity
  and scale to rank information, and never fights the image for attention.
- **Everything animates on and off** with eased transitions. Nothing pops into existence.
- **Feedback for every action**: hitmarkers, damage direction, reload state, ammo count changes
  must be immediately legible in peripheral vision.

---

## Scoring

Weighted mean of the seven axes, on the weights above.

| Score | Meaning |
|---|---|
| ≤ 5.9 | Reads as a hobby WebGL demo. |
| 6.0–6.9 | Competent indie. Still obviously not AAA. |
| 7.0–7.9 | Good indie / mobile AAA. Would not pass as console AAA. |
| 8.0–8.4 | Genuinely close. Specific, nameable defects remain. |
| 8.5–8.9 | Would pass as AAA to a non-expert; an expert finds the tells. |
| 9.0+ | Would pass blind as a shipped AAA frame. |

**The bar for this project is a weighted score of ≥ 8.5 on every shot, with no single axis below
8.0.** An axis below 8.0 blocks acceptance regardless of the mean — a frame with perfect materials
and broken shadows is not an acceptable frame.
