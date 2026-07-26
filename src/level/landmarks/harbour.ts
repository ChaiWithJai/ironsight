/**
 * BRAVO — the harbour: quay, seawall, gantry cranes, warehouses, container
 * yard, fuel depot and the breakwater.
 *
 * OWNER: LEVEL.
 *
 * BRAVO is the lowest and most exposed of the three points and it is overlooked
 * by CHARLIE from 200 m, so it has to be the point with the most HARD COVER at
 * ground level. That is why the container yard exists: 2.6 m steel boxes in
 * staggered stacks give a lattice of lanes and dead ends that a squad can cross
 * under fire, and their tops are a second storey the crane stairs reach.
 *
 * The cranes do three jobs at once — silhouette against the sea, shadow across
 * the quay at golden hour, and a legible vertical scale reference that tells you
 * how big everything else is.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import { railing, stairs } from '@/level/kit/detail';
import { groundSkirt, rock, rubblePile } from '@/level/kit/ground';
import { barrel, bollard, container, crateStack, sandbagWall, tyreStack } from '@/level/dressing';
import { BREAKWATER, CRANES, QUAY } from '@/level/layout';
import type { MatKey } from '@/level/materials';

type Ground = (x: number, z: number) => number;
const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

/**
 * A square-section lattice truss between two points: four chords plus alternating
 * diagonals. This is the single highest-value primitive in the harbour — a crane
 * built from solid boxes reads as a toy, and a crane built from a lattice reads
 * as forty tonnes of steel even in silhouette.
 */
function truss(
  b: LevelBuild,
  mat: MatKey,
  from: THREE.Vector3,
  to: THREE.Vector3,
  width: number,
  bays: number,
  chord = 0.09,
): void {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 0.2) return;
  dir.divideScalar(len);
  const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(dir, up).normalize();
  const norm = new THREE.Vector3().crossVectors(side, dir).normalize();
  const offs: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const at = (t: number, ox: number, oy: number, out: THREE.Vector3): THREE.Vector3 =>
    out.copy(from).addScaledVector(dir, len * t)
      .addScaledVector(side, ox * width / 2)
      .addScaledVector(norm, oy * width / 2);
  const g = b.m(mat);
  for (const [ox, oy] of offs) {
    g.tube([at(0, ox, oy, new THREE.Vector3()), at(1, ox, oy, new THREE.Vector3())], chord, 4, 1);
  }
  for (let i = 0; i < bays; i++) {
    const t0 = i / bays;
    const t1 = (i + 1) / bays;
    // Rungs at every bay boundary, on all four faces.
    for (const [a, c] of [[offs[0], offs[1]], [offs[2], offs[3]], [offs[0], offs[2]], [offs[1], offs[3]]] as const) {
      g.tube([at(t1, a[0], a[1], new THREE.Vector3()), at(t1, c[0], c[1], new THREE.Vector3())], chord * 0.7, 3, 1);
      // One diagonal per bay per face, alternating direction — a Warren truss.
      const flip = i % 2 === 0;
      g.tube(
        [
          at(t0, flip ? a[0] : c[0], flip ? a[1] : c[1], new THREE.Vector3()),
          at(t1, flip ? c[0] : a[0], flip ? c[1] : a[1], new THREE.Vector3()),
        ],
        chord * 0.6, 3, 1,
      );
    }
  }
}

/**
 * The quay apron and its seawall. Built rather than terrain-cut, because the
 * macro terrace falls away seaward here and LEVEL cannot move TERRAIN's ground.
 */
