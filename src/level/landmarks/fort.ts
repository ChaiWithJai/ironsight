/**
 * CHARLIE — the old fort on the headland.
 *
 * OWNER: LEVEL.
 *
 * CHARLIE is the point that makes the map work. It stands 28 m above BRAVO at
 * 200 m and its ramparts see the whole quay, so holding it is worth a lot; the
 * price is that it is 300 m from ALPHA by any route and the only vehicle-width
 * approach is one switchback road. That trade is the tension in the match.
 *
 * For that to be true rather than merely stated, the fort has to be a REAL
 * BUILDING and not a silhouette:
 *
 *  - a walkable RAMPART all the way round, at 5.2 m, behind a crenellated
 *    parapet — the firing position that overlooks BRAVO;
 *  - a GATEHOUSE with a vaulted passage you actually walk through, which is the
 *    front door and the obvious chokepoint;
 *  - a BREACH in the north curtain, which is the second way in and the reason
 *    the gate is not an auto-win;
 *  - a COURTYARD with hard cover in it, so taking the gate does not immediately
 *    hand you the point;
 *  - a KEEP with an enterable ground floor and an internal stair to the rampart,
 *    which is the vertical fight.
 *
 * The enceinte is an IRREGULAR PENTAGON, not a rectangle. Every real coastal
 * fort is shaped by its rock, none of them is square, and a square one on a
 * headland is the single loudest "this was generated" signal available.
 *
 * The polygon, the gate side and the breach side are all derived from the
 * approach direction rather than hard-coded, so the fort stays correct if the
 * headland road is ever re-routed.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import { railing, stairs } from '@/level/kit/detail';
import { groundSkirt, rock, rubblePile } from '@/level/kit/ground';
import { wallPanel, type Opening } from '@/level/kit/wall';
import { barrel, crateStack, concreteBarrier, sandbagWall } from '@/level/dressing';
import { POINTS } from '@/level/layout';
import type { MatKey } from '@/level/materials';

type Ground = (x: number, z: number) => number;
const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _wp = new THREE.Vector3();

const STONE: MatKey = 'sandstone';
const COPING: MatKey = 'concrete';

/** Rampart height above the courtyard floor. Chosen so a standing soldier's
 *  eye clears a 1.3 m parapet from the wall-walk but not from the courtyard. */
const WALK_Y = 5.2;
const PARAPET_H = 1.35;
const WALL_T = 2.5;

/** Enceinte outline in the fort's own frame, +X toward the approach. */
const OUTLINE: readonly (readonly [number, number])[] = [
  [24, -14],
  [21, 17],
  [-6, 25],
  [-24, 8],
  [-19, -19],
];

/**
 * Crenellated parapet along one wall run, plus the arrow slits below it. The
 * merlon/crenel rhythm is deliberately imperfect — three lost merlons and a
 * couple of chipped ones per fort, because an unbroken run of identical teeth is
 * a cartoon castle.
 */
function parapet(
  b: LevelBuild,
  length: number,
  y: number,
  outwardZ: number,
  rng: Rng,
  seaward: boolean,
): void {
  const merlon = 1.15;
  const crenel = 0.62;
  const pitch = merlon + crenel;
  const n = Math.max(2, Math.floor(length / pitch));
  const actual = length / n;
  for (let i = 0; i < n; i++) {
    const cx = -length / 2 + (i + 0.5) * actual;
    // A missing tooth, more often on the seaward walls where the weather is.
    if (rng.bool(seaward ? 0.13 : 0.07)) continue;
    const h = PARAPET_H * rng.range(0.86, 1.0);
    b.solid(STONE, cx, y + h / 2, outwardZ, (actual * merlon) / pitch / 2, h / 2, WALL_T * 0.3, {
      groundY: y, noBlock: true,
    });
    b.m(COPING).boxAt(cx, y + h + 0.05, outwardZ, (actual * merlon) / pitch / 2 + 0.05, 0.05, WALL_T * 0.3 + 0.05, 1, 0x3f);
  }
  // Low back-kerb on the inner edge of the walk, so the wall-walk has an edge
  // you read rather than a drop you fall off without noticing.
  b.m(STONE).boxAt(0, y + 0.22, -outwardZ * 0.55, length / 2, 0.22, WALL_T * 0.14, 1, 0x3f);
}

/**
 * One curtain-wall run between two courtyard corners. Emits the batter, the
 * wall mass, its collider, the wall-walk deck, the parapet and the ground
 * transition on both faces.
 */
