# IRONSIGHT — LOOK SPEC

**The rendering and art-direction target, as implementable numbers. This document is law.**

Read `docs/BRIEF.md` first. This spec is downstream of it and upstream of every rendering lane.
Where this document gives a number, that number is the target and deviations are defects, not
taste. Where it gives a range, land inside the range and say where you landed.

Companion documents:
- `docs/ARCHITECTURE.md` §4 — the render graph these numbers are implemented in. Pass numbers
  below (`P10`, `P25`, …) refer to that table.
- `docs/HUD_SPEC.md` — HUD, which is never graded, bloomed, tonemapped or TAA'd.
- `docs/REFERENCE_INDEX.md` — which reference frame each shot is blind-A/B'd against.

---

## 0. How this spec was derived, and how to use it

Every number here is either (a) measured directly off `reference/gameplay/` frames, (b) derived
from physical photometry and then cross-checked against those measurements, or (c) a resolution
of a conflict between the four independent reverse-engineering passes, with the resolution stated.

Measurements quoted as `[m: frame]` were taken on the frame named, on the central 80 % × 62 % crop
(HUD excluded). No pixel from those frames enters the build.

**The acceptance model.** Every section ends with pass/fail tests that can be run on one of our own
PNGs with a twenty-line numpy script. A lane is not done when it looks right; it is done when its
shot passes its tests and survives a blind A/B. Section 10 collects the tests into one checklist.

**One rule above all the others.** The reference corpus is internally consistent about exactly one
thing across four titles, five lighting regimes and 135 frames: *the image is wide-range with a
dense, saturated lower-midtone, warm-to-neutral highlights that desaturate as they brighten, and
shadows that carry the colour of the sky rather than a darker copy of the sunlit surface.* If you
have limited time, spend it there. It is worth more than any amount of geometry.

---

## 1. Scene presets

HARBOUR REACH ships one primary lighting state. Two secondaries exist so the atmosphere system
is provably general and so scripted moments have somewhere to go. Everything in §2–§6 is specified
for the primary unless noted.

| | **GOLDEN** (primary) | **HAZE** (secondary) | **COMBAT** (secondary) |
|---|---|---|---|
| When | default play | mid-round weather shift | scripted, near a burning objective |
| Sun elevation | **11°** | 16° | 9° |
| Sun CCT | **3400 K** | 4100 K | 3400 K + fire |
| Direct normal illuminance | **48 000 lx** | 26 000 lx | 44 000 lx |
| Sky diffuse (horizontal) | **7 500 lx** | 11 000 lx | 6 200 lx |
| Total horizontal illuminance | **16 700 lx** | 18 200 lx | 13 100 lx |
| `toneMappingExposure` | **1.88e-4** | 1.73e-4 | 2.40e-4 |
| Equivalent EV100 | **12.1** | 12.3 | 11.8 |
| Fog e-fold distance (sea level) | **900 m** | 340 m | 700 m + local |
| Frame area behind participating media | **12–20 %** | 45–70 % | 35–55 % |
| Target median frame luma | **70–115** | 95–140 | 60–95 |

For reference, a clear-midday preset (not shipped, but the calibration anchor for the daylight
BF6 frames) would be sun 42°, DNI 92 000 lx, exposure 4.15e-5, EV100 14.3. Our golden preset is
exactly 2.2 stops below it, which is correct for an 11° sun.

### 1.1 The teal problem — read this before lighting anything

The brief asks for "warm sandstone and ochre against desaturated teal shadow and sea." The
reference says something more specific and slightly different, and if you implement the brief
naively you will get it wrong.

At golden hour the **entire sky dome is warm**, so shadows go warm-neutral, not blue.
`[m: bfv_gp_014]` — the near sunlit sand reads RGB(150, 81, 57) and the shadow band 1 m away
reads RGB(40, 22, 13): the shadow is *warmer* in R/B ratio than the lit surface (3.01 vs 2.64).
Its shadow-band hue is 14°, saturation 0.06. There is no teal anywhere in that frame.

So: **teal is not a shadow tint, it is a geographic fact.** In HARBOUR REACH it must be *earned*
from two real sources, and hard-coding it as a shadow colour is a defect:

1. **The sea** is a large, dark, blue-green lower-hemisphere reflector. Anything over water or
   facing the harbour picks up the sea in the bounce lobe (§2.4).
2. **The anti-sun half of the dome** stays cool even at golden hour. Surfaces shadowed from the
   sun but open to the seaward sky get the cool term; surfaces shadowed but enclosed by warm
   sandstone get the warm term.

That split — warm bounce on the landward side of a wall, cool sky-fill on the seaward side of the
same wall — is the single most valuable composition in the map, and it falls out for free if the
ambient is a real integrated sky and not a constant.

---

## 2. Lighting model

### 2.1 Units

Work in **photometric units end to end**: `DirectionalLight.intensity` in lux, point/spot in
candela, emissive surfaces in cd/m². Three.js ≥ r155 is physically based by default and
`MeshStandardMaterial` uses `albedo/π` for diffuse, so a horizontal surface under a directional
light of intensity `E` lux at incidence θ has luminance `L = E·cosθ·albedo/π` cd/m². All numbers
below assume that chain.

**Exposure is derived, never dialled by eye.** Set

```
toneMappingExposure = 0.18 / L_grey
L_grey = E_total_horizontal · 0.18 / π       // an 18 % surface on open flat ground
```

For GOLDEN: `L_grey = 16 700 × 0.18 / π = 957 cd/m²` → `exposure = 1.88e-4`. Auto-exposure (P22)
adapts around this value with a ±0.75 EV clamp and is **frozen to the preset value whenever
`FrameCtx.deterministic`**, or shots are not comparable frame to frame.

### 2.2 Key light — the sun

One `DirectionalLight`. Never more than one. No fill lights, no rim lights, no "cheat" lights
anywhere in an exterior; every secondary light in this game is a real emitter (fire, muzzle,
flare, window) with a real position.

| Property | GOLDEN | Note |
|---|---|---|
| Elevation | 11° | shadow length ≈ 5.1× occluder height |
| Intensity | 48 000 lx | direct-normal, after 5.3 air masses of extinction |
| Linear colour (max-normalised) | **(1.000, 0.712, 0.478)** | ≈ 3400 K |
| Angular diameter | 0.53° | drives penumbra, §2.5 |
| Sun disc rendered colour | **near-white, (1.00, 0.96, 0.92) × 1.6e7 cd/m²** | see below |

**The sun disc is never drawn orange.** `[m: bfv_gp_014]` the sky within 3° of a 2° sun reads
RGB(254, 246, 238) — it tonemaps to white. The warmth lives in the dome and the in-scatter, not
in the disc. Drawing an orange disc is a first-glance tell.

Sun colour interpolates along a blackbody curve as elevation changes, so time-of-day variants and
the HAZE preset stay consistent:

| Elevation | CCT | Linear RGB (max-normalised) |
|---|---|---|
| 45° | 5600 K | (1.000, 0.956, 0.925) |
| 25° | 5000 K | (1.000, 0.900, 0.830) |
| 16° | 4100 K | (1.000, 0.810, 0.660) |
| **11°** | **3400 K** | **(1.000, 0.712, 0.478)** |
| 5° | 2900 K | (1.000, 0.620, 0.360) |

### 2.3 Sun azimuth — a hard composition rule

The sun sits **100–150° in azimuth from the primary sightline** of every objective. Front-lit
framing (sun within 40° of behind the camera) appears in **zero** press frames and is rare in the
gameplay corpus; it flattens every vertical face and is the reason amateur renders look like
product photography.

The consequence, which is the whole point: **every vertical surface in frame must show a lit face
and a sky-lit face simultaneously.** If a shot camera cannot find a wall that does both, move the
camera, not the sun.

HARBOUR REACH world azimuth is fixed (the sun sets over the sea, roughly WNW). The three capture
points are therefore deliberately different:

- **ALPHA (market square)** — sightlines run cross-sun. Raking light, long shadows across
  stone, maximum edge-wear readability. This is the material hero location.
- **BRAVO (harbour cranes)** — sightlines run into the sun over the water. Backlit, rim-lit
  cranes, the glitter path, maximum atmosphere. This is the atmosphere hero location.
- **CHARLIE (old fort, headland)** — sightlines run away from the sun. Cool seaward fill,
  the deepest aerial-perspective ladder, the teal side of the palette.

### 2.4 Ambient — a real integrated sky, in two lobes

