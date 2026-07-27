export const meta = {
  name: 'ironsight-visual-lanes',
  description: 'Wave 2: the nine visual lanes that close the AAA gap',
  phases: [
    { title: 'Visual', detail: 'material, post, light, sky, terrain, water, vegetation, vfx, hud' },
    { title: 'Integrate', detail: 'whole-build verify, capture all shots, fix breakage' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

const COMMON = (lane, dist) => `You are the **${lane}** lane agent on IRONSIGHT, working in ${ROOT}.

This is WAVE 2 — the visual wave. Wave 1 built the simulation: the map, physics, weapons, AI,
Conquest and audio all work, and 22 shots capture successfully. **What is missing is everything
that makes it look like a game rather than a blockout.** That is your job.

READ FIRST, IN THIS ORDER — all of them, in full:
  1. ${ROOT}/docs/BRIEF.md          — the project contract
  2. ${ROOT}/docs/LOOK_SPEC.md      — **THE ART DIRECTION LAW.** Derived by measuring real
                                       Battlefield gameplay frames pixel by pixel. Photometric
                                       units, measured sun colours, derived exposure, hard
                                       composition rules. Where it gives a number, use that
                                       number. Where you deviate, say so in your report and why.
  3. ${ROOT}/docs/AAA_RUBRIC.md     — how the critics will judge you
  4. ${ROOT}/docs/ARCHITECTURE.md   — find YOUR lane's sections
  5. ${ROOT}/docs/OWNERSHIP.md      — exactly which files you own
  6. ${ROOT}/src/engine/types.ts    — the contract layer. THIS IS YOUR API.

You may also study \`${ROOT}/reference/gameplay/*.jpg\` directly — 135 real in-game frames.
\`${ROOT}/docs/REFERENCE_INDEX.md\` says which ones are the best reference for what.
Nothing from reference/ enters the build; we reproduce PROPERTIES with our own procedural code.

=== THE RULES ===
* You own ONLY the globs listed for **${lane}** in OWNERSHIP.md. Eight other agents are working
  in this repo RIGHT NOW in parallel.
* \`src/engine/harness.ts\`, \`src/bootstrap/subsystems.ts\`, \`src/bootstrap/nulls.ts\`,
  \`src/shots/index.ts\` are FROZEN.
* Append to YOUR OWN named section of \`src/engine/types.ts\` only, narrowly; report it.
* Your three exports (\`create*\`, \`register*Bakes\`, \`reset*\`) keep their exact name/path/signature.
* NO \`Math.random()\` — use \`ctx.rng\`. Determinism is what makes the critic loop possible.
* NO placeholders, NO TODOs.

=== BUILD ISOLATION ===
    IRONSIGHT_DIST=${dist} npm run build
    IRONSIGHT_DIST=${dist} ./tools/shoot.sh <shot>
\`npm run typecheck\` and \`npm run boundaries\` are safe bare.

=== DONE MEANS ALL OF ===
  1. \`npm run typecheck\` clean  2. \`npm run boundaries\` clean  3. build succeeds
  4. Your shots capture (exit 0)  5. **You have Read the PNGs**
  6. You compared your frame against the reference: run
     \`./tools/compare.sh --ours tools/shots/<shot>.png --ref reference/gameplay/<ref>.jpg --out tools/compare/<name>.png\`
     and Read the resulting A/B sheet. Do NOT open \`tools/compare/.keys/\`. Say honestly which
     panel looks better and why. If ours is obviously worse, keep working.

=== REPORT ===
What you built, LOOK_SPEC deviations and why, shots, your honest A/B read, what is still weak.`

phase('Visual')

const LANES = [
  {
    id: 'RCORE-MATERIAL', dist: 'dist-mat',
    brief: `You own \`src/render/material/**\`. **THIS IS THE HIGHEST-VALUE TASK IN THE PROJECT.**

BAKE already produces excellent procedural PBR TextureSets — see \`tools/shots/bake.png\`, six
materials with real wear, grime, micro-normal and a 70 m deck with no visible tiling. **None of
it reaches the level**, because the material factory still hands out day-0 \`MeshStandardMaterial\`
that ignores every \`TextureSet\`. The entire town is flat single-colour geometry sitting on top of
a working texture pipeline. Fix that and the game changes more than from any other single change.

Build the UBER MATERIAL: one shader family, driven by \`MaterialSpec\`/\`MaterialFeature\`, that
consumes a TextureSet and does — per LOOK_SPEC section 4 —
  - full PBR with correct energy conservation and Fresnel at grazing angles (LOOK_SPEC is
    explicit that a large flat surface must gain specular sheen toward the horizon)
  - **triplanar projection** on terrain and anything steep, to kill UV stretching
  - **detail normals** at a second, much higher frequency so surfaces stay detailed as the camera
    approaches, blended by distance
  - **curvature-driven edge wear** and **cavity-driven grime** — LOOK_SPEC gives the masks; this
    is what stops every surface reading as uniformly new
  - per-instance colour/roughness variation so no two buildings match
  - correct **motion vectors** into the velocity buffer (TAA and motion blur depend on you)
  - depth/shadow/velocity variants staying in sync, and the \`setUniform\` seam working
  - \`MaterialFeature.SoftParticle\` fragment depth-fade for VFX
  - \`createUnlit\` for sky/UI/gizmos
Watch the shader permutation budget — it was raised to 96/128/160/192 after wave 1 measured 44.

Register shots \`material_chart\` (your materials on real level geometry, not spheres) and
\`material_grazing\` (a long flat surface receding to the horizon, to prove Fresnel and tiling).`,
  },
  {
    id: 'RCORE-POST', dist: 'dist-post',
    brief: `You own \`src/render/service.ts\`, \`graph.ts\`, \`targets.ts\`, \`fullscreen.ts\`,
\`camera-rig.ts\`, \`color.ts\`, \`src/render/passes/**\`. You own THE FRAME.

Per LOOK_SPEC sections 5 and 6, build the full post chain in the correct order:
  - **TAA** with proper motion-vector reprojection, neighbourhood clamping and a jitter sequence.
    It must resolve thin geometry (railings, wires, antennae) without ghosting or smearing —
    LOOK_SPEC calls smeared thin geometry an automatic tell.
  - **Auto-exposure** derived per LOOK_SPEC section 2.1 (exposure = 0.18 / L_grey) with a
    plus/minus 0.75 EV clamp, and FROZEN to the preset value whenever \`FrameCtx.deterministic\`
    is true, or shots are not comparable frame to frame.
  - **Bloom** thresholded so only genuine emitters bleed. A global glow is a fail.
  - **Depth of field** with real bokeh, engaging per the spec's rules.
  - **Motion blur** from the velocity buffer — per-object, never a full-screen radial smear.
  - **The grade**: filmic tonemap (LOOK_SPEC names the operator), the split-tone targets
    (warm highlights / cool shadows — a neutral frame reads as an untouched render), the contrast
    curve, black level, and saturation-vs-luminance behaviour.
  - **Lens character with restraint**: vignette, corner-only chromatic aberration, fine grain that
    sits UNDER the detail. If any is individually noticeable it is too strong.
Also make sure the camera rig exposes what the harness needs to pose shots exactly.

Register \`post_chain\` (a frame with genuine bright and dark regions proving the histogram is
fully occupied) and \`post_dof_bokeh\`.`,
  },
  {
    id: 'LIGHT', dist: 'dist-light',
    brief: `You own \`src/render/lighting/**\`.

Wave 1's integration lead reported: *"There is effectively no ambient or indirect light. Every
shadowed face crushes to near-black. Terraced buildings look like floating slabs because the walls
between them are void-black — a lighting bug that presents as a modelling bug."* That is your
first fix and it is worth more than anything else you do.

Per LOOK_SPEC section 2, build:
  - **ONE directional sun**, photometric, with the measured colour ramp (3400 K at 11 degrees
    elevation). No fill lights, no rim lights — every secondary light must be a real emitter.
  - **Cascaded shadow maps**: 4 cascades, stable texel snapping (no shimmer when the camera
    moves), slope-scaled depth bias, normal-offset to kill acne without peter-panning, and
    **contact-hardening penumbrae** — penumbra width must grow with occluder distance. Wave 1 has
    ONE cascade at 180 m and three deprecates \`PCFSoftShadowMap\` to \`PCFShadowMap\` at boot, so
    there is currently no penumbra at all. Do not rely on three's shadow path if it fights you.
  - **Sky ambient with real directional variation** — a cool sky term from above and a warm bounce
    term tinted by the ground albedo on undersides. Uniform ambient is an automatic fail.
  - **GTAO/HBAO** that darkens creases and contact points WITHOUT the grey-halo artefact.
  - **Clustered local lights** so muzzle flashes, fires, flares and windows genuinely illuminate
    their surroundings with inverse-square falloff.
  - **Sky occlusion** so interiors and shaded sides lose sky light, not just sun light.

Register \`light_cascades\` (an object casting across a cascade boundary, proving no seam),
\`light_contact\` (a crate touching ground — razor shadow at contact, softening along its length)
and \`light_interior\` (an interior proving sky occlusion and bounce).`,
  },
  {
    id: 'SKY', dist: 'dist-sky',
    brief: `You own \`src/world/sky/**\`.

Currently: a gradient with a hard white sun disc. Per LOOK_SPEC section 3, build:
  - **Physical atmospheric scattering** — real Rayleigh + Mie with a forward-scattering lobe
    around the sun, precomputed into LUTs at bake time. Rayleigh blue overhead falling to a warm
    scattered horizon. A vertical linear gradient is an automatic fail.
  - **The sun disc rendered near-WHITE, not orange** — LOOK_SPEC section 2.2 is emphatic and cites
    a measured pixel: warmth belongs in the dome and the in-scatter, never the disc. Drawing an
    orange sun is a first-glance tell.
  - **Aerial perspective** applied to all geometry by distance, on the measured falloff curve.
    LOOK_SPEC: reference mountains sit within ~15% of pure sky colour. When it looks overdone in
    isolation it is probably correct — its absence is the single loudest "hobby demo" signal.
  - **Volumetric light shafts** where geometry occludes the sun, with varying density — not a
    uniform fog constant. Raymarched against the cascades.
  - **Volumetric clouds** with internal self-shadowing and sun-side silver lining. Flat-lit clouds
    are a fail. They must sit in the scattering model, not on top of it.
  - Time-of-day driven by \`ShotContext.setTimeOfDay\` — the harness poses this per shot.

Register \`sky_golden\`, \`sky_shafts\` (volumetric shafts through the harbour cranes) and
\`sky_clouds\`.`,
  },
  {
    id: 'TERRAIN', dist: 'dist-terrain',
    brief: `You own \`src/world/terrain/**\`.

NOTE: \`src/engine/macro.ts\` changed since wave 1 — the secondary headland shoulder dropped
16 m to 8 m and a 14 m saddle was cut along the CHARLIE-to-BRAVO line to open the map's central
sightline. Your heightfield derives from it, so re-derive rather than assuming old values.

Build the visual terrain: a chunked LOD heightfield with crack-free stitching between levels
(no T-junction seams), **splat-mapped materials** blended by slope, altitude and curvature —
sand at the waterline, dry grass and scrub on the terrace, bare rock on the headland — using
BAKE's TextureSets through RCORE's triplanar path so steep faces do not stretch.

Critical details:
  - The shoreline currently meets the water on a **visible sawtooth** from the macro grid.
    Fix it — a shoreline is the most-looked-at silhouette on this map.
  - Distance-blended detail so terrain never goes smooth as you approach, and never tiles.
  - \`heightAt()\` must stay bit-matched with the GPU heightmap; physics, nav and scatter all
    read it and a mismatch desyncs collision from visuals.
  - Ground-transition detail where terrain meets built geometry.

Register \`terrain_shore\`, \`terrain_headland\` and \`terrain_lod_seam\`.`,
  },
  {
    id: 'WATER', dist: 'dist-water',
    brief: `You own \`src/world/water/**\`.

Currently a flat teal plane with one specular streak. This map is a HARBOUR — water is in most
frames and LOOK_SPEC treats blown highlights on water as a signature of the look.

Build:
  - **Gerstner wave hierarchy** with wind-driven direction and a real spectrum, displacing
    geometry (not just normals), with analytic derivatives for exact normals.
  - **Correct water shading**: Fresnel-weighted reflection vs refraction, depth-based absorption
    and scattering tint (shallow turquoise over sand to deep blue), and specular sun glitter that
    genuinely blows out — that is where the frame's brightest pixels should live.
  - **Screen-space reflections** for the harbour structures and the freighter, degrading to a
    sky/cubemap probe at grazing angles rather than smearing.
  - **Shore interaction**: read \`TerrainService.shoreMask\`, generate foam on the waterline and
    around obstacles, wet-sand darkening that responds to wave run-up, and a soft depth-faded
    intersection with the beach — a hard waterline is an automatic tell.
  - Underwater: absorption tint and murk via your \`PassOrder.Underwater\` slot.
  - Motion vectors so TAA and motion blur see the wave motion.

Register \`water_golden\` (sun glitter path toward camera), \`water_shore\` (foam and wet sand)
and \`water_freighter\`.`,
  },
  {
    id: 'VEG', dist: 'dist-veg',
    brief: `You own \`src/world/vegetation/**\`.

There is currently NO vegetation. Per LOOK_SPEC, a still world reads as a dead world, and
secondary motion is on the AAA requirements list.

Build:
  - **GPU-instanced scatter** driven by terrain slope/altitude/moisture masks, with LEVEL's
    exclusion volumes respected so nothing grows through a floor or a road.
  - **Grass and scrub** as camera-facing clustered cards with proper normals (not flat-lit
    billboards), density falling off with distance into a blended ground texture so there is no
    visible LOD pop line.
  - **Palms, olive trees, dry brush** appropriate to a Mediterranean/Levantine coast — built
    procedurally with real branch structure and leaf geometry, LODs down to impostors.
  - **Wind**: a coherent wind field with per-instance phase offset, gusts that travel across the
    field as a wave, and stiffness varying by plant type. Everything moving in lockstep is worse
    than nothing moving.
  - Correct motion vectors (wind motion must not smear under TAA — this is the classic failure).
  - Translucency so backlit leaves glow at golden hour. That single effect sells vegetation.

Register \`veg_field\` (wind-driven grass, backlit), \`veg_palms\` and \`veg_distance_blend\`.`,
  },
  {
    id: 'VFX', dist: 'dist-vfx',
    brief: `You own \`src/vfx/**\`.

Nothing currently draws. \`weapon_recoil_midburst\` has NO muzzle flash. The contract now has
everything you need — the \`Simulate = 420\` pass slot, \`SceneGraph.addDynamic\`,
\`MaterialFactory.setUniform\`, and \`MaterialFeature.SoftParticle\`.

Per LOOK_SPEC section 8 build a GPU particle system and the VFX vocabulary:
  - **Smoke** with internal detail, self-shadowing and curl-noise motion that DISSIPATES rather
    than fading uniformly. LOOK_SPEC: round white blobs with additive blending are an automatic
    fail. Soft-particle depth fade is mandatory — hard-edged cards intersecting ground is the
    classic tell.
  - **Muzzle flash** that lasts 1-2 frames, casts real light via LIGHT's clustered lights, and is
    followed by smoke.
  - **Impacts** by surface material: correct-coloured dust/spark/chip bursts, plus a **decal**
    that conforms to the surface it hit. Decal budget by tier.
  - **Tracers** as stretched ribbons with correct velocity, and **whizby** for near misses.
  - **Explosions**: a fireball with real rolloff, a pressure ring, debris that is actual geometry
    which bounces, and a lingering smoke column.
  - **Ambient particulate** — dust, pollen, sea spray. LOOK_SPEC calibration note #1: *there is no
    clear air, ever; every reference frame is 30-50% particulate by area.* This is one of the
    highest-value things in the whole project. Do not under-do it.
  - Destruction dust hooked to PHYS's events.

Register \`vfx_muzzle_flash\`, \`vfx_explosion\`, \`vfx_impacts\`, \`vfx_ambient_dust\`.`,
  },
  {
    id: 'HUD', dist: 'dist-hud',
    brief: `You own \`src/ui/**\`.

\`${ROOT}/docs/HUD_SPEC.md\` is 1300 lines of measured specification, reverse-engineered element by
element from real gameplay frames with quantitative positions, stroke weights, colour tokens and
motion curves. **Follow it.** It exists so you do not have to reconstruct a HUD from memory —
reconstruction-from-memory is exactly what produces a HUD that reads as fake.

Build the whole thing: ticket bar with segmented fill and bracketed enemy count, capture-point
row encoding ownership by fill AND shape, compass strip with degree ticks, killfeed, squad list
with class icons and health, minimap with view cone, ammo block with weapon silhouette, gadget
row, crosshair with dynamic spread, hitmarkers (body/head/armour/kill), damage direction
indicator, world-space objective and distance markers, reload/low-ammo/spotted states, the deploy
screen and the scoreboard.

Non-negotiables from the spec and the brief:
  - **No default browser look.** No system-font stack as-is, no pure #FFFFFF, no default controls.
    HUD_SPEC gives the CSS needed to reach a condensed technical face without shipping font files.
    BAKE also produces an SDF font atlas (\`BakedFont\`) — use it for in-canvas text.
  - Everything animates on and off with eased transitions. Nothing pops.
  - The HUD sits in the periphery and never fights the image for attention.
  - It must be LEGIBLE over a blown-out golden-hour sky — that is what the scrims are for.

CRITICAL: \`tools/capture.mjs\` screenshots the CANVAS ELEMENT ONLY. A DOM overlay is structurally
incapable of appearing in a shot, so the critics would never see your work. Render the HUD in-canvas
(see \`src/audio/debug/overlay.ts\` for a working in-canvas overlay pass using
\`PassOrder.DebugOverlay\`; yours belongs at \`PassOrder.Hud\`).

Register \`hud_full\` (HUD over live gameplay), \`hud_combat\` (hitmarker + damage direction +
killfeed active) and \`hud_deploy\`.`,
  },
]

const results = await parallel(
  LANES.map((l) => () =>
    agent(`${COMMON(l.id, l.dist)}\n\n=== YOUR LANE ===\n${l.brief}`, {
      label: `visual:${l.id}`,
      phase: 'Visual',
      effort: 'high',
    }),
  ),
)

const ok = results.filter(Boolean)
log(`${ok.length}/${LANES.length} visual lanes reported`)

phase('Integrate')

const integration = await agent(
  `You are the INTEGRATION LEAD on IRONSIGHT (${ROOT}). Nine visual lanes just worked in parallel.
This is the wave that decides whether the project looks AAA, so integrate carefully.

Read ${ROOT}/docs/BRIEF.md, ${ROOT}/docs/LOOK_SPEC.md and ${ROOT}/docs/OWNERSHIP.md.

Lane reports:
${LANES.map((l, i) => `\n########## ${l.id} ##########\n${ok[i] ?? '(NO REPORT — check this lane files yourself)'}`).join('\n')}

TASK:
1. \`npm run typecheck\`, \`npm run boundaries\`, \`IRONSIGHT_DIST=dist-integrate npm run build\`.
   Fix everything. Minimal correct fixes, kept in the owning file.
2. Capture EVERY registered shot. Any error, hang or black frame is a bug — fix it.
3. \`Read\` every PNG. Say what is actually visible.
4. Hunt specifically for INTEGRATION-ONLY failures — wave 1 proved these are the dangerous class:
   - two lanes registering the same PassOrder slot, or a pass reading a target another pass has
     already recycled
   - shader permutation budget exceeded once all lanes' materials coexist
   - the render graph's declared reads/writes disagreeing with what passes actually touch
   - TAA ghosting because a lane writes no motion vectors (vegetation and water are the usual
     offenders)
   - exposure fighting between auto-exposure and a lane that assumes a fixed value
   - double-applied fog/aerial perspective (SKY applying it AND the material applying it)
5. Check the whole frame is COHERENT: one sun direction everywhere including particles and
   vegetation; shadow, sky and water all agreeing on time of day; the grade applied once.
6. Delete stale \`dist-*\`. Commit with a clear message.

Report: what was broken, what you fixed, all working shots, and an honest rubric-scored read of
the best and worst frames — where are we against the 8.5 bar, per axis?`,
  { label: 'integrate-visual', phase: 'Integrate', effort: 'high' },
)

return { lanes: ok.length, integration }
