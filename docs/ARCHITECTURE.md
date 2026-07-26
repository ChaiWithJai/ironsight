# IRONSIGHT — ARCHITECTURE

**This document is law.** Sixteen lanes are built in parallel against it. Where it conflicts with
your instinct, follow it and raise the conflict in your report. Where it is silent, you own the
call inside your lane and nowhere else.

Companion documents:

- `docs/BRIEF.md` — what we are building and the quality bar. Read first.
- `src/engine/types.ts` — the compilable contract. Every seam in this document is expressed there.
- `docs/OWNERSHIP.md` — which lane owns which files, and which shots it must register.

---

## 0. The three structural rules

Everything below is downstream of these. If you remember nothing else, remember these.

**Rule 1 — Rings, one-way.** Three concentric rings with strictly one-way dependencies:

```
        ┌─────────────────────────────────────────────┐
        │  CONTRACT   src/engine/types.ts             │  types, enums, frozen tables. No behaviour.
        │  ┌───────────────────────────────────────┐  │
        │  │  CORE   loop, services, clock, rng,   │  │  knows the boot order and nothing else's guts
        │  │         events, entities, quality,    │  │
        │  │         scenegraph, culling, driver   │  │
        │  │  ┌─────────────────────────────────┐  │  │
        │  │  │  LANES  15 subsystems, disjoint │  │  │  never import each other
        │  │  │         file sets, one service  │  │  │
        │  │  └─────────────────────────────────┘  │  │
        │  └───────────────────────────────────────┘  │
        └─────────────────────────────────────────────┘
```

A lane imports `@/engine/types`, `@/engine/harness`, `three`, `@dimforge/rapier3d-compat`, and its
own directory. Nothing else. If you need something from another lane it is already a method on a
service in `types.ts`; if it genuinely is not, append narrowly to the matching section of
`types.ts`, and say so in your report.

**Rule 2 — No shared file is ever edited twice.** `src/bootstrap/subsystems.ts`,
`src/bootstrap/nulls.ts` and `src/shots/index.ts` are written once, by CORE, on day 0, and never
touched again. `subsystems.ts` holds one `SubsystemDescriptor` per lane pointing at a stub factory
that returns the null service; a lane ships by replacing the *body* of the file that factory lives
in. `src/shots/index.ts` uses `import.meta.glob(['./*.ts', '!./index.ts'], { eager: true })`, so
lanes only ever *create* `src/shots/<lane>.ts`. That glob is worth more to this project than any
amount of merge discipline.

A frozen table cannot grow a hook later, so **every descriptor is wired to three named exports of
its lane's entry file on day 0**, all present as no-ops from the start (§2.1). A lane fills in a
body and ships; it never comes back to `subsystems.ts`.

> **The freeze on `src/bootstrap/subsystems.ts` begins now.** It was written on day 0 and revised
> exactly once, before fan-out, to pass the `BootContext` to all 23 factories and to wire
> `registerBakes` and `reset` for every one of them. From that commit it is closed. If a lane
> believes it needs an edit there, the answer is a body change in its own entry file.

**Rule 3 — Null services, day one.** `src/bootstrap/nulls.ts` contains a working null
implementation of *every* entry in `Services`: flat terrain at y=0, empty level with three hardcoded
capture points, a physics service whose rays always miss, a silent audio service, a game mode that
returns plausible fake state. Any lane can boot the entire engine with 27 nulls and one real service
and still take a screenshot. This is the difference between sixteen parallel agents and sixteen
serialised ones.

---

## 1. Decisions where the proposals conflicted

Each of these was a genuine three-way disagreement. The decision is final; the sentence after it is
why.

| # | Conflict | Decision | Why |
|---|---|---|---|
| 1 | Deferred G-buffer vs forward+ with prepass | **Forward+ (clustered) with an MRT depth prepass** writing depth, packed normal/roughness, and velocity | three.js has no G-buffer path, so deferred would force every lane's surface shading into one hand-written GLSL3 material — the exact merge disaster we are engineering against — and its per-slot MRT formats rely on undocumented `WebGLRenderTarget` internals. |
| 2 | Deferred projected decals (needs a G-buffer) | **Forward box-projected decals blended into scene colour**, reading `SceneDepth`, normal-reoriented and angle-faded | Loses G-buffer normal writes, but the brief's actual requirement — bullet holes, scorch, and `GroundTransition` debris rings that kill the hard geometry/ground seam — is fully served by a colour+normal blend against reconstructed depth. |
| 3 | `EQUAL` vs `LEQUAL` depth in the forward pass | **`LEQUAL`, `depthWrite: false`** | `EQUAL` is a fraction faster but turns any float divergence between the prepass and forward vertex shaders into whole-surface z-fighting; hierarchical-Z still rejects occluded fragments under `LEQUAL`, so we keep ~95% of the early-Z win with none of the catastrophic failure mode. |
| 4 | Full ECS vs services-only | **Services + a minimal entity/component store**, used only by GAME, AI, WEAPONS, PHYS | Damage, scoring and AI genuinely need shared per-entity state with deterministic iteration order; renderers and bakers never touch it, so the concept cost is paid only by the four lanes that benefit. |
| 5 | Lockstep 60 Hz vs fixed tick + interpolated render | **Fixed 60 Hz tick with an integer-microsecond accumulator + variable render interpolating by `alpha`** | Gameplay must not read frame rate, and under the harness `dt = 1/60` yields exactly one tick per `stepFrame()` with `alpha = 0`, so captures stay bit-comparable. |
| 6 | Separate bot AI code path vs shared | **Bots emit `PlayerIntent`, the same struct humans produce, and go through the same `PlayerService` controller table** (§3.4) | One movement/fire-control code path means a feel change lands for 24 bots and the player simultaneously, and a movement bug cannot manifest differently for AI. |
| 7 | One recoil value vs sim/view split | **`WeaponState.aimPunch` (sim, deflects bullets) and `WeaponFeelState.cameraKick` (view, cosmetic)** | This is the only way the crosshair and the bullet can never disagree, and it lets WEAPONS split cleanly into two agents. |
| 8 | `Vec3` as a plain record vs `THREE.Vector3` | **`THREE.Vector3` throughout** | Every lane already imports three, rapier accepts it structurally, and a second vector type would add a conversion layer at every seam for no gain. |
| 9 | `types.ts` as one file vs a barrel over `contracts/*` | **One file** | The brief names `src/engine/types.ts` as *the* import path; a barrel over a dozen files buys nothing when the content is types-only and costs a real risk of a partial merge that does not compile. |
| 10 | Main-thread bake vs worker pool | **GPU device for anything that becomes a texture; a worker pool with a mandatory inline fallback for anything that becomes a typed array** | Mesh, navmesh and audio synthesis are CPU-bound and would hitch the main thread, but no lane may be *blocked* on workers, so `WorkerPool.run` must execute inline when `workerCount` is 0. |
| 11 | Bake over-budget: drop steps vs degrade | **Degrade resolution** (`BakeProfile.unitCeiling`) | A missing material is a visual defect; a 256² material is merely softer. |
| 12 | GPU Hi-Z occlusion readback vs CPU software raster | **CPU software occlusion raster, 256×144, ≤48 tagged occluders** | Hi-Z readback is a frame late and varies with GPU timing, which would make shots non-reproducible — and reproducibility is the review loop. |
| 13 | Where the HUD lives | **In-canvas orthographic pass after tonemap. No DOM UI anywhere.** | `tools/capture.mjs` screenshots the canvas only, so a DOM HUD is invisible in every shot; drawing UI before tonemap is the classic hobby-stack tell. |
| 14 | Motion vectors: discipline vs structure | **`MaterialFactory.registerDeform()` is the only legal way to move a vertex in a shader** | The identical GLSL is injected into the forward, depth, shadow and velocity materials, so motion vectors and shadows cannot disagree with the lit pass — a rule the type system can enforce with a CI grep, unlike "remember to update `prevMatrixWorld`". |
| 15 | Where the level's macro shape lives | **`MACRO_TERRAIN`, a frozen analytic silhouette in `src/engine/macro.ts`, day 0** | LEVEL, VEG, WATER and AI can place things correctly before TERRAIN's eroded heightfield exists, because both sides evaluate the same function. |

---

## 2. Module tree — one named owner per file

Lane tags are the owner. Every file in the repo appears exactly once. See `docs/OWNERSHIP.md` for
the glob table and the shot assignments.

