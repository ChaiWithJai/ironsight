/**
 * The wall kit — the single most-used piece of the building grammar.
 *
 * OWNER: LEVEL.
 *
 * A wall panel is authored in a LOCAL frame: it runs along +X from 0 to
 * `width`, up +Y from `base`, and its OUTWARD face is at z = 0 looking down +Z.
 * Everything else (yaw, lean, plant height) is the caller's matrix. That
 * convention is what lets the same function build a house facade, a fort
 * curtain, a warehouse gable and a market arcade.
 *
 * Openings are cut by a grid decomposition rather than by CSG: the opening
 * edges become cut lines, cells covered by an opening are skipped, and the
 * survivors are merged along X before emission. It is exact for rectangles,
 * costs nothing, and cannot produce the sliver triangles a real boolean does.
 *
 * The detail that matters most for the "is this AAA" test is the RECESS. A
 * window drawn as a dark quad flush with the facade is the flattest thing in
 * computer graphics. A window with a 0.15–0.25 m reveal has four extra faces
 * that catch the sun on one side and go black on the other, and at golden hour
 * with the sun raking along the street that single detail is most of what makes
 * a facade read as built rather than printed.
 */
import * as THREE from 'three';
import type { Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import type { MatKey } from '@/level/materials';

export type OpeningKind = 'window' | 'door' | 'arch' | 'vent' | 'void' | 'bricked';

export interface Opening {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  kind: OpeningKind;
  /** Add a glazed pane set back in the reveal. */
  glass?: boolean;
  /** 0 = none, 1 = both leaves shut, 2 = one open, 3 = one hanging off a hinge. */
  shutter?: number;
  /** Cantilevered balcony with a railing. */
  balcony?: boolean;
  /** Sun awning over the head — ground-floor shopfronts. */
  awning?: boolean;
}

export interface WallOpts {
  width: number;
  height: number;
  thickness: number;
  mat: MatKey;
  openings: readonly Opening[];
  base?: number;
  /** Cut all the way through and emit the inner face — an enterable room. */
  through?: boolean;
  /** Reveal depth on a solid wall. Ignored when `through`. */
  reveal?: number;
  uvScale?: number;
  /** Suppress the outer face (a party wall between two terraced plots). */
  noOuter?: boolean;
  /** Trim material for sills, lintels and copings. */
  trim?: MatKey;
}

const _p = [
  new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
];

/** Emit a face rectangle in the wall's local XY plane at depth `z`, facing `dir`. */
function facePanel(
  b: LevelBuild,
  mat: MatKey,
  x0: number, y0: number, x1: number, y1: number,
  z: number,
  dir: 1 | -1,
  uvScale: number,
): void {
  if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) return;
  const m = b.m(mat);
  if (dir > 0) {
    m.quad(
      _p[0].set(x0, y0, z), _p[1].set(x1, y0, z), _p[2].set(x1, y1, z), _p[3].set(x0, y1, z),
      uvScale, x0 * uvScale, y0 * uvScale,
    );
  } else {
    m.quad(
      _p[0].set(x1, y0, z), _p[1].set(x0, y0, z), _p[2].set(x0, y1, z), _p[3].set(x1, y1, z),
      uvScale, x0 * uvScale, y0 * uvScale,
    );
  }
}

/**
 * The area between a semicircular arch and the top of its bounding rectangle.
 * Cutting the arch as a rectangle and filling the spandrels back in is far
 * cheaper and far more robust than decomposing a curved hole directly.
 */
function archSpandrels(
  b: LevelBuild, mat: MatKey, o: Opening, z: number, dir: 1 | -1, uvScale: number,
): void {
  const r = (o.x1 - o.x0) / 2;
  const xc = (o.x0 + o.x1) / 2;
  const ys = o.y1 - r;
  const m = b.m(mat);
  const N = 9;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI;
    const a1 = ((i + 1) / N) * Math.PI;
    const ax = xc - Math.cos(a0) * r;
    const ay = ys + Math.sin(a0) * r;
    const bx = xc - Math.cos(a1) * r;
    const by = ys + Math.sin(a1) * r;
    if (o.y1 - ay < 1e-3 && o.y1 - by < 1e-3) continue;
    if (dir > 0) {
      m.quad(
        _p[0].set(ax, ay, z), _p[1].set(bx, by, z), _p[2].set(bx, o.y1, z), _p[3].set(ax, o.y1, z),
        uvScale, ax * uvScale, ay * uvScale,
      );
    } else {
      m.quad(
        _p[0].set(bx, by, z), _p[1].set(ax, ay, z), _p[2].set(ax, o.y1, z), _p[3].set(bx, o.y1, z),
        uvScale, ax * uvScale, ay * uvScale,
      );
    }
  }
}