**A flat `AmbientLight` is a defect.** So is a `HemisphereLight` with two hand-picked colours that
do not come from the sky model. Ambient comes from the sky LUTs (`ARCHITECTURE` B1–B7): a 128²
env cube + PMREM for specular, SH9 irradiance for diffuse, both re-baked when the sun moves.

Sky radiances for GOLDEN, in cd/m² and linear max-normalised chroma:

| Direction | Radiance | Chroma | Display (post-grade) |
|---|---|---|---|
| Horizon, within 20° of the sun azimuth | 9 000 | (1.00, 0.94, 0.87) | ≈ (250, 232, 210) |
| Horizon, 90° off sun | 3 400 | (0.92, 0.90, 0.90) | ≈ (196, 188, 184) |
| Horizon, anti-sun | 3 200 | (0.80, 0.86, 0.98) | ≈ (172, 182, 198) |
| 30° elevation, anti-sun | 2 600 | (0.74, 0.80, 0.95) | ≈ (150, 164, 188) |
| Zenith | 2 200 | (0.78, 0.82, 0.95) | ≈ (146, 156, 176) |

**Lower hemisphere (the bounce lobe) is not optional and is not grey.** Two-lobe irradiance,
crossfaded by the surface normal's Y, is the cheapest thing on this list that visibly separates a
shipped title from a demo: without it, upward-facing shadow and downward-facing shadow read
identically and the frame flattens.

| Ground beneath | Effective irradiance | Chroma |
|---|---|---|
| Dry sandstone / stone quay | 1 600 lx | (0.62, 0.50, 0.36) |
| Sea, away from the glitter path | 900 lx | (0.30, 0.46, 0.50) |
| Sea, inside the glitter path | 5 200 lx | (1.00, 0.82, 0.62) |
| Asphalt | 700 lx | (0.44, 0.42, 0.40) |

Implementation: sample the ground albedo × sun colour into the lower SH lobe per region; the
terrain lane publishes a coarse 64² ground-albedo map for this. **Bounce budget is 8–12 % of the
direct sun irradiance** on a surface fully open to the ground, matching the press measurement of
undersides at 8–12 % that are hue-shifted toward the ground albedo, not toward the sky.

### 2.5 Key-to-fill ratio — the number people get wrong

This is the most commonly failed number on the whole project, in both directions. The corpus
disagrees with itself until you notice that everyone measured different *surface orientations*,
and that physics resolves it exactly:

- **Open horizontal ground.** Direct horizontal = 48 000 × sin 11° = 9 160 lx; sky ≈ 7 500 lx.
  Lit:shadow linear ratio ≈ **2.2 : 1** on ground fully open to sky. `[m: bfv_gp_014]` measures a
  display ratio of 1.2–3.7 : 1 on open sand. ✔
- **Vertical face perpendicular to the sun.** Direct ≈ 47 100 lx; that face sees roughly half the
  dome ≈ 3 700 lx. Linear ratio ≈ **12.7 : 1** — 3.7 stops. `[m: bf6_gp_024]` clear midday reads
  4.5–9.5 : 1 in *display* luma, which inverts through the filmic curve to 15–25 : 1 linear. ✔
- **Enclosed shadow** (an alley, under a truck, a wall base). Sky visibility drops to 0.15–0.30,
  the ratio reaches 8–15 : 1 linear, and ground bounce becomes the dominant term.

**So do not spec a key:fill ratio. Spec the two illuminances and let sky visibility produce the
range.** Sky visibility comes from GTAO's bent normal and multi-bounce term (P7), applied to the
SH diffuse — *not* from a scalar AO multiply on the final colour, which is the mistake that
produces dirty grey shadows.

**Acceptance:** on any shot, sample the same material lit and shadowed. On open ground the
display-luma ratio must land in **2.5–4.5 : 1**; on a sunward vertical face, **5.0–9.0 : 1**. If a
shadow is more than **4.5 stops** below its sunlit neighbour anywhere in an exterior frame, the
ambient is too weak. That is the loudest WebGL tell in the corpus and it never occurs in it.

### 2.6 Shadows

Four cascades, splits 0–12–38–110–300 m, world-space texel snapping, cadence [1,1,2,4]
(`ARCHITECTURE` P4). Non-negotiables:

- **Contact hardening (PCSS), never a fixed blur.** Penumbra half-angle = sun angular radius
  (0.265°) → a 1 m occluder gap gives ≈ 9 mm of penumbra, a 10 m gap ≈ 90 mm. `[m: bf6_gp_032]`:
  a railing bar 1.2 m above a patio produces a 2–3 px terminator at 1080p while the same frame's
  architectural shadows soften over 8–14 px. One blur radius for both is a defect.
- **Blocker search 16 taps, PCF 24 taps**, Poisson disc rotated per-pixel by the spatiotemporal
  blue-noise LUT (B4), resolved by TAA. Minimum penumbra floor 1.5 texels so contact shadows do
  not alias.
- **Zero acne, zero peter-panning.** Slope-scaled depth bias + normal-offset bias sized in
  cascade texels, not world units.
- **Contact darkening is AO's job, not the shadow map's.** Every object/ground junction carries a
  separate 3–8 px band (at 1080p, at 3–6 m) that is *darker than the cast shadow itself*. GTAO at
  half res with a 0.55 m world radius, plus a short-range 0.12 m radius term composited in, plus
  the `GroundTransition` decal ring (P11).
- **The viewmodel casts into cascade 0.** `[m: bf2042_gp_020]` shows the player's own arm shadow
  on the ground with a 5–7 px penumbra. A weapon that casts nothing reads as a HUD element.
- **Distant terrain carries no resolvable shadow detail** — it is dissolved into aerial
  perspective. Fog is the last cascade; do not fight for shadow range past 300 m.

### 2.7 Emissive lights

Fire, muzzle flash, explosions, flares and lit windows are **real clustered lights** (P8), not
decals. Every reference frame containing an emitter shows it lighting geometry — concrete 30 m
from a fireball picks up hue 30° at 25 % saturation; a muzzle flash lifts soldiers 6 m away to
display 180–240.

| Emitter | Luminous intensity | CCT | Radius | Duration |
|---|---|---|---|---|
| Muzzle flash (rifle) | 60 000 cd | 2600 K | 15 m | 30 ms |
| Muzzle flash (MG/heavy) | 140 000 cd | 2500 K | 22 m | 40 ms |
| Explosion (40 mm / rocket) | 2.5e6 cd peak → 0 over 0.55 s | 2200 K → 1300 K | 60 m | 0.55 s |
| Ground fire (per licking flame cluster) | 1 800 cd, flickering ±25 % @ 7–11 Hz | 1900 K | 8 m | persistent |
| Ember | 0.4 cd | 1600 K | 0.9 m | 1.5–4 s |
| Flare / countermeasure | 90 000 cd | 2400 K | 30 m | 3.5 s |

Inverse-square falloff with a physical radius clamp, never a linear-falloff hack. Muzzle flash
must cast a shadow from cascade 0 — that is what sells it as light rather than a sprite.

---

## 3. Atmosphere

**There is no clear air, ever, and there is no zero-fog distance.** `[m: bf6_gp_034]` a foreground
rock at 15 m is already 22–25 % blended toward the sky colour. This one property does more work
than any amount of polygon density and its absence is the loudest possible hobby signal.

### 3.1 Sky model

Physical Rayleigh + Mie (`ARCHITECTURE` B1/B2, P1). A vertical-gradient sky dome is an instant
fail. The tests it must pass, measured on the clear-day anchor `[m: bf6_gp_024]`:

- **Hue is locked at 203–207° at every elevation.** Only saturation and value move:
  30° elev → RGB(13, 96, 148) S 0.91; 15° elev → RGB(72, 124, 172) S 0.58;
  5° elev → RGB(128, 166, 198) S 0.35; horizon band → RGB(149, 150, 156) S 0.04.
  Anything that changes hue with elevation reads as a gradient.
- **The horizon is roughly 2× brighter than the sky 30° up** and is essentially achromatic, and it
  **warms on the sun side** (RGB(186, 173, 168) in the same frame). That is Mie forward
  scattering; a λ⁻⁴-only sky cannot produce it.
- At GOLDEN the same model with an 11° sun and an aerosol turbidity of 3.2 produces the warm dome
  in §2.4 automatically. Do not author the golden sky as a separate gradient.

**Clouds** are volumetric with self-shadowing and a sun-side silver lining, raymarched into the
env cube and the cloud-shadow LUT (B6, P3). A scrolling cloud texture is a defect. Coverage for
GOLDEN: 0.25–0.35, base 900 m, thickness 1200 m, with the cloud shadow feeding the terrain so
distant ground has moving light and dark bands.

