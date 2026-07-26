/**
 * AUDIO — the on-screen debug overlay.
 *
 * OWNER: AUDIO.
 *
 * Audio cannot be screenshotted, which makes it the one lane the visual critic
 * loop is structurally blind to. This pass exists so `audio_debug` produces a
 * frame a reviewer can actually judge: every live voice with its bus, level,
 * distance and occlusion; the bus meters; the active impulse response and its
 * RT60; and the waveform envelope of the last gunshot fired.
 *
 * It is drawn as a fullscreen shader over the final image rather than as DOM,
 * because `tools/capture.mjs` screenshots the canvas element only — a DOM
 * overlay is structurally incapable of appearing in a shot.
 *
 * Glyphs come from a 6x7 bitmap font packed into a data texture at construction.
 * A baked SDF atlas from BAKE would be prettier, but this pass must work even
 * when the bake budget degraded the font away, and a debug overlay that
 * disappears at Low tier is worse than an ugly one.
 */
import * as THREE from 'three';
import {
  PassOrder,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
  type Services,
} from '@/engine/types';
import type { AudioSnapshot } from '../snapshot';

export const AUDIO_DEBUG_PASS_ID = 'audio.debug.overlay';

/** Columns x rows of the text grid. Sized so 24 voices fit at 1080p. */
const COLS = 96;
const ROWS = 40;
const GLYPH_W = 6;
const GLYPH_H = 7;

/**
 * 6x7 uppercase bitmap font, one 42-bit pattern per glyph, MSB = top-left.
 * Only the characters the overlay actually emits are defined; anything else
 * renders as blank, which is the right failure mode for a debug view.
 */
const FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [0x0c, 0x12, 0x21, 0x3f, 0x21, 0x21, 0x21],
  B: [0x3e, 0x21, 0x3e, 0x21, 0x21, 0x21, 0x3e],
  C: [0x1e, 0x21, 0x20, 0x20, 0x20, 0x21, 0x1e],
  D: [0x3c, 0x22, 0x21, 0x21, 0x21, 0x22, 0x3c],
  E: [0x3f, 0x20, 0x3e, 0x20, 0x20, 0x20, 0x3f],
  F: [0x3f, 0x20, 0x3e, 0x20, 0x20, 0x20, 0x20],
  G: [0x1e, 0x21, 0x20, 0x27, 0x21, 0x21, 0x1f],
  H: [0x21, 0x21, 0x3f, 0x21, 0x21, 0x21, 0x21],
  I: [0x1c, 0x08, 0x08, 0x08, 0x08, 0x08, 0x1c],
  J: [0x07, 0x02, 0x02, 0x02, 0x22, 0x22, 0x1c],
  K: [0x21, 0x22, 0x24, 0x38, 0x24, 0x22, 0x21],
  L: [0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x3f],
  M: [0x21, 0x33, 0x2d, 0x21, 0x21, 0x21, 0x21],
  N: [0x21, 0x31, 0x29, 0x25, 0x23, 0x21, 0x21],
  O: [0x1e, 0x21, 0x21, 0x21, 0x21, 0x21, 0x1e],
  P: [0x3e, 0x21, 0x21, 0x3e, 0x20, 0x20, 0x20],
  Q: [0x1e, 0x21, 0x21, 0x21, 0x25, 0x22, 0x1d],
  R: [0x3e, 0x21, 0x21, 0x3e, 0x24, 0x22, 0x21],
  S: [0x1f, 0x20, 0x20, 0x1e, 0x01, 0x01, 0x3e],
  T: [0x3e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08],
  U: [0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x1e],
  V: [0x21, 0x21, 0x21, 0x21, 0x12, 0x12, 0x0c],
  W: [0x21, 0x21, 0x21, 0x21, 0x2d, 0x33, 0x21],
  X: [0x21, 0x12, 0x0c, 0x0c, 0x0c, 0x12, 0x21],
  Y: [0x21, 0x12, 0x0c, 0x08, 0x08, 0x08, 0x08],
  Z: [0x3f, 0x02, 0x04, 0x08, 0x10, 0x20, 0x3f],
  '0': [0x1e, 0x21, 0x23, 0x2d, 0x31, 0x21, 0x1e],
  '1': [0x08, 0x18, 0x08, 0x08, 0x08, 0x08, 0x1c],
  '2': [0x1e, 0x21, 0x01, 0x06, 0x08, 0x10, 0x3f],
  '3': [0x1e, 0x21, 0x01, 0x0e, 0x01, 0x21, 0x1e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x3f, 0x02, 0x02],
  '5': [0x3f, 0x20, 0x3e, 0x01, 0x01, 0x21, 0x1e],
  '6': [0x0e, 0x10, 0x20, 0x3e, 0x21, 0x21, 0x1e],
  '7': [0x3f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x1e, 0x21, 0x21, 0x1e, 0x21, 0x21, 0x1e],
  '9': [0x1e, 0x21, 0x21, 0x1f, 0x01, 0x02, 0x1c],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ',': [0, 0, 0, 0, 0x0c, 0x0c, 0x10],
  '-': [0, 0, 0, 0x3e, 0, 0, 0],
  '+': [0, 0x08, 0x08, 0x3e, 0x08, 0x08, 0],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  '/': [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x20],
  '%': [0x31, 0x32, 0x04, 0x08, 0x13, 0x23, 0x01],
  '[': [0x1c, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1c],
  ']': [0x1c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1c],
  '(': [0x06, 0x08, 0x10, 0x10, 0x10, 0x08, 0x06],
  ')': [0x18, 0x04, 0x02, 0x02, 0x02, 0x04, 0x18],
  '#': [0x12, 0x3f, 0x12, 0x12, 0x3f, 0x12, 0x12],
  '*': [0, 0x12, 0x0c, 0x3f, 0x0c, 0x12, 0],
  '=': [0, 0, 0x3e, 0, 0x3e, 0, 0],
  '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '>': [0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10],
  _: [0, 0, 0, 0, 0, 0, 0x3f],
};