export function buildQuay(b: LevelBuild, ground: Ground, rng: Rng): void {
  const edge = QUAY.edge;
  const deck = QUAY.deckY;
  const slab = b.m('concrete');
  const wall = b.m('sandstone');

  for (let i = 0; i < edge.length - 1; i++) {
    const a = edge[i];
    const c = edge[i + 1];
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    // Inland normal (the coastline runs roughly WSW→ENE with the sea at −Z).
    const nx = -(c.z - a.z) / len;
    const nz = (c.x - a.x) / len;
    const steps = Math.max(2, Math.round(len / 6));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const p0x = a.x + (c.x - a.x) * t0;
      const p0z = a.z + (c.z - a.z) * t0;
      const p1x = a.x + (c.x - a.x) * t1;
      const p1z = a.z + (c.z - a.z) * t1;
      const d = QUAY.depth;
      // Apron top.
      slab.quad(
        _v[0].set(p0x, deck, p0z),
        _v[1].set(p1x, deck, p1z),
        _v[2].set(p1x + nx * d, deck, p1z + nz * d),
        _v[3].set(p0x + nx * d, deck, p0z + nz * d),
        0.4,
      );
      // Seawall face, dropped to −4 m so it is buried whatever the seabed does.
      wall.quad(
        _v[0].set(p1x, deck, p1z),
        _v[1].set(p0x, deck, p0z),
        _v[2].set(p0x, -4, p0z),
        _v[3].set(p1x, -4, p1z),
        0.5,
      );
      // Coping course along the very edge — the shadow line that reads as a quay.
      const mx = (p0x + p1x) / 2;
      const mz = (p0z + p1z) / 2;
      const yaw = Math.atan2(p1x - p0x, p1z - p0z);
      const m = new THREE.Matrix4().makeTranslation(mx + nx * 0.28, deck - 0.03, mz + nz * 0.28)
        .multiply(new THREE.Matrix4().makeRotationY(yaw));
      b.xf.pushAbsolute(m);
      b.m('concrete').boxAt(0, 0.09, 0, 0.32, 0.1, len / steps / 2, 1, 0x3f);
      b.xf.pop();
    }
    // ONE collider for the whole apron segment plus its wall.
    const mx = (a.x + c.x) / 2 + nx * QUAY.depth / 2;
    const mz = (a.z + c.z) / 2 + nz * QUAY.depth / 2;
    b.collider({
      matrix: new THREE.Matrix4()
        .makeTranslation(mx, deck - 2.2, mz)
        .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(c.x - a.x, c.z - a.z))),
      shape: { kind: 'box', half: new THREE.Vector3(QUAY.depth / 2, 2.2, len / 2 + 0.5) },
      surface: SurfaceId.Concrete,
      group: CollisionGroup.StaticGeo,
    });
    b.deck(mx, deck, mz, QUAY.depth / 2, len / 2, Math.atan2(c.x - a.x, c.z - a.z), 0);

    // Bollards, fenders and the odd pile of rope along the edge.
    const n = Math.max(2, Math.round(len / 11));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const px = a.x + (c.x - a.x) * t + nx * 1.5;
      const pz = a.z + (c.z - a.z) * t + nz * 1.5;
      bollard(b, px, deck, pz, rng);
      if (rng.bool(0.5)) tyreStack(b, px + nx * 2.4, deck, pz + nz * 2.4, rng);
    }
    // Armour stone tumbled at the wall's foot, in the water.
    for (let k = 0; k < Math.round(len / 3.5); k++) {
      const t = rng.next();
      const px = a.x + (c.x - a.x) * t - nx * rng.range(0.6, 3.4);
      const pz = a.z + (c.z - a.z) * t - nz * rng.range(0.6, 3.4);
      const s = rng.range(0.5, 1.3);
      rock(b, 'sandstone', px, rng.range(-1.2, 0.9), pz, s, s * 0.8, s * 1.1, rng, 5);
    }
  }

  // Inland edge of the apron, where the slab meets the terrace.
  const inland = edge.map((p, i) => {
    const q = edge[Math.min(i + 1, edge.length - 1)];
    const r = edge[Math.max(i - 1, 0)];
    const len = Math.max(1e-3, Math.hypot(q.x - r.x, q.z - r.z));
    return { x: p.x - (q.z - r.z) / len * QUAY.depth, z: p.z + (q.x - r.x) / len * QUAY.depth };
  });
  groundSkirt(b, [...inland].reverse(), ground, rng, { amount: 0.9, noScatter: false });
}

