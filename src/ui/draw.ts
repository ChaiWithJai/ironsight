/**
 * The HUD draw list. OWNER: HUD.
 *
 * Everything the HUD puts on screen — rectangles, rounded boxes, circles,
 * diamonds, arcs, hatches, glyphs, the minimap plate — is accumulated into ONE
 * interleaved vertex stream here and issued as ONE draw call by
 * `src/ui/renderer.ts`. `docs/HUD_SPEC.md` §9.7 requires text to be one draw per
 * (atlas, threshold, colour-mode) tuple; putting the threshold and the colour in
 * the vertex stream collapses that to one draw for the entire interface.
 *
 * WHY PREMULTIPLIED ALPHA, AND WHY IT MATTERS HERE
 * ------------------------------------------------
 * §9.6 requires every glow to be drawn additively IMMEDIATELY BEFORE its sharp
 * pass, inside the same z-layer. With separate alpha and additive materials that
 * is two draw calls whose relative order cannot interleave, so a glow would
 * either sit over its own glyph or under an unrelated panel. Premultiplied
 * blending (`src·1 + dst·(1−srcA)`) expresses BOTH: an alpha mark emits
 * `(rgb·a, a)` and an additive glow emits `(rgb·a, 0)`, which reduces to
 * `src + dst`. One material, one draw, and emission order IS z-order — so the
 * §3 layer table is expressed by the order the widgets are called in, with no
 * sort and no depth buffer.
 *
 * COORDINATES. Device pixels, origin top-left, y down. Callers work in `u`
 * (§2.1) and convert through `Layout`; nothing below knows what a `u` is.
 */
import * as THREE from 'three';
import type { Rgb } from './theme';

/** Fragment branch selector. Must match `MODE_*` in `renderer.ts`'s shader. */
export const enum Mode {
  /** Flat fill. `aUv`/`aParam` unused — triangles, fans, strokes, plates. */
  Solid = 0,
  /** SDF glyph. `aUv` = atlas uv; `aParam` = (threshold, softness, 0, 0). */
  Glyph = 1,
  /** Rounded box / circle / ring. `aUv` = local px; `aParam` = (hx, hy, r, stroke). */
  Box = 2,
  /** 45° stripes clipped to a box. `aUv` = local px; `aParam` = (hx, hy, pitch, stripe). */
  Hatch = 3,
  /** Radial falloff. `aUv` = local −1..1; `aParam.x` = exponent. */
  Glow = 4,
  /** Minimap plate. `aUv` = plate uv; colour multiplies. */
  Plate = 5,
}

/** Floats per vertex: pos(3) + uv(2) + colour(4) + param(4) + flags(2). */
const STRIDE = 15;
const INITIAL_VERTS = 24576;

/** A stroked-path point. */
export type Pt = readonly [number, number];

export class HudBatch {
  private data: Float32Array;
  private capacity: number;
  private count = 0;
  /** Bumped whenever the backing array is reallocated, so the GPU side rebuilds. */
  private generation = 0;