function curtain(
  b: LevelBuild,
  ax: number, az: number, bx: number, bz: number,
  outX: number, outZ: number,
  baseY: number, footY: number,
  ground: Ground,
  rng: Rng,
  opts: { gateWidth?: number; breach?: boolean } = {},
): void {
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const len = Math.hypot(bx - ax, bz - az);
  /**
   * Local frame: +X along the wall, +Z OUTWARD, derived from the outward normal
   * rather than from the wall's direction.
   *
   * `makeRotationY(θ)` has columns X = (cos θ, 0, −sin θ) and Z = (sin θ, 0,
   * cos θ), so `θ = atan2(outX, outZ)` puts +Z exactly on the outward normal and
   * +X along the wall, in that order, right-handed. Deriving it from
   * `atan2(bx−ax, bz−az)` instead gets it right only for one polygon winding and
   * silently mirrors every parapet, arrow slit and skirt for the other — which
   * is invisible in a plan view and obvious the moment you stand on the wall.
   */
  const yaw = Math.atan2(outX, outZ);
  const m = new THREE.Matrix4()
    .makeTranslation(mx, baseY, mz)
    .multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);

  const gate = opts.gateWidth ?? 0;
  const segs: [number, number][] = gate > 0
    ? [[-len / 2, -gate / 2], [gate / 2, len / 2]]
    : [[-len / 2, len / 2]];

  for (const [s0, s1] of segs) {
    const segLen = s1 - s0;
    if (segLen < 0.4) continue;
    const cx = (s0 + s1) / 2;
    // Battered base: a wider skirt for the bottom 1.8 m. Every masonry fort has
    // one, it throws a horizontal shadow all the way round, and it is the
    // cheapest thing you can do to stop a wall reading as a extruded rectangle.
    const drop = baseY - footY;
    b.m(STONE).boxAt(cx, -drop / 2 + 0.9, 0, segLen / 2 + 0.05, drop / 2 + 0.9, WALL_T / 2 + 0.55, 0.6, 0x3f);
    b.m(COPING).boxAt(cx, 0.9, 0, segLen / 2 + 0.06, 0.07, WALL_T / 2 + 0.6, 1, 0x3f);
    // The wall mass, up to the walk.
    b.m(STONE).boxAt(cx, WALK_Y / 2 + 0.45, 0, segLen / 2, WALK_Y / 2 - 0.45, WALL_T / 2, 0.6, 0x3f);
    b.collider({
      matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(cx, (WALK_Y - drop) / 2, 0)),
      shape: { kind: 'box', half: new THREE.Vector3(segLen / 2, (WALK_Y + drop) / 2, WALL_T / 2 + 0.55) },
      surface: SurfaceId.Sandstone,
      group: CollisionGroup.StaticGeo,
      occluder: segLen > 14,
    });
    // Nav blocker for the wall mass. `b.m().boxAt` emits geometry only, so a
    // curtain built this way is invisible to the navmesh unless it is said out
    // loud — and the symptom is bots strolling through 2.5 m of masonry.
    // `yMax` stops 0.3 m BELOW the wall-walk so the walk's own deck survives the
    // headroom test: block the wall, not the firing step on top of it.
    _wp.set(cx, 0, 0).applyMatrix4(m);
    b.blocker(_wp.x, _wp.z, segLen / 2, WALL_T / 2 + 0.5, yaw, footY, baseY + WALK_Y - 0.3);
    // Arrow slits: a deep splayed recess, one every ~4 m. They are the only
    // thing that gives a 20 m blank wall any scale at all.
    const slits = Math.max(1, Math.round(segLen / 4.2));
    for (let i = 0; i < slits; i++) {
      const sx = s0 + ((i + 0.5) / slits) * segLen;
      b.m('glass').boxAt(sx, 3.1, WALL_T / 2 - 0.04, 0.11, 0.65, 0.06, 1, 0x3f);
      // The splay: four faces cut back into the stone around the slot.
      for (const [ox, oy, hx2, hy2] of [
        [-0.34, 0, 0.02, 0.95], [0.34, 0, 0.02, 0.95], [0, 1.0, 0.36, 0.02], [0, -1.0, 0.36, 0.02],
      ] as const) {
        b.m(STONE).boxAt(sx + ox, 3.1 + oy, WALL_T / 2 - 0.18, hx2, hy2, 0.18, 1, 0x3f);
      }
      b.m(COPING).boxAt(sx, 4.2, WALL_T / 2 + 0.02, 0.42, 0.07, 0.09, 1, 0x3f);
    }
  }

  // Wall-walk deck: a slab across the whole run, gate included — the walk
  // continues over the gate passage, which is the entire point of a gatehouse.
  b.m(COPING).boxAt(0, WALK_Y - 0.16, 0, len / 2, 0.16, WALL_T / 2, 0.7, 0x3f);
  b.collider({
    matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, WALK_Y - 0.16, 0)),
    shape: { kind: 'box', half: new THREE.Vector3(len / 2, 0.18, WALL_T / 2) },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  parapet(b, len, WALK_Y, WALL_T / 2 - 0.35, rng, outZ < 0 || outX < 0);
  b.xf.pop();

  b.deck(mx, baseY + WALK_Y, mz, len / 2 - 0.3, WALL_T / 2 - 0.5, yaw, 0);
  b.coverBoxes.push({
    matrix: new THREE.Matrix4()
      .makeTranslation(mx + outX * (WALL_T / 2 - 0.35), baseY + WALK_Y + PARAPET_H / 2, mz + outZ * (WALL_T / 2 - 0.35))
      .multiply(new THREE.Matrix4().makeRotationY(yaw)),
    half: new THREE.Vector3(len / 2, PARAPET_H / 2, WALL_T * 0.3),
    groundY: baseY + WALK_Y,
  });

  // Ground transition on the outer face, and rubble at the foot of a breach.
  groundSkirt(
    b,
    [
      { x: ax + outX * (WALL_T / 2 + 0.6), z: az + outZ * (WALL_T / 2 + 0.6) },
      { x: bx + outX * (WALL_T / 2 + 0.6), z: bz + outZ * (WALL_T / 2 + 0.6) },
      { x: bx + outX * (WALL_T / 2 + 2.4), z: bz + outZ * (WALL_T / 2 + 2.4) },
      { x: ax + outX * (WALL_T / 2 + 2.4), z: az + outZ * (WALL_T / 2 + 2.4) },
    ],
    ground, rng, { amount: 1.15, windDir: -0.7 },
  );
}

/**
 * A breached wall run: the wall stops short, the rest is a ramp of collapsed
 * masonry you can climb. This is the second way into the fort and the reason
 * the gate fight has a flank.
 */
