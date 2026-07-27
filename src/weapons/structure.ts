/**
 * What a bullet does to a WALL, as opposed to what it does to a soldier.
 * WEAPONS owns this file.
 *
 * `damage.ts` answers "how much health does this round take off a person"; this
 * one answers "how much of this solid did this round remove". They are different
 * questions with different units and they must not share a curve: a soldier's
 * damage comes off an authored balance table (`BallisticsDef.damage`, "this
 * weapon takes four shots past 60 m"), while a wall does not care what the
 * balance table says — it cares how much energy arrived and how hard the
 * material is.
 *
 * THE MODEL, IN ONE LINE
 * ----------------------
 *     structural damage  ∝  the depth this round could bore into this material
 *
 * `SurfaceProfile.penetrationResistance` is already authored in JOULES PER
 * CENTIMETRE — it is the number `penetration.ts` charges a round to cross a
 * wall. Dividing the round's REMAINING kinetic energy by it gives centimetres,
 * which is a length of material removed, and length of material removed is what
 * structural damage actually is. Three properties fall out of that for free and
 * none of them had to be special-cased:
 *
 *   · RANGE MATTERS, because the numerator is the energy the round still has
 *     after drag. The AR leaves the muzzle with 1549 J and arrives at 300 m with
 *     895 J, so a wall shot from across the map takes 42% less per round. The
 *     drop and drag model was already there; this is the first thing that reads
 *     it for anything other than where the bullet lands.
 *
 *   · MATERIAL MATTERS, because the denominator is the material's own authored
 *     resistance. At 50 m the service rifle takes 11.4 off sandstone (210 J/cm),
 *     7.5 off concrete (320) and 34 off timber (70) — from one expression, with
 *     no table of per-material bullet damages to keep in sync.
 *
 *   · CALIBRE MATTERS, because energy is ½mv². The SMG's 600 J subsonic pistol
 *     round takes 4.9 off sandstone and is not a tool for opening walls; the
 *     LMG's 3432 J takes 27.7, and one 100-round belt is 2770 — which is how a
 *     support gunner ends up being the one who makes the hole.
 *
 * WHY THE ROUND'S FULL ENERGY AND NOT THE ENERGY THE PANEL ABSORBED
 * -----------------------------------------------------------------
 * A round that punches clean through a 2 cm plank only DEPOSITS ~140 J in it,
 * and a round that buries itself in a 50 cm wall deposits everything. Charging
 * structural damage by deposited energy therefore makes thin cover TOUGHER per
 * round than thick cover, which is backwards, and it is backwards in the one
 * direction the brief calls out ("thin materials should breach faster"). So the
 * bore depth is computed from what the round arrived with — what it COULD bore
 * — and the thin panel simply has less health to lose, because `DestructibleDef`
 * health is authored per cubic metre. Thin breaches fast because it is small,
 * not because the arithmetic was bent to say so.
 *
 * CALIBRATION
 * -----------
 * `STRUCTURE_HP_PER_CM` is pinned to ONE authored figure, PHYS's own comment on
 * `cover_wall_sandstone` in `physics/destruction/defs.ts`:
 *
 *     health: 2400,   // ~7 rifle magazines, or one rocket. Masonry shrugs off bullets.
 *
 * Seven 30-round magazines is 210 rounds, so a service-rifle round at a normal
 * engagement range must take 2400/210 = 11.43 off sandstone. Integrating the
 * flight model to 50 m gives 1411 J; sandstone resists 210 J/cm; 1411/210 =
 * 6.72 cm; 11.43/6.72 = 1.70. That is the whole derivation, and it means the
 * number below is a CONSEQUENCE of a design statement someone already wrote
 * down, not a knob that was turned until a wall fell over at a pleasing rate.
 */
import type { SurfaceProfile } from '@/engine/types';
import type { PenetrationOutcome } from '@/weapons/penetration';

/**
 * Destructible health removed per centimetre of material the round can bore.
 * Derived, not dialled — see the header. Changing it re-times EVERY weapon
 * against EVERY material at once, which is the point of there being one.
 */
export const STRUCTURE_HP_PER_CM = 1.7;

/**
 * A glance rakes the face instead of boring into it, so most of the energy it
 * gives up goes sideways along the wall rather than into a hole. The retained
 * fraction leaves with the round (`SurfaceProfile.ricochetRestitution`); of what
 * is left, this much counts as structural.
 */
const GLANCE_SCALE = 0.35;

/**
 * Health to take off a destructible solid for one impact.
 *
 * @param profile   the struck surface, from `MaterialFactory.profile`
 * @param energyJ   the round's REMAINING kinetic energy at the impact — the
 *                  live value the ballistics pool integrates, never a constant
 * @param outcome   what `resolvePenetration` decided the round then did
 */
export function structuralDamage(
  profile: Readonly<SurfaceProfile>,
  energyJ: number,
  outcome: Readonly<PenetrationOutcome>,
): number {
  if (!(energyJ > 0)) return 0;
  // Guarded rather than trusted: a surface authored at 0 J/cm would divide the
  // whole map's cover to zero health in one round, and the failure would look
  // like "destruction is broken" rather than like one bad table row.
  const resistanceJPerCm = Math.max(1, profile.penetrationResistance);
  const boreCm = energyJ / resistanceJPerCm;
  const scale =
    outcome.kind === 'ricochet'
      ? GLANCE_SCALE * Math.max(0, 1 - profile.ricochetRestitution)
      : 1;
  return boreCm * scale * STRUCTURE_HP_PER_CM;
}
