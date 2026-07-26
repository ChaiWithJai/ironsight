/**
 * DETAIL — the things bolted onto a building after it was built.
 *
 * OWNER: LEVEL.
 *
 * Every item in here exists because it is on the reference frames and because
 * it is *asymmetric*: a satellite dish, a drainpipe on one corner only, a roof
 * tank on a rusted stand, an air-con box with a drip stain, a laundry line
 * across an alley. A procedural town without these reads as extruded footprints
 * no matter how good the shading gets, because the roofline is the silhouette
 * you see from every capture point and a clean roofline is an unbuilt one.
 *
 * All of it is emitted in the CALLER's frame, so it leans with the building.
 * That is deliberate — a dish bolted to a leaning parapet leans too.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import type { MatKey } from '@/level/materials';

const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

/** Rooftop water cistern on a welded stand — the single most Levantine roofline object. */
export function waterTank(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const r = rng.range(0.42, 0.62);
  const h = rng.range(0.75, 1.15);
  const legH = rng.range(0.45, 0.85);
  const mat: MatKey = rng.bool(0.55) ? 'rust' : 'steel';
  // Stand.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    b.m('rust').boxAt(x + sx * r * 0.8, y + legH / 2, z + sz * r * 0.8, 0.035, legH / 2, 0.035, 1, 0x3f);
  }
  b.m('rust').boxAt(x, y + legH, z, r * 0.9, 0.035, r * 0.9, 1, 0x3f);
  b.m(mat).cylinder(x, y + legH + 0.04, z, r, r, h, 10, 1, true, false);
  // Lid and inlet pipe.
  b.m('steel').cylinder(x + r * 0.3, y + legH + h + 0.04, z, r * 0.24, r * 0.24, 0.07, 8, 1, true, false);
  b.m('steel').tube(
    [
      new THREE.Vector3(x - r * 0.7, y + legH + h * 0.2, z),
      new THREE.Vector3(x - r * 0.7, y - 0.1, z),
    ],
    0.022, 4, 1,
  );
  b.solid('steel', x, y + legH + h / 2, z, r, (legH + h) / 2, r, { noCollide: false, noCover: false, groundY: y, faces: 0 });
}

/** Satellite dish on a pole clamp. Offset yaw and pitch, never two the same. */
export function satelliteDish(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const r = rng.range(0.28, 0.46);
  const az = rng.range(-0.9, 0.9) + Math.PI * 0.15;
  const el = rng.range(0.35, 0.75);
  const poleH = rng.range(0.35, 0.9);
  b.m('steel').cylinder(x, y, z, 0.035, 0.032, poleH, 6, 1, true, false);
  const m = new THREE.Matrix4().makeTranslation(x, y + poleH, z);
  m.multiply(new THREE.Matrix4().makeRotationY(az));
  m.multiply(new THREE.Matrix4().makeRotationX(-el));
  b.xf.push(m);
  // Shallow dish: a ring plus a centre, so it has a concave face and a rim.
  const mesh = b.m('steel');
  const N = 12;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    mesh.triangle(
      _v[0].set(0, 0, 0.09),
      _v[1].set(Math.cos(a1) * r, Math.sin(a1) * r, 0),
      _v[2].set(Math.cos(a0) * r, Math.sin(a0) * r, 0),
      1,
    );
    mesh.triangle(
      _v[0].set(0, 0, 0.05),
      _v[1].set(Math.cos(a0) * r, Math.sin(a0) * r, 0),
      _v[2].set(Math.cos(a1) * r, Math.sin(a1) * r, 0),
      1,
    );
  }
  // LNB arm.
  mesh.boxAt(0, -r * 0.55, -0.22, 0.02, r * 0.3, 0.02, 1, 0x3f);
  mesh.boxAt(0, -r * 0.82, -0.4, 0.035, 0.035, 0.07, 1, 0x3f);
  b.xf.pop();
}

