/**
 * PROPS AND STREET DRESSING.
 *
 * OWNER: LEVEL.
 *
 * Everything here is a COVER DECISION first and a set-dressing decision second.
 * A crate you cannot crouch behind is worse than no crate: it costs triangles,
 * it costs a collider, and it teaches the player that the props in this game are
 * scenery. So every emitter in this file goes through `LevelBuild.solid`, which
 * registers the collider and — when the exposed height lands in the 0.55–2.4 m
 * band a soldier can actually use — a cover candidate.
 *
 * Heights are chosen against the stance table rather than by eye:
 *   0.55–0.95 m  prone / high-prone cover, and a vault-over
 *   0.95–1.35 m  crouch cover you can shoot over standing
 *   1.35–2.10 m  standing cover you must lean or step out of
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import { railing } from '@/level/kit/detail';
import { rock } from '@/level/kit/ground';
import type { MatKey } from '@/level/materials';

/** A wooden crate, optionally stacked and never square to the world. */
export function crate(b: LevelBuild, x: number, y: number, z: number, size: number, rng: Rng): void {
  const m = new THREE.Matrix4()
    .makeTranslation(x, y + size / 2, z)
    .multiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)))
    .multiply(new THREE.Matrix4().makeRotationX(rng.range(-0.04, 0.04)))
    .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.04, 0.04)));
  b.xf.pushAbsolute(m);
  b.solid('wood', 0, 0, 0, size / 2, size / 2, size / 2 * rng.range(0.85, 1.1), { groundY: y });
  // Batten frame: eight edge strips. A plain cube reads as a placeholder; a
  // battened crate reads as a crate at any distance.
  const s = size / 2;
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) b.m('wood').boxAt(0, sy * s, sz * s, s + 0.012, 0.03, 0.03, 1, 0x3f);
    for (const sx of [-1, 1]) b.m('wood').boxAt(sx * s, sy * s, 0, 0.03, 0.03, s + 0.012, 1, 0x3f);
  }
  b.xf.pop();
}

export function crateStack(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const n = 1 + rng.int(3);
  let cy = y;
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.55, 0.95) * (1 - i * 0.12);
    crate(b, x + rng.range(-0.18, 0.18) * i, cy, z + rng.range(-0.18, 0.18) * i, s, rng);
    cy += s;
  }
}

/** 200 l drum. Rusted, dented, occasionally on its side. */
export function barrel(b: LevelBuild, x: number, y: number, z: number, rng: Rng, mat: MatKey = 'rust'): void {
  const r = 0.29;
  const h = 0.88;
  const down = rng.bool(0.18);
  const m = new THREE.Matrix4().makeTranslation(x, y + (down ? r : 0), z)
    .multiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)));
  if (down) m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  b.xf.pushAbsolute(m);
  b.m(mat).cylinder(0, 0, 0, r, r, h, 12, 1, true, false);
  // Rolling hoops — the detail that stops a drum being a cylinder.
  for (const t of [0.3, 0.7]) {
    b.m(mat).cylinder(0, h * t - 0.025, 0, r + 0.022, r + 0.022, 0.05, 12, 1, false, false);
  }
  b.xf.pop();
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + (down ? r : h / 2), z),
    shape: down
      ? { kind: 'cylinder', halfHeight: h / 2, radius: r }
      : { kind: 'cylinder', halfHeight: h / 2, radius: r },
    surface: SurfaceId.RustedMetal,
    group: CollisionGroup.Prop,
  });
  if (!down) {
    b.coverBoxes.push({
      matrix: new THREE.Matrix4().makeTranslation(x, y + h / 2, z),
      half: new THREE.Vector3(r, h / 2, r),
      groundY: y,
    });
  }
}

/**
 * A sandbag emplacement: a curved or straight run of stacked bags. This is the
 * archetypal piece of "cover that reads as cover" — the bag courses give it a
 * silhouette that is unmistakable at 80 m.
 */
