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
import { propFoot, rock } from '@/level/kit/ground';
import type { MatKey } from '@/level/materials';

/**
 * Ground contact for an emitter whose BODY is authored in absolute world space.
 *
 * Every prop in this file that starts with `xf.pushAbsolute` takes world
 * coordinates and deliberately ignores whatever frame its caller happens to have
 * on the stack — a crate placed by a leaning building must not lean. The foot has
 * to obey the same rule or it lands somewhere else entirely, so it is emitted
 * under an identity frame rather than the current one.
 */
function worldFoot(b: LevelBuild, x: number, y: number, z: number, r: number, rng: Rng, debris = true): void {
  b.xf.pushAbsolute(_identity);
  propFoot(b, x, y, z, r, rng, 'sand', debris);
  b.xf.pop();
}

/** A wooden crate, optionally stacked and never square to the world. */
export function crate(b: LevelBuild, x: number, y: number, z: number, size: number, rng: Rng): void {
  const m = new THREE.Matrix4()
    .makeTranslation(x, y + size / 2, z)
    .multiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)))
    .multiply(new THREE.Matrix4().makeRotationX(rng.range(-0.04, 0.04)))
    .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.04, 0.04)));
  b.xf.pushAbsolute(m);
  b.m('wood').setUvShift(rng.range(0, 20), rng.range(0, 20));
  b.solid('wood', 0, 0, 0, size / 2, size / 2, size / 2 * rng.range(0.85, 1.1), { groundY: y });
  // Batten frame: eight edge strips. A plain cube reads as a placeholder; a
  // battened crate reads as a crate at any distance.
  const s = size / 2;
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) b.m('wood').boxAt(0, sy * s, sz * s, s + 0.012, 0.03, 0.03, 1, 0x3f);
    for (const sx of [-1, 1]) b.m('wood').boxAt(sx * s, sy * s, 0, 0.03, 0.03, s + 0.012, 1, 0x3f);
  }
  /**
   * CORNER POSTS AND A DIAGONAL BRACE.
   *
   * Round 2 measured the crates in `sky_golden` as "single-value quads whose
   * only feature is one vertical silhouette seam". The battens above run along
   * the top and bottom edges only, so a crate seen face-on — which is how a
   * crate at 60 m is always seen — presented one unbroken square of one value.
   * A packing case has four corner posts and a diagonal on each side, and the
   * diagonal is the piece that does the work: it is the only line on the object
   * that is neither horizontal nor vertical, so it survives every distance and
   * every angle at which the horizontals foreshorten to nothing.
   */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.m('wood').boxAt(sx * s, 0, sz * s, 0.032, s, 0.032, 1, 0x3f);
  }
  for (const sz of [-1, 1]) {
    const dm = new THREE.Matrix4().makeTranslation(0, 0, sz * (s + 0.018))
      .multiply(new THREE.Matrix4().makeRotationZ(sz * Math.PI / 4));
    b.xf.push(dm);
    b.m('wood').boxAt(0, 0, 0, s * 1.32, 0.028, 0.018, 1, 0x3f);
    b.xf.pop();
  }
  for (const sx of [-1, 1]) {
    const dm = new THREE.Matrix4().makeTranslation(sx * (s + 0.018), 0, 0)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeRotationZ(-sx * Math.PI / 4));
    b.xf.push(dm);
    b.m('wood').boxAt(0, 0, 0, s * 1.32, 0.028, 0.018, 1, 0x3f);
    b.xf.pop();
  }
  b.m('wood').clearUvShift();
  b.xf.pop();
}

