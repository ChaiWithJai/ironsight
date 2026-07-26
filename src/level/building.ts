/**
 * THE BUILDING GRAMMAR.
 *
 * OWNER: LEVEL.
 *
 * footprint → plinth → floors → facade → openings → roof → parapet → details →
 * ground transition. One function, run 130-odd times with a different stream,
 * and no two results the same.
 *
 * The three rules that do most of the work:
 *
 *  1. NOTHING IS PLUMB. Every building gets a lean of 0.25–1.1° about a random
 *     horizontal axis, applied above the plinth so the base still meets the
 *     ground. Over a 12 m facade that is 5–23 cm of drift — far too small to
 *     read as a mistake and far too large to read as a machine. Perfect
 *     verticals across a whole town are the single loudest procedural tell
 *     after the ground seam.
 *  2. FLOORS ARE NOT STACKED PRISMS. Each storey's plan is offset and inset by a
 *     few centimetres from the one below, and the joint is covered by a string
 *     course. That gives every facade a strong horizontal shadow line per floor
 *     at golden hour, for four boxes.
 *  3. THE ROOFLINE CARRIES THE SILHOUETTE. Parapets with broken sections, water
 *     tanks, dishes, aerials, rebar stubs, stair head-houses. From ALPHA you see
 *     eighty rooflines and nothing else; a clean one reads as unbuilt.
 *
 * Colliders: a SOLID building emits exactly ONE box for the whole massing.
 * Chasing the facade with per-wall boxes triples the physics body count for a
 * difference no player can perceive, because they cannot get inside. Enterable
 * buildings pay for four wall boxes plus floor slabs, and they earn it.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import { facadeOpenings, wallPanel, type Opening } from '@/level/kit/wall';
import {
  acUnit, aerial, chimney, drainpipe, conduit, railing, rebarStubs,
  satelliteDish, shopSign, stairs, waterTank,
} from '@/level/kit/detail';
import { groundSkirt, type Pt2 } from '@/level/kit/ground';
import { WALL_MATS, type MatKey } from '@/level/materials';

export type PlotStyle = 'town' | 'grand' | 'harbour' | 'shack' | 'compound';

export interface Plot {
  /** World centre. */
  x: number;
  z: number;
  /** Half extents along the plot's local X and Z. */
  hx: number;
  hz: number;
  yaw: number;
  style: PlotStyle;
  /** Which local face fronts the street: 0 = +Z, 1 = +X, 2 = −Z, 3 = −X. */
  streetSide: number;
  /** Party walls: no outer face and no windows on these sides. */
  party: readonly [boolean, boolean, boolean, boolean];
  /** Floors, or 0 to let the grammar pick. */
  floors?: number;
  /** Hollow ground floor with a through-route — flanking geometry. */
  enterable?: boolean;
  /** External stair to the roof, which also makes the roof a nav deck. */
  roofStair?: boolean;
}

export interface BuildingResult {
  readonly roofY: number;
  readonly baseY: number;
  /** World outline of the plinth, for street dressing and vegetation carve-outs. */
  readonly outline: Pt2[];
}

const STYLE_FLOORS: Record<PlotStyle, [number, number]> = {
  town: [2, 4],
  grand: [3, 5],
  harbour: [1, 2],
  shack: [1, 1],
  compound: [1, 2],
};

/** Local-frame start point and yaw of wall side `i` (0=+Z, 1=+X, 2=−Z, 3=−X). */
function sideFrame(i: number, hx: number, hz: number): { m: THREE.Matrix4; width: number } {
  const rot = (i * Math.PI) / 2;
  const starts: [number, number][] = [
    [-hx, hz],
    [hx, hz],
    [hx, -hz],
    [-hx, -hz],
  ];
  const [sx, sz] = starts[i];
  const m = new THREE.Matrix4().makeTranslation(sx, 0, sz).multiply(new THREE.Matrix4().makeRotationY(rot));
  return { m, width: i % 2 === 0 ? hx * 2 : hz * 2 };
}