/** One ship-to-shore gantry crane. */
export function buildCrane(b: LevelBuild, x: number, z: number, yaw: number, height: number, rng: Rng): void {
  const base = QUAY.deckY;
  const m = new THREE.Matrix4().makeTranslation(x, base, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);
  const span = 9.0;   // half the rail gauge
  const legZ = 4.0;   // half the leg spacing along the quay
  const legTop = height;

  // Rails.
  for (const sx of [-1, 1]) {
    b.solid('steel', sx * span, 0.06, 0, 0.14, 0.06, legZ + 7, { noBlock: true, noCover: true, groundY: 0 });
  }
  // Four legs: lattice, splayed inward, sitting on sill beams.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.solid('steel', sx * span, 0.4, sz * legZ, 0.75, 0.4, 1.0, { groundY: 0 });
      truss(
        b, 'steel',
        new THREE.Vector3(sx * span, 0.8, sz * legZ),
        new THREE.Vector3(sx * span * 0.78, legTop, sz * legZ * 0.6),
        1.5, Math.round(legTop / 3.2), 0.1,
      );
      // Collider for the leg: one box, because a lattice trimesh here would be
      // the most expensive collider on the map for a shape nobody hugs.
      b.collider({
        matrix: new THREE.Matrix4()
          .multiplyMatrices(m, new THREE.Matrix4().makeTranslation(sx * span * 0.9, legTop / 2, sz * legZ * 0.8)),
        shape: { kind: 'box', half: new THREE.Vector3(1.1, legTop / 2, 1.1) },
        surface: SurfaceId.PaintedMetal,
        group: CollisionGroup.StaticGeo,
      });
    }
  }
  // Portal beam and the sill bracing between leg pairs.
  for (const sz of [-1, 1]) {
    truss(
      b, 'steel',
      new THREE.Vector3(-span * 0.78, legTop, sz * legZ * 0.6),
      new THREE.Vector3(span * 0.78, legTop, sz * legZ * 0.6),
      1.5, 8, 0.1,
    );
    for (const sx of [-1, 1]) {
      b.m('steel').tube(
        [new THREE.Vector3(sx * span, 6.5, sz * legZ), new THREE.Vector3(sx * span * 0.85, legTop - 2, -sz * legZ * 0.6)],
        0.07, 4, 1,
      );
    }
  }
  // The boom: seaward jib and the landward backreach with its counterweight.
  const boomY = legTop + 2.4;
  truss(b, 'steel', new THREE.Vector3(-span * 0.4, boomY, 0), new THREE.Vector3(-span * 0.4 - 30, boomY - 1.4, 0), 2.2, 12, 0.11);
  truss(b, 'steel', new THREE.Vector3(-span * 0.4, boomY, 0), new THREE.Vector3(span * 0.4 + 15, boomY - 0.6, 0), 2.2, 6, 0.11);
  // A-frame and stay cables — the shape that says "gantry" from a kilometre.
  const apex = new THREE.Vector3(0, boomY + 9, 0);
  truss(b, 'steel', new THREE.Vector3(-span * 0.35, boomY, 0), apex, 1.2, 4, 0.08);
  truss(b, 'steel', new THREE.Vector3(span * 0.35, boomY, 0), apex, 1.2, 4, 0.08);
  b.m('steel').tube([apex.clone(), new THREE.Vector3(-span * 0.4 - 29, boomY - 1.3, 0)], 0.055, 4, 1);
  b.m('steel').tube([apex.clone(), new THREE.Vector3(span * 0.4 + 14, boomY - 0.6, 0)], 0.055, 4, 1);
  // Machinery house, counterweight and the operator cab under the boom.
  b.solid('paint', span * 0.4 + 7, boomY + 1.6, 0, 3.2, 1.6, 2.4, { groundY: 0, noBlock: true, noCover: true });
  b.solid('steel', span * 0.4 + 12.5, boomY - 1.9, 0, 1.6, 1.2, 2.0, { groundY: 0, noBlock: true, noCover: true });
  b.solid('paint', -span * 0.4 - 8, boomY - 3.4, 0, 1.1, 1.0, 1.3, { groundY: 0, noBlock: true, noCover: true });
  b.m('glass').boxAt(-span * 0.4 - 8, boomY - 3.4, 1.32, 1.0, 0.7, 0.03, 1, 0x3f);
  // Hoist cables and the spreader, parked low.
  for (const sz of [-1, 1]) {
    b.m('steel').tube(
      [new THREE.Vector3(-span * 0.4 - 14, boomY - 1.0, sz * 0.9), new THREE.Vector3(-span * 0.4 - 14, 7.5, sz * 0.9)],
      0.03, 3, 1,
    );
  }
  b.solid('rust', -span * 0.4 - 14, 6.7, 0, 3.0, 0.35, 1.3, { groundY: 0, noBlock: true, noCover: true });
  // Access stair up the landward leg, and a walkway you can actually stand on.
  stairs(b, span * 0.72, 0, legZ + 5.6, Math.PI, 1.1, 6.2, 5.0, 'steel', rng, 2);
  b.xf.pop();

  b.exclude(x, z, 14);
}

/**
 * A big shed: portal frame, corrugated cladding, roller doors, clerestory
 * glazing and an enterable interior. Enterable matters — an unopenable shed on
 * the biggest point on the map is a wall with a door painted on it.
 */
