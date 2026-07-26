/**
 * VORONOI PRE-FRACTURE, AT BAKE TIME. OWNER: PHYS.
 *
 * Runtime fracture is a frame-hitch generator and is banned by the architecture,
 * so every destructible in the map is shattered ONCE during the load bake and the
 * shards are held as finished geometry plus finished convex colliders. Breaking a
 * wall at runtime is then a pool allocation and a body insert, not a geometry
 * job.
 *
 * HOW A CELL IS BUILT, AND WHY NOT BY CLIPPING
 * -------------------------------------------
 * A Voronoi cell is the intersection of half-spaces: the six faces of the source
 * box, plus one bisector plane between this site and each neighbouring site. The
 * textbook construction clips a polyhedron plane by plane, which needs a
 * watertight face/edge structure and degrades badly when three planes nearly
 * meet — exactly what happens with a stratified point set.
 *
 * Instead we take the DUAL route: every candidate vertex of a convex cell is the
 * intersection of three of its planes, and it is a real vertex if and only if it
 * satisfies all the others. Enumerating triples is O(p³) with p ≈ 16 planes, i.e.
 * ~560 tiny 3×3 solves per shard — nothing at bake time — and it cannot produce a
 * non-convex or self-intersecting result no matter how the sites fall. Faces are
 * then recovered by grouping vertices onto their planes and sorting them
 * angularly, which is stable because the vertex set is already exact.
 *
 * Only the twelve nearest neighbours contribute bisectors. A Voronoi cell can
 * only be bounded by nearby sites, and capping the neighbour count is what keeps
 * the triple enumeration at 560 rather than at 4000.
 *
 * WHAT COMES OUT: for each shard, a flat-shaded `BufferGeometry` centred on its
 * own centroid (so the rigid body's origin is its centre of mass), a `convex`
 * `ColliderShape` over the same point set, and its volume — which is what gives a
 * shard its MASS, and is why a keystone falls like a keystone and a corner chip
 * skitters.
 */
import * as THREE from 'three';
import {
  type ColliderShape,
  type MeshAsset,
  type Rng,
  type SurfaceId,
  type Vec3,
} from '@/engine/types';

export interface FractureShard {
  readonly geometry: THREE.BufferGeometry;
  readonly collider: ColliderShape;
  /** Centroid in the source solid's local frame. The body spawns here. */
  readonly centre: Vec3;
  readonly volumeM3: number;
}

/**
 * A `MeshAsset` that also carries its pre-fractured shards.
 *
 * `DestructibleDef.chunks` is typed `AssetKey<MeshAsset>` and `AssetKey<T>` is
 * contravariant in `T`, so a key of a subtype cannot be stored in that field.
 * The bake therefore DECLARES `AssetKey<MeshAsset>` and returns this — every
 * value here is a valid `MeshAsset`, and `shardsOf()` below is the narrowing.
 */
export interface FracturedMesh extends MeshAsset {
  readonly shards: readonly FractureShard[];
}

export function shardsOf(asset: MeshAsset): readonly FractureShard[] {
  const maybe = asset as Partial<FracturedMesh>;
  return maybe.shards ?? [];
}

interface Plane {
  nx: number;
  ny: number;
  nz: number;
  /** Inside the half-space is `n · v <= d`. */
  d: number;
}

/** Vertices closer than this are the same vertex. 0.1 mm. */
const WELD_EPS = 1e-4;
/** Half-space slack when testing a candidate vertex for feasibility. */
const FEASIBLE_EPS = 1e-5;
/** A vertex is ON a plane within this distance. */
const ON_PLANE_EPS = 2e-4;

/**
 * Fracture an axis-aligned box into `siteCount` Voronoi shards.
 *
 * `half` is the box half-extent. `rng` must be a stream nobody else draws from:
 * the shard layout is baked geometry, and it must not move because another lane
 * changed how many random numbers it takes.
 */
