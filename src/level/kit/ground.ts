/**
 * GROUND TRANSITION — the detail the brief singles out by name.
 *
 * OWNER: LEVEL.
 *
 * > "Geometry that meets the ground with a hard seam and no debris, dirt or
 * >  transition" — docs/BRIEF.md, defect list.
 *
 * A wall that intersects a terrain triangle produces a mathematically perfect
 * line. Nothing in the physical world produces that line: forty years of wind
 * piles sand against the windward face, rain washes grit out of the mortar, and
 * every building sheds its own render into a low ridge of rubble at its foot.
 * Reproducing that costs three things, and all three are in here:
 *
 *  1. A continuous SAND FILLET — an irregular wedge hugging the wall, 0.1–0.5 m
 *     high and 0.4–1.6 m out, thicker on the prevailing-wind side. This alone
 *     removes the seam, because there is no longer a wall/ground intersection
 *     visible from any standing eye height.
 *  2. RUBBLE CHUNKS at the foot — spalled render, broken block, roof tile. These
 *     break the fillet's own silhouette so it does not read as a moulding.
 *  3. SCATTER out to ~2.5 m, thinning with distance, so the transition has a
 *     falloff instead of an edge.
 *
 * Everything here is emitted in WORLD space against the analytic macro terrain,
 * NOT in the building's local frame — the drift follows the ground, and a
 * leaning building must not lean its own debris.
 */
import * as THREE from 'three';
import { CollisionGroup, SurfaceId, type Rng } from '@/engine/types';
import type { LevelBuild } from '@/level/build';
import type { MatKey } from '@/level/materials';

export interface Pt2 {
  x: number;
  z: number;
}

/**
 * SEA LEVEL, AND WHY THIS FILE HAS TO KNOW ABOUT IT.
 *
 * WATER's surface is y = 0. Everything in here is emitted against a height
 * FUNCTION, and a height function does not stop at the shore: ask the macro
 * terrain for the ground under a point 40 m out in the harbour and it answers
 * with the seabed, quite happily, several metres down. A sand tongue or a rubble
 * chip placed there is a piece of dressing sitting on the bottom of the sea.
 *
 * That is round 4's `hud_full` severity 8: *"about twelve flat tan planes float
 * unmoored over the water at arbitrary angles with no contact, no shadow and no
 * thickness."* They are not floating and they are not unmoored — they are
 * `spillTongues` fans lying on the seabed, seen THROUGH a refracting water
 * surface, which flattens them, kills their contact shadow and puts them at an
 * apparent depth that has nothing to do with the geometry.
 *
 * So: nothing here is emitted below the waterline unless the caller explicitly
 * passes a Y, which is how the quay's armour stone and the freighter's reef —
 * the two things that ARE meant to be awash — are placed.
 */
const SHORE_Y = 0.35;

const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/**
 * An irregular boulder / rubble chunk.
 *
 * ROUND-3 REWRITE, and the reason is worth stating precisely because the old
 * shape was the single worst object in the whole lane. It was a BIPYRAMID: one
 * jittered equator with a pole above and a pole below, 2n triangles. Seen from
 * more than a couple of metres that silhouette is a diamond, every one of its
 * four visible upper facets is a single flat-shaded plane meeting its
 * neighbours on a hard crease, and — because the shape is fully determined by
 * one ring — every instance of it looks like the same mesh scaled. The round-2
 * critics found it three separate times, in three separate frames:
 *
 *   level_bravo    "a row of ~9 flat-shaded octahedra (diamond bipyramids)…
 *                   the same mesh instanced with no rotation or shape variation"
 *   water_golden   the freighter's reef read as "zero-thickness single-sided
 *                   triangles floating half-submerged at arbitrary angles"
 *   light_cascades "the same triangular wedge prop repeats roughly ten times"
 *
 * All three are the same bug. The replacement is a proper LATHED-AND-NOISED
 * SOLID:
 *
 *  - `rows` horizontal rings between a broad top crown and a buried base,
 *    on a barrel profile (`0.56 + 0.44·sin πu`) rather than a cone, so the
 *    silhouette has SHOULDERS. A boulder's read is its shoulder line; a cone
 *    has none, which is exactly why the old one looked like a tent.
 *  - a per-COLUMN lobe amplitude, coherent up the whole height, so the form has
 *    large lumps rather than uniform fuzz — that is what makes it read as
 *    fractured stone instead of a low-poly sphere;
 *  - one column pulled hard in as a CLEFT, which puts a genuine concavity in
 *    the silhouette. Every reference boulder has one and no convex hull does;
 *  - per-vertex radial, vertical and azimuthal jitter, so no two facets are
 *    coplanar and the flat normals break the light across the whole surface;
 *  - tessellation driven by the chunk's own size, so a 15 cm chip stays at 24
 *    triangles and only the metre-plus boulders that actually sit in the near
 *    field pay for 120.
 *
 * `sides` survives as a caller-supplied FLOOR on the column count, not as the
 * count itself — every existing call site passed 5, which is now far too coarse
 * for anything the camera can get near.
 */
