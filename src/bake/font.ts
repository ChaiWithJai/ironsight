/**
 * The HUD typeface, generated in code. OWNER: BAKE.
 *
 * "Zero binary art assets" includes fonts. There is no `.woff` in this repo and
 * no `document.fonts` call anywhere — a canvas `fillText` bake would depend on
 * whichever system face the capture machine happens to have, which is both a
 * network/licensing hazard and a reproducibility one: the same shot would render
 * different letterforms on two machines and the blind A/B would be comparing
 * fonts instead of rendering.
 *
 * SO THE GLYPHS ARE VECTORS, AUTHORED HERE
 * ----------------------------------------
 * Each glyph is a set of centre-line polylines with a constant stroke weight —
 * a "skeleton + pen" construction rather than filled outlines. That is a
 * deliberate trade: filled outlines would need ~30 hand-placed points per glyph
 * (≈1800 numbers) to say what a stroke says in six, and the resulting face —
 * squared terminals, uniform stem, condensed, no optical contrast — is exactly
 * the industrial grotesque a military HUD wants. `docs/HUD_SPEC.md`'s brief of
 * "condensed, high-legibility, no system-font tells" is a stroke font's natural
 * output, not something we are settling for.
 *
 * WHY THE FIELD IS ANALYTIC AND NOT AN EDT
 * ----------------------------------------
 * `bake.sdf2d` (the 8SSEDT worker job) exists for coverage bitmaps that arrive
 * already rasterised. A stroke skeleton does not: the exact signed distance to a
 * capsule chain is a closed form, so every texel here gets the TRUE distance,
 * not the distance to the nearest rasterised texel centre. At HUD sizes — 12–16
 * px cap height — that sub-texel accuracy is the whole difference between crisp
 * stems and stems that shimmer by a third of a pixel as the camera moves.
 *
 * CASE FOLDING. Lowercase codepoints map to the uppercase glyph cell. Every HUD
 * string in this game is set in caps (it is what the reference frames do), and
 * folding rather than omitting means a lane that writes `"Reloading"` gets
 * `RELOADING` instead of a row of missing-glyph boxes.
 */
import * as THREE from 'three';
import type { BakedFont } from '@/engine/types';

/* ------------------------------------------------------------------ metrics */

/**
 * Design space: y = 0 is the baseline, y = 1 is the cap height, x grows right.
 * Everything else is expressed as a fraction of the cap height so a change to
 * `STROKE` re-weights the whole face without moving a single coordinate.
 */
const T = 0.92; // top of a cap-height stroke's CENTRE line
const B = 0.08; // bottom ditto — the outer edge lands on 0 and 1 after the pen
const M = 0.5; // optical middle; deliberately not (T+B)/2 for E/F/H crossbars
const L = 0.08; // left stem centre
const R = 0.46; // right stem centre
const CX = 0.27; // centre of a round glyph
const RX = 0.19; // round-glyph horizontal radius — condensed, hence < RY
const RY = 0.42;

/** Pen half-width. 0.075 of cap height ⇒ a 0.15 stem: bold, HUD-legible. */
const STROKE = 0.075;
/** Side bearing, each side, in cap-height units. */
const BEARING = 0.055;

const ASCENDER = 1.0;
const DESCENDER = -0.22;
const LINE_HEIGHT = 1.42;

type Pt = readonly [number, number];
type Stroke = readonly Pt[];