function breachRun(
  b: LevelBuild,
  ax: number, az: number, bx: number, bz: number,
  outX: number, outZ: number,
  baseY: number, footY: number,
  ground: Ground,
  rng: Rng,
): void {
  const len = Math.hypot(bx - ax, bz - az);
  const gapFrac = 0.36;
  const dx = (bx - ax) / len;
  const dz = (bz - az) / len;
  // Two stubs either side of the gap.
  const stub = (len * (1 - gapFrac)) / 2;
  curtain(b, ax, az, ax + dx * stub, az + dz * stub, outX, outZ, baseY, footY, ground, rng);
  curtain(b, bx - dx * stub, bz - dz * stub, bx, bz, outX, outZ, baseY, footY, ground, rng);

  // The rubble ramp through the gap: two piles and a spine of large blocks,
  // climbable from outside and from in.
  const gx = ax + dx * (len / 2);
  const gz = az + dz * (len / 2);
  const gapLen = len * gapFrac;
  for (let i = 0; i < 5; i++) {
    const t = (i / 4 - 0.5) * gapLen * 0.8;
    const px = gx + dx * t;
    const pz = gz + dz * t;
    const h = 2.6 - Math.abs(i - 2) * 0.5;
    rubblePile(b, px + outX * rng.range(-1.4, 1.4), pz + outZ * rng.range(-1.4, 1.4), footY, rng.range(2.4, 3.4), h, rng);
  }
  // Jagged wall ends, so the break reads as a collapse and not as a doorway.
  for (const [ex, ez, sgn] of [
    [gx - dx * gapLen * 0.5, gz - dz * gapLen * 0.5, 1],
    [gx + dx * gapLen * 0.5, gz + dz * gapLen * 0.5, -1],
  ] as const) {
    for (let i = 0; i < 7; i++) {
      const up = (i / 7) * WALK_Y;
      const jag = rng.range(0.2, 1.9) * (1 - up / WALK_Y);
      b.m(STONE).boxAt(
        ex + dx * sgn * jag + outX * rng.range(-0.5, 0.5),
        baseY + up + 0.35,
        ez + dz * sgn * jag + outZ * rng.range(-0.5, 0.5),
        0.55, 0.35, WALL_T / 2, 1, 0x3f,
      );
    }
  }
  // A collapsed lintel lying across the gap, and spilled blocks outside.
  for (let i = 0; i < 9; i++) {
    const t = rng.range(-0.6, 0.6) * gapLen;
    const o = rng.range(1.5, 7.5);
    const px = gx + dx * t + outX * o;
    const pz = gz + dz * t + outZ * o;
    const s = rng.range(0.35, 1.1);
    rock(b, rng.bool(0.6) ? 'rubble' : STONE, px, ground(px, pz) + s * 0.3, pz, s, s * 0.62, s * 1.2, rng, 5);
  }
  /**
   * Ramps for the character controller and for the bots: one sloped box each
   * side of the crest. Without these the rubble is decoration and the breach is
   * not actually a route — which is the failure that matters, because a fort
   * with one entrance is a fort the attackers cannot take.
   *
   * Each ramp's frame is built with +Z pointing UPHILL, so `NavDeck.rise` (which
   * always runs low at −halfZ to high at +halfZ) is expressible as a positive
   * number on both of them, and the collider is the same box tilted by the same
   * angle about its own X.
   */
  const crest = footY + 2.2;
  const run = 7.2;
  const slope = Math.atan2(crest - footY, run);
  for (const s of [1, -1]) {
    // s = +1 is the ramp OUTSIDE the wall, whose uphill is inward, and vice
    // versa. Downhill is where the ramp's body sits.
    const upX = -outX * s;
    const upZ = -outZ * s;
    const upYaw = Math.atan2(upX, upZ);
    const cxr = gx - upX * (run / 2);
    const czr = gz - upZ * (run / 2);
    b.collider({
      matrix: new THREE.Matrix4()
        .makeTranslation(cxr, (footY + crest) / 2, czr)
        .multiply(new THREE.Matrix4().makeRotationY(upYaw))
        .multiply(new THREE.Matrix4().makeRotationX(-slope)),
      shape: { kind: 'box', half: new THREE.Vector3(gapLen * 0.42, 0.25, run / 2 + 0.4) },
      surface: SurfaceId.Rubble,
      group: CollisionGroup.StaticGeo,
    });
    b.deck(cxr, footY, czr, gapLen * 0.42, run / 2, upYaw, crest - footY);
  }
}

/** A round corner tower: battered drum, machicolated head, crenellated top. */
function tower(
  b: LevelBuild,
  x: number, z: number, footY: number, baseY: number,
  radius: number, height: number,
  ground: Ground,
  rng: Rng,
): void {
  const drop = baseY - footY;
  b.m(STONE).cylinder(x, footY - 1.2, z, radius + 1.15, radius + 0.35, drop + 2.1, 16, 0.7, false, false);
  b.m(COPING).cylinder(x, baseY + 0.9, z, radius + 0.38, radius + 0.38, 0.12, 16, 1, false, false);
  b.m(STONE).cylinder(x, baseY + 1.0, z, radius, radius * 0.94, height - 1.6, 16, 0.7, false, false);
  // Machicolation: a corbelled ring at the head, overhanging by 40 cm with the
  // gaps between the corbels showing. This is the detail that makes a tower a
  // fortification instead of a chimney.
  const headY = baseY + height - 0.6;
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    b.m(STONE).boxAt(
      x + Math.cos(a) * (radius * 0.94 + 0.18), headY - 0.3, z + Math.sin(a) * (radius * 0.94 + 0.18),
      0.17, 0.3, 0.17, 1, 0x3f,
    );
  }
  b.m(COPING).cylinder(x, headY, z, radius + 0.42, radius + 0.42, 0.22, 18, 1, true, false);
  // Crenellated top.
  const topY = headY + 0.22;
  for (let i = 0; i < 12; i++) {
    const a = ((i + 0.5) / 12) * Math.PI * 2;
    if (rng.bool(0.12)) continue;
    const px = x + Math.cos(a) * (radius + 0.1);
    const pz = z + Math.sin(a) * (radius + 0.1);
    const mm = new THREE.Matrix4().makeTranslation(px, topY, pz).multiply(new THREE.Matrix4().makeRotationY(-a));
    b.xf.pushAbsolute(mm);
    b.m(STONE).boxAt(0, PARAPET_H / 2, 0, 0.42, PARAPET_H / 2 * rng.range(0.88, 1.0), 0.34, 1, 0x3f);
    b.xf.pop();
  }
  b.m(COPING).cylinder(x, topY - 0.02, z, radius - 0.25, radius - 0.25, 0.14, 16, 1, true, false);
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, (footY - 1.2 + topY) / 2, z),
    shape: { kind: 'cylinder', halfHeight: (topY - footY + 1.2) / 2, radius: radius + 0.35 },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  b.deck(x, topY, z, radius - 0.5, radius - 0.5, 0, 0);
  b.blocker(x, z, radius + 0.5, radius + 0.5, 0, footY, topY);
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(x, topY + PARAPET_H / 2, z),
    half: new THREE.Vector3(radius, PARAPET_H / 2, radius),
    groundY: topY,
  });
  b.exclude(x, z, radius + 2);
  const ring: { x: number; z: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ring.push({ x: x + Math.cos(a) * (radius + 1.3), z: z + Math.sin(a) * (radius + 1.3) });
  }
  groundSkirt(b, ring, ground, rng, { amount: 1.2 });
}

