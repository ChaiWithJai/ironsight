/**
 * The HUD's shape vocabulary. OWNER: HUD.
 *
 * These are the marks that are NOT type: the ownership shapes, the class
 * glyphs, the slot badge, the skull, the weapon and gadget pictograms, the
 * keybind chip, the award ribbon and the map pin. They live in one file because
 * `docs/HUD_SPEC.md` §0.1 makes the ownership triad — circle / diamond /
 * rounded square — a load-bearing invariant that appears in the capture row, on
 * world markers, on the minimap and on the deploy map. Four call sites each
 * drawing "a diamond" their own way is exactly how a HUD ends up with three
 * different diamonds.
 *
 * Every function here takes device pixels and writes into the shared batch, so
 * the shapes inherit z-order from call order like everything else.
 */
import type { HudBatch, Pt } from './draw';
import { ALPHA, COLOUR, type Rgb } from './theme';
import type { TextPen } from './text';
import { TYPE, WEIGHT } from './theme';

/** §0.1. Ownership is encoded by SHAPE first and colour second. */
export type OwnerShape = 'circle' | 'diamond' | 'roundsquare';

export interface ShapeOpts {
  /** Outline width in px; 0 fills. */
  readonly stroke?: number;
  /** Interior fill colour, drawn under the stroke. */
  readonly fill?: Rgb;
  readonly fillAlpha?: number;
  /** Additive halo radius in px. 0 = none. */
  readonly glow?: number;
  readonly glowAlpha?: number;
}

/**
 * The ownership glyph, at nominal size `s` across.
 *
 * The diamond is a square of side 0.72s rotated 45° (so 1.02s point-to-point)
 * with a 2 px corner radius — literally the same rounded-box field as the
 * circle and the rounded square, at a different rotation and radius. That is
 * what makes the `bf6_gp_024` colour-blind test pass: change the hue token to
 * magenta and the shapes still read.
 */
export function ownerShape(batch: HudBatch, shape: OwnerShape, cx: number, cy: number, s: number, colour: Rgb, alpha: number, opts: ShapeOpts = {}): void {
    const stroke = opts.stroke ?? 0;
  const glow = opts.glow ?? 0;
  if (glow > 0) {
    batch.glow(cx, cy, s * 0.5 + glow, s * 0.5 + glow, colour, (opts.glowAlpha ?? 0.5) * alpha, 2.2);
  }
  switch (shape) {
    case 'circle': {
      const r = s * 0.5;
      if (opts.fill) batch.circle(cx, cy, r - stroke * 0.5, opts.fill, (opts.fillAlpha ?? 1) * alpha);
      if (stroke > 0) batch.circle(cx, cy, r, colour, alpha, stroke);
      else if (!opts.fill) batch.circle(cx, cy, r, colour, alpha);
      break;
    }
    case 'diamond': {
      const half = s * 0.36;
      const rot = Math.PI * 0.25;
      if (opts.fill) batch.box(cx, cy, half - stroke * 0.5, half - stroke * 0.5, 2, opts.fill, (opts.fillAlpha ?? 1) * alpha, { rotation: rot });
      if (stroke > 0) batch.box(cx, cy, half, half, 2, colour, alpha, { stroke, rotation: rot });
      else if (!opts.fill) batch.box(cx, cy, half, half, 2, colour, alpha, { rotation: rot });
      break;
    }
    default: {
      const half = s * 0.38;
      if (opts.fill) batch.box(cx, cy, half - stroke * 0.5, half - stroke * 0.5, 2, opts.fill, (opts.fillAlpha ?? 1) * alpha);
      if (stroke > 0) batch.box(cx, cy, half, half, 2, colour, alpha, { stroke });
      else if (!opts.fill) batch.box(cx, cy, half, half, 2, colour, alpha);
      break;
    }
  }
}

/**
 * §6.6 skull, drawn only on a headshot. Rounded cranium, flat-bottomed jaw
 * block, two knocked-out square sockets and a nose notch — the sockets are cut
 * by overdrawing in the local background rather than by a stencil, which is why
 * the caller passes `knockout`.
 */
