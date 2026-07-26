/**
 * The bake cost model and the degradation policy. OWNER: BAKE.
 *
 * `tools/capture.mjs` hard-fails at 300 s waiting for `ready`, playwright uses a
 * fresh profile so IndexedDB never hits, and SwiftShader runs GPU bakes 20–60×
 * slower than a discrete part. The unit ceiling is the one number standing
 * between that and a review loop that is red for every lane at once.
 *
 * ARCHITECTURE DECISION #11 — when Σcost exceeds `BakeProfile.unitCeiling` the
 * scheduler DEGRADES RESOLUTION; it never drops a step. A missing material is a
 * defect that shows up as an untextured surface in someone's shot and costs a
 * critic a round trip; a 256² material is merely softer.
 *
 * Which steps degrade first: the MOST EXPENSIVE ones. Halving the texel edge of
 * a 480-unit material-array bake reclaims 360 units; halving a 6-unit BRDF LUT
 * reclaims 4.5 and ruins it. Cost is the best available proxy for "large,
 * bulk, and viewed at a distance", which is exactly the population that
 * tolerates being softer.
 */

export interface CostedStep {
  readonly id: string;
  readonly cost: number;
}

export interface DegradePlan {
  /** id → linear texel scale in {1, 0.5, 0.25}. */
  readonly scale: ReadonlyMap<string, number>;
  readonly degraded: readonly string[];
  readonly declaredUnits: number;
  readonly plannedUnits: number;
  readonly ceiling: number;
}

/** Floor for degradation. Below 128² a bulk material stops reading as material. */
const MIN_SCALE = 0.25;

/**
 * A texture bake's cost scales with texel COUNT, so halving the edge quarters
 * the work. Worker and main-thread steps do not shrink with texel size, but they
 * are also never the reason a bake is over budget, and modelling them the same
 * way simply means they are asked to degrade last.
 */
function scaledCost(cost: number, scale: number): number {
  return cost * scale * scale;
}

export function planDegradation(steps: readonly CostedStep[], ceiling: number): DegradePlan {
  const scale = new Map<string, number>();
  let declared = 0;
  for (const s of steps) {
    scale.set(s.id, 1);
    declared += Math.max(1, s.cost);
  }
  let planned = declared;
  if (ceiling <= 0 || planned <= ceiling) {
    return { scale, degraded: [], declaredUnits: declared, plannedUnits: planned, ceiling };
  }

  // Deterministic order: cost descending, ties broken by id. A Map iteration
  // order or a stable-sort assumption would make the plan depend on declaration
  // order, and therefore on which lanes happen to be shipped that day.
  const order = [...steps].sort((a, b) => b.cost - a.cost || (a.id < b.id ? -1 : 1));
  const degraded = new Set<string>();
  let progress = true;
  while (planned > ceiling && progress) {
    progress = false;
    for (const s of order) {
      const current = scale.get(s.id) ?? 1;
      if (current <= MIN_SCALE) continue;
      const next = current * 0.5;
      planned -= scaledCost(Math.max(1, s.cost), current) - scaledCost(Math.max(1, s.cost), next);
      scale.set(s.id, next);
      degraded.add(s.id);
      progress = true;
      if (planned <= ceiling) break;
    }
  }
  return {
    scale,
    degraded: [...degraded].sort(),
    declaredUnits: declared,
    plannedUnits: Math.round(planned),
    ceiling,
  };
}

/**
 * Apply a plan's scale to a requested texel edge. Always a power of two: mip
 * chains and `DataArrayTexture` layers both assume it, and a 384² layer in a
 * 512² array is a silent stretch.
 */
export function grantTexelSize(requested: number, scale: number, floor = 64): number {
  if (scale >= 1) return requested;
  const target = Math.max(floor, requested * scale);
  let size = 1;
  while (size * 2 <= target) size *= 2;
  return Math.max(floor, Math.min(requested, size));
}
