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
 * meadow in the reference corpus actually does. Because the blades are
 * double-sided, the far side of each tuft flips to the anti-sun normal and picks
 * up the sky term instead — the two-lobe read that makes a field look deep.
 */
import * as THREE from 'three';
import type { Rng } from '@/engine/types';
import { MeshBuilder, stripe } from '@/world/vegetation/geometry';

const TAU = Math.PI * 2;

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
    // Quadratic droop in arc length: a cantilever under its own weight, and the
    // reason a blade tips over near the top instead of describing a circle.
    const arc = t * length;
    s.px = ox + dirX * lean * arc * arc;
    s.py = arc * (1 - lean * lean * arc * 0.35);
    s.pz = oz + dirZ * lean * arc * arc;
    // Blades taper from a shoulder at ~15%, not from the base: the base is the
    // sheath and is nearly parallel-sided.
    const taper = t < 0.15 ? 1 : 1 - Math.pow((t - 0.15) / 0.85, 1.35);
    s.halfWidth = width * 0.5 * Math.max(0.04, taper);
    s.wx = wx; s.wy = 0; s.wz = wz;
    s.nx = nx; s.ny = ny; s.nz = nz;
  });
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
  });
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
    });
  }
}

function buildCluster(blades: number, segments: number, stalks: number, rng: Rng): MeshBuilder {
  const b = new MeshBuilder();
  for (let i = 0; i < blades; i++) {
    // Golden angle round the tuft, jittered, with the blade root offset from
    // centre — a tuft whose blades all start at one point reads as a shuttlecock.
    const yaw = i * 2.39996 + rng.range(-0.35, 0.35);
    const r = 0.02 + 0.105 * rng.next();
    const length = 0.22 + 0.32 * rng.next();
    blade(
      b,
      Math.cos(yaw) * r,
      Math.sin(yaw) * r,
      yaw + rng.range(-0.5, 0.5),
      length,
      0.011 + 0.007 * rng.next(),
      0.55 + 0.75 * rng.next(),
      segments,
    );
  }
  for (let i = 0; i < stalks; i++) {
    const yaw = rng.range(0, TAU);
    seedStalk(b, Math.cos(yaw) * 0.03, Math.sin(yaw) * 0.03, yaw, 0.46 + 0.22 * rng.next(), rng);
  }
  return b;
}

/** Low splayed blades that carpet the gaps between tufts. */
function buildThatch(rng: Rng): MeshBuilder {
  const b = new MeshBuilder();
  const count = 16;
  for (let i = 0; i < count; i++) {
    const yaw = i * 2.39996 + rng.range(-0.4, 0.4);
    const r = 0.05 + 0.30 * rng.next();
    // Long, low and nearly prone: `lean` well above 1 lays the blade over.
    blade(
      b,
      Math.cos(yaw) * r * 0.4,
      Math.sin(yaw) * r * 0.4,
      yaw,
      0.20 + 0.20 * rng.next(),
      0.021,
      2.3 + 1.5 * rng.next(),
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
  const l0 = buildCluster(15, 3, 2, rng.fork('grass.l0'));
  const l1 = buildCluster(7, 3, 1, rng.fork('grass.l1'));
  const l2 = buildCluster(3, 2, 0, rng.fork('grass.l2'));
  return {
    cluster: [l0.toGeometry('grass.l0'), l1.toGeometry('grass.l1'), l2.toGeometry('grass.l2')],
    thatch: buildThatch(rng.fork('grass.thatch')).toGeometry('grass.thatch'),
    mat: buildMat(rng.fork('grass.mat')).toGeometry('grass.mat'),
    height: 0.5,
  };
}
