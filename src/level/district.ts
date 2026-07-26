/**
 * DISTRICTS — blocks into plots, plots into buildings, and the streets between.
 *
 * OWNER: LEVEL.
 *
 * A block is subdivided the way a real one grew: a row of party-walled plots
 * along the street frontage, a second row behind it where the block is deep
 * enough, and a service alley between them. Party walls are what make a
 * Mediterranean town read as a town rather than as detached houses on a grid —
 * and they are free geometry, because a shared wall is a wall nobody emits.
 *
 * Roughly one plot in six deliberately breaks the terrace: a slot alley, a
 * setback, or a missing building where a courtyard sits. Those slots are the
 * flanking routes; they are placed by the same stream that places the buildings
 * so they are stable, and they are the reason the block is not one long wall.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import { buildBuilding, type Plot } from '@/level/building';
import { groundSkirt, spillTongues } from '@/level/kit/ground';
import { laundryLine, stairs } from '@/level/kit/detail';
import {
  barrel, bollard, concreteBarrier, crateStack, lowWall, marketStall,
  sandbagWall, tyreStack, utilityPole, wreckedCar,
} from '@/level/dressing';
import { BLOCKS, KEEP_CLEAR, POINTS, STREETS, type BlockDef } from '@/level/layout';

type Ground = (x: number, z: number) => number;

/**
 * DETAIL BUDGET BY DISTANCE TO THE NEAREST CAPTURE POINT.
 *
 * Full detail out to 60 m, falling to 0.3 by 190 m. The numbers come from where
 * the player's eye is: everything inside 60 m of a point is somewhere a
 * firefight physically happens and gets read at 3 m; past ~190 m a building is a
 * roofline on a skyline and its shutters cost triangles nobody sees.
 *
 * This is not a quality tier — it does not move with `QualitySettings` — it is a
 * fixed property of the level, so a shot of the fort looks the same on Low as on
 * Ultra and the review loop compares like with like.
 */
function detailAt(x: number, z: number): number {
  let best = Infinity;
  for (const p of [POINTS.alpha, POINTS.bravo, POINTS.charlie]) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < best) best = d;
  }
  if (best <= 60) return 1;
  if (best >= 190) return 0.3;
  return 1 - 0.7 * ((best - 60) / 130);
}

function clearOf(x: number, z: number, margin: number): boolean {
  for (const k of KEEP_CLEAR) {
    const d = Math.hypot(x - k.x, z - k.z);
    if (d < k.r + margin) return false;
  }
  return true;
}

/** Distance from a point to the nearest street centreline. */
export function streetDistance(x: number, z: number): number {
  let best = Infinity;
  for (const s of STREETS) {
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i];
      const c = s.pts[i + 1];
      const vx = c.x - a.x;
      const vz = c.z - a.z;
      const l2 = vx * vx + vz * vz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2)) : 0;
      const d = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t)) - s.width * 0.5;
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Subdivide one block into plots.
 *
 * Local axes follow the block's yaw. `street` names which local face fronts the
 * road, so the frontage axis is X for faces 0/2 and Z for faces 1/3.
 */