### 3.2 Aerial perspective

Implement as **`surface·exp(-σd) + inscatter(viewDir)·(1-exp(-σd))`**, never as
`mix(colour, fogColour, d)`. The distinction is not academic: at low sun the in-scatter is an
additive warm term, and `[m: bfv_gp_014]` measures saturation *rising* with distance through the
near-mid range (0.54 at 5 m → 0.60 at 100–300 m) before collapsing at the horizon. A lerp toward
grey cannot do that and produces the flat, washed distance that reads as a demo.

**Extinction, GOLDEN preset**, as a two-term height-layered medium:

```
σ(y) = σ_marine · exp(-y / 22)  +  σ_upper
σ_marine = 1.10e-3 /m          // sea-level marine haze slab, scale height 22 m
σ_upper  = 2.20e-4 /m          // general aerosol, no height falloff
σ_R : σ_G : σ_B = 1.00 : 1.25 : 1.50    // Mie-dominated, ~λ^-1.5, NOT λ^-4
```

Blend fraction toward the in-scatter colour along a horizontal ray at eye height:

| Distance | Blend fraction | Corresponds to |
|---|---|---|
| 15 m | 0.16 | near cover, foreground rubble |
| 60 m | 0.33 | typical engagement range |
| 150 m | 0.53 | across the harbour |
| 400 m | 0.79 | the breakwater from the square |
| 1 400 m | 0.96 | the headland — CHARLIE from ALPHA |
| 4 000 m+ | 0.99 | the far coast, indistinguishable from sky |

For the HAZE preset scale σ by 2.6× (e-fold 340 m, 90 % fogged at 780 m). For dense local dust,
`ARCHITECTURE`'s froxel volume (P9) carries it; do not raise the global σ for a local event.

**Three properties that separate this from fog:**

1. **In-scatter colour is the per-ray sky radiance**, sampled from the same LUT that draws the
   sky. It is warm-white toward the sun, cool-blue away from it, and it changes across a single
   frame. A constant fog colour is an instant giveaway.
2. **Forward scattering, Henyey-Greenstein g = 0.72.** Haze near the sun azimuth *outshines the
   sky*: `[m: bf6_gp_039]` the far ridge is 1.21× brighter than sky sampled away from the sun.
3. **An explicit Rayleigh λ⁻⁴ in-scatter term on top of the Mie extinction**, so distant geometry
   on the anti-sun side goes *bluer and more saturated than the horizon sky it sits against*
   (press corpus: 4 km in-scatter S 0.29 against a horizon sky at S 0.14). A lerp-to-sky-colour
   fog mathematically cannot produce this.

**Aerial perspective is applied in-shader in the forward pass (P10)**, not as a screen-space
post effect, so transparents, water and particles receive it consistently. Contrast dies faster
than luminance: residual local σ should fall to ~55 % of near-field by 4 km and ~30 % at the true
horizon.

### 3.3 Participating media and frame budget

| State | Frame area behind ≥1 translucent layer |
|---|---|
| Quiet GOLDEN gameplay | 12–20 % (distant smoke columns, harbour haze, the global term) |
| Active combat | 35–55 % |
| HAZE preset | 45–70 % |
| **Never** | 0 % |

Two distinct scales, both required:
- **Global thin haze** — everywhere, always, the §3.2 integral.
- **Local dense bodies** — smoke columns, dust, spray, with optical thickness sufficient to fully
  occlude over 2–4 m of path.

**Discrete particle sprites are used sparingly.** Ambient "atmosphere dust motes" floating in the
air are a demo signature; the reference uses the fog integral instead. The exceptions are inside
volumetric shafts (§3.4) and inside 2 m of a disturbed surface.

Every smoke and dust body is a **lit volume with a phase function**, alpha-blended, never
additive, taking (a) the sky ambient on its upper/outer faces, (b) the sun with HG g = 0.6–0.75,
(c) the nearest emissive. A sprite that does not pick up both the sky term and the nearest
emissive reads as a decal.

### 3.4 Volumetric light shafts

Froxel volume 160×90×64, temporally reprojected with Halton Z jitter (P9), composited
depth-aware (P15).

- Shaft radiance **≤ 25 % above the local fog level**, feature width 8–15 % of frame width, soft
  edges. There are no hard-edged god-ray polygons and no cathedral shafts in any gameplay frame.
- Shafts appear whenever the sun is occluded — through the crane gantries at BRAVO, the market
  awnings at ALPHA, the fort embrasures at CHARLIE, and through every smoke column.
- Dust motes catching light *inside* a shaft are permitted and are a high-value detail; motes
  outside one are not.

---

## 4. Materials

### 4.1 The layer stack — mandatory on every surface

Nothing in the corpus is a single albedo at a single roughness. Every world material is built as:

```
1. base albedo                       constant per material
2. mesoscale variation      0.15–0.6 m wavelength, albedo AND roughness AND normal
3. macro variation          3–12 m wavelength, breaks tiling, albedo only, ±8 %
4. curvature wear           convex → chip to substrate     (§4.4)
5. cavity grime             concave → darken, roughen      (§4.4)
6. N·up dust                upward faces → pale, flat      (§4.4)
7. detail normal            2–6 cm, fading in from 6 m
8. micro normal             1–3 mm, fading in from 1.2 m
```

**Acceptance:** the standard deviation of display luminance inside a nominally uniform patch of
any material, viewed at 1 m, must be **≥ 12 levels** and should land at 20–40. `[m: bfv_gp_001]`
stucco measures σ 28–41. Any surface at σ < 8 reads as untextured and is a defect.

**Tiling.** Three noise octaves at non-harmonic frequency ratios (1.00, 3.70, 13.90) plus a
low-frequency 0.03 m⁻¹ mask that modulates the others. Triplanar on terrain, rubble and anything
with a discontinuous UV. **Nothing may repeat visibly at any of the three viewing zooms** —
silhouette, 3 m, and 0.3 m.

### 4.2 Roughness by class

Nothing is at roughness 1.0 with a flat normal; every "matte" surface still shows a broad grazing
sheen along its top edge.

| Class | Roughness | Metalness | Notes |
|---|---|---|---|
| Optical glass (objective) | 0.03–0.08 | 0 | near-mirror, tinted AR coat, §4.6 |
| Wet stone / puddle | 0.08–0.20 | 0 | §4.5 |
| Polished / blued steel | 0.20–0.35 | 1 | picks up sky, hue 217° `[m: bfv_gp_001]` |
| Bare steel at wear points | 0.25–0.35 | 1 | where all the specular interest lives |
| Machined aluminium | 0.30–0.45 | 1 | anisotropic scratch band along the turn axis |
| Brass / copper hardware | 0.35–0.45 | 1 | |
| Painted vehicle armour, intact | 0.40–0.60 | 0 | chalked/faded areas → 0.70+ |
| Satin sprayed camo | 0.45–0.55 | 0 | |
| Leather | 0.45–0.60 | 0 | broad sheen on shoulder/lapel |
| Weapon polymer / furniture | 0.55–0.70 | 0 | waxy highlight, distinct from the metal |
| Parkerised / phosphate metal | 0.55–0.70 | 1 | |
| Painted timber, boat hull | 0.55–0.75 | 0 | |
| Fabric / webbing / camo | 0.75–0.90 | 0 | **plus a sheen lobe**, §4.7 |
| Weathered stucco / plaster | 0.72–0.88 | 0 | rain-washed strips → 0.60, sheltered → 0.90 |
| Dry concrete, asphalt, sandstone | 0.80–0.95 | 0 | |
| Rusted / corroded metal | 0.70–0.85 | 0.3 | |
| Dry soil, gravel, sand | 0.90–1.00 | 0 | near-Lambertian, grazing sheen only |

### 4.3 Albedo — nothing pure black, nothing pure white

Linear albedo bounds. Values outside these are physically impossible and read as such.

| Material | Linear albedo | Chroma note |
|---|---|---|
| Fresh soot / burnt core | **0.035** (floor) | never below |
| Asphalt, dry | 0.05–0.09 | slightly blue-neutral |
| Sea water (diffuse component) | 0.02–0.06 | teal, hue 185–195° |
| Foliage, palm frond | 0.06–0.14 | plus two-sided transmission, §4.7 |
| Dark painted steel | 0.06–0.12 | |
| Weathered timber | 0.12–0.22 | |
| Dry soil | 0.18–0.30 | hue 30–40° |
| Concrete | 0.28–0.42 | |
| Sandstone | 0.32–0.48 | hue 27–35°, S 0.13–0.26 sunlit |
| Stucco, painted | 0.38–0.55 | |
| Dry sand / dune | 0.45–0.58 | |
| Fresh white paint, spray foam | **0.82** (ceiling) | never above |

