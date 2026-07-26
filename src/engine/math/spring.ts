/**
 * Semi-implicit (symplectic) Euler spring integrators. CORE owns this file.
 *
 * Weapon kick, camera trauma, viewmodel sway and HUD pops all run through here
 * so "damping 0.7" means the same overshoot everywhere. Semi-implicit rather
 * than explicit Euler because explicit Euler *gains* energy at the stiffnesses
 * weapon feel wants (400–1400) and visibly buzzes.
 *
 * Substepping keeps a stiff spring stable when a frame runs long: the stability
 * limit is dt < 2/ω, so we cap the per-substep dt at 1/(4·ω).
 */
import type { SpringParams, Vec3 } from '@/engine/types';

export interface Spring1 {
  value: number;
  velocity: number;
}

function substeps(params: SpringParams, dt: number): number {
  const omega = Math.sqrt(params.stiffness / Math.max(params.mass, 1e-4));
  const maxDt = 1 / Math.max(omega * 4, 1e-4);
  return Math.min(8, Math.max(1, Math.ceil(dt / maxDt)));
}

/** Integrate a scalar spring toward `target`. Mutates and returns `s.value`. */
export function integrateSpring(s: Spring1, target: number, params: SpringParams, dt: number): number {
  const n = substeps(params, dt);
  const h = dt / n;
  const omega = Math.sqrt(params.stiffness / Math.max(params.mass, 1e-4));
  // `damping` is a ratio: 1.0 is critical. c = 2ζω.
  const c = 2 * params.damping * omega;
  for (let i = 0; i < n; i++) {
    const accel = (target - s.value) * params.stiffness / Math.max(params.mass, 1e-4) - c * s.velocity;
    s.velocity += accel * h;
    s.value += s.velocity * h;
  }
  return s.value;
}

/** Vector form. `value` and `velocity` are mutated in place. */
export function integrateSpring3(
  value: Vec3,
  velocity: Vec3,
  target: Vec3,
  params: SpringParams,
  dt: number,
): void {
  const n = substeps(params, dt);
  const h = dt / n;
  const invMass = 1 / Math.max(params.mass, 1e-4);
  const omega = Math.sqrt(params.stiffness * invMass);
  const c = 2 * params.damping * omega;
  for (let i = 0; i < n; i++) {
    const ax = (target.x - value.x) * params.stiffness * invMass - c * velocity.x;
    const ay = (target.y - value.y) * params.stiffness * invMass - c * velocity.y;
    const az = (target.z - value.z) * params.stiffness * invMass - c * velocity.z;
    velocity.x += ax * h;
    velocity.y += ay * h;
    velocity.z += az * h;
    value.x += velocity.x * h;
    value.y += velocity.y * h;
    value.z += velocity.z * h;
  }
}

/** Kick a spring by an instantaneous velocity impulse (a gunshot, a landing). */
export function impulse(s: Spring1, amount: number): void {
  s.velocity += amount;
}