function subdivide(block: BlockDef, ground: Ground, rng: Rng): Plot[] {
  const out: Plot[] = [];
  const alongIsX = block.street % 2 === 0;
  const alongHalf = alongIsX ? block.hx : block.hz;
  const depthHalf = alongIsX ? block.hz : block.hx;
  const frontSign = block.street === 0 || block.street === 1 ? 1 : -1;

  // Two rows with a 2.4 m service alley once the block is deep enough to hold
  // them; otherwise one deep row.
  const rows: { depthCentre: number; depthHalf: number; side: number }[] = [];
  if (depthHalf > 9.5) {
    const alley = 1.2;
    const rowDepth = (depthHalf - alley) / 2;
    rows.push({ depthCentre: frontSign * (depthHalf - rowDepth), depthHalf: rowDepth, side: block.street });
    rows.push({ depthCentre: -frontSign * (depthHalf - rowDepth), depthHalf: rowDepth, side: (block.street + 2) % 4 });
  } else {
    rows.push({ depthCentre: 0, depthHalf, side: block.street });
  }

  const cos = Math.cos(block.yaw);
  const sin = Math.sin(block.yaw);

  for (const row of rows) {
    const n = Math.max(1, Math.round((alongHalf * 2) / block.grain));
    const span = (alongHalf * 2) / n;
    // A "break" index gets no building: the slot alley through the terrace.
    const breakAt = n >= 3 && rng.bool(0.55) ? 1 + rng.int(n - 2) : -1;
    for (let i = 0; i < n; i++) {
      if (i === breakAt) continue;
      const alongC = -alongHalf + (i + 0.5) * span;
      const gap = rng.range(0.12, 0.5);
      const halfAlong = span / 2 - gap;
      if (halfAlong < 1.8) continue;
      const setback = rng.bool(0.22) ? rng.range(0.4, 1.5) : 0;
      const halfDepth = row.depthHalf - setback / 2;
      if (halfDepth < 2.2) continue;
      const depthC = row.depthCentre - Math.sign(row.depthCentre || frontSign) * setback / 2;

      const lx = alongIsX ? alongC : depthC;
      const lz = alongIsX ? depthC : alongC;
      const wx = block.x + lx * cos + lz * sin;
      const wz = block.z - lx * sin + lz * cos;

      if (!clearOf(wx, wz, Math.max(halfAlong, halfDepth) * 0.7)) continue;
      // Never in the water, and never so steep the plinth cannot swallow it.
      const g = ground(wx, wz);
      if (g < 1.4) continue;
      const dh = Math.max(
        Math.abs(ground(wx + 5, wz) - g),
        Math.abs(ground(wx - 5, wz) - g),
        Math.abs(ground(wx, wz + 5) - g),
        Math.abs(ground(wx, wz - 5) - g),
      );
      if (dh > 4.2) continue;
      // A plot straddling a street centreline would put a house in the road.
      if (streetDistance(wx, wz) < 1.0) continue;

      const isEnd = i === 0 || i === n - 1 || i === breakAt - 1 || i === breakAt + 1;
      const party: [boolean, boolean, boolean, boolean] = [false, false, false, false];
      if (!isEnd && n > 1 && rng.bool(0.82)) {
        if (alongIsX) {
          party[1] = true;
          party[3] = true;
        } else {
          party[0] = true;
          party[2] = true;
        }
      }
      out.push({
        x: wx,
        z: wz,
        hx: alongIsX ? halfAlong : halfDepth,
        hz: alongIsX ? halfDepth : halfAlong,
        yaw: block.yaw + rng.range(-0.022, 0.022),
        style: block.style,
        streetSide: row.side,
        party,
        // The market-square frontage and the harbour sheds get through-routes.
        // A building close to a point is far more likely to be enterable: a
        // through-route 200 m from any objective is a route nobody takes.
        enterable: rng.bool((block.style === 'harbour' ? 0.45 : 0.16) * (0.35 + detailAt(wx, wz) * 0.9)),
        roofStair: rng.bool(block.style === 'town' ? 0.3 : 0.12),
        detail: detailAt(wx, wz),
      });
    }
  }
  return out;
}

export function generatePlots(ground: Ground, rng: Rng): Plot[] {
  const out: Plot[] = [];
  for (const block of BLOCKS) out.push(...subdivide(block, ground, rng));
  return out;
}