const FRAGMENT = /* glsl */ `
  // One texel per character cell: r = glyph index, g = colour index.
  uniform sampler2D uText;
  uniform sampler2D uFont;
  uniform vec2 uGrid;
  uniform vec2 uCell;
  uniform vec2 uResolution;
  uniform float uGlyphCount;

  vec3 paletteOf(float idx){
    // Terminal-ish palette: dim label, bright value, amber warn, red alert,
    // cyan for anything spatial. Chosen to stay legible over a bright frame.
    if (idx < 0.5) return vec3(0.55, 0.62, 0.68);
    if (idx < 1.5) return vec3(0.92, 0.95, 0.98);
    if (idx < 2.5) return vec3(0.96, 0.71, 0.32);
    if (idx < 3.5) return vec3(0.92, 0.36, 0.28);
    return vec3(0.40, 0.82, 0.90);
  }

  void main(){
    vec2 px = vUv * uResolution;
    vec2 cellF = px / uCell;
    if (cellF.x >= uGrid.x || cellF.y >= uGrid.y) { outColor = vec4(0.0); return; }

    vec2 cell = floor(cellF);
    vec2 inCell = fract(cellF);
    vec4 t = texture(uText, (cell + 0.5) / uGrid);
    float glyph = floor(t.r * 255.0 + 0.5);
    if (glyph < 0.5) { outColor = vec4(0.0, 0.0, 0.0, 0.34); return; }

    // Font atlas is a single row of glyphs, GLYPH_W x GLYPH_H each.
    vec2 fontUv = vec2((glyph + inCell.x) / uGlyphCount, inCell.y);
    float on = texture(uFont, fontUv).r;
    vec3 rgb = paletteOf(floor(t.g * 255.0 + 0.5));
    // Scrim under the text so the overlay survives a blown-out sky behind it.
    outColor = vec4(rgb * on, max(on, 0.34));
  }
`;

