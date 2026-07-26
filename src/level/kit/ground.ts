/**
 * GROUND TRANSITION — the detail the brief singles out by name.
 *
 * OWNER: LEVEL.
 *
 * > "Geometry that meets the ground with a hard seam and no debris, dirt or
 * >  transition" — docs/BRIEF.md, defect list.
 *
 * A wall that intersects a terrain triangle produces a mathematically perfect
 * line. Nothing in the physical world produces that line: forty years of wind
 * piles sand against the windward face, rain washes grit out of the mortar, and
 * every building sheds its own render into a low ridge of rubble at its foot.
 * Reproducing that costs three things, and all three are in here:
 *
 *  1. A continuous SAND FILLET — an irregular wedge hugging the wall, 0.1–0.5 m
 *     high and 0.4–1.6 m out, thicker on the prevailing-wind side. This alone
 *     removes the seam, because there is no longer a wall/ground intersection
 *     visible from any standing eye height.
 *  2. RUBBLE CHUNKS at the foot — spalled render, broken block, roof tile. These
 *     break the fillet's own silhouette so it does not read as a moulding.
 *  3. SCATTER out to ~2.5 m, thinning with distance, so the transition has a
 *     falloff instead of an edge.
 *
 * Everything here is emitted in WORLD space against the analytic macro terrain,
 * NOT in the building's local frame — the drift follows the ground, and a
 * leaning building must not lean its own debris.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import type { MatKey } from '@/level/materials';

export interface Pt2 {
  x: number;
  z: number;
}

const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/**
 * An irregular boulder / rubble chunk. Two poles and one jittered equator: 2n
 * triangles for a shape that reads as broken stone from 1 m and as a silhouette
 * bump from 40 m, which is the whole job.
 */
export function rock(
  b: LevelBuild,
  mat: MatKey,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
  rng: Rng,
  sides = 5,
): void {
  const m = b.m(mat);
  const yaw = rng.range(0, Math.PI * 2);
  const eq: THREE.Vector3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = yaw + (i / sides) * Math.PI * 2;
    const j = rng.range(0.62, 1.0);
    eq.push(new THREE.Vector3(cx + Math.cos(a) * rx * j, cy + rng.range(-0.14, 0.14) * ry, cz + Math.sin(a) * rz * j));
  }
  const top = _t0.set(cx + rng.range(-0.2, 0.2) * rx, cy + ry, cz + rng.range(-0.2, 0.2) * rz);
  // The bottom pole is pushed well below the surface: a rock that merely rests
  // on the ground has its own hard seam, which is the bug we came here to fix.
  const bot = _t1.set(cx, cy - ry * 1.4, cz);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    m.triangle(eq[i], eq[j], _t2.copy(top), 1);
    m.triangle(eq[j], eq[i], _t2.copy(bot), 1);
  }
}

export interface SkirtOpts {
  /** Direction sand piles from, radians. Drift is thickest on this face. */
  readonly windDir?: number;
  /** Global multiplier on drift height — 0.5 for a swept quay, 1.6 for an alley. */
  readonly amount?: number;
  readonly rubbleMat?: MatKey;
  readonly sandMat?: MatKey;
  /** Skip the outward scatter (interiors, tight alleys). */
  readonly noScatter?: boolean;
}

/**
 * Lay the drift, rubble and scatter along a closed world-space outline.
 * `groundAt` is the terrain height function — the analytic macro field, so this
 * is correct before TERRAIN's eroded heightfield exists and stays correct after
 * (erosion is contracted not to move the macro silhouette).
 */