/** The curved soffit of an arch, from z = `zFront` back to `zBack`. */
function archIntrados(b: LevelBuild, mat: MatKey, o: Opening, zFront: number, zBack: number, uvScale: number): void {
  const r = (o.x1 - o.x0) / 2;
  const xc = (o.x0 + o.x1) / 2;
  const ys = o.y1 - r;
  const m = b.m(mat);
  const N = 9;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI;
    const a1 = ((i + 1) / N) * Math.PI;
    const ax = xc - Math.cos(a0) * r;
    const ay = ys + Math.sin(a0) * r;
    const bx = xc - Math.cos(a1) * r;
    const by = ys + Math.sin(a1) * r;
    m.quad(
      _p[0].set(bx, by, zFront), _p[1].set(ax, ay, zFront), _p[2].set(ax, ay, zBack), _p[3].set(bx, by, zBack),
      uvScale,
    );
  }
}

/**
 * Cut `openings` out of the rectangle [0,width] × [base, base+height] and emit
 * the surviving area as merged quads.
 */
function cutFace(
  b: LevelBuild, mat: MatKey, o: WallOpts, z: number, dir: 1 | -1,
): void {
  const base = o.base ?? 0;
  const top = base + o.height;
  const uvScale = o.uvScale ?? 1;
  const xs = new Set<number>([0, o.width]);
  const ys = new Set<number>([base, top]);
  for (const op of o.openings) {
    if (op.kind === 'bricked') continue;
    xs.add(Math.max(0, op.x0));
    xs.add(Math.min(o.width, op.x1));
    ys.add(Math.max(base, op.y0));
    ys.add(Math.min(top, op.y1));
  }
  const X = [...xs].sort((a, c) => a - c);
  const Y = [...ys].sort((a, c) => a - c);
  for (let j = 0; j < Y.length - 1; j++) {
    const cy = (Y[j] + Y[j + 1]) / 2;
    let runStart = -1;
    for (let i = 0; i < X.length; i++) {
      const inRange = i < X.length - 1;
      const cx = inRange ? (X[i] + X[i + 1]) / 2 : 0;
      let covered = !inRange;
      if (inRange) {
        for (const op of o.openings) {
          if (op.kind === 'bricked') continue;
          if (cx > op.x0 && cx < op.x1 && cy > op.y0 && cy < op.y1) {
            covered = true;
            break;
          }
        }
      }
      if (!covered && runStart < 0) runStart = i;
      if (covered && runStart >= 0) {
        facePanel(b, mat, X[runStart], Y[j], X[i], Y[j + 1], z, dir, uvScale);
        runStart = -1;
      }
    }
  }
  for (const op of o.openings) {
    if (op.kind === 'arch') archSpandrels(b, mat, op, z, dir, uvScale);
  }
}

/**
 * Build a wall panel with its openings, reveals, sills, lintels, shutters,
 * glazing, balconies and awnings.
 */