export function rock(
  b: LevelBuild,
  mat: MatKey,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
  rng: Rng,
  sides = 5,
): void {
  const m = b.m(mat);
  // Per-chunk UV phase: every `triangle()` starts its uv at 0, so without this
  // 900 rubble chunks all sample the same texel and the scatter reads as one
  // shape repeated, which is the exact failure the scatter exists to prevent.
  m.setUvShift(rng.range(0, 16), rng.range(0, 16));

  const span = Math.max(rx, rz);
  /**
   * ROUND-2 REBUILD, and it is the third pass on this function because it keeps
   * being the nearest object in a hero frame. The critique on `level_alpha`:
   * "fewer than ~20 visible facets per rock, hard flat-shaded facet normals with
   * no smoothing groups… the texture visibly smears into parallel streaks across
   * the large faces… no micro relief."
   *
   * Three separate defects, three separate fixes, all below:
   *
   *  1. TESSELLATION. A 1.5 m boulder at 2 m from the lens covers a quarter of
   *     the frame height; twelve columns puts a 25 cm chord on its silhouette,
   *     which is a visible corner. The near-field tier now gets 26 columns and
   *     11 rows (~570 triangles), and the small tiers are up proportionally.
   *     The budget is affordable precisely because it is size-gated: the 900
   *     rubble chips in the level are all in the bottom tier at 42 triangles.
   *  2. SMOOTH NORMALS. Emitting through `quad()` gives every face a flat
   *     normal, so the shading has exactly as many values as the mesh has
   *     facets and the rock reads as a cut gem. Vertex normals are now
   *     accumulated over the incident faces and the mesh is emitted through
   *     `vertex()`/`tri()` with them, so the shading is continuous and the
   *     silhouette is the only place the tessellation shows.
   *  3. UVs. `quad()` and `triangle()` both restart their UV at the first
   *     corner, so every facet sampled an unrelated patch of the material and
   *     the discontinuity at each edge is exactly the "parallel streaks" the
   *     critique measured. UVs are now CYLINDRICAL and continuous: u is arc
   *     length around the rock in metres, v is height in metres, with the seam
   *     column duplicated so u never wraps inside a face.
   *
   * On top of those, a two-octave MICRO-RELIEF term (~2 % of radius, at 6× and
   * 13× the lobe frequency) puts real high-frequency deflection in the normals,
   * which is what makes stone read as stone under a raking sun rather than as a
   * smoothed potato.
   */
  const cols = span < 0.25 ? Math.max(7, sides + 2) : span < 0.65 ? 12 : span < 1.4 ? 18 : 26;
  const rows = span < 0.25 ? 3 : span < 0.65 ? 5 : span < 1.4 ? 8 : 11;

  const yaw = rng.range(0, Math.PI * 2);
  // Per-column lobe, coherent over the full height: the large-form variation.
  const lobe: number[] = [];
  for (let c = 0; c < cols; c++) lobe.push(rng.range(0.72, 1.1));
  // The cleft, and its two neighbours pulled part of the way in with it so the
  // notch is a valley rather than a single missing vertex.
  const cleft = rng.int(cols);
  lobe[cleft] *= rng.range(0.44, 0.62);
  lobe[(cleft + 1) % cols] *= rng.range(0.74, 0.9);
  lobe[(cleft + cols - 1) % cols] *= rng.range(0.74, 0.9);
  // With more columns than before, the lobe field has to be SMOOTHED or the
  // large form turns into per-column fuzz — the opposite of what it is for. One
  // pass of a 1-2-1 kernel keeps the cleft and kills the noise.
  if (cols > 10) {
    const sm: number[] = [];
    for (let c = 0; c < cols; c++) {
      sm.push((lobe[(c + cols - 1) % cols] + lobe[c] * 2 + lobe[(c + 1) % cols]) / 4);
    }
    for (let c = 0; c < cols; c++) lobe[c] = sm[c];
  }

  // Micro-relief phases, per rock, so no two carry the same pitting.
  const mp0 = rng.range(0, Math.PI * 2);
  const mp1 = rng.range(0, Math.PI * 2);
  const micro = (a: number, u: number): number =>
    0.021 * Math.sin(a * 6 + mp0 + u * 4.1) + 0.013 * Math.sin(a * 13 - mp1 + u * 9.3);

  // Ring vertices, bottom row first. The last column duplicates the first so
  // the UV seam has somewhere to live; positions are identical, so the seam is
  // invisible in the silhouette and in the shading.
  const nc = cols + 1;
  const ring: THREE.Vector3[][] = [];
  const ang: number[] = [];
  for (let c = 0; c < nc; c++) {
    ang.push(yaw + (((c % cols) + (c === cols ? cols : 0)) / cols) * Math.PI * 2);
  }
  // Per-column angular jitter, shared by the seam pair.
  const jit: number[] = [];
  for (let c = 0; c < cols; c++) jit.push(rng.range(-0.3, 0.3) / cols * Math.PI * 2);
  for (let r = 0; r < rows; r++) {
    const u = r / (rows - 1);
    // Barrel profile. Broad at the crown (0.56 at u=1) so the top caps as a
    // plateau, never as a spike.
    const pr = 0.56 + 0.44 * Math.sin(Math.PI * u);
    const y = cy + (u * 2 - 1) * ry;
    // Per-row radial and vertical wobble, shared by the seam pair.
    const rw: number[] = [];
    const yw: number[] = [];
    for (let c = 0; c < cols; c++) {
      rw.push(rng.range(0.93, 1.06));
      yw.push(rng.range(-0.08, 0.08) * ry);
    }
    const row: THREE.Vector3[] = [];
    for (let c = 0; c < nc; c++) {
      const cc = c % cols;
      const a = ang[c] + jit[cc];
      const k = pr * lobe[cc] * rw[cc] * (1 + micro(a, u));
      row.push(new THREE.Vector3(
        cx + Math.cos(a) * rx * k,
        y + yw[cc],
        cz + Math.sin(a) * rz * k,
      ));
    }
    ring.push(row);
  }

  // Crown: an off-centre apex, so the top is a tilted plateau. Base pole pushed
  // well below the surface — a rock that merely rests on the ground has its own
  // hard seam, which is the bug this file came to fix.
  const top = new THREE.Vector3(
    cx + rng.range(-0.26, 0.26) * rx, cy + ry * rng.range(1.02, 1.2), cz + rng.range(-0.26, 0.26) * rz,
  );
  const bot = new THREE.Vector3(cx, cy - ry * 1.5, cz);

  // ---- vertex normals, accumulated over the incident faces ------------------
  const nrm: THREE.Vector3[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: THREE.Vector3[] = [];
    for (let c = 0; c < nc; c++) row.push(new THREE.Vector3());
    nrm.push(row);
  }
  const nTop = new THREE.Vector3();
  const nBot = new THREE.Vector3();
  const accum = (
    p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3,
    n0: THREE.Vector3, n1: THREE.Vector3, n2: THREE.Vector3,
  ): void => {
    // Un-normalised cross product: its length is twice the triangle area, which
    // is exactly the weight a vertex normal wants.
    _t0.subVectors(p1, p0);
    _t1.subVectors(p2, p0);
    _t2.crossVectors(_t0, _t1);
    n0.add(_t2);
    n1.add(_t2);
    n2.add(_t2);
  };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const d = c + 1;
      accum(ring[r][c], ring[r + 1][c], ring[r + 1][d], nrm[r][c], nrm[r + 1][c], nrm[r + 1][d]);
      accum(ring[r][c], ring[r + 1][d], ring[r][d], nrm[r][c], nrm[r + 1][d], nrm[r][d]);
    }
  }
  for (let c = 0; c < cols; c++) {
    const d = c + 1;
    accum(ring[rows - 1][d], ring[rows - 1][c], top, nrm[rows - 1][d], nrm[rows - 1][c], nTop);
    accum(ring[0][c], ring[0][d], bot, nrm[0][c], nrm[0][d], nBot);
  }
  // The duplicated seam column must carry the SAME normal as column 0 or a
  // shading crease appears where the UV wraps.
  for (let r = 0; r < rows; r++) {
    nrm[r][0].add(nrm[r][cols]);
    nrm[r][cols].copy(nrm[r][0]);
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < nc; c++) nrm[r][c].normalize();
  nTop.normalize();
  nBot.normalize();

  // ---- emit -----------------------------------------------------------------
  // Cylindrical UVs in metres: u around, v up. `MeshBuilder` textures in world
  // units, so this matches the scale every other surface in the level uses.
  const circ = Math.PI * (rx + rz);
  const idx: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < nc; c++) {
      const p = ring[r][c];
      const n = nrm[r][c];
      row.push(m.vertex(p.x, p.y, p.z, n.x, n.y, n.z, (c / cols) * circ, p.y - (cy - ry)));
    }
    idx.push(row);
  }
  const iTop = m.vertex(top.x, top.y, top.z, nTop.x, nTop.y, nTop.z, circ * 0.5, top.y - (cy - ry));
  const iBot = m.vertex(bot.x, bot.y, bot.z, nBot.x, nBot.y, nBot.z, circ * 0.5, bot.y - (cy - ry));
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const d = c + 1;
      m.tri(idx[r][c], idx[r + 1][c], idx[r + 1][d]);
      m.tri(idx[r][c], idx[r + 1][d], idx[r][d]);
    }
  }
  for (let c = 0; c < cols; c++) {
    const d = c + 1;
    m.tri(idx[rows - 1][d], idx[rows - 1][c], iTop);
    m.tri(idx[0][c], idx[0][d], iBot);
  }
  m.clearUvShift();
}