```
src/
├── main.ts                                  CORE    boot → caps probe → bake → build → attachDriver → markReady
├── bootstrap/
│   ├── subsystems.ts                        CORE    the 23 SubsystemDescriptors. WRITTEN DAY 0, FROZEN.
│   └── nulls.ts                             CORE    a null implementation of every Services entry
├── engine/
│   ├── harness.ts                           LOCKED  do not edit, ever
│   ├── types.ts                             CORE    THE CONTRACT (sectioned; see per-section amender)
│   ├── renderer.ts                          CORE    WebGLRenderer construction + EXT_color_buffer_float probe
│   ├── engine.ts                            CORE    service construction, topological boot over dependsOn
│   ├── loop.ts                              CORE    integer-µs accumulator, TickPhase + RenderStage dispatch
│   ├── driver.ts                            CORE    HarnessDriver + ShotContext impl + the reset chain
│   ├── services.ts                          CORE    ServiceRegistry impl (null-aware)
│   ├── clock.ts                             CORE    tick/frame/alpha; simTime is derived, never wall-clock
│   ├── rng.ts                               CORE    PCG32 + fork(label); the ONLY randomness in the repo
│   ├── events.ts                            CORE    deferred insertion-ordered SimBus and FxBus
│   ├── entities.ts                          CORE    generational EntityId, dense ComponentStore
│   ├── components.ts                        CORE    ComponentDefs shared by ≥2 lanes (transform, health, team)
│   ├── quality.ts                           CORE    the four tier tables + dynamic-resolution governor
│   ├── caps.ts                              CORE    GPU probe, SwiftShader detection, EXT_color_buffer_float
│   ├── profiler.ts                          CORE    CPU marks + disjoint timer queries + budget assertions
│   ├── input.ts                             CORE    pointer lock, keymap, device deltas → PlayerIntent
│   ├── scenegraph.ts                        CORE    SceneGroups, static registry, 32 m sector grid
│   ├── culling.ts                           CORE    sector → frustum → software occlusion raster, LOD hysteresis
│   ├── batching.ts                          CORE    BatchedMesh cluster builder over GeometrySpec
│   ├── macro.ts                             CORE    MACRO_TERRAIN — frozen Harbour Reach silhouette
│   ├── debug.ts                             CORE    DebugService: gizmos, frame graph (stripped in prod)
│   └── math/                                CORE    packing, spring, curves, frustum, halton, easing
├── bake/
│   ├── registry.ts                          BAKE    AssetRegistry impl: topo sort, unit ceiling, progress
│   ├── gpu-device.ts                        BAKE    GpuBakeDevice: fullscreen/MRT/iterate/volume/impostor
│   ├── worker-pool.ts                       BAKE    transferable job pool with MANDATORY inline fallback
│   ├── workers/                             BAKE    mesh / data / audio workers + protocol
│   ├── cache.ts                             BAKE    IndexedDB cache keyed by hash(id, version, params, profile)
│   ├── units.ts                             BAKE    cost model and degradation policy
│   ├── mips.ts                              BAKE    normal-renormalising + Toksvig roughness mip chains
│   ├── noise.ts                             BAKE    NoiseLib: CPU noise + the MATCHING GLSL chunks
│   ├── glsl/                                BAKE    hash, fbm, worley, gabor, erosion, curvature, wear, packing
│   ├── sdf.ts                               BAKE    2D/3D SDF primitives and ops
│   ├── mesh.ts                              BAKE    lathe/loft/extrude/bevel/weld/decimate + GeometrySpec builder
│   ├── greeble.ts                           BAKE    procedural panelling, rivets, pipes, edge bevels
│   ├── fracture.ts                          BAKE    Voronoi pre-fracture → DestructibleDef chunk sets
│   └── impostor.ts                          BAKE    octahedral impostor atlas baker
├── render/
│   ├── service.ts                           RCORE   RenderService facade, submit system, resize path
│   ├── graph.ts                             RCORE   RenderGraph impl, pass ordering, validate(), aliasing
│   ├── targets.ts                           RCORE   RT pool, RTFormat → GL table, VRAM accounting
│   ├── fullscreen.ts                        RCORE   cached fullscreen-triangle programs
│   ├── camera-rig.ts                        RCORE   CameraRig — the ONLY writer of camera transform
│   ├── color.ts                             RCORE   AgX tonemap, 32³ grade LUT bake, colour-space plumbing
│   ├── material/
│   │   ├── factory.ts                       RCORE   MaterialFactory impl, permutation cap, deform registry
│   │   ├── iron-material.ts                 RCORE   THE uber material (one onBeforeCompile over Physical)
│   │   ├── chunks.ts                        RCORE   shared GLSL: detail, triplanar, stochastic, wear, POM, dither
│   │   ├── deform.ts                        RCORE   vertex-deform chunk registry (fwd/depth/shadow/velocity)
│   │   ├── arrays.ts                        RCORE   albedo + surface DataArrayTexture allocation
│   │   ├── surfaces.ts                      RCORE   the frozen SurfaceProfile table
│   │   └── prewarm.ts                       RCORE   probe scene; compiles every permutation before markReady
│   ├── passes/
│   │   ├── prepass.ts                       RCORE   MRT: depth + normal/rough + velocity
│   │   ├── hiz.ts                           RCORE   Hi-Z min-depth mip chain
│   │   ├── forward.ts                       RCORE   opaque, LEQUAL, depthWrite off, cluster-lit
│   │   ├── transparent.ts                   RCORE   sorted forward, soft particles
│   │   ├── viewmodel.ts                     RCORE   own near camera, own depth range, writes velocity
│   │   ├── velocity-dilate.ts               RCORE   tile-max / neighbour-max
│   │   ├── taa.ts                           RCORE   Halton jitter, YCoCg clip, Catmull-Rom history
│   │   ├── motionblur.ts                    RCORE   McGuire reconstruction
│   │   ├── exposure.ts                      RCORE   log-luma reduction + adaptation (FROZEN in capture)
│   │   ├── bloom.ts                         RCORE   Karis-average 6-level pyramid, EV-relative threshold
│   │   ├── dof.ts                           RCORE   ADS-gated CoC + gather bokeh
│   │   ├── tonemap.ts                       RCORE   AgX + grade LUT
│   │   ├── lens.ts                          RCORE   vignette, aberration, grain, CAS
│   │   └── present.ts                       RCORE   blit / upscale to the default framebuffer
│   └── lighting/
│       ├── service.ts                       LIGHT   LightingService impl, photometric sun
│       ├── csm.ts                           LIGHT   cascade fit, world-space texel snapping, per-cascade cadence
│       ├── shadow-atlas.ts                  LIGHT   tiled depth atlas, slope-scaled + normal-offset bias
│       ├── pcss.ts                          LIGHT   blocker search + contact-hardening filter GLSL
│       ├── contact-shadows.ts               LIGHT   screen-space march for the sub-0.5 m gap
│       ├── clustered.ts                     LIGHT   16×8×24 cluster assignment → index/data textures
│       ├── sh.ts                            LIGHT   sky → SH9 projection, directional ambient
│       ├── ibl.ts                           LIGHT   GGX prefilter of the sky cube + box-projected local probes
│       ├── gtao.ts                          LIGHT   pass: horizon search, bent normals, bilateral + temporal denoise
│       ├── ssr.ts                           LIGHT   pass: Hi-Z trace + roughness cone resolve + temporal filter
│       └── volumetrics.ts                   LIGHT   pass: froxel inject → scatter → integrate → composite
├── world/
│   ├── sky/                                 SKY     system, luts, atmosphere, clouds, cloud-shadow, aerial, env-probe, weather
│   ├── terrain/                             TERRAIN system, recipe, erosion, clipmap, splat, material, cliffs, collision, shore
│   ├── water/                               WATER   system, spectrum, ocean-mesh, material, foam, shoreline, underwater, buoyancy
│   └── vegetation/                          VEG     system, palm, shrub, succulent, grass, cards, wind, scatter, impostors
├── level/
│   ├── harbour-reach.ts                     LEVEL   LevelService impl, build orchestration
│   ├── layout.ts                            LEVEL   PURE DATA: point/spawn/building anchors. LANDS FIRST.
│   ├── kit/                                 LEVEL   wall, arch, roof, stair, window, balcony, railing, awning
│   ├── landmarks/                           LEVEL   market, cranes, fort, minaret, freighter, breakwater, depot
│   ├── dressing/                            LEVEL   crates, barrels, sandbags, wires, rubble, signage, vehicles, transitions
│   ├── colliders.ts                         LEVEL   StaticColliderDef emission + destructible tagging
│   ├── navmesh-bake.ts                      LEVEL   voxelise → region → contour → poly, in a worker
│   ├── cover-bake.ts                        LEVEL   CoverSlot extraction from collider silhouettes
│   └── cameras.ts                           LEVEL   named CameraRigPoses shared by every lane's shots
├── physics/
│   ├── system.ts                            PHYS    PhysicsService impl over rapier3d-compat
│   ├── world.ts                             PHYS    world init, fixed step, island management
│   ├── bodies.ts                            PHYS    BodyDesc → rapier, collider userData ↔ EntityId
│   ├── queries.ts                           PHYS    raycast/sphereCast/overlap/visibility, pooled RayHit
│   ├── character.ts                         PHYS    CharacterController: collide-and-slide only
│   ├── layers.ts                            PHYS    CollisionGroup mask translation
│   ├── ragdoll.ts                           PHYS    articulated death ragdolls, blend from pose
│   └── destruction/                         PHYS    system, chunks, holes, budget, settle-to-instanced
├── weapons/
│   ├── system.ts                            WEAPONS WeaponService impl + fire-control TickSystem
│   ├── defs/                                WEAPONS the frozen WeaponDef tables (one file per class)
│   ├── ballistics.ts                        WEAPONS pooled projectiles, drag + gravity, CCD sweeps
│   ├── penetration.ts                       WEAPONS energy loss vs SurfaceProfile, exit points, ricochet
│   ├── damage.ts                            WEAPONS damage curves, hit zones, DamageInfo emission
│   ├── viewmodel/                           WEAPONS rig, arms, anim (procedural reload/bolt/inspect)
│   └── models/                              WEAPONS procedural weapon geometry: receiver, barrel, optic, mag, furniture
├── vfx/
│   ├── system.ts                            VFX     VfxService impl, FxEventMap subscriptions, budget arbitration
│   ├── particles.ts                         VFX     GPU particle sim in an RGBA32F state pair
│   ├── emitters.ts / library.ts             VFX     EmitterDefs, VfxId → emitter graph
│   ├── decals.ts                            VFX     instanced box-projected decals against scene depth
│   ├── tracers.ts / muzzle.ts               VFX     ribbon tracers, whizby, flash card + LightingService.flash()
│   ├── explosions.ts                        VFX     fireball, shock ring, debris burst, heat haze
│   └── ambient.ts                           VFX     dust motes, pollen, sea spray, heat shimmer
├── audio/
│   ├── system.ts                            AUDIO   AudioService impl, voice pool, headless no-op safety
│   ├── graph.ts / spatial.ts / reverb.ts    AUDIO   bus topology, panner + occlusion, convolution IRs
│   ├── library.ts                           AUDIO   SoundId → synthesis recipe + variation policy
│   ├── dsp/                                 AUDIO   osc, noise, transient, body, tail, filters, impulse, granular
│   └── cues/                                AUDIO   weapons, world, ui
├── ai/
│   ├── system.ts                            AI      AiService impl, bot pool, LOD'd think rates
│   ├── nav.ts                               AI      NavService impl over LEVEL's NavmeshData
│   ├── pathfind.ts                          AI      A* + funnel string-pull, time-sliced
│   ├── perception.ts                        AI      vision cones, foliage attenuation, hearing, threat memory
│   ├── brain.ts / squad.ts / aim.ts         AI      utility scoring, orders, reaction latency + error cone
│   ├── intent.ts                            AI      brain goals → PlayerIntent (the same struct as the player)
│   ├── profiles.ts                          AI      BotProfile data per difficulty and class
│   └── character/                           AI      soldier mesh, rig, gear, clips, lod
├── ui/
│   ├── system.ts                            HUD     HudService impl
│   ├── renderer.ts                          HUD     in-canvas 2D layer: instanced quads, one draw per material
│   ├── font.ts                              HUD     SDF atlas baked from code-defined glyph outlines
│   ├── theme.ts                             HUD     type scale, colour ramp, opacity hierarchy
│   ├── widgets/                             HUD     crosshair, ammo, health, compass, capturebar, killfeed, hitmarker, minimap, damage
│   └── screens/                             HUD     spawn, scoreboard, deploy, endmatch
├── game/
│   ├── player.ts                            GAME    PlayerService impl: movement, stance, stamina, suppression
│   ├── conquest.ts                          GAME    GameMode impl: capture logic, ticket bleed, round flow
│   ├── spawn.ts                             GAME    spawn selection, safety test, deploy timing
│   ├── damage.ts                            GAME    damage resolution, hit registration, assists, scoring
│   └── director.ts                          GAME    bot count balancing, ambient combat pacing
└── shots/
    ├── index.ts                             CORE    import.meta.glob loader. WRITTEN DAY 0, FROZEN.
    └── <lane>.ts × 16                       each lane owns exactly one file named for its lane
```