export function wallPanel(b: LevelBuild, o: WallOpts, rng: Rng): void {
  const base = o.base ?? 0;
  const uvScale = o.uvScale ?? 1;
  const t = o.thickness;
  const trim = o.trim ?? 'sandstone';
  const reveal = o.through ? t : Math.min(o.reveal ?? 0.22, t - 0.02);

  if (!o.noOuter) cutFace(b, o.mat, o, 0, 1);
  if (o.through) cutFace(b, o.mat, o, -t, -1);

  for (const op of o.openings) {
    if (op.kind === 'bricked') {
      // A bricked-up window: the reveal is still there, filled flush-ish with a
      // slightly proud panel of a different material. One per street is enough
      // to say "this town has been repaired badly for forty years".
      b.m('sandstone').boxAt(
        (op.x0 + op.x1) / 2, (op.y0 + op.y1) / 2, -0.035,
        (op.x1 - op.x0) / 2 - 0.02, (op.y1 - op.y0) / 2 - 0.02, 0.05,
        uvScale, 0x1f,
      );
      continue;
    }

    const w = op.x1 - op.x0;
    const h = op.y1 - op.y0;
    const isArch = op.kind === 'arch';
    const headY = isArch ? op.y1 - w / 2 : op.y1;

    // ---- reveal: the four inner faces of the opening -----------------------
    const m = b.m(o.mat);
    // jambs
    m.quad(
      _p[0].set(op.x0, op.y0, 0), _p[1].set(op.x0, op.y0, -reveal),
      _p[2].set(op.x0, headY, -reveal), _p[3].set(op.x0, headY, 0), uvScale,
    );
    m.quad(
      _p[0].set(op.x1, op.y0, -reveal), _p[1].set(op.x1, op.y0, 0),
      _p[2].set(op.x1, headY, 0), _p[3].set(op.x1, headY, -reveal), uvScale,
    );
    // cill face
    m.quad(
      _p[0].set(op.x0, op.y0, -reveal), _p[1].set(op.x1, op.y0, -reveal),
      _p[2].set(op.x1, op.y0, 0), _p[3].set(op.x0, op.y0, 0), uvScale,
    );
    // head / soffit
    if (isArch) {
      archIntrados(b, o.mat, op, 0, -reveal, uvScale);
    } else {
      m.quad(
        _p[0].set(op.x1, op.y1, -reveal), _p[1].set(op.x0, op.y1, -reveal),
        _p[2].set(op.x0, op.y1, 0), _p[3].set(op.x1, op.y1, 0), uvScale,
      );
    }

    // ---- back of a solid opening ------------------------------------------
    if (!o.through && op.kind !== 'void') {
      // The interior we never model. A near-black plane at the back of the
      // reveal reads as a room with the lights off, which at 30 m is
      // indistinguishable from one that is actually there, and at 3 m the
      // reveal depth still sells it.
      facePanel(b, 'glass', op.x0, op.y0, op.x1, op.y1 + (isArch ? 0 : 0), -reveal + 0.005, 1, uvScale);
    }

    // ---- glazing -----------------------------------------------------------
    if (op.glass !== false && (op.kind === 'window' || op.kind === 'vent')) {
      const inset = reveal * 0.55;
      facePanel(b, 'glass', op.x0 + 0.03, op.y0 + 0.03, op.x1 - 0.03, op.y1 - 0.03, -inset, 1, uvScale);
      // A single central mullion and a transom: without them a window is a
      // black rectangle, and mullions are the highest-value-per-triangle detail
      // on any facade.
      const mid = (op.x0 + op.x1) / 2;
      b.m('paint').boxAt(mid, (op.y0 + op.y1) / 2, -inset + 0.02, 0.025, h / 2 - 0.03, 0.022, 1, 0x3f);
      b.m('paint').boxAt((op.x0 + op.x1) / 2, op.y0 + h * 0.62, -inset + 0.02, w / 2 - 0.03, 0.022, 0.022, 1, 0x3f);
    }

    // ---- sill --------------------------------------------------------------
    if (op.kind === 'window' || op.kind === 'arch') {
      b.m(trim).boxAt(
        (op.x0 + op.x1) / 2, op.y0 - 0.045, 0.03,
        w / 2 + 0.09, 0.05, 0.075, 1, 0x3f,
      );
    }
    // ---- lintel ------------------------------------------------------------
    if (!isArch) {
      b.m(trim).boxAt(
        (op.x0 + op.x1) / 2, op.y1 + 0.055, 0.015,
        w / 2 + 0.07, 0.055, 0.05, 1, 0x3f,
      );
    } else {
      // Voussoir band: a ring of short radial blocks following the arc.
      const r = w / 2;
      const xc = (op.x0 + op.x1) / 2;
      const ys = op.y1 - r;
      for (let i = 0; i < 7; i++) {
        const a = ((i + 0.5) / 7) * Math.PI;
        const px = xc - Math.cos(a) * (r + 0.07);
        const py = ys + Math.sin(a) * (r + 0.07);
        const bm = b.m(trim);
        const q = new THREE.Matrix4().makeTranslation(px, py, 0.02);
        q.multiply(new THREE.Matrix4().makeRotationZ(a - Math.PI / 2));
        b.xf.push(q);
        bm.boxAt(0, 0, 0, 0.075, 0.09, 0.045, 1, 0x3f);
        b.xf.pop();
      }
    }

    // ---- shutters ----------------------------------------------------------
    if (op.shutter) {
      const leaf = w / 2 - 0.02;
      const emitLeaf = (side: -1 | 1, openAngle: number, hang: number): void => {
        const hingeX = side < 0 ? op.x0 - 0.02 : op.x1 + 0.02;
        const mm = new THREE.Matrix4().makeTranslation(hingeX, (op.y0 + op.y1) / 2, 0.055);
        mm.multiply(new THREE.Matrix4().makeRotationY(-side * openAngle));
        if (hang !== 0) mm.multiply(new THREE.Matrix4().makeRotationZ(hang));
        b.xf.push(mm);
        b.m('paint').boxAt(side * leaf * 0.5, 0, 0, leaf * 0.5, h / 2 - 0.02, 0.022, 1, 0x3f);
        // Louvre slats: four shallow ribs. They catch the raking sun and are
        // the difference between "a painted board" and "a shutter".
        for (let s = 0; s < 4; s++) {
          const sy = -h / 2 + 0.12 + s * ((h - 0.3) / 3);
          b.m('paint').boxAt(side * leaf * 0.5, sy, 0.024, leaf * 0.46, 0.028, 0.012, 1, 0x3f);
        }
        b.xf.pop();
      };
      if (op.shutter === 1) {
        emitLeaf(-1, 0, 0);
        emitLeaf(1, 0, 0);
      } else if (op.shutter === 2) {
        emitLeaf(-1, 0, 0);
        emitLeaf(1, 1.9 + rng.range(-0.25, 0.25), 0);
      } else {
        emitLeaf(-1, 2.2, -0.28);
      }
    }

    // ---- balcony -----------------------------------------------------------
    if (op.balcony) {
      const bw = w / 2 + 0.42;
      const depth = 0.85;
      b.m('concrete').boxAt((op.x0 + op.x1) / 2, op.y0 - 0.11, depth / 2, bw, 0.07, depth / 2, 1, 0x3f);
      // Corbels under the slab.
      for (const sx of [-1, 1]) {
        b.m(trim).boxAt((op.x0 + op.x1) / 2 + sx * (bw - 0.12), op.y0 - 0.27, 0.22, 0.09, 0.12, 0.22, 1, 0x3f);
      }
      // Railing: top rail, bottom rail, uprights. Slight outward lean.
      const railY = op.y0 - 0.04;
      const zf = depth - 0.05;
      b.m('steel').boxAt((op.x0 + op.x1) / 2, railY + 0.94, zf, bw, 0.032, 0.032, 1, 0x3f);
      b.m('steel').boxAt((op.x0 + op.x1) / 2, railY + 0.34, zf, bw, 0.022, 0.022, 1, 0x3f);
      const n = Math.max(4, Math.round(bw * 2 * 3.2));
      for (let i = 0; i <= n; i++) {
        const px = (op.x0 + op.x1) / 2 - bw + (i / n) * bw * 2;
        b.m('steel').boxAt(px, railY + 0.47, zf, 0.014, 0.47, 0.014, 1, 0x3f);
      }
      for (const sx of [-1, 1]) {
        b.m('steel').boxAt((op.x0 + op.x1) / 2 + sx * bw, railY + 0.47, zf / 2 + 0.02, 0.02, 0.47, zf / 2, 1, 0x3f);
        b.m('steel').boxAt((op.x0 + op.x1) / 2 + sx * bw, railY + 0.94, zf / 2 + 0.02, 0.028, 0.028, zf / 2, 1, 0x3f);
      }
      // Something drying on it, half the time.
      if (rng.bool(0.45)) {
        b.m('fabric').boxAt(
          (op.x0 + op.x1) / 2 + rng.range(-0.2, 0.2), railY + 0.62, zf + 0.03,
          rng.range(0.22, 0.4), rng.range(0.24, 0.4), 0.008, 1, 0x3f,
        );
      }
    }

    // ---- shopfront awning ---------------------------------------------------
    if (op.awning) {
      const aw = w / 2 + 0.35;
      const proj = rng.range(1.0, 1.5);
      const drop = rng.range(0.28, 0.46);
      const yTop = op.y1 + 0.22;
      const m2 = b.m('fabric');
      m2.quad(
        _p[0].set((op.x0 + op.x1) / 2 - aw, yTop, 0.02),
        _p[1].set((op.x0 + op.x1) / 2 + aw, yTop, 0.02),
        _p[2].set((op.x0 + op.x1) / 2 + aw, yTop - drop, proj),
        _p[3].set((op.x0 + op.x1) / 2 - aw, yTop - drop, proj),
        1,
      );
      // Valance, so the awning has a silhouette edge instead of a knife edge.
      m2.quad(
        _p[0].set((op.x0 + op.x1) / 2 - aw, yTop - drop, proj),
        _p[1].set((op.x0 + op.x1) / 2 + aw, yTop - drop, proj),
        _p[2].set((op.x0 + op.x1) / 2 + aw, yTop - drop - 0.22, proj - 0.02),
        _p[3].set((op.x0 + op.x1) / 2 - aw, yTop - drop - 0.22, proj - 0.02),
        1,
      );
      for (const sx of [-1, 1]) {
        const px = (op.x0 + op.x1) / 2 + sx * (aw - 0.06);
        b.m('steel').tube(
          [new THREE.Vector3(px, yTop, 0.03), new THREE.Vector3(px, yTop - drop, proj - 0.03)],
          0.018, 4, 1,
        );
        b.m('steel').tube(
          [new THREE.Vector3(px, yTop - 0.5, 0.03), new THREE.Vector3(px, yTop - drop, proj - 0.03)],
          0.014, 4, 1,
        );
      }
    }
  }
}