export function crateStack(b: LevelBuild, x: number, y: number, z: number, rng: Rng): void {
  worldFoot(b, x, y, z, 0.55, rng);
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
  worldFoot(b, x, y, z, down ? 0.5 : 0.34, rng);
  const m = new THREE.Matrix4().makeTranslation(x, y + (down ? r : 0), z)
    .multiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)));
  if (down) m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  b.xf.pushAbsolute(m);
  b.m(mat).cylinder(0, 0, 0, r, r, h, 12, 1, true, false);
  // Rolling hoops — the detail that stops a drum being a cylinder.
  for (const t of [0.3, 0.7]) {
    b.m(mat).cylinder(0, h * t - 0.025, 0, r + 0.022, r + 0.022, 0.05, 12, 1, false, false);
  }
  /**
   * HEAD DETAIL. A 200 l drum seen from above — which is how every drum in a
   * frame shot from a metre and a half of extra height is seen — was a flat
   * 12-gon of one colour: round 2 read one of them at (162,665) in level_bravo as
   * *"an untextured primitive, an orange sphere"*. A real drum head is a chime
   * ring standing 2 cm proud of a slightly dished top with two bungs in it, and
   * those three features are what turn the disc back into an object: the chime
   * casts a ring of shadow inside itself, and the bungs break the centre.
   */
  for (const t of [0, 1]) {
    b.m(mat).cylinder(0, t * h - (t ? 0.02 : 0), 0, r, r, 0.02, 12, 1, true, false);
    b.m(mat).cylinder(0, t * h - (t ? 0.055 : -0.035), 0, r - 0.035, r - 0.035, 0.02, 12, 1, true, false);
  }
  for (const [bx, bz] of [[0.6, 0], [-0.34, 0.5]] as const) {
    b.m('steel').cylinder(bx * r, h - 0.03, bz * r, 0.038, 0.034, 0.035, 6, 1, true, false);
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
/**
 * The three tones a sandbag comes in. LEVEL has a fifteen-material budget and
 * cannot mint a tinted material per bag, so per-instance albedo variation is
 * bought by picking among materials that already exist and are already in the
 * draw list: hessian (0x9c8557), sun-bleached (0xb6a179) and dirt-stained
 * (0x8b7c62). Three albedos, no new draw calls, and the run stops reading as one
 * extruded colour.
 */
const BAG_MATS: readonly MatKey[] = ['fabric', 'sand', 'rubble', 'fabric', 'sand'];

/**
 * ONE BAG. A chamfered, jittered, individually-rotated solid rather than a
 * cuboid.
 *
 * Round 1's critique of this emitter is worth quoting because everything here is
 * a direct answer to it: *"~20 instances of one cuboid with zero variation.
 * Every block is the identical size, identical orientation, laid on an exact grid
 * with the courses perfectly aligned; every visible end face carries the same
 * dark blue-grey branching smear in the same position and orientation. All twelve
 * edges of every block are razor-sharp 90°."*
 *
 *  - identical size        → ±8 % non-uniform scale per bag
 *  - identical orientation → ±9° yaw, ±5° roll and pitch
 *  - exact grid            → per-bag along/across/height offsets, and a course
 *                            pitch that is not a divisor of the run length
 *  - the same smear        → per-bag UV phase (`setUvShift`), so the albedo,
 *                            height and wear maps all land somewhere different
 *  - razor-sharp edges     → a 3.5 cm chamfer on all twelve arrises, which under
 *                            an 11° sun is a bright rim on the sunward edges
 *  - one colour            → `BAG_MATS`
 */
function sandbag(
  b: LevelBuild,
  mat: MatKey,
  cx: number, cy: number, cz: number,
  hw: number, hh: number, hd: number,
  rng: Rng,
): void {
  const m = new THREE.Matrix4().makeTranslation(cx, cy, cz)
    .multiply(new THREE.Matrix4().makeRotationY(rng.range(-0.16, 0.16)))
    .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.085, 0.085)))
    .multiply(new THREE.Matrix4().makeRotationX(rng.range(-0.085, 0.085)));
  b.xf.push(m);
  const g = b.m(mat);
  g.setUvShift(rng.range(0, 24), rng.range(0, 24));
  // The chamfer is a fifth of the bag's depth: enough that the silhouette of a
  // stack is a row of pillows rather than a row of bricks.
  g.chamferBox(0, 0, 0, hw, hh, hd, Math.min(hh, hd) * 0.42, 1, rng, 0.16);
  g.clearUvShift();
  b.xf.pop();
}

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
  /**
   * SETTLEMENT. A stack of bags on sand is not level: it sinks where the load is
   * heaviest and the courses sag toward the middle and toward whichever end the
   * ground gave way under. Two out-of-phase sines over the run, scaled by the
   * course index so the top course sags most, does the whole job — and because it
   * is a continuous field rather than per-bag noise, the sag reads as ONE wall
   * settling rather than as forty bags jittering independently.
   */
  const sagPhase = rng.range(0, Math.PI * 2);
  const sagAmp = bagH * rng.range(0.5, 1.1);
  const leanAmt = rng.range(-0.05, 0.05);
  for (let c = 0; c < courses; c++) {
    // Each course is offset by an irrational fraction of a bag rather than a
    // clean half, so no two courses ever line their joints up down the wall.
    const off = ((c * 0.618) % 1) * bagW;
    // A course occasionally runs one bag short at one end: a real emplacement is
    // built up in a wedge, not squared off.
    const drop = c >= courses - 2 && rng.bool(0.55) ? 1 + rng.int(2) : 0;
    const fromEnd = rng.bool(0.5);
    for (let i = 0; i < perCourse; i++) {
      if (drop > 0 && (fromEnd ? i >= perCourse - drop : i < drop)) continue;
      // One bag in twenty-five has been pulled out or has slumped out of line.
      const stray = rng.bool(0.04);
      const px = -length / 2 + off + (i + 0.5) * (length / perCourse) + rng.range(-0.05, 0.05);
      const t = px / (length / 2);
      const pz = curve * t * t;
      const inset = c * 0.035;
      const sag = Math.sin(px * 1.7 + sagPhase) * 0.6 + Math.sin(px * 0.63 - sagPhase) * 0.4;
      const settle = sag * sagAmp * (c + 1) / courses + leanAmt * px * 0.05;
      sandbag(
        b,
        rng.pick(BAG_MATS),
        px,
        bagH * (c + 0.5) + settle,
        pz + rng.range(-0.05, 0.05) + (stray ? rng.range(0.12, 0.3) * rng.sign() : 0),
        bagW * 0.5 * rng.range(0.9, 1.08),
        bagH * 0.5 * rng.range(0.86, 1.06),
        (bagD - inset) * rng.range(0.88, 1.1),
        rng,
      );
    }
  }
  // One or two bags off the top course, lying on the ground at the foot. The
  // cheapest possible piece of history, and it also breaks the wall's own
  // base line where it meets the sand.
  const fallen = 1 + rng.int(2);
  for (let i = 0; i < fallen; i++) {
    const px = rng.range(-length / 2, length / 2);
    const fm = new THREE.Matrix4()
      .makeTranslation(px, bagH * 0.5, curve * (px / (length / 2)) ** 2 + rng.range(0.35, 0.95) * rng.sign())
      .multiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)))
      .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.35, 0.35)));
    b.xf.push(fm);
    const g = b.m(rng.pick(BAG_MATS));
    g.setUvShift(rng.range(0, 24), rng.range(0, 24));
    g.chamferBox(0, 0, 0, bagW * 0.52, bagH * 0.46, bagD * 0.95, bagH * 0.19, 1, rng, 0.2);
    g.clearUvShift();
    b.xf.pop();
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
  worldFoot(b, x, y, z, 0.7, rng);
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw + rng.range(-0.05, 0.05)));
  b.xf.pushAbsolute(m);
  const L = rng.range(1.5, 2.1);
  // Tapered profile, cast in one piece: wide foot, narrow top.
  const g = b.m('concrete');
  g.setUvShift(rng.range(0, 18), rng.range(0, 18));
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
  g.clearUvShift();
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
  /** False for a container stacked on another, or standing on a ship's deck. */
  foot = true,
): void {
  const L = long ? 6.06 : 3.0;
  if (foot) {
    // Three drifts along the length rather than one disc — a 6 m box banks sand
    // along its whole windward side, not in a circle around its centre.
    for (const t of [-0.62, 0, 0.62]) {
      worldFoot(b, x + Math.cos(yaw) * L * t, y, z - Math.sin(yaw) * L * t, 0.85, rng);
    }
  }
  const W = 1.22;
  const H = 1.3;
  const m = new THREE.Matrix4().makeTranslation(x, y + H, z)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.012, 0.012)));
  b.xf.pushAbsolute(m);
  // Per-container UV phase, so nine containers in a stack do not all carry the
  // same rust streak in the same place down their doors.
  b.m(mat).setUvShift(rng.range(0, 30), rng.range(0, 30));
  b.m('rust').setUvShift(rng.range(0, 30), rng.range(0, 30));
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
  b.m(mat).clearUvShift();
  b.m('rust').clearUvShift();
  b.xf.pop();
  b.deck(x, y + H * 2, z, L / 2, W, yaw, 0);
}

