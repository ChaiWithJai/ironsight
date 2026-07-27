export const meta = {
  name: 'ironsight-critic-loop-gpu',
  description: 'Critic loop on GPU capture: tight fix/shoot/score iteration until AAA',
  phases: [
    { title: 'Fix', detail: 'lane agents iterate against the critics, capturing every ~2s' },
    { title: 'Shoot', detail: 'rebuild, capture hero shots, build blind A/B sheets' },
    { title: 'Critique', detail: 'harsh blind critics score against the rubric' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

const HEROES = [
  { shot: 'level_bravo',    ref: 'bf6_gp_020.jpg' },
  { shot: 'light_cascades', ref: 'bf6_gp_012.jpg' },
  { shot: 'material_chart', ref: 'bf2042_gp_022.jpg' },
  { shot: 'weapon_ads',     ref: 'bf6_gp_004.jpg' },
  { shot: 'water_golden',   ref: 'bf6_gp_000.jpg' },
  { shot: 'sky_golden',     ref: 'bfv_gp_006.jpg' },
  { shot: 'hud_full',       ref: 'bf6_gp_004.jpg' },
  { shot: 'level_alpha',    ref: 'bf6_gp_005.jpg' },
]

// Round 1 seeds from the previous loop's final critics, which scored 3.80/8.5.
// Severity 9-10 items only: the loop stalled at +0.27/round by spreading effort.
let findings = [
  { lane: 'LIGHT', dist: 'dist-light', axis: 'lightTransport 2.5/10 — LOWEST AXIS IN THE PROJECT',
    defect: `**THERE IS NOT ONE CAST SHADOW IN level_bravo.** A critic measured it: the deck strip
abutting the warehouse wall reads mean luminance 0.436, while open deck 6 m out reads 0.420. The
ground is BRIGHTER where it meets the wall than in the open — the shadow term is not soft, it is
absent and slightly INVERTED. The warehouse, both 40 m cranes, the bollards, the sandbag pile, the
containers and ~30 debris props all cast nothing.

The critic's read, which you should test first: this looks like a shadow camera whose ortho
frustum is smaller than the level, or whose far plane clips before the ground — NOT a tuning
problem. Note light_cascades DOES have shadows, so this is shot//distance-specific: find why the
cascade covers one and not the other.

**NO AMBIENT OCCLUSION ANYWHERE.** Bollards meet the deck with zero darkening. ~30 debris pebbles
sit as flat ellipses with no contact darkening, so they read as decals painted on the ground
rather than objects resting on it. Warehouse doorway interior corners show no corner darkening.
SSAO alone will not catch pebble/deck contact at this pixel scale — add per-instance contact
darkening for small props.` },

  { lane: 'RCORE-POST', dist: 'dist-post', axis: 'composition 3.5, and the histogram is still wrong',
    defect: `**1. DEPTH OF FIELD IS FOCUSED ON THE WRONG SUBJECT.** In level_bravo the focal plane
sits on a 40 m warehouse, so the entire lower 45% of the frame — the dock the player stands on —
is smeared past legibility. Sandbags fuse into an amorphous lump; bollards are unrecognisable
discs. A critic called it "an out-of-focus photograph", and it was their FIRST tell.
FIX: focus at ~6-10 m, cut aperture/CoC scale ~3x, clamp max near-field CoC to 12-16 px (currently
looks 40 px+). Reference frames put heavy bokeh on a NEAR occluder and keep the playable surface
readable; ours has the two bands swapped.

**2. THE HISTOGRAM IS STILL COMPRESSED.** Measured on level_bravo: min luminance 0.050, max 0.955,
mean 0.537, median 0.547. 0.00% of pixels below 0.05, 0.01% above 0.95, ZERO above 0.99. 54.1% sit
in the middle 40%. Nothing blown, nothing black.

**3. YOU HAVE OVERCORRECTED SATURATION ON SOME SHOTS.** light_cascades now pushes buildings to a
strong red-salmon and shadow tint to a heavily saturated blue. Saturation was ~2x under spec; do
not answer that by going 1.5x over. Hit LOOK_SPEC section 5's curve, and verify per-shot rather
than globally — the two shots currently sit on opposite sides of correct.` },

  { lane: 'RCORE-MATERIAL', dist: 'dist-mat', axis: 'materials 2.5/10',
    defect: `**THE LARGEST FOREGROUND OBJECT IN level_bravo IS COMPLETELY UNTEXTURED.** The
container/hull slab occupying the right third (x 1435-1920, y 610-1080, ~1.5 m from camera) is a
flat orange gradient. Measured mean RGB (0.464, 0.279, 0.181), saturation 0.610 — the most
saturated large mass in the picture — with zero mesoscale (no panel lines, welds, rivets,
corrugation, placards) and zero micro (no rust pitting, no roughness break-up). It owns ~18% of
the pixels and it is the CLOSEST thing to the camera. The rubric's rule is explicit: surfaces that
go smooth as they approach the camera fail.

FIX: corrugated-steel normal with real depth; albedo with three rust generations (flat oxide, dark
vertical bleeding streaks from the top edge, near-black scale in the low points); roughness glossy
on un-oxidised paint and matte on rust; chipped top edge with a thin bright specular line. Drop
albedo saturation to ~0.35 — it is currently louder than any real weathered container.

Then sweep for OTHER untextured hero-adjacent geometry the same way; if the material factory is
not reaching an object, find out why rather than special-casing it.` },
]

const HISTORY = []
const MAX_ROUNDS = 8

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Fix')
  log(`round ${round}: ${findings.length} fix agent(s) — ${findings.map((f) => f.lane).join(', ')}`)

  const fixes = await parallel(
    findings.map((f) => () =>
      agent(
        `You are the **${f.lane}** lane agent on IRONSIGHT, ${ROOT}. Visual critic loop, round ${round}.

*** CAPTURE IS NOW ~1.5 SECONDS PER SHOT, NOT 12 MINUTES. ***
The harness was forcing a software rasteriser; it now runs on the GPU. This changes how you should
work. Previously you could afford one capture. Now you should capture, LOOK at the PNG, adjust, and
capture again — DOZENS of times — until the frame is actually right. Do not reason about what your
change probably did. Look at it. Iterate until the defect is visibly gone.

READ FIRST: ${ROOT}/docs/BRIEF.md, ${ROOT}/docs/LOOK_SPEC.md (art-direction law, measured from
real frames), ${ROOT}/docs/AAA_RUBRIC.md (how you are judged), ${ROOT}/docs/OWNERSHIP.md.

RULES: you own ONLY your lane's globs; other agents are live in this repo. harness.ts /
subsystems.ts / nulls.ts / shots/index.ts are FROZEN. No Math.random(). typecheck + boundaries
clean when you finish. Build isolated: IRONSIGHT_DIST=${f.dist}.

=== YOUR DEFECT (current critic score: ${f.axis}) ===

${f.defect}

=== HOW TO FINISH ===
1. Fix it. Capture. Read the PNG. Is the defect gone? If not, iterate — you have the budget now.
2. Blind A/B at least one affected hero shot:
   ./tools/compare.sh --ours tools/shots/<shot>.png --ref reference/gameplay/<ref>.jpg --out tools/compare/g${round}_${f.lane}.png
   Read the sheet. Do NOT open tools/compare/.keys/. Say which panel is better and why.
3. Report: what changed, before/after description, honest A/B read, what is still wrong.`,
        { label: `g${round}:${f.lane}`, phase: 'Fix', effort: 'high' },
      ),
    ),
  )
  log(`round ${round}: ${fixes.filter(Boolean).length}/${findings.length} fixed`)

  phase('Shoot')
  await agent(
    `CAPTURE + INTEGRATION lead, IRONSIGHT (${ROOT}), critic loop round ${round}.
Capture now runs on the GPU at ~1.5 s/shot, so this phase is fast — use that to verify properly.

1. \`npm run typecheck\`, \`npm run boundaries\`, \`IRONSIGHT_DIST=dist-round npm run build\`. Fix
   breakage minimally, in the owning file.
2. Capture ALL hero shots to the default dir: ${HEROES.map((h) => h.shot).join(' ')}
   Read each PNG. Any black/broken/regressed frame is a bug — fix and re-capture.
3. Build a blind A/B sheet per hero shot:
   ./tools/compare.sh --ours tools/shots/<shot>.png --ref reference/gameplay/<ref> --out tools/compare/gpu${round}_<shot>.png
   Pairings: ${HEROES.map((h) => `${h.shot}=${h.ref}`).join(', ')}
4. Verify coherence: one sun direction everywhere, shadow/sky/water agreeing on time of day, grade
   applied once, no double aerial perspective, no lane regressed another.
5. Commit.
Report tersely; confirm all ${HEROES.length} shots + ${HEROES.length} sheets exist.`,
    { label: `g${round}:shoot`, phase: 'Shoot', effort: 'high' },
  )

  phase('Critique')
  const CRITIC_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['shot', 'provenanceVerdict', 'firstTell', 'blindPick', 'axes', 'weighted', 'passes', 'findings'],
    properties: {
      shot: { type: 'string' },
      provenanceVerdict: { type: 'string', enum: ['shipped-AAA', 'close-but-clockable', 'hobby-webgl-demo'] },
      firstTell: { type: 'string' },
      blindPick: { type: 'string', description: 'Which panel is the better image, A or B, and why — decided WITHOUT the key.' },
      axes: {
        type: 'object', additionalProperties: false,
        required: ['lightTransport', 'materials', 'atmosphere', 'composition', 'worldCraft', 'motionVfx', 'ui'],
        properties: {
          lightTransport: { type: 'number' }, materials: { type: 'number' }, atmosphere: { type: 'number' },
          composition: { type: 'number' }, worldCraft: { type: 'number' }, motionVfx: { type: 'number' }, ui: { type: 'number' },
        },
      },
      weighted: { type: 'number' },
      passes: { type: 'boolean', description: 'True ONLY if weighted >= 8.5 AND no axis < 8.0.' },
      findings: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['lane', 'severity', 'defect', 'fix'],
          properties: {
            lane: { type: 'string', description: 'VEG SKY WATER LIGHT RCORE-MATERIAL RCORE-POST HUD VFX TERRAIN LEVEL WEAPONS SHOTS-STAGING CORE' },
            severity: { type: 'number' },
            defect: { type: 'string', description: 'Specific, with cited pixels/regions and measurements.' },
            fix: { type: 'string' },
          },
        },
      },
    },
  }

  const critiques = await parallel(
    HEROES.map((h) => () =>
      agent(
        `You are a HARSH visual critic reviewing ONE frame of IRONSIGHT, a browser FPS aiming to pass
as a shipped AAA Battlefield-quality title. Round ${round}.

READ ${ROOT}/docs/AAA_RUBRIC.md FIRST — it defines how to work and how to score.

FRAME:     ${ROOT}/tools/shots/${h.shot}.png
A/B SHEET: ${ROOT}/tools/compare/gpu${round}_${h.shot}.png

IN ORDER:
1. Open the A/B SHEET FIRST. Two frames, A and B, one ours and one a real Battlefield gameplay
   screenshot, sides randomised. Which is the better IMAGE, and why? **You are forbidden from
   opening ${ROOT}/tools/compare/.keys/** — the blind is what makes your score mean anything.
2. Then our frame alone, cold: shipped AAA, or WebGL demo? What EXACTLY gave it away first?
3. Score all seven rubric axes 0-10 with cited pixels/regions and measurements where you can take
   them. "Shadows are bad" is worthless.
4. Weighted mean on rubric weights (light 3, materials 3, atmosphere 2, composition 2, worldcraft
   2, motion 2, ui 1).

BE HARSH — 7 is competent indie, 8 is good mobile AAA, 9+ only for a marketing screenshot. Grade
inflation is a failure of your job. But be FAIR: if a defect from an earlier round is genuinely
fixed, say so and score it accordingly. The loop needs your scores to move when the work improves.

Every finding names the owning lane, a severity 1-10, and a concrete fix.`,
        { label: `g${round}:critic:${h.shot}`, phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' },
      ),
    ),
  )

  const scored = critiques.filter(Boolean)
  const mean = scored.length ? scored.reduce((s, c) => s + (c.weighted || 0), 0) / scored.length : 0
  const passing = scored.filter((c) => c.passes).length
  log(`ROUND ${round}: mean ${mean.toFixed(2)}/8.5 · ${passing}/${scored.length} pass · ${scored.map((c) => c.provenanceVerdict[0]).join('')}`)
  HISTORY.push({ round, mean: Number(mean.toFixed(2)), passing, of: scored.length })

  if (scored.length && passing === scored.length) {
    log(`CONVERGED at round ${round}`)
    break
  }

  // Concentrate: take the worst lanes only. Spreading across 8 lanes stalled the
  // previous loop at +0.27/round.
  const byLane = new Map()
  for (const c of scored) {
    for (const f of c.findings || []) {
      const k = f.lane || 'UNKNOWN'
      if (!byLane.has(k)) byLane.set(k, [])
      byLane.get(k).push({ ...f, shot: c.shot })
    }
  }
  const DISTS = { VEG: 'dist-veg', SKY: 'dist-sky', WATER: 'dist-water', LIGHT: 'dist-light',
    'RCORE-MATERIAL': 'dist-mat', 'RCORE-POST': 'dist-post', HUD: 'dist-hud', VFX: 'dist-vfx',
    TERRAIN: 'dist-terrain', LEVEL: 'dist-level', WEAPONS: 'dist-weapons',
    'SHOTS-STAGING': 'dist-stage', CORE: 'dist-core' }

  findings = [...byLane.entries()]
    .map(([lane, items]) => {
      items.sort((a, b) => b.severity - a.severity)
      const impact = items.reduce((s, i) => s + i.severity, 0)
      return {
        lane, dist: DISTS[lane] || 'dist-fix', impact,
        axis: `round ${round}, worst severity ${items[0]?.severity ?? 0}/10 across ${items.length} finding(s)`,
        defect: items.slice(0, 5).map((i, n) =>
          `${n + 1}. [severity ${i.severity}/10 — ${i.shot}]\n   DEFECT: ${i.defect}\n   FIX: ${i.fix}`).join('\n\n'),
      }
    })
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 5)

  log(`round ${round + 1}: ${findings.map((f) => `${f.lane}(${f.impact})`).join(' ')}`)
}

return { trajectory: HISTORY, final: HISTORY[HISTORY.length - 1] ?? null }