### 2.1 The three named exports — the whole of a lane's wiring

Each `SubsystemDescriptor` in the frozen table is wired to **three named exports** of its lane's
entry file. All three exist as no-ops today; a lane fills in the bodies and ships.

```ts
export function create<Key>Service(ctx: BootContext): <Key>Service
export function register<Key>Bakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void
export function reset<Key>(seed: number): void
```

`<Key>` is the PascalCase of the `Services` key: `createVfxService` / `registerVfxBakes` /
`resetVfx`. **Do not rename, move or re-sign these three functions** — the frozen table imports
them by name and path. Everything else in the file, including the file's own internal structure and
any number of sibling files in your directory, is yours.

Why the last two are free functions rather than methods on the service:

- `register…Bakes` runs **after `assets` and before every other subsystem is constructed**. There is
  no instance yet, and there must not be: the scheduler has to see the whole cost total up front to
  apply `BakeProfile.unitCeiling` by degrading resolution instead of discovering it is over budget
  half way through. So bake declaration cannot happen inside `create`.
- `reset` must work whether or not `create` ever ran, and it must be reachable from the frozen table
  without the driver knowing your service's shape.

A lane that needs its instance inside either hook keeps it in a **module-scoped variable that
`create` assigns**, and tolerates `null`. `src/game/player.ts` is the worked example.

```ts
let instance: MyService | null = null;

export function createVfxService(ctx: BootContext): VfxService {
  instance = new IronVfx(ctx);          // ctx.addTick / ctx.addRender / ctx.assets / ctx.rng
  return instance;
}
export function registerVfxBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  assets.define({ /* … */ });           // declare only. NEVER bake in here.
}
export function resetVfx(seed: number): void {
  instance?.dropTransientState(seed);
}
```

**Every `create` receives the full `BootContext`.** A factory that ignores it cannot register a tick
or render system, cannot reach `ctx.assets` for its baked textures, cannot fork the RNG and cannot
add anything to the scene — i.e. it cannot do its job. There is no such thing as a lane that
legitimately takes no context. The one narrow exception is `assets` itself, which is constructed
first and therefore sees `ctx.assets` undefined; nothing else in the table has that exception.

### 2.2 Register render passes in `afterBoot`, never in your factory body

`dependsOn` declares **construction-time** dependencies only — services your factory reads *while it
is running*. It cannot describe "my render pass will read `SceneDepth` in nine months", and
`subsystems.ts` is frozen, so five descriptors (`sky`, `lighting`, `water`, `vfx`, `hud`) register
passes without declaring an edge to `graph`. Today that happens to work because `graph` declares no
dependencies and leads the table. **Do not rely on it.** A topological sort only guarantees declared
edges, and if the tie-break ever changes, `ctx.services.graph` is the NULL graph: `addPass` returns
normally, your passes never run, nothing throws, and the shot is black.

Deferring `addPass` to your first `update()` is the other wrong answer — `RenderGraph.validate()`
has already run, so a pass that reads a resource nobody writes is no longer caught at boot.

`BootContext.afterBoot(fn)` is the seam. CORE runs every callback after the last subsystem is
constructed and before `validate()`, in construction order:

```ts
export function createWaterService(ctx: BootContext): WaterService {
  const water = new IronWater(ctx);
  ctx.afterBoot((s) => {
    s.graph.addPass(new SceneColorCopyPass(water));   // ForwardWater, subOrder -10
    s.graph.addPass(new ForwardWaterPass(water));     // ForwardWater, subOrder 0
  });
  return water;
}
```

The same hook is the answer whenever a factory wants a service its `dependsOn` cannot name — WATER
reading `sky` for the wind direction that seeds its spectrum, for instance. `ctx.assets.define(...)`
does **not** need it: `assets` is constructed before every content lane by rule, not by luck.

---

## 3. Frame lifecycle

### 3.1 The loop

