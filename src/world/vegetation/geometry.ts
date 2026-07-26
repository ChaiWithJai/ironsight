/**
 * A small non-indexed-friendly mesh builder for procedural plant geometry.
 *
 * OWNER: VEG. Deliberately tiny: vegetation is thousands of tapered strips and
 * a few lathes, and every one of them wants to control its own shading normal
 * independently of its face normal.
 *
 * WHY FOLIAGE HERE IS GEOMETRY AND NOT ALPHA CARDS
 * ------------------------------------------------
 * The obvious way to build foliage is an alpha-tested quad with a leaf texture.
 * We do not, for three reasons that all matter on this project:
 *
 *  1. Every texture in this game is procedural and lives in the shared material
 *     arrays; a per-species leaf cut-out is a texture budget line for something
 *     real geometry gives for free at this leaf size.
 *  2. Alpha-tested foliage is the single worst case for TAA and for half-res
 *     GTAO/SSR (ARCHITECTURE §11.9). Solid geometry resolves cleanly.
 *  3. A leaflet is 2 triangles either way. The card wins nothing.
 *
 * The cost is that leaves must be *small enough* that their silhouette is the
 * geometry's silhouette, which is what drives the leaflet counts in `plants.ts`.
 */
import * as THREE from 'three';

export class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];

  /** Push one vertex with an EXPLICIT shading normal. Returns its index. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    const len = Math.hypot(nx, ny, nz) || 1;
    this.nrm.push(nx / len, ny / len, nz / len);
    this.uv.push(u, v);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Append another builder's contents, transformed by `m`. */
  append(other: MeshBuilder, m: THREE.Matrix4): void {
    const base = this.pos.length / 3;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < other.pos.length; i += 3) {
      v.set(other.pos[i], other.pos[i + 1], other.pos[i + 2]).applyMatrix4(m);
      n.set(other.nrm[i], other.nrm[i + 1], other.nrm[i + 2]).applyMatrix3(nm).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(n.x, n.y, n.z);
    }
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + base);
  }

  toGeometry(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.name = name;
    return g;
  }
}

/**
 * A tapered, curved strip — the primitive every blade, leaflet, frond rachis and
 * twig in this lane is made of.
 *
 * `sample(t)` returns the strip's centreline point at t∈[0,1], its half-width,
 * and the direction the strip's WIDTH runs in. The shading normal is supplied
 * separately per sample so a leaflet can be shaded as part of a rounded canopy
 * mass while its geometry stays a flat blade — the single most valuable trick
 * in foliage shading, and the reason a grass field lights as a surface rather
 * than as ten thousand independently-flickering cards.
 */