export function skull(batch: HudBatch, cx: number, cy: number, w: number, colour: Rgb, alpha: number, knockout: Rgb = COLOUR.black, knockoutAlpha: number = 0.85): void {
  batch.box(cx, cy - w * 0.06, w * 0.5, w * 0.42, w * 0.26, colour, alpha);
  batch.rect(cx - w * 0.275, cy + w * 0.3, w * 0.55, w * 0.22, colour, alpha);
  const eye = w * 0.18;
  batch.box(cx - w * 0.19, cy - w * 0.04, eye * 0.5, w * 0.1, 1, knockout, knockoutAlpha * alpha);
  batch.box(cx + w * 0.19, cy - w * 0.04, eye * 0.5, w * 0.1, 1, knockout, knockoutAlpha * alpha);
  batch.box(cx, cy + w * 0.16, w * 0.05, w * 0.06, 0.5, knockout, knockoutAlpha * alpha);
}

export type ClassKind = 'assault' | 'engineer' | 'support' | 'recon' | 'dead';

/**
 * §6.8 class glyphs — outline only, 0.28u stroke, 2.4u across. Recognisable at
 * 26 px is the whole design constraint: each one is three or four strokes with a
 * distinct silhouette, not a detailed icon shrunk down.
 */
export function classGlyph(batch: HudBatch, kind: ClassKind, cx: number, cy: number, size: number, stroke: number, colour: Rgb, alpha: number): void {
  const h = size * 0.5;
  switch (kind) {
    case 'assault': {
      // Wide chevron with a short internal stem.
      batch.strokePath(
        [
          [cx - h, cy + h * 0.55],
          [cx, cy - h * 0.7],
          [cx + h, cy + h * 0.55],
        ],
        stroke,
        colour,
        alpha,
      );
      batch.strokePath(
        [
          [cx, cy - h * 0.05],
          [cx, cy + h * 0.75],
        ],
        stroke,
        colour,
        alpha,
      );
      break;
    }
    case 'engineer': {
      // Double-ended open wrench: a bar with a C-jaw at each end.
      batch.strokePath(
        [
          [cx - h * 0.35, cy + h * 0.35],
          [cx + h * 0.35, cy - h * 0.35],
        ],
        stroke,
        colour,
        alpha,
      );
      batch.strokePath(
        [
          [cx + h * 0.35, cy - h * 0.9],
          [cx + h * 0.9, cy - h * 0.9],
          [cx + h * 0.9, cy - h * 0.35],
        ],
        stroke,
        colour,
        alpha,
      );
      batch.strokePath(
        [
          [cx - h * 0.35, cy + h * 0.9],
          [cx - h * 0.9, cy + h * 0.9],
          [cx - h * 0.9, cy + h * 0.35],
        ],
        stroke,
        colour,
        alpha,
      );
      break;
    }
    case 'support': {
      batch.rect(cx - h * 0.85, cy - stroke * 0.5, h * 1.7, stroke, colour, alpha);
      batch.rect(cx - stroke * 0.5, cy - h * 0.85, stroke, h * 1.7, colour, alpha);
      break;
    }
    case 'recon': {
      // Four-lobed compass rose: a diamond with concave sides, read as a star.
      const pts: Pt[] = [];
      const lobes = 4;
      for (let i = 0; i < lobes * 2; i++) {
        const a = (i / (lobes * 2)) * Math.PI * 2 - Math.PI * 0.5;
        const r = i % 2 === 0 ? h : h * 0.3;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      batch.strokePath(pts, stroke, colour, alpha, true);
      break;
    }
    default: {
      batch.strokePath(
        [
          [cx - h * 0.7, cy - h * 0.7],
          [cx + h * 0.7, cy + h * 0.7],
        ],
        stroke,
        colour,
        alpha,
      );
      batch.strokePath(
        [
          [cx + h * 0.7, cy - h * 0.7],
          [cx - h * 0.7, cy + h * 0.7],
        ],
        stroke,
        colour,
        alpha,
      );
      break;
    }
  }
}

/**
 * §6.8 slot badge — a flattened hexagon, flat top and bottom, pointed left and
 * right, SOLID FILLED with the digit knocked out. Not a circle, not a square,
 * not an outline: those three are what a reconstruction reaches for and all
 * three read wrong next to the real thing.
 */
export function slotBadge(batch: HudBatch, pen: TextPen, cx: number, cy: number, w: number, h: number, digit: string, colour: Rgb, alpha: number, capPx: number): void {
  const k = 0.24 * w;
  batch.poly(
    [
      [cx - w * 0.5, cy],
      [cx - w * 0.5 + k, cy - h * 0.5],
      [cx + w * 0.5 - k, cy - h * 0.5],
      [cx + w * 0.5, cy],
      [cx + w * 0.5 - k, cy + h * 0.5],
      [cx - w * 0.5 + k, cy + h * 0.5],
    ],
    colour,
    alpha,
  );
  pen.drawSegments(batch, [{ text: digit }], cx, cy + capPx * 0.5, {
    cap: capPx,
    weight: WEIGHT.bold,
    tracking: 0,
    colour: COLOUR.ink,
    alpha,
    align: 'center',
    treatment: 'none',
  });
}

/**
 * §6.16 keybind chip — the ONE inverted family in the HUD and the only rounded
 * corners in the frame: a light plate carrying a dark glyph. Returns its width
 * so a caller can lay out around it.
 */
export function keybindChip(batch: HudBatch, pen: TextPen, label: string, cx: number, cy: number, unit: number, alpha: number = ALPHA.chip): number {
  const capPx = TYPE.t1.cap * unit;
  const side = 1.85 * unit;
  const inner = pen.measure(label, { cap: capPx, weight: WEIGHT.bold, tracking: TYPE.t1.tracking, colour: COLOUR.ink, alpha: 1 });
  const w = Math.max(side, inner + 0.74 * unit);
  batch.box(cx, cy, w * 0.5, side * 0.5, 0.19 * unit, COLOUR.chipFill, alpha);
  pen.drawSegments(batch, [{ text: label }], cx, cy + capPx * 0.5, {
    cap: capPx,
    weight: WEIGHT.bold,
    tracking: TYPE.t1.tracking,
    colour: COLOUR.ink,
    alpha: 1,
    align: 'center',
    treatment: 'none',
  });
  return w;
}

/**
 * §6.14. `∞` is not in the face, so it is drawn as a lemniscate stroked at the
 * face's own stem weight — text and vector have to match or the reserve count
 * reads as two different fonts.
 */
export function infinityGlyph(batch: HudBatch, cx: number, cy: number, cap: number, colour: Rgb, alpha: number): void {
  const r = cap * 0.3;
  const dx = cap * 0.32;
  const stroke = cap * 0.15;
  const pts: Pt[] = [];
  // Lemniscate of Gerono, which crosses cleanly at the centre instead of
  // leaving the two circles' inner arcs visible.
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    pts.push([cx + dx * 1.55 * Math.cos(t), cy + r * 1.6 * Math.sin(t) * Math.cos(t)]);
  }
  batch.strokePath(pts, stroke, colour, alpha, true);
}

