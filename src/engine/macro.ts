/**
 * MACRO_TERRAIN — the frozen analytic silhouette of HARBOUR REACH.
 * CORE owns this file and it does not change after day 0.
 *
 * WHY THIS EXISTS
 * ---------------
 * TERRAIN's real heightfield is an eroded 2048² GPU bake that does not exist
 * until well into the schedule. LEVEL, VEG, WATER and AI all need to know where
 * the ground is BEFORE that. If each of them guessed, the buildings would float
 * and the palms would grow out of the sea the first time the lanes were
 * composed. Instead every lane evaluates THIS function, TERRAIN uses it as the
 * base layer under erosion, and the composition is correct on the first try with
 * neither side reading the other's code.
 *
 * The contract TERRAIN inherits: erosion may carve channels and add detail, but
 * it must not move the macro silhouette by more than a couple of metres. This is
 * the shape of the map.
 *
 * THE MAP, IN WORDS
 * -----------------
 * A Mediterranean/Levantine coastal town. The sea lies to the north (−Z); the
 * land rises south through a beach berm, a town terrace and inland hills. A
 * rocky headland juts north-west carrying the old fort (CHARLIE). A stone
 * breakwater runs north-east from the quay. The market square (ALPHA) sits on a
 * flattened terrace inland; the harbour cranes (BRAVO) stand on a low quay at
 * the waterline.
 *
 * Everything is analytic — sines, gaussians and smoothsteps. No noise library,
 * no tables, no allocation, no state. It is safe to call from a worker, from the
 * physics tick, and from a shader port that has to agree with it exactly.
 */
import { clamp, smoothstep } from '@/engine/math/curves';
import type { MacroTerrain } from '@/engine/types';

const SEA_LEVEL = 0;

/** Playable envelope. The visual terrain extends further; gameplay does not. */
const BOUNDS = Object.freeze({ minX: -400, minZ: -400, maxX: 400, maxZ: 400 });

/**
 * Capture-point anchors. LEVEL's `layout.ts` MUST use these same centres — the
 * plateaus below are flattened around them, so a point placed anywhere else sits
 * on a slope. Exported so LEVEL can import rather than retype them.
 */
export const MACRO_ANCHORS = Object.freeze({
  /** ALPHA — market square, on the inland terrace. */
  alpha: Object.freeze({ x: 78, z: 96, radius: 52, height: 11.5 }),
  /** BRAVO — harbour cranes, on the quay at the waterline. */
  bravo: Object.freeze({ x: -26, z: 6, radius: 58, height: 3.4 }),
  /** CHARLIE — the old fort, on the headland. */
  charlie: Object.freeze({ x: -212, z: -48, radius: 46, height: 31.0 }),
});

/**
 * Where the waterline sits for a given X, before the headland and breakwater
 * deform it. Three incommensurate sine periods (838 m, 331 m, 203 m) so the
 * coast never visibly repeats inside the playable envelope.
 */
function shorelineZ(x: number): number {
  return -30 + 26 * Math.sin(x * 0.0075) + 14 * Math.sin(x * 0.019 + 1.7) - 8 * Math.cos(x * 0.031 - 0.4);
}

/** Unnormalised gaussian bump. `sigma` is the 1σ radius in metres. */
function bump(x: number, z: number, cx: number, cz: number, sigma: number): number {
  const dx = x - cx;
  const dz = z - cz;
  return Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
}

/** Squared distance from (x,z) to the segment (ax,az)–(bx,bz). */
function distToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = x - ax;
  const wz = z - az;
  const len2 = vx * vx + vz * vz;
  const t = len2 > 0 ? clamp((wx * vx + wz * vz) / len2, 0, 1) : 0;
  const px = ax + vx * t;
  const pz = az + vz * t;
  return Math.hypot(x - px, z - pz);
}

/**
 * Blend `h` toward `target` inside a disc. `radius` is the flat core; the outer
 * 45% is the ramp, which is what keeps a plateau from reading as a cake stand.
 */
function plateau(h: number, x: number, z: number, cx: number, cz: number, radius: number, target: number): number {
  const d = Math.hypot(x - cx, z - cz);
  const mask = 1 - smoothstep(radius * 0.55, radius * 1.45, d);
  return h + (target - h) * mask;
}

