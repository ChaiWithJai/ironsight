/**
 * Grass, ground thatch and the distance mat. OWNER: VEG.
 *
 * THE THREE LAYERS, AND WHY THERE ARE THREE
 * -----------------------------------------
 * A grass system that is only blade clusters has a visible edge where the
 * clusters stop, and bare terrain between the clusters that never stops looking
 * bare. So the field is built as three layers that hand over to each other:
 *
 *  1. CLUSTERS  — tufts of real blade geometry, 0 → grassRadius. Three LODs.
 *  2. THATCH    — a low splayed mass of short blades that fills BETWEEN the
 *                 tufts, so the ground under the field is never bare terrain.
 *  3. MAT       — flat, irregular, ground-hugging polygons out to well beyond
 *                 the cluster radius, fading IN exactly as the clusters fade
 *                 out. This is the "blended ground texture" the spec asks for,
 *                 owned by us rather than by TERRAIN's splat map, and it is what
 *                 removes the LOD pop line: past the last tuft the field does
 *                 not end, it flattens.
 *
 * A blade is real geometry, not an alpha card — see `geometry.ts` for why.
 *
 * BLADE SHADING NORMALS point OUTWARD from the tuft with a modest upward tilt,
 * NOT up. At an 11° sun a field of up-facing normals receives sin(11°) = 0.19 of
 * the direct beam and goes dead; a field of outward-facing normals lights on its
 * sunward side and falls into shadow on the other, which is what every low-sun
 * meadow in the reference corpus actually does.
 *
 * EVERY BLADE IS A SOLID, NOT A ZERO-THICKNESS CARD. See the long note on
 * `stripe()` in `geometry.ts`: a double-sided card has its normal flipped into
 * the camera's hemisphere by `gl_FrontFacing`, which zeroes the sun term across
 * the whole field on any framing that is not looking straight down-sun. A 1 mm
 * solid blade keeps its true outward normal on both faces, is drawn FrontSide,
 * and gets the sunward/skyward two-lobe read a real meadow has.
 *
 * BLADES STAND UP. Dry Mediterranean grass in August is a stiff straw sheaf that
 * nods at the tip, not a splayed rosette. The `lean` numbers below are
 * deliberately small; the travelling gust in the wind deform supplies the rest
 * of the motion. Large static lean is what turned this field into a carpet of
 * radiating spikes in the first review round.
 */
import * as THREE from 'three';
import type { Rng } from '@/engine/types';
import { MeshBuilder, stripe } from '@/world/vegetation/geometry';

const TAU = Math.PI * 2;

/**
 * Blade thickness, metres. A real grass blade is 0.2–0.5 mm; 1 mm is the
 * smallest offset that stays clear of depth-buffer resolution out at the far end
 * of `grassRadius` (55 m on the High tier) and is still under a tenth of a pixel
 * at 1 m. See the `stripe()` header for why the blade is a solid at all.
 */
const BLADE_THICKNESS = 0.0007;

export interface GrassAssets {
  /** Cluster LOD ladder, coarsest last. */
  readonly cluster: readonly THREE.BufferGeometry[];
  readonly thatch: THREE.BufferGeometry;
  readonly mat: THREE.BufferGeometry;
  /** Nominal cluster height, metres — the wind bend normalises against it. */
  readonly height: number;
}

/**
 * One blade. `lean` is the static wind-shaped bend baked into the mesh; the
 * runtime adds the travelling gust on top in the vertex deform, so the mesh
 * carries the plant's *growth* shape and the shader carries its *motion*.
 */