/**
 * THE GATEHOUSE. A taller block straddling the gate opening with a vaulted
 * passage through it, a portcullis slot, a machicolated box over the outer arch
 * and a guard chamber on top. The passage is a real walkable corridor.
 */
function gatehouse(
  b: LevelBuild,
  cx: number, cz: number, yaw: number,
  baseY: number, footY: number,
  gateW: number,
  rng: Rng,
): void {
  const m = new THREE.Matrix4().makeTranslation(cx, baseY, cz).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);
  const halfW = gateW / 2 + 2.6;
  const depth = WALL_T / 2 + 1.9;
  const H = WALK_Y + 4.6;
  const passH = 4.0;
  const pierW = (halfW - gateW / 2) / 2;

  // The two piers either side of the passage, front to back. They stop at the
  // wall-walk; the storey above it is a HOLLOW chamber the walk runs through.
  for (const s of [-1, 1]) {
    b.m(STONE).boxAt(s * (gateW / 2 + pierW), WALK_Y / 2, 0, pierW, WALK_Y / 2, depth, 0.6, 0x3f);
    b.collider({
      matrix: new THREE.Matrix4().multiplyMatrices(
        m, new THREE.Matrix4().makeTranslation(s * (gateW / 2 + pierW), (WALK_Y - (baseY - footY)) / 2, 0),
      ),
      shape: { kind: 'box', half: new THREE.Vector3(pierW, (WALK_Y + baseY - footY) / 2, depth) },
      surface: SurfaceId.Sandstone,
      group: CollisionGroup.StaticGeo,
    });
    _wp.set(s * (gateW / 2 + pierW), 0, 0).applyMatrix4(m);
    b.blocker(_wp.x, _wp.z, pierW, depth, yaw, footY, baseY + WALK_Y - 0.3);
  }
  // The block over the passage — this is what makes it a gatehouse.
  b.m(STONE).boxAt(0, (passH + WALK_Y) / 2, 0, gateW / 2 + 0.05, (WALK_Y - passH) / 2, depth, 0.6, 0x3f);
  b.collider({
    matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, (passH + WALK_Y) / 2, 0)),
    shape: { kind: 'box', half: new THREE.Vector3(gateW / 2, (WALK_Y - passH) / 2, depth) },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  // Walk-level floor slab across the whole gatehouse.
  b.m(COPING).boxAt(0, WALK_Y - 0.16, 0, halfW, 0.16, depth, 0.7, 0x3f);
  b.collider({
    matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, WALK_Y - 0.16, 0)),
    shape: { kind: 'box', half: new THREE.Vector3(halfW, 0.2, depth) },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  // Barrel vault over the passage, as a fan of short chords. A flat soffit here
  // is the difference between "a tunnel" and "a hole in a box".
  const N = 10;
  const r = gateW / 2;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI;
    const a1 = ((i + 1) / N) * Math.PI;
    const y0 = passH - r + Math.sin(a0) * r;
    const y1 = passH - r + Math.sin(a1) * r;
    const x0 = -Math.cos(a0) * r;
    const x1 = -Math.cos(a1) * r;
    b.m(STONE).quad(
      _v[0].set(x1, y1, -depth), _v[1].set(x0, y0, -depth), _v[2].set(x0, y0, depth), _v[3].set(x1, y1, depth), 1,
    );
  }
  // Passage side walls, and the portcullis slot cut into the soffit.
  for (const s of [-1, 1]) {
    b.m(STONE).quad(
      _v[0].set(s * r, 0, s * depth), _v[1].set(s * r, 0, -s * depth),
      _v[2].set(s * r, passH - r, -s * depth), _v[3].set(s * r, passH - r, s * depth), 1,
    );
  }
  b.m('rust').boxAt(0, passH - r + r * 0.98, depth - 0.55, r - 0.1, 0.06, 0.09, 1, 0x3f);
  for (let i = 0; i < 7; i++) {
    b.m('rust').boxAt(-r + 0.2 + (i / 6) * (r * 2 - 0.4), passH - 0.25, depth - 0.55, 0.035, 0.35, 0.035, 1, 0x3f);
  }
  // Outer arch surround: a CONTINUOUS voussoir course, sized to the arc rather
  // than to a fixed count. Eleven blocks around a 3.4 m gate leaves 25 cm of
  // bare wall between each pair and the surround reads as a row of teeth stuck
  // on the stone; one block every 38 cm of extrados reads as masonry.
  //
  // The rotation is π/2 − a, NOT a − π/2 — see the note in kit/wall.ts. The
  // negated form is correct only at the crown and puts the haunch blocks on end
  // pointing radially out of the arch.
  const ring = r + 0.2;
  const vn = Math.max(9, Math.round((Math.PI * ring) / 0.38));
  const vHalf = ((Math.PI * ring) / vn / 2) * 1.14;
  for (let i = 0; i < vn; i++) {
    const a = ((i + 0.5) / vn) * Math.PI;
    const px = -Math.cos(a) * ring;
    const py = passH - r + Math.sin(a) * ring;
    const vm = new THREE.Matrix4().makeTranslation(px, py, depth + 0.05)
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2 - a));
    b.xf.push(vm);
    b.m(COPING).boxAt(0, 0, 0, vHalf, 0.28, 0.11, 1, 0x3f);
    b.xf.pop();
  }
  // Hood mould: a continuous label over the voussoirs, which is what stops the
  // course reading as a separate object bolted to the wall.
  for (let i = 0; i < vn; i++) {
    const a = ((i + 0.5) / vn) * Math.PI;
    const px = -Math.cos(a) * (ring + 0.3);
    const py = passH - r + Math.sin(a) * (ring + 0.3);
    const vm = new THREE.Matrix4().makeTranslation(px, py, depth + 0.02)
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2 - a));
    b.xf.push(vm);
    b.m(STONE).boxAt(0, 0, 0, vHalf * 1.06, 0.1, 0.14, 1, 0x3f);
    b.xf.pop();
  }
  // Machicolation box over the outer arch, on three corbels.
  const macY = WALK_Y + 0.4;
  for (const s of [-1, 0, 1]) {
    b.m(STONE).boxAt(s * (gateW * 0.32), macY - 0.35, depth + 0.28, 0.2, 0.35, 0.36, 1, 0x3f);
  }
  b.m(STONE).boxAt(0, macY + 0.62, depth + 0.42, gateW * 0.46, 0.62, 0.42, 1, 0x3f);
  b.m(COPING).boxAt(0, macY + 1.28, depth + 0.42, gateW * 0.5, 0.06, 0.46, 1, 0x3f);

  /**
   * THE GUARD CHAMBER, above the walk. Four real walls with real openings: a
   * doorway in each END wall so the rampart runs THROUGH it, an arched window
   * over the gate and a second one facing the courtyard. That makes the
   * gatehouse a room you fight in rather than a lump you walk past, and it makes
   * the wall-walk a continuous loop instead of two dead ends.
   */
  const chamberY = WALK_Y;
  const chamberH = H - chamberY - 0.5;
  const cT = 0.55;
  for (let side = 0; side < 4; side++) {
    const rot = (side * Math.PI) / 2;
    const starts: [number, number][] = [[-halfW, depth], [halfW, depth], [halfW, -depth], [-halfW, -depth]];
    const [sx, sz] = starts[side];
    const width = side % 2 === 0 ? halfW * 2 : depth * 2;
    const openings: Opening[] =
      side % 2 === 1
        // End walls: the doorway the rampart passes through.
        ? [{ x0: width / 2 - 0.62, x1: width / 2 + 0.62, y0: 0.02, y1: 2.15, kind: 'arch', glass: false }]
        // Front and back: a pair of arched lights either side of centre.
        : [
            { x0: width / 2 - 1.9, x1: width / 2 - 1.0, y0: 0.85, y1: 2.2, kind: 'arch', glass: false },
            { x0: width / 2 + 1.0, x1: width / 2 + 1.9, y0: 0.85, y1: 2.2, kind: 'arch', glass: false },
          ];
    b.xf.push(
      new THREE.Matrix4().makeTranslation(sx, chamberY, sz).multiply(new THREE.Matrix4().makeRotationY(rot)),
    );
    wallPanel(
      b,
      { width, height: chamberH, thickness: cT, mat: STONE, trim: COPING, openings, base: 0, through: true, uvScale: 0.8 },
      rng,
    );
    b.xf.pop();
    // Two collider stubs either side of each opening run, so the walls are solid
    // and the doorways are not.
    const gapHalf = side % 2 === 1 ? 0.62 : 1.9;
    for (const s of [-1, 1]) {
      const seg = (width / 2 - gapHalf) / 2;
      if (seg < 0.05) continue;
      b.collider({
        matrix: new THREE.Matrix4()
          .multiplyMatrices(
            m,
            new THREE.Matrix4().makeTranslation(sx, chamberY, sz).multiply(new THREE.Matrix4().makeRotationY(rot)),
          )
          .multiply(new THREE.Matrix4().makeTranslation(width / 2 + s * (gapHalf + seg), chamberH / 2, -cT / 2)),
        shape: { kind: 'box', half: new THREE.Vector3(seg, chamberH / 2, cT / 2) },
        surface: SurfaceId.Sandstone,
        group: CollisionGroup.StaticGeo,
      });
    }
  }
  // Roof slab, crenellated all round — the highest firing position over the gate.
  b.m(COPING).boxAt(0, chamberY + chamberH + 0.2, 0, halfW + 0.16, 0.2, depth + 0.16, 0.7, 0x3f);
  const roofY = chamberY + chamberH + 0.4;
  b.collider({
    matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, chamberY + chamberH + 0.2, 0)),
    shape: { kind: 'box', half: new THREE.Vector3(halfW + 0.16, 0.24, depth + 0.16) },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  for (const [along, outw, axis] of [[halfW, depth, 0], [depth, halfW, 1]] as const) {
    const n = Math.max(2, Math.floor((along * 2) / 1.75));
    for (const s of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.1)) continue;
        const t = -along + ((i + 0.5) / n) * along * 2;
        const px = axis === 0 ? t : s * (outw + 0.06);
        const pz = axis === 0 ? s * (outw + 0.06) : t;
        b.m(STONE).boxAt(px, roofY + PARAPET_H / 2, pz, axis === 0 ? 0.5 : 0.24, PARAPET_H / 2, axis === 0 ? 0.24 : 0.5, 1, 0x3f);
      }
    }
  }
  b.xf.pop();

  b.deck(cx, baseY + roofY, cz, halfW - 0.5, depth - 0.5, yaw, 0);
  b.deck(cx, baseY + WALK_Y, cz, halfW - 0.4, depth - 0.4, yaw, 0);
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(cx, baseY + roofY + PARAPET_H / 2, cz)
      .multiply(new THREE.Matrix4().makeRotationY(yaw)),
    half: new THREE.Vector3(halfW, PARAPET_H / 2, depth),
    groundY: baseY + roofY,
  });

  // The passage floor is the courtyard's — this is the deck that makes walking
  // in through the gate an actual navmesh route rather than a hole in it.
  b.deck(cx, baseY, cz, gateW / 2 - 0.2, depth, yaw, 0);
  b.exclude(cx, cz, halfW + 2);
}