/**
 * Lay out a bay grid of openings across a facade width.
 *
 * The rhythm — bays of 1.7–2.4 m, windows centred in them, taller and wider on
 * the piano nobile, smaller under the roof — is what makes a procedural facade
 * read as designed rather than as noise. Randomising the window positions
 * directly does not; it just looks broken.
 */
export function facadeOpenings(
  width: number,
  floorBase: number,
  floorHeight: number,
  floorIndex: number,
  floorCount: number,
  rng: Rng,
  opts: { street?: boolean; doorAt?: number; arch?: boolean } = {},
): Opening[] {
  const out: Opening[] = [];
  const margin = 0.55;
  const usable = width - margin * 2;
  if (usable < 1.0) return out;
  const bays = Math.max(1, Math.round(usable / rng.range(1.9, 2.5)));
  const bayW = usable / bays;
  const ground = floorIndex === 0;
  const topFloor = floorIndex === floorCount - 1;

  for (let i = 0; i < bays; i++) {
    const cx = margin + bayW * (i + 0.5);
    // Door on the ground floor of a street facade, in the requested bay.
    if (ground && opts.doorAt !== undefined && i === Math.min(bays - 1, opts.doorAt)) {
      const dw = Math.min(1.15, bayW * 0.62);
      out.push({
        x0: cx - dw / 2,
        x1: cx + dw / 2,
        y0: floorBase + 0.02,
        y1: floorBase + Math.min(2.25, floorHeight - 0.5),
        kind: opts.arch ? 'arch' : 'door',
        glass: false,
        shutter: 0,
      });
      continue;
    }
    if (ground && opts.street && rng.bool(0.42)) {
      // Shopfront: a wide, low opening with an awning.
      const sw = Math.min(bayW * 0.82, 2.3);
      out.push({
        x0: cx - sw / 2,
        x1: cx + sw / 2,
        y0: floorBase + 0.45,
        y1: floorBase + Math.min(2.5, floorHeight - 0.42),
        kind: 'window',
        glass: true,
        shutter: rng.bool(0.35) ? 1 : 0,
        awning: rng.bool(0.55),
      });
      continue;
    }
    // A blank bay now and then: a real terrace is not a perfect grid.
    if (rng.bool(ground ? 0.3 : 0.12)) continue;
    if (rng.bool(0.06)) {
      const bw = Math.min(bayW * 0.5, 1.0);
      out.push({
        x0: cx - bw / 2, x1: cx + bw / 2,
        y0: floorBase + floorHeight * 0.34, y1: floorBase + floorHeight * 0.34 + 1.2,
        kind: 'bricked',
      });
      continue;
    }
    const ww = Math.min(bayW * rng.range(0.44, 0.6), 1.35);
    const wh = topFloor ? rng.range(0.95, 1.25) : rng.range(1.25, 1.6);
    const sill = floorBase + (topFloor ? floorHeight * 0.34 : floorHeight * 0.3);
    out.push({
      x0: cx - ww / 2,
      x1: cx + ww / 2,
      y0: sill,
      y1: sill + wh,
      kind: 'window',
      glass: true,
      shutter: rng.bool(0.62) ? (rng.bool(0.55) ? 1 : rng.bool(0.85) ? 2 : 3) : 0,
      balcony: !ground && opts.street === true && rng.bool(0.34),
    });
  }
  return out;
}