/** Split-unit air-con condenser, bracketed off a wall or sat on a roof. */
export function acUnit(b: LevelBuild, x: number, y: number, z: number, yaw: number, rng: Rng): void {
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.push(m);
  const w = rng.range(0.34, 0.46);
  const h = rng.range(0.28, 0.38);
  const d = rng.range(0.16, 0.24);
  b.m('steel').boxAt(0, h, 0, w, h, d, 1, 0x3f);
  // Fan grille: a recessed disc so the box is not a featureless brick.
  b.m('paint').cylinder(0, h - 0.01, d - 0.02, w * 0.62, w * 0.62, 0.02, 10, 1, true, false);
  // Wall brackets.
  for (const sx of [-1, 1]) {
    b.m('rust').boxAt(sx * (w - 0.04), h - 0.02, -d - 0.05, 0.02, 0.02, 0.06, 1, 0x3f);
  }
  // Condensate pipe with the drip run it leaves down the wall.
  b.m('paint').tube(
    [new THREE.Vector3(w * 0.5, 0.02, -d), new THREE.Vector3(w * 0.5, -1.2, -d + 0.02)],
    0.014, 4, 1,
  );
  b.xf.pop();
}

/** Down-pipe with hoppers and clips, run down a corner. */
export function drainpipe(b: LevelBuild, x: number, z: number, yTop: number, yBottom: number, rng: Rng): void {
  const r = 0.055;
  const pts: THREE.Vector3[] = [];
  const segs = Math.max(3, Math.round((yTop - yBottom) / 1.6));
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // A pipe fixed by hand is never plumb; ±3 cm of wander over a storey.
    pts.push(new THREE.Vector3(x + rng.range(-0.03, 0.03), yTop + (yBottom - yTop) * t, z + rng.range(-0.03, 0.03)));
  }
  b.m('rust').tube(pts, r, 5, 1);
  // Hopper head at the top.
  b.m('rust').boxAt(x, yTop + 0.1, z, 0.11, 0.1, 0.11, 1, 0x3f);
  // Clips every ~1.6 m.
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    b.m('rust').boxAt(x, yTop + (yBottom - yTop) * t, z, 0.085, 0.02, 0.085, 1, 0x3f);
  }
  // Shoe: the pipe kicks out at the bottom rather than vanishing into the wall.
  b.m('rust').tube(
    [new THREE.Vector3(x, yBottom + 0.35, z), new THREE.Vector3(x + 0.16, yBottom + 0.06, z + 0.16)],
    r, 5, 1,
  );
}

/**
 * Exposed rebar from a column that was cast for a storey nobody ever built.
 * Half the buildings in a town like this have it; it is a strong silhouette read
 * against a bright sky and it costs 12 triangles.
 */
export function rebarStubs(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const n = 4 + Math.round(rng.range(0, 4));
  const spread = rng.range(0.11, 0.2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const bx = x + Math.cos(a) * spread;
    const bz = z + Math.sin(a) * spread;
    const h = rng.range(0.35, 0.95);
    b.m('rust').tube(
      [
        new THREE.Vector3(bx, y, bz),
        new THREE.Vector3(bx + rng.range(-0.05, 0.05), y + h * 0.7, bz + rng.range(-0.05, 0.05)),
        new THREE.Vector3(bx + rng.range(-0.16, 0.16), y + h, bz + rng.range(-0.16, 0.16)),
      ],
      0.012, 3, 1,
    );
  }
  // The stub of unfinished column the bars come out of.
  b.m('concrete').boxAt(x, y - 0.14, z, spread + 0.06, 0.15, spread + 0.06, 1, 0x3f);
}

/** A stubby chimney / flue with a cowl. */
export function chimney(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const h = rng.range(0.55, 1.2);
  const w = rng.range(0.16, 0.26);
  b.m('sandstone').boxAt(x, y + h / 2, z, w, h / 2, w, 1, 0x3f);
  b.m('rust').cylinder(x, y + h, z, w * 0.55, w * 0.5, 0.22, 8, 1, true, false);
  b.m('rust').boxAt(x, y + h + 0.28, z, w * 0.8, 0.02, w * 0.8, 1, 0x3f);
}