export function buildWarehouse(
  b: LevelBuild,
  x: number, z: number, hx: number, hz: number, yaw: number,
  ground: Ground,
  rng: Rng,
): void {
  const g = ground(x, z);
  const wallH = rng.range(6.2, 8.0);
  const ridge = rng.range(2.0, 3.0);
  const m = new THREE.Matrix4().makeTranslation(x, g, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);

  const clad: MatKey = rng.bool(0.5) ? 'rust' : 'steel';
  const plinth: MatKey = 'concrete';
  // Plinth and slab.
  b.m(plinth).boxAt(0, -0.6, 0, hx + 0.2, 1.0, hz + 0.2, 0.5, 0x3f);
  b.deck(x, g + 0.42, z, hx - 0.6, hz - 0.6, yaw, 0);

  // Long walls: corrugated cladding as a run of alternating ribs, which is what
  // gives the raking sun something to break up over a 30 m facade.
  const ribs = Math.max(8, Math.round((hx * 2) / 0.5));
  for (const sz of [1, -1]) {
    b.m(clad).boxAt(0, wallH / 2 + 0.4, sz * hz, hx, wallH / 2, 0.09, 0.5, 0x3f);
    for (let i = 0; i <= ribs; i++) {
      const px = -hx + (i / ribs) * hx * 2;
      b.m(clad).boxAt(px, wallH / 2 + 0.4, sz * (hz + 0.07), 0.07, wallH / 2 - 0.1, 0.05, 1, 0x3f);
    }
    // Clerestory band under the eaves.
    b.m('glass').boxAt(0, wallH + 0.05, sz * (hz + 0.02), hx - 0.8, 0.5, 0.05, 1, 0x3f);
    for (let i = 0; i < 7; i++) {
      b.m('steel').boxAt(-hx + 0.8 + (i / 6) * (hx * 2 - 1.6), wallH + 0.05, sz * (hz + 0.06), 0.05, 0.5, 0.04, 1, 0x3f);
    }
    b.collider({
      matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, wallH / 2 + 0.4, sz * hz)),
      shape: { kind: 'box', half: new THREE.Vector3(hx, wallH / 2 + 0.4, 0.2) },
      surface: SurfaceId.PaintedMetal,
      group: CollisionGroup.StaticGeo,
    });
  }
  // Gable ends with a roller door in each, so the shed is a through-route.
  for (const sx of [1, -1]) {
    const doorW = Math.min(4.2, hz * 0.8);
    const doorH = 4.4;
    // Wall around the door, in four pieces.
    b.m(clad).boxAt(sx * hx, wallH / 2 + 0.4, (hz + doorW) / 2 + 0.001, 0.09, wallH / 2, (hz - doorW) / 2, 0.5, 0x3f);
    b.m(clad).boxAt(sx * hx, wallH / 2 + 0.4, -(hz + doorW) / 2, 0.09, wallH / 2, (hz - doorW) / 2, 0.5, 0x3f);
    b.m(clad).boxAt(sx * hx, (wallH + doorH) / 2 + 0.4, 0, 0.09, (wallH - doorH) / 2, doorW / 2, 0.5, 0x3f);
    // Gable triangle above the eaves.
    const gm = b.m(clad);
    gm.triangle(
      _v[0].set(sx * hx, wallH + 0.4, -hz), _v[1].set(sx * hx, wallH + 0.4, hz), _v[2].set(sx * hx, wallH + 0.4 + ridge, 0), 1,
    );
    gm.triangle(
      _v[0].set(sx * hx, wallH + 0.4, hz), _v[1].set(sx * hx, wallH + 0.4, -hz), _v[2].set(sx * hx, wallH + 0.4 + ridge, 0), 1,
    );
    // The roller door itself: shutter slats, half up on one end.
    const open = sx > 0 ? rng.range(1.6, 3.2) : 0.0;
    const slats = 9;
    for (let i = 0; i < slats; i++) {
      const y = 0.4 + open + (i / slats) * (doorH - open);
      if (y > doorH + 0.4) break;
      b.m('paint').boxAt(sx * (hx + 0.05), y, 0, 0.04, (doorH - open) / slats / 2, doorW / 2, 1, 0x3f);
    }
    b.m('steel').boxAt(sx * (hx + 0.05), doorH + 0.62, 0, 0.08, 0.22, doorW / 2 + 0.15, 1, 0x3f);
    if (open < 0.2) {
      b.collider({
        matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(sx * hx, doorH / 2 + 0.4, 0)),
        shape: { kind: 'box', half: new THREE.Vector3(0.15, doorH / 2, doorW / 2) },
        surface: SurfaceId.PaintedMetal,
        group: CollisionGroup.StaticGeo,
      });
    }
    // Side wall colliders either side of the door.
    for (const s of [1, -1]) {
      b.collider({
        matrix: new THREE.Matrix4().multiplyMatrices(
          m, new THREE.Matrix4().makeTranslation(sx * hx, wallH / 2 + 0.4, s * (hz + doorW) / 2),
        ),
        shape: { kind: 'box', half: new THREE.Vector3(0.2, wallH / 2 + 0.4, (hz - doorW) / 2) },
        surface: SurfaceId.PaintedMetal,
        group: CollisionGroup.StaticGeo,
      });
    }
  }
  // Roof: two pitches, plus purlins visible from below.
  const rm = b.m(clad);
  for (const sz of [1, -1]) {
    rm.quad(
      _v[0].set(-hx - 0.35, wallH + 0.4, sz * (hz + 0.35)),
      _v[1].set(hx + 0.35, wallH + 0.4, sz * (hz + 0.35)),
      _v[2].set(hx + 0.35, wallH + 0.4 + ridge, 0),
      _v[3].set(-hx - 0.35, wallH + 0.4 + ridge, 0),
      0.5,
    );
    rm.quad(
      _v[0].set(hx + 0.35, wallH + 0.32, sz * (hz + 0.35)),
      _v[1].set(-hx - 0.35, wallH + 0.32, sz * (hz + 0.35)),
      _v[2].set(-hx - 0.35, wallH + 0.32 + ridge, 0),
      _v[3].set(hx + 0.35, wallH + 0.32 + ridge, 0),
      0.5,
    );
  }
  b.m('steel').boxAt(0, wallH + 0.5 + ridge, 0, hx + 0.4, 0.09, 0.28, 1, 0x3f);
  // Portal frames inside: rafters and stanchions, so the interior has structure.
  const frames = Math.max(3, Math.round(hx / 4));
  for (let i = 0; i <= frames; i++) {
    const px = -hx + (i / frames) * hx * 2;
    for (const sz of [1, -1]) {
      b.m('steel').boxAt(px, wallH / 2 + 0.4, sz * (hz - 0.16), 0.11, wallH / 2, 0.11, 1, 0x3f);
      b.m('steel').tube(
        [new THREE.Vector3(px, wallH + 0.35, sz * (hz - 0.16)), new THREE.Vector3(px, wallH + 0.3 + ridge, 0)],
        0.1, 4, 1,
      );
    }
  }
  // Contents: pallets, drums, a stack of crates, a spill of rope.
  for (let i = 0; i < 8; i++) {
    const px = rng.range(-hx + 1.6, hx - 1.6);
    const pz = rng.range(-hz + 1.4, hz - 1.4);
    if (rng.bool(0.4)) b.m('wood').boxAt(px, 0.5, pz, rng.range(0.6, 1.1), 0.1, rng.range(0.5, 0.9), 1, 0x3f);
  }
  b.xf.pop();

  // Props inside, in world space so their colliders land right.
  for (let i = 0; i < 7; i++) {
    const lx = rng.range(-hx + 2, hx - 2);
    const lz = rng.range(-hz + 1.8, hz - 1.8);
    const px = x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
    const pz = z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
    if (rng.bool(0.55)) crateStack(b, px, g + 0.42, pz, rng);
    else barrel(b, px, g + 0.42, pz, rng);
  }
  b.blocker(x, z, hx + 0.2, hz + 0.2, yaw, g, g + 0.3);
  b.exclude(x, z, Math.max(hx, hz) + 2);

  groundSkirt(
    b,
    [
      { x: x + (-hx - 0.3) * Math.cos(yaw) + (hz + 0.3) * Math.sin(yaw), z: z - (-hx - 0.3) * Math.sin(yaw) + (hz + 0.3) * Math.cos(yaw) },
      { x: x + (hx + 0.3) * Math.cos(yaw) + (hz + 0.3) * Math.sin(yaw), z: z - (hx + 0.3) * Math.sin(yaw) + (hz + 0.3) * Math.cos(yaw) },
      { x: x + (hx + 0.3) * Math.cos(yaw) + (-hz - 0.3) * Math.sin(yaw), z: z - (hx + 0.3) * Math.sin(yaw) + (-hz - 0.3) * Math.cos(yaw) },
      { x: x + (-hx - 0.3) * Math.cos(yaw) + (-hz - 0.3) * Math.sin(yaw), z: z - (-hx - 0.3) * Math.sin(yaw) + (-hz - 0.3) * Math.cos(yaw) },
    ],
    ground, rng, { amount: 1.05 },
  );
}