/**
 * THE CONTACT BAND — the dark line in the angle, and the wash up the face.
 *
 * ROUND 5. Rounds 2–4 answered "the wall meets the floor on a hard line" with
 * MORE GEOMETRY: a sand fillet, chips, rubble. Round 4 measured all three still
 * failing on `level_alpha`, `level_bravo` and `light_cascades`, and the reason
 * is that none of them changes the thing the eye actually uses to find a
 * contact, which is VALUE. A sand drift on sandstone paving is a 4 % albedo
 * step; the fillet is real and it is invisible past about eight metres.
 *
 * What a wall foot looks like in every frame of `reference/gameplay/` is a
 * DARK line — the angle sees almost none of the sky hemisphere, water runs off
 * the face and stops there, and nothing has ever swept it. `propFoot` bought
 * that with albedo in round 3 (its `interior` grime collar) and it worked; this
 * is the same trick for a straight run instead of a disc.
 *
 * Two strips, both in `interior` (0.09 linear — see `materials.ts`):
 *
 *  1. FLOOR BAND, 3–11 cm out from the face, 8 mm proud so it never z-fights
 *     with the paving. Its outer edge is lobed on a world-space harmonic, so it
 *     is a wandering dirty line rather than a drawn outline — the SSAO-halo
 *     read the rubric names as its own defect.
 *  2. WALL WASH, 4–22 cm up the face, 1 cm proud of it, with a per-station
 *     irregular top. This is the splash-back stain, and it is what stops the
 *     junction reading as a decal lying on the floor.
 *
 * The drift and the debris are emitted OVER it by the caller, so the dark line
 * shows through where the drift is thin and is buried where it is deep — which
 * is the correlation a painted band can never have.
 *
 * `in` must be a UNIT vector in world XZ pointing away from the vertical face.
 */
export function contactBand(
  b: LevelBuild,
  ax: number, az: number,
  bx: number, bz: number,
  y: number,
  inX: number, inZ: number,
  rng: Rng,
  opts: { reach?: number; rise?: number; mat?: MatKey } = {},
): void {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.3) return;
  const reach = opts.reach ?? 1;
  const rise = opts.rise ?? 1;
  const ex = (bx - ax) / len;
  const ez = (bz - az) / len;
  // Same derived winding test as `seamDebris`: `cross(in, e).y`. It decides the
  // facing of BOTH strips — see the derivation there and in `groundSkirt`.
  const up = inZ * ex - inX * ez > 0;
  const g = b.m(opts.mat ?? 'interior');
  g.setUvShift(rng.range(0, 24), rng.range(0, 24));
  const steps = Math.max(3, Math.round(len / 0.32));
  const pIn = new THREE.Vector3();
  const pOut = new THREE.Vector3();
  const pTop = new THREE.Vector3();
  const qIn = new THREE.Vector3();
  const qOut = new THREE.Vector3();
  const qTop = new THREE.Vector3();
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    // Two incommensurate harmonics at different scales: a slow one that decides
    // which bays are dirty and a fast one that keeps the edge from ever being
    // parallel to the wall for more than half a metre.
    const slow = 0.5 + 0.5 * Math.sin(px * 0.37 + pz * 0.71) * Math.sin(pz * 0.29 - px * 0.53);
    const fast = 0.5 + 0.5 * Math.sin(px * 3.1 - pz * 2.3);
    const d = (0.03 + slow * 0.06 + fast * 0.025) * reach;
    const h = (0.04 + slow * 0.13 + fast * 0.05) * rise;
    qIn.set(px + inX * 0.004, y + 0.008, pz + inZ * 0.004);
    qOut.set(px + inX * d, y + 0.006, pz + inZ * d);
    qTop.set(px + inX * 0.010, y + h, pz + inZ * 0.010);
    if (s > 0) {
      if (up) {
        g.quad(qOut, qIn, pIn, pOut, 1);
        g.quad(pTop, pIn, qIn, qTop, 1);
      } else {
        g.quad(pOut, pIn, qIn, qOut, 1);
        g.quad(qTop, qIn, pIn, pTop, 1);
      }
    }
    pIn.copy(qIn);
    pOut.copy(qOut);
    pTop.copy(qTop);
  }
  g.clearUvShift();
}

/**
 * DEBRIS ALONG A HARD SEAM.
 *
 * `groundSkirt` is for a building meeting TERRAIN: it samples the height field
 * and drapes a sand fillet over it. It is the wrong tool for the other kind of
 * junction, and round 2 found that one too, in `sky_golden`: *"The concrete
 * plinth meets the slab and the slab meets the dirt as dead-clean edges with no
 * debris, gravel, dirt buildup, tide line or vegetation."* A plinth standing on
 * a cast slab has no terrain under it to drape — both sides are man-made and
 * flat, and what actually accumulates in that internal corner is wind-blown
 * grit, spalled concrete and whatever the forklift has broken.
 *
 * So: a low, irregular grit fillet along the seam a → b, on the +in side, plus
 * chips and small rock at a noise-gated density. Everything is under 12 cm and
 * carries no collider or nav data, because a character controller that has to
 * step over set dressing is a bug.
 *
 * `in` must be a UNIT vector pointing away from the vertical face, in world XZ.
 *
 * ROUND 5, THREE CHANGES, all from measurements of the round-4 frames:
 *
 *  - `contactBand` first. Value, not geometry, is what makes a junction read;
 *    see its header.
 *  - THE FILLET WAS FACETED. Stations every 55 cm against a drift whose depth
 *    swings 0 → 52 cm over one wavelength produced isolated triangular RAMPS —
 *    `level_bravo` at (1180-1500, 880-1010) shows two of them with a clean
 *    straight wall/deck line in between. Stations are now every 26 cm, the
 *    depth has a floor so the strip never pinches to nothing, and a second
 *    harmonic breaks the outer edge inside each lobe.
 *  - THE DEBRIS MARCHED. One chunk per 1.1 m at a noise gate still reads as a
 *    procession. Chunks are now drawn in CLUMPS of 1–4 around a gated station,
 *    which is how spall actually lies: piles under the failures, nothing
 *    between them.
 */