export function fractureBox(half: Vec3, siteCount: number, rng: Rng, surface: SurfaceId): FracturedMesh {
  const sites = stratifiedSites(half, siteCount, rng);
  const boxPlanes: Plane[] = [
    { nx: 1, ny: 0, nz: 0, d: half.x },
    { nx: -1, ny: 0, nz: 0, d: half.x },
    { nx: 0, ny: 1, nz: 0, d: half.y },
    { nx: 0, ny: -1, nz: 0, d: half.y },
    { nx: 0, ny: 0, nz: 1, d: half.z },
    { nx: 0, ny: 0, nz: -1, d: half.z },
  ];

  const shards: FractureShard[] = [];
  const planes: Plane[] = [];
  const neighbours: { index: number; d2: number }[] = [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    planes.length = 0;
    for (const p of boxPlanes) planes.push({ nx: p.nx, ny: p.ny, nz: p.nz, d: p.d });

    neighbours.length = 0;
    for (let j = 0; j < sites.length; j++) {
      if (j === i) continue;
      const dx = sites[j].x - site.x;
      const dy = sites[j].y - site.y;
      const dz = sites[j].z - site.z;
      neighbours.push({ index: j, d2: dx * dx + dy * dy + dz * dz });
    }
    neighbours.sort((a, b) => a.d2 - b.d2 || a.index - b.index);
    const used = Math.min(12, neighbours.length);
    for (let k = 0; k < used; k++) {
      const other = sites[neighbours[k].index];
      let nx = other.x - site.x;
      let ny = other.y - site.y;
      let nz = other.z - site.z;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      // Bisector: the plane halfway between the two sites, facing the neighbour.
      const mx = (other.x + site.x) * 0.5;
      const my = (other.y + site.y) * 0.5;
      const mz = (other.z + site.z) * 0.5;
      planes.push({ nx, ny, nz, d: nx * mx + ny * my + nz * mz });
    }

    const shard = buildCell(planes, site);
    if (shard) shards.push(shard);
  }

  const bounds = new THREE.Box3(
    new THREE.Vector3(-half.x, -half.y, -half.z),
    new THREE.Vector3(half.x, half.y, half.z),
  );
  const intact = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
  intact.computeBoundingBox();
  intact.computeBoundingSphere();

  return {
    lods: [intact],
    screenErrors: [0],
    // The collision representation of the intact solid is the box itself. The
    // shard hulls live on `shards` and are inserted only once it breaks.
    collision: [{ kind: 'box', half: new THREE.Vector3(half.x, half.y, half.z) }],
    bounds,
    surface,
    shards,
  };
}

/**
 * Jittered lattice rather than uniform random points. Pure random sites clump,
 * and a clump of sites produces a cluster of slivers next to one enormous shard —
 * which looks like a bug, not like masonry. A jittered lattice gives shards
 * within roughly 3:1 of each other in volume.
 */
function stratifiedSites(half: Vec3, count: number, rng: Rng): THREE.Vector3[] {
  const size = [half.x * 2, half.y * 2, half.z * 2];
  // Split the count between the axes in proportion to extent, so a long thin
  // wall fractures into a row of blocks rather than into a stack of wafers.
  const total = size[0] + size[1] + size[2];
  const nx = Math.max(1, Math.round(Math.cbrt(count) * ((size[0] * 3) / total)));
  const ny = Math.max(1, Math.round(Math.cbrt(count) * ((size[1] * 3) / total)));
  const nz = Math.max(1, Math.round(count / (nx * ny)));

  const out: THREE.Vector3[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const u = (i + 0.5 + rng.range(-0.34, 0.34)) / nx;
        const v = (j + 0.5 + rng.range(-0.34, 0.34)) / ny;
        const w = (k + 0.5 + rng.range(-0.34, 0.34)) / nz;
        out.push(
          new THREE.Vector3(
            (u - 0.5) * size[0],
            (v - 0.5) * size[1],
            (w - 0.5) * size[2],
          ),
        );
      }
    }
  }
  return out;
}