/**
 * The container yard. Stacks are placed on a loose grid with gaps, so the whole
 * thing reads as lanes rather than as a wall — and the lanes are the gameplay.
 */
export function buildContainerYard(
  b: LevelBuild,
  cx: number, cz: number, hx: number, hz: number, yaw: number,
  ground: Ground,
  rng: Rng,
): void {
  const palette: MatKey[] = ['rust', 'paint', 'steel', 'rust', 'paint'];
  const cols = Math.max(2, Math.round((hx * 2) / 7.4));
  const rows = Math.max(2, Math.round((hz * 2) / 3.6));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (rng.bool(0.3)) continue; // a lane
      const lx = -hx + (i + 0.5) * (hx * 2 / cols);
      const lz = -hz + (j + 0.5) * (hz * 2 / rows);
      const px = cx + lx * Math.cos(yaw) + lz * Math.sin(yaw);
      const pz = cz - lx * Math.sin(yaw) + lz * Math.cos(yaw);
      const g = ground(px, pz);
      const high = rng.bool(0.42) ? 2 : 1;
      for (let k = 0; k < high; k++) {
        const long = rng.bool(0.75);
        container(
          b,
          px + rng.range(-0.15, 0.15) * k,
          g + k * 2.62,
          pz + rng.range(-0.15, 0.15) * k,
          yaw + rng.range(-0.05, 0.05),
          long,
          rng.pick(palette),
          rng,
        );
      }
    }
  }
  b.exclude(cx, cz, Math.max(hx, hz) + 2);
}

