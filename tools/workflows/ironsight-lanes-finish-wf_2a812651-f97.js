export const meta = {
  name: 'ironsight-lanes-finish',
  description: 'Finish the 7 interrupted simulation lanes, then integrate',
  phases: [
    { title: 'Finish', detail: 'each lane completes its partial work and registers shots' },
    { title: 'Integrate', detail: 'whole-build verify, capture every shot, fix what is broken' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

const COMMON = (lane, dist) => `You are the **${lane}** lane agent on IRONSIGHT, working in ${ROOT}.

*** IMPORTANT CONTEXT: YOUR LANE IS PARTIALLY BUILT ALREADY. ***
A previous session was cut off mid-flight. Your lane already contains substantial, good work —
thousands of lines. Someone else then made the repo compile again by filling the smallest possible
gaps. YOUR JOB IS TO FINISH WHAT IS THERE, NOT TO START OVER.

  1. FIRST, read every file you own and understand what exists. \`git log --oneline\` and
     \`git show --stat HEAD\` show what was recovered.
  2. Look specifically for: stubbed functions, files that are still the day-0 null
     implementation, features described in a file's header comment but not implemented, and
     anything the recovery commit filled in minimally (see \`git show HEAD\`) that deserves a real
     implementation now.
  3. Do NOT rewrite working code for style. Extend and complete it.

READ FIRST, IN THIS ORDER:
  1. ${ROOT}/docs/BRIEF.md
  2. ${ROOT}/docs/ARCHITECTURE.md   — find YOUR lane's sections
  3. ${ROOT}/docs/OWNERSHIP.md      — exactly which files you own
  4. ${ROOT}/src/engine/types.ts    — the contract layer. THIS IS YOUR API.

=== THE RULES ===
* You own ONLY the globs listed for **${lane}** in OWNERSHIP.md. Six other agents are working in
  this same repo RIGHT NOW in parallel. Editing another lane's file loses someone's work.
* \`src/engine/harness.ts\`, \`src/bootstrap/subsystems.ts\`, \`src/bootstrap/nulls.ts\` and
  \`src/shots/index.ts\` are FROZEN.
* You may append to YOUR OWN named section of \`src/engine/types.ts\` only, narrowly, and must
  call it out in your report.
* Your three exports (\`create*\`, \`register*Bakes\`, \`reset*\`) must keep their exact name, path
  and signature.
* NO \`Math.random()\` — use \`ctx.rng\`. Determinism is what makes the critic loop possible.
* NO placeholders, NO TODOs. Ship the real thing.

=== BUILD ISOLATION (other agents are building concurrently) ===
    IRONSIGHT_DIST=${dist} npm run build
    IRONSIGHT_DIST=${dist} ./tools/shoot.sh <yourshot>
\`npm run typecheck\` and \`npm run boundaries\` are safe to run bare.

=== DONE MEANS ALL OF ===
  1. \`npm run typecheck\` — zero errors
  2. \`npm run boundaries\` — clean (never weaken the checker; fix the code)
  3. \`IRONSIGHT_DIST=${dist} npm run build\` — succeeds
  4. You registered your shots in \`src/shots/<yourlane>.ts\` (currently only \`core\` exists —
     this is the biggest gap across the whole project and the critics are blocked on it)
  5. \`IRONSIGHT_DIST=${dist} ./tools/shoot.sh <yourshot>\` — exits 0
  6. You \`Read\` the PNG and it shows what you intended

=== REPORT ===
What you found already built, what you finished, types.ts additions, shots registered, what is
still weak.`

phase('Finish')

const LANES = [
  { id: 'BAKE', dist: 'dist-bake', note: `Your NoiseLib + GLSL chunks + gpu-device are largely written. Verify the CPU/GPU twins really are bit-matched (TerrainService.heightAt must agree with the GPU heightmap or physics and visuals desync). Finish TextureSet production so a material bake yields albedo/normal/roughness/AO/height that is seamlessly tileable with NO visible repeat and detail at three scales — domain warping is what stops procedural texture looking procedural. Finish BakedFont (HUD is blocked on it). Register a shot \`bake\` showing several baked material sets on lit panels/spheres so tiling, detail scale and normal strength can be judged.` },
  { id: 'LEVEL', dist: 'dist-level', note: `You have district/layout/dressing/materials/harbour-reach. Finish the building grammar so no two buildings are identical, add the ground-transition detail (debris, sand drift, rubble where every wall meets terrain — the brief calls a hard wall/ground seam the most common amateur tell), make ALPHA market and CHARLIE fort genuinely enterable, and emit complete StaticColliderDefs, NavmeshData, CapturePointDefs, SpawnPointDefs and CoverSlots. Register \`level_alpha\`, \`level_bravo\`, \`level_charlie\`, \`level_overview\`.` },
  { id: 'PHYS', dist: 'dist-phys', note: `Your lane is the LEAST complete (582 lines vs 4000+ elsewhere) — treat it as mostly greenfield. Rapier wrapper with async init as a declared bake step, kinematic character controller (capsule sweep, step-up, slope limits, ground snap, crouch/prone resize — no jitter on stairs, no corner sticking), raycasts/shape-casts with QueryFilter and surface material on hit, and DESTRUCTION with Voronoi pre-fracture at bake time, chunk budget by tier, and events for VFX dust and AUDIO collapse. Register \`physics_stack\` and \`destruction_wall\`.` },
  { id: 'WEAPONS', dist: 'dist-weapons', note: `You have models/, ballistics, viewmodel. Finish the FEEL layer — it is the single most important tactile quality in an FPS: sway that LAGS look input with spring damping, bob coupled to real velocity that settles on stop, ADS moving position+rotation+FOV on an eased ~200ms curve, recoil with visual follow-through and slight undershoot on recovery, landing dip, sprint lower, reload, breathing micro-motion at rest. All composed from WeaponDef DATA in one place. Ballistics must be projectile (drop, drag, travel time), not hitscan. Register \`weapon_hipfire\`, \`weapon_ads\`, \`weapon_recoil_midburst\`, \`weapon_reload\` — framed like reference/gameplay/bf6_gp_004.jpg, viewmodel in the lower-right third.` },
  { id: 'AI', dist: 'dist-ai', note: `You have 4270 lines across nav + behaviour. Verify the navmesh actually builds from LEVEL data (or bake your own from colliders in a worker), that path requests are time-sliced, and that bots emit PlayerIntent through the locomotion seam so they drive the SAME controller as the player. Finish combat behaviour: cover use via CoverSlots, suppression, peek/shoot/retreat rhythm, flanking, and HUMAN-LIKE aim — settle time, overshoot then correct, reaction delay. A bot that headshots instantly is worse than no bot. Bots must contest ALPHA/BRAVO/CHARLIE by reading GameMode. Register \`ai_firefight\`.` },
  { id: 'GAME', dist: 'dist-game', note: `CRITICAL GAP: \`src/game/player.ts\` is STILL THE DAY-0 NULL STUB — it calls createNullPlayer. Your locomotion.ts, damage.ts, spawn.ts, probe.ts, registry.ts, conquest.ts, tuning.ts are all written and waiting for it. Your #1 job is to implement the real PlayerService on top of them: per-entity intent dispatch (you own the ONLY TickPhase.Intent and TickPhase.Movement systems in the repo), walk/sprint/crouch/prone/jump/vault/mantle/slide/lean driving PHYS's CharacterController, camera feel (eye-height interp, landing dip, strafe roll, trauma shake). A previous pass added a \`laneActors()\` accessor and an ActorTable — wire them properly. Then finish Conquest and the damage model. Register \`game_sprint\`, \`game_slide\`, \`game_vault\`, \`game_capture_contested\`.` },
  { id: 'AUDIO', dist: 'dist-audio', note: `You have ~5000 lines: graph, dsp, cues, spatial, occlusion, voices, snapshot. A previous pass wrote \`debug/overlay.ts\` (a bitmap-font fullscreen readout) and \`debug/scenario.ts\` (a deterministic 12s scripted firefight) to unblock the build — review both, they are functional but you own them now. Finish: procedurally synthesised weapon sounds baked to AudioBuffers (layered transient + filtered-noise body + low thump + mechanical action, with variations so repeats do not phase-cancel), air absorption with distance, supersonic crack-then-thump, convolution reverb from procedurally generated IRs per AcousticEnvironment with crossfade, occlusion via PHYS raycast (low-pass, not mute), footsteps by surface and stance, and ambience. Register \`audio_debug\` and confirm the overlay renders real numbers.` },
]

const laneResults = await parallel(
  LANES.map((l) => () =>
    agent(`${COMMON(l.id, l.dist)}\n\n=== YOUR LANE: SPECIFIC GUIDANCE ===\n${l.note}`, {
      label: `finish:${l.id}`,
      phase: 'Finish',
      effort: 'high',
    }),
  ),
)

const ok = laneResults.filter(Boolean)
log(`${ok.length}/${LANES.length} lanes finished`)

phase('Integrate')

const integration = await agent(
  `You are the INTEGRATION LEAD on IRONSIGHT (${ROOT}). Seven lane agents just worked in parallel
on disjoint file sets. Make the whole thing build, run and render as one program.

Read ${ROOT}/docs/BRIEF.md and ${ROOT}/docs/OWNERSHIP.md.

Lane reports:
${LANES.map((l, i) => `\n########## ${l.id} ##########\n${ok[i] ?? '(NO REPORT — this lane may have failed; check its files yourself)'}`).join('\n')}

TASK:
1. \`npm run typecheck\` then \`npm run boundaries\`. Fix everything. You have cross-lane authority
   now, but make the MINIMAL correct fix and keep each fix in the file that owns it.
2. \`IRONSIGHT_DIST=dist-integrate npm run build\`.
3. \`IRONSIGHT_DIST=dist-integrate ./tools/shoot.sh --list\`, then capture EVERY shot. Any shot
   that errors, hangs, or produces a black/empty frame is a bug — find it and fix it.
4. \`Read\` every captured PNG and say what is actually visible in each.
5. Fix anything obviously broken: missing geometry, z-fighting, objects floating or sunk into
   terrain, inverted normals, NaN transforms, cameras pointed at empty space.
6. Check for contract drift: two lanes registering the same PassOrder slot; services still null
   at boot (\`registry.nullKeys()\` is logged); reset hooks not reached.
7. Delete stale \`dist-*\` directories. Commit the result with a clear message.

Report: what was broken, what you fixed, the full list of working shots, and an HONEST assessment
of how these frames look — the visual lanes have not run yet, so expect untextured/unlit geometry.
Say plainly what the biggest visual gaps are, since that briefs the next wave.`,
  { label: 'integrate-lanes', phase: 'Integrate', effort: 'high' },
)

return { lanes: ok.length, integration }