/** A burnt-out saloon, shoved onto the kerb. Real cover, and a landmark. */
export function wreckedCar(b: LevelBuild, x: number, y: number, z: number, yaw: number, rng: Rng): void {
  // Four wheel prints rather than one disc: the mound has to follow the object's
  // actual contact patches, and a saloon touches the ground in four places.
  for (const [wx, wz] of [[-1.25, 0.78], [-1.25, -0.78], [1.3, 0.78], [1.3, -0.78]] as const) {
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    worldFoot(b, x + wx * c + wz * sn, y, z - wx * sn + wz * c, 0.42, rng, false);
  }
  worldFoot(b, x, y, z, 0.9, rng);
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
    // Each leg gets its own drift and a couple of grains. Round 2: "the four
    // canopy posts intersect the sand as clean straight cuts."
    propFoot(b, sx * hx, 0, sz * hz, 0.17, rng);
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
  propFoot(b, x, y, z, 0.26, rng);
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
  propFoot(b, x, y, z, 0.3, rng);
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
  propFoot(b, x, y, z, 0.46, rng);
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

/**
 * A COILED MOORING HAWSER — flaked down on the quay in a flat spiral.
 *
 * Added in round 3 for one specific job. `level_bravo` is the atmosphere hero
 * frame and its near-field mass was a heap of loose stone, which the critics
 * read as placeholder primitives. A harbour's near field is rope, timber and
 * steel, and of those, rope is the one whose silhouette no primitive can fake:
 * a spiral is non-convex everywhere, it self-occludes, its cross-section catches
 * a rim light all the way round, and nobody has ever seen one in a WebGL demo.
 *
 * Three or four turns of `tube` on an Archimedean spiral, each turn dropped by
 * less than a diameter so the coil has a domed section like a real flake, and
 * the tail run off to a bollard. `sides = 4` because the tube is 6 cm across and
 * at that scale the facets are sub-pixel past 3 m.
 */
export function ropeCoil(
  b: LevelBuild,
  x: number, y: number, z: number,
  radius: number,
  rng: Rng,
  turns = 3.4,
): void {
  const r0 = 0.075;
  /**
   * `wood`, not `fabric`. `fabric` is the TARP entry — a pale, double-sided,
   * 0.55-albedo canvas that is lit on both faces, and a coil built out of it
   * resolved in `level_bravo` as a single flat blob at 197/160/129 against a
   * deck at 40: the brightest object in the lower half of the frame, with no
   * internal form at all, at 8 m from the lens. Hemp cordage is a mid-brown
   * closer to `wood` (0x6b4f33), it is not translucent, and at that albedo the
   * individual turns finally separate into light and shade instead of merging
   * into one value.
   */
  const g = b.m('wood');
  const phase = rng.range(0, Math.PI * 2);
  for (let layer = 0; layer < 2; layer++) {
    const pts: THREE.Vector3[] = [];
    const segs = Math.round(turns * 11);
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const a = phase + u * turns * Math.PI * 2;
      // Spiral inward, and lift the inner turns so the coil is domed not flat.
      const rr = radius * (1 - u * 0.62) - layer * r0 * 1.3;
      pts.push(new THREE.Vector3(
        x + Math.cos(a) * rr + rng.range(-0.012, 0.012),
        y + r0 + layer * r0 * 1.7 + u * r0 * 0.5,
        z + Math.sin(a) * rr + rng.range(-0.012, 0.012),
      ));
    }
    g.setUvShift(rng.range(0, 20), rng.range(0, 20));
    g.tube(pts, r0, 6, 1);
    g.clearUvShift();
  }
  // The standing part running off out of the coil and dying on the deck.
  const out = rng.range(0, Math.PI * 2);
  g.tube(
    [
      new THREE.Vector3(x + Math.cos(phase) * radius, y + r0, z + Math.sin(phase) * radius),
      new THREE.Vector3(x + Math.cos(out) * (radius + 0.9), y + r0 * 0.8, z + Math.sin(out) * (radius + 0.9)),
      new THREE.Vector3(x + Math.cos(out + 0.5) * (radius + 2.1), y + r0 * 0.7, z + Math.sin(out + 0.5) * (radius + 2.1)),
    ],
    r0, 5, 1,
  );
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + r0 * 2, z),
    shape: { kind: 'cylinder', halfHeight: r0 * 2, radius },
    surface: SurfaceId.Tarp,
    group: CollisionGroup.Prop,
  });
}