/** Whip aerial or a bundle of them, guyed. */
export function aerial(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const h = rng.range(1.4, 3.2);
  b.m('steel').tube([new THREE.Vector3(x, y, z), new THREE.Vector3(x + rng.range(-0.1, 0.1), y + h, z + rng.range(-0.1, 0.1))], 0.018, 3, 1);
  const arms = 2 + Math.round(rng.range(0, 3));
  for (let i = 0; i < arms; i++) {
    const ay = y + h * (0.45 + (i / arms) * 0.5);
    const al = rng.range(0.18, 0.4);
    const aa = rng.range(0, Math.PI);
    b.m('steel').tube(
      [
        new THREE.Vector3(x - Math.cos(aa) * al, ay, z - Math.sin(aa) * al),
        new THREE.Vector3(x + Math.cos(aa) * al, ay, z + Math.sin(aa) * al),
      ],
      0.009, 3, 1,
    );
  }
}

/**
 * A run of railing. `stance` decides the height: 1.05 m for a balcony/parapet
 * rail, 0.95 m for a quay edge. Uprights are deliberately irregular.
 */
export function railing(
  b: LevelBuild,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  height: number,
  rng: Rng,
  mat: MatKey = 'steel',
  post = 0.022,
): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.2) return;
  const m = b.m(mat);
  const n = Math.max(2, Math.round(len / 1.35));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = x0 + (x1 - x0) * t;
    const pz = z0 + (z1 - z0) * t;
    const py = y0 + (y1 - y0) * t;
    const lean = rng.range(-0.035, 0.035);
    m.tube(
      [new THREE.Vector3(px, py, pz), new THREE.Vector3(px + lean, py + height, pz + lean)],
      post * 1.5, 4, 1,
    );
  }
  for (const frac of [1.0, 0.55]) {
    const pts: THREE.Vector3[] = [];
    const seg = Math.max(2, Math.round(len / 2));
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      pts.push(new THREE.Vector3(
        x0 + (x1 - x0) * t,
        y0 + (y1 - y0) * t + height * frac - (frac < 1 ? 0 : 0) + rng.range(-0.012, 0.012),
        z0 + (z1 - z0) * t,
      ));
    }
    m.tube(pts, post * (frac === 1 ? 1.35 : 0.85), 4, 1);
  }
}

/**
 * A flight of stairs. Emits treads, risers, a stringer skirt, a nav deck ramp
 * and a collider ramp — the collider is a single sloped box, because a stack of
 * per-step boxes is what makes a character controller stutter on stairs.
 */