export function seamDebris(
  b: LevelBuild,
  ax: number, az: number,
  bx: number, bz: number,
  y: number,
  inX: number, inZ: number,
  rng: Rng,
  opts: { amount?: number; mat?: MatKey; chipMat?: MatKey; noBand?: boolean } = {},
): void {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.4) return;
  const amount = opts.amount ?? 1;
  const mat = opts.mat ?? 'sand';
  const chipMat = opts.chipMat ?? 'rubble';
  const ex = (bx - ax) / len;
  const ez = (bz - az) / len;
  if (!opts.noBand) {
    contactBand(b, ax, az, bx, bz, y, inX, inZ, rng, { reach: amount, rise: amount });
  }
  const g = b.m(mat);
  g.setUvShift(rng.range(0, 24), rng.range(0, 24));

  // The fillet. One strip, with the outer edge dropped 2 cm below the deck so
  // it terminates by intersection rather than on an edge — the same trick
  // `propFoot` uses, and for the same reason.
  const steps = Math.max(3, Math.round(len / 0.26));
  /**
   * WINDING, DERIVED RATHER THAN GUESSED. `quad`'s normal is (b−a)×(d−a); with
   * a = the outer edge of the previous station, that works out to
   * `cross(in, e)`, whose only non-zero component is y = inZ·ex − inX·ez. The
   * caller supplies `in` and the seam direction independently, so that sign can
   * come out either way — and a down-facing strip is back-face culled and
   * invisible. Test it, do not assume it.
   */
  const up = inZ * ex - inX * ez > 0;
  const prevIn = new THREE.Vector3();
  const prevOut = new THREE.Vector3();
  const cur = new THREE.Vector3();
  const curOut = new THREE.Vector3();
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    // Two incommensurate harmonics in world space: the drift is deep in one
    // place and gone in the next, and neighbouring walls agree at their corner
    // because the field is world-space rather than parametric.
    const wave = 0.5 + 0.5 * Math.sin(px * 0.61 + pz * 1.07) * Math.sin(pz * 0.43 - px * 0.83);
    // The fast term rides on the slow one and is scaled by it, so a deep drift
    // has a ragged edge and a shallow one stays shallow instead of spiking.
    const ripple = 0.5 + 0.5 * Math.sin(px * 2.7 + pz * 2.1) * Math.sin(pz * 1.9 - px * 3.3);
    const h = (0.02 + wave * 0.05) * amount;
    const d = (0.16 + wave * 0.34 + wave * ripple * 0.3) * amount;
    cur.set(px + inX * 0.02, y + h, pz + inZ * 0.02);
    curOut.set(px + inX * d, y - 0.02, pz + inZ * d);
    if (s > 0) {
      if (up) g.quad(curOut, cur, prevIn, prevOut, 1);
      else g.quad(prevOut, prevIn, cur, curOut, 1);
    }
    prevIn.copy(cur);
    prevOut.copy(curOut);
  }
  g.clearUvShift();

  const stations = Math.max(2, Math.round(len / 0.8));
  for (let i = 0; i < stations; i++) {
    const t = (i + rng.range(0.1, 0.9)) / stations;
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    const density = 0.5 + 0.5 * Math.sin(px * 0.91 + pz * 0.47) * Math.sin(pz * 1.19 - px * 0.71);
    if (density < 0.32) continue;
    // A clump, not a chunk: 1–4 pieces sharing a centre, sizes falling off from
    // the biggest, which is what a piece of spalled render looks like when it
    // hits a flagstone.
    const n = 1 + rng.int(1 + Math.round(density * 3));
    for (let k = 0; k < n; k++) {
      const off = rng.range(0.02, 0.6) * amount;
      const qx = px + inX * off + ex * rng.range(-0.34, 0.34);
      const qz = pz + inZ * off + ez * rng.range(-0.34, 0.34);
      const s = rng.range(0.07, 0.27) * (0.7 + density * 0.6) / (1 + k * 0.55);
      if (rng.bool(0.55)) blockChip(b, rng.bool(0.6) ? chipMat : mat, qx, y, qz, s, rng);
      else rock(b, rng.bool(0.55) ? chipMat : mat, qx, y + s * 0.28, qz, s, s * 0.5, s * 1.1, rng, 6);
    }
  }
}

/**
 * A spalled slab of render / broken block lying flat on the ground, tipped a few
 * degrees and turned to an arbitrary yaw.
 *
 * The counterpart to `rock()`: `rock` is a lump, this is a PLATE, and a wall foot
 * needs both. Every edge is chamfered so the raking sun puts a bright line along
 * the arris, which is what makes a 20 cm chip legible at 25 m against sand of a
 * similar albedo. The UV phase is randomised per chip, so no two carry the same
 * stain.
 */
export function blockChip(
  b: LevelBuild,
  mat: MatKey,
  x: number, groundY: number, z: number,
  size: number,
  rng: Rng,
): void {
  const thick = size * rng.range(0.16, 0.38);
  const m = new THREE.Matrix4()
    .makeTranslation(x, groundY + thick * 0.55, z)
    .multiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)))
    .multiply(new THREE.Matrix4().makeRotationX(rng.range(-0.22, 0.22)))
    .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.22, 0.22)));
  // RELATIVE push, like `rock()` above: both are called from inside a landmark's
  // own frame as often as from world space, and a chip that ignores the frame it
  // was authored in lands on the far side of the map.
  b.xf.push(m);
  const g = b.m(mat);
  g.setUvShift(rng.range(0, 16), rng.range(0, 16));
  g.chamferBox(0, 0, 0, size * rng.range(0.7, 1.1), thick, size * rng.range(0.55, 1.0), thick * 0.35, 1, rng, 0.25);
  g.clearUvShift();
  /**
   * SPALL ON THE SPALL. Above ~30 cm a chip is a near-field object — the
   * `level_alpha` cluster the round-2 critique called "the lowest-fidelity asset
   * in the frame" is made of these — and a chamfered box has exactly six large
   * faces however big it gets. Two or three smaller cleaved fragments sitting on
   * and against it triple the facet count where it matters, put a real concavity
   * in the silhouette, and cost nothing on the thousand sub-10 cm chips that
   * never reach the threshold.
   */
  if (size > 0.3) {
    const frags = 2 + rng.int(2);
    for (let i = 0; i < frags; i++) {
      const s = size * rng.range(0.22, 0.46);
      const fm = new THREE.Matrix4()
        .makeTranslation(
          size * rng.range(-0.85, 0.85),
          thick * rng.range(0.2, 1.0),
          size * rng.range(-0.7, 0.7),
        )
        .multiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)))
        .multiply(new THREE.Matrix4().makeRotationX(rng.range(-0.55, 0.55)))
        .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.55, 0.55)));
      b.xf.push(fm);
      const fg = b.m(mat);
      fg.setUvShift(rng.range(0, 16), rng.range(0, 16));
      fg.chamferBox(0, 0, 0, s, s * rng.range(0.3, 0.7), s * rng.range(0.6, 1.0), s * 0.22, 1, rng, 0.34);
      fg.clearUvShift();
      b.xf.pop();
    }
  }
  b.xf.pop();
}