export type WeaponSilhouetteClass = 'ar' | 'carbine' | 'smg' | 'dmr' | 'lmg' | 'shotgun' | 'pistol';

/**
 * §6.9 weapon pictogram: a flat `--art` fill with NO outline, built from the
 * weapon's own profile — receiver box, barrel line, magazine wedge, stock — and
 * with internal cut lines drawn as negative space in the panel scrim rather than
 * as strokes. `x,y` is the top-left of a `w × h` box; the silhouette is fitted
 * inside it.
 */
export function weaponSilhouette(
  batch: HudBatch,
  kind: WeaponSilhouetteClass,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: Rgb,
  alpha: number,
  cut: Rgb,
  cutAlpha: number,
): void {
  const bore = y + h * 0.42;
  const t = h * 0.16;
  // Per-class proportions, all as fractions of the box. A pistol is short and
  // deep, an LMG long with a box magazine, a shotgun has a tube under the barrel.
  const p = {
    ar: { barrel: 0.5, receiver: [0.3, 0.62], mag: [0.4, 0.5], magDrop: 0.5, stock: 0.28, optic: true, tube: false },
    carbine: { barrel: 0.44, receiver: [0.32, 0.64], mag: [0.42, 0.52], magDrop: 0.44, stock: 0.3, optic: true, tube: false },
    smg: { barrel: 0.3, receiver: [0.3, 0.66], mag: [0.44, 0.56], magDrop: 0.62, stock: 0.26, optic: false, tube: false },
    dmr: { barrel: 0.58, receiver: [0.34, 0.66], mag: [0.44, 0.54], magDrop: 0.4, stock: 0.32, optic: true, tube: false },
    lmg: { barrel: 0.5, receiver: [0.28, 0.62], mag: [0.36, 0.56], magDrop: 0.72, stock: 0.3, optic: true, tube: false },
    shotgun: { barrel: 0.56, receiver: [0.36, 0.66], mag: [0, 0], magDrop: 0, stock: 0.34, optic: false, tube: true },
    pistol: { barrel: 0.34, receiver: [0.3, 0.78], mag: [0.42, 0.56], magDrop: 0.66, stock: 0, optic: false, tube: false },
  }[kind];

  // Barrel.
  batch.rect(x + w * 0.02, bore - t * 0.32, w * p.barrel, t * 0.64, colour, alpha);
  if (p.tube) batch.rect(x + w * 0.04, bore + t * 0.38, w * (p.barrel - 0.06), t * 0.42, colour, alpha);
  // Receiver.
  batch.rect(x + w * p.receiver[0], bore - t * 0.85, w * (p.receiver[1] - p.receiver[0]), t * 1.7, colour, alpha);
  // Magazine wedge — leaned forward, which is most of what says "rifle".
  if (p.mag[1] > p.mag[0]) {
    const mx0 = x + w * p.mag[0];
    const mx1 = x + w * p.mag[1];
    const lean = w * 0.03;
    batch.poly(
      [
        [mx0, bore + t * 0.6],
        [mx1, bore + t * 0.6],
        [mx1 - lean, bore + t * 0.6 + h * p.magDrop],
        [mx0 - lean, bore + t * 0.6 + h * p.magDrop],
      ],
      colour,
      alpha,
    );
  }
  // Grip and stock.
  batch.poly(
    [
      [x + w * (p.receiver[1] - 0.09), bore + t * 0.6],
      [x + w * (p.receiver[1] - 0.02), bore + t * 0.6],
      [x + w * (p.receiver[1] + 0.02), bore + t * 0.6 + h * 0.34],
      [x + w * (p.receiver[1] - 0.05), bore + t * 0.6 + h * 0.34],
    ],
    colour,
    alpha,
  );
  if (p.stock > 0) {
    batch.rect(x + w * p.receiver[1], bore - t * 0.55, w * p.stock, t * 1.1, colour, alpha);
    batch.rect(x + w * (p.receiver[1] + p.stock - 0.05), bore - t * 0.85, w * 0.05, t * 1.9, colour, alpha);
  }
  if (p.optic) {
    batch.rect(x + w * (p.receiver[0] + 0.06), bore - t * 1.55, w * 0.16, t * 0.7, colour, alpha);
  }
  // Internal cut lines as negative space in the panel scrim (§6.9): a handguard
  // vent and the magazine well seam. Strokes here would read as an outline,
  // which the reference pictograms never have.
  batch.rect(x + w * 0.1, bore - t * 0.12, w * (p.barrel - 0.14), 1, cut, cutAlpha);
  batch.rect(x + w * p.receiver[0] + 1, bore + t * 0.2, w * (p.receiver[1] - p.receiver[0]) - 2, 1, cut, cutAlpha);
}