export function groundSkirt(
  b: LevelBuild,
  outline: readonly Pt2[],
  groundAt: (x: number, z: number) => number,
  rng: Rng,
  opts: SkirtOpts = {},
): void {
  const wind = opts.windDir ?? -0.6;
  const amount = opts.amount ?? 1;
  const rubbleMat = opts.rubbleMat ?? 'rubble';
  const sandMat = opts.sandMat ?? 'sand';
  const sand = b.m(sandMat);
  const n = outline.length;

  /**
   * WHICH WAY IS OUT.
   *
   * `(ez, −ex)` is the outward normal of edge `(ex, ez)` only for a
   * COUNTER-clockwise outline in XZ; for a clockwise one it points straight into
   * the building. Half this lane's callers build their outlines corner-by-corner
   * in a local frame and hand over a clockwise loop without knowing it, and the
   * failure is completely silent: the drift, the rubble and the scatter are all
   * still emitted, they are just emitted UNDER the plinth where nothing can see
   * them, and the wall meets the ground with exactly the hard seam this whole
   * file exists to remove.
   *
   * So the winding is measured rather than assumed. The shoelace sum is four
   * multiplies per edge, it is exact, and it makes every caller correct by
   * construction instead of by convention.
   */
  let area2 = 0;
  for (let e = 0; e < n; e++) {
    const a = outline[e];
    const c = outline[(e + 1) % n];
    area2 += a.x * c.z - c.x * a.z;
  }
  // Reversing the LOOP rather than negating the normal, because the drift quad
  // is wound from the edge direction as well: flip only the normal and the
  // skirt faces the ground instead of the sky.
  const poly = area2 < 0 ? [...outline].reverse() : outline;

  for (let e = 0; e < n; e++) {
    const a = poly[e];
    const c = poly[(e + 1) % n];
    const ex = c.x - a.x;
    const ez = c.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 0.25) continue;
    const nx = ez / len;
    const nz = -ex / len;
    // Windward faces get roughly twice the drift of leeward ones.
    const facing = Math.cos(Math.atan2(nz, nx) - wind);
    const exposure = 0.55 + 0.45 * facing;

    const steps = Math.max(2, Math.round(len / 0.85));
    let prevOutX = 0, prevOutZ = 0, prevOutY = 0, prevInY = 0, prevInX = 0, prevInZ = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + ex * t;
      const pz = a.z + ez * t;
      const g = groundAt(px, pz);
      // Two incommensurate sines plus noise from the stream: the drift varies
      // along the wall instead of being a constant-section moulding.
      const wave = 0.5 + 0.5 * Math.sin(px * 0.9 + pz * 0.7) * Math.sin(pz * 1.7 - px * 0.4);
      const h = (0.1 + wave * 0.34) * exposure * amount + rng.range(-0.03, 0.05);
      const d = (0.42 + wave * 1.05) * exposure * amount;
      const outX = px + nx * d;
      const outZ = pz + nz * d;
      const outY = groundAt(outX, outZ) - 0.06;
      const inX = px - nx * 0.12;
      const inZ = pz - nz * 0.12;
      const inY = g + Math.max(0.05, h);
      if (s > 0) {
        sand.quad(
          _t0.set(prevInX, prevInY, prevInZ),
          _t1.set(inX, inY, inZ),
          _t2.set(outX, outY, outZ),
          _skirtD.set(prevOutX, prevOutY, prevOutZ),
          1,
        );
      }
      prevInX = inX; prevInZ = inZ; prevInY = inY;
      prevOutX = outX; prevOutZ = outZ; prevOutY = outY;
    }

    // Rubble along the foot, and scatter beyond it.
    const chunks = Math.max(1, Math.round(len / 1.35));
    for (let i = 0; i < chunks; i++) {
      const t = (i + rng.range(0.15, 0.85)) / chunks;
      const px = a.x + ex * t + nx * rng.range(0.05, 0.5);
      const pz = a.z + ez * t + nz * rng.range(0.05, 0.5);
      const s = rng.range(0.13, 0.36) * (0.7 + amount * 0.4);
      rock(b, rng.bool(0.62) ? rubbleMat : sandMat, px, groundAt(px, pz) + s * 0.32, pz, s, s * rng.range(0.4, 0.75), s * rng.range(0.7, 1.3), rng, 5);
    }
    if (!opts.noScatter) {
      const scatter = Math.max(1, Math.round(len / 2.6));
      for (let i = 0; i < scatter; i++) {
        // Distance falloff: r = 1 - sqrt(u) concentrates chunks near the wall,
        // which is where wash and spall actually accumulate.
        const u = rng.next();
        const dist = 0.6 + (1 - Math.sqrt(u)) * 2.4;
        const t = rng.next();
        const px = a.x + ex * t + nx * dist + rng.range(-0.4, 0.4);
        const pz = a.z + ez * t + nz * dist + rng.range(-0.4, 0.4);
        const s = rng.range(0.07, 0.2);
        rock(b, rng.bool(0.5) ? rubbleMat : sandMat, px, groundAt(px, pz) + s * 0.25, pz, s, s * 0.5, s * 1.1, rng, 5);
      }
    }
  }
}

const _skirtD = new THREE.Vector3();

/**
 * A free-standing rubble pile — collapsed corner, bomb spoil, a heap of block
 * swept off the street. Emits a collider so it is real cover, and a nav deck so
 * bots will actually climb the shallow ones.
 */
export function rubblePile(
  b: LevelBuild,
  x: number, z: number, groundY: number,
  radius: number, height: number,
  rng: Rng,
  mat: MatKey = 'rubble',
): void {
  const count = Math.max(6, Math.round(radius * radius * 4));
  for (let i = 0; i < count; i++) {
    // Golden-angle disc sampling: even coverage with no ring artefact.
    const a = i * 2.39996323;
    const r = Math.sqrt((i + 0.4) / count) * radius;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const falloff = 1 - (r / radius) * (r / radius);
    const s = rng.range(0.16, 0.44) * (0.5 + falloff);
    rock(b, rng.bool(0.75) ? mat : 'sand', px, groundY + height * falloff * rng.range(0.25, 0.8), pz, s, s * rng.range(0.5, 0.9), s * rng.range(0.8, 1.3), rng, 5);
  }
  // One coarse collider for the whole pile: chasing the silhouette with dozens
  // of little boxes is how you turn a decorative heap into 4% of the physics
  // frame for no gameplay difference.
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, groundY + height * 0.38, z),
    shape: { kind: 'cylinder', halfHeight: height * 0.38, radius: radius * 0.82 },
    surface: SurfaceId.Rubble,
    group: CollisionGroup.Prop,
  });
  b.blocker(x, z, radius * 0.7, radius * 0.7, 0, groundY, groundY + height * 0.7);
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(x, groundY + height * 0.38, z),
    half: new THREE.Vector3(radius * 0.8, height * 0.38, radius * 0.8),
    groundY,
  });
}