```
requestAnimationFrame(t)
  frameDt = min(t - tPrev, Sim.MAX_FRAME_DT)
  accumulatorMicros += round(frameDt * 1e6)          ← integer µs; float accumulation drifts

  ticks = 0
  while accumulatorMicros >= TICK_MICROS and ticks < Sim.MAX_CATCHUP_TICKS:
      runTick()                                       ← TickPhase 0 … 1000
      accumulatorMicros -= TICK_MICROS
      ticks++
  if ticks == Sim.MAX_CATCHUP_TICKS: accumulatorMicros = 0    ← drop time, never spiral

  alpha = accumulatorMicros / TICK_MICROS
  runFrame(alpha)                                     ← RenderStage 0 … 500
```

`runTick()` dispatches every registered `TickSystem` in ascending `TickPhase` then `order`.
`runFrame()` dispatches every `RenderSystem` in ascending `RenderStage` then `order`, ending with
`RenderGraph.execute()` in `RenderStage.Submit`.

Two systems in the same phase **must be order-independent of each other**. That rule is what lets
sixteen agents write updaters without negotiating.

### 3.2 What runs where

| Phase | Lane | What |
|---|---|---|
| `TickPhase.Input` | CORE | drain device deltas into the raw input accumulator |
| `TickPhase.Intent` | **GAME, exclusively** | one system: walk `PlayerService.controlled` and call `source.sample(entity, ctx, out)` per entity — human source from `InputService.source`, bot source from `AiService.intentSource`. See §3.4. |
| `TickPhase.Ai` | AI | perception (round-robin budget), utility scoring, path selection, aim solve |
| `TickPhase.Movement` | **GAME, exclusively** | intent → accel/friction/air control → `CharacterController.move()`, per controlled entity |
| `TickPhase.PrePhysics` | PHYS | kinematic targets, applied impulses |
| `TickPhase.Physics` | PHYS | **the one and only** `rapier.world.step()`, at exactly `Sim.TICK_DT` |
| `TickPhase.PostPhysics` | PHYS | dynamic transform readback, contact drain |
| `TickPhase.Weapons` | WEAPONS | state machines, trigger, reload, `aimPunch` spring integration |
| `TickPhase.Ballistics` | WEAPONS | projectile integration + swept CCD (runs after weapons so a shot flies the same tick) |
| `TickPhase.Damage` | GAME | damage resolution, hit registration, kill/assist attribution |
| `TickPhase.Destruction` | PHYS | chunk release, debris budget, settle-to-instanced |
| `TickPhase.Mode` | GAME | capture progress, ticket bleed, spawn logic, scoring |
| `TickPhase.Cleanup` | CORE | deferred entity destruction, pool recycling, `SimBus.flush()` |

| Stage | Lane | What |
|---|---|---|
| `RenderStage.Sample` | VFX / AUDIO / HUD | `FxBus.flush()` — one drain, three consumers, zero coupling |
| `RenderStage.Camera` | RCORE | `CameraRig.update()` — eye lerp by `alpha`, aimPunch, cameraKick, sway, bob, lean, trauma, ADS FOV, TAA jitter |
| `RenderStage.Animation` | WEAPONS / AI / VEG / WATER | viewmodel rig, skinning, ragdoll blend, wind phase, Gerstner displacement — **everything that moves a vertex** |
| `RenderStage.Presentation` | VFX / HUD | particle sim, decal aging, tracer advance, HUD layout |
| `RenderStage.Scene` | CORE / TERRAIN / VEG | terrain LOD, instance upload, culling, previous-matrix capture |
| `RenderStage.Submit` | RCORE | `RenderGraph.execute()` |

### 3.3 Interpolation

Simulation writes `TransformComponent.curr`; the render side reads
`lerp(prev, curr, FrameCtx.alpha)`. Simulation code never reads `alpha`, `frameDt` or the camera.
Presentation code never touches `SimBus` — it only sees the write-only `FxEmitter` in reverse, via
`FxBus`. That one-way seam is what keeps captures deterministic.

Under the harness, `dt = 1/60` exactly, so one tick runs per `stepFrame()` and `alpha` is 0 on every
frame. Interpolation is a no-op during capture, by design.

### 3.4 Per-entity intent dispatch — GAME owns it, and nobody else touches it

Decision #6 says bots emit `PlayerIntent` and drive the same controller as the player. This is where
that stops being a slogan. **`PlayerService` is a per-entity controller table, not a singleton**, and
**GAME owns the dispatch**. The rules, in order of how often they get broken:

1. **Only GAME registers a `TickSystem` at `TickPhase.Intent` or `TickPhase.Movement`.** Exactly two
   systems live there, both from `src/game/player.ts`. Any other lane registering in those phases is
   a defect, not a design choice.
2. **AI never calls `sample()` on its own `intentSource`.** It exposes one source for all its bots;
   `sample(entity, …)` switches on the entity it is handed. GAME calls it, once per bot per tick, at
   `TickPhase.Intent`, walking `PlayerService.controlled` in stable attach order.
3. **AI attaches its bots.** Inside `AiService.spawnBot`, after allocating the entity:
   `services.player.attachController(entity, team, this.intentSource)`. A bot that is not attached is
   never sampled and never moves — and that failure is silent, which is why it is written here.
   `AiService` therefore declares `dependsOn: ['nav', 'level', 'player']`.
4. **Everything per-entity goes through `stateOf` / `intentOf`.** `PlayerService.state` is a
   convenience for the local player and nothing else. WEAPONS reads trigger bits with
   `intentOf(entity)`; HUD reads lean; damage and scoring read `stateOf(entity)`.
5. **AI's own thinking stays at `TickPhase.Ai`**, which runs *after* Intent and *before* Movement, so
   a brain reads last tick's world and writes only into the intent it is handed next tick.

```
Input(CORE)  →  Intent(GAME)                         →  Ai(AI)        →  Movement(GAME)
                for e of player.controlled:              perception,      for e of player.controlled:
                  sourceOf(e).sample(e, ctx, intent[e])  scoring,           intent[e] → CharacterController.move(e)
                    human → InputService.source          aim solve
                    bot   → AiService.intentSource
```

---

## 4. Render graph

Forward+ with an MRT depth prepass. All scales are fractions of the **internal** render resolution
(canvas × `renderScale`); absolute sizes are marked. Timings are the Ultra 1080p budget on a
discrete GPU (RTX 3060 / M2 Pro class). Formats use `RTFormat`; resource names use `RTId`; pass slots
use `PassOrder`. Both enums live in `types.ts`.