/**
 * THE GROUND-CONTACT SKIRT FOR A SINGLE PROP.
 *
 * `groundSkirt` handles buildings — a closed outline with edges to walk. It is
 * the wrong tool for the 400 free-standing objects in this level (drums, crates,
 * bollards, stall legs, barriers, poles), and round 2's `weapon_ads` critique is
 * precisely what happens without one: *"every ground contact in the frame is a
 * hard line with no blend… the four canopy posts intersect the sand as clean
 * straight cuts."* The rubric names that line the single most common amateur
 * tell, so it needs a cheap, universal answer.
 *
 * This is it: a soft-edged disc of ground material laid over the contact, plus a
 * handful of chips and grains around the rim. Three properties make it work
 * where a flat decal quad would not —
 *
 *  - the rim vertices sit BELOW the surrounding ground (−4 cm) and the centre
 *    sits above it, so the disc is a low mound that fades into the terrain by
 *    intersection rather than by an alpha edge that has to be authored;
 *  - the rim radius is per-vertex noisy, so the outline is never a circle;
 *  - the scatter is drawn from the same `rock`/`blockChip` pair as the wall
 *    skirt, so a prop foot and a wall foot are made of the same debris.
 *
 * `radius` is the prop's own footprint radius; the mound runs out to ~1.8× that.
 * No collider and no nav data: it is 4 cm tall, and a character controller that
 * has to step over set dressing is a bug.
 */
export function propFoot(
  b: LevelBuild,
  x: number, groundY: number, z: number,
  radius: number,
  rng: Rng,
  mat: MatKey = 'sand',
  debris = true,
): void {
  const g = b.m(mat);
  g.setUvShift(rng.range(0, 20), rng.range(0, 20));
  /**
   * ROUND-2 REBUILD. The `sky_golden` critique: "the ground decals … are visible
   * as hard-edged translucent POLYGONS — flat lilac-grey quads with straight
   * bevelled boundaries and uniform alpha, no edge fade at all — so they read as
   * floating geometry rather than grime."
   *
   * These are not decals and they have no alpha, but the critic saw the right
   * thing: a 7-gon cone from +7 cm at the hub to −4 cm at the rim intersects a
   * flat slab along a POLYGON with seven straight sides, and seven straight
   * sides is what a hard-edged quad looks like. Three changes remove it:
   *
   *  - the column count is roughly doubled, so the intersection contour is a
   *    fine polyline rather than a heptagon;
   *  - the rim depth is jittered PER VERTEX between −3 and −13 cm, so the
   *    contour where the mound cuts the ground wanders in and out instead of
   *    sitting on one radius;
   *  - a middle ring at 45 % of the reach carries most of the height, which
   *    makes the profile concave. A cone's edge meets the ground at a fixed
   *    angle; a concave drift approaches it asymptotically, and that is what
   *    reads as a fade rather than as an edge.
   */
  const cols = radius < 0.5 ? 12 : radius < 1.2 ? 16 : 22;
  const outer = radius * rng.range(1.5, 2.1);
  const rise = Math.min(0.075, radius * 0.3);
  const phase = rng.range(0, Math.PI * 2);
  /**
   * THE GRIME COLLAR — round 3, `weapon_ads`, severity 8.
   *
   * *"Every object meets the ground on a hard geometric line with no debris
   * skirt… all terminate against unchanged ground albedo on both sides."* The
   * drift below this was already being emitted on all of those objects. The
   * reason the critic could not see it is VALUE, not geometry: the drift is
   * `sand` (0xb6a179) laid on paving of `sandstone` (0xa78c63) or on sand
   * itself, a contrast of a few per cent, and a 6 cm mound of the same colour as
   * the floor is invisible from standing eye height.
   *
   * What a contact actually looks like is the opposite sign: a DARK band right
   * in the angle, because that is where the sky is occluded, where water runs
   * off and stops, and where dirt is never swept out. The rubric asks for
   * exactly this ("a screen-space contact-AO term biased strongly into the
   * bottom ~10 px of every object silhouette") and geometry can pay for it
   * honestly — `interior` is the 9 %-albedo entry, so a tight ring of it at the
   * object's own radius returns roughly a fifth of what the paving returns.
   *
   * It is deliberately TIGHT (1.0–1.45 × the prop radius) and lobed on the same
   * harmonic as the drift, so it reads as grime collected in the angle rather
   * than as a painted halo — the SSAO-halo artefact the rubric separately calls
   * a defect. The drift is emitted over it, so the two overlap and the boundary
   * between them is never a clean circle either.
   */
  {
    const gm = b.m('interior');
    gm.setUvShift(rng.range(0, 20), rng.range(0, 20));
    const inner: THREE.Vector3[] = [];
    const outerRing: THREE.Vector3[] = [];
    for (let i = 0; i < cols; i++) {
      const a = phase + (i / cols) * Math.PI * 2;
      const lobe = 0.62 + 0.38 * Math.sin(a * 2 + phase) * Math.sin(a * 3 - phase * 0.7);
      const r0 = radius * rng.range(0.92, 1.02);
      const r1 = radius * (1.12 + 0.33 * lobe) * rng.range(0.9, 1.1);
      inner.push(new THREE.Vector3(x + Math.cos(a) * r0, groundY + 0.014, z + Math.sin(a) * r0));
      outerRing.push(new THREE.Vector3(x + Math.cos(a) * r1, groundY + 0.004, z + Math.sin(a) * r1));
    }
    // Same j-before-i winding as the drift below, for the same reason.
    for (let i = 0; i < cols; i++) {
      const j = (i + 1) % cols;
      gm.quad(inner[j], outerRing[j], outerRing[i], inner[i], 1);
    }
    gm.clearUvShift();
  }
  const rim: THREE.Vector3[] = [];
  const mid: THREE.Vector3[] = [];
  for (let i = 0; i < cols; i++) {
    const a = phase + (i / cols) * Math.PI * 2;
    // Two incommensurate harmonics plus jitter: a wind-blown drift is lobed, not
    // round, and it is thicker on one side than the other.
    const lobe = 0.62 + 0.38 * Math.sin(a * 2 + phase) * Math.sin(a * 3 - phase * 0.7);
    const rr = outer * (0.55 + 0.65 * lobe) * rng.range(0.85, 1.12);
    rim.push(new THREE.Vector3(x + Math.cos(a) * rr, groundY - rng.range(0.03, 0.13), z + Math.sin(a) * rr));
    const mr = rr * rng.range(0.38, 0.52);
    mid.push(new THREE.Vector3(x + Math.cos(a) * mr, groundY + rise * rng.range(0.5, 0.78), z + Math.sin(a) * mr));
  }
  const hub = _t0.set(x, groundY + rise, z);
  /**
   * WINDING. `quad`/`triangle` take the normal as (b−a)×(d−a), and
   * `MeshBuilder.box`'s +Y face is wound (−x,+z) → (+x,+z) → (+x,−z) → (−x,−z),
   * i.e. by DECREASING atan2(z, x). The ring below runs by increasing angle, so
   * every face has to be emitted j-before-i to face up. The version this
   * replaced did not, so every prop foot in the level was a down-facing fan and
   * was back-face culled out of existence — which is the real reason the round-2
   * critics kept finding hard prop/ground contacts in frames this function was
   * supposed to have already softened.
   */
  for (let i = 0; i < cols; i++) {
    const j = (i + 1) % cols;
    g.quad(mid[j], rim[j], rim[i], mid[i], 1);
    g.triangle(mid[j], mid[i], _t2.copy(hub), 1);
  }
  g.clearUvShift();
  if (!debris) return;
  const n = Math.max(2, Math.round(radius * 5));
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = radius * rng.range(0.85, 2.0);
    const px = x + Math.cos(a) * rr;
    const pz = z + Math.sin(a) * rr;
    const s = radius * rng.range(0.07, 0.2);
    if (rng.bool(0.45)) blockChip(b, rng.bool(0.5) ? 'rubble' : mat, px, groundY, pz, Math.max(0.045, s), rng);
    else rock(b, rng.bool(0.5) ? 'rubble' : mat, px, groundY + s * 0.3, pz, s, s * 0.55, s * 1.15, rng, 5);
  }
}

