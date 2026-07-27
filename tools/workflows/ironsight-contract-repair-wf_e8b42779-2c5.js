export const meta = {
  name: 'ironsight-contract-repair',
  description: 'Fix the BootContext/reset/registerBakes/locomotion contract blockers before fan-out',
  phases: [
    { title: 'Repair', detail: 'wire ctx into all 23 descriptors, add reset + registerBakes + locomotion seam' },
    { title: 'Adversarial', detail: '4 lane-simulation agents each try to build a subsystem against the contract alone' },
    { title: 'Close', detail: 'fix whatever the simulations proved missing' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

const PRE = `You are working in ${ROOT} on IRONSIGHT. Read ${ROOT}/docs/BRIEF.md,
${ROOT}/docs/ARCHITECTURE.md and ${ROOT}/docs/OWNERSHIP.md first.

Toolchain: \`npm run verify\` = typecheck + boundary CI + build. It is currently GREEN and must
stay green. Screenshots: \`./tools/shoot.sh <shot>\`.`

phase('Repair')

const repair = await agent(
  `${PRE}

You are CORE. A skeptical integration review found blockers that make it IMPOSSIBLE for the
twelve parallel subsystem agents to do their work. You are fixing them now, before fan-out. This
is the highest-leverage task in the project: every downstream agent is blocked on it.

Read \`${ROOT}/src/bootstrap/subsystems.ts\`, \`${ROOT}/src/engine/engine.ts\`,
\`${ROOT}/src/engine/driver.ts\` and \`${ROOT}/src/engine/types.ts\` before changing anything.

=== BLOCKER 1: BootContext is discarded for 12 of 23 lanes ===
In \`src/bootstrap/subsystems.ts\`, 12 descriptors are written \`create: (): X => createX()\` and
throw the BootContext away entirely: vegetation, physics, destruction, weapons, ballistics, vfx,
audio, hud, nav, ai, player, mode.

\`src/engine/engine.ts\` correctly builds a full BootContext (addTick, addRender, assets, services,
scene, rng, registry, report) and passes it to \`descriptor.create(ctx)\` — the engine is right,
subsystems.ts drops it. Consequences: VFX cannot subscribe to the FxBus or draw anything; AI
cannot register a tick system or spawn a bot; PHYSICS cannot register its step; HUD cannot reach
its baked font. \`weapons\` and \`hud\` even declare \`dependsOn: ['assets']\` and then take no ctx,
which is the proof this is an oversight rather than a design.

FIX: pass \`ctx\` to ALL 23 factories, and widen every stub factory's signature to accept the
BootContext. Keep each factory's NAME and PATH identical — lanes replace the body of their file,
so the exported symbol must not move.

=== BLOCKER 2: SubsystemDescriptor.reset(seed) is unreachable ===
\`src/engine/driver.ts\` calls \`descriptor.reset?.(seed)\` and ARCHITECTURE 8.1 says implementing it
is mandatory — but NO descriptor declares \`reset\`, and OWNERSHIP/ARCHITECTURE both freeze
subsystems.ts so no lane can add one. Every per-lane reset hook (decal pools, debris, particles,
bot positions, wind phase, destroyed walls) is therefore unimplementable, and shot results will
silently depend on capture order.

=== BLOCKER 3: SubsystemDescriptor.registerBakes(assets, quality) is unreachable ===
Declared in types.ts, implemented by zero descriptors, unaddable for the same frozen-file reason.
Combined with lanes having no ctx.assets, NO LANE CAN DECLARE A SINGLE BAKE STEP — and "every
texture, mesh and sound generated procedurally at load time" is the central constraint of this
project. Note the ordering constraint in \`src/main.ts\`: registerBakes runs BEFORE bakeAll, which
runs BEFORE subsystem construction. So bake declaration cannot happen inside \`create\`.

FIX for 2 and 3: adopt a convention where each lane module exports, alongside its factory, an
OPTIONAL \`registerXBakes(assets, quality)\` and \`resetX(seed)\`. Add these as real no-op exports to
every lane stub file now, so subsystems.ts can wire all three named exports today and a lane just
fills in the body later. Wire them in subsystems.ts and verify driver.ts actually calls reset.

=== BLOCKER 4: AI has no locomotion seam ===
ARCHITECTURE decision #6 says bots emit PlayerIntent and "drive the same controller" as the
player. But \`PlayerService\` (types.ts ~2752) exposes only \`readonly state: Readonly<PlayerState>\`
— singular — with no \`stateOf(entity)\`, unlike WeaponService which has \`stateOf(entity)\`. 24 bots
cannot go through PlayerService. Separately, NOTHING dispatches
\`AiService.intentSource.sample(entity, ctx, out)\`, and TickPhase.Intent / TickPhase.Ai /
TickPhase.Movement have zero registered systems.

FIX: add the missing seam to types.ts — \`PlayerService.stateOf(entity: EntityId)\` plus an explicit
per-entity locomotion surface — and write down in ARCHITECTURE.md which lane owns per-entity
intent dispatch. Make it unambiguous.

=== ALSO ===
- \`src/render/service.ts\` is unowned by OWNERSHIP.md. Assign it to a lane.
- ARCHITECTURE.md and OWNERSHIP.md declare subsystems.ts frozen. It is legitimate to edit it NOW
  (day 0, before fan-out). After you are done, it is frozen for real. Update the doc comment to
  say the freeze begins now.
- BRIEF.md says npm runs on node 18; that has been fixed (npm scripts route through
  \`tools/with-node.sh\`). Correct any doc that still says otherwise.
- Boundary CI now exists at \`tools/check-boundaries.mjs\` and runs in \`npm run verify\`. Do not
  weaken it to make code pass; fix the code.

DONE means: \`npm run verify\` is green, \`./tools/shoot.sh core\` still exits 0, and you have Read
the PNG to confirm it still renders. Report exactly what you changed and what a lane agent must
now write to ship their subsystem.`,
  { label: 'core-contract-repair', phase: 'Repair', effort: 'high' },
)

phase('Adversarial')

// The real test of a contract is not whether it typechecks — it is whether an
// agent who has ONLY the contract can build against it. So simulate four lanes
// for real, in throwaway scratch files, and see what they hit.
const LANES = [
  { key: 'vfx', task: 'a GPU particle system that subscribes to the FxBus, spawns a smoke puff on an impact event, registers a render pass, and pools its particles' },
  { key: 'ai', task: 'a bot that pathfinds via NavService, emits PlayerIntent through the locomotion seam, and drives a weapon via WeaponService.stateOf' },
  { key: 'water', task: 'a Gerstner ocean that adds a ForwardWater pass to the render graph, reads TerrainService.shoreMask, samples the scene colour copy for refraction, and advances phase per frame' },
  { key: 'hud', task: 'a HUD that bakes a signed-distance font atlas at load time, reads MatchState from GameMode, and draws the ticket bar + ammo counter' },
]

const SIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['buildable', 'missingSeams', 'notes'],
  properties: {
    buildable: { type: 'boolean', description: 'Could you actually write this lane against the contract alone?' },
    missingSeams: {
      type: 'array',
      description: 'Each specific type, method or wiring point that is missing or ambiguous.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'whyBlocking', 'proposedFix'],
        properties: {
          what: { type: 'string' },
          whyBlocking: { type: 'string' },
          proposedFix: { type: 'string', description: 'Exact TypeScript to add, and to which file.' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const sims = await parallel(
  LANES.map((l) => () =>
    agent(
      `${PRE}

You are simulating the ${l.key.toUpperCase()} lane agent, to stress-test the contract before
twelve real agents depend on it.

Read ONLY these, as a real lane agent would: \`docs/ARCHITECTURE.md\`, \`docs/OWNERSHIP.md\`,
\`src/engine/types.ts\`, and your own lane's stub file. You may also read \`src/bootstrap/subsystems.ts\`
to see how you are constructed. **Do NOT read another lane's implementation** — if you find
yourself needing to, that is itself a finding, and you must report it.

YOUR TASK: actually attempt to implement ${l.task}.

Write your attempt to \`${ROOT}/tmp-contract-sim/${l.key}.ts\` (a scratch directory — do NOT touch
\`src/\`). Write REAL code, not a sketch: if the contract is sufficient, your file should be
something you could paste into the lane's real file and have it typecheck. Then run
\`npx tsc --noEmit tmp-contract-sim/${l.key}.ts --strict --target ES2022 --moduleResolution bundler --module ESNext --skipLibCheck --baseUrl . --paths '{"@/*":["src/*"]}'\`
or simply reason carefully about whether it would compile against the real types.

Report honestly. A contract that "looks complete" but blocks you on the third method you need is
exactly what we are trying to catch. Every missing seam you report must include the exact
TypeScript to add and which file it belongs in.`,
      { label: `sim:${l.key}`, phase: 'Adversarial', schema: SIM_SCHEMA, effort: 'high' },
    ),
  ),
)

const results = sims.filter(Boolean)
const allMissing = results.flatMap((r, i) => (r.missingSeams || []).map((m) => ({ lane: LANES[i]?.key, ...m })))
log(`lane simulations: ${results.filter((r) => r.buildable).length}/${results.length} buildable, ${allMissing.length} missing seam(s)`)

phase('Close')

if (allMissing.length === 0) {
  log('contract is complete — no seams missing')
  return { repaired: true, simulations: results, missing: [] }
}

const close = await agent(
  `${PRE}

You are CORE. Four agents simulated real lane work against the contract. They found these gaps:

${allMissing.map((m, i) => `${i + 1}. [lane: ${m.lane}] ${m.what}
   WHY BLOCKING: ${m.whyBlocking}
   PROPOSED FIX: ${m.proposedFix}`).join('\n\n')}

Simulation notes:
${results.map((r, i) => `[${LANES[i]?.key}] buildable=${r.buildable}\n${r.notes}`).join('\n\n')}

TASK: close every one of these gaps in \`src/engine/types.ts\` (and ARCHITECTURE.md / the stub
files where the fix belongs there instead).

Use judgement — a proposed fix may be wrong, redundant, or better solved a different way, and two
lanes may have proposed conflicting shapes for the same seam. Where you reject a proposal, say
why. Where two proposals overlap, unify them into one seam rather than adding both. Prefer adding
to the contract over loosening it; never add \`any\`.

Then delete the scratch directory \`${ROOT}/tmp-contract-sim/\` entirely.

DONE means \`npm run verify\` is green and \`./tools/shoot.sh core\` still exits 0 and renders.
Report the final list of seams added and confirm the contract is ready for twelve parallel agents.`,
  { label: 'close-contract-gaps', phase: 'Close', effort: 'high' },
)

return { repaired: true, simulations: results, missingCount: allMissing.length, closeReport: close }
