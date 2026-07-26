/**
 * Damage curves and hit zones. WEAPONS owns this file.
 *
 * WEAPONS decides how much damage a bullet carries and where it landed; GAME
 * resolves what that does to a soldier (health, kills, assists, scoring) at
 * `TickPhase.Damage`. The seam is `SimEventMap['damage.applied']`, and this
 * file is the whole of our side of it.
 */
import type { BallisticsDef, DamageCurvePoint, HitZone } from '@/engine/types';

/**
 * Piecewise-LINEAR interpolation over the authored curve, clamped at both ends.
 *
 * Linear rather than smooth on purpose: damage falloff is a balance statement
 * ("this weapon takes four shots past 60 m"), and an author needs the number at
 * 60 m to be exactly the number they wrote at 60 m. A spline would put it a
 * point or two off and turn a four-shot kill into a five-shot kill at a
 * distance nobody could find in the table.
 */
export function damageAtDistance(curve: readonly DamageCurvePoint[], distance: number): number {
  if (curve.length === 0) return 0;
  const first = curve[0]!;
  if (distance <= first.distance) return first.damage;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if (distance <= b.distance) {
      const span = b.distance - a.distance;
      const t = span > 1e-6 ? (distance - a.distance) / span : 0;
      return a.damage + (b.damage - a.damage) * t;
    }
  }
  return curve[curve.length - 1]!.damage;
}

/**
 * Damage for one impact.
 *
 * `energyFraction` is the share of muzzle energy the round still carries, and
 * it is how penetration is paid for: a bullet through 12 cm of concrete arrives
 * with a third of its energy and does a third less damage. Without that term,
 * shooting through cover would be strictly better than shooting around it.
 */
export function bulletDamage(
  def: Readonly<BallisticsDef>,
  distance: number,
  zone: HitZone,
  energyFraction: number,
): number {
  const base = damageAtDistance(def.damage, distance);
  const zoneMul = def.zoneMultipliers[zone] ?? 1;
  // Clamped at 1: a round cannot arrive with more energy than it left with, and
  // floating-point drift on the very first tick otherwise reads as a 1% buff.
  const energy = Math.max(0, Math.min(1, energyFraction));
  return base * zoneMul * energy;
}

/** Muzzle kinetic energy in joules, from the def alone. */
export function muzzleEnergyJ(def: Readonly<BallisticsDef>): number {
  return 0.5 * def.massKg * def.muzzleVelocity * def.muzzleVelocity;
}