/**
 * SAND SPILLING ACROSS A MATERIAL BOUNDARY.
 *
 * Where paving meets sand, our two materials meet on a polygon edge, and round
 * 2 called it in two frames: *"a hard polygon seam with no blend, no scattered
 * grains on the tile and no wear decal"*. The correct fix in an engine with a
 * layered material is a height-blended transition; LEVEL cannot add a shader
 * (that is RCORE's directory) so it buys the same read geometrically.
 *
 * `spillTongues` lays irregular flat fans of the sand material ON TOP of the
 * paved side of the boundary, 1.5 cm proud so they never z-fight, with a lobed
 * outline that runs from a wide root on the sand side to a thin finger reaching
 * inward. Their DENSITY is noise-modulated along the edge, so the sand reaches
 * two metres onto the tile in one place and stops at the kerb in the next —
 * which is what a straight edge can never do no matter how much drift is piled
 * against it.
 */
export function spillTongues(
  b: LevelBuild,
  ax: number, az: number, cx: number, cz: number,
  inX: number, inZ: number,
  groundAt: (x: number, z: number) => number,
  rng: Rng,
  reach = 1.8,
  mat: MatKey = 'sand',
): void {
  const len = Math.hypot(cx - ax, cz - az);
  if (len < 0.8) return;
  const g = b.m(mat);
  const count = Math.max(1, Math.round(len / 2.6));
  for (let i = 0; i < count; i++) {
    const t = (i + rng.range(0.05, 0.95)) / count;
    // Noise-driven density: roughly a third of the stations produce nothing, so
    // the tongues clump instead of marching.
    const px = ax + (cx - ax) * t;
    const pz = az + (cz - az) * t;
    if (0.5 + 0.5 * Math.sin(px * 0.7 + pz * 1.3) * Math.sin(pz * 0.41 - px * 0.9) < 0.34) continue;
    // Not below the waterline. See SHORE_Y — this single test is the whole of
    // the `hud_full` "twelve floating tan planes" finding.
    if (groundAt(px, pz) < SHORE_Y) continue;
    const half = rng.range(0.5, 1.5);
    const deep = reach * rng.range(0.35, 1.15);
    const ex = (cx - ax) / len;
    const ez = (cz - az) / len;
    // Local frame: `ex/ez` runs ALONG the boundary, `inX/inZ` runs onto the paved
    // side. The tongue is a half-disc in that frame with a per-vertex ragged rim.
    const at = (along: number, into: number, out: THREE.Vector3): THREE.Vector3 => {
      const wx = px + ex * along + inX * into;
      const wz = pz + ez * along + inZ * into;
      return out.set(wx, groundAt(wx, wz) + 0.015, wz);
    };
    const lobes = 7 + rng.int(4);
    const rim: THREE.Vector3[] = [];
    for (let k = 0; k <= lobes; k++) {
      const th = Math.PI * (k / lobes);
      const j = rng.range(0.62, 1.2);
      rim.push(at(Math.cos(th) * half * j, Math.sin(th) * deep * j, new THREE.Vector3()));
    }
    g.setUvShift(rng.range(0, 20), rng.range(0, 20));
    const hub = at(rng.range(-0.2, 0.2) * half, deep * 0.22, _t0);
    /**
     * WINDING. The fan runs counter-clockwise in the local (along, into) frame,
     * so its normal is along `(ex,0,ez) × (inX,0,inZ)`, whose only non-zero
     * component is `ez·inX − ex·inZ`. Callers hand over whichever outward normal
     * their own loop happened to produce, so the sign is measured rather than
     * assumed — get it wrong and the whole tongue is back-face culled and
     * silently invisible, which is the same class of bug the shoelace test in
     * `groundSkirt` exists to prevent.
     */
    const up = ez * inX - ex * inZ > 0;
    for (let k = 0; k < rim.length - 1; k++) {
      if (up) g.triangle(_t2.copy(hub), rim[k], rim[k + 1], 1);
      else g.triangle(_t2.copy(hub), rim[k + 1], rim[k], 1);
    }
    g.clearUvShift();
  }
}

export interface SkirtOpts {
  /** Direction sand piles from, radians. Drift is thickest on this face. */
  readonly windDir?: number;
  /** Global multiplier on drift height — 0.5 for a swept quay, 1.6 for an alley. */
  readonly amount?: number;
  readonly rubbleMat?: MatKey;
  readonly sandMat?: MatKey;
  /** Skip the outward scatter (interiors, tight alleys). */
  readonly noScatter?: boolean;
  /**
   * Metres to raise the whole transition above `groundAt`.
   *
   * A landmark that stands on a PAVED surface — the market hall on the ALPHA
   * terrace slab, a shed on the quay apron — does not meet the terrain, it meets
   * the paving, and a drift laid on the terrain is a drift buried under 12 cm of
   * flagstone. Round 1's weapon_ads frame shows exactly that: the hall's plinth
   * runs 570 px as a single unbroken strip with the rubble that was supposed to
   * break it sitting invisibly beneath the square.
   */
  readonly lift?: number;
  /** Fraction of the foot chunks emitted as spalled rectangular block. 0..1. */
  readonly blockFraction?: number;
}

