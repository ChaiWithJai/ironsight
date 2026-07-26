/**
 * SDF text layout for the HUD. OWNER: HUD.
 *
 * Consumes `BakedFont` (BAKE, `src/bake/font.ts`) — a stroke-skeleton atlas with
 * a slashed zero, caps-only case folding and one synthesised weight. There is no
 * `fillText`, no `document.fonts` and no font file anywhere in this project.
 *
 * WHERE THE GLYPH QUAD GOES, derived rather than trusted
 * ------------------------------------------------------
 * The bake writes texel `px` of a cell from design x `(px + 0.5 − pad)/capPx −
 * shift`, and publishes `u0` at the LEFT EDGE of texel `pad`. Substituting the
 * edge (`s = pad`) gives design x `−shift`, i.e. pen x = 0: the usable box's
 * left edge sits exactly on the advance origin, and the ink then starts one
 * side bearing in. `BakedFont.bearingX` reports `−pad/capPx` instead, which
 * would pull every glyph ~0.12 cap left of its pen and overlap the sidebearings;
 * we use the derivation. Vertically `bearingY` (= ascender) and `height` are
 * consistent and are used as published.
 *
 * TABULAR NUMERALS are a hard requirement of §4.4.2, not a nicety: the font
 * auto-fits advances from ink bounds, so `1` is narrow and a ticket counter
 * would reflow on every tick. Digits and numeric separators are forced to a
 * constant 0.82-cap advance and CENTRED inside it, which reproduces the
 * reference's 0.85-advance / 0.65-ink proportion at every size.
 */
import type { BakedFont } from '@/engine/types';
import { GLOW_THRESHOLD, TABULAR_ADVANCE, type Rgb, COLOUR } from './theme';
import type { HudBatch } from './draw';

export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  /** Cap height in device pixels. */
  readonly cap: number;
  /** SDF threshold — the synthetic weight (§4.3). */
  readonly weight: number;
  /** Extra advance after every glyph, in cap-height units. */
  readonly tracking: number;
  readonly colour: Rgb;
  readonly alpha: number;
  readonly align?: TextAlign;
  /** Force the constant digit advance. Default true — turn it off for prose. */
  readonly tabular?: boolean;
  /** Horizontal squeeze on both the quad and the advance. Display cut = 0.88. */
  readonly xScale?: number;
  /**
   * §4.6. `shadow` = 1px hard dark offset, for white/neutral text. `glow` = soft
   * additive halo in the text's own hue, for coloured text. Never both.
   */
  readonly treatment?: 'shadow' | 'glow' | 'none';
  readonly glowAlpha?: number;
}

/** One colour run inside a single laid-out string — the padded magazine count. */
export interface TextSegment {
  readonly text: string;
  readonly colour?: Rgb;
  readonly alpha?: number;
  readonly weight?: number;
}

const TABULAR_CHARS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', ',', ':', '/']);

const SHADOW_ALPHA = 0.75;
/** Threshold shift for the dark contrast rim; ≈1 px of dilation at HUD sizes. */
const RIM_DILATE = 0.09;
const RIM_ALPHA = 0.78;

export class TextPen {
  constructor(private readonly font: BakedFont) {}

  private entry(ch: string): ReturnType<BakedFont['glyphs']['get']> {
    return this.font.glyphs.get(ch.codePointAt(0) ?? 32);
  }

  /** Advance for one character, in cap-height units, before tracking. */
  private advanceOf(ch: string, tabular: boolean): number {
    if (tabular && TABULAR_CHARS.has(ch)) return TABULAR_ADVANCE;
    const g = this.entry(ch);
    return g ? g.advance : 0.34;
  }

  /**
   * Run width in device pixels. The trailing tracking is trimmed, per §4.2 —
   * otherwise every centred label sits half a tracking unit left of centre.
   */
  measure(text: string, style: TextStyle): number {
    const tabular = style.tabular ?? true;
    const xs = style.xScale ?? 1;
    let w = 0;
    for (const ch of text) w += (this.advanceOf(ch, tabular) + style.tracking) * style.cap * xs;
    return Math.max(0, w - style.tracking * style.cap * xs);
  }

  measureSegments(segments: readonly TextSegment[], style: TextStyle): number {
    let w = 0;
    for (const s of segments) w += this.measure(s.text, style) + (s.text.length > 0 ? style.tracking * style.cap * (style.xScale ?? 1) : 0);
    return Math.max(0, w - style.tracking * style.cap * (style.xScale ?? 1));
  }

  /** Left edge of a run drawn at `x` under `align`. */
  private originFor(width: number, x: number, align: TextAlign): number {
    if (align === 'center') return x - width * 0.5;
    if (align === 'right') return x - width;
    return x;
  }