**Hue rotation between lit and shadowed is itself a tell.** `[m: bf6_gp_039]` sunlit rock reads
hue 27–29° at S 0.13–0.26; the same rock in shadow reads hue 50–72° at S 0.06–0.09. That
rotation is produced by the two-lobe ambient (§2.4) and must not be authored into the texture.

### 4.4 Wear — curvature-driven, never noise-driven

This is the highest-yield detail in the entire spec and it is one mask stack that runs on
weapons, vehicles, architecture and terrain alike.

```
convexity  = saturate( +curvature * k )      // k tuned per asset scale
cavity     = saturate( -curvature * k )
upness     = saturate( dot(N, up) )
```

| Mask | Effect | Scale | Evidence |
|---|---|---|---|
| **Convex → chip** | albedo → lighter substrate; roughness → 0.35; metalness +0.6 on painted metal | 1–4 mm on a weapon, 2–8 cm on a vehicle, 3–15 cm on masonry | `[m: bf6_gp_038]` paint chipping exists *exclusively* on convexities of the MG receiver, rail and handguard |
| **Concave → grime** | albedo × 0.65–0.70; roughness → 0.85; desaturate toward brown | follows creases, rivet lines, panel gaps | concavities in the same frame carry a darker layer, never chips |
| **N·up → dust** | albedo +15–25 % toward pale ochre; roughness → 0.85–0.90; flatten micro-normal | 40–70 % coverage on horizontal faces | every upward-facing surface in the press corpus is loaded; vertical faces stay clean |

Chip and grime boundaries are **noise-broken, never clean outlines**. Scratches run parallel to
the direction of use: fore-aft on track guards, along the length of a handguard, around the axis
on anything that rotates.

**Ground junctions.** *Nothing in 183 reference frames meets the ground with a clean seam.* Every
geometry/ground junction carries a 10–50 cm transition band of drifted sand, pebbles, rubble,
spalled concrete or dry vegetation, with individual contact shadows on the loose pieces. This is
served by the `GroundTransition` decal rings (P11) plus scattered small meshes; both are required,
because the decal alone reads flat at 2 m.

### 4.5 Wet vs dry

HARBOUR REACH has a tide line, a boat ramp, spray-wetted stone at the breakwater and drainage
lines. Wetness is a **mask that does four things simultaneously** — doing only some of them is
what makes wet surfaces read as plastic:

```
albedo    *= 0.60            // 35–45 % darker
roughness  = mix(rough, 0.15, wetness)
normal     = mix(normal, geometricNormal, wetness * 0.8)   // flatten micro-relief
height     : fills the height map's low points FIRST
```

Plus, at wetness > 0.7, a low-roughness (0.05–0.10) Fresnel layer with a strong grazing sky
reflection. The wet/dry boundary is hard-ish with a **5–15 cm feather**, not a soft gradient, and
it pools in concave curvature first.

`[m: bfv_gp_016]` wet mud measures a base of display 4–16 with specular streaks at 150–220 — a
15–20× specular-to-diffuse ratio, and the highlights are **anisotropic**, stretched along the
surface flow direction rather than forming round hotspots.

### 4.6 Optics glass — cheap and extremely high yield

`[m: bf6_gp_024]` the scope objective is a mirror at roughness ≈ 0.05 carrying a strongly tinted
AR coating: the reflected world reads through a crimson filter, RGB ≈ (150, 20, 25) at the top of
the lens grading to warmer amber at the bottom, geometrically plausible but blurred and
barrel-warped, with a bright Fresnel rim where the glass meets the bezel.
`[m: bf2042_gp_022]` shows the alternative: a near-black disc with a green-cyan coating at
≈ (40, 70, 58) and a small off-axis sky reflection.

Implement as a tinted cube reflection with a 2.5 % barrel warp, a coating tint that rotates
crimson→amber down the lens, and a rim term. Two shader instructions; enormous perceived quality.

### 4.7 Special responses

- **Cloth needs a separate sheen/fuzz lobe** that brightens the silhouette rim independently of
  the diffuse. Without it cloth reads as plastic. Visible on every uniform edge in the corpus.
- **Vegetation needs two-sided translucency.** Backlit palm fronds and grass are *brighter and
  more saturated* than front-lit ones — `[m: bf2042_gp_022]` sun-facing fronds read (161, 154, 125)
  while backlit fronds glow yellower and brighter than reflection alone permits. At BRAVO the
  palms are between the camera and the sun; this term is doing visible work.
- **Skin** has subsurface: the terminator on cheek and nose shifts warm by +12–18° of hue in a
  2–4 % band, ears and finger edges transmit red. Oily specular at roughness 0.35–0.50 on
  forehead, nose bridge and cheekbones only, against 0.55 elsewhere.
- **Decals sit IN the material**, taking the substrate's specular response, its aerial
  perspective and its wetness. A decal that does not is visible as a sticker.

---

## 5. Colour grade

The full chain, in order. Every stage is measurable.

```
scene HDR (P10–P17)
  → TAA resolve (P19)
  → motion blur (P21)
  → exposure (P22)           §2.1  — derived, frozen when deterministic
  → bloom (P23)              §6.1
  → DOF (P24)                §6.2
  → tonemap: AgX (P25)       §5.1
  → 32³ grade LUT (P25)      §5.2–5.4
  → lens fx (P26)            §6.3–6.6
  → HUD (P27)                never graded
```

### 5.1 Tonemapper — AgX, not ACES

`ARCHITECTURE` already commits to this and the reason belongs here: the ACES RRT pushes this
brief's warm sandstone/ochre palette into orange hue-clipping at the top of the range, which is
exactly the "everything is orange" tell. AgX preserves hue through the shoulder.

The required shoulder behaviour, verifiable on a synthetic ramp:

| Scene-linear (0.18 = mid grey) | Display code |
|---|---|
| 0.020 | ≈ 25 |
| 0.050 | ≈ 52 |
| 0.090 | ≈ 78 |
| **0.180** | **≈ 110** |
| 0.360 | ≈ 145 |
| 0.720 | ≈ 178 |
| 1.440 | ≈ 205 |
| 2.900 | ≈ 228 |
| 5.800 | ≈ 243 |
| 16.3 (white point) | 255 |

Cross-check: sunlit sandstone at albedo 0.42 under GOLDEN → linear 0.42 → display ≈ 150.
`[m: bfv_gp_001]` sunlit stucco measures 164 and `[m: bf6_gp_024]` sunlit concrete 210–224 at a
higher albedo and a higher sun. ✔

**Hot sources must desaturate toward white on the way up, skewing slightly yellow.**
`[m: bf6_gp_023]` a fireball runs (224, 180, 147) hue 26° S 0.34 → (254, 244, 217) hue 40° S 0.15
→ white. Orange fire that turns magenta or picks up a cyan fringe on the way to white is a
broken tonemapper.

### 5.2 Black level, white level, contrast

| Property | Target | Evidence |
|---|---|---|
| Output black point | 0.035–0.050 display | toe is lifted; pure black is reserved for letterbox bars |
| p0.1 luminance | 3–20 | `[m: bf6_gp_024]` 0; `[m: bf6_gp_039]` 16; `[m: bfv_gp_014]` 3 |
| p1 luminance | 5–30 | measured 6 / 27 / 5 |
| Fraction below display 8 | **< 5.0 %**, target < 2 % | measured 1.20 % / 0.00 % / 3.48 % / 3.75 % |
| Darkest genuine surface | ≥ 26/255 | never let a real material reach black |
| p50 (median) | **70–115** | measured 93 / 101 / 72 / 111 |
| IQR (p25–p75) | **55–150** | measured 64–135 / 78–136 / 35–149 / 70–144 |
| p99 | 195–248 | measured 225 / 239 / 231 / 203 |
| Fraction above display 250 | **< 0.30 %** | measured 0.007 % / 0.024 % / 0.027 % / 0.002 % |

(Four-frame set throughout this table: `bf6_gp_024`, `bf6_gp_039`, `bfv_gp_014`, `bf6_gp_032`.
A frame carrying a large dark near-field occluder legitimately pushes the sub-8 fraction toward
5 % — that is depth, not crushing. What is not permitted is a *large flat area* sitting at black.)