function blade(
  b: MeshBuilder,
  ox: number,
  oz: number,
  yaw: number,
  length: number,
  width: number,
  lean: number,
  segments: number,
): void {
  const dirX = Math.cos(yaw);
  const dirZ = Math.sin(yaw);
  // Width runs across the blade, horizontal and perpendicular to its azimuth.
  const wx = -dirZ;
  const wz = dirX;
  // Shading normal: outward, tilted up. See the file header.
  const nx = dirX * 0.80;
  const ny = 0.62;
  const nz = dirZ * 0.80;

  stripe(b, segments, true, (t, s) => {
    // Quartic droop in arc length: the blade is stiff over its lower half and
    // nods only near the tip, which is what dry standing grass actually does.
    // A quadratic bends from the root and reads as a rosette of spikes.
    const arc = t * length;
    const nod = lean * arc * arc * arc;
    s.px = ox + dirX * nod;
    // Arc-length preservation: a blade that swings out must lose height. Floored
    // so a heavily-laid-over thatch blade cannot invert through the ground.
    s.py = arc * Math.max(0.20, 1 - lean * lean * arc * arc * 0.45);
    s.pz = oz + dirZ * nod;
    // Blades taper from a shoulder at ~15%, not from the base: the base is the
    // sheath and is nearly parallel-sided.
    const taper = t < 0.15 ? 1 : 1 - Math.pow((t - 0.15) / 0.85, 1.35);
    // Floored at 12 %, not 4 %: a blade is a flat ribbon, and letting the width
    // collapse below its own thickness turns the last centimetre into a square
    // rod with a blunt end, which reads as a stalk rather than a blade.
    s.halfWidth = width * 0.5 * Math.max(0.12, taper);
    s.wx = wx; s.wy = 0; s.wz = wz;
    s.nx = nx; s.ny = ny; s.nz = nz;
  }, BLADE_THICKNESS);
}

/** A nodding seed head — the silhouette element that says "dry grass, late summer". */
function seedStalk(b: MeshBuilder, ox: number, oz: number, yaw: number, height: number, rng: Rng): void {
  const dirX = Math.cos(yaw);
  const dirZ = Math.sin(yaw);
  const lean = 0.26 + 0.2 * rng.next();
  stripe(b, 3, false, (t, s) => {
    const arc = t * height;
    s.px = ox + dirX * lean * arc * arc;
    s.py = arc;
    s.pz = oz + dirZ * lean * arc * arc;
    s.halfWidth = 0.0035 * (1 - t * 0.4);
    s.wx = -dirZ; s.wy = 0; s.wz = dirX;
    s.nx = dirX * 0.7; s.ny = 0.7; s.nz = dirZ * 0.7;
  }, BLADE_THICKNESS);
  // The head: five short awns fanning off the tip.
  const tx = ox + dirX * lean * height * height;
  const ty = height;
  const tz = oz + dirZ * lean * height * height;
  for (let i = 0; i < 3; i++) {
    const a = yaw + (i - 1) * 0.55;
    const len = height * (0.10 + 0.05 * rng.next());
    stripe(b, 1, true, (t, s) => {
      const d = t * len;
      s.px = tx + Math.cos(a) * d * 0.55;
      s.py = ty + d * 0.5 - d * d * 2.2;
      s.pz = tz + Math.sin(a) * d * 0.55;
      s.halfWidth = 0.006 * (1 - t);
      s.wx = -Math.sin(a); s.wy = 0; s.wz = Math.cos(a);
      s.nx = Math.cos(a) * 0.6; s.ny = 0.8; s.nz = Math.sin(a) * 0.6;
    }, BLADE_THICKNESS);
  }
}

function buildCluster(blades: number, segments: number, stalks: number, rng: Rng): MeshBuilder {
  const b = new MeshBuilder();
  for (let i = 0; i < blades; i++) {
    // Golden angle round the tuft, jittered, with the blade root offset from
    // centre — a tuft whose blades all start at one point reads as a shuttlecock.
    const yaw = i * 2.39996 + rng.range(-0.35, 0.35);
    // The roots sit inside a 7 cm disc, not a 12 cm one: a tuft is a sheaf that
    // shares one crown, and spreading the roots turns it into a starfish.
    const r = 0.012 + 0.058 * rng.next();
    // Wide length spread on purpose: a tuft whose blades are all the same length
    // has a machined silhouette, and the eye reads the outline of a grass clump
    // long before it reads any individual blade.
    const length = 0.22 + 0.44 * rng.next();
    blade(
      b,
      Math.cos(yaw) * r,
      Math.sin(yaw) * r,
      // Azimuth jitter, but the blade's own bend direction stays close to its
      // root azimuth so the sheaf opens outward instead of tangling.
      yaw + rng.range(-0.5, 0.5),
      length,
      // 5–9 mm. A real blade of dry coastal grass is 3–6 mm and this is already
      // generous; the previous 11–18 mm rendered ten pixels across at two metres
      // and read as chives.
      0.005 + 0.004 * rng.next(),
      0.40 + 1.05 * rng.next(),
      segments,
    );
  }
  for (let i = 0; i < stalks; i++) {
    const yaw = rng.range(0, TAU);
    seedStalk(b, Math.cos(yaw) * 0.03, Math.sin(yaw) * 0.03, yaw, 0.52 + 0.26 * rng.next(), rng);
  }
  return b;
}