```
##  PASS (PassOrder)              WRITES → format                    scale     READS                              ms
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
BOOT / DIRTY-FLAG (not per frame; SKY re-runs 1–2 only when the sun moves >0.15° or weather changes)

B1  sky.transmittance  SkyLuts    SkyTransmittance   RGBA16F         256×64    —                                 0.02
B2  sky.multiScatter   SkyLuts    SkyMultiScatter    RGBA16F         32×32     B1                                0.02
B3  brdfLut            (bake)     —                  RG16F           256×256   —                                 —
B4  blueNoise          (bake)     —                  R8 3D            128²×64  —  void-and-cluster, spatiotemporal —
B5  gradeLut           (bake)     —                  RGBA16F 3D       32³      —                                 —
B6  env cube + PMREM   SkyLuts    (LightingService.environment)      128² cube B1,B2,clouds                      0.35
B7  irradiance SH9     SkyLuts    (LightingService.ambientSH)        27 floats B6 mip4                           0.05

PER FRAME

 1  sky.view           SkyLuts    SkyView            RGBA16F        192×108    B1,B2                             0.06
 2  sky.aerial         SkyLuts    AerialPerspective  RGBA16F 3D     32×32×32   B1,B2  0–32 km non-linear Z        0.10
 3  sky.cloudShadow    SkyLuts    CloudShadow        R8             512²       cloud volume                      0.05
 4  shadow.cascades    ShadowCascades  ShadowAtlas   Depth32F       4096²      scene geometry                    1.80
      4 tiles of 2048², splits 0–12–38–110–300 m, cadence [1,1,2,4] (distant cascades
      amortised with a stability epsilon), ortho snapped to a WORLD-SPACE texel grid.
 4b shadow.foliage     ShadowCascades  ShadowFoliage R8             2048²      vegetation alpha, cascades 0–1     0.25
 5  depth.prepass      DepthPrepass  SceneDepth      Depth32F(tex)  1.0        —                                 0.70
                                    GNormalRough     RGB10A2        1.0        (oct normal RG10, rough B10, class A2)
                                    GVelocity        RG16F          1.0        (NDC units/frame, jitter removed)
      One override material per registered deform chunk, so wind / skinning / recoil
      velocity is exact. THE VELOCITY BUFFER IS BORN HERE AND EVERYTHING TEMPORAL EATS IT.
 6  depth.hiz          HiZBuild   HiZ                R32F, 8 mips   1.0        SceneDepth                        0.25
 7  gtao               Gtao       Gtao               R8             0.5        SceneDepth,GNormalRough,HiZ,B4    0.90
                                  GtaoBentNormal     RGB10A2        0.5
      4 slices × 8 steps, 2-pass bilateral + temporal reprojection through GVelocity.
 8  light.clusters     LightClusters  ClusterIndex   RGBA8          16×8×24    (CPU assignment)                  0.05
                                     ClusterData     RGBA32F        128×8
      CPU-side. WebGL2 has no compute, and a few hundred lights in JS is ~0.2 ms —
      which is what makes muzzle flashes free instead of a program recompile.
 9  volume.froxel      Volumetrics  VolumeScatter    RGBA16F 3D     160×90×64  ShadowAtlas,SkyView,CloudShadow,  1.10
                                                                               clusters, previous scatter
      inject → scatter → integrate, temporally reprojected with a Halton Z jitter.
10  forward.opaque     ForwardOpaque  SceneColor     hdrFormat      1.0        ShadowAtlas,ShadowFoliage,Gtao,   4.20
                                                                               GtaoBentNormal,VolumeScatter,
                                                                               AerialPerspective,clusters,env,SH
      LEQUAL, depthWrite OFF (early-Z from pass 5). Terrain clipmap, level batches,
      vegetation, characters, impostors (Bayer-dithered LOD fade that TAA resolves).
      Aerial perspective is applied IN-SHADER, not as a screen-space pass, so
      transparents, water and particles receive it consistently.
11  forward.decals     Decals     SceneColor (blend) hdrFormat      1.0        SceneDepth,GNormalRough           0.35
      Box-projected, normal-reoriented, angle-faded. Includes the GroundTransition
      rings that kill the hard seam where geometry meets ground.
12  sky.render         SkyRender  SceneColor         hdrFormat      1.0        SkyView,CloudLayer,SceneDepth     0.20
13  ssr                Ssr        SsrColor           RGBA16F        0.5        HiZ,GNormalRough,SceneColor,env   0.90
      Hi-Z march, blue-noise jittered, temporal history. Composited by LERPing OVER the
      IBL specular by confidence — never added, or the frame double-counts energy.
14  forward.water      ForwardWater  SceneColor      hdrFormat      1.0        SceneColorCopy,SceneDepth,        0.55
                                     GVelocity       RG16F          1.0        SsrColor,ShadowAtlas,shoreMask
      MRT: water WRITES VELOCITY as well as colour, through
      `graph.mrtTarget([RTId.SceneColor, RTId.GVelocity])` — one draw, two
      attachments. Gerstner displacement genuinely moves the surface; without
      motion vectors TAA smears the golden-hour highlights.
      `SceneColorCopy` IS DECLARED BY RCORE alongside `SceneColor`, and BLITTED BY
      WATER in a `PassOrder.ForwardWater` pass at `subOrder: -10`. Naming the
      owner matters: if both lanes declare it the second `declare()` is a no-op
      only while the descs match, and if neither blits it, `validate()` throws at
      boot with water reading a resource nobody wrote.
15  volume.composite   VolumetricComposite  SceneColor              1.0        VolumeScatter,SceneDepth          0.20
      Depth-aware upsample so fog respects water and transparents drawn so far.
16  forward.transparent ForwardTransparent  SceneColor              1.0        SceneDepth,VolumeScatter,clusters 1.00
      Sorted back-to-front, soft depth fade, half-res smoke composited up.
17  forward.viewmodel  Viewmodel  SceneColor + GVelocity            1.0        ShadowAtlas,env,SH                0.50
      Its OWN camera (near 0.01 / far 6) with the depth range remapped, so the weapon
      can never clip a wall and never eats world depth precision. Velocity comes from
      the VIEWMODEL's own previous transform, not the camera's, or TAA smears the gun
      every time you turn.
18  motion.dilate      VelocityDilate  VelocityTiles RG16F          1/20       GVelocity                         0.15
19  taa.resolve        TaaResolve  TaaHistory        RGBA16F        1.0        SceneColor,GVelocity,SceneDepth,  0.55
                                   ResolvedColor     hdrFormat      1.0        previous TaaHistory
      8-sample Halton(2,3); 3×3 velocity dilation by closest depth; YCoCg variance
      clipping; Catmull-Rom history fetch; tonemapped-weight blend to kill fireflies.
      History is RGBA16F even when hdrFormat is R11G11B10F — the feedback loop
      accumulates the 10-bit blue channel's error into a visible cast over ~30 frames.
      Viewmodel pixels get a tighter clamp so recoil does not ghost.
20  vfx.postResolve    PostResolveVfx  ResolvedColor                1.0        —                                 0.20
      Tracers, sparks, muzzle-flash cards, lens glints. AFTER TAA so they stay razor
      sharp, BEFORE bloom so they bloom. The flash's effect on the WORLD is a
      clustered light back in pass 10.
21  post.motionblur    MotionBlur  ResolvedColor     hdrFormat      1.0        VelocityTiles,SceneDepth,B4       0.35
      Before bloom: physically the shutter integrates motion first and the lens
      scatters that integrated light second. Blurring after bloom reads as a filter.
22  post.exposure      Exposure   Exposure           R32F           1×1        ResolvedColor log-luma mips       0.05
      Centre-weighted log-average (no compute → no true histogram; honest limitation),
      0.8 s adaptation. **FROZEN to a locked EV whenever FrameCtx.deterministic.**
23  post.bloom         Bloom      BloomPyramid       hdrFormat   0.5 → 1/64    ResolvedColor,Exposure            0.45
      Threshold is a soft knee in EV RELATIVE TO EXPOSURE, so only genuinely bright
      things bloom regardless of scene luminance. Mip 0 uses a Karis-averaged 13-tap.
24  post.dof           DepthOfField  DofResult       RGBA16F        0.5        ResolvedColor,SceneDepth,Exposure 0.40
      CoC from a physical aperture. High/Ultra, and only while adsBlend > 0.
25  post.tonemap       Tonemap    LdrColor           RGBA8_SRGB     1.0        Resolved/Dof,BloomPyramid,        0.20
                                                                               Exposure,gradeLut
      AgX, not the ACES RRT: ACES pushes this brief's warm sandstone/ochre palette
      straight into orange hue-clipping at the top of the range, which is exactly the
      "everything is orange" tell. Also resolves renderScale → canvas resolution.
26  post.lens          LensFx     LdrColor (in place) RGBA8_SRGB    1.0        LdrColor                          0.10
      Vignette, lateral chromatic aberration (≤1.2 px at the corner), luma-only film
      grain scaled by inverse luminance, ordered dither to 8 bits, CAS sharpen.
27  ui.hud             Hud        LdrColor           RGBA8_SRGB   NATIVE res   SDF atlas, HUD state              0.15
      Orthographic, at native canvas resolution — never renderScale. Never tonemapped,
      never graded, never bloomed, never TAA'd.
28  present            Present    default framebuffer              native      LdrColor                          0.05
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
GPU total @ Ultra 1080p ≈ 14.4 ms (2.2 ms headroom in the 16.6 ms budget).
CPU: sim 1.6 (physics 0.80, AI 0.35, gameplay+VFX 0.45) + cull 0.35 + submit 2.60 ≈ 4.6 ms, overlapped.
```

Two `PassOrder` slots in that table are not RCORE's and are called out here so nobody has to squat
in a neighbour's:

| Slot | Registered by | What |
|---|---|---|
| `Simulate` = 420 | any lane | GPU simulation between the prepass and forward opaque: particle state advance, ribbon integration. Reads `SceneDepth`, and its result is drawable the same frame. |
| `PostResolveVfx` = 730 | **VFX**, not RCORE | tracers, sparks, muzzle-flash cards, lens glints (pass 20). `src/render/passes/**` is RCORE's directory and contains no vfx pass; the pass lives in `src/vfx/`. |
| `Underwater` = 745 | **WATER** | absorption, murk and surface-line distortion on the resolved HDR image, so it is exposed, bloomed and tonemapped like everything else rather than painted on after the grade. |

### Which pass draws which `RenderLayer`

`drawLayer` is the only way scene geometry reaches the screen, so exactly one pass may draw each
layer or every object in it is submitted twice — double vertex cost, double alpha, and a "why is my
smoke twice as dense" bug that is invisible in a diff.

