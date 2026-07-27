export const meta = {
  name: 'ironsight-critic-loop',
  description: 'Harsh blind-A/B critic loop: fix, re-shoot, score, repeat until AAA',
  phases: [
    { title: 'Fix', detail: 'lane agents address the ranked defects' },
    { title: 'Shoot', detail: 'rebuild, capture hero shots, build blind A/B sheets' },
    { title: 'Critique', detail: 'harsh critics score blind against the rubric' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

// Hero shots the AAA verdict actually rests on, paired with the reference frame
// REFERENCE_INDEX nominates as the fairest blind partner.
const HEROES = [
  { shot: 'level_bravo',    ref: 'bf6_gp_020.jpg',   what: 'atmosphere hero, back-lit harbour' },
  { shot: 'light_cascades', ref: 'bf6_gp_012.jpg',   what: 'light transport + materials' },
  { shot: 'material_chart', ref: 'bf2042_gp_022.jpg',what: 'material response on real geometry' },
  { shot: 'weapon_ads',     ref: 'bf6_gp_004.jpg',   what: 'the first-person hero frame' },
  { shot: 'water_golden',   ref: 'bf6_gp_000.jpg',   what: 'water + glitter + sky' },
  { shot: 'sky_golden',     ref: 'bfv_gp_006.jpg',   what: 'sky, clouds, aerial perspective' },
  { shot: 'hud_full',       ref: 'bf6_gp_004.jpg',   what: 'HUD over live gameplay' },
  { shot: 'level_alpha',    ref: 'bf6_gp_005.jpg',   what: 'town interior/exterior, hard sun' },
]

const LANE_RULES = `
=== RULES (unchanged, and they still bind) ===
* You own ONLY your lane's globs in ${ROOT}/docs/OWNERSHIP.md. Other agents are working in this
  repo RIGHT NOW in parallel.
* harness.ts / subsystems.ts / nulls.ts / shots/index.ts are FROZEN.
* NO Math.random() — use ctx.rng. NO placeholders.
* \`npm run typecheck\` and \`npm run boundaries\` must be clean when you finish.
* Build/capture isolated: IRONSIGHT_DIST=<yourdist> npm run build / ./tools/shoot.sh <shot>
* LOOK at your result. Read the PNG. If it did not change what you expected, you are not done.
`

// Round 1 defects, ranked by the integration lead's measured rubric. The loop
// replaces this list with the critics' findings on every subsequent round.
let findings = [
  { lane: 'VEG', dist: 'dist-veg', axis: 'vegetation 5.5',
    defect: `**GRASS RENDERS AS BLACK SLASHES IN EVERY GROUND-LEVEL FRAME.** This is the single most
damaging defect in the project — it is the first thing anyone notices in light_cascades,
material_chart and level_alpha, and it alone makes the frames read as broken rather than merely
unfinished.

The integration lead's diagnosis is that it is partly a STAGING problem: four hero shots are
front-lit, so IRON_TRANSLUCENCY contributes ~0 and camera-facing blades face away from the sun.
That is a real contribution but DO NOT stop there — grass this black is also a shading bug. Check
in this order:
  1. Are the blade normals correct? Camera-facing cards need a bent/cylindrical normal, not the
     card's geometric normal, or they self-shadow to black at every angle.
  2. Is the grass receiving ambient/sky light at all, or only the sun term?
  3. Is two-sided rendering on, and is the backface normal flipped for lighting?
  4. Is alpha-test cutting the blade to a silhouette that then shades as if solid?
  5. Is it in the depth prepass now (RCORE just added WorldAlphaTest handling — verify)?
Grass must read as dry straw at golden hour: warm, translucent at the tips, darker at the base.` },

  { lane: 'RCORE-POST', dist: 'dist-post', axis: 'post/grade 6.0',
    defect: `**THE FRAME HAS NO BLACK POINT ANYWHERE.** Measured p0.1 is 50-130 across most frames
against a 3-20 target. This is the #1 reason a critic picks ours out instantly: a milky,
low-contrast wash. Saturation also runs ~2x under LOOK_SPEC section 5.

Fix the grade so the histogram is genuinely occupied end to end:
  - Establish a real black point. Something in frame must reach near-zero.
  - Restore the split-tone targets (warm highlights / cool shadows) at spec strength — a neutral
    frame reads as an untouched render.
  - Bring saturation to the spec curve.
  - Verify against LOOK_SPEC section 5.2's target percentiles (p50, IQR, p99) and section 10's
    acceptance checklist. light_cascades already hits the p99 195-248 band; make the rest match.
Do NOT achieve contrast by crushing shadows to void-black — LOOK_SPEC and the rubric both treat
crushed blacks as a defect. Lift the top and set the floor, do not just multiply.` },

  { lane: 'SKY', dist: 'dist-sky', axis: 'atmosphere 4.5 — WORST AXIS',
    defect: `Two separate defects, both flagged as top-3 tells.

**1. CLOUDS ARE HARD-EDGED WHITE ELLIPSES.** Visible as soft purple/white blobs in
light_cascades. The rubric calls flat-lit clouds an automatic fail and this is worse than flat —
they read as painted ovals. They need real volumetric structure: internal self-shadowing,
sun-side silver lining, soft eroded edges, and they must sit IN the scattering model.

**2. IN-SCATTER IS FAR TOO STRONG.** Foreground is veiled at 5 m against LOOK_SPEC section 10's
14-20% at 15 m. This is the milky wash's other half. The aerial ladder into the far distance is
GOOD — the fort genuinely hazes out correctly — so do not weaken the far end. Fix the near-field
falloff curve so the first 30 m is essentially clear.` },

  { lane: 'WATER', dist: 'dist-water', axis: 'water 4.0 — WORST AXIS',
    defect: `**1. BLACK WEDGE IN THE GLITTER PATH.** Present in water_golden and level_bravo. The
integration lead ruled out shafts, TAA and NaN (instrumented a magenta guard: zero pixels fired).
It is a genuinely computed ~0.8 cd/m2 against a 2.5e4 clamped specular — bimodal glitter. Their
lead, with evidence: your SSR march's \`step(1.0, hitLuma)\` accepts ANY hit above 1 cd/m2 and
substitutes it wholesale for the reflection; in level_bravo the wedge sits directly under the dark
crane boom. Fix the accept test and the fallback blend so a dark SSR hit cannot replace a bright
sky reflection.

**2. WATER READS AS A FLAT PALE SHEET AT DISTANCE.** Wave detail and glitter must persist toward
the horizon — that is where the frame's brightest pixels should live.

NOTE: the integration lead fixed two real bugs in your lane you should understand before touching
it — your GVelocity was in NDC where the rest of the frame uses UV (factor of 2), and you were
decoding SceneDepth as hardware depth when that target is R32F carrying LINEAR VIEW DEPTH IN
METRES. Your refraction and SSR were comparing nonsense and silently doing nothing, which is why
you reported refraction as "effectively untested". Re-test both now that they receive real data.` },

  { lane: 'LIGHT', dist: 'dist-light', axis: 'lighting 6.5',
    defect: `**WHITE Z-FIGHTING SHEETS.** Clearly visible in light_cascades as white horizontal
streaks inside the arcade and scattered white patches across the ground. These look like a shadow
or AO term blowing out on coplanar surfaces, or a depth-bias failure at grazing incidence. Find
the true cause rather than raising bias until it hides — raising bias trades this artefact for
peter-panning.

**CAST SHADOWS ARE BARELY VISIBLE.** Partly the front-lit staging (shadows fall away from
camera), but verify the cascades are actually resolving at the distances the hero shots use, and
that contact-hardening is producing a real penumbra gradient rather than a constant kernel.` },

  { lane: 'RCORE-MATERIAL', dist: 'dist-mat', axis: 'materials 7.0 — strongest, finish it',
    defect: `**VISIBLE 2.4 m ASHLAR REPEAT.** The wall texture repeats on a readable grid — the
rubric's first material test is "walk your eye across every large surface; if you can find the
repeat, it fails." Break it: stochastic/hex-tile sampling, a low-frequency colour and roughness
variation layer at a non-commensurate scale, per-block hue jitter driven by world position.

**GROUND SHOWS A DIAGONAL LATTICE TILING PATTERN** on the sand in material_chart and
light_cascades — same problem, more visible because the surface is large and flat.

Your axis is the strongest in the project; this is what stands between 7.0 and the bar.` },

  { lane: 'SHOTS-STAGING', dist: 'dist-stage', axis: 'composition — affects 4 hero shots',
    defect: `**FOUR HERO SHOTS ARE FRONT-LIT AND LOOK_SPEC SECTION 2.3 CALLS THAT A DEFECT** that
"appears in zero press frames". Measured against the current solar model (azimuth 261 degrees):
  level_charlie 25 degrees off directly-behind, material_chart 32, material_grazing 34,
  level_alpha 37. All front-lit. By contrast light_cascades is cross-lit at 131 (ideal) and
  level_bravo back-lit at 146 (correct for the atmosphere hero).

This one staging fact explains three symptoms at once: invisible cast shadows, black grass, and
flat vertical faces. LIGHT re-staged their shots when SKY moved the sun mid-session; LEVEL and
RCORE-MATERIAL did not.

YOU OWN ONLY THE SHOT REGISTRATIONS in \`src/shots/*.ts\` for level and material — re-aim those
cameras so the sun is 100-150 degrees in azimuth from the sightline, per LOOK_SPEC section 2.3.
Do not change the sun; it is roughly correct. Iterate: capture, Read the PNG, re-aim, repeat.
Beware poses that end up inside geometry — RCORE-MATERIAL lost a capture that way. Also apply
LOOK_SPEC's composition rule that almost every reference frame has a near-field foreground
occluder anchoring depth; our frames are mostly empty-foreground, which reads flat.` },

  { lane: 'CORE', dist: 'dist-core', axis: 'blocker',
    defect: `**level_overview FAR-FIELD SHATTER.** Everything past ~200 m dissolves into block/stripe
corruption and the frame washes to near-white. The integration lead A/B'd it against a build
without their depth-prepass change and confirmed it is PRE-EXISTING, not a regression — histograms
matched to a digit. So it is still unfixed and it invalidates every wide shot.

You own \`src/engine/**\` and \`tools/**\` and have cross-lane read access. Diagnose it properly:
the stripe blocks look like a render target being read while written, or TAA history sampling
uninitialised memory, or a precision collapse in the far depth range. Bisect it — disable TAA,
then post, then aerial perspective, capturing each time, until the frame is clean, then fix the
real cause. Report which pass owns it even if the fix belongs to another lane.` },
]

const HISTORY = []
const MAX_ROUNDS = 3

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Fix')
  log(`round ${round}: dispatching ${findings.length} fix agent(s)`)

  const fixes = await parallel(
    findings.map((f) => () =>
      agent(
        `You are the **${f.lane}** lane agent on IRONSIGHT, working in ${ROOT}.

This is the VISUAL CRITIC LOOP, round ${round}. The build works and all shots capture; what
remains is quality. A harsh critic will blind-A/B your frame against a real Battlefield gameplay
frame immediately after you finish, so fix the defect properly rather than making it less visible.

READ FIRST: ${ROOT}/docs/BRIEF.md, ${ROOT}/docs/LOOK_SPEC.md (the art-direction law, derived by
measuring real frames), ${ROOT}/docs/AAA_RUBRIC.md (how you will be judged),
${ROOT}/docs/OWNERSHIP.md (your files).
${LANE_RULES}
=== YOUR DEFECT (current rubric score on this axis: ${f.axis}) ===

${f.defect}

=== BEFORE YOU FINISH ===
Capture the hero shots your change affects and Read them. Then blind-A/B at least one:
  ./tools/compare.sh --ours tools/shots/<shot>.png --ref reference/gameplay/<ref>.jpg --out tools/compare/r${round}_<lane>.png
Read the sheet. Do NOT open tools/compare/.keys/. Say which panel is better and why.

Report: what you changed, what the frame looks like now vs before, your honest A/B read, and what
is still wrong in your area.`,
        { label: `r${round}:${f.lane}`, phase: 'Fix', effort: 'high' },
      ),
    ),
  )
  log(`round ${round}: ${fixes.filter(Boolean).length}/${findings.length} fixes reported`)

  phase('Shoot')
  const shootReport = await agent(
    `You are the CAPTURE + INTEGRATION lead on IRONSIGHT (${ROOT}), critic loop round ${round}.

${findings.length} lane agents just worked in parallel on visual defects. Your job:

1. \`npm run typecheck\` and \`npm run boundaries\`. Fix any breakage — minimal correct fixes in the
   owning file.
2. \`IRONSIGHT_DIST=dist-round npm run build\`.
3. Capture ALL of these hero shots to the DEFAULT output dir (tools/shots/):
   ${HEROES.map((h) => h.shot).join(' ')}
   Any error, hang or black frame is a bug — fix it and re-capture.
4. Build a blind A/B sheet for every hero shot:
   ./tools/compare.sh --ours tools/shots/<shot>.png --ref reference/gameplay/<ref> --out tools/compare/round${round}_<shot>.png
   using these pairings: ${HEROES.map((h) => `${h.shot}=${h.ref}`).join(', ')}
5. Check whole-frame COHERENCE after all the changes: one sun direction everywhere, shadow/sky/
   water agreeing on time of day, grade applied exactly once, no double aerial perspective.
6. Commit.

Report tersely: what broke, what you fixed, and confirm all ${HEROES.length} shots + ${HEROES.length} A/B sheets exist.`,
    { label: `r${round}:shoot`, phase: 'Shoot', effort: 'high' },
  )

  phase('Critique')
  const CRITIC_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['shot', 'provenanceVerdict', 'firstTell', 'blindPick', 'axes', 'weighted', 'passes', 'findings'],
    properties: {
      shot: { type: 'string' },
      provenanceVerdict: { type: 'string', enum: ['shipped-AAA', 'close-but-clockable', 'hobby-webgl-demo'] },
      firstTell: { type: 'string', description: 'The very first thing that gave it away, before any analysis.' },
      blindPick: { type: 'string', description: 'Which panel of the A/B sheet is the better image, A or B, and why — decided WITHOUT opening the key.' },
      axes: {
        type: 'object', additionalProperties: false,
        required: ['lightTransport', 'materials', 'atmosphere', 'composition', 'worldCraft', 'motionVfx', 'ui'],
        properties: {
          lightTransport: { type: 'number' }, materials: { type: 'number' }, atmosphere: { type: 'number' },
          composition: { type: 'number' }, worldCraft: { type: 'number' }, motionVfx: { type: 'number' }, ui: { type: 'number' },
        },
      },
      weighted: { type: 'number', description: 'Weighted mean per AAA_RUBRIC.md weights (3,3,2,2,2,2,1).' },
      passes: { type: 'boolean', description: 'True ONLY if weighted >= 8.5 AND no axis < 8.0.' },
      findings: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['lane', 'severity', 'defect', 'fix'],
          properties: {
            lane: { type: 'string', description: 'Owning lane: VEG, SKY, WATER, LIGHT, RCORE-MATERIAL, RCORE-POST, HUD, VFX, TERRAIN, LEVEL, WEAPONS, SHOTS-STAGING, CORE' },
            severity: { type: 'number', description: '1 = trivial, 10 = the thing that gives it away' },
            defect: { type: 'string', description: 'Specific, with cited pixels/regions. "Shadows are bad" is worthless.' },
            fix: { type: 'string', description: 'The concrete change to make.' },
          },
        },
      },
    },
  }

  const critiques = await parallel(
    HEROES.map((h) => () =>
      agent(
        `You are a HARSH visual critic reviewing one frame of IRONSIGHT, a browser FPS aiming to pass
as a shipped AAA Battlefield-quality title. Round ${round}.

READ ${ROOT}/docs/AAA_RUBRIC.md FIRST — it defines exactly how to work and how to score.

YOUR FRAME:   ${ROOT}/tools/shots/${h.shot}.png   (${h.what})
YOUR A/B SHEET: ${ROOT}/tools/compare/round${round}_${h.shot}.png

DO THIS IN ORDER:
1. Open the A/B SHEET FIRST, before anything else. It contains two frames labelled A and B, one
   ours and one a real Battlefield gameplay screenshot, sides randomised. Decide which is the
   better IMAGE and why. **You are forbidden from opening ${ROOT}/tools/compare/.keys/** — the
   blind is the only thing that makes your score worth anything.
2. Then open our frame on its own and answer the provenance question cold: shipped AAA title, or
   WebGL demo? What EXACTLY gave it away first? That first impression is the most important
   finding in your review, because it is what a player would notice too.
3. Then score all seven rubric axes 0-10, citing specific pixels/regions for each. "Shadows are
   bad" is worthless; "the shadow under the crate at centre-left has a uniform 3px penumbra
   identical to the 40 m crane's, so there is no contact hardening" is a finding.
4. Compute the weighted mean on the rubric's weights (light 3, materials 3, atmosphere 2,
   composition 2, worldcraft 2, motion 2, ui 1).

BE HARSH. A 7 is competent indie. An 8 is good mobile AAA. Only 9+ for something you would accept
in a marketing screenshot. **Grade inflation is a failure of your job** — this loop only converges
if your scores are honest. If the frame is a 5, say 5.

Every finding must name the owning lane and a concrete fix. Rank by severity: what would a viewer
notice first?`,
        { label: `r${round}:critic:${h.shot}`, phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' },
      ),
    ),
  )

  const scored = critiques.filter(Boolean)
  const mean = scored.length ? scored.reduce((s, c) => s + (c.weighted || 0), 0) / scored.length : 0
  const passing = scored.filter((c) => c.passes).length
  const provenance = scored.map((c) => `${c.shot}:${c.provenanceVerdict}`).join(' ')
  log(`ROUND ${round}: mean ${mean.toFixed(2)}/8.5 · ${passing}/${scored.length} shots pass · ${provenance}`)
  HISTORY.push({ round, mean, passing, of: scored.length, critiques: scored, shootReport })

  if (scored.length && passing === scored.length) {
    log(`CONVERGED at round ${round} — every hero shot clears the bar`)
    break
  }

  // Re-rank: group the critics' findings by lane, worst-first, and feed them back.
  const byLane = new Map()
  for (const c of scored) {
    for (const f of c.findings || []) {
      const key = f.lane || 'UNKNOWN'
      if (!byLane.has(key)) byLane.set(key, [])
      byLane.get(key).push({ ...f, shot: c.shot })
    }
  }
  const DISTS = { VEG: 'dist-veg', SKY: 'dist-sky', WATER: 'dist-water', LIGHT: 'dist-light',
    'RCORE-MATERIAL': 'dist-mat', 'RCORE-POST': 'dist-post', HUD: 'dist-hud', VFX: 'dist-vfx',
    TERRAIN: 'dist-terrain', LEVEL: 'dist-level', WEAPONS: 'dist-weapons',
    'SHOTS-STAGING': 'dist-stage', CORE: 'dist-core' }

  findings = [...byLane.entries()]
    .map(([lane, items]) => {
      items.sort((a, b) => b.severity - a.severity)
      const worst = items[0]?.severity ?? 0
      return {
        lane, dist: DISTS[lane] || 'dist-fix', worst,
        axis: `round ${round} critics, worst severity ${worst}/10`,
        defect: items.slice(0, 6).map((i, n) =>
          `${n + 1}. [severity ${i.severity}/10, seen in ${i.shot}]\n   DEFECT: ${i.defect}\n   FIX: ${i.fix}`).join('\n\n'),
      }
    })
    .sort((a, b) => b.worst - a.worst)
    .slice(0, 9)

  log(`round ${round + 1} queue: ${findings.map((f) => `${f.lane}(${f.worst})`).join(' ')}`)
}

return {
  rounds: HISTORY.map((h) => ({ round: h.round, mean: Number(h.mean.toFixed(2)), passing: `${h.passing}/${h.of}` })),
  final: HISTORY[HISTORY.length - 1] ?? null,
}
