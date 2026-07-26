/**
 * HUD design tokens. OWNER: HUD.
 *
 * Every colour, size, opacity and easing curve in `docs/HUD_SPEC.md` §4, §5 and
 * §8 lives here and nowhere else. A widget that hardcodes a hex value or a pixel
 * size is a bug: the spec ships three team-hue pairings (cyan/salmon,
 * blue/crimson, cyan/magenta) with byte-identical geometry, and the only way to
 * be able to prove that is for the hue to be a variable every draw call reads.
 *
 * COLOUR SPACE. HUD colours are authored in sRGB and written straight through.
 * The HUD is drawn after the tonemap and is never graded, exposed or bloomed —
 * drawing UI before the tonemap is the classic hobby-post-stack tell. The values
 * below are therefore literal sRGB 0..1, and the shader only converts them when
 * the destination target is itself sRGB-encoded (§6 of `renderer.ts`).
 */

/** Straight sRGB triple, 0..1. */
export type Rgb = readonly [number, number, number];

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];

/* --------------------------------------------------------------- colours -- */

export const COLOUR = Object.freeze({
  /* team + state (§5.1) */
  friendly: hex(0x75f0ff),
  friendlyTrack: hex(0x123a52),
  friendlyPlate: hex(0x122434),
  enemy: hex(0xfd8b80),
  enemyTrack: hex(0x35202c),
  enemyPlate: hex(0x2b1a24),
  enemyWorld: hex(0xe9724f),
  neutralObj: hex(0xeaf16f),
  neutralStroke: hex(0xb9c0c5),

  /* squad, self, progression (§5.2) */
  squad: hex(0x8ff03c),
  squadDead: hex(0x68705c),
  self: hex(0xf2f6e4),
  xp: hex(0xb7f382),
  xpScrim: hex(0x60be2c),
  scoreObj: hex(0xf7fc3d),

  /* feedback (§5.3) */
  fxHit: hex(0xf4f8fa),
  fxKill: hex(0xf5c24a),
  contestPip: hex(0xe0a85c),
  orderPath: hex(0xf0b428),
  warn: hex(0xffb03a),
  alert: hex(0xf03b2e),
  gadget: hex(0x3ade1e),

  /* neutrals (§5.4). NOTHING here is pure #FFFFFF. */
  white: hex(0xe8edf1),
  whiteKey: hex(0xf4f8fa),
  dim: hex(0x7e8b96),
  ink: hex(0x12171a),
  chipFill: hex(0xdcded8),
  art: hex(0xd2d8dc),
  black: hex(0x000000),
} as const);

/** Alphas that belong to a token rather than to a call site (§5.4, §5.5). */
export const ALPHA = Object.freeze({
  scrim: 0.33,
  scrimDeep: 0.45,
  scrimMarker: 0.32,
  hatch: 0.15,
  plate: 0.7,
  track: 0.85,
  chip: 0.9,
  mapPlate: 0.85,
  zoneFill: 0.12,
  compassLabel: 0.92,
  compassTick: 0.55,
  compassRule: 0.5,
  hudLine: 0.95,
  deEmphasis: 0.25,
  xpScrim: 0.28,
} as const);

/**
 * The "dim track" of a team hue is a 0.53 luminance multiply of its full
 * colour, per §5.1 — derived, never a second authored token, so swapping the
 * hue variable carries the depleted state with it.
 */
export function dimmed(c: Rgb, k = 0.53): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Lift a hue toward white without changing it — the drain-front glow, +35 %. */
export function brighten(c: Rgb, k: number): Rgb {
  return [Math.min(1, c[0] * (1 + k)), Math.min(1, c[1] * (1 + k)), Math.min(1, c[2] * (1 + k))];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/* ------------------------------------------------------------------ type -- */

/**
 * SDF threshold per weight (§4.3). The field stores
 * `code = 0.5 − d/(2·distanceRange)` with negative distance inside the ink, so
 * the glyph edge is at 0.5 and a LOWER threshold admits more of the field and
 * therefore fattens the stem.
 *
 * `docs/HUD_SPEC.md` §4.6 says the glow pass uses a threshold "raised to ~0.62
 * (a dilated silhouette)", which contradicts its own §4.3 table where the bolder
 * weights are the lower thresholds. The field's sign settles it: raising the
 * threshold ERODES. The glow therefore lowers it (`GLOW_THRESHOLD`), and this is
 * reported as a spec-internal inconsistency rather than followed literally.
 */
export const WEIGHT = Object.freeze({
  light: 0.545,
  regular: 0.5,
  bold: 0.455,
  display: 0.43,
} as const);

/** Dilated silhouette for the additive glow pass. */
export const GLOW_THRESHOLD = 0.38;

export interface TypeStep {
  /** Cap height in `u`. */
  readonly cap: number;
  readonly weight: number;
  /** Extra advance after every glyph, in cap-height units. */
  readonly tracking: number;
}

/** §4.2. Never use a size that is not on this ladder. */
export const TYPE = Object.freeze({
  t0: { cap: 0.85, weight: WEIGHT.regular, tracking: 0.08 } as TypeStep,
  t1: { cap: 1.05, weight: WEIGHT.bold, tracking: 0.06 } as TypeStep,
  t2: { cap: 1.2, weight: WEIGHT.regular, tracking: 0.015 } as TypeStep,
  t3: { cap: 1.55, weight: WEIGHT.bold, tracking: 0.04 } as TypeStep,
  t4: { cap: 1.85, weight: WEIGHT.bold, tracking: 0 } as TypeStep,
  t5: { cap: 2.9, weight: WEIGHT.display, tracking: 0 } as TypeStep,
} as const);

/**
 * §4.4.2 — every digit and every numeric separator gets this constant advance,
 * in cap-height units, so a counter never reflows as it ticks. Derived from the
 * reference's 0.85 advance / 0.65 ink ratio against our face's 0.61-cap digit
 * ink; the font's own ≈0.72 natural digit advance reads cramped and is the
 * classic hand-rolled-HUD tell.
 */
export const TABULAR_ADVANCE = 0.82;

/** The display cut is narrower than the text cut (§4.3). */
export const DISPLAY_XSCALE = 0.88;

/* ---------------------------------------------------------------- easing -- */

/**
 * `cubic-bezier(x1, y1, x2, y2)` evaluated by Newton iteration on x. Three
 * iterations lands inside 1e-5 for every curve in §8.1, which is a hundredth of
 * a frame of animation error and free.
 */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 4; i++) {
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (sampleX(t) - x) / d;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

/** §8.1. `LIN` is deliberately identity — anything that IS a rate never eases. */
export const EASE = Object.freeze({
  out: bezier(0.22, 1.0, 0.36, 1.0),
  snap: bezier(0.16, 1.0, 0.3, 1.0),
  io: bezier(0.65, 0.0, 0.35, 1.0),
  lin: (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t),
} as const);

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Symmetric 0→1→0 ramp, for anything that pulses on a sine loop. */
export function pulse(time: number, periodSeconds: number): number {
  return 0.5 - 0.5 * Math.cos((time / periodSeconds) * Math.PI * 2);
}
