export const meta = {
  name: 'ironsight-wire-gameplay',
  description: 'Connect the built-but-unreachable systems: HUD feedback, destruction, explosions, ammo economy',
  phases: [
    { title: 'Wire', detail: 'HUD feedback, bullets→destruction, frag grenade, ammo economy, container placement' },
    { title: 'Verify', detail: 'soak + play proves each is actually reachable' },
  ],
}

const ROOT = process.env.IRONSIGHT_ROOT || process.cwd()

const CONTEXT = `IRONSIGHT, ${ROOT}.

**THE PROBLEM: two fully-built systems are unreachable from gameplay.**

A human looked at the captured shots and asked whether destruction and explosions were real
mechanics. They are not:

  - \`DestructionService.applyDamage()\` is called from exactly ONE place in the repo —
    \`src/physics/scenario.ts\`, a proving-ground scenario that exists so \`destruction_wall.png\`
    has something to photograph. **Shooting a wall in-game does nothing.**
  - The explosion VFX (\`explosion.large\`, \`explosion.fuel\`) is spawned only from
    \`src/vfx/scenes.ts\`, a demo scene for \`vfx_explosion.png\`. **No player action creates one.**
  - \`Btn.Grenade\` is bound to \`G\` in \`src/engine/input.ts\` and consumed by NOTHING. There is no
    explosive in the loadout at all: \`src/weapons/defs/\` holds four ballistic weapons (AR, DMR,
    LMG, SMG).

  - **NO GAMEPLAY CODE CALLS THE HUD AT ALL.** \`grep -rn "services.hud\\." src/game/ src/weapons/
    src/ai/\` returns NOTHING. Every hitmarker, killfeed line and damage indicator in the captured
    shots comes from a scripted demo timeline in \`src/ui/system.ts\` (look for the \`at: 0.36\`,
    \`at: 0.4\`, \`at: 0.75\` storyboard). **The HUD is currently decorative.** A player who kills
    someone gets no hitmarker, no killfeed line, no confirmation of any kind.
  - There is **no resupply mechanic**. The AR carries \`magazine: 30, reserve: 180\` — 210 rounds
    total for the whole match, and then you are permanently dry.

All of these systems are complete and tested. **This is connection work, not construction.** Do not
rebuild any of them; find the seam and wire it.

THE PATTERN, said plainly, because it is the most important thing on this project right now: each
lane built its system AND its screenshot scene, and the wiring BETWEEN lanes was never finished.
The shot harness photographs systems, not mechanics, so twelve rounds of visual critics scored a
destruction frame no player can cause and a killfeed no kill produces. **When you finish, the test
is not "does it render" — it is "can a human sitting at the keyboard make this happen".**

READ FIRST: ${ROOT}/README.md (see "What is NOT yet a playable mechanic"), ${ROOT}/HANDOFF.md,
${ROOT}/docs/OWNERSHIP.md, ${ROOT}/src/engine/types.ts.

RULES: own only your lane's globs. harness.ts / subsystems.ts / nulls.ts / shots/index.ts FROZEN.
No Math.random(). \`npm run typecheck\` and \`npm run boundaries\` clean when you finish. Build
isolated with IRONSIGHT_DIST=<yourdist>.

NOTE: a playability pass has just fixed a character-controller wedging bug and a bot-perception
bug. Read \`git log\` and re-run \`./tools/soak.sh\` before you start so you are building on the
fixed state, not the broken one.`

phase('Wire')

