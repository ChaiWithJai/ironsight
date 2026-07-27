export const meta = {
  name: 'ironsight-wire-destruction',
  description: 'Make destruction and explosions reachable by a player: bullets damage cover, G throws a frag',
  phases: [
    { title: 'Wire', detail: 'ballistics→destruction, and a frag grenade on G' },
    { title: 'Verify', detail: 'soak proves a player can actually cause both' },
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

Both systems are complete and tested. **This is connection work, not construction.** Do not rebuild
either one; find the seam and wire it.

This matters beyond the feature: the shot harness will happily photograph a system that gameplay
cannot reach, and twelve rounds of visual critics scored a destruction frame no player can cause.

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
--- BULLETS ---
${work[0] ?? '(no report)'}
--- GRENADE ---
${work[1] ?? '(no report)'}

DO THIS YOURSELF:
1. \`npm run typecheck\`, \`npm run boundaries\`, \`npm run build\`.
2. **Grep for the call sites.** \`DestructionService.applyDamage\` must now be called from a
   gameplay path, not only \`src/physics/scenario.ts\`. The explosion VFX must be spawned from
   somewhere other than \`src/vfx/scenes.ts\`. If either is still only reachable from a test
   scenario, the task FAILED regardless of what the reports say.
3. **Drive it through the soak.** Extend/use \`./tools/soak.sh\` with a scripted intent that fires at
   a destructible wall and throws a grenade, then report: destructible chunks spawned, damage
   events, explosion events, entities damaged. Zero of any of those means it does not work.
4. Capture \`destruction_wall\` and \`vfx_explosion\` and READ the PNGs — confirm they still render
   correctly and were not regressed.
5. Confirm the README's "What is NOT yet a playable mechanic" table is now accurate — update it if
   these are genuinely reachable, and leave it alone if they are not.

Report honestly. A false "reachable" here is exactly the failure this whole task exists to correct.`,
  { label: 'verify-reachable', phase: 'Verify', schema: VERDICT, effort: 'high' },
)

return { verdict, wired: work.filter(Boolean).length }
