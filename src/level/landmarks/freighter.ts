/**
 * THE HALF-SUNK FREIGHTER, aground on the reef off the breakwater head.
 *
 * OWNER: LEVEL.
 *
 * She is not a capture point and nobody fights on her. She is there for three
 * reasons, all of which are about the frame rather than the gameplay:
 *
 *  1. SCALE. 84 m of hull at 130 m from the breakwater is the only object in the
 *     map that tells you how big the harbour actually is. Without it the sea is
 *     a featureless plane and the map reads half its true size.
 *  2. THE WATERLINE. WATER's shoreline foam, refraction and wave shoaling all
 *     need something with a hard vertical edge sitting IN the water to read
 *     against. A hull heeled 14° gives them a waterline that is neither
 *     horizontal in screen space nor parallel to the shore.
 *  3. SILHOUETTE AGAINST THE SUN. She is placed north-east of the town, which at
 *     golden hour with the sun low over the water puts her between the camera
 *     and the brightest part of the frame from BRAVO and from the breakwater.
 *
 * She is authored in SHIP-LOCAL coordinates — origin amidships at the waterline,
 * +X forward, +Y up, +Z to port — and planted with one matrix carrying her
 * heading, her list to starboard and her trim down by the stern. Everything
 * below her local y = 0 is still modelled: the hull sides continue to −7 m so
 * there is no open bottom for the camera to see through from a low angle over a
 * wave crest, which is the failure a flat "boat-shaped lid" always has.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import { railing } from '@/level/kit/detail';
import { rock } from '@/level/kit/ground';
import { container } from '@/level/dressing';
import { FREIGHTER } from '@/level/layout';
import type { MatKey } from '@/level/materials';

const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

/**
 * Hull half-beam as a fraction of the maximum, at a fore-aft station t ∈ [0,1]
 * running stern → bow. A ship is not a lozenge: she is parallel-sided for the
 * middle 45% of her length, tapers hard forward and rounds off aft. Getting this
 * curve right is most of what makes the silhouette read as a ship.
 */
function beamAt(t: number): number {
  if (t < 0.12) return Math.sqrt(Math.max(0, t / 0.12)) * 0.72;
  if (t < 0.28) return 0.72 + 0.28 * ((t - 0.12) / 0.16);
  if (t < 0.73) return 1.0;
  const u = (t - 0.73) / 0.27;
  // Cubic entry: fine forward waterlines, and a stem that is nearly a knife.
  return Math.max(0.02, 1 - u * u * (3 - 2 * u) * 0.99);
}

/** Draught fraction: the keel rises toward the bow and toward the stern. */
function keelAt(t: number): number {
  if (t > 0.86) return 1 - (t - 0.86) / 0.14 * 0.55;
  if (t < 0.06) return 1 - (0.06 - t) / 0.06 * 0.4;
  return 1;
}