/** Sampled elliptical arc. Angles in degrees, CCW, `(cx+rx·cos t, cy+ry·sin t)`. */
function earc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Pt[] {
  // One sample per ~12° keeps the chord sagitta under 0.003 cap heights, which
  // at a 64-texel cell is a tenth of a texel — below the SDF's own quantisation.
  const steps = Math.max(3, Math.ceil(Math.abs(a1 - a0) / 12));
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

const ellipse = (cx: number, cy: number, rx: number, ry: number): Pt[] => earc(cx, cy, rx, ry, 0, 360);
/** A pen dot: a degenerate stroke, so it inherits the pen's radius exactly. */
const dot = (x: number, y: number): Pt[] => [
  [x, y],
  [x, y],
];

/* ------------------------------------------------------------------ glyphs */

/**
 * The face. Keys are the canonical (uppercase) codepoints; `GLYPHS` is walked in
 * insertion order, which fixes the atlas layout and therefore the UVs — a font
 * whose cells move between runs would break every cached HUD quad.
 */
const GLYPHS: ReadonlyMap<string, readonly Stroke[]> = new Map<string, readonly Stroke[]>([
  [' ', []],
  ['A', [[[L, B], [CX, T], [R, B]], [[0.155, 0.33], [0.385, 0.33]]]],
  [
    'B',
    [
      [[L, B], [L, T]],
      [[L, T], [0.26, T], ...earc(0.26, 0.71, 0.21, 0.21, 90, -90), [L, M]],
      [[L, M], [0.27, M], ...earc(0.27, 0.29, 0.21, 0.21, 90, -90), [L, B]],
    ],
  ],
  ['C', [earc(CX, M, RX, RY, 52, 308)]],
  ['D', [[[L, B], [L, T]], [[L, T], [0.22, T], ...earc(0.22, M, 0.24, RY, 90, -90), [L, B]]]],
  ['E', [[[R, T], [L, T], [L, B], [R, B]], [[L, M], [0.40, M]]]],
  ['F', [[[R, T], [L, T], [L, B]], [[L, M], [0.38, M]]]],
  ['G', [[...earc(CX, M, RX, RY, 52, 340), [0.448, 0.46], [0.29, 0.46]]]],
  ['H', [[[L, T], [L, B]], [[R, T], [R, B]], [[L, M], [R, M]]]],
  ['I', [[[CX, T], [CX, B]]]],
  ['J', [[[0.42, T], [0.42, 0.24], ...earc(0.25, 0.24, 0.17, 0.16, 0, -180)]]],
  ['K', [[[L, T], [L, B]], [[R, T], [L, 0.42]], [[0.20, 0.55], [R, B]]]],
  ['L', [[[L, T], [L, B], [0.44, B]]]],
  ['M', [[[L, B], [L, T], [CX, 0.42], [R, T], [R, B]]]],
  ['N', [[[L, B], [L, T], [R, B], [R, T]]]],
  ['O', [ellipse(CX, M, RX, RY)]],
  ['P', [[[L, B], [L, T]], [[L, T], [0.25, T], ...earc(0.25, 0.715, 0.21, 0.205, 90, -90), [L, 0.51]]]],
  ['Q', [ellipse(CX, M, RX, RY), [[0.30, 0.24], [0.47, 0.02]]]],
  [
    'R',
    [
      [[L, B], [L, T]],
      [[L, T], [0.25, T], ...earc(0.25, 0.715, 0.21, 0.205, 90, -90), [L, 0.51]],
      [[0.24, 0.51], [R, B]],
    ],
  ],
  ['S', [[...earc(CX, 0.715, RX, 0.205, -20, 250), ...earc(CX, 0.285, RX, 0.205, 110, -160)]]],
  ['T', [[[L, T], [R, T]], [[CX, T], [CX, B]]]],
  ['U', [[[L, T], [L, 0.26], ...earc(CX, 0.26, RX, 0.18, 180, 360), [R, T]]]],
  ['V', [[[L, T], [CX, B], [R, T]]]],
  ['W', [[[0.05, T], [0.16, B], [CX, 0.56], [0.38, B], [0.49, T]]]],
  ['X', [[[L, T], [R, B]], [[R, T], [L, B]]]],
  ['Y', [[[L, T], [CX, M], [R, T]], [[CX, M], [CX, B]]]],
  ['Z', [[[L, T], [R, T], [L, B], [R, B]]]],

  // Slashed zero, distinguishable from O at a glance — the convention every
  // military and aviation display uses, and the reason 0/O is never ambiguous
  // on a ticket counter.
  ['0', [ellipse(CX, M, RX, RY), [[0.17, 0.30], [0.37, 0.70]]]],
  ['1', [[[0.13, 0.75], [CX, T], [CX, B]]]],
  ['2', [[...earc(CX, 0.70, RX, 0.21, 170, -30), [L, B], [R, B]]]],
  ['3', [[...earc(CX, 0.715, RX, 0.205, 170, -70), ...earc(CX, 0.285, RX, 0.205, 70, -175)]]],
  ['4', [[[0.36, B], [0.36, T]], [[0.36, T], [0.06, 0.30], [0.47, 0.30]]]],
  ['5', [[[0.45, T], [0.11, T], [0.09, 0.56], [0.28, 0.56], ...earc(0.28, 0.32, 0.19, 0.24, 90, -160)]]],
  ['6', [[...earc(CX, 0.62, RX, 0.30, 60, 180), [L, 0.29]], ellipse(CX, 0.29, RX, 0.21)]],
  ['7', [[[L, T], [R, T], [0.19, B]]]],
  ['8', [ellipse(CX, 0.715, 0.175, 0.20), ellipse(CX, 0.285, RX, 0.205)]],
  ['9', [[...earc(CX, 0.38, RX, 0.30, 240, 360), [R, 0.71]], ellipse(CX, 0.71, RX, 0.21)]],

  ['.', [dot(0.10, B)]],
  [',', [[[0.13, 0.10], [0.06, -0.11]]]],
  [':', [dot(0.10, B), dot(0.10, 0.50)]],
  [';', [dot(0.10, 0.50), [[0.13, 0.10], [0.06, -0.11]]]],
  ['-', [[[0.05, 0.46], [0.31, 0.46]]]],
  ['+', [[[0.05, 0.46], [0.33, 0.46]], [[0.19, 0.32], [0.19, 0.60]]]],
  ['=', [[[0.05, 0.36], [0.33, 0.36]], [[0.05, 0.58], [0.33, 0.58]]]],
  ['_', [[[0.03, -0.12], [0.41, -0.12]]]],
  ['/', [[[0.04, -0.04], [0.34, 0.96]]]],
  ['\\', [[[0.04, 0.96], [0.34, -0.04]]]],
  ['|', [[[0.08, -0.06], [0.08, 0.96]]]],
  ['(', [earc(0.30, 0.46, 0.24, 0.62, 132, 228)]],
  [')', [earc(0.02, 0.46, 0.24, 0.62, -48, 48)]],
  ['[', [[[0.24, -0.04], [0.07, -0.04], [0.07, 0.96], [0.24, 0.96]]]],
  [']', [[[0.05, -0.04], [0.22, -0.04], [0.22, 0.96], [0.05, 0.96]]]],
  ['<', [[[0.30, 0.72], [0.06, 0.42], [0.30, 0.12]]]],
  ['>', [[[0.06, 0.72], [0.30, 0.42], [0.06, 0.12]]]],
  ['!', [[[0.10, 0.30], [0.10, T]], dot(0.10, B)]],
  ['?', [[...earc(0.22, 0.71, 0.16, 0.20, 190, -20), [0.22, 0.32]], dot(0.22, B)]],
  ["'", [[[0.08, 0.68], [0.08, T]]]],
  ['"', [[[0.07, 0.68], [0.07, T]], [[0.23, 0.68], [0.23, T]]]],
  ['*', [[[0.20, 0.60], [0.20, 0.92]], [[0.06, 0.68], [0.34, 0.84]], [[0.06, 0.84], [0.34, 0.68]]]],
  ['#', [[[0.13, B], [0.19, T]], [[0.30, B], [0.36, T]], [[0.04, 0.34], [0.42, 0.34]], [[0.06, 0.64], [0.44, 0.64]]]],
  ['%', [ellipse(0.14, 0.76, 0.10, 0.15), ellipse(0.40, 0.20, 0.10, 0.15), [[0.44, 0.90], [0.10, 0.06]]]],
  ['°', [ellipse(0.16, 0.78, 0.10, 0.13)]],
  ['~', [[[0.04, 0.46], [0.12, 0.56], [0.24, 0.38], [0.32, 0.48]]]],
]);

/** Codepoints that render with another glyph's cell. Case folding, mostly. */
function aliasesFor(canonical: string): string[] {
  const lower = canonical.toLowerCase();
  return lower !== canonical ? [lower] : [];
}

/* ---------------------------------------------------------------- distance */

/**
 * Signed distance to the pen mark left by the segment `a→b`: a rectangle of
 * half-width `STROKE`, with SQUARE CAPS.
 *
 * Square rather than round is the single decision that makes this read as an
 * industrial grotesque instead of a rounded display face — a capsule leaves a
 * bulb on every terminal, and an E, an F and a T are nothing but terminals. The
 * cost is a notch on the outside of a curve where two boxes meet at an angle;
 * at the 12° arc step this file samples, that notch is 0.0004 cap heights, which
 * at a 42-texel cap is a fiftieth of a texel and below the field's quantisation.
 *
 * A degenerate segment (a period, a colon, the dot of an i) becomes a square,
 * which is what a technical face uses anyway.
 */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len = Math.sqrt(vx * vx + vy * vy);
  const mx = px - (ax + bx) * 0.5;
  const my = py - (ay + by) * 0.5;
  let along: number;
  let across: number;
  if (len < 1e-9) {
    along = mx;
    across = my;
  } else {
    const ux = vx / len;
    const uy = vy / len;
    along = mx * ux + my * uy;
    across = -mx * uy + my * ux;
  }
  const qx = Math.abs(along) - len * 0.5 - STROKE;
  const qy = Math.abs(across) - STROKE;
  // Exact box SDF: the outside term handles the corners, the inside term is the
  // (negative) distance to the nearest face.
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

/** Signed distance to the whole pen stroke: negative inside the ink. */
function glyphDistance(strokes: readonly Stroke[], px: number, py: number): number {
  let best = 1e9;
  for (const stroke of strokes) {
    if (stroke.length === 1) {
      const [x, y] = stroke[0];
      best = Math.min(best, segmentDistance(px, py, x, y, x, y));
      continue;
    }
    for (let i = 0; i + 1 < stroke.length; i++) {
      const a = stroke[i];
      const b = stroke[i + 1];
      const d = segmentDistance(px, py, a[0], a[1], b[0], b[1]);
      if (d < best) best = d;
    }
  }
  return best;
}

interface InkBounds {
  minX: number;
  maxX: number;
}

function inkBounds(strokes: readonly Stroke[]): InkBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const stroke of strokes) {
    for (const [x] of stroke) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0 };
  return { minX: minX - STROKE, maxX: maxX + STROKE };
}