export type GadgetIcon = 'frag' | 'smoke' | 'medkit' | 'ammo' | 'sensor' | 'breach' | 'launcher' | 'repair';

/** §6.11/§6.13 gadget pictograms — flat line art, ~50 % of the tile. */
export function gadgetIcon(batch: HudBatch, kind: GadgetIcon, cx: number, cy: number, size: number, stroke: number, colour: Rgb, alpha: number): void {
  const h = size * 0.5;
  switch (kind) {
    case 'frag': {
      batch.box(cx, cy + h * 0.12, h * 0.52, h * 0.62, h * 0.3, colour, alpha, { stroke });
      batch.rect(cx - h * 0.22, cy - h * 0.72, h * 0.44, stroke, colour, alpha);
      batch.strokePath(
        [
          [cx + h * 0.1, cy - h * 0.7],
          [cx + h * 0.45, cy - h * 0.9],
        ],
        stroke,
        colour,
        alpha,
      );
      break;
    }
    case 'smoke': {
      batch.box(cx, cy + h * 0.1, h * 0.34, h * 0.66, h * 0.14, colour, alpha, { stroke });
      batch.rect(cx - h * 0.18, cy - h * 0.72, h * 0.36, stroke, colour, alpha);
      batch.rect(cx - h * 0.34, cy + h * 0.3, h * 0.68, stroke, colour, alpha);
      break;
    }
    case 'medkit': {
      batch.box(cx, cy, h * 0.8, h * 0.6, h * 0.1, colour, alpha, { stroke });
      batch.rect(cx - h * 0.34, cy - stroke * 0.5, h * 0.68, stroke, colour, alpha);
      batch.rect(cx - stroke * 0.5, cy - h * 0.3, stroke, h * 0.6, colour, alpha);
      break;
    }
    case 'ammo': {
      batch.box(cx, cy, h * 0.82, h * 0.58, h * 0.08, colour, alpha, { stroke });
      batch.rect(cx - h * 0.5, cy - h * 0.58, h * 1.0, stroke, colour, alpha);
      for (let i = -1; i <= 1; i++) batch.rect(cx + i * h * 0.28 - stroke * 0.5, cy - h * 0.24, stroke, h * 0.48, colour, alpha);
      break;
    }
    case 'sensor': {
      batch.circle(cx, cy, h * 0.28, colour, alpha, stroke);
      for (let i = 1; i <= 2; i++) {
        batch.arc(cx, cy, h * (0.28 + i * 0.22) - stroke * 0.5, h * (0.28 + i * 0.22) + stroke * 0.5, -Math.PI * 0.85, -Math.PI * 0.15, colour, alpha * 0.9);
      }
      batch.rect(cx - stroke * 0.5, cy + h * 0.3, stroke, h * 0.55, colour, alpha);
      break;
    }
    case 'breach': {
      batch.box(cx, cy, h * 0.5, h * 0.72, h * 0.08, colour, alpha, { stroke });
      batch.strokePath(
        [
          [cx - h * 0.2, cy - h * 0.3],
          [cx + h * 0.12, cy - h * 0.02],
          [cx - h * 0.08, cy + h * 0.06],
          [cx + h * 0.2, cy + h * 0.4],
        ],
        stroke,
        colour,
        alpha,
      );
      break;
    }
    case 'launcher': {
      batch.rect(cx - h * 0.8, cy - stroke, h * 1.5, stroke * 2, colour, alpha);
      batch.poly(
        [
          [cx + h * 0.7, cy - stroke * 2.2],
          [cx + h * 0.95, cy],
          [cx + h * 0.7, cy + stroke * 2.2],
        ],
        colour,
        alpha,
      );
      batch.rect(cx - h * 0.5, cy + stroke, h * 0.2, h * 0.42, colour, alpha);
      break;
    }
    default: {
      batch.strokePath(
        [
          [cx - h * 0.6, cy + h * 0.6],
          [cx + h * 0.2, cy - h * 0.2],
        ],
        stroke * 1.6,
        colour,
        alpha,
      );
      batch.circle(cx + h * 0.45, cy - h * 0.45, h * 0.3, colour, alpha, stroke);
      break;
    }
  }
}