export interface StripSample {
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  /** Half-width at this station, metres. */
  readonly halfWidth: number;
  /** Unit vector along the strip's width. */
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
  /** Shading normal. Need not be perpendicular to the strip. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

interface Station extends StripSample {
  readonly t: number;
  readonly tip: boolean;
}

/**
 * Emit one sheet of a strip. `sign` selects which face: +1 is the sheet whose
 * geometric winding matches the supplied shading normal, −1 its mirror, offset
 * back along the normal by `half` and wound the other way so it is a genuine
 * back face with a genuinely opposite normal.
 */
function sheet(b: MeshBuilder, stations: readonly Station[], sign: number, half: number): void {
  let prevL = -1;
  let prevR = -1;
  for (const s of stations) {
    const ox = s.nx * sign * half;
    const oy = s.ny * sign * half;
    const oz = s.nz * sign * half;
    const nx = s.nx * sign;
    const ny = s.ny * sign;
    const nz = s.nz * sign;
    if (s.tip) {
      const c = b.vertex(s.px + ox, s.py + oy, s.pz + oz, nx, ny, nz, 0.5, s.t);
      // Winding puts the GEOMETRIC front face on the same side as the supplied
      // shading normal. It matters even on double-sided foliage: three flips the
      // normal by `gl_FrontFacing`, so a reversed winding lights the visible
      // face with the back face's normal and the whole plant renders black.
      if (prevL >= 0) {
        if (sign > 0) b.tri(prevL, c, prevR);
        else b.tri(prevL, prevR, c);
      }
      break;
    }
    const l = b.vertex(
      s.px - s.wx * s.halfWidth + ox, s.py - s.wy * s.halfWidth + oy, s.pz - s.wz * s.halfWidth + oz,
      nx, ny, nz, 0, s.t,
    );
    const r = b.vertex(
      s.px + s.wx * s.halfWidth + ox, s.py + s.wy * s.halfWidth + oy, s.pz + s.wz * s.halfWidth + oz,
      nx, ny, nz, 1, s.t,
    );
    if (prevL >= 0) {
      if (sign > 0) b.quad(prevL, l, r, prevR);
      else b.quad(prevR, r, l, prevL);
    }
    prevL = l;
    prevR = r;
  }
}

/**
 * Emit a strip through `segments + 1` stations. When `pointed`, the last station
 * collapses to a single vertex so the tip is a true point rather than a
 * chopped-off rectangle — foliage silhouettes live and die on their tips.
 *
 * WHY `thickness` EXISTS, AND WHY GRASS IS NOT DRAWN DOUBLE-SIDED
 * --------------------------------------------------------------
 * A zero-thickness strip has to be rendered with `side: DoubleSide`, and three
 * then multiplies the shading normal by `gl_FrontFacing` so that it always
 * points into the CAMERA's hemisphere. On a flat leaf that is the right answer;
 * on a field of ten thousand blades it is catastrophic, because it means every
 * visible grass pixel in the frame has a normal within 90° of the view vector.
 * The instant the camera is not looking down-sun — which is every golden-hour
 * hero framing in this game — N·L goes negative on the ENTIRE field at once, the
 * sun term evaluates to zero everywhere, and the grass shades to flat ambient:
 * the "black slashes" defect.
 *
 * Giving the blade a real (sub-millimetre) thickness fixes it at the source. The
 * strip becomes a closed two-sheet solid, each sheet carries its own true
 * outward normal, the material is drawn `FrontSide`, and nothing flips anything:
 * the sunward half of every tuft lights and the far half falls to sky light,
 * which is the two-lobe read a real meadow has. The cost is 2× triangles on
 * geometry that is 5 triangles a blade.
 *
 * The offset must stay well under a pixel at the distance the geometry is read
 * at, and well over the depth buffer's resolution there, or the two sheets
 * z-fight. 1 mm satisfies both from 1 m to 60 m.
 */
export function stripe(
  b: MeshBuilder,
  segments: number,
  pointed: boolean,
  sample: (t: number, out: Mutable<StripSample>) => void,
  thickness = 0,
): void {
  const s: Mutable<StripSample> = {
    px: 0, py: 0, pz: 0, halfWidth: 0, wx: 1, wy: 0, wz: 0, nx: 0, ny: 1, nz: 0,
  };
  const stations: Station[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    sample(t, s);
    // The sample callback owns one mutable struct, so each station is snapshotted.
    const len = Math.hypot(s.nx, s.ny, s.nz) || 1;
    stations.push({
      px: s.px, py: s.py, pz: s.pz,
      halfWidth: s.halfWidth,
      wx: s.wx, wy: s.wy, wz: s.wz,
      nx: s.nx / len, ny: s.ny / len, nz: s.nz / len,
      t,
      tip: pointed && i === segments,
    });
  }
  const half = thickness * 0.5;
  sheet(b, stations, 1, half);
  if (thickness > 0) sheet(b, stations, -1, half);
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * A tapered tube around a centreline — trunks and thick branches.
 * `radial` sides, `segments` rings. Bark relief comes from a per-ring, per-side
 * radius perturbation supplied by the caller, so a palm gets leaf-base scars and
 * an olive gets longitudinal fluting from the same function.
 */
export function tube(
  b: MeshBuilder,
  radial: number,
  segments: number,
  centre: (t: number, out: THREE.Vector3) => void,
  radius: (t: number, sideAngle: number) => number,
  vScale = 1,
): void {
  const c = new THREE.Vector3();
  const cNext = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const side = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const ring: number[] = [];
  let prev: number[] = [];

  for (let j = 0; j <= segments; j++) {
    const t = j / segments;
    centre(t, c);
    // Finite-difference tangent so a curved trunk's rings stay perpendicular to
    // it — rings built on a fixed axis pinch visibly wherever the trunk leans.
    centre(Math.min(1, t + 1e-3), cNext);
    axis.copy(cNext).sub(c);
    if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
    axis.normalize();
    // Any stable perpendicular basis; the trunk is a solid of revolution so the
    // choice only rotates the UVs.
    side.set(axis.z, 0, -axis.x);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    fwd.crossVectors(axis, side).normalize();

    ring.length = 0;
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const r = radius(t, a);
      const ox = side.x * Math.cos(a) + fwd.x * Math.sin(a);
      const oy = side.y * Math.cos(a) + fwd.y * Math.sin(a);
      const oz = side.z * Math.cos(a) + fwd.z * Math.sin(a);
      ring.push(b.vertex(c.x + ox * r, c.y + oy * r, c.z + oz * r, ox, oy, oz, i / radial, t * vScale));
    }
    if (prev.length > 0) {
      for (let i = 0; i < radial; i++) {
        const n = (i + 1) % radial;
        b.quad(prev[i], prev[n], ring[n], ring[i]);
      }
    }
    prev = ring.slice();
  }
}
