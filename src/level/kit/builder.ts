/**
 * The geometry substrate every piece of HARBOUR REACH is built on.
 *
 * OWNER: LEVEL.
 *
 * Why a hand-rolled builder rather than composing `THREE.BoxGeometry`s: a town
 * is ~1200 discrete pieces and one `Mesh` per piece is 1200 draw calls, which is
 * three times the Ultra ceiling on its own. Everything is appended into ONE
 * vertex stream per material and uploaded as a single `BufferGeometry`, so the
 * whole level is ~15 draws no matter how much detail we add. That is what makes
 * "detail density is final quality" affordable.
 *
 * Two conventions worth knowing before you read a caller:
 *
 *  - `Xform` is a shared transform stack. Emitters read it at push time; there
 *    is exactly one stack per build so a building can be authored in convenient
 *    local coordinates (origin at the base centre, +Z front) and then leaned,
 *    yawed and planted with one matrix.
 *  - UVs are METRES, not 0..1. Every surface in the game is textured by a
 *    tiling material, so a UV that tracks world scale means a 3 m wall and a
 *    30 m warehouse get the same stucco grain. `uvScale` on an emitter is a
 *    multiplier on that, for the rare surface that wants a different density.
 */
import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
/** Orthonormal in-plane texture frame. See `quad`. */
const _tu = new THREE.Vector3();
const _tv = new THREE.Vector3();

/** Shared transform stack. One per build; every `MeshBuilder` reads it. */
export class Xform {
  readonly matrix = new THREE.Matrix4();
  readonly normalMatrix = new THREE.Matrix3();
  private readonly stack: THREE.Matrix4[] = [];

  push(m: THREE.Matrix4): void {
    this.stack.push(this.matrix.clone());
    this.matrix.multiply(m);
    this.normalMatrix.getNormalMatrix(this.matrix);
  }

  /** Push an absolute matrix, discarding the current one. Used at the top of a landmark. */
  pushAbsolute(m: THREE.Matrix4): void {
    this.stack.push(this.matrix.clone());
    this.matrix.copy(m);
    this.normalMatrix.getNormalMatrix(this.matrix);
  }

  pop(): void {
    const m = this.stack.pop();
    if (m) this.matrix.copy(m);
    else this.matrix.identity();
    this.normalMatrix.getNormalMatrix(this.matrix);
  }

  identity(): void {
    this.stack.length = 0;
    this.matrix.identity();
    this.normalMatrix.identity();
  }
}

/**
 * One interleaved-by-attribute vertex stream. Plain JS arrays during the build
 * (append is what they are good at) and typed arrays exactly once, at `finish`.
 */