The image is **not high-contrast — it is wide-range with a dense, low-placed midtone.** A frame
pushed to a crushed punchy curve reads as a filter, not a renderer. Do not centre the histogram.

Only the sun disc, fire cores, specular pinpricks on water and muzzle flashes are genuinely
clipped. **Bright diffuse surfaces never clip.** Diffuse white tops out at 210–224 and holds a
warm bias — `[m: bf6_gp_024]` sunlit concrete (215, 208, 202), hue 25°, S 0.06.

### 5.3 Saturation vs luminance — the defining curve

Every corpus, every title, every lighting regime agrees on this, and it is the single property
that makes bright surfaces stop looking like plastic. **Saturation peaks in the lower midtones and
collapses above display 216.**

Own measurements, mean HSV saturation per luma bucket, HUD excluded:

| Luma bucket | bf6_gp_024 | bf6_gp_039 | bf2042_gp_022 | bfv_gp_014 | bf6_gp_032 | **Target** |
|---|---|---|---|---|---|---|
| 0–24 | 0.341 | 0.470 | 0.587 | 0.556 | 0.49 | 0.30–0.60 |
| 24–48 | 0.507 | 0.296 | 0.504 | 0.379 | 0.41 | 0.30–0.52 |
| **48–96** | **0.545** | 0.209 | 0.309 | **0.511** | **0.45** | **0.40–0.55 (peak)** |
| 96–144 | 0.261 | 0.168 | 0.385 | 0.509 | 0.50 | 0.25–0.50 |
| 144–192 | 0.147 | 0.158 | 0.280 | 0.353 | 0.29 | 0.15–0.34 |
| 192–216 | 0.084 | 0.127 | 0.237 | 0.243 | 0.08 | 0.08–0.24 |
| 216–240 | 0.053 | 0.132 | 0.093 | 0.205 | 0.12 | **0.05–0.16** |
| 240–256 | 0.032 | 0.081 | 0.020 | 0.076 | — | **0.02–0.09** |

The absolute values move with scene content; **the shape does not, and the shape is what is being
specified.** Peak bucket must be 48–96 or 96–144, and the 240+ bucket must be below 0.10 in every
frame we ship.

Implement as a **post-tonemap per-pixel lerp toward luma**, baked into the 32³ grade LUT:

```
w   = smoothstep(0.62, 0.95, L_display)          // desaturation weight
boost = 1.0 + 0.09 * smoothstep(0.45, 0.10, L_display) * smoothstep(0.02, 0.12, L_display)
rgb = mix(rgb * boost, vec3(L), w * 0.88)
```

Resulting saturation multiplier: 1.08 at L 0.20, 1.05 at L 0.35, 0.97 at L 0.50, 0.80 at L 0.68,
0.55 at L 0.80, 0.30 at L 0.88, 0.12 at L 0.95.

**Skipping this is the fastest way to read as an untonemapped WebGL frame.**

### 5.4 Split tone

Shadows carry the **ambient dome hue at 8–18 % saturation** — *not* a hard-coded blue. Midtones
carry the scene's dominant hue at maximum strength. Highlights converge on neutral with a
residual warm tilt and **never carry a strong tint**.

Measured B−R channel delta by luma bucket (negative = warm):

| Frame | 0–24 | 24–48 | 48–96 | 96–144 | 144–192 | 192–216 | 216–240 | 240+ |
|---|---|---|---|---|---|---|---|---|
| bf6_gp_024 (clear midday) | −6 | +27 | +48 | +11 | −4 | −10 | −5 | −4 |
| bf6_gp_039 (golden, smoke) | −6 | −12 | −17 | −21 | −28 | −27 | −31 | −20 |
| bfv_gp_014 (golden desert) | −10 | −20 | −53 | −86 | −75 | −56 | −51 | −19 |
| **GOLDEN target** | **−4 … +6** | **−10 … +2** | **−30 … −10** | **−48 … −24** | **−42 … −20** | **−30 … −14** | **−22 … −8** | **−10 … 0** |

Read that row: the midtones carry the warmth (peak at L 96–144), the highlights neutralise, and
the shadows sit near neutral with a slight split — warm on the landward/sunward side, drifting to
+6 (cool teal) on the seaward side where the anti-sun dome dominates. That is the brief's
"sandstone against teal" and it **emerges from correct lighting**. Applying it as a LUT on top of
neutral lighting makes shadows blue everywhere including where they should be bounce-warmed, and
that is a defect.

3-way corrector offsets, applied inside the LUT bake, at **±0.03–0.06 maximum**:

```
shadows   (L < 0.25) : lift  ( -0.010, -0.004, +0.014 )   // ambient hue, gentle
midtones  (0.25–0.70): gamma ( +0.030, +0.006, -0.040 )   // the sandstone
highlights(L > 0.70) : gain  ( +0.014, +0.006, -0.010 )   // whisper of warmth only
```

---

## 6. Post

### 6.1 Bloom

**The threshold is high and this is measured, not a preference.** `[m: bf6_gp_038]` a diffuse
white letter at display 224 sitting on a display-42 background lifts the adjacent background by
only ~5/255. `[m: bf2042_gp_022]` a fully blown 240–250 sky does not bloom onto the buildings in
front of it. **Bright diffuse surfaces do not bloom.**

| Property | Value |
|---|---|
| Threshold | scene-linear **1.05** (≈ display 0.90), expressed in **EV relative to exposure** so it is scene-independent |
| Knee | soft, 0.55 EV wide |
| Pyramid | 7 mips, 0.5 → 1/64, Karis-averaged 13-tap on mip 0 |
| Mip weights | [0.340, 0.240, 0.170, 0.120, 0.080, 0.035, 0.015] |
| Total added energy | **5–8 % of the source** |
| Coarsest mip | must reach the full frame at ~10 % amplitude for a sun-sized emitter |

**Falloff shape.** A point source must yield an approximately 1/r halo. Measured radial profiles
to match: a blown emitter holds 255 to r = 150 px, then 210 @ 200, 151 @ 300, 107 @ 350,
78 @ 450, 61 @ 550, 56 @ 650. The sun produces a very low-slope veiling glare — 249 at source down
to only 183–198 at r = 650. A single-radius bloom cannot produce both the tight core falloff and
the frame-wide veil, which is why the pyramid weights above are geometric rather than equal.

Muzzle-flash halo target: half-value radius **0.018 of frame width** (≈ 35 px at 1920), reaching
the background floor by 0.06–0.08 W.

### 6.2 Depth of field

The corpora disagree and the disagreement resolves cleanly by title generation. BF6 measures a
mild near-field defocus on the viewmodel (acutance 0.10–0.18 vs 0.15–0.41 for the world); 2042
and BFV measure none in hipfire. **We ship the BF6 behaviour**, because it is the newest reference
and because it is the cheapest way to seat the weapon in the frame.

| State | Near | Far |
|---|---|---|
| **Hipfire** | viewmodel at 0.35–0.45 m carries CoC **1.5–3.0 px** at 1080p | **none.** Terrain at 2 km is the sharpest thing in the frame |
| **ADS** (`adsBlend > 0`) | rear sight / ocular ring **4× softer** than the sight picture | mild far pull, CoC ≤ 1.2 px beyond 40 m, fading in over the ADS transition |
| **Spawn / deploy / end-of-round** | full cinematic | subject at 4 m sharp, background CoC 20–40 px |

```
CoC_px = clamp( 0.926 * abs(1/d - 1/d_focus), 0.0, 3.0 )     // d in metres
d_focus = 8.0 m in hipfire; = target distance in ADS
farSideGain = 0.0 in hipfire, 0.40 in ADS, 1.0 in cinematic
```