/**
 * Lay the drift, rubble and scatter along a closed world-space outline.
 * `groundAt` is the terrain height function — the analytic macro field, so this
 * is correct before TERRAIN's eroded heightfield exists and stays correct after
 * (erosion is contracted not to move the macro silhouette).
 */
export function groundSkirt(
  b: LevelBuild,
  outline: readonly Pt2[],
  groundAtRaw: (x: number, z: number) => number,
  rng: Rng,
  opts: SkirtOpts = {},
): void {
  const wind = opts.windDir ?? -0.6;
  const amount = opts.amount ?? 1;
  const rubbleMat = opts.rubbleMat ?? 'rubble';
  const sandMat = opts.sandMat ?? 'sand';
  const lift = opts.lift ?? 0;
  const blockFraction = opts.blockFraction ?? 0.4;
  const groundAt = lift === 0 ? groundAtRaw : (x: number, z: number): number => groundAtRaw(x, z) + lift;
  const sand = b.m(sandMat);
  const n = outline.length;

  /**
   * WHICH WAY IS OUT.
   *
   * `(ez, −ex)` is the outward normal of edge `(ex, ez)` only for a
   * COUNTER-clockwise outline in XZ; for a clockwise one it points straight into
   * the building. Half this lane's callers build their outlines corner-by-corner
   * in a local frame and hand over a clockwise loop without knowing it, and the
   * failure is completely silent: the drift, the rubble and the scatter are all
   * still emitted, they are just emitted UNDER the plinth where nothing can see
   * them, and the wall meets the ground with exactly the hard seam this whole
   * file exists to remove.
   *
   * So the winding is measured rather than assumed. The shoelace sum is four
   * multiplies per edge, it is exact, and it makes every caller correct by
   * construction instead of by convention.
   */
  let area2 = 0;
  for (let e = 0; e < n; e++) {
    const a = outline[e];
    const c = outline[(e + 1) % n];
    area2 += a.x * c.z - c.x * a.z;
  }
  // Reversing the LOOP rather than negating the normal, because the drift quad
  // is wound from the edge direction as well: flip only the normal and the
  // skirt faces the ground instead of the sky.
  const poly = area2 < 0 ? [...outline].reverse() : outline;

  for (let e = 0; e < n; e++) {
    const a = poly[e];
    const c = poly[(e + 1) % n];
    const ex = c.x - a.x;
    const ez = c.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 0.25) continue;
    // An edge that runs out over the water gets no transition at all: see
    // SHORE_Y. Both ends and the midpoint, because a quay corner can have one
    // end on the apron and the other 20 m out in the basin.
    if (Math.min(
      groundAt(a.x, a.z),
      groundAt(c.x, c.z),
      groundAt((a.x + c.x) / 2, (a.z + c.z) / 2),
    ) < SHORE_Y) continue;
    const nx = ez / len;
    const nz = -ex / len;
    // Windward faces get roughly twice the drift of leeward ones.
    const facing = Math.cos(Math.atan2(nz, nx) - wind);
    const exposure = 0.55 + 0.45 * facing;

    /**
     * THE CONTACT BAND, round 5 — `light_cascades`, severity 7: *"the near wall
     * meets the ground in a hard clean line … no debris skirt, no dirt buildup
     * fillet, no ground decal over an 830 px run."* The drift below WAS being
     * emitted on that wall; it is sand laid on dirt, and at eleven metres the
     * albedo step is smaller than the noise in either material. See
     * `contactBand` for why the answer is value rather than more geometry.
     *
     * It is emitted first and the drift is laid over it, so the dark line is
     * buried where the sand is deep and shows where the sand has blown away.
     */
    contactBand(
      b, a.x, a.z, c.x, c.z, groundAt(a.x, a.z), nx, nz, rng,
      { reach: 0.7 + amount * 0.5, rise: 0.8 + amount * 0.5 },
    );

    const steps = Math.max(3, Math.round(len / 0.4));
    let prevOutX = 0, prevOutZ = 0, prevOutY = 0, prevInY = 0, prevInX = 0, prevInZ = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + ex * t;
      const pz = a.z + ez * t;
      const g = groundAt(px, pz);
      // Two incommensurate sines plus noise from the stream: the drift varies
      // along the wall instead of being a constant-section moulding. A faster
      // third term rides on the slow one so the outer edge is ragged INSIDE
      // each lobe — without it the strip is a smooth swell whose own outline is
      // as regular as the wall's.
      const wave = 0.5 + 0.5 * Math.sin(px * 0.9 + pz * 0.7) * Math.sin(pz * 1.7 - px * 0.4);
      const ripple = 0.5 + 0.5 * Math.sin(px * 2.3 - pz * 3.1) * Math.sin(pz * 2.7 + px * 1.9);
      const h = (0.1 + wave * 0.34) * exposure * amount + rng.range(-0.03, 0.05);
      const d = (0.42 + wave * 0.72 + wave * ripple * 0.55) * exposure * amount;
      const outX = px + nx * d;
      const outZ = pz + nz * d;
      const outY = groundAt(outX, outZ) - 0.06;
      const inX = px - nx * 0.12;
      const inZ = pz - nz * 0.12;
      const inY = g + Math.max(0.05, h);
      if (s > 0) {
        sand.quad(
          _t0.set(prevInX, prevInY, prevInZ),
          _t1.set(inX, inY, inZ),
          _t2.set(outX, outY, outZ),
          _skirtD.set(prevOutX, prevOutY, prevOutZ),
          1,
        );
      }
      prevInX = inX; prevInZ = inZ; prevInY = inY;
      prevOutX = outX; prevOutZ = outZ; prevOutY = outY;
    }

    // Rubble along the foot, and scatter beyond it. Round 1's chunks were all
    // `rock()` — five-sided cones that at 20 m read as a row of small dark
    // pyramids rather than as broken masonry. Half of them are now SPALLED
    // BLOCK: chamfered slabs lying flat with an arbitrary yaw, which is what
    // actually falls off a rendered wall, and which reads correctly at every
    // distance because it has a lit top face and a shadowed end.
    /**
     * FALLEN BLOCK. Round 5, `level_alpha`: *"break the wall base line further
     * with … 2-3 fallen blocks."* Everything else on this seam is under 40 cm,
     * and 40 cm of debris against a 3.5 m wall does not break its base line
     * from standing eye height — it sits below the line rather than across it.
     * One 0.5–0.9 m block every six metres or so does, and in a frame where the
     * whole wall foot is in shadow it is the ONLY thing that does, because a
     * shadowed drift and shadowed paving return the same radiance and only the
     * silhouette survives.
     */
    const blocks = Math.floor(len / 6.5);
    for (let i = 0; i < blocks; i++) {
      const t = (i + rng.range(0.15, 0.85)) / Math.max(1, blocks);
      if (rng.bool(0.35)) continue;
      const px = a.x + ex * t + nx * rng.range(0.25, 1.1);
      const pz = a.z + ez * t + nz * rng.range(0.25, 1.1);
      if (groundAt(px, pz) < SHORE_Y) continue;
      const s = rng.range(0.28, 0.52) * (0.7 + amount * 0.45);
      // Mostly angular BLOCK. A wall sheds cut stone and render, and a lathed
      // lump at this size reads as a sandbag or a sack — which is exactly what
      // the first round-5 capture of `light_cascades` showed.
      if (rng.bool(0.78)) blockChip(b, rubbleMat, px, groundAt(px, pz), pz, s, rng);
      else rock(b, rubbleMat, px, groundAt(px, pz) + s * 0.34, pz, s, s * rng.range(0.5, 0.8), s * rng.range(0.75, 1.2), rng, 7);
      // A block that has fallen has broken: two or three fragments beside it.
      for (let k = 0; k < 2 + rng.int(2); k++) {
        const fs = s * rng.range(0.16, 0.38);
        const fx = px + rng.range(-s * 1.6, s * 1.6);
        const fz = pz + rng.range(-s * 1.6, s * 1.6);
        blockChip(b, rng.bool(0.5) ? rubbleMat : sandMat, fx, groundAt(fx, fz), fz, fs, rng);
      }
    }

    const chunks = Math.max(2, Math.round(len / 0.8));
    for (let i = 0; i < chunks; i++) {
      const t = (i + rng.range(0.1, 0.9)) / chunks;
      const px = a.x + ex * t + nx * rng.range(0.02, 0.62);
      const pz = a.z + ez * t + nz * rng.range(0.02, 0.62);
      /**
       * DENSITY MASK. Stratified sampling puts exactly one chunk in every 0.95 m
       * cell, which from a shallow angle reads as a procession at a fixed pitch —
       * round 2's `light_cascades` note, *"marching from (1500,560) to (1850,760)
       * in a visibly even line"*. Gating on a two-harmonic world-space field
       * removes about a third of them in coherent runs, so the debris clumps
       * where the wall has failed and thins where it has not.
       */
      const density = 0.5 + 0.5 * Math.sin(px * 0.83 + pz * 0.51) * Math.sin(pz * 1.31 - px * 0.62);
      if (density < 0.3) continue;
      // ROUND 5 — CLUMPS, not chunks. One piece per gated cell is still a
      // procession, just a gappy one. Spall lies in heaps under the place the
      // render actually failed, with bare wall between the heaps.
      const clump = 1 + rng.int(1 + Math.round(density * 3));
      for (let k = 0; k < clump; k++) {
        const cxp = px + nx * rng.range(-0.14, 0.34) + (ex / len) * rng.range(-0.32, 0.32);
        const czp = pz + nz * rng.range(-0.14, 0.34) + (ez / len) * rng.range(-0.32, 0.32);
        if (groundAt(cxp, czp) < SHORE_Y) continue;
        /**
         * SIZE. Round 5 first tried 0.16–0.52 here and `light_cascades` came
         * back with a continuous row of half-metre LUMPS along the plinth that
         * read as sacks, not spall: at `amount` 1.45 the top of that range lands
         * at 0.83 m, which is a boulder, and a boulder every 80 cm for eleven
         * metres is a wall of them. The large silhouette break is the fallen
         * BLOCK above, which is deliberately rare; this tier is chips.
         */
        const s = rng.range(0.11, 0.34) * (0.55 + amount * 0.4 + density * 0.5) / (1 + k * 0.5);
        const mat = rng.bool(0.62) ? rubbleMat : sandMat;
        if (rng.bool(blockFraction)) {
          blockChip(b, mat, cxp, groundAt(cxp, czp), czp, s, rng);
        } else {
          rock(b, mat, cxp, groundAt(cxp, czp) + s * 0.32, czp, s, s * rng.range(0.4, 0.75), s * rng.range(0.7, 1.3), rng, 5);
        }
      }
    }
    if (!opts.noScatter) {
      const scatter = Math.max(2, Math.round(len / 1.7));
      for (let i = 0; i < scatter; i++) {
        // Distance falloff: r = 1 - sqrt(u) concentrates chunks near the wall,
        // which is where wash and spall actually accumulate.
        const u = rng.next();
        const dist = 0.6 + (1 - Math.sqrt(u)) * 2.6;
        const t = rng.next();
        const px = a.x + ex * t + nx * dist + rng.range(-0.4, 0.4);
        const pz = a.z + ez * t + nz * dist + rng.range(-0.4, 0.4);
        if (groundAt(px, pz) < SHORE_Y) continue;
        const s = rng.range(0.07, 0.24);
        if (rng.bool(blockFraction * 0.7)) blockChip(b, rng.bool(0.5) ? rubbleMat : sandMat, px, groundAt(px, pz), pz, s, rng);
        else rock(b, rng.bool(0.5) ? rubbleMat : sandMat, px, groundAt(px, pz) + s * 0.25, pz, s, s * 0.5, s * 1.1, rng, 5);
      }
    }
  }
}