| `RenderLayer` | Drawn by | Pass |
|---|---|---|
| `WorldOpaque`, `WorldAlphaTest`, `Vegetation`, `Impostor` | RCORE | 5 (prepass, override material), 10 (forward.opaque), 4 (shadows) |
| `Water` | WATER | 14 (forward.water) — and by RCORE's prepass only for depth |
| `Decals` | VFX | 11 (forward.decals) |
| `TransparentPreTaa` | RCORE | 16 (forward.transparent), sorted back-to-front |
| `TransparentPostTaa` | VFX | 20 (vfx.postResolve) |
| `Viewmodel` | RCORE | 17, through the viewmodel camera |
| `ShadowOnly` | LIGHT | 4 only |
| `Hud`, `Debug` | HUD / CORE | **not** via `drawLayer` — `drawScene` with a lane-owned ortho camera |

A lane that puts a mesh on `TransparentPreTaa` therefore does **not** register its own draw pass:
RCORE's pass 16 already draws that layer. Register a pass only for a layer this table leaves to you.

### 4.1 Where velocity comes from, in one place

| Geometry | Pass | Source |
|---|---|---|
| static opaque | 5 | `prevViewProjection` (camera motion only) |
| moving / skinned | 5 | the deform chunk's `IRON_PREV_POSITION` + previous instance matrix |
| vegetation | 5 | the previous frame's wind-field phase, latched once per frame |
| viewmodel | 17 | the viewmodel rig's own previous transform, through its own camera |
| water | 14 | the previous frame's Gerstner displacement |
| sky | 5/12 | camera rotation only (translation removed, infinite depth) |
| pre-TAA VFX | — | none; TAA widens its neighbourhood clamp inside the heavy-VFX stencil |
| post-TAA VFX | — | none; drawn after the resolve, and motion blur's tile-max from opaque is correct because they are additive |

### 4.2 Rules the graph enforces

- **`RenderGraph` is the only code that may call `renderer.setRenderTarget`, set scissor state, or
  touch `autoClear`.** A lane that needs a custom pass registers a `RenderPass`; it never renders
  inside its own `update()`. CI greps for `setRenderTarget` outside `src/render/`. Calling
  `renderer.render()` from inside your `execute()` is the same violation with a different spelling —
  it just happens to slip past the grep. Use `drawLayer` for world geometry, `drawScene` for a
  lane-owned tree with a lane-owned camera (HUD, gizmos), `fullscreen` for a shader pass.
- **Every `THREE.Material` in the repo comes from `MaterialFactory`.** World surfaces go through
  `create()`; UNLIT non-scene materials — HUD text and quads, debug gizmos, the sky dome, raw
  overlays — go through `createUnlit()`. CI now fails on `new THREE.ShaderMaterial` and
  `new THREE.RawShaderMaterial` outside `src/render/` as well as on `Mesh*Material`, because the
  doctrine and the enforcement disagreeing is how twelve lanes each pick a different answer and find
  out at integration. A lane needing lane-authored GLSL on a LIT surface uses `registerDeform`
  (vertex) or `registerSurface` (fragment), which keep CSM, clustered lights, GTAO and aerial
  perspective; a hand-rolled ShaderMaterial silently loses all four.
- **The graph swaps every `RTHistory` once per frame, after the last pass.** A pass reads
  `previous`, writes `current`, and never swaps anything itself. If each owner swapped, a resource
  read by two passes would flip mid-frame; if the owner forgot, its simulation would freeze with no
  error.
- **`RenderGraph.validate()` runs at boot and throws** if an enabled pass reads a resource no
  earlier enabled pass wrote — so disabling volumetrics on Low cannot silently produce a black
  composite.
- **`scene.sortObjects = false`.** The graph submits in a precomputed material order, saving ~0.4 ms
  of CPU sort per frame.
- **Boot must call `renderer.getContext().getExtension('EXT_color_buffer_float')` before the graph
  allocates anything.** three only requests it for the R16F/RG16F/RGBA16F paths, *not* for
  R11G11B10F — without the explicit call, every HDR target on Low silently comes back
  framebuffer-incomplete. One line; a lost day if nobody knows.

---

## 5. Quality tiers

`QualityService` owns the four tables in `src/engine/quality.ts`. **No lane raises its own budget.**
Twelve agents each raising theirs is how you get a 40 ms frame with no single culprit.

|  | LOW | MEDIUM | HIGH | ULTRA |
|---|---|---|---|---|
| base res | 1280×720 | 1920×1080 | 1920×1080 | 1920×1080 |
| renderScale | 0.70–1.00 | 0.75–1.00 | 0.85–1.00 | 1.00 |
| AA | FXAA | TAA ×4 | TAA ×8 | TAA ×8 + CAS |
| hdrFormat | R11G11B10F | RGBA16F | RGBA16F | RGBA16F |
| cascades | 2 × 1024 | 3 × 1024 | 4 × [2048,1536,1024,1024] | 4 × 2048 |
| shadow atlas | 2048² | 3072² | 3072² | 4096² |
| shadow dist | 90 m | 140 m | 220 m | 300 m |
| PCSS | 4 taps (PCF) | 8 | 12 | 16 + contact shadows |
| GTAO | off (vertex AO) | half, 2×4, no bent | half, 3×6, bent | half, 4×8, bent |
| SSR | off (env only) | off | half, 24 steps | half, 48 steps |
| volumetrics | off (height fog) | 96×54×32 | 128×72×48 | 160×90×64 |
| bloom levels | 4 | 5 | 6 | 6 |
| motion blur | off | 6 | 8 | 12 |
| DOF | off | off | ADS only | ADS + cinematic |
| grass | 22 m / 14 k | 40 m / 45 k | 55 m / 90 k | 70 m / 140 k |
| particles | 1 200 unlit | 3 000 soft | 6 000 soft+lit | 12 000 soft+lit+shadow |
| decals | 256 | 768 | 2 048 | 4 096 |
| debris chunks | 64 | 128 | 256 | 512 |
| bots | 10 | 16 | 20 | 24 |
| draw ceiling | 160 | 250 | 360 | 480 |
| tri ceiling | 1.6 M | 2.8 M | 4.2 M | 5.6 M |
| texture cap | 112 MB | 192 MB | 320 MB | 512 MB |
| RT cap | 45 MB | 95 MB | 150 MB | 200 MB |
| program cap | 24 | 32 | 40 | 40 |
| bake profile | compact | standard | standard | full |
| target | 16.6 ms @720p | 16.6 @1080p | 16.6 @1080p | 16.6 @1080p |

**VRAM at Ultra 1080p ≈ 580 MB**: render targets 195 (shadow atlas 67, scene + TAA×2 50, prepass
25, Hi-Z 11, froxels 24, GTAO+SSR 12, bloom 6), material arrays 66, hero materials 134, impostor
atlases 67, particle/decal atlases 67, terrain 28, water 4, PMREM 8, weapon+character 11.
`RenderGraph.renderTargetBytes` must be validated against `BudgetLimits.renderTargetBytes` at boot —
a tab that exceeds the GPU process budget gets context-lost, not a slow frame.

**Dynamic resolution** is governed by `EXT_disjoint_timer_query_webgl2` (falling back to a CPU frame
EMA), adjusts `renderScale` in 0.05 steps at most once per 30 frames within a 14.5–17.5 ms
hysteresis band, and is **hard-disabled whenever `FrameCtx.deterministic` is true**.

---

## 6. The procedural bake pipeline

Every byte of art in this game is generated at load. There are two devices:

- **`GpuBakeDevice`** — anything that ends up as a texture. Fullscreen procedural fragment shaders,
  MRT bakes, ping-pong `iterate()` for erosion and flow, layer writes into `DataArrayTexture` /
  `Data3DTexture`, and octahedral impostor rendering.
- **`WorkerPool`** — anything that ends up as a typed array: meshes, navmesh, audio PCM. Uses
  **transferable `ArrayBuffer`s, not `SharedArrayBuffer`**, because the vite dev server does not set
  COOP/COEP by default and we will not make the bake depend on headers only the capture server
  sends. **`run()` must fall back to inline main-thread execution** when `workerCount` is 0 or
  worker construction fails — no lane may be blocked on workers existing.

### 6.1 Phases and cost

Steps are declared through `AssetRegistry.define()` and resolved in topological order over
`dependsOn`. GPU steps serialise (one GL context); worker steps saturate the pool; the two overlap.