/** Bulk fuel: three tanks in a bund, with catwalks, pipework and a flare stack. */
export function buildFuelDepot(b: LevelBuild, x: number, z: number, yaw: number, ground: Ground, rng: Rng): void {
  const g = ground(x, z);
  const m = new THREE.Matrix4().makeTranslation(x, g, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  b.xf.pushAbsolute(m);
  const bundHx = 17;
  const bundHz = 12;
  // Bund wall: a low containment ring you can fight over.
  for (const [sx, sz, ax, az] of [
    [0, 1, bundHx, 0.35], [0, -1, bundHx, 0.35], [1, 0, 0.35, bundHz], [-1, 0, 0.35, bundHz],
  ] as const) {
    b.solid('concrete', sx * bundHx, 0.62, sz * bundHz, ax, 0.62, az, { groundY: 0 });
  }
  const tanks: [number, number, number, number][] = [
    [-8.5, -4.5, 5.2, 8.4],
    [4.0, -5.0, 4.4, 7.2],
    [-1.0, 5.5, 6.0, 9.6],
  ];
  for (const [tx, tz, r, h] of tanks) {
    b.m('steel').cylinder(tx, 0.3, tz, r, r, h, 22, 0.6, false, false);
    // Ring stiffeners and the shell course lines: what stops a tank being a can.
    for (let i = 1; i < 4; i++) {
      b.m('steel').cylinder(tx, 0.3 + (i / 4) * h, tz, r + 0.06, r + 0.06, 0.1, 22, 1, false, false);
    }
    // Domed roof, approximated by two shallow cones.
    b.m('rust').cylinder(tx, 0.3 + h, tz, r, r * 0.72, 0.5, 22, 1, false, false);
    b.m('rust').cylinder(tx, 0.3 + h + 0.5, tz, r * 0.72, 0, 0.55, 22, 1, false, false);
    // Roof railing and the spiral stair cage.
    railing(b, tx - r * 0.75, 0.3 + h + 0.28, tz - r * 0.75, tx + r * 0.75, 0.3 + h + 0.28, tz - r * 0.75, 1.05, rng);
    b.m('steel').cylinder(tx + r + 0.5, 0.3, tz, 0.09, 0.09, h, 6, 1, true, false);
    for (let i = 0; i < Math.round(h / 0.42); i++) {
      const a = i * 0.55;
      b.m('steel').boxAt(
        tx + Math.cos(a) * (r + 0.55), 0.3 + i * 0.42, tz + Math.sin(a) * (r + 0.55),
        0.42, 0.03, 0.42, 1, 0x3f,
      );
    }
    b.collider({
      matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(tx, 0.3 + h / 2, tz)),
      shape: { kind: 'cylinder', halfHeight: h / 2 + 0.4, radius: r + 0.1 },
      surface: SurfaceId.PaintedMetal,
      group: CollisionGroup.StaticGeo,
    });
    b.blocker(
      x + tx * Math.cos(yaw) + tz * Math.sin(yaw),
      z - tx * Math.sin(yaw) + tz * Math.cos(yaw),
      r + 0.4, r + 0.4, 0, g, g + h,
    );
  }
  // Pipe gallery between the tanks and out to the quay.
  const runY = 1.35;
  for (const [ax, az, bx, bz] of [
    [-8.5, 0.9, 4.0, 0.9], [-1.0, 0.9, -1.0, -9.5], [4.0, -0.6, 14.0, -0.6],
  ] as const) {
    for (const off of [-0.32, 0, 0.32]) {
      b.m('rust').tube(
        [new THREE.Vector3(ax, runY + Math.abs(off) * 0.1, az + off), new THREE.Vector3(bx, runY + Math.abs(off) * 0.1, bz + off)],
        0.11, 6, 1,
      );
    }
    // Pipe supports.
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, bz - az) / 4));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      b.m('steel').boxAt(ax + (bx - ax) * t, runY / 2, az + (bz - az) * t, 0.08, runY / 2, 0.5, 1, 0x3f);
    }
  }
  // Flare / vent stack.
  b.m('steel').cylinder(13.5, 0.3, 8.0, 0.28, 0.2, 13, 10, 1, true, false);
  for (let i = 0; i < 4; i++) {
    b.m('steel').tube(
      [
        new THREE.Vector3(13.5, 9.5, 8.0),
        new THREE.Vector3(13.5 + Math.cos(i * 1.57) * 5, 0.3, 8.0 + Math.sin(i * 1.57) * 5),
      ],
      0.02, 3, 1,
    );
  }
  b.xf.pop();

  // Drums and pallets outside the bund; sandbags at the gate.
  for (let i = 0; i < 12; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(19, 26);
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    if (ground(px, pz) < 1.5) continue;
    barrel(b, px, ground(px, pz), pz, rng);
  }
  sandbagWall(b, x - 6, g, z - 14, yaw, 6, 5, rng, 0.7);
  b.exclude(x, z, 24);
}