const work = await parallel([
  () =>
    agent(
      `${CONTEXT}

=== YOUR TASK: BULLETS MUST DAMAGE DESTRUCTIBLE COVER ===
You own WEAPONS (\`src/weapons/**\`). PHYS owns \`src/physics/**\` — call into it, do not edit it.

\`src/weapons/ballistics.ts\` already emits \`'projectile.impact'\` with an \`ImpactEvent\` carrying the
surface it struck. \`src/game/damage.ts\` consumes that for player/bot damage and suppression.
Nothing routes it to \`DestructionService.applyDamage()\`.

Wire it:
- On impact against a destructible collider, build a \`DamageInfo\` and call
  \`services.physics\`/\`services.destruction.applyDamage()\` with the correct hit point, direction,
  and a damage value derived from the round's energy at that range (you already model drop and drag
  — use the real remaining energy, not a constant).
- Respect material: a rifle round should chip and crack sandstone over several hits, not delete a
  wall. Thin materials should breach faster. \`DestructionResult\` tells you what happened — use it
  so VFX and AUDIO get the right event.
- Make sure the impact still produces its decal and surface-correct particle burst as it does now.
  Do not regress the one impact path that already works.

DONE when: firing at a destructible wall in-game visibly damages it and eventually breaches it, and
you can prove it — see the soak instruction below.`,
      { label: 'wire:bullets-destroy', phase: 'Wire', effort: 'high' },
    ),
  () =>
    agent(
      `${CONTEXT}

=== YOUR TASK: A FRAG GRENADE ON \`G\` ===
You own WEAPONS (\`src/weapons/**\`) — specifically the loadout and a new throwable. GAME owns the
damage model and PHYS owns destruction; call into both, edit neither.

There is currently no explosive in the game. Add one:
- A frag grenade as a throwable gadget, triggered by \`Btn.Grenade\` (already bound to \`G\`, already
  reaching \`PlayerIntent\` — it is simply never read). Cooked throw with an arc, a real physics
  body that bounces and settles, a fuse, and a limited carry count shown in the HUD's gadget row.
- On detonation: radial damage to players and bots with falloff and line-of-sight occlusion (do not
  damage through walls), a call into \`DestructionService.applyDamage()\` so it breaches cover, and
  the existing \`explosion.large\` VFX plus its audio.
- The explosion must light the world — LIGHT's clustered local lights already support this.
- Bots should be able to throw them too if the AI profile allows it; do not special-case the player.

The VFX and destruction systems are built and tested — you are connecting to them, not writing them.
\`src/vfx/scenes.ts\` shows exactly how the explosion is spawned today.

DONE when: pressing \`G\` in-game throws a grenade that detonates, damages, breaches cover and looks
right, and you can prove it — see the soak instruction below.`,
      { label: 'wire:grenade', phase: 'Wire', effort: 'high' },
    ),
  () =>
    agent(
      `${CONTEXT}

=== YOUR TASK: MAKE THE HUD RESPOND TO REAL GAMEPLAY ===
You own HUD (\`src/ui/**\`). GAME owns the damage model and the sim bus — subscribe to its events,
do not edit it.

Reported by a human playing: *"reticule needs to turn red when the enemy is killed so I know"* and
*"killfeed or HUD saying I killed someone is missing"*.

The HUD's own API is complete — \`showHitmarker('body'|'head'|'armour'|'kill')\`, \`pushKillFeed\`,
\`addDamage\`, \`addDamageDirection\` all exist and all render correctly. They are called from ONE
place: the scripted demo timeline used to stage \`hud_combat.png\`. Nothing in gameplay calls them.

Wire the real events. The sim bus already carries what you need:
- \`'projectile.impact'\` — carries the hit, so you can raise a body/head/armour hitmarker on a real
  hit, with the pitch/shape difference the reference HUD uses for a headshot.
- \`'entity.killed'\` (\`{ victim, killer, weapon, headshot }\`) — raise the **kill** hitmarker when
  \`killer\` is the local player, and push a killfeed line for every kill regardless of who made it.
  \`GameMode.nameOf(entity)\` resolves the callsigns.
- Damage taken by the local player → the directional damage indicator.

Match \`docs/HUD_SPEC.md\` for the visual treatment — it specifies the hitmarker shapes, the kill
variant, killfeed layout and the motion curves, measured from real frames. The demo timeline is a
good reference for what the finished thing should look like; the point is to drive it from events
instead of from a clock.

Leave the demo timeline working — \`hud_combat\` still needs to capture.

DONE when: killing a bot in-game produces a kill hitmarker AND a killfeed line, and you can prove
it from soak counters rather than by asserting it.`,
      { label: 'wire:hud-feedback', phase: 'Wire', effort: 'high' },
    ),
  () =>
    agent(
      `${CONTEXT}

=== YOUR TASK: AMMO ECONOMY, AND CONTAINERS THAT FLOAT ===
Two unrelated items, both reported by a human playing. You own WEAPONS (\`src/weapons/defs/**\`) for
the first and LEVEL (\`src/level/**\`) for the second.

**(a) "need more ammo, gun runs out too fast".** The AR is \`magazine: 30, reserve: 180\` — 210
rounds for an entire match, with **no resupply mechanic anywhere in the repo**. That is not a
tuning nit; the game becomes unplayable a few minutes in. Fix it properly:
- Raise reserve to something appropriate per weapon class (a reference AR carries ~7 magazines).
- Add a real **resupply**: an ammo crate at each capture point that refills reserve on proximity or
  on \`Btn.Use\` (\`F\`, already bound and already reaching PlayerIntent). The HUD already has an
  \`'ammo'\` gadget-marker kind, so the world-space marker is available.
- Balance across all four weapons in \`src/weapons/defs/\` — do not fix the AR alone.

**(b) Floating containers.** In a player screenshot of the BRAVO container yard, several shipping
containers hover clearly above the terrain with daylight under them. The yard is built in
\`src/level/landmarks/harbour.ts\` ("The container yard. Stacks are placed on a loose grid…").
Almost certainly placed at a constant Y instead of sampled terrain height. Fix it by sampling
\`TerrainService.heightAt()\` per stack — and then **sweep the whole level for the same mistake**,
because anything else placed on a constant Y has the same bug and only shows up where the ground
slopes. The rubric counts "geometry floating above the terrain" as a worldcraft defect, and the
critics missed it because it is outside the hero-shot framings.

DONE when: a full match does not run you dry, and no prop in the level floats. Capture
\`level_bravo\` and \`level_overview\` and READ them to confirm.`,
      { label: 'wire:ammo-and-placement', phase: 'Wire', effort: 'high' },
    ),
  () =>
    agent(
      `${CONTEXT}

=== YOUR TASK: BOTS TRAVERSE THE MAP BUT NEVER FIGHT ===
You own AI (\`src/ai/**\`). GAME owns the mode and squad orders — read it, call into it, do not edit it.

A previous pass fixed bot LOCOMOTION and it is genuinely fixed: median distance went 21 m → 183 m
over 60 s, 0 of 18 bots stationary. **They still never fight.** A skeptical verifier measured, over
a full 60 s 9v9:

    shots 82  ·  damage events 1  ·  KILLS 0
    Engage behaviour: 448 of 64,510 bot-ticks (0.7%). Dominant behaviour: Advance ×61,542.

And found the reason — **the two teams never meet**:

    After 60 s: all 9 Coalition bots at x = +63…+120
                all 9 Insurgent bots at x = −23…−174
                zero overlap, 90–290 m apart

Every bot walks to its own team's objective and stops there. Direct instrumentation of
\`src/ai/perception.ts\` showed enemy line-of-sight succeeded 72 times against 1,489 blocked (4.6%),
and **the count froze between t=2400 and t=3600 — zero enemy sightings in the final 20 seconds.**
The four bots reporting a target were all seeing the scripted player walking past, not each other.

**This is squad-goal selection, not perception and not movement.** Nothing pulls a bot toward
contact. Fix the objective logic so a Conquest match actually produces a fight:
- Bots should contest points the ENEMY holds or is capturing, not walk to a friendly-held point and
  idle. Read \`GameMode\`'s capture state — \`CapturePointRuntime\` carries owner, contested and progress.
- Once a point is secured, a proportion of the squad should push toward the next contested point
  rather than all garrisoning.
- React to contact: gunfire, a squadmate taking damage, or a spot should pull nearby bots toward it.
- Verify with the soak: **the pass condition is non-zero kills in 60 s of 9v9**, and Engage as a
  meaningful share of bot-ticks rather than 0.7%.

ALSO FIX: two bots remain wedged. Entities 1048828 and 1048830 end 0.8 m apart at (84.9, 11.5, 99)
with ~65% of the match frozen, longest unbroken freeze 9.38 s. The 0–5° slope band carries 27.8% of
all frozen ticks — **flat ground**, so this is capsule-vs-geometry or capsule-vs-capsule, not slope.
A bot frozen 9 s in one spot is something a human immediately reads as broken.

TWO WARNINGS, both from the verifier instrumenting the previous pass's claims:
1. \`nav.raycastWalkable\`'s 99.8% success headline is an ARTIFACT. 64,800 of 64,847 calls are the
   zero-length self-probe at \`src/ai/intent.ts:128\` (\`from === to\`), which is trivially clear.
   The real steering probe is a rounding error in that total. Do not trust that number.
2. \`RESUBMIT_EPSILON\` path coalescing was claimed as the centrepiece of the last fix and measured
   \`coalesced=0\` over a full run — it never fires. Do not tune it expecting an effect.

AND ONE THING NOBODY HAS LOOKED AT: **29% of path solves return \`partial\`** (184 of 624), and the
share is RISING through the run (6/100 at t=600 → 184/624 at t=3600). Bots are increasingly
steering along truncated corridors. Find out whether that is a budget cap or a graph defect.`,
      { label: 'wire:bots-fight', phase: 'Wire', effort: 'high' },
    ),
])