/**
 * §6.30 / §6.18 directional fin: a filled wedge with a CONCAVE inner edge,
 * pointing away from screen centre. The concavity is what makes it read as part
 * of the off-screen indicator family rather than as a generic arrow.
 */
export function directionFin(batch: HudBatch, cx: number, cy: number, w: number, h: number, angle: number, colour: Rgb, alpha: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local: Pt[] = [
    [w, 0],
    [-w * 0.35, h * 0.5],
    [0, 0],
    [-w * 0.35, -h * 0.5],
  ];
  batch.poly(
    local.map(([lx, ly]): Pt => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]),
    colour,
    alpha,
  );
}

/** §6.29 enemy spot pin: filled circle with a downward taper, no stroke. */
export function mapPin(batch: HudBatch, cx: number, cy: number, d: number, colour: Rgb, alpha: number): void {
  batch.circle(cx, cy, d * 0.5, colour, alpha);
  batch.poly(
    [
      [cx - d * 0.34, cy + d * 0.3],
      [cx + d * 0.34, cy + d * 0.3],
      [cx, cy + d * 0.3 + d * 0.7],
    ],
    colour,
    alpha,
  );
}

/**
 * §6.25 award ribbon: a vertical dagger flanked by four stacked tapering bars
 * each side, reading as stylised laurel wings. Pure white, no scrim.
 */
