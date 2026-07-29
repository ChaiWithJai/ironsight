---
name: fps-weapon-feel
description: >
  Make a first-person weapon feel tactile and trustworthy: a learnable recoil pattern, a crosshair
  that can never lie about where the bullet goes, real projectiles with drag and travel time, and a
  procedural viewmodel with sway, bob, breathing and reload animations built entirely in code. Use
  when building FPS gunplay, tuning weapon feel, or wiring aim/recoil/ADS. Proven in IRONSIGHT:
  firing, ADS and recoil were measured working in live play.
status: PROVEN in live play (firing, ADS after a real bug fix, recoil, ballistics). Honest gaps:
  melee and weapon-switch are bound but inert; shotgun and sidearm silently fall back to the SMG.
---

# FPS weapon feel

## The load-bearing idea: split sim recoil from view recoil

The single most important design decision (`src/weapons/system.ts` header): **`WeaponState.aimPunch`
is SIMULATION recoil** — it is added to the aim basis *before* a bullet's direction is computed, so it
genuinely deflects rounds — while **`WeaponFeelState.cameraKick` (in `src/weapons/viewmodel/rig.ts`)
is VIEW recoil, purely cosmetic.** "Nothing in the viewmodel can move a bullet."

Why this matters: the aim basis is `player.pitch/yaw + aimPunch`, and **both the ballistics solver and
the HUD reticle read the same basis**, so the crosshair can never disagree with where the bullet
actually goes. This one seam is what makes gunplay feel honest instead of random. It also let two
agents split WEAPONS cleanly — one owns the sim, one owns the view — without either being able to
corrupt the other's guarantee.

## A learnable pattern comes from a hash, not an RNG draw

Per-shot recoil jitter is a **deterministic hash of (entity, shotIndex)**, not a draw from a random
stream (`system.ts`, `hashSigned()`). The seventh shot of a burst kicks the *same way every time, for
every player*, so the pattern is memorisable — which is the whole point of a recoil pattern in a
competitive shooter. Making it an RNG draw would also have coupled it to shot determinism and shifted
other lanes' streams.

Recoil application splits the kick into a **recovered fraction** (fed into an underdamped spring,
`aimPunchVelocity`) and a **permanent-climb fraction** (applied through `player.applyAimPunch`), with
a hang delay before the spring relaxes so a held burst keeps climbing. Springs are authored from the
weapon's mass in `src/weapons/defs/shared.ts` — the kick spring is deliberately underdamped (damping
0.55–0.75) so the sight overshoots and settles rather than snapping back, which is most of what reads
as "weight."

## Fire control, spread, ADS — the details that separate good from janky

- **Fractional-tick rate accumulation** (`system.ts`): rounds-per-minute is accumulated as a
  fractional `nextFireAt`, never rounded to whole ticks, because rounding 900/850 rpm to the tick grid
  quietly changes the fire rate and desyncs the feel. Stale schedules resync and future credit is
  clamped.
- **Three fire modes** (Auto held / Semi new-pull-only / Burst latched) with per-mode reset, and an
  equip that resets mag/spread/recoil step so a weapon swap cannot inherit the LMG's step-19 climb.
- **Spread is a state machine** that always decays toward a stance/movement/air floor: hip↔ADS base ×
  crouch/prone × movement × airborne, plus per-shot bloom and heat.
- **ADS uses two different numbers with the same shape**: a sim-side blend at tick rate (read by
  spread and recoil, asymmetric — lowers ~1.35× faster than it raises) and a *separately* eased
  view-side curve (`outExpo`, not a spring or lerp) so the visual and the sim never fight. The
  view-side ADS derives its offset from the model's actual sight point so the optic axis lands on the
  eye.

## Real projectiles, not hitscan (`src/weapons/ballistics.ts`)

Bullets are pooled entries in fixed typed arrays (never rapier bodies), swept with a sphere cast, and
integrated with `dv/dt = −k·|v|·v + g` (quadratic drag plus gravity). The trick that keeps a
crosshair honest *and* makes corner shots hit the wall: **the bullet starts at the camera and blends
to the true muzzle position over ~3.2 m.** Cone spread is sampled from the shot seed (sqrt on the
radius for a uniform disc), not a stream. The same flight model backs `predictImpact` / `solveLead`,
so AI leading and HUD lead indicators use the exact physics the bullet will.

## The whole feel is one composed pose (`src/weapons/viewmodel/rig.ts`)

`composePose()` layers nine contributions in a fixed order: base, sprint, sway, bob, landing,
breathing, lean, recoil, active clip. The details that read as craft:

- **Sway is a spring trailing the camera *quaternion*** (so it overshoots on a fast turn), not a
  position lerp.
- **Bob is advanced by distance travelled, not time** (a figure-eight), so it stops instantly when you
  stop and does not drift while idle.
- **Landing dip is sized by the arrested fall speed**; breathing runs on its own accumulated clock.
- **Reload / bolt / inspect are procedural clips** — key tables plus a sampler, zero imported
  animation data. The magazine channel uses an *asymmetric* ease: t² falling out under gravity,
  1−(1−t)² seating back under muscle. The bolt cycles on `sin(πt)`; the trigger break is driven off
  seconds-since-fire and rpm.
- The viewmodel has its **own near camera and its own three-point light rig** (key/fill/rim in
  absolute lux with a body-occlusion factor), so the gun is lit consistently and can never clip a
  wall or eat world depth precision.

Every weapon mesh is procedural too (`src/weapons/models/build.ts`): a part list (not a merged mesh)
in weapon space (−Z bore), four class silhouettes, receiver/rail/optic/handguard/barrel/muzzle/grip/
stock/magazine/bipod, a sub-millimetre wear-jitter pass, and procedural gloved hands.

## Honesty — what is proven vs what is not

- **Proven in live play** (`HANDOFF.md` §A0, re-measured by driving the shipped build): firing, ADS
  (after fixing a real bug — ADS had been bound to the *middle* mouse button for the project's whole
  life because a `& 2` test was run against a `1 << button` mask; left-click fire worked because left
  is bit 0 in every layout, which hid it), recoil, and the sim/view split with a learnable pattern.
  Bots fire through the *same* code path (they emit the same `PlayerIntent`), so a feel change lands
  for the player and 24 bots at once.
- **Bound but inert — do not claim these work:** melee (`V`) and weapon-switch (`X`, `1`–`9`) reach
  the input layer and have **zero consumers** anywhere in the codebase. The loadout stays on the
  rifle.
- **Not authored:** only 4 of 7 weapon classes exist. `shotgun` and `sidearm` **silently fall back to
  `smg_compact`** (and `carbine` aliases `ar_service`) via an alias table that logs a one-time
  warning. A future author should build these as real defs, not aliases.
- The HUD damage number for a shot *through cover* reads high, because the residual-energy fraction is
  not on the public contract and the number is recomputed from the full damage curve (self-flagged).

## Key files
- `src/weapons/system.ts` — fire control, sim recoil, spread, sim-side ADS, the aim basis.
- `src/weapons/viewmodel/rig.ts` — the 9-layer composed pose, view recoil, sway/bob/breathing, light
  rig. `src/weapons/viewmodel/anim.ts` — procedural reload/bolt/inspect clips.
- `src/weapons/ballistics.ts` — pooled projectiles, drag+gravity, camera→muzzle blend, lead solve.
- `src/weapons/defs/shared.ts` (spring authoring from mass), `defs/index.ts` (the alias fallback).
- `src/weapons/models/build.ts` — procedural weapon geometry.