/**
 * Low blades that carpet the gaps between tufts. They lie over further than a
 * standing blade does — that is their job, they are the litter layer — but not
 * flat: a prone blade at an 11° sun presents its edge to the light and reads as
 * a black stroke on bright soil, which is exactly the artefact this pass is
 * removing. 45–60° off vertical keeps them covering ground while still catching
 * the beam.
 */
function buildThatch(rng: Rng): MeshBuilder {
  const b = new MeshBuilder();
  const count = 9;
  for (let i = 0; i < count; i++) {
    const yaw = i * 2.39996 + rng.range(-0.4, 0.4);
    const r = 0.04 + 0.16 * rng.next();
    blade(
      b,
      Math.cos(yaw) * r * 0.4,
      Math.sin(yaw) * r * 0.4,
      yaw,
      0.19 + 0.19 * rng.next(),
      // 9 mm, not 21 mm. The old thatch went out at up to 2.9× instance scale,
      // so a "blade" landed on the ground 5 cm wide and a metre long — a plank,
      // and the single most literal source of the black-slash read.
      0.009,
      1.8 + 1.2 * rng.next(),
      2,
    );
  }
  return b;
}

/**
 * The distance mat: an irregular ground-hugging polygon. Deliberately NOT a
 * quad — a rectangle at 80 m is readable as a rectangle, and a 7-gon with
 * jittered radii is not. Slightly domed so it holds a shading gradient instead
 * of reading as a flat colour chip.
 */
function buildMat(rng: Rng): MeshBuilder {
  const b = new MeshBuilder();
  const sides = 7;
  const centre = b.vertex(0, 0.05, 0, 0, 1, 0, 0.5, 0.5);
  const rim: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * TAU;
    const r = 0.55 + 0.45 * rng.next();
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Rim normals tilt outward so the patch reads as a low mound of vegetation
    // rather than a decal, and so it separates from the terrain under raking sun.
    rim.push(b.vertex(x, 0, z, x * 0.35, 1, z * 0.35, 0.5 + x * 0.5, 0.5 + z * 0.5));
  }
  // Front face up — see the winding note in `stripe`.
  for (let i = 0; i < sides; i++) b.tri(centre, rim[(i + 1) % sides], rim[i]);
  return b;
}

export function buildGrassAssets(rng: Rng): GrassAssets {
  // 15 thin blades at three segments beat 9 fat ones at four for the same
  // triangle count. Coverage AND blade fineness are both what the eye measures
  // in a grass field; blade curvature is not. The reference (bfv_gp_001) shows
  // near-field grass as a CONTINUOUS mat of FINE blades, almost no soil showing.
  // Blade counts are down ~15 % from the pre-solid-blade version because every
  // blade now costs two sheets instead of one; the tuft still reads denser than
  // it did, because the roots are packed into half the radius and the blades no
  // longer splay out of the sheaf.
  const l0 = buildCluster(17, 3, 2, rng.fork('grass.l0'));
  const l1 = buildCluster(8, 3, 1, rng.fork('grass.l1'));
  const l2 = buildCluster(3, 2, 0, rng.fork('grass.l2'));
  return {
    cluster: [l0.toGeometry('grass.l0'), l1.toGeometry('grass.l1'), l2.toGeometry('grass.l2')],
    thatch: buildThatch(rng.fork('grass.thatch')).toGeometry('grass.thatch'),
    mat: buildMat(rng.fork('grass.mat')).toGeometry('grass.mat'),
    height: 0.55,
  };
}