export function sandbagWall(
  b: LevelBuild,
  x: number, y: number, z: number,
  yaw: number,
  length: number,
  courses: number,
  rng: Rng,
  curve = 0,
): void {
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);
  const bagW = 0.44;
  const bagH = 0.2;
  const bagD = 0.28;
  const perCourse = Math.max(2, Math.round(length / bagW));
  for (let c = 0; c < courses; c++) {
    // Each course is offset half a bag, like real bond.
    const off = (c % 2) * bagW * 0.5;
    for (let i = 0; i < perCourse; i++) {
      const px = -length / 2 + off + (i + 0.5) * (length / perCourse);
      const t = px / (length / 2);
      const pz = curve * t * t;
      const inset = c * 0.035;
      b.m('fabric').boxAt(
        px + rng.range(-0.02, 0.02),
        bagH * (c + 0.5),
        pz + rng.range(-0.025, 0.025),
        bagW * 0.5 * rng.range(0.9, 1.02),
        bagH * 0.5 * rng.range(0.88, 1.0),
        (bagD - inset) * rng.range(0.9, 1.05),
        1, 0x3f,
      );
    }
  }
  b.xf.pop();
  const h = bagH * courses;
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + h / 2, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    shape: { kind: 'box', half: new THREE.Vector3(length / 2 + 0.2, h / 2, bagD + 0.05) },
    surface: SurfaceId.Sandbag,
    group: CollisionGroup.StaticGeo,
  });
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(x, y + h / 2, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    half: new THREE.Vector3(length / 2, h / 2, bagD),
    groundY: y,
  });
  b.blocker(x, z, length / 2, bagD + 0.1, yaw, y, y + h);
}

/** Jersey barrier / concrete block, the harbour's answer to a sandbag. */
export function concreteBarrier(b: LevelBuild, x: number, y: number, z: number, yaw: number, rng: Rng): void {
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw + rng.range(-0.05, 0.05)));
  b.xf.pushAbsolute(m);
  const L = rng.range(1.5, 2.1);
  // Tapered profile, cast in one piece: wide foot, narrow top.
  const g = b.m('concrete');
  const prof: [number, number][] = [[0.32, 0], [0.24, 0.22], [0.11, 0.55], [0.1, 0.92]];
  for (let i = 0; i < prof.length - 1; i++) {
    const [w0, y0] = prof[i];
    const [w1, y1] = prof[i + 1];
    for (const s of [1, -1]) {
      g.quad(
        _q[0].set(-L / 2, y0, s * w0), _q[1].set(L / 2, y0, s * w0),
        _q[2].set(L / 2, y1, s * w1), _q[3].set(-L / 2, y1, s * w1),
        1,
      );
      if (s < 0) {
        // The quad above is wound for +Z; mirror the winding on the −Z face.
        g.quad(
          _q[0].set(L / 2, y0, s * w0), _q[1].set(-L / 2, y0, s * w0),
          _q[2].set(-L / 2, y1, s * w1), _q[3].set(L / 2, y1, s * w1),
          1,
        );
      }
    }
  }
  g.boxAt(0, 0.94, 0, L / 2, 0.03, 0.1, 1, 0x3f);
  for (const s of [1, -1]) g.boxAt(s * L / 2, 0.46, 0, 0.02, 0.46, 0.22, 1, 0x3f);
  b.xf.pop();
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + 0.48, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    shape: { kind: 'box', half: new THREE.Vector3(L / 2, 0.48, 0.3) },
    surface: SurfaceId.Concrete,
    group: CollisionGroup.StaticGeo,
  });
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(x, y + 0.48, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    half: new THREE.Vector3(L / 2, 0.48, 0.3),
    groundY: y,
  });
}

/** ISO container — the harbour's structural cover unit and its climbing frame. */
export function container(
  b: LevelBuild,
  x: number, y: number, z: number, yaw: number,
  long: boolean,
  mat: MatKey,
  rng: Rng,
): void {
  const L = long ? 6.06 : 3.0;
  const W = 1.22;
  const H = 1.3;
  const m = new THREE.Matrix4().makeTranslation(x, y + H, z)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.012, 0.012)));
  b.xf.pushAbsolute(m);
  b.solid(mat, 0, 0, 0, L / 2, H, W, { groundY: y, occluder: long });
  // Corrugation: vertical ribs on the long sides, which is what makes a
  // container silhouette read at 150 m instead of being a coloured brick.
  const ribs = Math.round(L / 0.32);
  for (let i = 0; i <= ribs; i++) {
    const px = -L / 2 + (i / ribs) * L;
    for (const s of [1, -1]) {
      b.m(mat).boxAt(px, 0, s * (W + 0.025), 0.06, H - 0.09, 0.03, 1, 0x3f);
    }
  }
  for (const s of [1, -1]) b.m(mat).boxAt(0, s * (H - 0.06), 0, L / 2 + 0.02, 0.05, W + 0.03, 1, 0x3f);
  // Door end: two leaves with locking bars.
  b.m('rust').boxAt(-L / 2 - 0.03, 0, 0, 0.03, H - 0.05, W - 0.04, 1, 0x3f);
  for (const s of [-0.6, -0.2, 0.2, 0.6]) {
    b.m('rust').boxAt(-L / 2 - 0.06, 0, s * W, 0.03, H - 0.12, 0.035, 1, 0x3f);
  }
  // Corner castings.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    b.m('rust').boxAt(sx * (L / 2 - 0.09), sy * (H - 0.09), sz * (W - 0.09), 0.1, 0.1, 0.1, 1, 0x3f);
  }
  b.xf.pop();
  b.deck(x, y + H * 2, z, L / 2, W, yaw, 0);
}