/* ------------------------------------------------------------------- bake */

export interface FontBakeOptions {
  /** Edge of one glyph cell, in texels. The atlas sizes itself from this. */
  readonly cell: number;
  /** Texels of distance mapped onto the full 0..1 code range. */
  readonly distanceRange: number;
}

interface GlyphMetrics {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  advance: number;
  bearingX: number;
  bearingY: number;
  width: number;
  height: number;
}

/**
 * Rasterise the face into one SDF atlas.
 *
 * Layout is a fixed grid so a glyph's cell is `index → (col, row)` with no
 * packer heuristics — a packer would repack when a glyph's bounds change by a
 * texel and silently move every UV in the HUD.
 */
export function bakeFont(opts: FontBakeOptions): BakedFont {
  const cell = Math.max(16, Math.floor(opts.cell));
  const distanceRange = Math.max(2, Math.floor(opts.distanceRange));
  const grid = Math.ceil(Math.sqrt(GLYPHS.size));
  const atlas = cell * grid;
  // Zero everywhere is "far outside the glyph", which is what an untouched cell
  // must read as — the field is centred on 0.5 at the edge, so a text shader's
  // `smoothstep(0.5 - w, 0.5 + w, sample)` needs no bias term.
  const data = new Uint8Array(atlas * atlas);
  const glyphs = new Map<number, GlyphMetrics>();

  // Cap height in texels inside a cell, leaving room for descenders and for the
  // SDF spread to fall to zero before the cell boundary — a glyph whose field is
  // clipped at the cell edge bleeds into its neighbour under linear filtering.
  const pad = distanceRange + 1;
  const usable = cell - pad * 2;
  const capPx = usable / (ASCENDER - DESCENDER);
  const baselinePx = pad + capPx * -DESCENDER;

  let index = 0;
  for (const [char, strokes] of GLYPHS) {
    const col = index % grid;
    const row = Math.floor(index / grid);
    const ox = col * cell;
    const oy = row * cell;
    const bounds = inkBounds(strokes);
    const inkWidth = Math.max(0, bounds.maxX - bounds.minX);
    // Auto-fit: shift so the ink starts exactly one side bearing in, and set the
    // advance from the ink itself. Hand-tuned advances are where a stroke font
    // usually falls apart — B, I and W cannot share a number.
    const shift = char === ' ' ? 0 : BEARING - bounds.minX;
    const advance = char === ' ' ? 0.34 : inkWidth + BEARING * 2;

    if (strokes.length > 0) {
      for (let py = 0; py < cell; py++) {
        // Texel centre, in design space. Flipped because texture v grows up
        // while the atlas row index grows down.
        const gy = (cell - 1 - py + 0.5 - baselinePx) / capPx;
        for (let px = 0; px < cell; px++) {
          const gx = (px + 0.5 - pad) / capPx - shift;
          const d = glyphDistance(strokes, gx, gy) * capPx; // texels
          // Negative inside ⇒ codes above 128 inside, which is the convention
          // `Sdf2dResponse` documents and every text shader in the repo expects.
          const t = 0.5 - d / (distanceRange * 2);
          data[(oy + py) * atlas + ox + px] = Math.max(0, Math.min(255, Math.round(t * 255)));
        }
      }
    }

    // The quad the HUD draws is the cell's USABLE box, not the ink box: the SDF
    // spread lives outside the ink, and a quad cropped to the ink would clip the
    // antialiasing ramp off every stem. `bearingX` is therefore negative — the
    // box starts `pad` texels left of the pen position.
    // The atlas is uploaded with `flipY = false`, so data row 0 is v = 0 and v
    // therefore grows DOWNWARD through the cell: `v1` (the glyph's top edge) is
    // the smaller number. Getting this backwards renders every glyph upside
    // down, which is the single most common bug in a hand-rolled font atlas.
    const entry: GlyphMetrics = {
      u0: (ox + pad) / atlas,
      v0: (oy + cell - pad) / atlas,
      u1: (ox + cell - pad) / atlas,
      v1: (oy + pad) / atlas,
      advance,
      bearingX: -pad / capPx,
      bearingY: ASCENDER,
      width: usable / capPx,
      height: usable / capPx,
    };
    glyphs.set(char.codePointAt(0) ?? 32, entry);
    for (const alias of aliasesFor(char)) glyphs.set(alias.codePointAt(0) ?? 32, entry);
    index++;
  }

  const texture = new THREE.DataTexture(data, atlas, atlas, THREE.RedFormat, THREE.UnsignedByteType);
  texture.name = 'bake.font.atlas';
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // No mips: an SDF averaged down the chain stops being a distance field, and
  // HUD text is drawn at native resolution by definition.
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;

  return {
    atlas: texture,
    glyphs,
    lineHeight: LINE_HEIGHT,
    ascender: ASCENDER,
    descender: DESCENDER,
    distanceRange,
  };
}

/** Glyph count, for the bake's own cost accounting and for the shot's label. */
export const FONT_GLYPH_COUNT = GLYPHS.size;