| # | Step | Device | Cost (units, `full`) |
|---|---|---|---|
| 1 | noise basis volumes | GPU | 4 |
| 2 | material arrays: 24 bulk + 12 hero layers | GPU | 480 |
| 3 | terrain heightfield: fBm → 64 hydraulic erosion iterations, 2048² R32F ping-pong, one readback for physics | GPU | 220 |
| 4 | terrain splat / curvature / AO / macro break-up | GPU | 60 |
| 5 | sky LUTs + 128×128×32 cloud volume | GPU | 40 |
| 6 | water spectrum → 4 × 256² displacement + normal | worker (FFT) | 120 |
| 7 | building / prop / landmark meshes, 8 parallel jobs | worker | 300 |
| 8 | vegetation meshes + octahedral impostor atlases | both | 180 |
| 9 | weapon meshes + attachments | worker | 90 |
| 10 | soldier mesh, rig, animation clips | worker | 130 |
| 11 | decal + particle atlases | GPU | 50 |
| 12 | navmesh voxelise / region / contour + cover slots | worker | 110 |
| 13 | audio: ~60 cues + 3 impulse responses, pure DSP | worker | 160 |
| 14 | SDF font atlas from code-defined outlines | GPU | 30 |
| 15 | shader prewarm — compile every permutation | main | 90 |
| 16 | rapier collider construction | main | 70 |
| | **total** | | **2 134** |

When Σcost exceeds `BakeProfile.unitCeiling` the scheduler **halves `grantedTexelSize` on the
lowest-priority steps** rather than dropping any. A missing material is a defect; a 256² material is
merely softer.

### 6.2 Readiness protocol

```
main.ts
  setStatus('probing gpu')       → caps.probe()
  setStatus('bake: <phase> 43%') → assets.bakeAll(p => setStatus(`bake: ${p.phase} ${p.fraction}`))
  setStatus('building level')    → level.build(), physics colliders, nav bake
  setStatus('prewarming shaders')→ materials.prewarm()
  attachDriver(engine.driver)
  markReady()
```

`tools/capture.mjs` hard-fails at 300 s waiting for `ready`. Under SwiftShader the GPU bakes are
20–60× slower, so **`caps.isSoftware` forces `BakeProfile` down to `standard` while keeping the
render tier at High/Ultra** — shots stay beautiful, they just bake coarser. Expected cold bake:
~12 s discrete GPU (`full`), ~5 s iGPU (`compact`), ~70–110 s under SwiftShader (`standard`).

Every step calls `ctx.progress()` and must `await ctx.yieldFrame()` between expensive units, so a
blown budget shows up in the capture log as `bake: material arrays 61%` instead of a silent timeout.

**Caching** is IndexedDB keyed by `hash(id, version, params, profile)`. Playwright uses a fresh
profile per run, so **captures always cold-bake** — the capture path, not the dev path, is what
sizes the budget.

### 6.3 Two bake-time rules that are not optional

1. **Toksvig roughness mipping.** Whenever a normal map is baked, fold its per-mip normal variance
   into the matching roughness mip (`MipMode.RoughnessToksvig`). The brief demands high-frequency
   micro-detail everywhere; without this, distant metal, glass and stucco sparkle, TAA either smears
   or boils it, and no resolve-time tuning fixes it. This is a bake-time problem with a bake-time
   solution.
2. **CPU/GPU noise parity.** `TerrainService.heightAt` must be *literally* the function the terrain
   vertex shader displaces with. Both come from `NoiseLib`, which ships matched CPU and GLSL
   implementations over one permutation table. Any shader displacement finer than the physics
   collider cell must be **normal-only** — position offsets finer than the collider make players
   float over bumps and sink into dips.

---

## 7. Threading and workers

- **Main thread**: the entire game loop, all GL, all of rapier. There is one WebGL context and one
  physics world; neither is transferable.
- **Worker pool** (`min(hardwareConcurrency - 1, 4)`, 0 under a constrained profile): bake-time CPU
  jobs only — mesh generation, LOD decimation, water FFT, navmesh voxelisation, audio DSP. Payloads
  are transferable `ArrayBuffer`s.
- **No worker runs during gameplay.** Nothing in the frame loop is allowed to await a worker; the
  latency and the nondeterminism are both unacceptable for a deterministic capture.
- **`OfflineAudioContext`** is used at bake time for all audio synthesis, so it works headless with
  no user gesture. The live `AudioContext` is created lazily on first unlock and every
  `AudioService` method is a **safe no-op while `unlocked` is false**.

---

## 8. Where the harness plugs in

`src/engine/harness.ts` is **locked**. CORE implements everything it calls, in
`src/engine/driver.ts`.

```
main.ts ── attachDriver({ context, stepFrame, setLoopSuspended, flush })
                │
                ├─ stepFrame(dt)          → one tick at exactly dt + one full render frame
                ├─ setLoopSuspended(v)    → parks the rAF loop
                ├─ flush()                → gl.finish() + one rAF
                └─ context: ShotContext
                     ├─ setTimeOfDay      → SkyService.setTimeOfDay
                     ├─ setWeather        → SkyService.setWeather
                     ├─ poseCamera        → CameraRig.poseAbsolute + setPoseLocked(true)
                     ├─ setOverlays       → RenderService.overlays
                     ├─ setPlayerState    → PlayerService.setForcedState + ViewmodelRig.forcePose
                     └─ seed              → THE RESET CHAIN, below
```

### 8.1 The reset chain — read this before you add persistent state

The locked harness resets the seed, overlays and player state before every capture. **It does not
know about your lane.** Persistent decals, debris, destroyed walls, TAA history, exposure
adaptation, bot positions and particle pools all leak from one capture into the next, which makes
shot results depend on capture *order* and sends the visual critics chasing ghosts.

`ShotContext.seed(n)` therefore runs, in this order:

```
rng.reseed(n)                       services.destruction.reset()
graph.resetHistories()              services.vfx.clearTransient()
(CORE clears its own tick counter    services.ballistics.clear()
 and re-enters deterministic mode)   services.ai.despawnAll()
                                    services.mode.reset(n)
                                    → then every SubsystemDescriptor.reset?(n), in boot order
```

**If your lane holds transient state, fill in the body of `reset<Key>(seed)` in your entry file.**
It is already exported as a no-op and already wired into the frozen descriptor table (§2.1) — you do
not add a hook, you fill one in, which is the whole reason it was wired on day 0. This is not
optional and it is not something the integration pass can retrofit for you. The acceptance test is:
capture every shot twice in different orders and diff the PNGs. Identical bytes, or the reset chain
is incomplete.

`reset<Key>` is a free function, so reach your instance through the module-scoped variable your
`create<Key>Service` assigned, and tolerate `null` — the hook can fire before construction:

```ts
export function resetVfx(_seed: number): void {
  instance?.clearPools();
}
```

Note that five services are *also* reset explicitly by name earlier in the chain
(`destruction`, `vfx`, `ballistics`, `ai`, `mode`). That covers what their contract methods promise
and no more; your `reset<Key>` still owns everything those methods do not name.

**Three things the reset chain already handles, so do not re-implement them:**

1. **`rng.fork(label)` IS rewound.** Forks are memoised per label and `reseed()` propagates into
   every child recursively, so a fork taken in a constructor is deterministically re-derived when
   the chain reseeds the root. What is *not* rewound is anything you copied out of a fork and
   cached — a jitter table built once at construction keeps last capture's numbers. Rebuild it in
   `reset<Key>`, or draw it fresh each frame.
2. **Every `RTHistory` is cleared** by `graph.resetHistories()`, and comes back with `valid: false`
   for one frame. That is your signal to re-seed simulation state, not an error.
3. **`ShotContext` cannot reach a service.** It exposes `setTimeOfDay`, `setWeather`, `poseCamera`,
   `setOverlays`, `setPlayerState` and `seed`, and nothing else. `AiService.forceState`,
   `HudService.forceState` and `GameMode.forceState` are therefore called by their own lane's shot
   file through a lane-private export, not by the harness. Camera poses in a shot file are literal
   coordinates; importing `@/level/**` for a named pose breaks boundary CI.

### 8.2 Shots

Every lane registers at least one shot in `src/shots/<lane>.ts` — see `docs/OWNERSHIP.md` for the
assignment. `src/shots/index.ts` picks them up by glob; **no lane ever edits a shared registry.**

Shot files must be **trivially thin**: pose the camera, force state, return. No module-level side
effects, no top-level throws, no imports outside your lane. A single shot file with a compile error
breaks the capture tool for all sixteen lanes simultaneously.

Auto-exposure is a temporal feedback loop and a shot is 32 frames, so a capture would otherwise land
at a different EV than a live session that has adapted for seconds. `post.exposure` therefore reads
a **locked EV whenever `deterministic` is true**. Any lane that adds another temporal feedback loop
— SSR, GTAO, clouds, volumetrics — inherits the same obligation: converge inside the shot's frame
count, or declare a higher `frames` on your `ShotSpec`.

---

## 9. Determinism — the non-negotiables

Reproducible screenshots are the review loop. Every one of these is a build-breaking defect:

