---
name: gpu-particles-and-vfx
description: >
  Build combat VFX — muzzle flashes, tracers, surface-keyed bullet impacts, decals, and explosions —
  as GPU-instanced particles whose motion is a closed-form function of time (no ping-pong state),
  driven by real gameplay events, with debris that actually bounces off physics. Use when adding
  impact/explosion/tracer effects, when you need effects a deterministic capture can reproduce, or
  when a full GPU simulation pass is too heavy or too entangled to register safely. Proven in
  IRONSIGHT: bullet impacts, tracers and the frag explosion are reachable and fire in live play.
status: PROVEN for the reachable effects (impacts, tracers, muzzle flash, frag explosion, bouncing
  debris — all confirmed firing from real gameplay). Honest gaps: water splash/underwater VFX are
  complete but dormant; particles cannot collide with scene depth by design.
---

# GPU particles & VFX

## The core decision: stateless closed-form particles, not ping-pong state

IRONSIGHT deliberately **rejected** the RGBA32F ping-pong state-pair simulation that the render
graph's `Simulate` slot exists for (`src/vfx/pools.ts`). Instead, each particle's 32 floats are
**written once at spawn**, and everything after — damped-ballistic integration, curl advection,
growth, colour ramp — is a **closed-form function of `uVfxTime` evaluated in the vertex shader**.

The reason is architectural, and it is a transferable lesson: registering a GPU-simulation pass into
the day-0 empty render graph would blank other lanes' fallback renders during parallel development. A
stateless system needs no pass registration and no persistent target, so it composes cleanly against
the null graph. **The honest cost, stated in the code: stateless particles cannot collide with scene
depth.** If you need particles that bounce off world geometry in the general case, you need the state
pair; if you can express your motion in closed form, the stateless path is simpler, deterministic, and
parallel-development-friendly. IRONSIGHT chose the latter and paid the collision cost.

The pools are ring buffers: `SoftPool` (alpha-blended, occludes), `StreakPool` (additive,
velocity-stretched), `DecalPool`.

## Event-driven, not a node graph (`src/vfx/system.ts`, `library.ts`)

There is no visual emitter graph. Emission is **event-driven**: the VFX service subscribes to the
`FxEventMap` in its constructor, and each event fans out to a recipe in `library.ts`. This is what
makes the effects *reachable* — they are triggered by the same gameplay bus the HUD reads, not by a
scripted timeline. Confirmed emitters outside the VFX lane:

- `muzzleFlash` — player (`weapons/system.ts`) **and** bots (`ai/brain.ts`)
- `shellEject`, `tracer`, `whizby` — weapons/ballistics
- `impact` (surface-keyed decal + surface-correct debris) — ballistics on every bullet hit
- `debrisBurst` — ballistics, throwables, and destruction
- `explosion` — the `G` frag (`weapons/throwables.ts`)

These match the README's re-measured "reachable in play" table (bullet impacts, explosions, tracers
all `yes`).

## Decals: depth-tested, not box-projected (`src/vfx/glsl.ts`)

The decals are oriented quads (a tangent/bitangent/normal frame) with a noise-broken non-circular
outline, lit like the substrate. They are **not** a true deferred box-projection; instead they run an
explicit depth-occlusion test against the scene-depth target — and, importantly, they sample that
target **decoded as linear metres**, which correctly avoids the integration trap that bit water
(decoding a linear-metres depth target as if it were hardware depth). If you copy one thing from the
decal code, copy the discipline of knowing exactly what encoding your depth target holds.

## Explosions and debris that read as physical (`library.ts`, `src/vfx/debris.ts`)

The frag explosion is not a billboard: a fireball of 6–12 primary lobes with sub-lobes, a
ground-hugging pressure/shock ring of dust points, debris ejecta, a lingering soot column that
*separates* as it rises, and a real emitter light registered for the flash so the explosion lights the
world (a clustered light, not a painted glow). The **debris are real instanced geometry that bounces**
— CPU-integrated with `PhysicsService.raycast`, taking restitution and friction from the struck
surface's `SurfaceProfile`. That surface-keying (a round on stucco vs steel vs sand throws different
debris) is the shared-material-vocabulary payoff from the PBR-bakery skill.

Everything is governed by a "VFX are sparse" budget (tracers 3–12 on screen), which is honest about
the density the frame can afford rather than pretending to AAA particle counts.

## Honesty — proven vs dormant

- **Proven / reachable in real play:** muzzle flash (player and bots), tracers, whizby, shell eject,
  surface-keyed bullet impacts with bouncing surface-correct debris, and the `G` frag explosion
  (fireball, shock ring, ejecta, column, world light). Measured by driving the live build.
- **Built but dormant — do not claim as working:** water splash rings, the `impact.water` column
  recipe, and the underwater absorption pass all have complete code and *listeners*, but **no emitter
  fires them** — there is no wired water collider, and nothing calls `water.splash()`. Explosion-driven
  vegetation flatten / scorch have subscribers but no gameplay caller. Scripted `VfxScene` sequences
  exist only for deterministic shot files, not play.
- **By-design limitation:** stateless particles do not collide with scene depth. This is a deliberate
  trade, not a bug — but know it before promising depth-aware smoke.

## Key files
- `src/vfx/pools.ts` — the stateless closed-form pools and the explicit rejection of ping-pong state.
- `src/vfx/system.ts` — the FxEventMap subscriptions (why the effects are reachable).
- `src/vfx/library.ts` — the recipes: muzzle, tracer, impact, explosion.
- `src/vfx/glsl.ts` — decal frame + the linear-metres depth-occlusion test.
- `src/vfx/debris.ts` — physics-bounced instanced debris keyed by `SurfaceProfile`.