export function stairs(
  b: LevelBuild,
  x: number, y: number, z: number,
  yaw: number,
  width: number,
  rise: number,
  run: number,
  mat: MatKey,
  rng: Rng,
  railings: 0 | 1 | 2 = 0,
): void {
  const steps = Math.max(2, Math.round(rise / 0.175));
  const stepRise = rise / steps;
  const stepRun = run / steps;
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.push(m);
  const g = b.m(mat);
  for (let i = 0; i < steps; i++) {
    const sy = (i + 0.5) * stepRise;
    const sz = (i + 0.5) * stepRun;
    // Each tread nosed 3 cm proud and worn a few mm off level.
    g.boxAt(0, sy - stepRise * 0.5 + stepRise * 0.5, sz, width / 2, stepRise / 2, stepRun / 2 + 0.03, 1, 0x3f);
    if (rng.bool(0.22)) {
      // A chipped nosing: a small wedge missing from the front edge.
      const cx = rng.range(-width / 2 + 0.2, width / 2 - 0.2);
      g.boxAt(cx, sy + stepRise * 0.35, sz + stepRun / 2 + 0.01, rng.range(0.06, 0.16), 0.03, 0.05, 1, 0x3f);
    }
  }
  // Skirt below the flight so it does not float over a slope.
  g.boxAt(0, -0.5, run / 2, width / 2, 0.5 + 0.01, run / 2, 1, 0x3f);
  b.xf.pop();

  // ONE sloped collider for the whole flight.
  const slopeAngle = Math.atan2(rise, run);
  const len = Math.hypot(rise, run);
  const cm = new THREE.Matrix4().makeTranslation(x, y + rise / 2, z + 0);
  cm.multiply(new THREE.Matrix4().makeRotationY(yaw));
  cm.multiply(new THREE.Matrix4().makeTranslation(0, 0, run / 2));
  cm.multiply(new THREE.Matrix4().makeRotationX(-slopeAngle));
  b.collider({
    matrix: cm,
    shape: { kind: 'box', half: new THREE.Vector3(width / 2, 0.12, len / 2) },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  b.deck(
    x + Math.sin(yaw) * (run / 2),
    y,
    z + Math.cos(yaw) * (run / 2),
    width / 2,
    run / 2,
    yaw,
    rise,
  );
  if (railings) {
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const sideX = Math.cos(yaw);
    const sideZ = -Math.sin(yaw);
    for (const s of railings === 2 ? [-1, 1] : [1]) {
      railing(
        b,
        x + sideX * s * width * 0.5, y + 0.1, z + sideZ * s * width * 0.5,
        x + sideX * s * width * 0.5 + dirX * run, y + rise + 0.1, z + sideZ * s * width * 0.5 + dirZ * run,
        0.95, rng, 'steel',
      );
    }
  }
}

/**
 * Overhead lines strung across a street. Two anchors, a slack span and a couple
 * of hanging items — the single cheapest way to break up a hard sky above an
 * alley and to give the eye a depth cue between two facades.
 */
export function laundryLine(
  b: LevelBuild,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  rng: Rng,
): void {
  const from = new THREE.Vector3(ax, ay, az);
  const to = new THREE.Vector3(bx, by, bz);
  b.m('rust').slackLine(from, to, rng.range(0.25, 0.7), 0.012, 7);
  const items = Math.round(rng.range(2, 6));
  for (let i = 0; i < items; i++) {
    const t = (i + rng.range(0.2, 0.8)) / items;
    const p = new THREE.Vector3().lerpVectors(from, to, t);
    const sag = rng.range(0.25, 0.7);
    p.y -= sag * 4 * t * (1 - t);
    const w = rng.range(0.22, 0.5);
    const h = rng.range(0.3, 0.75);
    // Sheets hang with a twist; a flat billboard would strobe as the camera moves.
    const m = new THREE.Matrix4().makeTranslation(p.x, p.y - h / 2 - 0.02, p.z);
    m.multiply(new THREE.Matrix4().makeRotationY(Math.atan2(to.x - from.x, to.z - from.z) + rng.range(-0.35, 0.35)));
    m.multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.09, 0.09)));
    b.xf.push(m);
    b.m('fabric').boxAt(0, 0, 0, w / 2, h / 2, 0.006, 1, 0x3f);
    b.xf.pop();
  }
}

/** Electrical conduit and a junction box run up a facade. */
export function conduit(b: LevelBuild, x: number, z: number, yBottom: number, yTop: number, rng: Rng): void {
  const pts: THREE.Vector3[] = [];
  const segs = 4;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(x + rng.range(-0.02, 0.02), yBottom + (yTop - yBottom) * t, z));
  }
  b.m('paint').tube(pts, 0.02, 4, 1);
  b.m('paint').boxAt(x, yBottom + (yTop - yBottom) * rng.range(0.3, 0.7), z + 0.03, 0.09, 0.13, 0.05, 1, 0x3f);
}

/** A hanging shop sign, perpendicular to the facade. */
export function shopSign(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const proj = rng.range(0.5, 0.95);
  b.m('rust').tube([new THREE.Vector3(x, y, z), new THREE.Vector3(x, y, z + proj)], 0.016, 4, 1);
  b.m('rust').tube([new THREE.Vector3(x, y - 0.45, z + 0.04), new THREE.Vector3(x, y, z + proj * 0.85)], 0.012, 3, 1);
  const m = new THREE.Matrix4().makeTranslation(x, y - 0.28, z + proj * 0.75);
  m.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2 + rng.range(-0.12, 0.12)));
  m.multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.06, 0.06)));
  b.xf.push(m);
  b.m('paint').boxAt(0, 0, 0, rng.range(0.3, 0.55), rng.range(0.16, 0.28), 0.02, 1, 0x3f);
  b.xf.pop();
}
