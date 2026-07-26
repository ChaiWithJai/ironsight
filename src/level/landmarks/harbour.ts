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
import { blockChip, groundSkirt, rock, rubblePile } from '@/level/kit/ground';
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
      /**
       * TIDEMARK. The single most-missed detail on any waterline in this brief.
       *
       * A seawall carries three bands, and they are not a texture — they are
       * where the material CHANGES: dry masonry above the splash line, a bleached
       * salt band through the splash zone, and a dark weed/algae band from about
       * 0.9 m above chart datum down. Round 1's harbour critique: *"no tidemark
       * or algae band where the quay meets the waterline."* Without it the quay
       * looks like it was dropped into the sea five minutes ago.
       *
       * The top edge is deliberately IRREGULAR — swell does not draw a straight
       * line — and it is emitted as its own quad strip 3 cm proud of the wall so
       * it is a real surface with its own shading rather than a decal.
       */
      const bandTop = (t: number): number => 1.05 + Math.sin((p0x + (p1x - p0x) * t) * 0.55 + (p0z + (p1z - p0z) * t) * 0.31) * 0.34;
      const algae = b.m('rubble');
      const salt = b.m('sand');
      const segs = 4;
      for (let q = 0; q < segs; q++) {
        const u0 = q / segs;
        const u1 = (q + 1) / segs;
        const ax = p0x + (p1x - p0x) * u0;
        const az = p0z + (p1z - p0z) * u0;
        const bx = p0x + (p1x - p0x) * u1;
        const bz = p0z + (p1z - p0z) * u1;
        const ay = bandTop(u0);
        const by = bandTop(u1);
        // Weed band: irregular top, running down to well below the surface.
        algae.setUvShift((p0x + q) * 0.7, p0z * 0.7);
        algae.quad(
          _v[0].set(bx - nx * 0.03, by, bz - nz * 0.03),
          _v[1].set(ax - nx * 0.03, ay, az - nz * 0.03),
          _v[2].set(ax - nx * 0.03, -1.6, az - nz * 0.03),
          _v[3].set(bx - nx * 0.03, -1.6, bz - nz * 0.03),
          0.7,
        );
        algae.clearUvShift();
        // Bleached splash band above it, 0.5–0.9 m tall, fading into the wall.
        salt.setUvShift((p0z + q) * 0.9, p0x * 0.9);
        salt.quad(
          _v[0].set(bx - nx * 0.02, by + 0.62, bz - nz * 0.02),
          _v[1].set(ax - nx * 0.02, ay + 0.62, az - nz * 0.02),
          _v[2].set(ax - nx * 0.02, ay, az - nz * 0.02),
          _v[3].set(bx - nx * 0.02, by, bz - nz * 0.02),
          0.7,
        );
        salt.clearUvShift();
      }

      // Coping course along the very edge — the shadow line that reads as a quay.
      const mx = (p0x + p1x) / 2;
      const mz = (p0z + p1z) / 2;
      const yaw = Math.atan2(p1x - p0x, p1z - p0z);
      const m = new THREE.Matrix4().makeTranslation(mx + nx * 0.28, deck - 0.03, mz + nz * 0.28)
        .multiply(new THREE.Matrix4().makeRotationY(yaw));
      b.xf.pushAbsolute(m);
      b.m('concrete').setUvShift(rng.range(0, 30), rng.range(0, 30));
      // Chamfered, so the quay edge catches a bright arris against the water
      // instead of terminating on a hard 90° line, and occasionally a section is
      // broken away with the reinforcement showing.
      b.m('concrete').chamferBox(0, 0.09, 0, 0.32, 0.1, len / steps / 2, 0.035, 1, rng, 0.05);
      b.m('concrete').clearUvShift();
      if (rng.bool(0.22)) {
        const cl = len / steps / 2;
        for (let r = 0; r < 3; r++) {
          blockChip(b, 'rubble', rng.range(-0.25, 0.3), 0.2, rng.range(-cl, cl), rng.range(0.1, 0.22), rng);
        }
        for (let r = 0; r < 3; r++) {
          b.m('rust').tube(
            [new THREE.Vector3(-0.1, 0.19, -cl * 0.4 + r * 0.18), new THREE.Vector3(0.28, 0.24, -cl * 0.4 + r * 0.18)],
            0.012, 3, 1,
          );
        }
      }
      b.xf.pop();

      /**
       * THE APRON'S OWN HISTORY. A quay deck is the most worked surface on the
       * map: expansion joints every few metres, patched excavations, oil under
       * where the reach stacker parks, grit swept into the coping angle. Round 1
       * called the deck *"a flat tan plane… and it gets smoother as it approaches
       * the camera rather than gaining detail"*, which is the exact inversion of
       * what a density gradient should do.
       */
      {
        const jm = new THREE.Matrix4().makeTranslation(
          (p0x + p1x) / 2 + nx * QUAY.depth / 2, deck + 0.012, (p0z + p1z) / 2 + nz * QUAY.depth / 2,
        ).multiply(new THREE.Matrix4().makeRotationY(Math.atan2(p1x - p0x, p1z - p0z)));
        b.xf.pushAbsolute(jm);
        // Expansion joints: a shallow recessed strip across the apron.
        b.m('rubble').boxAt(0, -0.008, 0, QUAY.depth / 2 - 0.4, 0.012, 0.045, 1, 0x3f);
        // Two patched excavations of a different mix, proud by a centimetre.
        for (let p = 0; p < 2; p++) {
          const pw = rng.range(0.9, 2.4);
          const pl = rng.range(0.8, 2.0);
          b.m('sandstone').setUvShift(rng.range(0, 30), rng.range(0, 30));
          b.m('sandstone').chamferBox(
            rng.range(-QUAY.depth / 2 + 3, QUAY.depth / 2 - 3), 0.006, rng.range(-len / steps / 2, len / steps / 2),
            pw, 0.014, pl, 0.01, 0.6, rng, 0.12,
          );
          b.m('sandstone').clearUvShift();
        }
        // Aggregate and swept grit, densest toward the coping.
        for (let s2 = 0; s2 < 14; s2++) {
          const u = rng.next();
          const across = -QUAY.depth / 2 + (1 - Math.sqrt(u)) * QUAY.depth * 0.55 + 0.3;
          const along = rng.range(-len / steps / 2, len / steps / 2);
          if (rng.bool(0.45)) blockChip(b, rng.bool(0.5) ? 'rubble' : 'sand', across, -0.006, along, rng.range(0.05, 0.16), rng);
          else {
            const s3 = rng.range(0.04, 0.11);
            rock(b, 'sand', across, -0.004 + s3 * 0.3, along, s3, s3 * 0.4, s3 * 1.2, rng, 5);
          }
        }
        b.xf.pop();
      }
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
  /**
   * WHERE THE CRANE MEETS THE QUAY.
   *
   * A 900-tonne machine standing on a concrete apron does not meet it on a clean
   * line: there is a cast pad proud of the deck, a grout course under the sill,
   * spalled concrete around the rail chairs and forty years of grit swept into
   * the angle. Round 1's harbour critique named the leg pads specifically as one
   * of the frame's hard geometric intersections.
   */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * span;
      const pz = sz * legZ;
      b.m('concrete').setUvShift(rng.range(0, 30), rng.range(0, 30));
      b.m('concrete').chamferBox(px, 0.11, pz, 1.55, 0.12, 1.8, 0.04, 1, rng, 0.05);
      b.m('concrete').chamferBox(px, 0.23, pz, 1.15, 0.09, 1.35, 0.03, 1, rng, 0.06);
      b.m('concrete').clearUvShift();
      // Holding-down bolts through the pad — human scale on a huge machine.
      for (const bx of [-1, 1]) for (const bz of [-1, 1]) {
        b.m('rust').cylinder(px + bx * 1.05, 0.22, pz + bz * 1.3, 0.055, 0.055, 0.14, 6, 1, true, false);
      }
      for (let i = 0; i < 7; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(1.5, 3.4);
        blockChip(b, rng.bool(0.5) ? 'rubble' : 'sand', px + Math.cos(a) * r, 0.02, pz + Math.sin(a) * r * 1.2, rng.range(0.09, 0.24), rng);
      }
      for (let i = 0; i < 5; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(0.9, 2.6);
        const s = rng.range(0.07, 0.17);
        rock(b, 'sand', px + Math.cos(a) * r, 0.02 + s * 0.3, pz + Math.sin(a) * r * 1.2, s, s * 0.45, s * 1.1, rng, 5);
      }
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
  /**
   * THE TOP WORKS — machinery house, counterweight, cab, trolley and load.
   *
   * Round 1's atmosphere critique of BRAVO was, in full: *"the boxes slung under
   * the gantries are untextured flat-shaded cuboids… Worse, most are unsupported:
   * no hoist cable, no spreader bar and no trolley above them. They are literally
   * floating."* Every one of those was this block. Backlit at 40 m up, a lattice
   * truss washes out into a blown sky while a dark cuboid does not, so anything
   * up here that is not EXPLICITLY carried by something opaque reads as floating
   * even when it is geometrically resting on steel.
   *
   * So: every mass above gets a visible saddle, hanger or gantry that is thicker
   * than a truss chord, and the machinery gets the ribs, walkway, handrail and
   * door that separate a machinery house from a box.
   */
  const houseX = span * 0.4 + 7;

  // Saddle: two deep plate girders across the backreach that the house sits on,
  // plus the deck between them. This is the opaque thing that carries the mass.
  for (const sz of [-1, 1]) {
    b.m('steel').boxAt(houseX, boomY - 0.1, sz * 2.3, 3.6, 0.42, 0.16, 1, 0x3f);
  }
  b.m('steel').boxAt(houseX, boomY - 0.06, 0, 3.7, 0.08, 2.4, 1, 0x3f);
  for (const sx of [-1, 1]) {
    b.m('steel').boxAt(houseX + sx * 3.5, boomY - 0.6, 0, 0.16, 0.55, 2.3, 1, 0x3f);
  }

  // Machinery house: a ribbed box with a shallow roof, a door, louvred vents and
  // a walkway with a handrail all the way round.
  const hh = 1.55;
  b.m('paint').setUvShift(rng.range(0, 40), rng.range(0, 40));
  b.solid('paint', houseX, boomY + hh, 0, 3.2, hh, 2.2, { groundY: 0, noBlock: true, noCover: true });
  for (let i = 0; i <= 10; i++) {
    const px = houseX - 3.2 + (i / 10) * 6.4;
    for (const sz of [-1, 1]) b.m('paint').boxAt(px, boomY + hh, sz * 2.26, 0.07, hh - 0.12, 0.06, 1, 0x3f);
  }
  b.m('paint').clearUvShift();
  // Roof: a slab with a proud drip lip, and a pair of extract cowls.
  b.m('steel').boxAt(houseX, boomY + hh * 2 + 0.07, 0, 3.4, 0.07, 2.4, 1, 0x3f);
  for (const sx of [-1.6, 1.4]) {
    b.m('rust').cylinder(houseX + sx, boomY + hh * 2 + 0.14, 0.4, 0.34, 0.34, 0.55, 8, 1, true, false);
    b.m('rust').cylinder(houseX + sx, boomY + hh * 2 + 0.69, 0.4, 0.44, 0.1, 0.22, 8, 1, true, false);
  }
  // Door and louvres on the seaward face.
  b.m('rust').boxAt(houseX - 2.2, boomY + 0.95, -2.28, 0.45, 0.95, 0.05, 1, 0x3f);
  for (let i = 0; i < 5; i++) {
    b.m('steel').boxAt(houseX + 0.9, boomY + hh + 0.5 - i * 0.16, -2.3, 0.75, 0.05, 0.05, 1, 0x3f);
  }
  // Walkway + handrail around the house: the detail that gives it human scale.
  b.m('steel').boxAt(houseX, boomY - 0.02, -2.95, 3.6, 0.05, 0.75, 1, 0x3f);
  railing(b, houseX - 3.6, boomY + 0.03, -3.65, houseX + 3.6, boomY + 0.03, -3.65, 1.05, rng, 'steel');

  /**
   * COUNTERWEIGHT. A stack of cast slabs in a fabricated cradle, HUNG from two
   * plate hangers that reach up over the boom's top chord and are visibly wider
   * than it. Round 1 had a bare cuboid sitting in mid-air 1.3 m below the boom.
   */
  const cwX = span * 0.4 + 12.5;
  const cwTop = boomY - 0.55;
  for (const sz of [-1, 1]) {
    b.m('steel').boxAt(cwX, cwTop - 0.5, sz * 2.05, 1.85, 1.1, 0.14, 1, 0x3f);
  }
  b.m('steel').boxAt(cwX, cwTop + 0.28, 0, 1.9, 0.16, 2.15, 1, 0x3f);
  for (let i = 0; i < 4; i++) {
    b.m('rust').setUvShift(rng.range(0, 40), rng.range(0, 40));
    b.m('rust').chamferBox(cwX, cwTop - 0.25 - i * 0.42, 0, 1.62, 0.19, 1.85, 0.05, 1, rng, 0.04);
    b.m('rust').clearUvShift();
  }
  b.m('steel').boxAt(cwX, cwTop - 1.95, 0, 1.9, 0.1, 2.0, 1, 0x3f);

  /**
   * OPERATOR CAB, on a visible trolley frame that rides the jib. Two box beams
   * up to the boom's bottom chord, a hanger plate, and a glazed nose with a
   * floor window — a ship-to-shore driver looks straight DOWN at the hatch.
   */
  const cabX = -span * 0.4 - 8;
  b.m('steel').boxAt(cabX, boomY - 1.35, 0, 1.5, 0.22, 1.9, 1, 0x3f);
  for (const sz of [-1, 1]) {
    b.m('steel').boxAt(cabX, boomY - 2.2, sz * 1.05, 0.16, 0.75, 0.16, 1, 0x3f);
  }
  b.m('paint').setUvShift(rng.range(0, 40), rng.range(0, 40));
  b.solid('paint', cabX, boomY - 3.5, 0, 1.15, 1.05, 1.35, { groundY: 0, noBlock: true, noCover: true });
  b.m('paint').clearUvShift();
  b.m('glass').boxAt(cabX, boomY - 3.4, 1.38, 1.02, 0.72, 0.04, 1, 0x3f);
  b.m('glass').boxAt(cabX, boomY - 4.57, 0.55, 0.9, 0.03, 0.7, 1, 0x3f);
  for (const sx of [-1, 1]) b.m('steel').boxAt(cabX + sx * 1.17, boomY - 3.5, 0.9, 0.05, 1.05, 0.05, 1, 0x3f);

  /**
   * THE HOIST: trolley, four falls of wire, spreader, and a container on it.
   *
   * This is the single element that turns three towers into three working
   * machines, and it is also the answer to "floating boxes": the load is
   * suspended, and every viewer can trace the load → spreader → four cables →
   * trolley → boom chain without thinking about it.
   */
  const trX = -span * 0.4 - 14;
  const trolleyY = boomY - 1.15;
  b.m('steel').boxAt(trX, trolleyY, 0, 1.5, 0.3, 1.7, 1, 0x3f);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.m('steel').cylinder(trX + sx * 1.15, trolleyY + 0.3, sz * 1.35, 0.3, 0.3, 0.16, 8, 1, true, false);
  }
  const spreaderY = 8.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.m('steel').tube(
        [
          new THREE.Vector3(trX + sx * 1.2, trolleyY - 0.28, sz * 1.0),
          new THREE.Vector3(trX + sx * 2.55, spreaderY + 0.3, sz * 1.05),
        ],
        0.035, 4, 1,
      );
    }
  }
  // Head block and spreader beam.
  b.m('rust').boxAt(trX, spreaderY + 0.55, 0, 0.7, 0.22, 1.1, 1, 0x3f);
  b.m('rust').setUvShift(rng.range(0, 40), rng.range(0, 40));
  b.m('rust').boxAt(trX, spreaderY, 0, 3.2, 0.3, 0.55, 1, 0x3f);
  for (const sx of [-1, 1]) {
    b.m('rust').boxAt(trX + sx * 2.95, spreaderY - 0.05, 0, 0.35, 0.42, 1.25, 1, 0x3f);
    b.m('steel').boxAt(trX + sx * 2.95, spreaderY + 0.32, 0, 0.16, 0.4, 0.16, 1, 0x3f);
  }
  b.m('rust').clearUvShift();
  // The load itself: a corrugated container twist-locked under the spreader, so
  // the silhouette overhead is a box being MOVED rather than a box left in the
  // sky. Emitted in the crane's own frame and deliberately WITHOUT a collider or
  // a nav deck — nothing 30 m up on a wire is standable, and `dressing.container`
  // gives both, which is why this is not a call to it.
  {
    const load: MatKey = rng.pick(['rust', 'paint', 'steel'] as MatKey[]);
    const L = 6.06;
    const W = 1.22;
    const H = 1.3;
    const cy = spreaderY - 0.32 - H;
    const gm = b.m(load);
    gm.setUvShift(rng.range(0, 40), rng.range(0, 40));
    gm.boxAt(trX, cy, 0, L / 2, H, W, 1, 0x3f);
    const ribs = Math.round(L / 0.32);
    for (let i = 0; i <= ribs; i++) {
      const px = trX - L / 2 + (i / ribs) * L;
      for (const sz of [1, -1]) gm.boxAt(px, cy, sz * (W + 0.025), 0.06, H - 0.09, 0.03, 1, 0x3f);
    }
    for (const sy of [1, -1]) gm.boxAt(trX, cy + sy * (H - 0.06), 0, L / 2 + 0.02, 0.05, W + 0.03, 1, 0x3f);
    gm.clearUvShift();
    b.m('rust').boxAt(trX - L / 2 - 0.03, cy, 0, 0.03, H - 0.05, W - 0.04, 1, 0x3f);
    for (const s of [-0.6, -0.2, 0.2, 0.6]) {
      b.m('rust').boxAt(trX - L / 2 - 0.06, cy, s * W, 0.03, H - 0.12, 0.035, 1, 0x3f);
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      b.m('rust').boxAt(trX + sx * (L / 2 - 0.09), cy + sy * (H - 0.09), sz * (W - 0.09), 0.1, 0.1, 0.1, 1, 0x3f);
    }
    // Twist locks: the four short pins that actually hold it on the spreader.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.m('steel').boxAt(trX + sx * (L / 2 - 0.12), cy + H + 0.16, sz * (W - 0.12), 0.07, 0.18, 0.07, 1, 0x3f);
    }
  }
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
  // Per-shed UV phase, so three sheds on one apron do not carry the same streak
  // down the same rib. Cleared at the end of the local frame.
  b.m(clad).setUvShift(rng.range(0, 50), rng.range(0, 50));
  b.m(plinth).setUvShift(rng.range(0, 50), rng.range(0, 50));
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
  b.m(clad).clearUvShift();
  b.m(plinth).clearUvShift();
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
  // The long walls block; the gable ends do NOT, because their roller doors are
  // 4.2 m wide and the shed's whole point is that it is a through-route.
  for (const sz of [1, -1]) {
    b.blocker(
      x + (sz * hz) * Math.sin(yaw), z + (sz * hz) * Math.cos(yaw),
      hx, 0.35, yaw, g, g + wallH,
    );
  }
  b.exclude(x, z, Math.max(hx, hz) + 2);

  groundSkirt(
    b,
    [
      { x: x + (-hx - 0.3) * Math.cos(yaw) + (hz + 0.3) * Math.sin(yaw), z: z - (-hx - 0.3) * Math.sin(yaw) + (hz + 0.3) * Math.cos(yaw) },
      { x: x + (hx + 0.3) * Math.cos(yaw) + (hz + 0.3) * Math.sin(yaw), z: z - (hx + 0.3) * Math.sin(yaw) + (hz + 0.3) * Math.cos(yaw) },
      { x: x + (hx + 0.3) * Math.cos(yaw) + (-hz - 0.3) * Math.sin(yaw), z: z - (hx + 0.3) * Math.sin(yaw) + (-hz - 0.3) * Math.cos(yaw) },
      { x: x + (-hx - 0.3) * Math.cos(yaw) + (-hz - 0.3) * Math.sin(yaw), z: z - (-hx - 0.3) * Math.sin(yaw) + (-hz - 0.3) * Math.cos(yaw) },
    ],
    ground, rng, { amount: 1.3, blockFraction: 0.5 },
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
