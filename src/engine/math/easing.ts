/**
 * The named easing curves declared as `EaseId` in the contract. CORE owns this
 * file; every lane that eases anything (ADS blends, HUD fades, camera moves)
 * calls `ease(id, t)` so a designer-visible curve name means one thing project
 * wide.
 */
import type { EaseId } from '@/engine/types';
import { clamp01 } from '@/engine/math/curves';

type EaseFn = (t: number) => number;

const C4 = (2 * Math.PI) / 3;

const TABLE: Readonly<Record<EaseId, EaseFn>> = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  // 1.70158 is the classic overshoot constant: ~10% past the target.
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1;
  },
};

export function ease(id: EaseId, t: number): number {
  return TABLE[id](clamp01(t));
}

export function easeFn(id: EaseId): EaseFn {
  return TABLE[id];
}