export function buildTown(b: LevelBuild, plots: readonly Plot[], ground: Ground, rng: Rng): void {
  const roofs: { x: number; z: number; y: number; hx: number; hz: number }[] = [];
  for (const p of plots) {
    const r = buildBuilding(b, p, ground, rng);
    roofs.push({ x: p.x, z: p.z, y: r.roofY, hx: p.hx, hz: p.hz });

    /**
     * COMPOUND WALLS. The `compound` plots on the west slope are farmsteads,
     * and a farmstead is a walled yard with a house in the corner, not a
     * detached villa. The wall is what turns the headland road from an open
     * approach into a sequence of enclosures you have to clear — and it is the
     * only piece of hard cover between the town and CHARLIE.
     */
    if (p.style === 'compound') {
      const yardSide = (p.streetSide + 2) % 4;
      const out = yardSide === 0 || yardSide === 1 ? 1 : -1;
      const depth = Math.max(p.hx, p.hz) * 1.5 + 4;
      const cos = Math.cos(p.yaw);
      const sin = Math.sin(p.yaw);
      const w = (lx: number, lz: number): [number, number] => [
        p.x + lx * cos + lz * sin,
        p.z - lx * sin + lz * cos,
      ];
      const ax = yardSide % 2 === 0 ? p.hx + 1.5 : out * depth;
      const az = yardSide % 2 === 0 ? out * depth : p.hz + 1.5;
      const corners: [number, number][] = [
        w(yardSide % 2 === 0 ? -ax : (out > 0 ? p.hx : -p.hx), yardSide % 2 === 0 ? (out > 0 ? p.hz : -p.hz) : -az),
        w(yardSide % 2 === 0 ? -ax : ax, yardSide % 2 === 0 ? az : -az),
        w(ax, az),
        w(yardSide % 2 === 0 ? ax : (out > 0 ? p.hx : -p.hx), yardSide % 2 === 0 ? (out > 0 ? p.hz : -p.hz) : az),
      ];
      for (let i = 0; i < corners.length - 1; i++) {
        lowWall(b, corners[i][0], corners[i][1], corners[i + 1][0], corners[i + 1][1], ground, rng.range(1.9, 2.4), rng);
      }
      // What is in the yard: a fuel drum, a stack of feed crates, a wreck.
      for (let i = 0; i < 3; i++) {
        const lx = rng.range(-Math.abs(ax) * 0.6, Math.abs(ax) * 0.6);
        const lz = rng.range(-Math.abs(az) * 0.6, Math.abs(az) * 0.6);
        const [px, pz] = w(lx, lz);
        const g = ground(px, pz);
        if (g < 1.4) continue;
        if (rng.bool(0.4)) barrel(b, px, g, pz, rng);
        else if (rng.bool(0.5)) crateStack(b, px, g, pz, rng);
        else tyreStack(b, px, g, pz, rng);
      }
    }
  }
  // Lines across the alleys: only between facades close enough to string one,
  // which is what makes them land in the alleys and nowhere else.
  for (let i = 0; i < roofs.length; i++) {
    for (let j = i + 1; j < roofs.length; j++) {
      const a = roofs[i];
      const c = roofs[j];
      const d = Math.hypot(a.x - c.x, a.z - c.z);
      const reach = Math.max(a.hx, a.hz) + Math.max(c.hx, c.hz);
      if (d < reach + 9 && d > reach + 2 && rng.bool(0.35)) {
        const t = 0.62;
        laundryLine(
          b,
          a.x + (c.x - a.x) * (1 - t) * 0.25, Math.min(a.y, c.y) - rng.range(1.5, 4.5), a.z + (c.z - a.z) * (1 - t) * 0.25,
          c.x - (c.x - a.x) * (1 - t) * 0.25, Math.min(a.y, c.y) - rng.range(1.5, 4.5), c.z - (c.z - a.z) * (1 - t) * 0.25,
          rng,
        );
      }
    }
  }
}

/**
 * Paving. A strip along each street centreline, laid on the terrain plus 7 cm,
 * with a kerb either side and sand washed over both edges.
 *
 * The paving is DELIBERATELY not a collider: the terrain underneath already is
 * one, and a 7 cm slab you can trip on is a character-controller bug waiting to
 * happen. It is a visual layer and nothing else.
 */