  constructor(capacity = INITIAL_VERTS) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
  }

  get vertexCount(): number {
    return this.count;
  }
  get buffer(): Float32Array {
    return this.data;
  }
  get stride(): number {
    return STRIDE;
  }
  get bufferGeneration(): number {
    return this.generation;
  }

  reset(): void {
    this.count = 0;
  }

  private ensure(extra: number): void {
    if (this.count + extra <= this.capacity) return;
    let next = this.capacity;
    while (next < this.count + extra) next *= 2;
    const grown = new Float32Array(next * STRIDE);
    grown.set(this.data.subarray(0, this.count * STRIDE));
    this.data = grown;
    this.capacity = next;
    this.generation++;
  }

  /* ------------------------------------------------------------ primitive -- */

  private vertex(
    x: number,
    y: number,
    u: number,
    v: number,
    c: Rgb,
    a: number,
    p0: number,
    p1: number,
    p2: number,
    p3: number,
    mode: number,
    additive: number,
  ): void {
    const o = this.count * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = 0;
    d[o + 3] = u;
    d[o + 4] = v;
    d[o + 5] = c[0];
    d[o + 6] = c[1];
    d[o + 7] = c[2];
    d[o + 8] = a;
    d[o + 9] = p0;
    d[o + 10] = p1;
    d[o + 11] = p2;
    d[o + 12] = p3;
    d[o + 13] = mode;
    d[o + 14] = additive;
    this.count++;
  }

  /**
   * The one primitive everything else is expressed in. Two triangles over four
   * corners given in TL, TR, BR, BL order, each carrying its own uv.
   */
  private quad(
    px: readonly number[],
    py: readonly number[],
    uu: readonly number[],
    uv: readonly number[],
    c: Rgb,
    a: number,
    p0: number,
    p1: number,
    p2: number,
    p3: number,
    mode: number,
    additive: number,
  ): void {
    if (a <= 0.0005) return;
    this.ensure(6);
    const order = [0, 1, 2, 0, 2, 3];
    for (const i of order) {
      this.vertex(px[i], py[i], uu[i], uv[i], c, a, p0, p1, p2, p3, mode, additive);
    }
  }

  /** Flat-shaded triangle in device pixels. */
  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, col: Rgb, alpha: number, additive = 0): void {
    if (alpha <= 0.0005) return;
    this.ensure(3);
    this.vertex(ax, ay, 0, 0, col, alpha, 0, 0, 0, 0, Mode.Solid, additive);
    this.vertex(bx, by, 0, 0, col, alpha, 0, 0, 0, 0, Mode.Solid, additive);
    this.vertex(cx, cy, 0, 0, col, alpha, 0, 0, 0, 0, Mode.Solid, additive);
  }

  /** Convex polygon as a triangle fan. Winding is irrelevant — no culling. */
  poly(points: readonly Pt[], col: Rgb, alpha: number, additive = 0): void {
    if (points.length < 3 || alpha <= 0.0005) return;
    const a = points[0];
    for (let i = 1; i + 1 < points.length; i++) {
      this.tri(a[0], a[1], points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], col, alpha, additive);
    }
  }

  /** Axis-aligned filled rectangle. Snaps to whole device pixels (§2.5). */
  rect(x: number, y: number, w: number, h: number, col: Rgb, alpha: number, additive = 0): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    if (x1 <= x0 || y1 <= y0) return;
    this.quad([x0, x1, x1, x0], [y0, y0, y1, y1], [0, 0, 0, 0], [0, 0, 0, 0], col, alpha, 0, 0, 0, 0, Mode.Solid, additive);
  }

  /**
   * Rounded box, circle, diamond or ring, analytically antialiased.
   *
   * `stroke` 0 fills; > 0 draws a centred outline of that width. `rotation` in
   * radians rotates the QUAD but not the local field, which is what makes a
   * diamond a rotated rounded square rather than a second shape — §0.1's
   * requirement that ownership survives a colour-blind palette rests on those
   * two being literally the same code path.
   */
  box(
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    radius: number,
    col: Rgb,
    alpha: number,
    opts?: { stroke?: number; rotation?: number; additive?: number },
  ): void {
    const stroke = opts?.stroke ?? 0;
    const rot = opts?.rotation ?? 0;
    const add = opts?.additive ?? 0;
    // Pad the quad past the field so the AA ramp and half the stroke fit inside.
    const pad = 1.5 + stroke * 0.5;
    const ex = halfW + pad;
    const ey = halfH + pad;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const lx = [-ex, ex, ex, -ex];
    const ly = [-ey, -ey, ey, ey];
    const px: number[] = [];
    const py: number[] = [];
    for (let i = 0; i < 4; i++) {
      px.push(cx + lx[i] * cos - ly[i] * sin);
      py.push(cy + lx[i] * sin + ly[i] * cos);
    }
    const r = Math.min(radius, Math.min(halfW, halfH));
    this.quad(px, py, lx, ly, col, alpha, halfW, halfH, r, stroke, Mode.Box, add);
  }

  circle(cx: number, cy: number, radius: number, col: Rgb, alpha: number, stroke = 0, additive = 0): void {
    this.box(cx, cy, radius, radius, radius, col, alpha, { stroke, additive });
  }

  /** 45° cooldown hatch, clipped to the tile (§6.11). */
  hatch(x: number, y: number, w: number, h: number, col: Rgb, alpha: number, pitch: number, stripe: number): void {
    const cx = x + w * 0.5;
    const cy = y + h * 0.5;
    const hx = w * 0.5;
    const hy = h * 0.5;
    this.quad(
      [cx - hx, cx + hx, cx + hx, cx - hx],
      [cy - hy, cy - hy, cy + hy, cy + hy],
      [-hx, hx, hx, -hx],
      [-hy, -hy, hy, hy],
      col,
      alpha,
      hx,
      hy,
      pitch,
      stripe,
      Mode.Hatch,
      0,
    );
  }

  /**
   * Soft additive glow blob. `exponent` shapes the falloff: 2 is the default
   * quadratic that reads as a lens halo, higher values tighten it.
   *
   * This is HUD-local geometry and never touches the scene bloom pass — §2.6.
   */
  glow(cx: number, cy: number, rx: number, ry: number, col: Rgb, alpha: number, exponent = 2): void {
    this.quad(
      [cx - rx, cx + rx, cx + rx, cx - rx],
      [cy - ry, cy - ry, cy + ry, cy + ry],
      [-1, 1, 1, -1],
      [-1, -1, 1, 1],
      col,
      alpha,
      exponent,
      0,
      0,
      0,
      Mode.Glow,
      1,
    );
  }

  /** Textured quad from the baked minimap plate. */
  plate(x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, col: Rgb, alpha: number): void {
    this.quad([x, x + w, x + w, x], [y, y, y + h, y + h], [u0, u1, u1, u0], [v0, v0, v1, v1], col, alpha, 0, 0, 0, 0, Mode.Plate, 0);
  }

  /** One SDF glyph cell. Called only by `text.ts`. */
  glyph(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    col: Rgb,
    alpha: number,
    threshold: number,
    softness: number,
    additive: number,
  ): void {
    this.quad([x0, x1, x1, x0], [y0, y0, y1, y1], [u0, u1, u1, u0], [v1, v1, v0, v0], col, alpha, threshold, softness, 0, 0, Mode.Glyph, additive);
  }

  /* --------------------------------------------------------------- paths -- */

  /**
   * Stroke a polyline with square joins. Used for brackets, compass ticks,
   * class glyphs, the minimap order path and every hand-drawn pictogram — a
   * dedicated stroker is what keeps those from being twelve ad-hoc rect calls
   * that disagree about where a corner goes.
   */
  strokePath(points: readonly Pt[], width: number, col: Rgb, alpha: number, closed = false): void {
    const n = points.length;
    if (n < 2 || alpha <= 0.0005) return;
    const half = width * 0.5;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) continue;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      this.quad(
        [a[0] + nx, b[0] + nx, b[0] - nx, a[0] - nx],
        [a[1] + ny, b[1] + ny, b[1] - ny, a[1] - ny],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        col,
        alpha,
        0,
        0,
        0,
        0,
        Mode.Solid,
        0,
      );
    }
    // Square join patches. Cheaper and visually identical to a mitre at these
    // stroke weights, and it cannot spike on a near-180° turn the way a mitre does.
    if (width > 1.6) {
      const joins = closed ? n : n - 2;
      for (let i = 0; i < joins; i++) {
        const p = points[(i + 1) % n];
        this.rect(p[0] - half, p[1] - half, width, width, col, alpha);
      }
    }
  }

  /**
   * Filled arc band between two radii, optionally tapering to nothing at both
   * ends. The damage-direction fin (§6.20), the minimap view cone (§6.7) and the
   * bleedout dashes (§6.21) are all this one function.
   */
  arc(
    cx: number,
    cy: number,
    innerR: number,
    outerR: number,
    startRad: number,
    endRad: number,
    col: Rgb,
    alpha: number,
    opts?: { taper?: boolean; segments?: number; additive?: number; fadeOuter?: boolean },
  ): void {
    const span = endRad - startRad;
    const segments = opts?.segments ?? Math.max(3, Math.ceil(Math.abs(span) / 0.12));
    const taper = opts?.taper ?? false;
    const add = opts?.additive ?? 0;
    const fadeOuter = opts?.fadeOuter ?? false;
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const a0 = startRad + span * t0;
      const a1 = startRad + span * t1;
      // sin(πt) tapers the band symmetrically to zero thickness at both ends.
      const w0 = taper ? Math.sin(Math.PI * t0) : 1;
      const w1 = taper ? Math.sin(Math.PI * t1) : 1;
      const mid = (innerR + outerR) * 0.5;
      const h = (outerR - innerR) * 0.5;
      const i0 = mid - h * w0;
      const o0 = mid + h * w0;
      const i1 = mid - h * w1;
      const o1 = mid + h * w1;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      if (fadeOuter) {
        // Two triangles with the outer edge at zero alpha: a wedge that fades
        // to nothing at its far edge without needing a gradient texture.
        this.ensure(6);
        this.vertex(cx + c0 * i0, cy + s0 * i0, 0, 0, col, alpha, 0, 0, 0, 0, Mode.Solid, add);
        this.vertex(cx + c1 * i1, cy + s1 * i1, 0, 0, col, alpha, 0, 0, 0, 0, Mode.Solid, add);
        this.vertex(cx + c1 * o1, cy + s1 * o1, 0, 0, col, 0, 0, 0, 0, 0, Mode.Solid, add);
        this.vertex(cx + c0 * i0, cy + s0 * i0, 0, 0, col, alpha, 0, 0, 0, 0, Mode.Solid, add);
        this.vertex(cx + c1 * o1, cy + s1 * o1, 0, 0, col, 0, 0, 0, 0, 0, Mode.Solid, add);
        this.vertex(cx + c0 * o0, cy + s0 * o0, 0, 0, col, 0, 0, 0, 0, 0, Mode.Solid, add);
        continue;
      }
      this.quad(
        [cx + c0 * i0, cx + c1 * i1, cx + c1 * o1, cx + c0 * o0],
        [cy + s0 * i0, cy + s1 * i1, cy + s1 * o1, cy + s0 * o0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        col,
        alpha,
        0,
        0,
        0,
        0,
        Mode.Solid,
        add,
      );
    }
  }

  /** Dashed straight rule with square dashes — the compass rule and map paths. */
  dashedLine(x0: number, y0: number, x1: number, y1: number, width: number, dash: number, gap: number, col: Rgb, alpha: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return;
    const ux = dx / len;
    const uy = dy / len;
    const period = dash + gap;
    for (let s = 0; s < len; s += period) {
      const e = Math.min(len, s + dash);
      this.strokePath(
        [
          [x0 + ux * s, y0 + uy * s],
          [x0 + ux * e, y0 + uy * e],
        ],
        width,
        col,
        alpha,
      );
    }
  }
}

/** Attribute descriptors, shared by the batch and the GPU-side geometry. */
export const ATTRIBUTES: readonly { name: string; size: number; offset: number }[] = [
  { name: 'position', size: 3, offset: 0 },
  { name: 'aUv', size: 2, offset: 3 },
  { name: 'aColor', size: 4, offset: 5 },
  { name: 'aParam', size: 4, offset: 9 },
  { name: 'aFlags', size: 2, offset: 13 },
];

export function buildGeometry(batch: HudBatch): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const interleaved = new THREE.InterleavedBuffer(batch.buffer, batch.stride);
  interleaved.setUsage(THREE.DynamicDrawUsage);
  for (const attr of ATTRIBUTES) {
    geometry.setAttribute(attr.name, new THREE.InterleavedBufferAttribute(interleaved, attr.size, attr.offset, false));
  }
  return geometry;
}