export class AudioDebugPass implements RenderPass {
  readonly id = AUDIO_DEBUG_PASS_ID;
  // After tonemap and UI so the overlay is never graded, blurred or bloomed —
  // a debug readout that changes colour with exposure is useless.
  readonly order = PassOrder.DebugOverlay;
  readonly subOrder = 50;
  readonly reads: readonly string[] = [];
  readonly writes: readonly string[] = [];
  readonly budgetMs = 0.12;

  private readonly glyphIndex = new Map<string, number>();
  private readonly textData: Uint8Array;
  private readonly textTex: THREE.DataTexture;
  private readonly fontTex: THREE.DataTexture;
  private cursor = 0;
  private viewW = 1920;
  private viewH = 1080;

  constructor(
    private readonly services: Services,
    private readonly snapshot: () => AudioSnapshot,
  ) {
    const chars = Object.keys(FONT);
    chars.forEach((c, i) => this.glyphIndex.set(c, i));

    // Font atlas: one row, GLYPH_W px per glyph.
    const fw = chars.length * GLYPH_W;
    const font = new Uint8Array(fw * GLYPH_H);
    chars.forEach((c, gi) => {
      const rows = FONT[c]!;
      for (let y = 0; y < GLYPH_H; y++) {
        const bits = rows[y] ?? 0;
        for (let x = 0; x < GLYPH_W; x++) {
          // Bit 5 is the leftmost column of a 6-wide glyph.
          const on = (bits >> (GLYPH_W - 1 - x)) & 1;
          font[y * fw + gi * GLYPH_W + x] = on ? 255 : 0;
        }
      }
    });
    this.fontTex = new THREE.DataTexture(font, fw, GLYPH_H, THREE.RedFormat);
    this.fontTex.needsUpdate = true;
    this.fontTex.minFilter = THREE.NearestFilter;
    this.fontTex.magFilter = THREE.NearestFilter;

    this.textData = new Uint8Array(COLS * ROWS * 4);
    this.textTex = new THREE.DataTexture(this.textData, COLS, ROWS, THREE.RGBAFormat);
    this.textTex.minFilter = THREE.NearestFilter;
    this.textTex.magFilter = THREE.NearestFilter;
  }

  enabled(_quality: Readonly<QualitySettings>): boolean {
    // Armed explicitly by the audio system; if the pass is registered at all the
    // operator asked for it, so no tier gating.
    return true;
  }

  /* ------------------------------------------------------------- text buffer */

  private clear(): void {
    this.textData.fill(0);
    this.cursor = 0;
  }