const _skirtD = new THREE.Vector3();

/**
 * A free-standing rubble pile — collapsed corner, bomb spoil, a heap of block
 * swept off the street. Emits a collider so it is real cover, and a nav deck so
 * bots will actually climb the shallow ones.
 */
export function rubblePile(
  b: LevelBuild,
  x: number, z: number, groundY: number,
  radius: number, height: number,
  rng: Rng,
  mat: MatKey = 'rubble',
): void {
  const count = Math.max(6, Math.round(radius * radius * 4));
  for (let i = 0; i < count; i++) {
    // Golden-angle disc sampling: even coverage with no ring artefact.
    const a = i * 2.39996323;
    const r = Math.sqrt((i + 0.4) / count) * radius;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const falloff = 1 - (r / radius) * (r / radius);
    const s = rng.range(0.16, 0.44) * (0.5 + falloff);
    rock(b, rng.bool(0.75) ? mat : 'sand', px, groundY + height * falloff * rng.range(0.25, 0.8), pz, s, s * rng.range(0.5, 0.9), s * rng.range(0.8, 1.3), rng, 5);
  }
  // One coarse collider for the whole pile: chasing the silhouette with dozens
  // of little boxes is how you turn a decorative heap into 4% of the physics
  // frame for no gameplay difference.
  b.collider({
    matrix: new THREE.Matrix4().makeTranslation(x, groundY + height * 0.38, z),
    shape: { kind: 'cylinder', halfHeight: height * 0.38, radius: radius * 0.82 },
    surface: SurfaceId.Rubble,
    group: CollisionGroup.Prop,
  });
  b.blocker(x, z, radius * 0.7, radius * 0.7, 0, groundY, groundY + height * 0.7);
  b.coverBoxes.push({
    matrix: new THREE.Matrix4().makeTranslation(x, groundY + height * 0.38, z),
    half: new THREE.Vector3(radius * 0.8, height * 0.38, radius * 0.8),
    groundY,
  });
}