export function awardRibbon(batch: HudBatch, cx: number, cy: number, w: number, h: number, colour: Rgb, alpha: number): void {
  batch.rect(cx - w * 0.02, cy - h * 0.5, w * 0.04, h, colour, alpha);
  batch.poly(
    [
      [cx - w * 0.04, cy - h * 0.5],
      [cx + w * 0.04, cy - h * 0.5],
      [cx, cy - h * 0.78],
    ],
    colour,
    alpha,
  );
  for (let i = 0; i < 4; i++) {
    const yy = cy - h * 0.28 + i * h * 0.2;
    const len = w * (0.42 - i * 0.07);
    batch.poly(
      [
        [cx - w * 0.05, yy - h * 0.06],
        [cx - w * 0.05 - len, yy],
        [cx - w * 0.05, yy + h * 0.06],
      ],
      colour,
      alpha,
    );
    batch.poly(
      [
        [cx + w * 0.05, yy - h * 0.06],
        [cx + w * 0.05 + len, yy],
        [cx + w * 0.05, yy + h * 0.06],
      ],
      colour,
      alpha,
    );
  }
}

/**
 * §7 blueprint chrome. Non-functional connective tissue at 25–45 % opacity,
 * drawn ONLY in the outer margin of full-screen states and never over live
 * gameplay. Three or four marks, never a border.
 */
export function blueprintRuler(batch: HudBatch, x: number, y: number, w: number, unit: number, colour: Rgb, alpha: number, mirrored = false): void {
  const dir = mirrored ? -1 : 1;
  batch.rect(Math.min(x, x + w * dir), y, Math.abs(w), 1, colour, alpha);
  for (let i = 0; i < 4; i++) {
    const tx = x + dir * (w * (0.12 + i * 0.2));
    batch.rect(tx, y - 0.55 * unit, 1, 0.55 * unit, colour, alpha);
  }
  const ex = x + dir * w;
  for (let i = 0; i < 2; i++) {
    batch.strokePath(
      [
        [ex + dir * (i * 0.4 * unit), y - 0.4 * unit],
        [ex + dir * (0.4 * unit + i * 0.4 * unit), y],
        [ex + dir * (i * 0.4 * unit), y + 0.4 * unit],
      ],
      1,
      colour,
      alpha,
    );
  }
}

export function blueprintBracket(batch: HudBatch, x: number, y: number, h: number, unit: number, colour: Rgb, alpha: number, mirrored = false): void {
  const dir = mirrored ? -1 : 1;
  const arm = 0.9 * unit * dir;
  batch.strokePath(
    [
      [x + arm, y],
      [x, y],
      [x, y + h],
      [x + arm, y + h],
    ],
    1,
    colour,
    alpha,
  );
  batch.box(x, y + h * 0.5, 0.23 * unit, 0.23 * unit, 0, colour, alpha, { stroke: 1 });
}

export function blueprintColumn(batch: HudBatch, x: number, y: number, count: number, unit: number, colour: Rgb, alpha: number): void {
  for (let i = 0; i < count; i++) {
    batch.box(x, y + i * 1.3 * unit, 0.23 * unit, 0.23 * unit, 0, colour, alpha, { stroke: 1 });
  }
}

export function blueprintCross(batch: HudBatch, x: number, y: number, unit: number, colour: Rgb, alpha: number): void {
  batch.rect(x - 0.37 * unit, y, 0.74 * unit, 1, colour, alpha);
  batch.rect(x, y - 0.37 * unit, 1, 0.74 * unit, colour, alpha);
}