function macroHeight(x: number, z: number): number {
  // Metres inland of the nominal waterline. Negative is offshore.
  const d = z - shorelineZ(x);

  // Sea floor: a gentle shelf that steepens offshore, floored at −22 m so the
  // half-sunk freighter has somewhere to sit and the water shader has a bottom.
  const seabed = -Math.min(22, 0.35 + Math.pow(Math.max(0, -d), 1.18) * 0.055);

  // Land profile: beach berm → town terrace → inland hills.
  const berm = 2.4 * smoothstep(0, 16, d);
  const terrace = 7.6 * smoothstep(22, 135, d);
  const hills = 27 * smoothstep(150, 390, d);
  // Long-wavelength undulation so the terrace is not a billiard table.
  const roll = 2.1 * Math.sin(x * 0.0125 + 0.6) * smoothstep(10, 90, d) + 1.3 * Math.sin(z * 0.017 - 1.1);

  let h = d < 0 ? seabed : berm + terrace + hills + roll;

  // Blend across the waterline so the beach does not have a step in it.
  if (d > -18 && d < 18) {
    const t = smoothstep(-18, 18, d);
    h = seabed * (1 - t) + (berm + terrace + hills + roll) * t;
  }

  // THE HEADLAND. Two overlapping bumps so the promontory has a shoulder rather
  // than reading as a single cone; it pushes land ~150 m out into the sea.
  h += 38 * bump(x, z, -228, -66, 96);
  // Secondary shoulder, lowered 16 m -> 8 m. See THE CHARLIE-BRAVO CORRIDOR note
  // below: at 16 m this shoulder put 15 m of rock across the map's central
  // sightline.
  h += 8 * bump(x, z, -168, -20, 62);
  // A notch that separates the headland from the town, which is what makes it
  // read as a *headland* and gives CHARLIE its natural approach.
  h -= 11 * bump(x, z, -140, 34, 44);

  // THE CHARLIE-BRAVO CORRIDOR.
  //
  // The map's premise is three points that contest each other. CHARLIE (the fort,
  // 31 m) overlooking BRAVO (the quay, 3.4 m) at 194 m is the fight the whole
  // layout is built around, and as first authored it did not exist: the terrain
  // put a 15 m wall across it at (-153, -31).
  //
  // Measured, not guessed. Sampling the height field along the eye-to-eye line
  // showed two SEPARATE obstructions, which is why an earlier attempt to fix this
  // by cutting harder saturated at 1.8 m and stopped improving:
  //
  //   1. the secondary headland shoulder above — genuine terrain, cut here;
  //   2. CHARLIE's OWN plateau. The terrace is flat at 31 m, so a player standing
  //      at its centre has a sightline that drops below their own ground 33 m out.
  //      No amount of cutting fixes that, because `plateau()` runs last and
  //      re-flattens whatever this carve removes.
  //
  // (2) is not a terrain defect — it is what a flat terrace does, and it is why
  // real fortifications put the fighting step at the parapet. LEVEL owns that
  // half: CHARLIE's firing positions must sit >= 4 m above the terrace on the
  // seaward rampart. With this saddle and a 6 m rampart the line clears by 1.8 m.
  // With either alone it stays blocked.
  //
  // A saddle rather than a trench: sigma 58 m is wide enough that it reads as the
  // natural col between the headland and the town, and the cut is applied BEFORE
  // the plateaus so it can never eat a capture point's terrace.
  h -= 14 * Math.exp(
    -Math.pow(distToSegment(x, z, MACRO_ANCHORS.charlie.x, MACRO_ANCHORS.charlie.z, MACRO_ANCHORS.bravo.x, MACRO_ANCHORS.bravo.z), 2) /
      (2 * 58 * 58),
  );

  // THE BREAKWATER. A narrow stone arm running north-east from the quay; +5.5 m
  // above the water at the root, tapering as it goes out.
  const bw = distToSegment(x, z, 26, -14, 148, -102);
  h += 7.4 * Math.exp(-(bw * bw) / (2 * 11 * 11)) * (1 - smoothstep(0, 165, Math.hypot(x - 26, z + 14)) * 0.45);

  // A second, lower spur sheltering the inner harbour from the west.
  const spur = distToSegment(x, z, -96, -6, -150, -58);
  h += 5.0 * Math.exp(-(spur * spur) / (2 * 9 * 9));

  // Capture-point terraces, applied last so they win over the roll.
  h = plateau(h, x, z, MACRO_ANCHORS.alpha.x, MACRO_ANCHORS.alpha.z, MACRO_ANCHORS.alpha.radius, MACRO_ANCHORS.alpha.height);
  h = plateau(h, x, z, MACRO_ANCHORS.bravo.x, MACRO_ANCHORS.bravo.z, MACRO_ANCHORS.bravo.radius, MACRO_ANCHORS.bravo.height);
  h = plateau(h, x, z, MACRO_ANCHORS.charlie.x, MACRO_ANCHORS.charlie.z, MACRO_ANCHORS.charlie.radius, MACRO_ANCHORS.charlie.height);

  return h;
}

/**
 * First-order signed distance to the waterline: `H / |∇H|`. Exact only where the
 * gradient is locally constant, which near a shoreline it very nearly is. The
 * alternative — marching to find the true nearest zero crossing — costs dozens
 * of evaluations for an answer nobody needs to sub-metre accuracy.
 *
 * Positive inland, negative offshore, as the contract specifies.
 */
const GRAD_EPS = 1.5;

function macroShoreDistance(x: number, z: number): number {
  const h = macroHeight(x, z) - SEA_LEVEL;
  const gx = (macroHeight(x + GRAD_EPS, z) - macroHeight(x - GRAD_EPS, z)) / (2 * GRAD_EPS);
  const gz = (macroHeight(x, z + GRAD_EPS) - macroHeight(x, z - GRAD_EPS)) / (2 * GRAD_EPS);
  const grad = Math.hypot(gx, gz);
  // A flat sea floor has a near-zero gradient, which would report the shoreline
  // as infinitely far. Clamp so "very far offshore" saturates at a sane number.
  return h / Math.max(grad, 0.012);
}

export const MACRO_TERRAIN: MacroTerrain = Object.freeze({
  seaLevel: SEA_LEVEL,
  bounds: BOUNDS,
  height: macroHeight,
  shoreDistance: macroShoreDistance,
});

/** Analytic macro normal. Cheap enough to call per scatter instance. */
export function macroNormal(x: number, z: number, out: { x: number; y: number; z: number }): void {
  const gx = (macroHeight(x + GRAD_EPS, z) - macroHeight(x - GRAD_EPS, z)) / (2 * GRAD_EPS);
  const gz = (macroHeight(x, z + GRAD_EPS) - macroHeight(x, z - GRAD_EPS)) / (2 * GRAD_EPS);
  const len = Math.hypot(gx, 1, gz);
  out.x = -gx / len;
  out.y = 1 / len;
  out.z = -gz / len;
}