phase('Verify')

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['bulletsDamageCover', 'grenadeWorks', 'explosionReachable', 'evidence', 'remaining'],
  properties: {
    bulletsDamageCover: { type: 'boolean' },
    grenadeWorks: { type: 'boolean' },
    explosionReachable: { type: 'boolean', description: 'Can a player action cause an explosion VFX?' },
    evidence: { type: 'string', description: 'The real soak output / capture observations you produced yourself.' },
    remaining: { type: 'array', items: { type: 'string' } },
  },
}

const verdict = await agent(
  `${CONTEXT}

You are a SKEPTICAL verifier. Two agents claim to have made destruction and explosions reachable by
a player. **The entire point of this task was that a system can look built and be unreachable** —
so verify reachability specifically, not existence.

Their reports:
--- BULLETS -> DESTRUCTION ---
${work[0] ?? '(no report)'}
--- GRENADE ---
${work[1] ?? '(no report)'}
--- HUD FEEDBACK ---
${work[2] ?? '(no report)'}
--- AMMO + PLACEMENT ---
${work[3] ?? '(no report)'}
--- BOTS FIGHTING ---
${work[4] ?? '(no report)'}

DO THIS YOURSELF:
1. \`npm run typecheck\`, \`npm run boundaries\`, \`npm run build\`.
2. **Grep for the call sites — this is the core check.** All three must now be reachable from
   GAMEPLAY, not only from a scenario or a demo timeline:
     - \`DestructionService.applyDamage\` called from somewhere other than \`src/physics/scenario.ts\`
     - the explosion VFX spawned from somewhere other than \`src/vfx/scenes.ts\`
     - \`grep -rn "services.hud\\." src/game/ src/weapons/ src/ai/\` returns NON-EMPTY (it returns
       nothing today — the HUD is decorative)
   If any is still reachable only from a test path, that item FAILED regardless of what its report
   says.
3. **Drive it through the soak.** Extend/use \`./tools/soak.sh\` with a scripted intent that fires at
   a destructible wall and throws a grenade, then report: destructible chunks spawned, damage
   events, explosion events, entities damaged. Zero of any of those means it does not work.
4. Capture \`destruction_wall\`, \`vfx_explosion\` and \`ai_firefight\` and READ the PNGs — confirm
   they still render correctly and were not regressed.
4b. **Bot combat pass condition: NON-ZERO KILLS in a 60 s 9v9 soak.** The previous pass produced
   82 shots / 1 damage / 0 kills and was correctly judged not-fixed. Do not accept "bots move" as
   "bots fight" — check the kill count and the Engage share of bot-ticks.
5. Confirm the README's "What is NOT yet a playable mechanic" table is now accurate — update it if
   these are genuinely reachable, and leave it alone if they are not.

Report honestly. A false "reachable" here is exactly the failure this whole task exists to correct.`,
  { label: 'verify-reachable', phase: 'Verify', schema: VERDICT, effort: 'high' },
)

return { verdict, wired: work.filter(Boolean).length }
