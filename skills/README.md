# IRONSIGHT skills

Reusable, source-grounded skill files — the second deliverable promised in `HANDOFF.md` §7B and
tracked as the P2 `skills/` item in issue #3. Each file captures a hard-won technique this codebase
**actually proves out**, cites the real source files it is drawn from, and is explicit about what is
proven versus what is below the project's own quality bar.

## The honesty rule that shaped this set

`HANDOFF.md` §7B and issue #3 both say the same thing: build the skills **only from verified final
techniques, not stale aspirational prose** — and specifically *"Do not write [the AAA-rendering
skills] until the quality bar is actually met — a skill claiming to teach AAA rendering, written from
a 3.8/8.5 codebase, is worse than no skill."* The project self-assesses at ~6.0 against an 8.5 visual
bar with 0/8 hero shots passing, and its own critic score drifts inside its noise floor.

So this set is deliberately **not** thirteen "achieve AAA X" recipes. It is:

- **Proven infrastructure and gameplay skills** — techniques whose *mechanism and result* are
  load-bearing and verified (the meta/infra trio, the bake pipeline, weapon feel, the HUD, VFX, the
  architecture grammar).
- **One consolidated "traps, not a recipe" file** for the below-bar visual rendering lanes, which
  preserves their genuinely reusable engineering decisions and expensive traps while refusing to
  claim their look is AAA.

## The skills

### Meta / infrastructure — the most transferable, and the most proven
These are *why* the rest was achievable. They work today and are load-bearing.

| Skill | What it gives you |
|---|---|
| [`deterministic-screenshot-harness`](deterministic-screenshot-harness.md) | Bit-reproducible frames on any GPU/software backend, so "did this change make it worse?" is answerable. The frames-not-wall-clock contract, the reset chain, the 465× ANGLE-vs-SwiftShader lesson, and the trap that a screenshot photographs systems, not mechanics. |
| [`multi-agent-lane-architecture`](multi-agent-lane-architecture.md) | Structure a codebase so ~16 agents build against one renderer in parallel without a black-screen merge disaster. Rings, the contract layer, three named exports per lane, frozen bootstrap files, null services, boundary CI, and integration-only failures. |
| [`blind-ab-critic-loop`](blind-ab-critic-loop.md) | Score your own visual output honestly against a real reference, blind, with DELTA scoring that survives critic drift (~1.7 between rounds, measured). And the two lessons that cost the project most: the instrument drifts, and it is blind to behaviour. |

### Proven procedural, gameplay & effects
Techniques whose result is verified — bakes run, shots capture, and (where noted) mechanics fire in
live play.

| Skill | Proven? |
|---|---|
| [`procedural-pbr-bakery`](procedural-pbr-bakery.md) | Pipeline PROVEN (zero binary art assets, zero runtime network, CPU/GPU noise parity, fits the cold-bake budget). Surface *look* is below the bar — stated. |
| [`fps-weapon-feel`](fps-weapon-feel.md) | PROVEN in live play: firing, ADS, recoil, real ballistics, sim/view split. Honest gaps: melee & weapon-swap inert; shotgun/sidearm fall back to the SMG. |
| [`diegetic-hud-from-reference`](diegetic-hud-from-reference.md) | PROVEN: in-canvas one-draw HUD, analytic code-baked SDF font, driven by real gameplay events in live play. |
| [`gpu-particles-and-vfx`](gpu-particles-and-vfx.md) | PROVEN reachable in play: bullet impacts, tracers, muzzle flash, the `G` frag explosion, physics-bounced debris. Water splash/underwater VFX complete but dormant. |
| [`procedural-architecture-grammar`](procedural-architecture-grammar.md) | PROVEN as generation: a whole town in ~15–17 draws, seeded so editing one building doesn't reshuffle the rest. Honest gaps: three named collider/destructible tagging bugs. |

### Below-bar visual rendering — traps and decisions, NOT an AAA recipe

| Skill | Why it's here |
|---|---|
| [`rendering-lanes-below-bar-traps`](rendering-lanes-below-bar-traps.md) | Consolidates the candidate `physical-sky-and-aerial-perspective`, `cascaded-shadows-and-gtao`, `filmic-grade-and-tonemapping`, `gerstner-water` and `wind-driven-vegetation` skills. These lanes are engineering-complete but self-assessed **below the visual bar** (water is named the weakest thing in the frame; impostors were never built). Per `HANDOFF.md` §7B they are not written as standalone AAA recipes. This file preserves their genuinely reusable engineering (golden-hour CSM world-space texel snapping, AgX-not-ACES, exposure-relative bloom, Gerstner CPU/GPU parity, the shared wind field) and their expensive traps — clearly labelled as pitfalls to learn from, not tuning to copy. |

## What is deliberately NOT here, and why

- **Standalone AAA sky / shadows / grade / water / vegetation skills** — folded into the traps file
  above. Writing them as recipes would violate the explicit `HANDOFF.md` §7B instruction and misstate
  a below-bar result as a target.
- **Melee and weapon-switch** — bound but inert (no consumers); nothing to teach yet.
- **Anything about destruction quality measured from the automated instruments** — both the screenshot
  and soak harnesses reset the destructible registry, so they are structurally blind to destruction;
  those claims rest on live human play only (`README.md`, `HANDOFF.md` §2.2).

## When the visual bar is met

The correct next step (per `HANDOFF.md` §7B and issue #3) is to converge the delta-scored blind critic
loop first, then promote individual rendering techniques out of the traps file into standalone
"achieve this look" skills — written from frames that actually pass, with before/after captures as
evidence.