export function buildStreets(b: LevelBuild, ground: Ground, rng: Rng): void {
  for (const s of STREETS) {
    const half = s.width / 2;
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i];
      const c = s.pts[i + 1];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      const steps = Math.max(2, Math.round(len / 4));
      const nx = (c.z - a.z) / len;
      const nz = -(c.x - a.x) / len;
      const g = b.m('concrete');
      const kerb = b.m('sandstone');
      let prev: { lx: number; lz: number; ly: number; rx: number; rz: number; ry: number } | null = null;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const px = a.x + (c.x - a.x) * t;
        const pz = a.z + (c.z - a.z) * t;
        const w = half * (0.92 + 0.16 * Math.sin(px * 0.31 + pz * 0.17));
        const lx = px + nx * w;
        const lz = pz + nz * w;
        const rx = px - nx * w;
        const rz = pz - nz * w;
        const ly = ground(lx, lz) + 0.07;
        const ry = ground(rx, rz) + 0.07;
        if (prev) {
          g.quad(
            _v[0].set(prev.lx, prev.ly, prev.lz),
            _v[1].set(lx, ly, lz),
            _v[2].set(rx, ry, rz),
            _v[3].set(prev.rx, prev.ry, prev.rz),
            0.5,
          );
          /**
           * KERBS — laid as SETTS, not as an extrusion.
           *
           * These used to be one 0.13 × 0.13 box per paving step, all the same
           * height, all exactly end to end, and round 2 named it: *"one unbroken
           * extruded prism with a constant triangular profile: no breaks, no sag,
           * no missing sections, no chips."* A real kerb is 1 m stones bedded by
           * hand on sand, and after thirty years of lorries they sit at slightly
           * different heights, they rock, one in ten has been knocked out and
           * never replaced, and every arris is chipped.
           *
           * So: 0.9–1.4 m setts along the edge, each with its own height, cross
           * fall, yaw and lateral offset; a chamfer so the raking sun catches the
           * arris; and two failure modes drawn per stone — MISSING (nothing but
           * the sand drift, which the skirt below fills) and SUNK (dropped 6–11 cm
           * and tipped, the classic settled sett).
           */
          for (const [ax, az, ay, bx, bz, by] of [
            [prev.lx, prev.lz, prev.ly, lx, lz, ly],
            [prev.rx, prev.rz, prev.ry, rx, rz, ry],
          ] as const) {
            const run = Math.hypot(bx - ax, bz - az);
            const yaw = Math.atan2(bx - ax, bz - az);
            const setts = Math.max(1, Math.round(run / 1.15));
            for (let q = 0; q < setts; q++) {
              if (rng.bool(0.09)) continue; // a stone that was never put back
              const u = (q + 0.5) / setts;
              const mx = ax + (bx - ax) * u;
              const mz = az + (bz - az) * u;
              const my = ay + (by - ay) * u;
              const sunk = rng.bool(0.14);
              const half = (run / setts) * 0.5 * rng.range(0.86, 0.98);
              const m = new THREE.Matrix4()
                .makeTranslation(
                  mx + Math.cos(yaw) * rng.range(-0.03, 0.03),
                  my - 0.06 - (sunk ? rng.range(0.06, 0.11) : rng.range(-0.012, 0.018)),
                  mz - Math.sin(yaw) * rng.range(-0.03, 0.03),
                )
                .multiply(new THREE.Matrix4().makeRotationY(yaw + rng.range(-0.035, 0.035)))
                .multiply(new THREE.Matrix4().makeRotationX(sunk ? rng.range(-0.09, 0.09) : rng.range(-0.025, 0.025)))
                .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.03, 0.03)));
              b.xf.pushAbsolute(m);
              kerb.setUvShift(rng.range(0, 16), rng.range(0, 16));
              kerb.chamferBox(0, 0, 0, 0.13, 0.13 * rng.range(0.88, 1.06), half, 0.022, 1, rng, 0.28);
              kerb.clearUvShift();
              b.xf.pop();
            }
          }
        }
        prev = { lx, lz, ly, rx, rz, ry };
      }
      // Sand washed over the kerb line on both sides.
      groundSkirt(
        b,
        [
          { x: a.x + nx * half, z: a.z + nz * half },
          { x: c.x + nx * half, z: c.z + nz * half },
          { x: c.x - nx * half, z: c.z - nz * half },
          { x: a.x - nx * half, z: a.z - nz * half },
        ],
        ground,
        rng,
        { amount: 0.55, blockFraction: 0.55 },
      );
      /**
       * …and sand spilling the OTHER way, out over the paving.
       *
       * The skirt banks drift against the outside of the kerb, which fixes the
       * sand-side seam and does nothing at all for the tile side: round 2 saw
       * *"the sand-to-pavement material boundary … is a hard polygon seam with no
       * blend, no scattered grains on the tile and no wear decal."* The proper
       * fix is a height-blended material transition, which lives in a shader
       * LEVEL does not own, so the read is bought geometrically — irregular
       * tongues of sand lying 1.5 cm proud of the paving, clumped by a noise mask
       * so the boundary advances two metres onto the tile in one place and stops
       * at the kerb in the next. The `inward` normal points at the road
       * centreline, which is the paved side by construction.
       */
      for (const s of [1, -1] as const) {
        spillTongues(
          b,
          a.x + s * nx * half, a.z + s * nz * half,
          c.x + s * nx * half, c.z + s * nz * half,
          -s * nx, -s * nz,
          (gx, gz) => ground(gx, gz) + 0.07,
          rng,
          2.1,
        );
      }
    }
  }
}