/**
 * The breakwater. The macro ridge under it dies at about half its length, so the
 * outer half stands on piers — which is both true to how these are built and the
 * reason the arm reads as a structure rather than as a spit of land.
 */
export function buildBreakwater(b: LevelBuild, ground: Ground, rng: Rng): void {
  const { root, tip, deckY, halfWidth } = BREAKWATER;
  const len = Math.hypot(tip.x - root.x, tip.z - root.z);
  const dx = (tip.x - root.x) / len;
  const dz = (tip.z - root.z) / len;
  const nx = dz;
  const nz = -dx;
  const steps = Math.round(len / 4);
  const deck = b.m('concrete');
  const stone = b.m('sandstone');

  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const p0x = root.x + dx * len * t0;
    const p0z = root.z + dz * len * t0;
    const p1x = root.x + dx * len * t1;
    const p1z = root.z + dz * len * t1;
    const w0 = halfWidth * (1 - t0 * 0.25);
    const w1 = halfWidth * (1 - t1 * 0.25);
    // Deck.
    deck.quad(
      _v[0].set(p0x - nx * w0, deckY, p0z - nz * w0),
      _v[1].set(p1x - nx * w1, deckY, p1z - nz * w1),
      _v[2].set(p1x + nx * w1, deckY, p1z + nz * w1),
      _v[3].set(p0x + nx * w0, deckY, p0z + nz * w0),
      0.4,
    );
    // Flanks down to the seabed, or to the pier line.
    for (const s of [1, -1]) {
      stone.quad(
        _v[0].set(p1x + s * nx * w1, deckY, p1z + s * nz * w1),
        _v[1].set(p0x + s * nx * w0, deckY, p0z + s * nz * w0),
        _v[2].set(p0x + s * nx * (w0 + 2.2), -6, p0z + s * nz * (w0 + 2.2)),
        _v[3].set(p1x + s * nx * (w1 + 2.2), -6, p1z + s * nz * (w1 + 2.2)),
        0.5,
      );
    }
    // Seaward parapet, broken in places by storms.
    if (!rng.bool(0.12)) {
      const mx = (p0x + p1x) / 2 + nx * (w0 - 0.5);
      const mz = (p0z + p1z) / 2 + nz * (w0 - 0.5);
      const yaw = Math.atan2(p1x - p0x, p1z - p0z);
      const mm = new THREE.Matrix4().makeTranslation(mx, deckY, mz).multiply(new THREE.Matrix4().makeRotationY(yaw));
      b.xf.pushAbsolute(mm);
      b.solid('sandstone', 0, 0.62, 0, 0.5, 0.62, len / steps / 2, { groundY: deckY });
      b.m('concrete').boxAt(0, 1.28, 0, 0.6, 0.06, len / steps / 2, 1, 0x3f);
      b.xf.pop();
    }
    // Armour stone tumbled along both flanks.
    for (let k = 0; k < 4; k++) {
      const t = t0 + (t1 - t0) * rng.next();
      const s = rng.sign();
      const w = halfWidth * (1 - t * 0.25) + rng.range(1.0, 4.5);
      const px = root.x + dx * len * t + s * nx * w;
      const pz = root.z + dz * len * t + s * nz * w;
      const sz = rng.range(0.7, 1.9);
      rock(b, 'sandstone', px, rng.range(-2.4, 1.4), pz, sz, sz * 0.85, sz * 1.15, rng, 5);
    }
  }
  // One collider for the whole arm, plus a nav deck.
  b.collider({
    matrix: new THREE.Matrix4()
      .makeTranslation((root.x + tip.x) / 2, deckY - 3, (root.z + tip.z) / 2)
      .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(tip.x - root.x, tip.z - root.z))),
    shape: { kind: 'box', half: new THREE.Vector3(halfWidth, 3, len / 2) },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });
  b.deck(
    (root.x + tip.x) / 2, deckY, (root.z + tip.z) / 2,
    halfWidth - 0.6, len / 2, Math.atan2(tip.x - root.x, tip.z - root.z), 0,
  );

  // The light tower at the head.
  const lx = tip.x;
  const lz = tip.z;
  b.m('concrete').cylinder(lx, deckY - 0.2, lz, 2.6, 2.2, 1.0, 14, 0.6, true, false);
  b.m('sandstone').cylinder(lx, deckY + 0.8, lz, 1.7, 1.35, 7.0, 14, 0.6, false, false);
  b.m('concrete').cylinder(lx, deckY + 7.8, lz, 1.9, 1.9, 0.28, 14, 1, true, false);
  railing(b, lx - 1.7, deckY + 8.1, lz, lx + 1.7, deckY + 8.1, lz, 0.95, rng);
  b.m('steel').cylinder(lx, deckY + 8.1, lz, 1.05, 1.0, 1.9, 10, 1, false, false);
  b.m('glass').cylinder(lx, deckY + 8.3, lz, 1.02, 1.02, 1.4, 10, 1, false, false);
  b.m('rust').cylinder(lx, deckY + 10.0, lz, 1.15, 0.15, 1.1, 10, 1, true, false);
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(lx, deckY + 4.3, lz),
    shape: { kind: 'cylinder', halfHeight: 4.3, radius: 1.9 },
    surface: SurfaceId.Sandstone,
    group: CollisionGroup.StaticGeo,
  });

  // A ramp from the quay onto the root, and cover along the arm.
  stairs(b, root.x - 1.5, ground(root.x, root.z) + 0.3, root.z + 5.5, Math.PI + 0.5, 3.0, deckY - ground(root.x, root.z) - 0.3, 5.0, 'sandstone', rng, 1);
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    const px = root.x + dx * len * t + nx * rng.range(-1.5, 1.5);
    const pz = root.z + dz * len * t + nz * rng.range(-1.5, 1.5);
    if (rng.bool(0.5)) crateStack(b, px, deckY, pz, rng);
    else if (rng.bool(0.5)) barrel(b, px, deckY, pz, rng);
    else sandbagWall(b, px, deckY, pz, Math.atan2(dx, dz) + Math.PI / 2, 3.2, 4, rng, 0.4);
  }
  rubblePile(b, root.x + dx * len * 0.42, root.z + dz * len * 0.42, deckY, 3.2, 1.4, rng);
}
