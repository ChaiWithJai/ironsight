export const meta = {
  name: 'ironsight-reference-study',
  description: 'Study real Battlefield gameplay frames; produce a HUD spec and a critic reference index',
  phases: [
    { title: 'Triage', detail: 'agents each study a slice of the 135 gameplay + 48 press frames' },
    { title: 'Spec', detail: 'write HUD_SPEC.md, LOOK_SPEC.md and REFERENCE_INDEX.md' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()
const GP = `${ROOT}/reference/gameplay`
const PRESS = `${ROOT}/reference/battlefield`

const PRE = `You are working in ${ROOT} on IRONSIGHT, a browser FPS built in Three.js that must pass
as a shipped AAA Battlefield-quality title. Read ${ROOT}/docs/BRIEF.md first.

\`${ROOT}/reference/\` holds real Battlefield frames, pulled locally as a calibration target. They
are gitignored and never shipped; no pixel or asset from them enters the build. We study them to
learn WHAT PROPERTIES to reproduce with our own procedural code.

  reference/gameplay/  — 135 REAL in-game player screenshots (bf6_gp_*, bf2042_gp_*, bfv_gp_*,
                         redsec_gp_*). These are the ground truth: real HUD, real first-person
                         framing, real in-engine lighting. THIS is the look we must match.
  reference/battlefield/ — 48 official press screenshots. Staged bullshots, no HUD, often
                         third-person. Useful ONLY for atmosphere/lighting ambition, not for
                         framing or UI.

You must actually \`Read\` every image assigned to you. Do not speculate about images you have
not opened.`

const HUD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['elements', 'typography', 'palette', 'layoutRules', 'observations'],
  properties: {
    elements: {
      type: 'array',
      description: 'Every distinct HUD element observed.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'screenPosition', 'appearance', 'behaviour', 'sourceImages'],
        properties: {
          name: { type: 'string' },
          screenPosition: { type: 'string', description: 'Anchor + approximate offset as % of screen, e.g. "top-centre, y=2%".' },
          appearance: { type: 'string', description: 'Exact visual description: shapes, sizes relative to screen height, stroke weights, fills, opacity, icons.' },
          behaviour: { type: 'string', description: 'How it animates/changes in response to gameplay.' },
          sourceImages: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    typography: { type: 'string', description: 'Typeface character (condensed? mono? grotesque?), weights, letter-spacing, case, approximate sizes as % of screen height, and how numerals are rendered.' },
    palette: { type: 'string', description: 'Exact colour roles with hex estimates: friendly, enemy, neutral, warning, background scrims, and the opacity levels used.' },
    layoutRules: { type: 'string', description: 'Safe margins, grouping, alignment grid, and what stays visible vs what fades.' },
    observations: { type: 'array', items: { type: 'string' }, description: 'Non-obvious details that would be missed by someone reconstructing from memory.' },
  },
}

const LOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lighting', 'atmosphere', 'materials', 'grade', 'composition', 'vfx', 'tells'],
  properties: {
    lighting: { type: 'string' },
    atmosphere: { type: 'string' },
    materials: { type: 'string' },
    grade: { type: 'string', description: 'Colour grading: shadow/midtone/highlight tinting, contrast curve, saturation behaviour, black level.' },
    composition: { type: 'string', description: 'Framing, FOV, viewmodel placement and scale, foreground occluders, horizon placement.' },
    vfx: { type: 'string' },
    tells: { type: 'array', items: { type: 'string' }, description: 'Specific reproducible properties that make these read as AAA in-engine rather than as a demo.' },
  },
}

phase('Triage')

// Slice the corpus so every image gets opened by exactly one agent, and so each
// agent's slice is coherent enough to draw conclusions from.
const HUD_SLICES = [
  { key: 'hud-bf6-a', files: 'bf6_gp_000.jpg through bf6_gp_013.jpg' },
  { key: 'hud-bf6-b', files: 'bf6_gp_014.jpg through bf6_gp_027.jpg' },
  { key: 'hud-bf6-c', files: 'bf6_gp_028.jpg through bf6_gp_039.jpg' },
  { key: 'hud-2042', files: 'bf2042_gp_000.jpg through bf2042_gp_019.jpg' },
  { key: 'hud-redsec', files: 'redsec_gp_000.jpg through redsec_gp_014.jpg' },
]

const LOOK_SLICES = [
  { key: 'look-bf6-gameplay', files: 'bf6_gp_020.jpg through bf6_gp_039.jpg', dir: GP, note: 'Real in-engine look. This is the achievable target.' },
  { key: 'look-2042-gameplay', files: 'bf2042_gp_020.jpg through bf2042_gp_039.jpg', dir: GP, note: 'Real in-engine look on large open maps.' },
  { key: 'look-bfv-gameplay', files: 'bfv_gp_000.jpg through bfv_gp_019.jpg', dir: GP, note: 'Real in-engine; BFV has the strongest volumetrics/weather of the series.' },
  { key: 'look-press', files: 'all 48 files in reference/battlefield/', dir: PRESS, note: 'Staged press shots — read these for lighting AMBITION only, not framing.' },
]

const hudReports = await parallel(
  HUD_SLICES.map((s) => () =>
    agent(
      `${PRE}

TASK: Reverse-engineer the Battlefield HUD from real gameplay frames so we can reconstruct it
faithfully in DOM/canvas.

Open and study these images in ${GP}: ${s.files}

For every HUD element you can see, record exactly what it looks like and where it sits. Be
obsessive and quantitative — someone will rebuild this from your notes alone, without access to
the images. Measure positions as percentages of screen width/height. Estimate stroke weights,
corner radii, icon shapes, opacity of background scrims, and font sizes relative to screen
height. Note the difference between infantry HUD and vehicle HUD if both appear in your slice.

Pay particular attention to things a reconstruction-from-memory would get wrong: the exact
bracket/tick shapes, how numerals are styled, the segmented ticket bar's construction, the
capture-point letter row and how ownership is encoded, killfeed layout, the squad list, the
minimap frame, hit markers, damage direction indicators, and the low-opacity scrims behind text.

Do NOT write files. Return the structured output only.`,
      { label: s.key, phase: 'Triage', schema: HUD_SCHEMA, effort: 'high' },
    ),
  ),
)

const lookReports = await parallel(
  LOOK_SLICES.map((s) => () =>
    agent(
      `${PRE}

TASK: Reverse-engineer the RENDERING and ART DIRECTION from these frames.

Open and study these images in ${s.dir}: ${s.files}
Context on this slice: ${s.note}

Describe, precisely and reproducibly, what the renderer is doing. We need to reproduce these
properties in Three.js with procedural assets, so frame everything as an implementable property,
not as an aesthetic impression. For example: not "moody lighting" but "shadows carry ~15%
saturation of the sky hue; sun is ~4000K against a ~12000K sky ambient; shadow terminator is
soft over roughly 2-3 degrees".

Cover: key light colour/intensity/angle; ambient and bounce behaviour; how much of the frame is
volumetric/particulate and at what density; aerial perspective falloff rate; material response
(roughness ranges, how wet/dry surfaces differ, edge wear); the colour grade (what happens to
shadows, midtones, highlights; black level; saturation vs luminance); highlight rolloff and
bloom threshold; DOF usage and bokeh character; grain; the composition and FOV of first-person
frames including exactly where the viewmodel sits and how much of the screen it occupies; and
the VFX vocabulary (smoke, dust, tracers, muzzle flash, impacts).

Do NOT write files. Return the structured output only.`,
      { label: s.key, phase: 'Triage', schema: LOOK_SCHEMA, effort: 'high' },
    ),
  ),
)

const huds = hudReports.filter(Boolean)
const looks = lookReports.filter(Boolean)
log(`${huds.length}/${HUD_SLICES.length} HUD reports, ${looks.length}/${LOOK_SLICES.length} look reports`)

phase('Spec')

const hudDigest = huds
  .map((h, i) => `--- HUD SLICE ${HUD_SLICES[i]?.key} ---
ELEMENTS:
${(h.elements || []).map((e) => `  * ${e.name} @ ${e.screenPosition}\n      look: ${e.appearance}\n      behaviour: ${e.behaviour}`).join('\n')}
TYPOGRAPHY: ${h.typography}
PALETTE: ${h.palette}
LAYOUT: ${h.layoutRules}
NOTES:
${(h.observations || []).map((o) => '  - ' + o).join('\n')}`)
  .join('\n\n')

const lookDigest = looks
  .map((l, i) => `--- LOOK SLICE ${LOOK_SLICES[i]?.key} ---
LIGHTING: ${l.lighting}
ATMOSPHERE: ${l.atmosphere}
MATERIALS: ${l.materials}
GRADE: ${l.grade}
COMPOSITION: ${l.composition}
VFX: ${l.vfx}
TELLS:
${(l.tells || []).map((t) => '  - ' + t).join('\n')}`)
  .join('\n\n')

const specs = await parallel([
  () =>
    agent(
      `${PRE}

Five agents independently reverse-engineered the Battlefield HUD from real gameplay frames:

${hudDigest}

TASK: Write \`${ROOT}/docs/HUD_SPEC.md\` — a complete, buildable specification for the IRONSIGHT
HUD, matching the reference HUD's visual language element for element.

It must be precise enough that a UI engineer who has never seen the reference images can build
a pixel-faithful HUD from this document alone. Include:

- A screen-space layout map: every element, its anchor, its offset in % or vmin, its z-order.
- Exact specs per element: dimensions, stroke weights, fills, opacities, corner treatment, icon
  geometry described well enough to draw as SVG/canvas paths.
- A full colour token table with hex values and their semantic roles.
- A type scale with sizes in vmin, weights, letter-spacing and case. Since we ship no font files,
  specify the CSS system-font stack that gets closest to the reference's condensed technical face,
  plus the exact CSS (transforms, tracking, synthetic weight) needed to close the gap. A default
  browser font look is an automatic failure.
- Motion specs: what animates, over what duration, on what easing curve.
- The state machine for every dynamic element (ticket bar, capture points, killfeed, hitmarker,
  damage indicator, reload, low-ammo, spotted, squad list).

Where the five reports disagree, decide and note the decision in one line. Where our game differs
from the reference (we have three capture points, not nine), adapt the design rule rather than
copying the literal layout, and say so.

Verify your own work: after writing, re-open two or three of the reference gameplay frames in
${GP} and check your spec against them. Fix anything you got wrong.`,
      { label: 'write-hud-spec', phase: 'Spec', effort: 'high' },
    ),
  () =>
    agent(
      `${PRE}

Four agents independently reverse-engineered the rendering and art direction from real frames:

${lookDigest}

TASK: Write \`${ROOT}/docs/LOOK_SPEC.md\` — the authoritative art-direction and rendering target
for IRONSIGHT, expressed as implementable properties.

Structure it as a spec an engineer implements against, with concrete numbers throughout:
- Key/fill/ambient light model: colour temperatures, intensities in physical units, sun angle.
- Atmosphere: participating-media density, height falloff, aerial-perspective curve, how much of
  frame area should be particulate, volumetric shaft intensity.
- Materials: roughness ranges per material class, albedo ranges (nothing pure black or white),
  edge-wear and cavity-grime rules, detail-normal scale and tiling frequencies.
- Colour grade: the full chain — exposure, tonemapper choice, shadow/mid/highlight tinting,
  contrast curve, saturation-vs-luminance behaviour, black lift, and the split-tone targets.
- Post: bloom threshold and falloff, DOF parameters and when it engages, grain amount and size,
  vignette strength, chromatic aberration extent.
- First-person framing: FOV, viewmodel FOV if separate, exact viewmodel screen placement and
  coverage percentage, ADS transition targets.
- VFX vocabulary with lifetimes, sizes and colours.

Then add a section "HOW WE WIN" that is honest about where a procedural WebGL build can match or
beat the reference (atmosphere, light transport, grade, composition, material response) and where
it cannot (character/facial density, asset variety), with the strategic implication for how our
shots should be composed.

Verify your own work against two or three reference frames in ${GP} after writing.`,
      { label: 'write-look-spec', phase: 'Spec', effort: 'high' },
    ),
  () =>
    agent(
      `${PRE}

TASK: Build the critic reference index — the map that tells the visual critic loop which real
frame to blind-A/B each of our shots against.

1. Skim-review the corpus. You do not need to deeply analyse every image, but you must open
   enough of them across ALL FOUR titles in ${GP} (and sample ${PRESS}) to classify the corpus.
2. Write \`${ROOT}/docs/REFERENCE_INDEX.md\` containing:
   - A table of the most useful reference frames: filename | title | what it is (first-person
     infantry / vehicle / vista / interior / night / weather) | what it is the best reference FOR
     (HUD layout, volumetrics, water, foliage, viewmodel framing, destruction, grade...).
   - A "COMPARISON PAIRS" section: for each planned IRONSIGHT shot below, name the 2-3 reference
     frames that are the fairest blind-A/B partners — matched for time of day, environment type,
     and framing, so the comparison tests our rendering rather than our subject matter.
     Planned shots: hero_harbour (FP infantry, golden hour, town + water), viewmodel_ads (weapon
     ADS close), market_square (interior/exterior transition, hard sun + deep shade),
     headland_vista (long-range vista, aerial perspective), firefight (combat with VFX, smoke,
     tracers), night_flares (low light + emissives), hud_full (HUD legibility over gameplay).
   - A "DO NOT COMPARE AGAINST" list: reference frames whose subject matter would make for an
     unfair or uninformative comparison (heavy character close-ups, vehicle cockpit interiors we
     do not have, etc.), with the reason.
3. Rank the 12 single most valuable reference frames overall and say why each earns its place.

The goal is that a critic given "shot X" can look up exactly which references to compare against
without having to browse 183 images.`,
      { label: 'write-reference-index', phase: 'Spec', effort: 'high' },
    ),
])

return {
  hudReports: huds.length,
  lookReports: looks.length,
  specs: specs.filter(Boolean).length,
}