That gives 2.2 px at 0.40 m, 0.81 px at 1 m, 0.35 px at 2 m, 0 beyond. Bokeh is **never** visible
as discrete discs in gameplay — soft, low-radius, no aperture shape. Real bokeh (near-circular,
slight 7–9 blade truncation, brighter rim than centre, cat's-eye squashing toward frame edges)
is reserved for the deploy and scoreboard cameras. DOF runs on High/Ultra only.

### 6.3 Motion blur

**Per-object, velocity-buffer driven** (P18/P21, from the `GVelocity` written in P5). Never a
camera-wide screen blur. The tracked subject stays sharp while the background streaks; a moving
object streaks against a static background in the same frame.

- Shutter angle **180°** (blur = half a frame of motion), which at 60 fps produces the measured
  20–80 px streaks on fast objects. `[m: bf6_gp_021]` helicopter tarps smear over ~80 px with
  acutance dropping to 0.062 against 0.158 for the static fuselage in the same frame.
- Tile-max at 1/20 res, 12 taps, blue-noise jittered, depth-aware so foreground does not bleed
  onto background.
- **The viewmodel is exempt entirely.** Its velocity comes from its own rig (P17) so TAA resolves
  it, but motion blur never touches it — recoil must stay crisp.
- Runs **before** bloom: the shutter integrates motion first and the lens scatters that integrated
  light second. Blurring after bloom reads as a filter.

### 6.4 Grain

The corpora disagree: 2042 measures effectively zero (σ 0.69 on a mean of 128 — the JPEG floor);
BF6 measures 0.3–0.6 in bright sky rising to 1.3–1.7 in shadow; the press corpus measures a real
floor of σ 1.5–2.3. **Resolution: we ship a low grain, at the BF6 amount**, because a completely
noise-free frame reads as CG and because our procedural surfaces will otherwise show banding in
the toe.

| Property | Value |
|---|---|
| Amplitude, highlights (L > 0.75) | **0.4 /255 σ** |
| Amplitude, midtones | 0.9 /255 σ |
| Amplitude, toe (L < 0.15) | **1.6 /255 σ** |
| Chroma component | **0.0 — monochrome, luma-only** |
| Correlation length | 1.0–1.5 px at 1080p |
| Weighting | `σ = mix(1.6, 0.4, smoothstep(0.10, 0.75, L))` |

**Anything visible as texture on a flat sky is an order of magnitude too much.** Grain is applied
after tonemap, before the 8-bit dither.

### 6.5 Vignette

**Subtle.** ≤ 8 % corner darkening on a flat sky, very wide profile, `r²`-weighted.
`[m: bf2042_gp_022]` a blown sky falls from 247 at x = 0.40 to 236 at x = 0.995 — a 4 % edge drop.
Anything a viewer would notice as a vignette is wrong.

### 6.6 Chromatic aberration

The corpora disagree again: 2042 measures **zero** lateral CA at both edges and centre; BF6
measures a visible 2–3 px green/magenta split past 80 % of frame radius; the press corpus
measures 1–2 px at the extreme corner. **Resolution: ship a small amount, capped at 1.2 px**
(matching `ARCHITECTURE` P26), zero inside 60 % of frame radius, scaling with `r²` thereafter.

```
shift_px = 1.2 * smoothstep(0.60, 1.00, r)^2        // r = normalised frame radius
```

Uniform full-frame CA is an anti-tell and is worse than none. Sample R and B along the radial
direction only — never a fixed XY offset.

### 6.7 Antialiasing and sharpen

TAA ×8 Halton(2,3), YCoCg variance clipping, Catmull-Rom history, tonemapped-weight blend (P19).
Acceptance: high-contrast world edges resolve 10 → 90 % in **2–3 px** at 1080p; power lines and
chain-link read as continuous soft lines with **no dashing and no crawl**; static geometry shows
no ghosting. CAS sharpen at 0.35 on Ultra only, applied after grain so it does not amplify it.

---

## 7. First-person framing

### 7.1 Field of view

| Camera | Vertical FOV | Horizontal @ 16:9 |
|---|---|---|
| **World, default** | **72°** | 103° |
| World, user range | 60–90° | 92–116° |
| **Viewmodel, fixed** | **55°** | 84° |
| Viewmodel, ADS | 44° | 70° |
| World, ADS (1× optic) | 52° | 79° |
| Cinematic / deploy | 38° | 61° |

**The viewmodel is rendered on its own camera at its own narrower FOV** (`ARCHITECTURE` P17, near
0.01 / far 6). This is not optional: at the world FOV a weapon at 0.35 m is violently distorted,
and in every reference frame the receiver and optic tube stay geometrically clean and read long.
The viewmodel FOV **does not change** when the player changes the world FOV slider.

### 7.2 Horizon and camera

- Standing eye height **1.62 m**. Crouched 1.05 m. Prone 0.32 m.
- **The camera is level and the horizon stays near the centreline.** Measured: `bf6_gp_024` 0.48,
  `bf2042_gp_022` 0.43, `bf6_gp_032` 0.62 (looking slightly up a slope). Allow **±10 % of H in
  free play**; hold **±6 % on every registered shot camera**. Tilting down to show more ground is
  a demo camera and reads as one instantly.
- BFV's persistent 5–8° downward pitch is a BFV convention, not a general one, and we do not
  copy it.
- **Every frame must resolve into three separated luminance bands** — a dark near-field occluder,
  a mid-value action plane, a bright atmospheric far plane, with fog fractions of roughly
  0 % / 15–35 % / 75–99 %. `[m: bfv_gp_016]` those bands measure L ≈ 8 / 45 / 185, a 23× spread.
  **A frame where foreground, midground and background share a luminance band is the failure
  case, regardless of how good the materials are.**
- Near-field occluding geometry should cover **20–35 %** of a composed shot and read 2–4× darker
  than the midground. There is no full-screen foreground vignette geometry (grass, branches) in
  any gameplay frame — that is a press-shot device.

### 7.3 Viewmodel placement

Measured on gridded overlays of `bf6_gp_024`, `bf6_gp_032` and `bf2042_gp_022`, in fractions of
frame width W and height H, origin top-left.

| Landmark | bf6_gp_024 | bf6_gp_032 | bf2042_gp_022 | **IRONSIGHT target** |
|---|---|---|---|---|
| Optic / rear-sight centre | (0.755, 0.610) | (0.645, 0.550) | (0.735, 0.585) | **x 0.66–0.76 W, y 0.55–0.62 H** |
| Front sight / muzzle | ≈ (0.53, 0.65) | ≈ (0.55, 0.60) | (0.715, 0.455) | **(0.575 W, 0.487 H)** |
| Highest point of weapon | 0.485 H | 0.475 H | 0.450 H | **0.460–0.500 H** |
| Weapon bounding box | x 0.50–0.83 | x 0.50–0.79 | x 0.53–0.86 | **x 0.51–0.85 W, y 0.47–1.00 H** |
| Support forearm crosses bottom edge | x 0.27–0.47 | x 0.43–0.62 | x 0.52–0.60 | **x 0.30–0.60 W** |
| Coverage (weapon + hands) | ≈ 15 % | ≈ 14 % | ≈ 13 % | **12–16 % of frame pixels** |

The optic-centre spread (0.645 → 0.755 W) is real and is driven by weapon length and optic
mounting, not by pose drift: a long rifle with a forward-mounted optic pulls left, a short one
with a rear optic pushes right. Pick one number per weapon inside the window and keep it stable —
what must never vary is constraint 1 below.

Hard constraints, all of which hold in every first-person frame in the corpus:

1. **Screen centre (0.5, 0.5) is never occluded by the viewmodel.** The nearest viewmodel
   silhouette pixel to screen centre is ≥ **0.055 W** away.
2. **The entire left half of the frame above y = 0.5 H is clear of viewmodel geometry.**
3. The weapon's highest point grazes the centreline and never crosses more than **3 % of H**
   above it, and only out at x > 0.68 W.
4. The reticle sits at exactly (0.500, 0.500) in hipfire, within 1 % of frame dimensions.

**Pose.** The bore axis rises to the **left** at 12–16° from horizontal in screen space (the
muzzle exits the frame's upper-left region and is often cropped). The receiver is rolled **6–9°**
so the left side of the weapon and the ejection port face the camera. The stock is always cropped
by the bottom edge. **No edge of the weapon is parallel to a screen edge** — that diagonal is
doing a lot of the compositional work.

**HUD-driven composition.** The lower-left quadrant is minimap + squad list, the lower-right is
the ammo/gadget block, top-centre is tickets + compass, mid-right is notifications. The world
composition must therefore survive with its readable content inside the central **60 % of width
and 55 % of height**. Push scenery interest to upper-left and upper-right, where the HUD is empty.

### 7.4 ADS transition

| Property | Target |
|---|---|
| Duration | 180 ms in, 140 ms out, `easeOutCubic` on position, `easeInOutQuad` on FOV |
| World FOV | 72° → 52° (1× optic); scale by optic magnification thereafter |
| Viewmodel FOV | 55° → 44° |
| Optic centre at full ADS | **(0.500 W, 0.545 H)** — 4.5 % of H **below** true centre |
| Point of aim at full ADS | (0.500 W, 0.522 H) |
| Coverage at full ADS | 40–55 % of frame (an MMG reaches 55 %) |
| DOF | far pull fades in with `adsBlend`, §6.2 |
| Sway | reduced to 0.30× hipfire; breathing added at 0.22 Hz |

That deliberate downward offset of the optic — sitting *below* the point of aim, not on it — is
what makes ADS read as a weapon raised to the eye rather than a reticle pasted on the screen.
`[m: bfv_gp_012]` measures optic centre (0.498, 0.547) against point of aim (0.498, 0.524). Copy
it exactly.

---

## 8. VFX vocabulary

**Governing rules, from which everything below follows:**
- VFX are **sparse**. Tracers appear 3–12 on screen; embers cover 0.05–0.55 % of frame pixels;
  a muzzle flash was caught in 1 of 20 frames. A screen full of glowing particles is the demo
  signature.
- **Nothing uses additive round white blobs.** Smoke and dust are alpha-blended and occlude.
  Only genuine over-range emitters (flash cores, tracer cores, sparks, embers) are additive.
- **Every bright emitter is a light** (§2.7). A muzzle flash or explosion that does not inject
  light into the environment reads as a decal.
- Every particle system receives aerial perspective and volumetric scattering like world geometry.

### 8.1 Ballistics

| Effect | Size | Lifetime | Colour (display) | Notes |
|---|---|---|---|---|
| **Muzzle flash core** | 1.5–2.5 barrel Ø wide, 2–3 Ø long, small gap at the muzzle | 30 ms (1–2 frames) | core **(250, 244, 225)** near-white; petals (255, 150, 120) → saturated orange-red at the edge | ragged rounded lobe with 2–4 asymmetric petals, randomised per shot, soft-edged and internally noisy. **No 6-point star.** Core is *white*, not orange — the shoulder desaturates it |
| **Blast / propellant puff** | **6–10× the flash size** | 350–600 ms | warm grey, peak alpha 0.22 | the more visible element, and it outlives the flash. Omitting it is why most muzzle flashes read wrong |
| **Tracer** | 1.8–3.2 m long × 4–7 cm, 15–25:1 aspect | time of flight | core **(255, 215, 195)** warm-white over-range, tail amber (255, 140, 60) | velocity-stretched **rods, not dots**. Glow 3× core width. 1 in 4–5 rounds. Visible gravity drop. Casts no world light |
| **Weapon smoke** | 1–2 % of frame each | 500 ms | cool grey lifted by local light | 2–4 small puffs at the muzzle |
| **Shell casing** | 9–14 mm | 2.5 s + 1 bounce | brass, roughness 0.40 | tumbles, catches the key light, contacts with a sound |

### 8.2 Impacts

| Effect | Size | Lifetime | Colour | Notes |
|---|---|---|---|---|
| **Dust puff** | 0.35–0.70 m radius | 0.6–1.1 s | **the surface's own albedo × 1.15** | white off stucco, grey off concrete, dark off soil, tan off sand. Peak alpha 0.35 |
| **Sparks (metal/stone)** | 1–3 px, 8–24 of them | 0.25–0.50 s | 2600 K, over-range core | gravity arcs, visible motion streaks, each individually blooms. A spark without a glow is a dead pixel |
| **Debris chunks** | 3–20 cm, 3–15 of them | 1.2–2.5 s | non-emissive, silhouetted | individually rotating lumps, not sprites; larger pieces carry short smoke trails |
| **Impact decal** | 4–20 cm | persistent, LRU-capped | dark centre, lighter spalled ring | irregular noise-broken outline, **never a circular stamp**; takes the substrate's specular and fog |

### 8.3 Fire and explosions

**Four-zone structure with a soot handoff.** A fire that goes orange straight to grey reads as a
demo; the red-to-soot transition is where the AAA look lives.

| Zone | Colour (display) | Sat | Notes |
|---|---|---|---|
| 1. Core | (253, 231, 178) → (254, 244, 217) | 0.15 | ≈ 4500 K, genuinely over-range, blooms. Small — even a frame-filling flamethrower puts only 8.6 % of pixels above 215 |
| 2. Body | (228, 128, 80) → (244, 169, 96) | 0.60 | ≈ 2000 K |
| 3. Cooling shell | (167, 107, 92) → (138, 45, 24) | 0.46–0.79 | ≈ 1300 K, deep saturated red |
| 4. Soot cap / column | (55, 69, 70) → (60, 50, 42) | 0.12–0.20 | separates from the fireball as it rises |

- Fireball diameter **4–9 m** for a rocket/40 mm; **6–12 primary lobes** with sub-lobes at half
  scale; it **self-occludes** and silhouettes geometry in front of it with a bright warm rim. It
  is not a billboard.
- Broken by **internal dark soot filaments** over 3–4 turbulence octaves — voids at display 60–90
  sitting immediately adjacent to 240+ cores. A smooth gradient blob is wrong.
- Lifetime: core 0.08–0.15 s, body 0.2–0.4 s, shell 0.4–0.8 s, column rises for 20–60 s.
- **Ground fire** is small, licking, individually shaped flames with visible dark tips — never a
  billboard sheet — and it uplights the surrounding rubble.

### 8.4 Smoke, dust, embers

| Effect | Size | Lifetime | Colour | Notes |
|---|---|---|---|---|
| **Grenade smoke** | 4–9 m body | 8–25 s | sky-lit face **(136, 148, 161)** hue 208° S 0.15 under a blue dome; warm under the golden dome; dense core (60, 50, 42) | alpha-blended, HG g = 0.6, self-shadowing (shaded side ≈ 2.5× darker than lit side), dissipates by **both** expanding and losing opacity |
| **Wreck / objective column** | 30–400 m tall | minutes | as above, plus fire-lit warm on its lower inner face (160, 146, 126) | rises with visible shear; lobe features 150–500 px; internal σ 5–12 within a body but 40–50 across the column |
| **Vehicle / footfall dust** | stays under 2 m, spreads 3–8 m | 1.0–1.5 s | **tinted the exact colour of the ground it came from**, brighter on the sun side | warmer, lower, faster and lower-opacity than smoke. Moves as sheets, not puffs |
| **Rotor wash** | ground-hugging annulus 12–20 m | continuous | ground albedo | |
| **Ember** | 3–6 px + a soft halo ≈ 2× its diameter | 1.5–4 s | ramps **(255, 200, 140) → (120, 40, 15)** | rises 1.2–2.5 m/s with lateral turbulence and slight motion streaking; ~1 per 40×40 px block near the source, thinning as 1/r². **Each is a 0.9 m light** — the visible warm rim it puts on nearby geometry is the whole effect |

Coverage: embers **0.05 % of frame pixels** at a small fire, up to 0.55 % in a dense plume.

### 8.5 Water (BRAVO and the breakwater)

- Bow spray and breaking surf render as **dense white foam that genuinely occludes**, plus a fine
  backlit mist layer.
- Shallow water carries subsurface teal transmission ≈ (100, 190, 200) grading to deep blue
  ≈ (20, 60, 100), with the seabed readable through the shallows.
- Water sheeting off surfaces leaves a sharp **wet-line** with the §4.5 mask.
- The **glitter path** toward the sun is the map's brightest element and the primary bloom source
  in a quiet frame: over-range specular pinpricks on Gerstner slopes, driven by real roughness
  (0.02–0.06) and real normals, never a scrolling texture.

### 8.6 Screen-space / near-plane layers

- **Blood and wet droplets** on the near plane: irregular red-brown blobs 15–40 px,
  semi-transparent, **defocused** (they sit in front of the focus plane) and **refractive** —
  they distort and blur what is behind them. Concentrated lower-left and lower-centre. Thin over
  4–8 s.
- **Damage vignette**: soft inward gradient occupying the outer 12 % of the frame, peaking at
  ≈ (140, 20, 20) at 40–60 % opacity at the extreme edge. Post effect, never lighting.
- **Lens flare** is used at very low amplitude and only when the sun or a fireball is in frame: a
  faint horizontal anamorphic streak at ~2 % of frame height and only 10–20/255 amplitude, plus a
  chain of elliptical ghosts (≈ 40 × 90 px, +15/255, warm with rainbow fringing) running through
  frame centre. Nothing here would be noticeable if you were not looking for it. **No
  dirt-on-lens overlay.**

### 8.7 Wind — everything moves

Palms, awnings, market cloth, flags, rope, dry grass, rigging on the freighter, and every smoke
column share **one wind field** with a common gust phase. Static vegetation in a frame that
otherwise has smoke drift is an instant tell. Wind also drives the vegetation velocity written
into `GVelocity` (P5), or TAA smears every frond.

---

## 9. HOW WE WIN

An honest reading of where a procedural WebGL build can beat a shipped AAA title, where it can
draw, and where it cannot — and what that implies for how we compose every single shot.

### 9.1 Where we can genuinely match or beat the reference

**Atmosphere. This is the win.** Aerial perspective, a physical sky, height-layered marine haze,
forward-scattering in-scatter and volumetric shafts are *pure mathematics*. They cost no artists,
no asset budget, no memory, and no production time. Our sky can be a full Bruneton-class
multi-scattering solve because we have one map and one weather state to bake, where a shipped
title amortises the same LUTs across forty maps and ships a compromise. **We should be more
atmospheric than the reference, not less**, and every time a shot looks under-hazed the answer is
more haze.

**Light transport.** One directional light, one map, one time of day. We can afford a 4096²
four-cascade PCSS setup, half-res GTAO with bent normals, a 160×90×64 froxel volume and a
per-frame PMREM re-bake *for one lighting state*, because we never have to make it work for
thirty. Our shadows can be softer, better-graded and better-occluded than a title that must ship
the same rig at 4 a.m. on a snow map.

**The grade.** §5 is a closed-form specification. A LUT bake is a LUT bake; there is no
quality ceiling imposed by the platform. Every number in §5.2 and §5.3 is achievable exactly.
This is free parity with a shipped title and it is worth an enormous amount, because the grade is
what a viewer reads in the first 200 ms.

**Composition.** We control the camera, the level layout and the sun azimuth simultaneously.
Every shot can be staged so a vertical face splits into a lit and a sky-lit half, so three
luminance bands separate, and so a near-field occluder anchors the depth. A shipped title's
gameplay frames are whatever the player happened to be looking at. Ours never have to be.

**Material response.** PBR is PBR. Curvature-driven wear, cavity grime, N·up dust and wet masks
are *procedural by nature* — they are generated from geometry, so they are inherently
non-repeating and inherently correct at every zoom. This is one of the few places where "no
authored textures" is an advantage rather than a constraint: a hand-painted wear map has a
resolution; a curvature-driven one does not.

**Detail density at close range.** Our micro-normal and mesoscale layers are evaluated in the
shader, so they do not run out of texels. A surface can keep resolving as the camera approaches
in a way a 2K albedo texture cannot.

### 9.2 Where we cannot compete, honestly

**Characters, and above all faces.** A shipped title has scanned heads, wrinkle maps, per-actor
groom, subsurface profiles authored per skin tone, and hundreds of hand-animated clips. We will
have procedural humanoids. **At close range and in the mid-ground, our soldiers will lose, badly,
against any reference frame that features a face.** This is the single largest gap and no amount
of rendering fixes it.

**Asset variety.** DICE ships thousands of unique props. We ship a procedural kit of maybe forty
archetypes with parametric variation. At mid-distance in a dense urban frame, ours will read as
repetition.

**Animation.** Reload animations, weapon handling, ragdolls, character locomotion — all of it is
hand-keyed content in the reference. Ours is procedural. Weapon *feel* (recoil, sway, bob, ADS)
we can match; character *performance* we cannot.

**Vegetation density and destruction.** Real-time destruction with authored break states and
million-instance foliage are content problems, not rendering problems.

### 9.3 The strategic implication — how every shot must be composed

This follows directly and it is not negotiable:

1. **Faces are never the subject and are never at hero scale.** Soldiers appear in silhouette,
   rim-lit, backlit, at distance, partially occluded, in motion blur, or behind smoke. Every one
   of those states is *also* how the reference frames its soldiers most of the time, so this is
   not a dodge — it is the same framing, chosen for a different reason. A soldier at 25 m,
   rim-lit against a smoke column, reads as AAA. The same soldier at 3 m in flat light reads as a
   student project.

2. **Push the win to the front of the frame.** The near field belongs to the things we do best:
   the viewmodel (one asset, unlimited detail budget), a rubble/stone occluder (procedural wear
   at its best), water, foam, dust. The mid-ground, where asset variety would be exposed, is
   deliberately veiled by §3.2's fog fractions.

3. **Depth over density.** Our answer to "not enough unique props" is three separated luminance
   bands, strong aerial perspective and a near-field occluder — which is *exactly* what makes the
   reference frames read as depth in the first place. A frame with four objects and superb depth
   separation beats a frame with forty objects on a flat plane, and it beats it in a blind A/B.

4. **Atmosphere is the primary subject of the map, and the map is designed around that.** BRAVO
   looks into the sun over water: backlit cranes, shafts through the gantries, the glitter path,
   maximum haze. CHARLIE looks away: cool teal fill, the deepest aerial ladder, the headland at
   96 % blend. ALPHA runs cross-sun for material readability. Every objective is chosen to show
   off something we are good at.

5. **Motion, wind and VFX carry the life that animation would otherwise carry.** Palms moving,
   awnings snapping, smoke shearing, embers rising, water working. A still frame of ours must
   contain evidence of motion; a moving frame must contain a lot of it.

6. **When in doubt, add atmosphere and subtract objects.** That is the whole strategy in one
   sentence.

---

## 10. Acceptance checklist

Run on any registered shot PNG. A shot that fails any **bold** line is not done.

**Lighting**
- [ ] **Same material, sunlit vs shadowed: display-luma ratio 2.5–4.5:1 on open ground, 5.0–9.0:1 on a sunward vertical face**
- [ ] **No shadow more than 4.5 stops below its sunlit neighbour anywhere in the frame**
- [ ] Shadowed and sunlit patches of the same material differ in **hue**, not only value
- [ ] Every vertical face in frame shows both a lit and a sky-lit side
- [ ] Object/ground contacts carry a 3–8 px AO band darker than the cast shadow
- [ ] Shadow penumbra differs measurably between a near occluder and a far one
- [ ] The viewmodel casts a visible shadow

**Atmosphere**
- [ ] **12–20 % of frame area behind a translucent layer in a quiet frame; never 0 %**
- [ ] **Foreground geometry at 15 m is already 14–20 % blended toward the sky**
- [ ] Sky hue does not change with elevation; only saturation and value do
- [ ] Horizon is brighter than the sky 30° up, and warms toward the sun azimuth
- [ ] Haze in the sun azimuth is brighter than sky sampled away from it
- [ ] Distant geometry on the anti-sun side is bluer/more saturated than the horizon sky

**Materials**
- [ ] **Luminance σ inside a nominally uniform patch ≥ 12, target 20–40**
- [ ] **No geometry meets the ground without a 10–50 cm transition band**
- [ ] Paint chips appear only on convexities; grime only in cavities; dust only on N·up faces
- [ ] Nothing repeats visibly at silhouette, 3 m, or 0.3 m zoom
- [ ] No albedo below linear 0.035 or above 0.82

**Grade**
- [ ] **p50 in 70–115; p25–p75 inside 55–150**
- [ ] **< 0.30 % of pixels above display 250; < 5.0 % below display 8, and no large flat area at black**
- [ ] **Mean HSV saturation peaks in luma bucket 48–96 or 96–144 at 0.40–0.55, and is below 0.10 above 240**
- [ ] p99 in 195–248; no diffuse surface clipped
- [ ] Highlights near-neutral (|B−R| ≤ 10 above L 240); midtones warm (B−R −48…−24 at L 96–144)

**Post**
- [ ] **A diffuse surface at display 224 produces no measurable bloom halo**
- [ ] A genuine emitter's halo is still ≥ 20 % amplitude at r = 400 px and veils the frame at ~10 %
- [ ] Viewmodel acutance measurably below world acutance; nothing beyond 4 m is defocused
- [ ] Grain invisible on flat sky; chroma noise exactly zero
- [ ] CA zero inside 60 % frame radius, ≤ 1.2 px at the corner
- [ ] Moving objects streak while static neighbours stay sharp

**Framing**
- [ ] **Screen centre (0.5, 0.5) unoccluded; nearest viewmodel pixel ≥ 0.055 W away**
- [ ] **Viewmodel coverage 12–16 %; bbox inside x 0.51–0.85, y 0.47–1.00**
- [ ] **Left half above y = 0.5 H entirely clear of viewmodel**
- [ ] Horizon within ±6 % of the frame centreline (registered shot cameras)
- [ ] Three separated luminance bands present, near/mid/far
- [ ] Near-field occluder covering 20–35 %, 2–4× darker than the midground