/** Intersect the half-spaces and turn the result into a shard. */
function buildCell(planes: readonly Plane[], site: THREE.Vector3): FractureShard | null {
  const verts: THREE.Vector3[] = [];
  const p = planes.length;
  for (let a = 0; a < p - 2; a++) {
    for (let b = a + 1; b < p - 1; b++) {
      for (let c = b + 1; c < p; c++) {
        const v = intersect3(planes[a], planes[b], planes[c]);
        if (!v) continue;
        let feasible = true;
        for (let q = 0; q < p; q++) {
          const pl = planes[q];
          if (pl.nx * v.x + pl.ny * v.y + pl.nz * v.z > pl.d + FEASIBLE_EPS) {
            feasible = false;
            break;
          }
        }
        if (!feasible) continue;
        let duplicate = false;
        for (const existing of verts) {
          if (
            Math.abs(existing.x - v.x) < WELD_EPS &&
            Math.abs(existing.y - v.y) < WELD_EPS &&
            Math.abs(existing.z - v.z) < WELD_EPS
          ) {
            duplicate = true;
            break;
          }
        }
        if (!duplicate) verts.push(v);
      }
    }
  }
  if (verts.length < 4) return null;

  const centroid = new THREE.Vector3();
  for (const v of verts) centroid.add(v);
  centroid.multiplyScalar(1 / verts.length);

  const positions: number[] = [];
  const normals: number[] = [];
  let volume = 0;
  const face: THREE.Vector3[] = [];

  for (const pl of planes) {
    face.length = 0;
    for (const v of verts) {
      if (Math.abs(pl.nx * v.x + pl.ny * v.y + pl.nz * v.z - pl.d) < ON_PLANE_EPS) face.push(v);
    }
    if (face.length < 3) continue;

    // Order the face's vertices around their own centroid, in the plane's
    // tangent basis. Without this the triangle fan self-intersects and the shard
    // renders as a knot of inverted triangles.
    const fc = new THREE.Vector3();
    for (const v of face) fc.add(v);
    fc.multiplyScalar(1 / face.length);

    const n = new THREE.Vector3(pl.nx, pl.ny, pl.nz);
    const tangent = new THREE.Vector3(0, 0, 0);
    // Any vector not parallel to n. Picking the smallest component keeps the
    // cross product well conditioned.
    if (Math.abs(n.x) <= Math.abs(n.y) && Math.abs(n.x) <= Math.abs(n.z)) tangent.set(1, 0, 0);
    else if (Math.abs(n.y) <= Math.abs(n.z)) tangent.set(0, 1, 0);
    else tangent.set(0, 0, 1);
    const u = new THREE.Vector3().crossVectors(n, tangent).normalize();
    const w = new THREE.Vector3().crossVectors(n, u).normalize();

    const scratch = new THREE.Vector3();
    face.sort((a, b) => {
      const aa = Math.atan2(scratch.copy(a).sub(fc).dot(w), scratch.copy(a).sub(fc).dot(u));
      const bb = Math.atan2(scratch.copy(b).sub(fc).dot(w), scratch.copy(b).sub(fc).dot(u));
      return aa - bb;
    });

    for (let i = 1; i < face.length - 1; i++) {
      const a = face[0];
      const b = face[i];
      const c = face[i + 1];
      // Wind so the triangle normal agrees with the plane's outward normal.
      const e1 = new THREE.Vector3().subVectors(b, a);
      const e2 = new THREE.Vector3().subVectors(c, a);
      const tri = new THREE.Vector3().crossVectors(e1, e2);
      const flip = tri.dot(n) < 0;
      const v0 = a;
      const v1 = flip ? c : b;
      const v2 = flip ? b : c;
      positions.push(
        v0.x - centroid.x, v0.y - centroid.y, v0.z - centroid.z,
        v1.x - centroid.x, v1.y - centroid.y, v1.z - centroid.z,
        v2.x - centroid.x, v2.y - centroid.y, v2.z - centroid.z,
      );
      for (let k = 0; k < 3; k++) normals.push(pl.nx, pl.ny, pl.nz);
      // Signed tetrahedron volume against the centroid; the sum is exact for a
      // closed convex hull.
      volume += Math.abs(
        new THREE.Vector3().subVectors(v0, centroid).dot(
          new THREE.Vector3()
            .crossVectors(
              new THREE.Vector3().subVectors(v1, centroid),
              new THREE.Vector3().subVectors(v2, centroid),
            ),
        ),
      ) / 6;
    }
  }

  if (positions.length < 9) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  // The uber material samples uv; a triplanar projection would be better still,
  // but a box-ish planar unwrap keeps the shard from sampling one texel.
  const uv = new Float32Array((positions.length / 3) * 2);
  for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
    uv[j] = positions[i] * 0.5 + centroid.x * 0.5;
    uv[j + 1] = positions[i + 1] * 0.5 + centroid.y * 0.5;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const points = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    points[i * 3] = verts[i].x - centroid.x;
    points[i * 3 + 1] = verts[i].y - centroid.y;
    points[i * 3 + 2] = verts[i].z - centroid.z;
  }

  void site;
  return {
    geometry,
    collider: { kind: 'convex', points },
    centre: centroid,
    volumeM3: volume,
  };
}

/**
 * The point where three planes meet, by Cramer's rule. Returns null when they
 * are near-parallel — a determinant this small means the "vertex" is off at
 * infinity and is never part of a bounded cell.
 */
function intersect3(a: Plane, b: Plane, c: Plane): THREE.Vector3 | null {
  const det =
    a.nx * (b.ny * c.nz - b.nz * c.ny) -
    a.ny * (b.nx * c.nz - b.nz * c.nx) +
    a.nz * (b.nx * c.ny - b.ny * c.nx);
  if (Math.abs(det) < 1e-8) return null;
  const inv = 1 / det;
  const x =
    (a.d * (b.ny * c.nz - b.nz * c.ny) -
      a.ny * (b.d * c.nz - b.nz * c.d) +
      a.nz * (b.d * c.ny - b.ny * c.d)) * inv;
  const y =
    (a.nx * (b.d * c.nz - b.nz * c.d) -
      a.d * (b.nx * c.nz - b.nz * c.nx) +
      a.nz * (b.nx * c.d - b.d * c.nx)) * inv;
  const z =
    (a.nx * (b.ny * c.d - b.d * c.ny) -
      a.ny * (b.nx * c.d - b.d * c.nx) +
      a.d * (b.nx * c.ny - b.ny * c.nx)) * inv;
  return new THREE.Vector3(x, y, z);
}