1. `Math.random()` anywhere in `src/`. Use `Rng` and `rng.fork(label)` for a named sub-stream, so a
   lane that adds a draw cannot shift another lane's sequence.
2. Iterating a `Map` or `Set` keyed by object identity in gameplay code. Use `ComponentStore.each`,
   which iterates dense in stable creation order.
3. Reading `performance.now()` or `Date.now()` in gameplay. Use `Clock.simTime`, derived from the
   tick count.
4. Float time accumulation. The accumulator is integer microseconds.
5. Spawning rapier bodies in non-deterministic order. Rapier's f32 solver is deterministic for
   identical *input sequences* but not across differing body-insertion order; every spawn/despawn
   must be driven by a stable integer key and a deterministic sort.
6. Any dynamic resolution, adaptive quality or wall-clock-dependent logic while
   `FrameCtx.deterministic` is true.

---

## 10. Sequencing

**Wave 0 — CORE alone, blocking, nothing else starts.** `src/engine/types.ts` (done),
`bootstrap/subsystems.ts`, `bootstrap/nulls.ts` with a null for every service, a stub entry file for
each lane exporting the null **plus its `register…Bakes` and `reset…` no-ops** (§2.1),
`shots/index.ts` plus a trivial-but-valid `shots/<lane>.ts` for all 16,
`macro.ts`, and the CORE runtime: engine, loop, driver, services, clock, rng, events, entities,
quality, caps, profiler, input, scenegraph, culling, batching, math. Exit criterion:
`npm run verify` green and `./tools/shoot.sh core` produces a PNG. **Done — and
`bootstrap/subsystems.ts` is frozen as of that commit.**

**Wave 1a — two short unblocking commits, in parallel.** (i) BAKE lands `gpu-device.ts`,
`worker-pool.ts`, `noise.ts` and `registry.ts` so any lane can call `ctx.gpu.render()`. (ii) RCORE
lands `material/factory.ts`, `iron-material.ts`, `chunks.ts`, `deform.ts`, `arrays.ts` and
`surfaces.ts` so any lane can call `materials.create()`. **These two are the only genuine
serialisation point in the project.** Give them the strongest agents and schedule nothing behind
them. Every content lane's output looks wrong until `MaterialFactory` exists and is stable.

> **RCORE's Wave-1a commit must include the four authoring seams, not retrofit them:**
> `MaterialSpec.uniforms` + `setUniform` (the only data path into a lane's shader),
> `registerDeform(DeformChunk)` (vertex), `registerSurface(SurfaceChunk)` (fragment), and
> `createUnlit` (HUD, gizmos, sky). Without them the factory is a producer of finished materials
> from a fixed feature enum with no way to feed it anything — fine for LEVEL and TERRAIN, which want
> stock PBR, and fatal for WATER, VFX, VEG and WEAPONS, every one of which is a lane whose whole
> deliverable is its own maths on the GPU. This is a scheduling consequence, not just a types edit:
> four lanes get about four hours in and then stop dead at the material.

**Wave 1b — fully parallel, no cross-lane dependencies.** RCORE (graph, prepass, forward, the whole
post chain), PHYS (rapier world, character controller, queries — against a flat null terrain),
WEAPONS (meshes, viewmodel, recoil, sway, ADS, ballistics — needs only a camera and a physics that
always misses), AUDIO (zero visual dependencies), HUD (reads `GameMode` through the null, which
returns plausible fake state), VFX (soft particles look up `RTId.SceneDepth` by name and degrade to
hard particles against a null graph), GAME (tickets, bleed, capture progression, spawn selection —
all pure logic over the interfaces).

**Wave 1c — parallel, depends only on `MACRO_TERRAIN`.** SKY, TERRAIN, LEVEL (`layout.ts` **first**,
as pure data — AI and GAME both unblock on it), VEG. All four place geometry through the same frozen
function, so LEVEL's buildings sit on TERRAIN's ground the first time they are composed.

**Waves 2 — must wait, but productive early.** LIGHT starts one slice after RCORE's `graph.ts` and
`prepass.ts` land; until then `csm.ts`, `shadow-atlas.ts`, `pcss.ts`, `clustered.ts` and `sh.ts` are
pure maths and GLSL with no graph dependency. WATER needs TERRAIN's `shoreMask` for foam but builds
the FFT ocean, spectrum and material against a constant shore distance immediately. AI needs LEVEL's
navmesh for tuning only; `brain.ts`, `perception.ts`, `pathfind.ts`, `squad.ts`, `aim.ts` and the
whole soldier mesh/rig pipeline can be written from t0 against the null level's flat 200×200 m
navmesh.

**Wave 3 — global tuning. Cannot be parallelised and must not be attempted early.** Exposure and
tonemap calibration against the real golden-hour scene (RCORE + SKY together — the AgX look and the
sun illuminance are one decision, not two); cascade distances and bias against the real building
scale; bloom threshold against the real water highlights; TAA / mip-bias / Toksvig tuning; tier
calibration against measured frame time. Every one of these is a judgement about the whole frame, so
it needs one owner looking at one PNG.

**Continuous, not a wave.** One agent owns performance and tier calibration end to end from Wave 1b
onward. It owns `src/engine/quality.ts` and `src/engine/profiler.ts`, so it has no file conflicts,
and discovering at the end that Ultra does not fit in 16.6 ms is a redesign, not a tuning pass.

**Never parallelised:** additions to `src/engine/types.ts` (one lane at a time, append-only within
your own section, reported); the `PassOrder` and `TickPhase` enums (adding a slot changes global
ordering semantics — a CORE decision); the `QualitySettings` tier tables; and the three frozen files
in Rule 2.

---

## 11. Standing warnings

Every lane should read these once. They are the failure modes most likely to cost this project a day
each, and several of them fail for *everyone* at once.

1. **`EXT_color_buffer_float` must be explicitly requested at boot** or every R11G11B10F target
   comes back framebuffer-incomplete. three does not request it for that format path.
2. **Cold bake vs the 300 s harness timeout** is the single most likely thing to break the review
   loop, and it breaks it for all sixteen lanes simultaneously. Enforce the unit ceiling from day
   one; do not retrofit it after four lanes have each added 300 units of bake work.
3. **Three keeps a CPU-side copy of texture source data.** A 24-layer 512² RGBA8 array holds ~33 MB
   of JS heap *in addition to* 33 MB of VRAM. Call `renderer.initTexture()` and then release
   `texture.image.data`, or the tab sits at 900 MB of heap and dies on a 4 GB laptop.
4. **Golden hour is the worst case for cascaded shadows.** A sun 6–10° up makes cascade frusta
   extremely oblique; texel density collapses along the light direction and the bias needed for a
   raking sandstone wall starts to peter-pan the contact under a crate. Snap in light space to a
   fixed *world-space* texel grid, or the whole frame crawls as the camera moves.
5. **Rapier trimesh cost for a whole town.** Heightfield for terrain, boxes and convex hulls for
   ~90% of built geometry, trimesh only for the freighter hull, the cranes and the fort ramparts.
   Colliders are a deliberate second representation, never `mesh.geometry`.
6. **Per-draw CPU overhead is the real 1080p ceiling, not the GPU.** three costs ~5–8 µs per draw in
   JS; at the 480-draw Ultra ceiling that is 2.4–3.8 ms of main thread competing with physics, AI
   and culling. Dynamic resolution does not help a CPU-bound frame at all. Treat
   `Profiler.checkBudgets()` draw-call violations as build-breaking.
7. **Destruction is the most cross-cutting feature in the project.** A destroyed wall must leave its
   BatchedMesh without a rebuild, drop its collider, spawn chunks inside the debris budget,
   invalidate the `CoverSlot`s that referenced it, and re-open the navmesh. Scope it to
   pre-authored, pre-fractured cover pieces; do not attempt arbitrary geometry.
8. **Procedural humans are the highest-variance deliverable in the brief.** Bias hard toward
   silhouette and gear — helmets, packs, gloves, webbing, scarves — so the skin-and-face problem is
   minimised, and LOD aggressively so only 2–4 bots are ever close enough to scrutinise.
9. **SSR is genuinely unstable on water at grazing angles.** Plan to fade to the IBL cubemap by view
   angle and roughness rather than pretending it converges. Half-res GTAO and SSR also handle crane
   lattices, palm fronds, railings and window mullions worst — budget real time for the bilateral
   upsample weights.
10. **Water spans two lanes' mental models.** It writes velocity in a *forward* pass (14) that RCORE
    owns the ordering of and WATER owns the content of. If RCORE frees `GVelocity` after TAA input
    assembly, or WATER assumes `SceneColor` is readable without `SceneColorCopy`, water breaks in a
    way that looks exactly like a TAA bug.