  private write(row: number, col: number, text: string, colour = 1): void {
    if (row < 0 || row >= ROWS) return;
    const upper = text.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const c = col + i;
      if (c < 0 || c >= COLS) continue;
      const gi = this.glyphIndex.get(upper[i]!) ?? 0;
      const o = (row * COLS + c) * 4;
      this.textData[o] = gi;
      this.textData[o + 1] = colour;
      this.textData[o + 3] = 255;
    }
  }

  private line(text: string, colour = 1): void {
    this.write(this.cursor++, 1, text, colour);
  }

  private compose(s: AudioSnapshot): void {
    this.clear();
    const n = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--');
    const pad = (v: string, w: number) => (v.length >= w ? v.slice(0, w) : v + ' '.repeat(w - v.length));

    this.line(`IRONSIGHT AUDIO  ${s.contextState} ${s.unlocked ? 'UNLOCKED' : 'LOCKED'} ${n(s.sampleRate / 1000, 1)}KHZ`, 2);
    this.line(
      `VOICES ${s.voicesLive}/${s.voicesMax}  STEALS ${s.steals}  REJECT ${s.rejections}  ` +
        `DUCK ${n(s.duckDb)}DB  DEAF ${n(s.deafness, 2)}`,
      s.rejections > 0 ? 3 : 0,
    );
    this.line(
      `CUES ${s.bakedCues} (${s.bakedVariations} VAR)  ${n(s.bufferBytes / 1048576, 1)}MB  ` +
        `T+${n(s.modelTime, 1)}S`,
    );
    this.line(
      `ENV ${s.envName}  ENCLOSE ${n(s.envEnclosure, 2)}  RT ${n(s.envReverbSeconds, 2)}S  ` +
        `WET ${n(s.envWetDb)}DB  BLEND ${n(s.envBlend, 2)}`,
      4,
    );
    this.line(
      `LISTENER ${n(s.listener.x)} ${n(s.listener.y)} ${n(s.listener.z)}  ` +
        `YAW ${n(s.listener.yawDeg, 0)}  OCCL VIA ${s.occlusionSource}`,
      4,
    );
    this.cursor++;

    this.line(pad('BUS', 12) + pad('LEVEL', 9) + pad('PEAK', 9) + pad('GAIN', 9) + 'VOICES', 0);
    for (const b of s.buses) {
      // Meter bar doubles as an instant read on which bus is carrying the frame.
      const bars = Math.max(0, Math.min(16, Math.round((b.levelDb + 60) / 60 * 16)));
      this.line(
        pad(b.name, 12) +
          pad(n(b.levelDb) + 'DB', 9) +
          pad(n(b.peakDb) + 'DB', 9) +
          pad(n(b.gainDb) + 'DB', 9) +
          pad(String(b.voices), 4) +
          '*'.repeat(bars),
        b.peakDb > -1 ? 3 : 1,
      );
    }
    this.cursor++;

    this.line(
      pad('CUE', 18) + pad('BUS', 9) + pad('DIST', 8) + pad('LVL', 9) + pad('LP', 9) + pad('OCC', 6) + 'PAN',
      0,
    );
    for (const v of s.rows.slice(0, 20)) {
      this.line(
        pad(`${v.id}/${v.variation}`, 18) +
          pad(v.bus, 9) +
          pad(n(v.distance) + 'M', 8) +
          pad(n(v.levelDb) + 'DB', 9) +
          pad(n(v.lowpassHz / 1000, 1) + 'K', 9) +
          pad(n(v.occlusion, 2), 6) +
          n(v.pan, 2),
        v.occlusion > 0.5 ? 2 : 1,
      );
    }
    this.cursor++;

    for (const ir of s.irs) {
      this.line(`IR ${pad(ir.name, 14)} RT60 ${n(ir.rt60, 2)}S ${ir.active ? '[ACTIVE]' : ''}`, ir.active ? 4 : 0);
    }

    if (s.lastGunLabel) {
      this.cursor++;
      this.line(`LAST SHOT: ${s.lastGunLabel}`, 2);
      // Waveform envelope as an ASCII column chart — enough to see the transient,
      // the body and the tail, which is the whole point of layering a gunshot.
      const env = s.lastGunWaveform;
      const w = Math.min(COLS - 4, env.length);
      const H = 6;
      for (let y = 0; y < H; y++) {
        let row = '';
        const threshold = 1 - (y + 0.5) / H;
        for (let x = 0; x < w; x++) {
          const i = Math.floor((x / w) * env.length);
          row += (env[i] ?? 0) >= threshold ? '*' : ' ';
        }
        this.write(this.cursor + y, 2, row, 2);
      }
      this.cursor += H;
    }
  }

  /** The graph is the only thing that knows the backbuffer size; it tells us here. */
  resize(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
  }

  execute(_ctx: FrameCtx, graph: RenderGraph): void {
    this.compose(this.snapshot());
    this.textTex.needsUpdate = true;

    const w = this.viewW;
    const h = this.viewH;
    // Cell size derived from height so the overlay keeps a constant row count
    // at any resolution rather than shrinking to illegibility at 4K.
    const cell = Math.max(2, Math.floor(h / (ROWS * GLYPH_H)));

    graph.fullscreen(
      'audio.debug',
      FRAGMENT,
      {
        uText: { value: this.textTex },
        uFont: { value: this.fontTex },
        uGrid: { value: new THREE.Vector2(COLS, ROWS) },
        uCell: { value: new THREE.Vector2(cell * GLYPH_W, cell * GLYPH_H) },
        uResolution: { value: new THREE.Vector2(w, h) },
        uGlyphCount: { value: this.glyphIndex.size },
      },
      null,
      { blend: 'alpha' },
    );
  }

  dispose(): void {
    this.textTex.dispose();
    this.fontTex.dispose();
  }
}