/** A burnt-out saloon, shoved onto the kerb. Real cover, and a landmark. */
export function wreckedCar(b: LevelBuild, x: number, y: number, z: number, yaw: number, rng: Rng): void {
  const m = new THREE.Matrix4().makeTranslation(x, y, z)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.05, 0.05)));
  b.xf.pushAbsolute(m);
  const body: MatKey = 'rust';
  // Sills / body tub.
  b.m(body).boxAt(0, 0.52, 0, 2.05, 0.28, 0.82, 1, 0x3f);
  b.m(body).boxAt(0.15, 0.82, 0, 1.05, 0.14, 0.78, 1, 0x3f);
  // Bonnet and boot slope.
  b.m(body).boxAt(-1.55, 0.72, 0, 0.55, 0.1, 0.76, 1, 0x3f);
  b.m(body).boxAt(1.62, 0.74, 0, 0.5, 0.1, 0.74, 1, 0x3f);
  // Cabin frame: A, B and C pillars plus a caved roof. No glass left.
  for (const [px, pz] of [[-0.55, 0.72], [-0.55, -0.72], [0.85, 0.72], [0.85, -0.72]] as const) {
    b.m(body).boxAt(px, 1.12, pz, 0.05, 0.3, 0.05, 1, 0x3f);
  }
  b.m(body).boxAt(0.15, 1.4, 0, 0.72, 0.05, 0.7, 1, 0x3f);
  // Wheels: two flat, one missing.
  const wheels: [number, number][] = [[-1.25, 0.78], [-1.25, -0.78], [1.3, 0.78]];
  for (const [wx, wz] of wheels) {
    const wm = new THREE.Matrix4().makeTranslation(wx, 0.28, wz).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    b.xf.push(wm);
    b.m('paint').cylinder(0, -0.11, 0, 0.3, 0.3, 0.22, 10, 1, true, false);
    b.xf.pop();
  }
  // The axle stub where the fourth wheel was.
  b.m('steel').boxAt(1.3, 0.3, -0.78, 0.06, 0.06, 0.2, 1, 0x3f);
  b.xf.pop();
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + 0.68, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    shape: { kind: 'box', half: new THREE.Vector3(2.1, 0.68, 0.85) },
    surface: SurfaceId.PaintedMetal,
    group: CollisionGroup.Vehicle,
  });
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(x, y + 0.68, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    half: new THREE.Vector3(2.1, 0.68, 0.85),
    groundY: y,
  });
  b.blocker(x, z, 2.2, 0.95, yaw, y, y + 1.5);
}

/** Market stall: four poles, a sagging canopy, a trestle and produce boxes. */
export function marketStall(b: LevelBuild, x: number, y: number, z: number, yaw: number, rng: Rng): void {
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);
  const hx = rng.range(1.2, 1.9);
  const hz = rng.range(0.85, 1.25);
  const h = rng.range(2.05, 2.35);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.m('wood').boxAt(sx * hx, h / 2, sz * hz, 0.045, h / 2, 0.045, 1, 0x3f);
  }
  // Canopy: four quads meeting at a slightly off-centre sag, so it is never
  // a flat plane and always catches the sun differently on each panel.
  const g = b.m('fabric');
  const sagX = rng.range(-0.25, 0.25);
  const sagZ = rng.range(-0.2, 0.2);
  const c = _q[0].set(sagX, h - 0.2, sagZ);
  const corners = [
    _q[1].set(-hx - 0.25, h, -hz - 0.25),
    _q[2].set(hx + 0.25, h, -hz - 0.25),
    _q[3].set(hx + 0.25, h, hz + 0.25),
    new THREE.Vector3(-hx - 0.25, h, hz + 0.25),
  ];
  for (let i = 0; i < 4; i++) {
    g.triangle(corners[i], corners[(i + 1) % 4], c, 1);
    g.triangle(corners[(i + 1) % 4], corners[i], c, 1);
  }
  // Trestle table and the goods on it.
  b.m('wood').boxAt(0, 0.82, -hz * 0.35, hx * 0.9, 0.04, hz * 0.5, 1, 0x3f);
  for (const sx of [-1, 1]) b.m('wood').boxAt(sx * hx * 0.75, 0.41, -hz * 0.35, 0.04, 0.41, 0.04, 1, 0x3f);
  const goods = 2 + rng.int(4);
  for (let i = 0; i < goods; i++) {
    b.m(rng.pick(['wood', 'fabric'] as MatKey[])).boxAt(
      rng.range(-hx * 0.8, hx * 0.8), 0.95, rng.range(-hz * 0.7, 0),
      rng.range(0.12, 0.26), 0.1, rng.range(0.12, 0.22), 1, 0x3f,
    );
  }
  b.xf.pop();
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + 0.45, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    shape: { kind: 'box', half: new THREE.Vector3(hx * 0.9, 0.45, hz * 0.5) },
    surface: SurfaceId.Wood,
    group: CollisionGroup.Prop,
  });
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(x, y + 0.45, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    half: new THREE.Vector3(hx * 0.9, 0.45, hz * 0.5),
    groundY: y,
  });
}