export class MeshBuilder {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];
  readonly index: number[] = [];

  constructor(private readonly xf: Xform) {}

  /**
   * PER-INSTANCE UV PHASE.
   *
   * The uber material samples its albedo/height/normal set from `uv` (see
   * `render/material/chunks.ts`, `ironUv = vIronUv * ironScale`), and every
   * emitter here starts a fresh box or quad at u = v = 0. Two hundred sandbags
   * therefore all sample the SAME texel neighbourhood and every one of them
   * carries the identical stain in the identical place — which is precisely the
   * "twenty instances of one cuboid" read the round-1 critique named as the most
   * damning region of the ALPHA frame.
   *
   * A caller sets this to a per-instance value before emitting and back to 0
   * after. It costs two adds per vertex and it is the whole fix: the stain, the
   * crack, the streak and the wear all move independently per instance while the
   * material count stays at fifteen.
   */
  private uShift = 0;
  private vShift = 0;

  /** Phase this emitter's UVs. Always pair with `clearUvShift()`. */
  setUvShift(u: number, v: number): void {
    this.uShift = u;
    this.vShift = v;
  }

  clearUvShift(): void {
    this.uShift = 0;
    this.vShift = 0;
  }

  get vertexCount(): number {
    return this.position.length / 3;
  }

  get triangleCount(): number {
    return this.index.length / 3;
  }

  /** Append one vertex through the current transform. Returns its index. */
  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    _a.set(px, py, pz).applyMatrix4(this.xf.matrix);
    _n.set(nx, ny, nz).applyMatrix3(this.xf.normalMatrix).normalize();
    this.position.push(_a.x, _a.y, _a.z);
    this.normal.push(_n.x, _n.y, _n.z);
    this.uv.push(u + this.uShift, v + this.vShift);
    return this.position.length / 3 - 1;
  }

  tri(i0: number, i1: number, i2: number): void {
    this.index.push(i0, i1, i2);
  }

  /**
   * Build the ORTHONORMAL in-plane texture frame for a polygon whose first two
   * edge vectors are already in `_e1` (a→b) and `_e2` (a→d or a→c). Leaves the
   * unit face normal in `_n`, the u axis in `_tu` and the v axis in `_tv`.
   *
   * ROUND 3 — THIS IS THE BUG THAT PUT BLACK SPIKES AROUND EVERY ARCH IN THE
   * LEVEL, AND IT WAS IN THE BUILDER, NOT IN ANY OF THE CALLERS.
   *
   * What this used to do was measure u along a→b and v along a→d and project
   * the remaining corners onto THOSE TWO VECTORS. That is only a texture frame
   * if the two edges are perpendicular. On a rectangle they are, which is why
   * 95 % of the level looked right. On the spandrel cells of an arch head near
   * the springing, the a→b chord is within a few degrees of vertical and a→d is
   * exactly vertical: the two "axes" are nearly PARALLEL, so u and v measure the
   * same direction, the uv triangle collapses to a line, and its screen-space
   * derivatives — which is what the uber material uses to pick a mip and to
   * build its tangent frame — go to infinity. The result is a perturbed normal
   * pointing anywhere at all, and under any sun a good half of those faces land
   * past the terminator and shade black. Twenty-four black slivers fanning out
   * of every arch head, which round 2 measured on `material_chart` as "~8
   * disconnected flat trapezoids forming a serrated sawtooth… hard V-notches…
   * degenerate stretched vertical streak triangles". The geometry was never
   * disconnected and there was never a gap; the texture frame was degenerate.
   *
   * Gram–Schmidt against the face normal fixes it for every shape at once:
   * `u = â`, `v = n̂ × û`, both unit, always perpendicular, both measuring true
   * metres in the plane. On a rectangle it is bit-for-bit what the old code
   * produced, so nothing that was already correct moves.
   */
  private texFrame(): void {
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-18) _n.set(0, 0, 1);
    else _n.normalize();
    if (_e1.lengthSq() > 1e-12) _tu.copy(_e1).normalize();
    else if (_e2.lengthSq() > 1e-12) _tu.copy(_e2).normalize();
    else _tu.set(1, 0, 0);
    _tv.crossVectors(_n, _tu).normalize();
  }

  /**
   * A planar quad, wound a→b→c→d (counter-clockwise seen from the front). The
   * normal is the face normal; UVs run along the a→b and a→d edges in metres, so
   * a rectangle never stretches no matter how it is proportioned.
   *
   * For a RECTANGLE this is identical to `quadOrtho`. For anything skewed it is
   * not — see `quadOrtho`, and prefer it on new geometry.
   */
  quad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    uvScale = 1,
    uOffset = 0,
    vOffset = 0,
  ): void {
    _e1.subVectors(b, a);
    _e2.subVectors(d, a);
    _n.crossVectors(_e1, _e2).normalize();
    const uLen = _e1.length() * uvScale;
    const vLen = _e2.length() * uvScale;
    // The c corner is not necessarily at (uLen, vLen) if the quad is a
    // trapezoid, so project it rather than assuming a parallelogram.
    _c.subVectors(c, a);
    const uc = _e1.lengthSq() > 1e-9 ? (_c.dot(_e1) / _e1.length()) * uvScale : uLen;
    const vc = _e2.lengthSq() > 1e-9 ? (_c.dot(_e2) / _e2.length()) * uvScale : vLen;
    const i0 = this.vertex(a.x, a.y, a.z, _n.x, _n.y, _n.z, uOffset, vOffset);
    const i1 = this.vertex(b.x, b.y, b.z, _n.x, _n.y, _n.z, uOffset + uLen, vOffset);
    const i2 = this.vertex(c.x, c.y, c.z, _n.x, _n.y, _n.z, uOffset + uc, vOffset + vc);
    const i3 = this.vertex(d.x, d.y, d.z, _n.x, _n.y, _n.z, uOffset, vOffset + vLen);
    this.index.push(i0, i1, i2, i0, i2, i3);
  }

  /**
   * Same winding as `quad`, but textured through the ORTHONORMAL in-plane frame
   * rather than through the two edge vectors. Use it for any polygon that is not
   * a rectangle — trapezoids, wedges, slivers — because for those the edge-vector
   * frame is not a frame at all: see `texFrame` for what that does to the arch
   * spandrels. Scoped rather than made the default because `quad` is called
   * roughly forty thousand times across this lane and the two agree only on
   * rectangles; switching every skewed quad in the level at once re-phases their
   * texture and is not a change to make on the last pass of a round.
   */
  quadOrtho(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uvScale = 1): void {
    _e1.subVectors(b, a);
    _e2.subVectors(d, a);
    this.texFrame();
    _c.subVectors(c, a);
    const i0 = this.vertex(a.x, a.y, a.z, _n.x, _n.y, _n.z, 0, 0);
    const i1 = this.vertex(b.x, b.y, b.z, _n.x, _n.y, _n.z, _e1.dot(_tu) * uvScale, _e1.dot(_tv) * uvScale);
    const i2 = this.vertex(c.x, c.y, c.z, _n.x, _n.y, _n.z, _c.dot(_tu) * uvScale, _c.dot(_tv) * uvScale);
    const i3 = this.vertex(d.x, d.y, d.z, _n.x, _n.y, _n.z, _e2.dot(_tu) * uvScale, _e2.dot(_tv) * uvScale);
    this.index.push(i0, i1, i2, i0, i2, i3);
  }

  /** Triangle with a flat normal. */
  triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uvScale = 1): void {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2).normalize();
    const i0 = this.vertex(a.x, a.y, a.z, _n.x, _n.y, _n.z, 0, 0);
    const i1 = this.vertex(b.x, b.y, b.z, _n.x, _n.y, _n.z, _e1.length() * uvScale, 0);
    const i2 = this.vertex(c.x, c.y, c.z, _n.x, _n.y, _n.z, _e1.dot(_e2) / Math.max(_e1.length(), 1e-6) * uvScale, _e2.length() * uvScale);
    this.index.push(i0, i1, i2);
  }

  /** Triangle textured through the orthonormal in-plane frame. See `quadOrtho`. */
  triangleOrtho(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uvScale = 1): void {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    this.texFrame();
    const i0 = this.vertex(a.x, a.y, a.z, _n.x, _n.y, _n.z, 0, 0);
    const i1 = this.vertex(b.x, b.y, b.z, _n.x, _n.y, _n.z, _e1.dot(_tu) * uvScale, _e1.dot(_tv) * uvScale);
    const i2 = this.vertex(c.x, c.y, c.z, _n.x, _n.y, _n.z, _e2.dot(_tu) * uvScale, _e2.dot(_tv) * uvScale);
    this.index.push(i0, i1, i2);
  }

  /**
   * Axis-aligned box in the CURRENT local frame, from `min` to `max`.
   * `faces` is a 6-bit mask (+X −X +Y −Y +Z −Z); omitting a hidden face is the
   * cheapest triangle saving there is and a party wall between two terraced
   * houses is the common case.
   */
  box(min: THREE.Vector3, max: THREE.Vector3, uvScale = 1, faces = 0x3f): void {
    const { x: x0, y: y0, z: z0 } = min;
    const { x: x1, y: y1, z: z1 } = max;
    const p = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => out.set(x, y, z);
    const q = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      dx: number, dy: number, dz: number,
    ): void => {
      const va = p(ax, ay, az, _tmpQ[0]);
      const vb = p(bx, by, bz, _tmpQ[1]);
      const vc = p(cx, cy, cz, _tmpQ[2]);
      const vd = p(dx, dy, dz, _tmpQ[3]);
      this.quad(va, vb, vc, vd, uvScale);
    };
    if (faces & 0x01) q(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +X
    if (faces & 0x02) q(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // -X
    if (faces & 0x04) q(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0); // +Y
    if (faces & 0x08) q(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // -Y
    if (faces & 0x10) q(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +Z
    if (faces & 0x20) q(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // -Z
  }

  /** Convenience: box from a centre and half-extents. */
  boxAt(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, uvScale = 1, faces = 0x3f): void {
    this.box(_boxMin.set(cx - hx, cy - hy, cz - hz), _boxMax.set(cx + hx, cy + hy, cz + hz), uvScale, faces);
  }

  /**
   * A box with every edge chamfered — the single highest-yield shape change in
   * this kit and the reason it exists as a primitive rather than as a detail.
   *
   * `docs/AAA_RUBRIC.md` axis 2: *"no perfectly sharp 90° edges on anything
   * weathered. Real edges catch light as a thin bright line because they are
   * chipped and rounded."* A raw `box` has twelve mathematically perfect arrises
   * and under an 11° sun each one is a hard value step between a lit face and a
   * sky-lit face. A 2–5 cm chamfer inserts a third, intermediate-normal facet
   * along every arris, which reads as a bright rim on the sunward edges and a
   * soft one elsewhere — the thing that separates a stacked-cover wall in a
   * shipped title from a stack of primitives.
   *
   * The shape is the six shrunken faces, twelve edge bevels and eight corner
   * triangles: 44 triangles against the plain box's 12. That is affordable
   * exactly where it matters (cover blocks, sandbags, kerbs, machinery) and
   * nowhere else, which is why the plain `box` stays.
   *
   * `jitter` (0..1) pushes each of the eight corners in by a random fraction of
   * the chamfer, so a run of them is never a run of identical solids.
   */
  chamferBox(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    chamfer: number,
    uvScale = 1,
    rng?: { range(a: number, b: number): number },
    jitter = 0,
  ): void {
    const c = Math.min(chamfer, hx * 0.48, hy * 0.48, hz * 0.48);
    const ax = hx - c;
    const ay = hy - c;
    const az = hz - c;
    // Eight corner "hubs". Each hub owns three vertices, one per face plane.
    const j = (): number => (rng && jitter > 0 ? rng.range(1 - jitter, 1) : 1);
    const jx: number[] = [];
    const jy: number[] = [];
    const jz: number[] = [];
    for (let i = 0; i < 8; i++) {
      jx.push(j());
      jy.push(j());
      jz.push(j());
    }
    const idx = (sx: number, sy: number, sz: number): number =>
      (sx > 0 ? 1 : 0) | (sy > 0 ? 2 : 0) | (sz > 0 ? 4 : 0);
    /** Corner hub position, with the chamfer inset applied on the named axis. */
    const P = (sx: number, sy: number, sz: number, axis: 0 | 1 | 2, out: THREE.Vector3): THREE.Vector3 => {
      const k = idx(sx, sy, sz);
      const px = cx + sx * (axis === 0 ? hx * jx[k] : ax * jx[k]);
      const py = cy + sy * (axis === 1 ? hy * jy[k] : ay * jy[k]);
      const pz = cz + sz * (axis === 2 ? hz * jz[k] : az * jz[k]);
      return out.set(px, py, pz);
    };
    const q4 = (
      a: THREE.Vector3, b: THREE.Vector3, cc: THREE.Vector3, d: THREE.Vector3,
    ): void => this.quad(a, b, cc, d, uvScale);

    // ---- six faces, shrunk by the chamfer ---------------------------------
    q4(P(1, -1, 1, 0, _cb[0]), P(1, -1, -1, 0, _cb[1]), P(1, 1, -1, 0, _cb[2]), P(1, 1, 1, 0, _cb[3]));      // +X
    q4(P(-1, -1, -1, 0, _cb[0]), P(-1, -1, 1, 0, _cb[1]), P(-1, 1, 1, 0, _cb[2]), P(-1, 1, -1, 0, _cb[3]));  // -X
    q4(P(-1, 1, 1, 1, _cb[0]), P(1, 1, 1, 1, _cb[1]), P(1, 1, -1, 1, _cb[2]), P(-1, 1, -1, 1, _cb[3]));      // +Y
    q4(P(-1, -1, -1, 1, _cb[0]), P(1, -1, -1, 1, _cb[1]), P(1, -1, 1, 1, _cb[2]), P(-1, -1, 1, 1, _cb[3]));  // -Y
    q4(P(-1, -1, 1, 2, _cb[0]), P(1, -1, 1, 2, _cb[1]), P(1, 1, 1, 2, _cb[2]), P(-1, 1, 1, 2, _cb[3]));      // +Z
    q4(P(1, -1, -1, 2, _cb[0]), P(-1, -1, -1, 2, _cb[1]), P(-1, 1, -1, 2, _cb[2]), P(1, 1, -1, 2, _cb[3]));  // -Z

    // ---- twelve edge bevels ------------------------------------------------
    // Four edges parallel to X (varying sy, sz), joining the ±Y and ±Z faces.
    for (const sy of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const a = P(-1, sy, sz, 1, _cb[0]);
        const b = P(1, sy, sz, 1, _cb[1]);
        const cc = P(1, sy, sz, 2, _cb[2]);
        const d = P(-1, sy, sz, 2, _cb[3]);
        if (sy * sz > 0) q4(d, cc, b, a);
        else q4(a, b, cc, d);
      }
    }
    // Four edges parallel to Y, joining ±X and ±Z.
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const a = P(sx, -1, sz, 2, _cb[0]);
        const b = P(sx, 1, sz, 2, _cb[1]);
        const cc = P(sx, 1, sz, 0, _cb[2]);
        const d = P(sx, -1, sz, 0, _cb[3]);
        if (sx * sz > 0) q4(d, cc, b, a);
        else q4(a, b, cc, d);
      }
    }
    // Four edges parallel to Z, joining ±X and ±Y.
    for (const sx of [-1, 1] as const) {
      for (const sy of [-1, 1] as const) {
        const a = P(sx, sy, -1, 0, _cb[0]);
        const b = P(sx, sy, 1, 0, _cb[1]);
        const cc = P(sx, sy, 1, 1, _cb[2]);
        const d = P(sx, sy, -1, 1, _cb[3]);
        if (sx * sy > 0) q4(d, cc, b, a);
        else q4(a, b, cc, d);
      }
    }

    // ---- eight corner facets ----------------------------------------------
    for (const sx of [-1, 1] as const) {
      for (const sy of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          const a = P(sx, sy, sz, 0, _cb[0]);
          const b = P(sx, sy, sz, 1, _cb[1]);
          const cc = P(sx, sy, sz, 2, _cb[2]);
          if (sx * sy * sz > 0) this.triangle(a, b, cc, uvScale);
          else this.triangle(cc, b, a, uvScale);
        }
      }
    }
  }

  /**
   * Vertical prism over a closed 2D polygon (XZ plane), from `y0` to `y1`.
   *
   * THE POLYGON MUST BE CLOCKWISE IN (x, z), which is counter-intuitive and
   * worth stating precisely because getting it backwards produces a prism whose
   * every face is inside-out and therefore invisible under back-face culling.
   * Looking DOWN the −Y axis flips handedness, so a loop that is clockwise when
   * you plot (x, z) on paper is the one whose side quads take their outward
   * normal `(−dz, dx)` away from the interior and whose top cap fans to +Y.
   *
   * Caps are triangle-fanned, which is exact for the convex outlines this level
   * uses and acceptably wrong for nothing it uses.
   */
  prism(poly: readonly number[], y0: number, y1: number, uvScale = 1, cap = true, floor = false): void {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = poly[i * 2];
      const az = poly[i * 2 + 1];
      const bx = poly[j * 2];
      const bz = poly[j * 2 + 1];
      this.quad(
        _tmpQ[0].set(ax, y0, az),
        _tmpQ[1].set(bx, y0, bz),
        _tmpQ[2].set(bx, y1, bz),
        _tmpQ[3].set(ax, y1, az),
        uvScale,
      );
    }
    if (cap) {
      const base = this.vertexCount;
      for (let i = 0; i < n; i++) {
        this.vertex(poly[i * 2], y1, poly[i * 2 + 1], 0, 1, 0, poly[i * 2] * uvScale, poly[i * 2 + 1] * uvScale);
      }
      for (let i = 1; i < n - 1; i++) this.tri(base, base + i, base + i + 1);
    }
    if (floor) {
      const base = this.vertexCount;
      for (let i = 0; i < n; i++) {
        this.vertex(poly[i * 2], y0, poly[i * 2 + 1], 0, -1, 0, poly[i * 2] * uvScale, poly[i * 2 + 1] * uvScale);
      }
      for (let i = 1; i < n - 1; i++) this.tri(base, base + i + 1, base + i);
    }
  }

  /**
   * Cylinder about +Y, smooth-shaded around the barrel. `segments` below 8 reads
   * as a prism, which is sometimes what you want (a stone bollard) — pass
   * `flat` for that.
   */
  cylinder(
    cx: number,
    cy: number,
    cz: number,
    radiusBottom: number,
    radiusTop: number,
    height: number,
    segments: number,
    uvScale = 1,
    caps = true,
    flat = false,
  ): void {
    const y0 = cy;
    const y1 = cy + height;
    const slope = (radiusBottom - radiusTop) / Math.max(height, 1e-4);
    if (flat) {
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        this.quad(
          _tmpQ[0].set(cx + Math.cos(a0) * radiusBottom, y0, cz + Math.sin(a0) * radiusBottom),
          _tmpQ[1].set(cx + Math.cos(a1) * radiusBottom, y0, cz + Math.sin(a1) * radiusBottom),
          _tmpQ[2].set(cx + Math.cos(a1) * radiusTop, y1, cz + Math.sin(a1) * radiusTop),
          _tmpQ[3].set(cx + Math.cos(a0) * radiusTop, y1, cz + Math.sin(a0) * radiusTop),
          uvScale,
        );
      }
    } else {
      const base = this.vertexCount;
      const circ = Math.PI * 2 * Math.max(radiusBottom, radiusTop) * uvScale;
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Normal of a truncated cone: radial component 1, axial component = slope.
        const nl = Math.hypot(1, slope);
        const u = (i / segments) * circ;
        this.vertex(cx + ca * radiusBottom, y0, cz + sa * radiusBottom, ca / nl, slope / nl, sa / nl, u, 0);
        this.vertex(cx + ca * radiusTop, y1, cz + sa * radiusTop, ca / nl, slope / nl, sa / nl, u, height * uvScale);
      }
      for (let i = 0; i < segments; i++) {
        const a = base + i * 2;
        // WINDING. Vertices alternate bottom/top, so for segment i:
        //   a = bottom_i, a+1 = top_i, a+2 = bottom_i+1, a+3 = top_i+1
        // With x=cos, z=sin and angle increasing, this order is the one whose
        // face normal agrees with the outward radial vertex normal above. The
        // reverse (a, a+2, a+3 / a, a+3, a+1) winds every triangle INWARD, which
        // leaves the mesh lit correctly — the vertex normals are unaffected — but
        // backface-culled from outside, so the prop is visible only from within.
        // Every silo, tank, drum and chimney in the level rendered inside-out.
        this.index.push(a, a + 3, a + 2, a, a + 1, a + 3);
      }
    }
    if (caps) {
      for (const [y, r, dir] of [
        [y1, radiusTop, 1],
        [y0, radiusBottom, -1],
      ] as const) {
        if (r <= 1e-4) continue;
        const base = this.vertexCount;
        this.vertex(cx, y, cz, 0, dir, 0, 0, 0);
        for (let i = 0; i <= segments; i++) {
          const a = (i / segments) * Math.PI * 2;
          this.vertex(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, 0, dir, 0, Math.cos(a) * r * uvScale, Math.sin(a) * r * uvScale);
        }
        for (let i = 0; i < segments; i++) {
          // Same inversion as the side wall, and for the same reason: a top cap
          // wound centre→i→i+1 has a face normal of −Y. Verified numerically
          // against `dir` for both caps.
          if (dir > 0) this.index.push(base, base + 2 + i, base + 1 + i);
          else this.index.push(base, base + 1 + i, base + 2 + i);
        }
      }
    }
  }

  /**
   * A swept tube along a polyline — drainpipes, conduit, mooring rope, laundry
   * line, crane cable. Parallel-transport framing so a slack catenary does not
   * twist.
   */
  tube(points: readonly THREE.Vector3[], radius: number, sides = 5, uvScale = 1): void {
    if (points.length < 2) return;
    const up = _tubeUp.set(0, 1, 0);
    const tangent = _tubeT;
    const normal = _tubeN;
    const binormal = _tubeB;
    // Seed the frame from the first segment.
    tangent.subVectors(points[1], points[0]).normalize();
    normal.copy(Math.abs(tangent.y) > 0.9 ? _tubeAlt.set(1, 0, 0) : up).cross(tangent).normalize();
    binormal.crossVectors(tangent, normal).normalize();
    const base = this.vertexCount;
    let run = 0;
    for (let i = 0; i < points.length; i++) {
      if (i > 0) {
        const prev = points[i - 1];
        const cur = points[i];
        run += prev.distanceTo(cur);
        if (i < points.length - 1) tangent.subVectors(points[i + 1], prev).normalize();
        else tangent.subVectors(cur, prev).normalize();
        // Re-orthogonalise rather than rebuilding: this is the parallel transport.
        normal.copy(binormal).cross(tangent).normalize();
        binormal.crossVectors(tangent, normal).normalize();
      }
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        _n.set(
          normal.x * ca + binormal.x * sa,
          normal.y * ca + binormal.y * sa,
          normal.z * ca + binormal.z * sa,
        ).normalize();
        this.vertex(
          points[i].x + _n.x * radius,
          points[i].y + _n.y * radius,
          points[i].z + _n.z * radius,
          _n.x, _n.y, _n.z,
          (s / sides) * Math.PI * 2 * radius * uvScale,
          run * uvScale,
        );
      }
    }
    const ring = sides + 1;
    for (let i = 0; i < points.length - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = base + i * ring + s;
        // THIS WINDING IS CORRECT — do not "fix" it to match `cylinder` above.
        // The two loops look identical and are mirror images: `cylinder` walks
        // its ring as (x=cos, z=sin) about +Y, whereas this walks it as
        // `normal*cos + binormal*sin` about the tangent, and those two
        // parameterisations have OPPOSITE handedness. Verified numerically:
        // this order puts every face normal along the outward radial vertex
        // normal, and the cylinder's order does the same only after being
        // reversed. Pattern-matching the two produced an inside-out tube.
        this.index.push(a, a + ring, a + ring + 1, a, a + ring + 1, a + 1);
      }
    }
  }

  /**
   * A slack line between two points (laundry, power, mooring), as a catenary
   * approximated by a parabola — visually identical over these spans and one
   * transcendental cheaper per sample.
   */
  slackLine(from: THREE.Vector3, to: THREE.Vector3, sag: number, radius: number, segments = 7): void {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const p = new THREE.Vector3().lerpVectors(from, to, t);
      p.y -= sag * 4 * t * (1 - t);
      pts.push(p);
    }
    this.tube(pts, radius, 4, 1);
  }

  /**
   * How many index entries have been appended so far.
   *
   * THE HANDLE ON "WHICH TRIANGLES ARE THIS PIECE OF COVER". Everything in the
   * level is appended into one stream per material, which is what makes 1 200
   * pieces cost 17 draws — and it is also why a wall that gets blown up has no
   * mesh of its own to hide. `LevelBuild` brackets an emitter with this counter,
   * so a destructible ends up owning an exact half-open index range and can be
   * lifted out of the stream into a `BatchedMesh` instance that destruction CAN
   * hide. See `LevelBuild.beginPiece`.
   */
  get indexLength(): number {
    return this.index.length;
  }

  /**
   * Triangle indices in the half-open index range `[start, start + count)`.
   *
   * With `inside`, only triangles whose THREE vertices all pass it are kept.
   * That is the filter that makes automatic attribution safe: an emitter's
   * output is bracketed loosely — "everything since the last collider" — and
   * then intersected with the collider's own volume, so nothing outside the
   * solid can ever be hidden by it. The two bags that fell off the top of a
   * sandbag wall and are lying a metre in front of it stay in the merged mesh,
   * which is correct: they are not the wall.
   */
  collectTriangles(
    start: number,
    count: number,
    inside: ((x: number, y: number, z: number) => boolean) | null,
    out: number[],
  ): void {
    if (count <= 0 || start < 0 || start + count > this.index.length) return;
    const first = Math.ceil(start / 3);
    const last = Math.floor((start + count) / 3);
    for (let t = first; t < last; t++) {
      if (inside) {
        let ok = true;
        for (let k = 0; k < 3 && ok; k++) {
          const v = this.index[t * 3 + k];
          ok = inside(this.position[v * 3], this.position[v * 3 + 1], this.position[v * 3 + 2]);
        }
        if (!ok) continue;
      }
      out.push(t);
    }
  }

  /**
   * Copy a set of triangles out as a standalone geometry, re-indexed and welded
   * to only the vertices they use. Positions stay in WORLD space, exactly as
   * they were appended — so the batch instance that carries it needs no
   * transform, and it renders identically under the forward material, the
   * depth-prepass override, the shadow override and the velocity override
   * without any of them having to agree about a batching matrix.
   */
  geometryFromTriangles(triangles: readonly number[]): THREE.BufferGeometry | null {
    if (triangles.length === 0) return null;
    const remap = new Map<number, number>();
    const position: number[] = [];
    const normal: number[] = [];
    const uv: number[] = [];
    const index = new Uint32Array(triangles.length * 3);
    let w = 0;
    for (const t of triangles) {
      for (let k = 0; k < 3; k++) {
        const src = this.index[t * 3 + k];
        let dst = remap.get(src);
        if (dst === undefined) {
          dst = position.length / 3;
          remap.set(src, dst);
          position.push(this.position[src * 3], this.position[src * 3 + 1], this.position[src * 3 + 2]);
          normal.push(this.normal[src * 3], this.normal[src * 3 + 1], this.normal[src * 3 + 2]);
          uv.push(this.uv[src * 2], this.uv[src * 2 + 1]);
        }
        index[w++] = dst;
      }
    }
    if (position.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normal), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /**
   * Build the geometry. Called once at the end of the level build; the JS arrays
   * are dropped afterwards so the ~30 MB of transient number arrays does not sit
   * in the heap for the rest of the session.
   *
   * `omitTriangles` drops the triangles that have been lifted into a
   * `BatchedMesh` — the destructibles. Their VERTICES are left in place:
   * re-packing the stream would cost a full re-index of half a million
   * triangles to save a few thousand unreferenced vertices, and an unreferenced
   * vertex is never fetched.
   */
  finish(omitTriangles?: ReadonlySet<number>): THREE.BufferGeometry | null {
    if (this.index.length === 0) return null;
    let index = this.index;
    if (omitTriangles && omitTriangles.size > 0) {
      const kept: number[] = [];
      const triangles = this.index.length / 3;
      for (let t = 0; t < triangles; t++) {
        if (omitTriangles.has(t)) continue;
        kept.push(this.index[t * 3], this.index[t * 3 + 1], this.index[t * 3 + 2]);
      }
      index = kept;
    }
    if (index.length === 0) {
      this.position.length = 0;
      this.normal.length = 0;
      this.uv.length = 0;
      this.index.length = 0;
      return null;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.normal), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    const idx =
      this.position.length / 3 > 65535
        ? new THREE.BufferAttribute(new Uint32Array(index), 1)
        : new THREE.BufferAttribute(new Uint16Array(index), 1);
    g.setIndex(idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.position.length = 0;
    this.normal.length = 0;
    this.uv.length = 0;
    this.index.length = 0;
    return g;
  }
}

const _tmpQ = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _cb = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _boxMin = new THREE.Vector3();
const _boxMax = new THREE.Vector3();
const _tubeUp = new THREE.Vector3();
const _tubeAlt = new THREE.Vector3();
const _tubeT = new THREE.Vector3();
const _tubeN = new THREE.Vector3();
const _tubeB = new THREE.Vector3();

/** Unused-import guard for the shared scratch vectors above. */
void _b;