/**
 * Street furniture and the cover set. Placed ALONG the street lines rather than
 * scattered, because cover that is not on a route is cover nobody uses.
 */
export function dressStreets(b: LevelBuild, ground: Ground, rng: Rng): void {
  for (const s of STREETS) {
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i];
      const c = s.pts[i + 1];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      const nx = (c.z - a.z) / len;
      const nz = -(c.x - a.x) / len;
      const yaw = Math.atan2(c.x - a.x, c.z - a.z);
      const n = Math.max(1, Math.round(len / 14));
      for (let k = 0; k < n; k++) {
        const t = (k + rng.range(0.15, 0.85)) / n;
        const side = rng.sign();
        const off = s.width * 0.5 * rng.range(0.75, 1.15) * side;
        const px = a.x + (c.x - a.x) * t + nx * off;
        const pz = a.z + (c.z - a.z) * t + nz * off;
        if (!clearOf(px, pz, 0.5)) continue;
        const g = ground(px, pz);
        if (g < 1.4) continue;
        const pick = rng.next();
        if (pick < 0.16) utilityPole(b, px, g, pz, rng);
        else if (pick < 0.32) crateStack(b, px, g, pz, rng);
        else if (pick < 0.44) barrel(b, px, g, pz, rng);
        else if (pick < 0.56) concreteBarrier(b, px, g, pz, yaw + rng.range(-0.3, 0.3), rng);
        else if (pick < 0.66) sandbagWall(b, px, g, pz, yaw + Math.PI / 2 + rng.range(-0.4, 0.4), rng.range(2.4, 4.5), 4 + rng.int(3), rng, rng.range(-0.5, 0.5));
        else if (pick < 0.74) wreckedCar(b, px, g, pz, yaw + rng.range(-0.25, 0.25), rng);
        else if (pick < 0.82) tyreStack(b, px, g, pz, rng);
        else if (pick < 0.9) bollard(b, px, g, pz, rng);
        else {
          lowWall(b, px - nx * 3, pz - nz * 3, px + nx * 3, pz + nz * 3, ground, rng.range(0.9, 1.3), rng);
        }
      }
    }
  }
}

/**
 * The market square itself: paving, stalls, a stepped fountain, and the ring of
 * cover that makes the point contestable rather than a killbox.
 */