export function buildBuilding(
  b: LevelBuild,
  plot: Plot,
  groundAt: (x: number, z: number) => number,
  rng: Rng,
): BuildingResult {
  const cos = Math.cos(plot.yaw);
  const sin = Math.sin(plot.yaw);
  const toWorld = (lx: number, lz: number): Pt2 => ({
    x: plot.x + lx * cos + lz * sin,
    z: plot.z - lx * sin + lz * cos,
  });

  // ---- ground fit --------------------------------------------------------
  const corners: Pt2[] = [
    toWorld(-plot.hx, plot.hz),
    toWorld(plot.hx, plot.hz),
    toWorld(plot.hx, -plot.hz),
    toWorld(-plot.hx, -plot.hz),
  ];
  let gMin = Infinity;
  let gMax = -Infinity;
  for (const c of corners) {
    const h = groundAt(c.x, c.z);
    if (h < gMin) gMin = h;
    if (h > gMax) gMax = h;
  }
  // Sample the middle of each edge too: a footprint that spans a crown would
  // otherwise float in the middle.
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const c = corners[(i + 1) % 4];
    const h = groundAt((a.x + c.x) / 2, (a.z + c.z) / 2);
    if (h > gMax) gMax = h;
    if (h < gMin) gMin = h;
  }
  const plinthH = rng.range(0.18, 0.5);
  const baseY = gMax + plinthH;

  const [fMin, fMax] = STYLE_FLOORS[plot.style];
  const floors = plot.floors ?? Math.round(rng.range(fMin, fMax));
  const groundH = rng.range(3.05, 3.85);
  const upperH = rng.range(2.75, 3.25);
  const totalH = groundH + upperH * (floors - 1);
  const roofY = baseY + totalH;

  const wallMat: MatKey =
    plot.style === 'harbour'
      ? rng.pick(['concrete', 'plasterOchre', 'sandstone'] as MatKey[])
      : plot.style === 'shack'
        ? rng.pick(['wood', 'rust', 'plasterOchre'] as MatKey[])
        : plot.style === 'grand'
          ? rng.pick(['sandstone', 'plasterWhite', 'plasterOchre'] as MatKey[])
          : rng.pick(WALL_MATS);
  const trimMat: MatKey = rng.bool(0.7) ? 'sandstone' : 'concrete';
  const wallT = plot.style === 'shack' ? 0.16 : rng.range(0.3, 0.46);

  // ---- frames ------------------------------------------------------------
  // Upright frame: the plinth and the ground skirt live here, so the building
  // meets the terrain square even though everything above it does not.
  const upright = new THREE.Matrix4()
    .makeTranslation(plot.x, baseY, plot.z)
    .multiply(new THREE.Matrix4().makeRotationY(plot.yaw));
  b.xf.pushAbsolute(upright);

  // Plinth: driven a full 1.6 m below the LOWEST corner so a building on a
  // slope never shows daylight under an edge. This is invisible and load
  // bearing; the alternative is a floating house on every gradient in the map.
  const plinthOver = rng.range(0.05, 0.16);
  b.m(trimMat).boxAt(
    0, -(gMax - gMin + 1.6 + plinthH) / 2 + 0.001,
    0,
    plot.hx + plinthOver, (gMax - gMin + 1.6 + plinthH) / 2, plot.hz + plinthOver,
    1, 0x3f,
  );
  b.xf.pop();

  // Leaning frame for everything above the plinth.
  const leanAxis = rng.range(0, Math.PI * 2);
  const leanAmt = rng.range(0.0045, 0.019);
  const lean = new THREE.Matrix4()
    .makeRotationAxis(new THREE.Vector3(Math.cos(leanAxis), 0, Math.sin(leanAxis)).normalize(), leanAmt);
  const frame = upright.clone().multiply(lean);
  b.xf.pushAbsolute(frame);

  // ---- floors ------------------------------------------------------------
  let y = 0;
  const jettySide = plot.streetSide;
  const doorSide = plot.streetSide;
  const doorBay = Math.round(rng.range(0, 3));
  const enterable = plot.enterable === true;

  for (let f = 0; f < floors; f++) {
    const fh = f === 0 ? groundH : upperH;
    // Per-storey plan wobble. The jetty is only ever over the street.
    const jetty = f > 0 && rng.bool(0.3) ? rng.range(0.16, 0.42) : 0;
    for (let side = 0; side < 4; side++) {
      if (plot.party[side]) continue;
      const grow = (side === jettySide ? jetty : 0) + rng.range(-0.035, 0.035);
      const hx = plot.hx + (side % 2 === 1 ? grow : 0);
      const hz = plot.hz + (side % 2 === 0 ? grow : 0);
      const { m, width } = sideFrame(side, hx, hz);
      b.xf.push(m);
      const isStreet = side === plot.streetSide;
      let openings: Opening[] = [];
      if (plot.style === 'shack') {
        openings = f === 0 && isStreet
          ? [{ x0: width / 2 - 0.5, x1: width / 2 + 0.5, y0: 0.02, y1: 1.95, kind: 'door', glass: false }]
          : rng.bool(0.5)
            ? [{ x0: width / 2 - 0.4, x1: width / 2 + 0.4, y0: 1.1, y1: 1.8, kind: 'window', glass: true, shutter: 0 }]
            : [];
      } else {
        openings = facadeOpenings(width, 0, fh, f, floors, rng, {
          street: isStreet,
          doorAt: f === 0 && side === doorSide ? doorBay : undefined,
          arch: plot.style === 'grand' || (plot.style === 'town' && rng.bool(0.3)),
        });
      }
      wallPanel(
        b,
        {
          width,
          height: fh,
          thickness: wallT,
          mat: wallMat,
          trim: trimMat,
          openings,
          base: 0,
          through: enterable && f === 0,
          reveal: rng.range(0.16, 0.28),
          uvScale: 1,
        },
        rng,
      );
      b.xf.pop();
    }

    // String course over the joint between storeys. Also the thing that stops
    // the per-storey plan wobble reading as an error.
    if (f < floors - 1) {
      const band = rng.range(0.06, 0.13);
      b.m(trimMat).boxAt(0, y + fh + band / 2, 0, plot.hx + 0.07, band / 2, plot.hz + 0.07, 1, 0x3f);
    }

    // Interior floor slab.
    if (enterable) {
      b.m('concrete').boxAt(0, y + fh + 0.09, 0, plot.hx - wallT + 0.02, 0.09, plot.hz - wallT + 0.02, 1, 0x3f);
    }
    y += fh;
  }

  // ---- roof --------------------------------------------------------------
  const pitched = plot.style !== 'harbour' && plot.style !== 'compound' && rng.bool(0.22);
  const roofSlabT = 0.22;
  b.m('concrete').boxAt(0, totalH + roofSlabT / 2, 0, plot.hx + 0.05, roofSlabT / 2, plot.hz + 0.05, 1, 0x3f);
  const deckY = totalH + roofSlabT;

  if (pitched) {
    // Shallow hipped tile roof. Two slopes plus two hip triangles.
    const rise = rng.range(0.9, 1.6);
    const over = 0.28;
    const g = b.m('tile');
    const X = plot.hx + over;
    const Z = plot.hz + over;
    const ridgeZ = rng.range(-0.12, 0.12);
    const p = (x: number, yy: number, z: number, i: number): THREE.Vector3 => _rp[i].set(x, yy, z);
    g.quad(p(-X, deckY, Z, 0), p(X, deckY, Z, 1), p(X, deckY + rise, ridgeZ, 2), p(-X, deckY + rise, ridgeZ, 3), 1);
    g.quad(p(X, deckY, -Z, 0), p(-X, deckY, -Z, 1), p(-X, deckY + rise, ridgeZ, 2), p(X, deckY + rise, ridgeZ, 3), 1);
    g.triangle(p(X, deckY, Z, 0), p(X, deckY, -Z, 1), p(X, deckY + rise, ridgeZ, 2), 1);
    g.triangle(p(-X, deckY, -Z, 0), p(-X, deckY, Z, 1), p(-X, deckY + rise, ridgeZ, 2), 1);
    // Ridge cap, and a course of pantiles at the eaves so the edge has depth.
    b.m('tile').boxAt(0, deckY + rise + 0.05, ridgeZ, X, 0.055, 0.09, 1, 0x3f);
    for (const sz of [1, -1]) {
      b.m('tile').boxAt(0, deckY + 0.05, sz * Z, X, 0.055, 0.06, 1, 0x3f);
    }
    if (rng.bool(0.5)) chimney(b, rng.range(-plot.hx * 0.5, plot.hx * 0.5), deckY + rise * 0.4, ridgeZ + rng.range(-0.4, 0.4), rng);
  } else {
    // ---- parapet -----------------------------------------------------------
    const pH = rng.range(0.55, 1.15);
    const pT = rng.range(0.16, 0.26);
    const gap = rng.bool(0.35) ? rng.int(4) : -1;
    for (let side = 0; side < 4; side++) {
      const along = side % 2 === 0 ? plot.hx : plot.hz;
      const outw = side % 2 === 0 ? plot.hz : plot.hx;
      const sgn = side === 0 || side === 1 ? 1 : -1;
      const h = side === gap ? pH * rng.range(0.25, 0.5) : pH;
      const cx = side % 2 === 0 ? 0 : sgn * (outw + 0.05 - pT / 2);
      const cz = side % 2 === 0 ? sgn * (outw + 0.05 - pT / 2) : 0;
      const hxx = side % 2 === 0 ? along + 0.05 : pT / 2;
      const hzz = side % 2 === 0 ? pT / 2 : along + 0.05;
      b.m(wallMat).boxAt(cx, deckY + h / 2, cz, hxx, h / 2, hzz, 1, 0x3f);
      // Coping course, slightly proud — the shadow line that gives a flat roof
      // an edge instead of a termination.
      b.m(trimMat).boxAt(cx, deckY + h + 0.035, cz, hxx + 0.045, 0.04, hzz + 0.045, 1, 0x3f);
      if (side === gap && rng.bool(0.7)) {
        // Collapsed section: a few blocks tumbled onto the roof.
        for (let i = 0; i < 4; i++) {
          b.m(trimMat).boxAt(
            cx + rng.range(-along * 0.6, along * 0.6),
            deckY + 0.09,
            cz + rng.range(-0.5, 0.5) * (side % 2 === 0 ? 1 : 0) + (side % 2 === 1 ? rng.range(-0.5, 0.5) : 0),
            rng.range(0.1, 0.22), 0.09, rng.range(0.1, 0.22), 1, 0x3f,
          );
        }
      }
    }

    // ---- roof clutter ------------------------------------------------------
    const area = plot.hx * plot.hz * 4;
    const items = Math.max(2, Math.min(9, Math.round(area / 16 + rng.range(1, 3))));
    for (let i = 0; i < items; i++) {
      const rx = rng.range(-plot.hx + 0.7, plot.hx - 0.7);
      const rz = rng.range(-plot.hz + 0.7, plot.hz - 0.7);
      const pick = rng.next();
      if (pick < 0.3) waterTank(b, rx, deckY, rz, rng);
      else if (pick < 0.5) satelliteDish(b, rx, deckY, rz, rng);
      else if (pick < 0.62) acUnit(b, rx, deckY, rz, rng.range(0, Math.PI * 2), rng);
      else if (pick < 0.72) aerial(b, rx, deckY, rz, rng);
      else if (pick < 0.82) rebarStubs(b, rx, deckY + 0.14, rz, rng);
      else if (pick < 0.9) {
        // Stacked crates / a covered pile.
        const n = 1 + rng.int(3);
        for (let k = 0; k < n; k++) {
          b.m('wood').boxAt(rx + rng.range(-0.2, 0.2), deckY + 0.22 + k * 0.42, rz + rng.range(-0.2, 0.2), 0.3, 0.21, 0.3, 1, 0x3f);
        }
      } else {
        chimney(b, rx, deckY, rz, rng);
      }
    }
    // A stair head-house on the taller buildings — the thing that explains how
    // anyone gets onto the roof.
    if (floors >= 3 && rng.bool(0.55)) {
      const hx = rng.range(0.85, 1.25);
      const hz = rng.range(0.85, 1.25);
      const px = rng.range(-plot.hx + hx + 0.3, plot.hx - hx - 0.3);
      const pz = rng.range(-plot.hz + hz + 0.3, plot.hz - hz - 0.3);
      b.solid(wallMat, px, deckY + 1.15, pz, hx, 1.15, hz, { groundY: deckY });
      b.m(trimMat).boxAt(px, deckY + 2.34, pz, hx + 0.07, 0.06, hz + 0.07, 1, 0x3f);
      b.m('paint').boxAt(px, deckY + 1.0, pz + hz + 0.01, 0.42, 0.98, 0.04, 1, 0x3f);
    }
  }

  // ---- facade furniture ---------------------------------------------------
  // Drainpipe on one or two corners only. Symmetry here is worse than nothing.
  const cornerList: [number, number][] = [
    [plot.hx - 0.1, plot.hz - 0.1],
    [-plot.hx + 0.1, plot.hz - 0.1],
    [plot.hx - 0.1, -plot.hz + 0.1],
    [-plot.hx + 0.1, -plot.hz + 0.1],
  ];
  const pipes = 1 + (rng.bool(0.4) ? 1 : 0);
  for (let i = 0; i < pipes; i++) {
    const c = rng.pick(cornerList);
    drainpipe(b, c[0], c[1], deckY - 0.1, 0.1, rng);
  }
  if (rng.bool(0.55)) {
    const c = rng.pick(cornerList);
    conduit(b, c[0] * 0.6, c[1] * 1.02, 0.4, totalH * rng.range(0.4, 0.9), rng);
  }
  if (plot.streetSide >= 0 && rng.bool(0.3)) {
    const s = sideFrame(plot.streetSide, plot.hx + 0.02, plot.hz + 0.02);
    b.xf.push(s.m);
    shopSign(b, s.width * rng.range(0.25, 0.75), groundH - rng.range(0.3, 0.7), 0.05, rng);
    b.xf.pop();
  }
  // A patched repair: a rectangle of different render, proud of the wall.
  if (rng.bool(0.55)) {
    const s = sideFrame(rng.int(4), plot.hx + 0.015, plot.hz + 0.015);
    b.xf.push(s.m);
    b.m(rng.pick(['concrete', 'sandstone', 'plasterOchre'] as MatKey[])).boxAt(
      s.width * rng.range(0.2, 0.8),
      rng.range(0.4, totalH - 1.2),
      0.03,
      rng.range(0.5, 1.6), rng.range(0.4, 1.4), 0.035,
      1, 0x3f,
    );
    b.xf.pop();
  }
  // Air-con on a facade, bracketed under a window.
  if (rng.bool(0.6)) {
    const side = rng.int(4);
    if (!plot.party[side]) {
      const s = sideFrame(side, plot.hx + 0.02, plot.hz + 0.02);
      b.xf.push(s.m);
      acUnit(b, s.width * rng.range(0.2, 0.8), groundH + rng.range(0.4, 1.4), 0.24, 0, rng);
      b.xf.pop();
    }
  }

  b.xf.pop(); // leaning frame

  // ---- colliders + nav ----------------------------------------------------
  const worldMid = new THREE.Vector3(plot.x, 0, plot.z);
  if (!enterable) {
    // ONE box for the whole massing. See the header note.
    const cy = (gMin - 1.0 + roofY) / 2;
    b.collider({
      matrix: new THREE.Matrix4()
        .makeTranslation(worldMid.x, cy, worldMid.z)
        .multiply(new THREE.Matrix4().makeRotationY(plot.yaw)),
      shape: { kind: 'box', half: new THREE.Vector3(plot.hx + 0.05, (roofY - (gMin - 1.0)) / 2, plot.hz + 0.05) },
      surface: SurfaceId.Stucco,
      group: CollisionGroup.StaticGeo,
      // Buildings are exactly what the software occlusion raster wants: box-like
      // and discrete. Only the big ones are worth a slot out of the 48.
      occluder: plot.hx * plot.hz > 34,
    });
  } else {
    for (let side = 0; side < 4; side++) {
      const { m, width } = sideFrame(side, plot.hx, plot.hz);
      const world = new THREE.Matrix4()
        .multiplyMatrices(
          new THREE.Matrix4().makeTranslation(plot.x, baseY, plot.z).multiply(new THREE.Matrix4().makeRotationY(plot.yaw)),
          m,
        )
        .multiply(new THREE.Matrix4().makeTranslation(width / 2, totalH / 2, -wallT / 2));
      b.collider({
        matrix: world,
        shape: { kind: 'box', half: new THREE.Vector3(width / 2, totalH / 2, wallT / 2) },
        surface: SurfaceId.Stucco,
        group: CollisionGroup.StaticGeo,
      });
    }
    b.collider({
      matrix: new THREE.Matrix4().makeTranslation(plot.x, baseY - 0.1, plot.z),
      shape: { kind: 'box', half: new THREE.Vector3(plot.hx, 0.6, plot.hz) },
      surface: SurfaceId.Tile,
      group: CollisionGroup.StaticGeo,
    });
    b.deck(plot.x, baseY, plot.z, plot.hx - wallT - 0.1, plot.hz - wallT - 0.1, plot.yaw, 0);
  }
  b.blocker(plot.x, plot.z, plot.hx + 0.1, plot.hz + 0.1, plot.yaw, gMin - 1, roofY);
  b.exclude(plot.x, plot.z, Math.max(plot.hx, plot.hz) + 1.4);

  // ---- external roof stair, and the roof as a nav deck --------------------
  if (plot.roofStair && !pitched) {
    const side = (plot.streetSide + 2) % 4;
    const { m } = sideFrame(side, plot.hx + 1.05, plot.hz + 1.05);
    const world = new THREE.Matrix4()
      .multiplyMatrices(
        new THREE.Matrix4().makeTranslation(plot.x, baseY, plot.z).multiply(new THREE.Matrix4().makeRotationY(plot.yaw)),
        m,
      );
    const pos = new THREE.Vector3().setFromMatrixPosition(world);
    const yawTotal = plot.yaw - (side * Math.PI) / 2 + Math.PI;
    stairs(b, pos.x, baseY - plinthH, pos.z, yawTotal, 1.25, deckY + plinthH, deckY * 0.85, trimMat, rng, 1);
    b.deck(plot.x, baseY + deckY, plot.z, plot.hx - 0.4, plot.hz - 0.4, plot.yaw, 0);
    // A parapet you can shoot over from the roof is only cover if it is real.
    b.coverBoxes.push({
      matrix: new THREE.Matrix4().makeTranslation(plot.x, baseY + deckY + 0.45, plot.z),
      half: new THREE.Vector3(plot.hx, 0.45, plot.hz),
      groundY: baseY + deckY,
    });
  }

  // ---- ground transition --------------------------------------------------
  const outline: Pt2[] = [
    toWorld(-(plot.hx + plinthOver), plot.hz + plinthOver),
    toWorld(plot.hx + plinthOver, plot.hz + plinthOver),
    toWorld(plot.hx + plinthOver, -(plot.hz + plinthOver)),
    toWorld(-(plot.hx + plinthOver), -(plot.hz + plinthOver)),
  ];
  groundSkirt(b, outline, groundAt, rng, {
    amount: plot.style === 'shack' ? 1.35 : rng.range(0.8, 1.25),
    windDir: -0.7,
  });

  return { roofY: baseY + deckY, baseY, outline };
}

const _rp = [
  new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
];

/** Re-exported so street dressing can hang lines between two known facades. */
export { railing };