/**
 * A STACK OF EUROPALLETS, one of them stove in.
 *
 * The other half of the round-3 near-field answer. A pallet is nine timbers with
 * air between them, so its silhouette is a comb: it reads as manufactured at a
 * glance and it is impossible to mistake for a primitive, which is precisely the
 * failure mode being fixed. Cheap, too — 22 boxes for a whole stack.
 */
export function palletStack(
  b: LevelBuild,
  x: number, y: number, z: number,
  yaw: number,
  rng: Rng,
): void {
  const n = 2 + rng.int(4);
  const L = 0.6;
  const W = 0.4;
  let cy = y;
  for (let p = 0; p < n; p++) {
    const m = new THREE.Matrix4().makeTranslation(x, cy, z)
      .multiply(new THREE.Matrix4().makeRotationY(yaw + rng.range(-0.22, 0.22)))
      .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.035, 0.035)));
    b.xf.pushAbsolute(m);
    const g = b.m('wood');
    g.setUvShift(rng.range(0, 20), rng.range(0, 20));
    // Three bearers, then the top deck boards, then two bottom runners.
    for (const s of [-1, 0, 1]) g.boxAt(0, 0.05, s * W * 0.86, L, 0.05, 0.05, 1, 0x3f);
    const boards = 5;
    for (let i = 0; i < boards; i++) {
      // The top pallet has lost a board or two; the ones under it are intact.
      if (p === n - 1 && rng.bool(0.3)) continue;
      const px = -L + (i / (boards - 1)) * L * 2;
      g.boxAt(px, 0.115, 0, L * 0.16, 0.014, W, 1, 0x3f);
    }
    for (const s of [-1, 1]) g.boxAt(0, 0.007, s * W * 0.86, L, 0.012, 0.06, 1, 0x3f);
    g.clearUvShift();
    b.xf.pop();
    cy += 0.132;
  }
  const h = n * 0.132;
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, y + h / 2, z).multiply(new THREE.Matrix4().makeRotationY(yaw)),
    shape: { kind: 'box', half: new THREE.Vector3(L, h / 2, W) },
    surface: SurfaceId.Wood,
    group: CollisionGroup.Prop,
  });
  worldFoot(b, x, y, z, 0.55, rng);
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
    for (let k = 0; k < Math.max(1, Math.round(segLen / 0.9)); k++) {
      const along = rng.range(-segLen, segLen);
      propFoot(b, rng.range(-0.24, 0.24), 0.35, along, 0.3, rng);
    }
    b.xf.pop();
  }
}

/** Re-exported so the districts can rail a terrace edge without a second import. */
export { railing, rock };

const _q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _identity = new THREE.Matrix4();