export function buildSquare(
  b: LevelBuild,
  cx: number, cz: number, hx: number, hz: number,
  ground: Ground,
  rng: Rng,
  /**
   * The market hall's world footprint. Everything the square scatters is tested
   * against it, because a stall inside the hall's arcade is a stall wedged
   * through a stone pier — the one collision this file cannot see for itself,
   * since the hall is a landmark and landmarks own their own ground.
   */
  keepOut?: { x: number; z: number; hx: number; hz: number; yaw: number },
): void {
  const y = ground(cx, cz);
  const inKeepOut = (px: number, pz: number, margin: number): boolean => {
    if (!keepOut) return false;
    const dx = px - keepOut.x;
    const dz = pz - keepOut.z;
    const c = Math.cos(keepOut.yaw);
    const s = Math.sin(keepOut.yaw);
    return (
      Math.abs(dx * c - dz * s) < keepOut.hx + margin &&
      Math.abs(dx * s + dz * c) < keepOut.hz + margin
    );
  };
  // Paving slab. Sunk 4 cm into the terrace so its edge never shows.
  b.m('sandstone').boxAt(cx, y + 0.02, cz, hx, 0.1, hz, 0.5, 0x3f);
  b.deck(cx, y + 0.12, cz, hx, hz, 0, 0);
  groundSkirt(
    b,
    [
      { x: cx - hx, z: cz - hz }, { x: cx + hx, z: cz - hz },
      { x: cx + hx, z: cz + hz }, { x: cx - hx, z: cz + hz },
    ],
    ground, rng, { amount: 0.6, blockFraction: 0.55 },
  );
  /**
   * Sand blown IN over the paving on all four sides. Without this the square's
   * slab ends on a straight polygon edge — round 2 measured the tell as a line
   * running from (0,920) to (790,730) in `weapon_ads` — and the drift banked
   * against the outside of that edge does not hide it, because the eye reads the
   * boundary from the paved side. See `spillTongues`.
   */
  for (const [ax, az, bx, bz, ix, iz] of [
    [cx - hx, cz - hz, cx + hx, cz - hz, 0, 1],
    [cx + hx, cz + hz, cx - hx, cz + hz, 0, -1],
    [cx - hx, cz + hz, cx - hx, cz - hz, 1, 0],
    [cx + hx, cz - hz, cx + hx, cz + hz, -1, 0],
  ] as const) {
    // The slab is a single flat box at `y + 0.12`, NOT a surface that follows the
    // terrain — sampling `ground()` here would sink the tongues under it wherever
    // the terrace falls away from the square's centre.
    spillTongues(b, ax, az, bx, bz, ix, iz, () => y + 0.12, rng, 2.6);
  }

  // Stepped fountain / cistern head. The one thing in the square you can stand
  // ON as well as behind, which is what makes the middle worth holding.
  const fx = cx + hx * 0.62;
  const fz = cz - hz * 0.44;
  for (let i = 0; i < 3; i++) {
    b.solid('sandstone', fx, y + 0.11 + i * 0.22, fz, 3.1 - i * 0.75, 0.11, 3.1 - i * 0.75, { groundY: y });
  }
  b.m('sandstone').cylinder(fx, y + 0.66, fz, 1.5, 1.45, 0.62, 14, 1, true, false);
  b.m('glass').cylinder(fx, y + 1.18, fz, 1.3, 1.3, 0.03, 14, 1, true, false);
  b.m('sandstone').cylinder(fx, y + 1.18, fz, 0.28, 0.2, 1.35, 10, 1, true, false);
  b.m('sandstone').cylinder(fx, y + 2.4, fz, 0.55, 0.05, 0.4, 10, 1, true, false);
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(fx, y + 0.66, fz),
    shape: { kind: 'cylinder', halfHeight: 0.66, radius: 1.55 },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(fx, y + 0.66, fz),
    half: new THREE.Vector3(1.55, 0.66, 1.55),
    groundY: y,
  });

  // Stalls in loose rows, angled off the square's axis. Golden-angle placement
  // over a square this size gives roughly one stall per 90 m², which is what a
  // working market looks like and — more to the point — is enough soft cover
  // that crossing the open middle is a decision rather than a death sentence.
  for (let i = 0; i < 16; i++) {
    const a = i * 2.39996323;
    const r = Math.sqrt((i + 0.5) / 16) * Math.min(hx, hz) * 0.86;
    const px = cx + Math.cos(a) * r * 1.25;
    const pz = cz + Math.sin(a) * r;
    if (Math.hypot(px - fx, pz - fz) < 5) continue;
    if (inKeepOut(px, pz, 1.0)) continue;
    marketStall(b, px, ground(px, pz), pz, rng.range(0, Math.PI * 2), rng);
  }
  // Hard cover at the square's edges: barriers, sandbags, a wreck.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.3;
    const px = cx + Math.cos(a) * hx * 0.9;
    const pz = cz + Math.sin(a) * hz * 0.9;
    if (inKeepOut(px, pz, 2.4)) continue;
    const g = ground(px, pz);
    const face = Math.atan2(cx - px, cz - pz);
    if (i % 3 === 0) sandbagWall(b, px, g, pz, face, rng.range(3, 5), 5, rng, rng.range(-0.6, 0.6));
    else if (i % 3 === 1) concreteBarrier(b, px, g, pz, face, rng);
    else crateStack(b, px, g, pz, rng);
  }
  wreckedCar(b, cx - hx * 0.72, ground(cx - hx * 0.72, cz + hz * 0.5), cz + hz * 0.5, 0.9, rng);
  // Two flights down to the street on the seaward side — the square is a
  // terrace, and the stairs are how the fight arrives in it.
  for (const sx of [-0.5, 0.35]) {
    const px = cx + hx * sx;
    const pz = cz - hz - 1.2;
    stairs(b, px, ground(px, pz) - 1.6, pz, Math.PI, 3.4, 1.75, 3.6, 'sandstone', rng, 2);
  }
}

const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