  draw(batch: HudBatch, text: string, x: number, baselineY: number, style: TextStyle): number {
    return this.drawSegments(batch, [{ text }], x, baselineY, style);
  }

  /**
   * Lay out and emit one line. `baselineY` is snapped in Y (§2.5) while X stays
   * fractional so tracking never quantises unevenly across a run.
   */
  drawSegments(batch: HudBatch, segments: readonly TextSegment[], x: number, baselineY: number, style: TextStyle): number {
    const tabular = style.tabular ?? true;
    const xs = style.xScale ?? 1;
    const cap = style.cap;
    const treatment = style.treatment ?? 'shadow';
    const total = this.measureSegments(segments, style);
    let pen = this.originFor(total, x, style.align ?? 'left');
    const by = Math.round(baselineY);

    // Glow first, then the dark rim, then the offset shadow, then the sharp
    // draw — §9.6 requires the dilated pass immediately before its own sharp
    // pass inside the same layer.
    if (treatment === 'glow') this.emitRun(batch, segments, pen, by, style, tabular, xs, cap, 'glow');
    if (treatment !== 'none') this.emitRun(batch, segments, pen, by, style, tabular, xs, cap, 'rim');
    if (treatment === 'shadow') this.emitRun(batch, segments, pen, by, style, tabular, xs, cap, 'shadow');
    this.emitRun(batch, segments, pen, by, style, tabular, xs, cap, 'sharp');
    pen += total;
    return total;
  }

  private emitRun(
    batch: HudBatch,
    segments: readonly TextSegment[],
    startX: number,
    baselineY: number,
    style: TextStyle,
    tabular: boolean,
    xs: number,
    cap: number,
    pass: 'sharp' | 'shadow' | 'glow' | 'rim',
  ): void {
    const font = this.font;
    let pen = startX;
    for (const seg of segments) {
      const colour = pass === 'shadow' || pass === 'rim' ? COLOUR.black : (seg.colour ?? style.colour);
      const baseAlpha = (seg.alpha ?? 1) * style.alpha;
      const weight = seg.weight ?? style.weight;
      for (const ch of seg.text) {
        const g = font.glyphs.get(ch.codePointAt(0) ?? 32);
        const natural = g ? g.advance : 0.34;
        const forced = tabular && TABULAR_CHARS.has(ch);
        const advance = forced ? TABULAR_ADVANCE : natural;
        if (g && ch !== ' ') {
          // Centre a forced-advance digit inside its cell, so `1` sits where a
          // `Ø` sits and a counter reads as an instrument rather than a label.
          const inset = forced ? (TABULAR_ADVANCE - natural) * 0.5 : 0;
          const x0 = pen + inset * cap * xs;
          const x1 = x0 + g.width * cap * xs;
          const y0 = baselineY - g.bearingY * cap;
          const y1 = y0 + g.height * cap;
          if (pass === 'sharp') {
            batch.glyph(x0, y0, x1, y1, g.u0, g.v0, g.u1, g.v1, colour, baseAlpha, weight, 0, 0);
          } else if (pass === 'shadow') {
            batch.glyph(x0, y0 + 1, x1, y1 + 1, g.u0, g.v0, g.u1, g.v1, colour, baseAlpha * SHADOW_ALPHA, weight, 0.02, 0);
          } else if (pass === 'rim') {
            // DEVIATION from §4.6, and the brief asked for it explicitly: the
            // HUD must stay legible over a blown-out golden-hour sky. A 1 px
            // offset shadow alone disappears against a display-240 field, so
            // every treated run also gets a DILATED DARK SILHOUETTE under it —
            // a ~1 px rim, not a scrim. The killfeed still has no background
            // box; it just stops vanishing into the horizon.
            batch.glyph(x0, y0, x1, y1, g.u0, g.v0, g.u1, g.v1, colour, baseAlpha * RIM_ALPHA, weight - RIM_DILATE, 0.05, 0);
          } else {
            // Four offset taps of the dilated silhouette. The SDF's own spread
            // only reaches ~0.12 cap, which at a 13 px cap is 1.5 px — too
            // tight for §4.6's 0.55u halo — so the taps carry it outward.
            const g4 = cap * 0.2;
            const a = (style.glowAlpha ?? 0.35) * baseAlpha * 0.42;
            const taps: readonly [number, number][] = [
              [-g4, 0],
              [g4, 0],
              [0, -g4],
              [0, g4],
            ];
            for (const [dx, dy] of taps) {
              batch.glyph(x0 + dx, y0 + dy, x1 + dx, y1 + dy, g.u0, g.v0, g.u1, g.v1, colour, a, GLOW_THRESHOLD, 0.2, 1);
            }
          }
        }
        pen += (advance + style.tracking) * cap * xs;
      }
    }
  }
}
