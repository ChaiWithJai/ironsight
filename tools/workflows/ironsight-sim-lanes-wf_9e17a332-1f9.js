export const meta = {
  name: 'ironsight-sim-lanes',
  description: 'Build the 7 simulation/infrastructure lanes in parallel against the frozen contract',
  phases: [
    { title: 'Lanes', detail: 'BAKE, LEVEL, PHYS, WEAPONS, AI, GAME, AUDIO in parallel' },
    { title: 'Integrate', detail: 'resolve conflicts, verify the whole build, capture' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

const COMMON = (lane, dist) => `You are the **${lane}** lane agent on IRONSIGHT, working in ${ROOT}.

READ FIRST, IN THIS ORDER — all of them, in full:
  1. ${ROOT}/docs/BRIEF.md          — the project contract
  2. ${ROOT}/docs/ARCHITECTURE.md   — the design; find YOUR lane's sections
  3. ${ROOT}/docs/OWNERSHIP.md      — exactly which files you own and what you export
  4. ${ROOT}/src/engine/types.ts    — the contract layer. THIS IS YOUR API.
  5. your own lane's current stub files

=== THE RULES ===
* You own ONLY the globs listed for **${lane}** in OWNERSHIP.md. Editing another lane's file is
  the single worst thing you can do here — 6 other agents are working RIGHT NOW in this same
  repo, in parallel, and they will silently lose your changes or you theirs.
* \`src/engine/harness.ts\`, \`src/bootstrap/subsystems.ts\`, \`src/bootstrap/nulls.ts\` and
  \`src/shots/index.ts\` are FROZEN. Never touch them.
* You may append to YOUR OWN named section of \`src/engine/types.ts\` only, narrowly, and you must
  call it out in your report. Check the section banner says your lane before you write.
* Your three exported symbols (\`create*\`, \`register*Bakes\`, \`reset*\`) must keep their exact
  name, path and signature — subsystems.ts imports them by name and is frozen.
* NO \`Math.random()\` — take a stream from \`ctx.rng\`. Determinism is what makes the visual
  critic loop possible; breaking it breaks the whole project.
* NO placeholder code, NO TODOs, NO "implement later". Ship the real thing.
* NO binary assets, NO network requests. Everything procedural, generated in code.

=== YOUR BUILD ISOLATION ===
Other agents are building concurrently. ALWAYS prefix build/capture commands so you do not
clobber them:
    export IRONSIGHT_DIST=${dist}
    IRONSIGHT_DIST=${dist} npm run verify
    IRONSIGHT_DIST=${dist} ./tools/shoot.sh <yourshot>
\`npm run typecheck\` and \`npm run boundaries\` are safe to run bare at any time.

=== DONE MEANS ALL OF ===
  1. \`npm run typecheck\` — zero errors
  2. \`npm run boundaries\` — clean (never weaken the checker to pass; fix the code)
  3. \`IRONSIGHT_DIST=${dist} npm run build\` — succeeds
  4. You registered at least one shot in \`src/shots/<yourlane>.ts\` that isolates your work
  5. \`IRONSIGHT_DIST=${dist} ./tools/shoot.sh <yourshot>\` — exits 0
  6. You have \`Read\` that PNG and it shows what you intended

Iterate until all six hold. If something in the contract genuinely blocks you, say so explicitly
in your report rather than hacking around it or editing someone else's file.

=== REPORT ===
End with: what you built, any types.ts additions you made, what you registered as shots, what is
weak or unfinished, and what the visual critics should look at first.`

phase('Lanes')

const LANES = [
  {
    id: 'BAKE',
    dist: 'dist-bake',
    brief: `You own \`src/bake/**\` — the PROCEDURAL ASSET FACTORY. Every other lane depends on you.
This is the most load-bearing lane in the project: "zero binary art assets, everything generated
in code at load time" is the central constraint of the brief, and you are the machine that makes
it possible.

Build:
- The **bake scheduler**: lanes declare BakeSteps with cost weights; you run them in dependency
  order, report aggregate progress, and enforce \`BakeProfile.unitCeiling\` by DEGRADING
  resolution rather than blowing the budget. Cache results by content hash.
- A **GPU bake device**: render-to-texture bakes driven by fragment shaders (\`GpuBakeDesc\`),
  with the documented shader protocol (vUv, uResolution, uPass, uSeed in scope; write outColor).
  Support multi-pass bakes and mip generation.
- A **worker pool** for CPU bakes so a 4-second mesh bake does not freeze the loading screen.
- **NoiseLib** — the shared GLSL + TS noise library everyone builds textures from. This must be
  genuinely good: simplex/perlin/worley/voronoi, fBm with domain warping, ridged multifractal,
  curl noise, gradient noise with analytic derivatives (for normal generation without finite
  differencing), tileable variants of all of them, and blue-noise/stratified sampling.
  Domain warping is what stops procedural texture looking like procedural texture — invest here.
- **TextureSet production**: given a material description, produce a full PBR set —
  albedo / normal / roughness / metalness / AO / height — that is seamlessly tileable, has
  detail at three scales, and has NO visible repeat. Height-derived AO and curvature-derived
  edge wear are what make it read as real.
- **BakedFont**: an SDF/MSDF font atlas baked from canvas-rendered glyphs, since we ship no font
  files. HUD depends on this.
- Audio buffer baking helpers (noise shaping, impulse responses) for AUDIO.

Your shot should be a texture-inspection grid: several baked material sets displayed as lit
spheres or panels so the critics can judge tiling, detail scale, normal strength and wear.`,
  },
  {
    id: 'LEVEL',
    dist: 'dist-level',
    brief: `You own \`src/level/**\` — HARBOUR REACH itself, the actual playable map. PHYS, AI and GAME
all consume what you produce, so your data contract matters as much as your art.

Build the real level: a Mediterranean/Levantine coastal town. A stone breakwater running into the
water, a half-sunk freighter, a market square (ALPHA), harbour cranes and warehouses (BRAVO), an
old fort on the headland (CHARLIE), a minaret, a fuel depot, alleys, courtyards, stairs, rooftops.

This must be built as **procedural architecture**, not hand-placed boxes:
- A building grammar: footprint → floors → facade → openings → roof → parapet → details.
  Sandstone/stucco/plaster with balconies, awnings, shutters, exposed rebar, satellite dishes,
  air-con units, laundry lines, drainpipes, patched repairs.
- Variation is everything. No two buildings identical; per-instance colour, height, wear, damage.
  Buildings should sag and lean slightly — nothing perfectly plumb.
- Interiors that matter: at minimum the ALPHA market and the CHARLIE fort must be enterable,
  with openings that read as cover and sightlines that make the three points contest each other.
- **Ground transition detail**: where a wall meets the ground there must be debris, sand
  drift, rubble and dirt. A hard seam between a building and terrain is the single most common
  amateur tell — the brief calls it out explicitly.
- Emit \`StaticColliderDef\`s for PHYS, \`NavmeshData\` for AI, \`CapturePointDef\`s and
  \`SpawnPointDef\`s and \`CoverSlot\`s for GAME, and \`CameraRigPose\`s that the shot system uses.
- Gameplay first: the three points must form a triangle with real flanking routes, verticality,
  and cover that reads as cover.

Use the MaterialFactory for all materials (boundary CI enforces this). Placeholder greybox
materials are fine for now if RCORE's factory is still a stub — the visual lanes land next and
will dress it — but the GEOMETRY, LAYOUT and DETAIL DENSITY must be final quality.

Register several shots: \`level_alpha\`, \`level_bravo\`, \`level_charlie\`, \`level_overview\`.`,
  },
  {
    id: 'PHYS',
    dist: 'dist-phys',
    brief: `You own \`src/physics/**\` — the Rapier world, the character controller, and DESTRUCTION.

Build:
- A clean Rapier wrapper: fixed-step, deterministic, with the collision groups from types.ts
  (\`LAYER_SOLID\`, \`LAYER_SHOOTABLE\`), body/collider lifecycle tied to handles, and sleeping.
  Rapier is \`@dimforge/rapier3d-compat\` and needs an async init — make sure that is a declared
  bake step so boot waits for it properly.
- A **kinematic character controller** with capsule sweep, step-up, slope limits, ground snapping,
  crouch/prone capsule resize, and a moving-platform-safe resolve. This is what makes movement
  feel right — GAME drives it, but the quality of the feel lives here. No jitter on stairs, no
  sticking on corners, no launching off small bumps.
- **Raycasts and shape-casts** for BALLISTICS with a proper \`QueryFilter\`, plus material lookup
  on hit so impacts know what they struck.
- **DESTRUCTION**: destructible walls/props that fracture into real chunks. Pre-fracture geometry
  at bake time (Voronoi shatter around a seed set), then swap intact→fractured on damage
  threshold, spawning dynamic chunk bodies with a lifetime and a budget cap. Chunks must inherit
  the parent's material so debris looks like the thing it came from. Emit events so VFX can put
  dust and AUDIO can put a collapse sound on it.
- A debris/chunk budget that degrades by quality tier.

Register shots: \`physics_ragdoll_pile\` (a settled stack proving stable contacts) and
\`destruction_wall\` (a wall mid-collapse, frozen deterministically).`,
  },
  {
    id: 'WEAPONS',
    dist: 'dist-weapons',
    brief: `You own \`src/weapons/**\` — weapon simulation, ballistics, and the viewmodel rig.

**Weapon feel is the single most important tactile quality in an FPS.** The brief lists
"a viewmodel that floats, does not react to movement, and has no recoil follow-through" as an
automatic tell. Get this right and the game feels AAA even before it looks it.

Build:
- **Data-driven weapon defs** (\`WeaponDef\`): three weapons minimum — an assault rifle, a
  DMR/sniper, and an LMG or SMG. Fire modes, RPM, magazine, reload timings (with a distinct
  tactical vs empty reload), spread state machine, and a real \`RecoilPattern\` — a per-shot
  vertical/horizontal impulse sequence with a recovery curve, not a random kick. Recoil must be
  learnable, which means deterministic per shot index.
- **Ballistics**: projectiles with muzzle velocity, gravity drop, drag, and travel time — not
  hitscan. Penetration through thin materials with damage falloff. Tracers on a fraction of
  rounds. Emit \`ImpactEvent\`s carrying surface material so VFX/AUDIO can respond correctly.
- **The viewmodel rig** (\`src/weapons/viewmodel/rig.ts\`): a procedurally-modelled weapon (built
  in code — no imported meshes) with hands, rendered with a separate near-plane FOV so it never
  clips world geometry. Then the feel layer, which is where AAA lives:
    - sway that LAGS look input with spring damping, not a lerp
    - bob coupled to actual velocity, that settles smoothly on stop
    - ADS transition moving position, rotation AND FOV on an eased curve, ~180-220ms
    - recoil kick with visual follow-through and recovery that undershoots slightly
    - landing impact, sprint-to-fire lowering, reload animation, inspect idle
    - breathing micro-motion at rest so the weapon is never perfectly still
  All of this composed from \`WeaponDef\` DATA, in ONE place, per the contract's
  \`WeaponFeelState.update\` — not magic numbers scattered across files.

Register shots: \`weapon_hipfire\`, \`weapon_ads\`, \`weapon_recoil_midburst\`, \`weapon_reload\`.
Compose them like a real first-person frame: reference gameplay has the viewmodel occupying the
lower-right third of the screen. Look at \`reference/gameplay/bf6_gp_004.jpg\` for framing.`,
  },
  {
    id: 'AI',
    dist: 'dist-ai',
    brief: `You own \`src/ai/**\` — navigation and the bots that make the map feel like a battlefield.

Build:
- **NavService**: consume \`NavmeshData\` from LEVEL, build a searchable navmesh (or bake your own
  from level colliders if LEVEL's is not ready — declare it as a bake step, run it in a worker),
  with A* + funnel string-pulling for smooth paths, off-mesh links for vaults and drops, and
  dynamic obstacle avoidance. Path requests must be time-sliced across frames — never block.
- **Bots**: a squad-based behaviour system, not a state machine per bot in isolation.
    - Perception: FOV cone, line-of-sight raycasts, hearing (gunshots, footsteps), a memory of
      last-known-position that decays, and a reaction delay so they are not instant-aim robots.
    - Combat: take cover using LEVEL's \`CoverSlot\`s, suppress, peek/shoot/retreat rhythm,
      reload behind cover, grenade when a target is static, flank when a squadmate engages.
    - Aim: human-like — a settle time, overshoot then correct, spread that reflects the weapon,
      and deliberate inaccuracy that scales with difficulty. A bot that headshots instantly is
      worse than no bot.
    - Objective play: bots must actually contest ALPHA/BRAVO/CHARLIE — attack the weakest point,
      defend a held one, and respond to the mode's tickets. Read the state from \`GameMode\`.
- Emit \`PlayerIntent\` through the locomotion seam so bots drive the SAME controller as the
  player (see ARCHITECTURE §3.4 — GAME owns the dispatch, you own \`intentSource.sample\`).
- Budget: ~24 bots at tier High, scaling down by quality tier. Time-slice everything.

Register a shot \`ai_firefight\`: bots engaged across a capture point, posed deterministically.`,
  },
  {
    id: 'GAME',
    dist: 'dist-game',
    brief: `You own \`src/game/**\` — the player controller, and Conquest.

You also own **per-entity intent dispatch** — the only two \`TickSystem\`s at \`TickPhase.Intent\`
and \`TickPhase.Movement\` in the entire repo (ARCHITECTURE §3.4). Both the local player and every
AI bot flow through your movement code; do not special-case the player.

Build:
- **The player controller.** Battlefield-grade movement: walk/sprint/tactical sprint, crouch,
  prone, jump with real arcs, vault and mantle over waist and chest height, slide from sprint
  with momentum decay, lean. Acceleration and friction curves that feel weighty but responsive —
  no ice-skating, no instant stop. Stance transitions take real time and change capsule height,
  eye height, speed and weapon handling. Drive PHYS's \`CharacterController\`; do not run your own
  collision.
- **Camera feel**: eye-height interpolation on stance change, landing dip proportional to fall
  speed, subtle roll on strafe, step-based head motion, trauma-driven shake on nearby explosions
  via the CameraRig. Restraint matters — camera motion should be felt, not noticed.
- **Conquest**: three capture points, capture progress scaled by how many players are inside,
  contested when both teams present, ticket bleed proportional to points held, ticket loss on
  death, match phases (warmup → active → end), and a real spawn system — spawn on squadmate,
  spawn on held point, with safety validation against enemy proximity.
- **Damage model**: hit zones (head/torso/limb multipliers), falloff by distance and by
  penetration, a downed/bleedout state, regeneration after a delay out of combat, and score
  events that HUD consumes.

Register shots: \`game_sprint\`, \`game_slide\`, \`game_vault\`, \`game_capture_contested\`.`,
  },
  {
    id: 'AUDIO',
    dist: 'dist-audio',
    brief: `You own \`src/audio/**\`. Everything is synthesised in code — we ship no audio files.

The brief's bar is "sound that has weight, distance falloff, and environmental tails". A gunshot
that is a click is as damaging to the illusion as a flat-shaded wall.

Build:
- A **WebAudio graph** with a proper bus structure (dry / early reflections / tail / sub),
  compression on the master, and a duck bus so important sounds cut through.
- **Procedurally synthesised weapon sounds**, baked to AudioBuffers at load time: a gunshot is a
  layered event — a transient click, a body composed of filtered noise bursts, a low-end thump,
  and a mechanical action. Different weapons must be recognisably different. Bake variations so
  repeated shots do not phase-cancel into a machine-gun buzz.
- **Distance modelling that is not just gain**: air absorption (low-pass with distance), a
  distinct crack-then-thump for supersonic rounds passing near the listener, and a reflected tail
  whose character depends on the environment.
- **Reverb via convolution with procedurally-generated impulse responses** — one per
  \`AcousticEnvironment\` (open harbour, alley, interior, fort). Crossfade as the listener moves.
- **Occlusion**: raycast to the listener via PHYS; occluded sources get low-passed and attenuated,
  not muted.
- Footsteps keyed to surface material and stance, weapon handling foley, bullet impacts by
  material, explosion with a body and a long tail, and ambience (sea, wind, gulls, distant war)
  that responds to position.
- A voice-stealing pool with priority so a firefight cannot exhaust the graph.

Audio cannot be screenshotted, so your shot \`audio_debug\` should render a visual debug overlay:
active voices, bus levels, the current acoustic environment, and occlusion rays.`,
  },
]

const laneResults = await parallel(
  LANES.map((l) => () =>
    agent(`${COMMON(l.id, l.dist)}\n\n=== YOUR LANE ===\n${l.brief}`, {
      label: `lane:${l.id}`,
      phase: 'Lanes',
      effort: 'high',
    }),
  ),
)

const ok = laneResults.filter(Boolean)
log(`${ok.length}/${LANES.length} lanes reported`)

phase('Integrate')

const integration = await agent(
  `You are the INTEGRATION LEAD on IRONSIGHT (${ROOT}). Seven lane agents just worked in parallel
on disjoint file sets. Your job is to make the whole thing build, run and render as one program.

Read ${ROOT}/docs/BRIEF.md, ${ROOT}/docs/ARCHITECTURE.md and ${ROOT}/docs/OWNERSHIP.md.

Lane reports:
${LANES.map((l, i) => `\n########## ${l.id} ##########\n${ok[i] ?? '(no report — this lane may have failed)'}`).join('\n')}

TASK:
1. \`npm run typecheck\` and \`npm run boundaries\`. Fix everything. You have cross-lane authority
   now that the parallel phase is over — but make the MINIMAL correct fix, and keep each fix in
   the lane that owns the file.
2. \`IRONSIGHT_DIST=dist-integrate npm run build\`.
3. \`IRONSIGHT_DIST=dist-integrate ./tools/shoot.sh --list\`, then capture EVERY registered shot.
   Any shot that errors or produces a black frame is a bug — find it and fix it.
4. \`Read\` every captured PNG. For each one say what is actually visible. Then fix anything that
   is obviously broken: missing geometry, z-fighting, objects floating or sunk, inverted normals,
   NaN transforms, shots that point at empty space.
5. Check for contract drift: did two lanes both register the same PassOrder slot? Does anything
   still resolve to a null service at boot (\`registry.nullKeys()\` is logged at boot)? Are all
   23 \`reset\` hooks actually reached?
6. Delete stale \`dist-*\` directories.

Report: what was broken, what you fixed, the list of working shots, and — importantly — an honest
assessment of what these frames look like right now, since the visual lanes have NOT run yet and
the critics come next.`,
  { label: 'integrate-sim-lanes', phase: 'Integrate', effort: 'high' },
)

return { lanes: ok.length, integration }