/**
 * THE KEEP. Two storeys against the west curtain: an enterable vaulted ground
 * floor, an internal stair to the first floor, and a roof that opens onto the
 * rampart. The keep is where a squad that has taken the courtyard actually digs
 * in, and it is the last room of the fight.
 */
function keep(
  b: LevelBuild,
  cx: number, cz: number, yaw: number, baseY: number,
  rng: Rng,
): void {
  const hx = 8.2;
  const hz = 6.0;
  const floorH = 3.6;
  const t = 0.85;
  const m = new THREE.Matrix4().makeTranslation(cx, baseY, cz).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);

  for (let f = 0; f < 2; f++) {
    for (let side = 0; side < 4; side++) {
      const rot = (side * Math.PI) / 2;
      const starts: [number, number][] = [[-hx, hz], [hx, hz], [hx, -hz], [-hx, -hz]];
      const [sx, sz] = starts[side];
      const width = side % 2 === 0 ? hx * 2 : hz * 2;
      const openings: Opening[] = [];
      if (f === 0 && side === 0) {
        openings.push({ x0: width / 2 - 1.1, x1: width / 2 + 1.1, y0: 0.02, y1: 2.6, kind: 'arch', glass: false });
        openings.push({ x0: 1.6, x1: 2.5, y0: 1.5, y1: 2.6, kind: 'window', glass: true, shutter: 0 });
        openings.push({ x0: width - 2.5, x1: width - 1.6, y0: 1.5, y1: 2.6, kind: 'window', glass: true, shutter: 0 });
      } else if (f === 1 && side === 0) {
        for (let i = 0; i < 3; i++) {
          const c = ((i + 0.5) / 3) * width;
          openings.push({ x0: c - 0.5, x1: c + 0.5, y0: 0.9, y1: 2.3, kind: 'arch', glass: false });
        }
      } else if (side === 2) {
        openings.push({ x0: width / 2 - 0.45, x1: width / 2 + 0.45, y0: 1.4, y1: 2.4, kind: 'window', glass: true, shutter: 0 });
      } else if (side % 2 === 1) {
        openings.push({ x0: width / 2 - 0.28, x1: width / 2 + 0.28, y0: 1.5, y1: 2.6, kind: 'void' });
      }
      b.xf.push(
        new THREE.Matrix4().makeTranslation(sx, f * floorH, sz).multiply(new THREE.Matrix4().makeRotationY(rot)),
      );
      wallPanel(
        b,
        { width, height: floorH, thickness: t, mat: STONE, trim: COPING, openings, base: 0, through: true, uvScale: 0.7 },
        rng,
      );
      b.xf.pop();
      b.collider({
        matrix: new THREE.Matrix4()
          .multiplyMatrices(m, new THREE.Matrix4().makeTranslation(sx, f * floorH, sz).multiply(new THREE.Matrix4().makeRotationY(rot)))
          .multiply(new THREE.Matrix4().makeTranslation(width / 2, floorH / 2, -t / 2)),
        shape: { kind: 'box', half: new THREE.Vector3(width / 2, floorH / 2, t / 2) },
        surface: SurfaceId.Sandstone,
        group: CollisionGroup.StaticGeo,
      });
    }
    // Floor / ceiling slab, with the stairwell opening left out of it.
    const y = (f + 1) * floorH;
    for (const [ox, oz, ax, az] of [
      [0, hz * 0.42, hx - t, hz * 0.58 - t / 2],
      [-hx * 0.55, -hz * 0.45, hx * 0.45 - t / 2, hz * 0.55 - t / 2],
      [hx * 0.62, -hz * 0.45, hx * 0.38 - t / 2, hz * 0.55 - t / 2],
    ] as const) {
      b.m(COPING).boxAt(ox, y + 0.14, oz, ax, 0.14, az, 0.7, 0x3f);
      b.collider({
        matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(ox, y + 0.14, oz)),
        shape: { kind: 'box', half: new THREE.Vector3(ax, 0.18, az) },
        surface: SurfaceId.Concrete,
        group: CollisionGroup.StaticGeo,
      });
    }
    // Transverse arches carrying the slab — a stone room this span needs them,
    // and they turn a flat ceiling into three bays of light and shadow.
    for (const px of [-hx * 0.45, hx * 0.45]) {
      b.m(STONE).boxAt(px, f * floorH + floorH - 0.55, 0, 0.28, 0.55, hz - t, 1, 0x3f);
    }
  }

  // Internal stair, in the stairwell gap left in the slab.
  b.xf.pop();
  const swx = cx + hx * 0.05 * Math.cos(yaw) + -hz * 0.45 * Math.sin(yaw);
  const swz = cz - hx * 0.05 * Math.sin(yaw) + -hz * 0.45 * Math.cos(yaw);
  stairs(b, swx, baseY, swz, yaw + Math.PI / 2, 1.4, floorH + 0.14, floorH * 1.05, STONE, rng, 1);
  b.deck(cx, baseY, cz, hx - t - 0.2, hz - t - 0.2, yaw, 0);
  b.deck(cx, baseY + floorH + 0.28, cz, hx - t - 0.2, hz - t - 0.2, yaw, 0);
  /**
   * ONE blocker over the whole keep, not four wall stubs with a door gap.
   *
   * The navmesh cell is 2.0 m and the keep's door is 2.2 m wide, so a stubbed
   * wall would resolve into a doorway only if a cell centre happened to land in
   * it — which is a coin toss that changes if anything upstream moves. A
   * navmesh that sometimes has a route through a building is far worse than one
   * that reliably has none, so the bots go round and the PLAYER (whose
   * colliders are exact) still walks in. The two interior decks above are kept
   * deliberately: they are what the cover baker and the level's own debug view
   * read, and they are harmless to a blocked column.
   */
  b.blocker(cx, cz, hx + 0.1, hz + 0.1, yaw, baseY - 0.5, baseY + floorH * 2);

  b.xf.pushAbsolute(m);
  // Roof: a flat terrace with its own parapet, level with the rampart so you
  // can step straight across from the wall-walk.
  const roofY = floorH * 2 + 0.28;
  b.m(COPING).boxAt(0, roofY + 0.16, 0, hx + 0.28, 0.16, hz + 0.28, 0.7, 0x3f);
  for (const [ox, oz, ax, az] of [
    [0, hz + 0.2, hx + 0.4, 0.2], [0, -hz - 0.2, hx + 0.4, 0.2],
    [hx + 0.2, 0, 0.2, hz + 0.4], [-hx - 0.2, 0, 0.2, hz + 0.4],
  ] as const) {
    b.m(STONE).boxAt(ox, roofY + 0.32 + PARAPET_H / 2, oz, ax, PARAPET_H / 2, az, 1, 0x3f);
    b.m(COPING).boxAt(ox, roofY + 0.32 + PARAPET_H + 0.04, oz, ax + 0.05, 0.04, az + 0.05, 1, 0x3f);
  }
  b.collider({
    matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, roofY + 0.16, 0)),
    shape: { kind: 'box', half: new THREE.Vector3(hx + 0.28, 0.2, hz + 0.28) },
    surface: SurfaceId.Concrete,
    group: CollisionGroup.StaticGeo,
  });
  // Contents of the ground floor: a fire pit, ammo crates, a cot.
  b.m('rubble').cylinder(-hx * 0.4, 0.02, hz * 0.35, 0.75, 0.7, 0.22, 10, 1, true, false);
  b.m('wood').boxAt(hx * 0.5, 0.35, hz * 0.3, 0.9, 0.35, 0.55, 1, 0x3f);
  b.xf.pop();

  b.deck(cx, baseY + roofY + 0.32, cz, hx - 0.4, hz - 0.4, yaw, 0);
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(cx, baseY + roofY + 0.32 + PARAPET_H / 2, cz)
      .multiply(new THREE.Matrix4().makeRotationY(yaw)),
    half: new THREE.Vector3(hx + 0.4, PARAPET_H / 2, hz + 0.4),
    groundY: baseY + roofY + 0.32,
  });
  b.exclude(cx, cz, Math.max(hx, hz) + 2);
  for (let i = 0; i < 4; i++) {
    const lx = rng.range(-hx + 1.4, hx - 1.4);
    const lz = rng.range(-hz + 1.4, hz - 1.4);
    const px = cx + lx * Math.cos(yaw) + lz * Math.sin(yaw);
    const pz = cz - lx * Math.sin(yaw) + lz * Math.cos(yaw);
    if (rng.bool(0.5)) crateStack(b, px, baseY, pz, rng);
    else barrel(b, px, baseY, pz, rng);
  }
}

