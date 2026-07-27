export const meta = {
  name: 'ironsight-foundation',
  description: 'Design and build the IRONSIGHT engine foundation + module contracts',
  phases: [
    { title: 'Design', detail: '3 independent architecture proposals with different biases' },
    { title: 'Synthesize', detail: 'merge into ARCHITECTURE.md + types.ts + OWNERSHIP.md' },
    { title: 'Build', detail: 'implement engine core, service registry, main bootstrap' },
    { title: 'Verify', detail: 'typecheck, build, capture, eyeball the frame' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

const PREAMBLE = `You are working in the repo at ${ROOT}.

FIRST ACTION, ALWAYS: Read ${ROOT}/docs/BRIEF.md in full. It is the shared contract for this
project and everything below assumes you have read it.

Also read these existing files so you know what already exists:
- ${ROOT}/src/engine/harness.ts   (LOCKED — the screenshot contract, do not edit)
- ${ROOT}/src/main.ts             (throwaway smoke test, will be replaced)
- ${ROOT}/package.json
- ${ROOT}/tsconfig.json

Toolchain notes: three@0.185, TypeScript strict, Vite 7. \`npm run typecheck\` and \`npm run build\`
run on node 18. Screenshots are \`./tools/shoot.sh <shotname>\` (node 22, headless SwiftShader, slow).
The import alias \`@/\` maps to \`src/\`.
`

const ARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'moduleTree', 'coreInterfaces', 'renderGraph', 'risks', 'sequencing'],
  properties: {
    summary: { type: 'string', description: 'Two paragraphs on the shape of the architecture and why.' },
    moduleTree: {
      type: 'string',
      description: 'Full proposed src/ tree as a text diagram, one line per file, with a trailing comment naming the single owning subsystem for each file.',
    },
    coreInterfaces: {
      type: 'string',
      description: 'Actual TypeScript source for the shared contract types every subsystem codes against. Real compilable code, not prose.',
    },
    renderGraph: {
      type: 'string',
      description: 'Ordered list of render passes from depth-prepass to final present, with the render target format and resolution scale of each, and which passes read which.',
    },
    risks: { type: 'array', items: { type: 'string' }, description: 'Concrete integration or performance risks with this design.' },
    sequencing: {
      type: 'array',
      items: { type: 'string' },
      description: 'Which subsystems can be built fully in parallel vs which must wait, and on what.',
    },
  },
}

phase('Design')

const BIASES = [
  {
    key: 'render-first',
    lens: `You are a principal RENDERING engineer from a Frostbite/Decima-class engine team. Design the
architecture around the frame: a proper render graph with explicit resource lifetimes, HDR
throughout, a deferred-or-forward+ decision you justify, cascaded shadows, temporal
reprojection with correct motion vectors, and a post chain that is ordered for correctness
(resolve before bloom, bloom before tonemap, tonemap before UI). Gameplay code must be a
client of the renderer, never tangled into it. Be specific about render target formats
(RGBA16F vs R11G11B10 vs RG16F) and about where the velocity buffer comes from.`,
  },
  {
    key: 'gameplay-first',
    lens: `You are a principal GAMEPLAY architect from a shipped AAA shooter. Design around the
simulation: a fixed-timestep deterministic tick separated from a variable-rate render with
interpolation, an entity/component layout that makes weapons, bots, vehicles and destructible
props uniform, a typed event bus, and clean seams between input -> intent -> simulation ->
presentation so that weapon feel (recoil, sway, ADS, bob) is authored data rather than
scattered magic numbers. Be specific about how the player controller, ballistics and the
Rapier physics world interact without fighting each other.`,
  },
  {
    key: 'perf-first',
    lens: `You are a principal PERFORMANCE/TECH-ART engineer. Design around the budget: everything is
generated procedurally at load time, so you must design the asset bake pipeline (what is baked
on the GPU, what on a worker, what is cached, how progress is reported) and the runtime budget
(instancing strategy, LOD selection, culling, draw call ceilings, texture memory ceiling,
shader permutation control). Also design the quality-tier system that scales the whole engine
from a laptop iGPU to a discrete GPU. Be specific about numbers: draw calls, triangle counts,
VRAM, and millisecond budgets per pass.`,
  },
]

const proposals = await parallel(
  BIASES.map((b) => () =>
    agent(
      `${PREAMBLE}

${b.lens}

TASK: Produce a complete architecture proposal for IRONSIGHT.

This is a DESIGN task. Do NOT write or edit any files — return your proposal through the
structured output only. You may read files and run read-only commands to ground yourself.

The project will be built by roughly a dozen agents working IN PARALLEL, each owning a
disjoint set of files. Your architecture is what stops that from becoming a merge disaster,
so the single most important property of your design is: **crisp module boundaries with a
shared, compilable contract layer that everyone codes against**. A subsystem author must be
able to build their piece against interfaces alone, without reading anyone else's
implementation.

Cover at minimum: engine core loop and service access, the render graph, the procedural asset
bake pipeline, world/terrain/sky, vegetation, the level, weapons and ballistics, physics and
destruction, VFX, audio, AI, UI/HUD, and the Conquest game mode.

Your \`coreInterfaces\` field must be REAL TypeScript that would compile: the interfaces,
type aliases and enums that form the seam between subsystems. Include the service registry
type, the per-frame context passed to updaters, the quality-tier enum, the asset/bake
registry interface, and the interfaces each major subsystem exposes.`,
      { label: `arch:${b.key}`, phase: 'Design', schema: ARCH_SCHEMA, effort: 'high' },
    ),
  ),
)

const good = proposals.filter(Boolean)
log(`${good.length}/3 architecture proposals returned`)

phase('Synthesize')

const brief = good
  .map(
    (p, i) => `
===================== PROPOSAL ${i + 1} (${BIASES[i]?.key ?? 'unknown'}) =====================
SUMMARY:
${p.summary}

MODULE TREE:
${p.moduleTree}

RENDER GRAPH:
${p.renderGraph}

CORE INTERFACES:
${p.coreInterfaces}

RISKS:
${(p.risks || []).map((r) => '- ' + r).join('\n')}

SEQUENCING:
${(p.sequencing || []).map((r) => '- ' + r).join('\n')}
`,
  )
  .join('\n')

const synth = await agent(
  `${PREAMBLE}

You are the TECHNICAL DIRECTOR. Three principal engineers independently proposed an
architecture for IRONSIGHT, each from a different bias (rendering, gameplay, performance).
Your job is to merge them into ONE authoritative design and write it to disk.

${brief}

TASK — write exactly these three files:

1. \`${ROOT}/docs/ARCHITECTURE.md\`
   The authoritative design. Module tree with one named owner per file. The render graph as an
   ordered pass list with RT formats and resolution scales. The frame lifecycle (fixed sim tick
   vs variable render, interpolation, where each subsystem gets called). The procedural bake
   pipeline and its progress/readiness protocol. The quality-tier system. Threading/worker
   strategy. Where the harness plugs in. Take the best of all three proposals; where they
   conflict, decide, and write one sentence saying why. Be decisive — this document is law for
   a dozen parallel agents.

2. \`${ROOT}/src/engine/types.ts\`
   The compilable contract layer. Every interface, type and enum that forms a seam between
   subsystems. This is the single most important file in the project: parallel agents will code
   against it without reading each other's implementations, so it must be complete enough that
   every subsystem's surface is expressible. Include: the service registry, the per-frame update
   context, the fixed-tick context, the quality tiers, the bake/asset registry, the event bus
   payload map, and the exported interface of every subsystem listed in ARCHITECTURE.md.
   Document each interface with a short doc comment describing the contract, invariants and
   who implements it. It must typecheck standalone (types and interfaces only — no runtime
   logic, no imports from unwritten modules other than \`three\` and the harness).

3. \`${ROOT}/docs/OWNERSHIP.md\`
   A table: subsystem name | the exact glob(s) of files it owns | what it must expose from
   types.ts | which shots in \`src/shots/\` it is responsible for registering. Every file in the
   module tree must appear under exactly one owner. This is the anti-collision map.

Then run \`npm run typecheck\` and make sure it is clean.

Return a short report: the decisions you made where proposals conflicted, and anything the
subsystem agents will need to be warned about.`,
  { label: 'synthesize-architecture', phase: 'Synthesize', effort: 'high' },
)

phase('Build')

const foundation = await agent(
  `${PREAMBLE}

You are the ENGINE LEAD. The architecture is now settled. Read these first:
- ${ROOT}/docs/ARCHITECTURE.md
- ${ROOT}/src/engine/types.ts
- ${ROOT}/docs/OWNERSHIP.md

Technical director's handoff notes:
${synth}

TASK: Implement the engine FOUNDATION — the skeleton that a dozen parallel subsystem agents
will hang their work on. You own \`src/engine/**\` (except the locked \`harness.ts\`) and
\`src/main.ts\`.

Build, for real and to production quality:

- **Service registry / engine context** — how any subsystem reaches the renderer, scene, camera,
  physics, audio, input, events, RNG and quality settings. Typed, no \`any\`, no globals beyond
  the harness.
- **Frame lifecycle** — fixed-timestep simulation accumulator with a max-catchup clamp, variable
  render with alpha interpolation, and clean ordered phases (input -> sim ticks -> post-sim ->
  camera -> render). Every phase must be a registration point subsystems can hook.
- **Seeded RNG** — a fast deterministic generator (PCG or xoshiro), with named sub-streams so one
  subsystem drawing extra numbers cannot shift another's sequence. This is what makes shots
  reproducible.
- **Typed event bus** — compile-time-checked topic to payload mapping.
- **Async bake/asset registry** — subsystems register named bake jobs with a cost weight; the
  registry runs them, reports aggregate progress, and resolves readiness. This is what drives
  \`markReady()\` for the harness and the loading screen.
- **Quality tiers** — a settings object every subsystem reads (shadow resolution, cascade count,
  post-FX toggles, particle budgets, instance counts, render scale), with an auto-detect that
  picks a tier from a quick GPU probe.
- **Input** — pointer lock, mouse look with configurable sensitivity, keyboard action mapping,
  gamepad, all normalised into an intent struct the player controller consumes. Must be
  suppressible so the harness can pose the camera without input fighting it.
- **Renderer bootstrap** — WebGLRenderer configured correctly for an HDR pipeline: colour
  management on, ACES/AgX tonemapping hook, correct output colour space, shadow config, and a
  resize path that respects render scale.
- **A stub registry for every subsystem** in OWNERSHIP.md — a no-op implementation of each
  subsystem interface, registered in the right lifecycle phase, so \`main.ts\` wires up the
  COMPLETE engine today and each subsystem agent replaces exactly one stub tomorrow without
  touching \`main.ts\`. Make each stub a real file at the path OWNERSHIP.md specifies, exporting
  the right symbol with the right signature, with a comment saying which agent owns it.
- **main.ts** — bootstrap: create engine, register all subsystems, run bakes with a progress
  screen, attach the harness driver (implementing \`stepFrame\`/\`setLoopSuspended\`/\`flush\`
  correctly against the fixed-tick loop), then \`markReady()\`.
- **A debug overlay** — frame time graph, draw calls, triangle count, memory, current quality
  tier. Toggled with a key. Hidden during shots.

Also create \`src/shots/index.ts\` which imports every per-area shot module (create empty-but-valid
modules for each area named in OWNERSHIP.md), and keep ONE working shot registered so the
harness is provably alive.

DONE means all of:
  1. \`npm run typecheck\` -> zero errors
  2. \`npm run build\` -> succeeds
  3. \`./tools/shoot.sh --list\` -> prints shot names
  4. \`./tools/shoot.sh <a shot>\` -> exits 0 and writes a PNG
  5. You have \`Read\` that PNG and confirmed it is a rendered frame, not a black screen

Iterate until all five hold. Report what you built, the exact lifecycle order you settled on,
and the precise instruction a subsystem agent needs in order to replace their stub.`,
  { label: 'engine-foundation', phase: 'Build', effort: 'high' },
)

phase('Verify')

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['typecheckClean', 'buildClean', 'shotsWork', 'contractComplete', 'blockers', 'notes'],
  properties: {
    typecheckClean: { type: 'boolean' },
    buildClean: { type: 'boolean' },
    shotsWork: { type: 'boolean' },
    contractComplete: {
      type: 'boolean',
      description: 'True only if a subsystem agent could implement their piece against types.ts alone.',
    },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Anything that would break parallel subsystem work. Empty if none.',
    },
    notes: { type: 'string' },
  },
}