export function buildFreighter(b: LevelBuild, rng: Rng): void {
  const { x, z, yaw, roll, pitch, length, beam } = FREIGHTER;
  const m = new THREE.Matrix4().makeTranslation(x, 0, z)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeRotationZ(pitch))
    .multiply(new THREE.Matrix4().makeRotationX(roll));
  b.xf.pushAbsolute(m);

  const halfL = length / 2;
  const halfB = beam / 2;
  const depth = 7.0;      // keel to main deck
  const freeboard = 3.4;  // waterline to main deck, amidships, before the list
  const stations = 26;
  const hull: MatKey = 'rust';
  const boot: MatKey = 'paint';   // the boot-top stripe at the waterline
  const deckMat: MatKey = 'steel';

  // ---- hull shell -------------------------------------------------------
  // Three longitudinal strakes per side so the boot-top can be a different
  // material: below the waterline, the boot band, and the topsides. A single
  // strake would put the whole hull in one colour and lose the one horizontal
  // line that says "this floats".
  const bands: [number, number, MatKey][] = [
    [-depth, -0.55, hull],
    [-0.55, 0.55, boot],
    [0.55, freeboard, hull],
  ];
  const hullPt = (t: number, y: number, side: number, out: THREE.Vector3): THREE.Vector3 => {
    const px = -halfL + t * length;
    // Tumblehome: the topsides pull in slightly above the waterline, which is
    // what stops the hull reading as an extruded rectangle at a grazing angle.
    const flare = y > 0 ? 1 - (y / freeboard) * 0.06 : 1 - (-y / depth) * 0.34 * keelAt(t);
    return out.set(px, y, side * halfB * beamAt(t) * flare);
  };
  for (const [y0, y1, mat] of bands) {
    const g = b.m(mat);
    for (let i = 0; i < stations; i++) {
      const t0 = i / stations;
      const t1 = (i + 1) / stations;
      for (const s of [1, -1]) {
        // Wound so the outward normal faces away from the centreline.
        if (s > 0) {
          g.quad(
            hullPt(t0, y0, s, _v[0]), hullPt(t1, y0, s, _v[1]),
            hullPt(t1, y1, s, _v[2]), hullPt(t0, y1, s, _v[3]), 0.35,
          );
        } else {
          g.quad(
            hullPt(t1, y0, s, _v[0]), hullPt(t0, y0, s, _v[1]),
            hullPt(t0, y1, s, _v[2]), hullPt(t1, y1, s, _v[3]), 0.35,
          );
        }
      }
    }
  }
  // Keel / bottom, so there is no hole under her.
  {
    const g = b.m(hull);
    for (let i = 0; i < stations; i++) {
      const t0 = i / stations;
      const t1 = (i + 1) / stations;
      g.quad(
        hullPt(t0, -depth, -1, _v[0]), hullPt(t1, -depth, -1, _v[1]),
        hullPt(t1, -depth, 1, _v[2]), hullPt(t0, -depth, 1, _v[3]), 0.4,
      );
    }
  }
  // Transom and stem: flat plates closing the ends.
  {
    const g = b.m(hull);
    g.quad(
      hullPt(0, -depth, 1, _v[0]), hullPt(0, -depth, -1, _v[1]),
      hullPt(0, freeboard, -1, _v[2]), hullPt(0, freeboard, 1, _v[3]), 0.4,
    );
    g.quad(
      hullPt(1, -depth, -1, _v[0]), hullPt(1, -depth, 1, _v[1]),
      hullPt(1, freeboard, 1, _v[2]), hullPt(1, freeboard, -1, _v[3]), 0.4,
    );
  }
  // Sheer strake and the fender rubbing band: two proud rails running the full
  // length. They catch the low sun as a bright line and they are the single
  // cheapest thing that makes a hull look plated instead of moulded.
  for (const [y, r] of [[freeboard - 0.25, 0.16], [0.75, 0.11]] as const) {
    for (const s of [1, -1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= stations; i++) {
        pts.push(hullPt(i / stations, y, s, new THREE.Vector3()).clone());
      }
      b.m(deckMat).tube(pts, r, 4, 1);
    }
  }
  // Frame lines: vertical weld seams every 3.2 m. Barely visible, and exactly
  // the kind of micro-relief that stops a 84 m surface going smooth on approach.
  for (let i = 1; i < stations; i++) {
    const t = i / stations;
    for (const s of [1, -1]) {
      const a = hullPt(t, -1.5, s, new THREE.Vector3()).clone();
      const c = hullPt(t, freeboard - 0.3, s, new THREE.Vector3()).clone();
      b.m(hull).tube([a, c], 0.045, 3, 1);
    }
  }

  // ---- main deck and cargo holds ---------------------------------------
  const deckY = freeboard;
  {
    const g = b.m(deckMat);
    for (let i = 0; i < stations; i++) {
      const t0 = i / stations;
      const t1 = (i + 1) / stations;
      g.quad(
        hullPt(t0, deckY, -1, _v[0]), hullPt(t1, deckY, -1, _v[1]),
        hullPt(t1, deckY, 1, _v[2]), hullPt(t0, deckY, 1, _v[3]), 0.5,
      );
    }
  }
  // Bulwark: a 1.1 m plate all round the deck edge, with two washports missing.
  for (let i = 0; i < stations; i++) {
    const t0 = i / stations;
    const t1 = (i + 1) / stations;
    if (i === 8 || i === 17) continue;
    for (const s of [1, -1]) {
      const a = hullPt(t0, deckY, s, new THREE.Vector3());
      const c = hullPt(t1, deckY, s, new THREE.Vector3());
      const g = b.m(hull);
      if (s > 0) {
        g.quad(
          _v[0].set(a.x, deckY, a.z), _v[1].set(c.x, deckY, c.z),
          _v[2].set(c.x, deckY + 1.1, c.z), _v[3].set(a.x, deckY + 1.1, a.z), 1,
        );
      } else {
        g.quad(
          _v[0].set(c.x, deckY, c.z), _v[1].set(a.x, deckY, a.z),
          _v[2].set(a.x, deckY + 1.1, a.z), _v[3].set(c.x, deckY + 1.1, c.z), 1,
        );
      }
    }
  }
  // Three hatch coamings forward of the house, one of them with the covers off
  // and the hold flooded — the thing that makes her a WRECK and not a ship.
  for (let h = 0; h < 3; h++) {
    const hx0 = -halfL * 0.55 + h * 13.5;
    const cw = halfB * 0.66;
    b.m(deckMat).boxAt(hx0, deckY + 0.62, 0, 5.4, 0.62, cw, 1, 0x3f);
    if (h === 1) {
      // Open hold: a dark void with the coaming's inner faces showing.
      b.m('glass').boxAt(hx0, deckY + 0.3, 0, 5.0, 0.3, cw - 0.42, 1, 0x10 | 0x04);
      // A hatch cover pitched off and lying half over the opening.
      const cm = new THREE.Matrix4().makeTranslation(hx0 + 5.4, deckY + 1.4, cw * 0.4)
        .multiply(new THREE.Matrix4().makeRotationZ(0.55))
        .multiply(new THREE.Matrix4().makeRotationY(0.26));
      b.xf.push(cm);
      b.m(hull).boxAt(0, 0, 0, 5.1, 0.16, cw - 0.3, 1, 0x3f);
      b.xf.pop();
    } else {
      b.m(hull).boxAt(hx0, deckY + 1.28, 0, 5.2, 0.15, cw - 0.15, 0.8, 0x3f);
      for (let i = 0; i < 6; i++) {
        b.m(deckMat).boxAt(hx0 - 4.4 + i * 1.75, deckY + 1.44, 0, 0.07, 0.07, cw - 0.2, 1, 0x3f);
      }
    }
  }
  // Deck cargo: a few containers still lashed down, and two gone over the side.
  for (let i = 0; i < 5; i++) {
    const px = -halfL * 0.62 + i * 8.5;
    const pz = (i % 2 === 0 ? 1 : -1) * halfB * 0.42;
    container(b, px, deckY + 1.3, pz, Math.PI / 2 + rng.range(-0.04, 0.04), true, rng.pick(['rust', 'paint', 'steel'] as MatKey[]), rng);
  }

  // ---- deckhouse, funnel and masts -------------------------------------
  const hx = -halfL * 0.72;
  const houseH = 9.5;
  for (let f = 0; f < 3; f++) {
    const w = 5.6 - f * 0.55;
    const d = halfB * (0.92 - f * 0.06);
    b.m('plasterWhite').boxAt(hx, deckY + 1.6 + f * 2.9, 0, w, 1.45, d, 0.7, 0x3f);
    // Window band per deck, set into a shadow line.
    b.m('glass').boxAt(hx, deckY + 2.3 + f * 2.9, 0, w - 0.35, 0.55, d + 0.04, 1, 0x3f);
    b.m(deckMat).boxAt(hx, deckY + 3.05 + f * 2.9, 0, w + 0.42, 0.09, d + 0.42, 1, 0x3f);
    if (f < 2) railing(b, hx - w - 0.3, deckY + 3.14 + f * 2.9, d + 0.36, hx + w + 0.3, deckY + 3.14 + f * 2.9, d + 0.36, 1.0, rng);
  }
  // Bridge wings.
  for (const s of [1, -1]) {
    b.m(deckMat).boxAt(hx, deckY + 7.75, s * (halfB * 0.78 + 1.6), 1.5, 0.09, 1.7, 1, 0x3f);
    railing(b, hx - 1.4, deckY + 7.84, s * (halfB * 0.78 + 3.2), hx + 1.4, deckY + 7.84, s * (halfB * 0.78 + 3.2), 1.0, rng);
  }
  // Funnel: raked, with a black top band and a whistle platform.
  const fm = new THREE.Matrix4().makeTranslation(hx - 4.4, deckY + houseH, 0)
    .multiply(new THREE.Matrix4().makeRotationZ(0.12));
  b.xf.push(fm);
  b.m('paint').cylinder(0, 0, 0, 1.85, 1.62, 4.4, 14, 0.7, false, false);
  b.m(hull).cylinder(0, 4.4, 0, 1.66, 1.66, 0.85, 14, 1, true, false);
  b.m('glass').cylinder(0, 5.2, 0, 1.35, 1.35, 0.05, 14, 1, true, false);
  for (const s of [1, -1]) b.m(deckMat).tube(
    [new THREE.Vector3(0.9, 3.2, s * 1.6), new THREE.Vector3(0.9, 4.9, s * 0.5)], 0.05, 4, 1,
  );
  b.xf.pop();
  // Foremast and the derrick posts. She lost her radar off the top.
  b.m(deckMat).cylinder(halfL * 0.42, deckY, 0, 0.32, 0.2, 13.5, 8, 1, false, false);
  for (const y of [5.5, 9.2]) {
    b.m(deckMat).boxAt(halfL * 0.42, deckY + y, 0, 0.09, 0.09, 3.2, 1, 0x3f);
  }
  for (const s of [1, -1]) {
    b.m(deckMat).tube(
      [
        new THREE.Vector3(halfL * 0.42, deckY + 13.0, 0),
        new THREE.Vector3(halfL * 0.2, deckY + 1.2, s * halfB * 0.8),
      ],
      0.025, 3, 1,
    );
  }
  for (let i = 0; i < 2; i++) {
    const px = -halfL * 0.34 + i * 27;
    b.m('rust').tube(
      [new THREE.Vector3(px, deckY, 0), new THREE.Vector3(px + 7.5, deckY + 9.5, i === 0 ? 3.2 : -2.6)],
      0.28, 6, 1,
    );
    b.m(deckMat).cylinder(px, deckY, 0, 0.42, 0.42, 1.4, 8, 1, true, false);
  }
  // Anchor chain out the hawse and down into the water — the ship is ANCHORED,
  // and the chain is the one line that says so without a caption.
  b.m('rust').slackLine(
    new THREE.Vector3(halfL * 0.9, deckY - 0.8, halfB * 0.35),
    new THREE.Vector3(halfL * 1.35, -8.5, halfB * 1.4),
    1.8, 0.11, 8,
  );
  // Accommodation ladder hanging off the starboard side, half unshipped.
  b.m(deckMat).tube(
    [new THREE.Vector3(hx + 6, deckY, halfB * 0.95), new THREE.Vector3(hx + 12.5, -1.2, halfB * 1.9)],
    0.09, 4, 1,
  );

  b.xf.pop();

  // ---- colliders and the reef ------------------------------------------
  // Two boxes, not a hull trimesh. Nobody can get to her, so all the colliders
  // are doing is stopping a stray bullet or a grenade passing through 84 m of
  // steel — and a trimesh of the whole hull would be the single most expensive
  // collider on the map for that.
  b.collider({
    matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(0, freeboard / 2 - 1, 0)),
    shape: { kind: 'box', half: new THREE.Vector3(halfL * 0.86, (freeboard + depth) / 2, halfB * 0.92) },
    surface: SurfaceId.RustedMetal,
    group: CollisionGroup.StaticGeo,
    occluder: true,
  });
  b.collider({
    matrix: new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(hx, freeboard + 4.8, 0)),
    shape: { kind: 'box', half: new THREE.Vector3(5.8, 4.8, beam * 0.46) },
    surface: SurfaceId.PaintedMetal,
    group: CollisionGroup.StaticGeo,
  });

  /**
   * The reef she went aground on: a spine of rock running out from under her
   * stern quarter and breaking the surface off her port bow. It is the reason
   * she is where she is, and it is also the thing that tells the player the
   * water there is shallow — a wreck with clear water all round it reads as a
   * ship that simply parked.
   *
   * The spine runs along her KEEL LINE (the world direction of local +X under
   * `makeRotationY(yaw)`, which is `(cos yaw, −sin yaw)`), offset to the side she
   * heeled away from, so it is under her rather than beside her.
   */
  const keelX = Math.cos(yaw);
  const keelZ = -Math.sin(yaw);
  for (let i = 0; i < 18; i++) {
    const t = i / 17;
    const along = (t - 0.35) * length * 0.95;
    const side = (-keelZ) * (6 + Math.sin(t * 5.1) * 7);
    const rx = x + keelX * along + side;
    const rz = z + keelZ * along + keelX * (6 + Math.sin(t * 5.1) * 7);
    // Biggest and shallowest under the forefoot, dying away aft.
    const s = rng.range(1.1, 3.2) * (0.35 + t * 0.95);
    rock(b, 'sandstone', rx + rng.range(-3, 3), -3.4 + t * 3.6 + rng.range(-0.8, 0.8), rz + rng.range(-3, 3), s, s * 0.7, s * 1.25, rng, 5);
  }
}