/**
 * Build the whole fort. Returns the courtyard floor height so the caller can
 * place the capture point on it rather than on the terrain under it.
 */
export function buildFort(b: LevelBuild, ground: Ground, rng: Rng): number {
  const cx = POINTS.charlie.x;
  const cz = POINTS.charlie.z;
  // The fort faces its approach: the headland road arrives from the north-east.
  const approach = { x: -172, z: -12 };
  const yaw = Math.atan2(approach.x - cx, approach.z - cz);

  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // Local +X points at the approach; +Z is 90° off it.
  const toWorld = (lx: number, lz: number): { x: number; z: number } => ({
    x: cx + lx * sin + lz * cos,
    z: cz + lx * cos - lz * sin,
  });

  const pts = OUTLINE.map(([lx, lz]) => toWorld(lx, lz));
  let footY = Infinity;
  let gTop = -Infinity;
  for (const p of pts) {
    const h = ground(p.x, p.z);
    if (h < footY) footY = h;
    if (h > gTop) gTop = h;
  }
  // The courtyard is a levelled platform on the fort's highest ground, so the
  // wall-walk is one height all the way round and the whole thing reads as
  // built rather than as draped.
  const baseY = gTop + 0.55;

  // Courtyard platform: a prism under the outline plus its collider.
  const poly: number[] = [];
  for (const p of pts) poly.push(p.x - cx, p.z - cz);
  b.xf.pushAbsolute(new THREE.Matrix4().makeTranslation(cx, 0, cz));
  b.m('sandstone').prism(poly, footY - 2.5, baseY, 0.45, true, false);
  b.xf.pop();
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(cx, (footY - 2.5 + baseY) / 2, cz),
    shape: { kind: 'box', half: new THREE.Vector3(26, (baseY - footY + 2.5) / 2, 26) },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  b.deck(cx, baseY, cz, 20, 20, yaw, 0);

  // Which side faces the approach most squarely? That is the gate. The one
  // furthest from it, on the seaward side, is the breach.
  const sideInfo = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    const mx = (p.x + q.x) / 2;
    const mz = (p.z + q.z) / 2;
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    // Outward normal for a polygon wound clockwise in XZ.
    const nx = (q.z - p.z) / len;
    const nz = -(q.x - p.x) / len;
    const toApproach = Math.hypot(approach.x - mx, approach.z - mz);
    const facing = (nx * (approach.x - mx) + nz * (approach.z - mz)) / toApproach;
    return { a: p, b: q, mx, mz, nx, nz, len, facing };
  });
  // Confirm the winding: if the "outward" normals point at the centre, flip.
  const flip = sideInfo[0].nx * (sideInfo[0].mx - cx) + sideInfo[0].nz * (sideInfo[0].mz - cz) < 0;
  if (flip) {
    for (const s of sideInfo) {
      s.nx = -s.nx;
      s.nz = -s.nz;
      s.facing = -s.facing;
    }
  }
  let gateIdx = 0;
  let breachIdx = 0;
  for (let i = 1; i < sideInfo.length; i++) {
    if (sideInfo[i].facing > sideInfo[gateIdx].facing) gateIdx = i;
    if (sideInfo[i].facing < sideInfo[breachIdx].facing) breachIdx = i;
  }

  const gateW = 3.4;
  for (let i = 0; i < sideInfo.length; i++) {
    const s = sideInfo[i];
    if (i === gateIdx) {
      curtain(b, s.a.x, s.a.z, s.b.x, s.b.z, s.nx, s.nz, baseY, footY, ground, rng, { gateWidth: gateW });
      gatehouse(b, s.mx, s.mz, Math.atan2(s.nx, s.nz), baseY, footY, gateW, rng);
    } else if (i === breachIdx) {
      breachRun(b, s.a.x, s.a.z, s.b.x, s.b.z, s.nx, s.nz, baseY, footY, ground, rng);
    } else {
      curtain(b, s.a.x, s.a.z, s.b.x, s.b.z, s.nx, s.nz, baseY, footY, ground, rng);
    }
  }

  // Corner towers on three of the five corners — the other two are where the
  // walls meet at a shallow angle and a tower would be absurd.
  const towerAt = [0, 2, 3];
  for (const i of towerAt) {
    const p = pts[i];
    tower(b, p.x, p.z, footY, baseY, 3.6 + (i === 0 ? 0.9 : 0), 9.4 + (i === 0 ? 2.2 : 0), ground, rng);
  }

  // Two stair flights from the courtyard up to the wall-walk, on opposite sides
  // so the rampart is never one contested ladder.
  for (const idx of [(gateIdx + 1) % sideInfo.length, (gateIdx + 3) % sideInfo.length]) {
    const s = sideInfo[idx];
    const inX = -s.nx;
    const inZ = -s.nz;
    // Start 5.5 m in from the wall centreline and run 5.0 m, so the top tread
    // lands 0.5 m inside the walk's inner edge rather than out over the parapet.
    stairs(
      b,
      s.mx + inX * 5.5 + (s.b.x - s.a.x) / s.len * 3.5,
      baseY,
      s.mz + inZ * 5.5 + (s.b.z - s.a.z) / s.len * 3.5,
      Math.atan2(-inX, -inZ),
      1.6, WALK_Y - 0.16, 5.0, STONE, rng, 1,
    );
  }

  // The keep, against the wall opposite the gate.
  const keepSide = sideInfo[(gateIdx + 2) % sideInfo.length];
  keep(
    b,
    keepSide.mx - keepSide.nx * 7.4,
    keepSide.mz - keepSide.nz * 7.4,
    Math.atan2(-keepSide.nx, -keepSide.nz),
    baseY, rng,
  );

  // The courtyard: a cistern head, hard cover, and the modern occupation on top
  // of the old stone — this is a fort that somebody is fighting out of TODAY.
  const well = toWorld(2, -3);
  b.m(STONE).cylinder(well.x, baseY, well.z, 1.5, 1.4, 0.95, 14, 1, true, false);
  b.m(COPING).cylinder(well.x, baseY + 0.95, well.z, 1.62, 1.62, 0.12, 14, 1, true, false);
  b.m('glass').cylinder(well.x, baseY + 0.5, well.z, 1.28, 1.28, 0.02, 14, 1, true, false);
  for (const s of [-1, 1]) {
    b.m('rust').tube(
      [new THREE.Vector3(well.x + s * 1.3, baseY, well.z), new THREE.Vector3(well.x + s * 0.75, baseY + 2.3, well.z)],
      0.045, 4, 1,
    );
  }
  b.m('wood').cylinder(well.x - 0.75, baseY + 2.25, well.z, 0.11, 0.11, 1.5, 8, 1, true, false);
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(well.x, baseY + 0.53, well.z),
    shape: { kind: 'cylinder', halfHeight: 0.53, radius: 1.62 },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(well.x, baseY + 0.53, well.z),
    half: new THREE.Vector3(1.62, 0.53, 1.62),
    groundY: baseY,
  });

  const gateSide = sideInfo[gateIdx];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.7;
    const p = toWorld(Math.cos(a) * 13.5, Math.sin(a) * 12.5);
    const face = Math.atan2(gateSide.mx - p.x, gateSide.mz - p.z);
    if (i % 3 === 0) sandbagWall(b, p.x, baseY, p.z, face, rng.range(3.2, 5.0), 5, rng, rng.range(-0.6, 0.6));
    else if (i % 3 === 1) concreteBarrier(b, p.x, baseY, p.z, face, rng);
    else crateStack(b, p.x, baseY, p.z, rng);
  }
  for (let i = 0; i < 6; i++) {
    const p = toWorld(rng.range(-16, 16), rng.range(-14, 16));
    barrel(b, p.x, baseY, p.z, rng);
  }
  // The spoil from the breach, dumped inside the courtyard.
  const spoil = toWorld(-11, 12);
  rubblePile(b, spoil.x, spoil.z, baseY, 3.4, 1.5, rng);

  // Railing along the two stair heads so the wall-walk edge is legible.
  for (const i of [gateIdx]) {
    const s = sideInfo[i];
    railing(
      b,
      s.a.x - s.nx * (WALL_T / 2 - 0.3), baseY + WALK_Y, s.a.z - s.nz * (WALL_T / 2 - 0.3),
      s.b.x - s.nx * (WALL_T / 2 - 0.3), baseY + WALK_Y, s.b.z - s.nz * (WALL_T / 2 - 0.3),
      0.95, rng, 'rust',
    );
  }

  b.exclude(cx, cz, 32);
  return baseY;
}