const verdict = await agent(
  `${PREAMBLE}

You are a SKEPTICAL integration reviewer. The engine foundation was just built. Your job is to
find out whether a dozen agents can now safely work in parallel on top of it — not to be
reassured that they can.

Do all of this yourself, from a clean slate. Do not trust the previous agent's claims:
1. Run \`npm run typecheck\`. Report the true result.
2. Run \`npm run build\`. Report the true result.
3. Run \`./tools/shoot.sh --list\`, then capture a shot, then \`Read\` the resulting PNG and say
   what is actually visible in it.
4. Read \`docs/ARCHITECTURE.md\`, \`docs/OWNERSHIP.md\` and \`src/engine/types.ts\`. Then pick THREE
   subsystems at random and ask, for each: could an agent who has read only types.ts,
   ARCHITECTURE.md and OWNERSHIP.md implement this subsystem without reading any other
   subsystem's implementation? If not, that is a blocker — name the exact missing type or seam.
5. Check that every file in the OWNERSHIP.md table actually exists as a stub and that no two
   owners claim the same file. Overlapping ownership is a blocker.
6. Confirm \`src/engine/harness.ts\` was not modified (\`git diff --stat\` / \`git status\`).

Fix trivial problems yourself (a missing stub file, a typo, a bad import). Report anything
structural as a blocker rather than papering over it.`,
  { label: 'verify-foundation', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
)

log(`foundation verdict: typecheck=${verdict?.typecheckClean} build=${verdict?.buildClean} shots=${verdict?.shotsWork} contract=${verdict?.contractComplete}`)

return { verdict, synthesisNotes: synth, foundationNotes: foundation }