/** Power / lighting pole with a cross-arm and a lamp. */
export function utilityPole(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const h = rng.range(6.5, 8.5);
  b.m('wood').cylinder(x, y - 0.3, z, 0.14, 0.11, h, 7, 1, true, false);
  const yaw = rng.range(0, Math.PI);
  const m = new THREE.Matrix4().makeTranslation(x, y + h - 0.9, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);
  b.m('wood').boxAt(0, 0, 0, 0.9, 0.05, 0.05, 1, 0x3f);
  for (const s of [-1, 0, 1]) b.m('glass').cylinder(s * 0.78, 0.06, 0, 0.045, 0.035, 0.11, 6, 1, true, false);
  b.xf.pop();
  // Street lamp on a swan neck.
  b.m('steel').tube(
    [
      new THREE.Vector3(x, y + h - 0.25, z),
      new THREE.Vector3(x + 0.4, y + h + 0.05, z),
      new THREE.Vector3(x + 1.05, y + h - 0.05, z),
    ],
    0.035, 5, 1,
  );
  b.m('steel').boxAt(x + 1.15, y + h - 0.14, z, 0.24, 0.06, 0.14, 1, 0x3f);
  b.m('glass').boxAt(x + 1.15, y + h - 0.22, z, 0.2, 0.03, 0.11, 1, 0x3f);
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + h / 2, z),
    shape: { kind: 'cylinder', halfHeight: h / 2, radius: 0.16 },
    surface: SurfaceId.Wood,
    group: CollisionGroup.StaticGeo,
  });
}

/** Mooring bollard, and the rope loop over it. */
export function bollard(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  b.m('steel').cylinder(x, y, z, 0.2, 0.16, 0.5, 8, 1, true, false);
  b.m('steel').cylinder(x, y + 0.5, z, 0.24, 0.2, 0.09, 8, 1, true, false);
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + 0.3, z),
    shape: { kind: 'cylinder', halfHeight: 0.3, radius: 0.22 },
    surface: SurfaceId.BareMetal,
    group: CollisionGroup.Prop,
  });
  void rng;
}

/** A tyre stack — fenders robbed off the quay and left on the pavement. */
export function tyreStack(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  const n = 2 + rng.int(4);
  for (let i = 0; i < n; i++) {
    b.m('paint').cylinder(
      x + rng.range(-0.09, 0.09), y + i * 0.19, z + rng.range(-0.09, 0.09),
      0.42, 0.42, 0.18, 10, 1, false, false,
    );
  }
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + n * 0.095, z),
    shape: { kind: 'cylinder', halfHeight: n * 0.095, radius: 0.44 },
    surface: SurfaceId.Rubber,
    group: CollisionGroup.Prop,
  });
}

/** A low boundary wall with a coping and a gap or two. Alleys and courtyards. */
export function lowWall(
  b: LevelBuild,
  x0: number, z0: number, x1: number, z1: number,
  groundAt: (x: number, z: number) => number,
  height: number,
  rng: Rng,
  mat: MatKey = 'sandstone',
): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.6) return;
  const yaw = Math.atan2(x1 - x0, z1 - z0);
  const segs = Math.max(1, Math.round(len / 3.2));
  for (let i = 0; i < segs; i++) {
    if (rng.bool(0.12)) continue; // a collapsed bay
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const mx = x0 + (x1 - x0) * (t0 + t1) / 2;
    const mz = z0 + (z1 - z0) * (t0 + t1) / 2;
    const g = groundAt(mx, mz);
    const h = height * rng.range(0.86, 1.05);
    const segLen = (len / segs) / 2;
    const m = new THREE.Matrix4().makeTranslation(mx, g - 0.35, mz).multiply(new THREE.Matrix4().makeRotationY(yaw));
    b.xf.pushAbsolute(m);
    b.solid(mat, 0, (h + 0.35) / 2, 0, 0.14, (h + 0.35) / 2, segLen, { groundY: g });
    b.m('concrete').boxAt(0, h + 0.02, 0, 0.19, 0.05, segLen, 1, 0x3f);
    b.xf.pop();
  }
}

/** Re-exported so the districts can rail a terrace edge without a second import. */
export { railing, rock };

const _q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
