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
  RenderLayer,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
  type Services,
} from '@/engine/types';
import type { AudioSnapshot } from '../snapshot';

export const AUDIO_DEBUG_PASS_ID = 'audio.debug.overlay';

/**
 * Columns x rows of the text grid, and the CELL the 6x7 glyph is drawn inside.
 *
 * The cell is deliberately larger than the glyph: 6x7 capitals with no leading
 * makes every row touch the one below it, which turns a dense table into an
 * unreadable smear at review-sheet scale. One column of right pad and one row
 * top and bottom is the minimum that separates them.
 *
 * 40 rows x 9 cell-rows = 360, which divides 1080 exactly three times, so at
 * 1080p a character is 21x27 px and the grid is 1890x1080 — an integer scale
 * with no resampling, which for a 1-px bitmap font is the difference between
 * crisp and mush.
 */
const COLS = 90;
const ROWS = 40;
const GLYPH_W = 6;
const GLYPH_H = 7;
const CELL_W = 7;
const CELL_H = 9;

/**
 * Bottom of the gunshot envelope chart's dB axis. 54 dB spans a rifle cue from
 * its pressure front down into its baked room tail.
 */
const FLOOR_DB = 54;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Text grid colour slots. Must match `paletteOf` in the shader prelude. */
const DIM = 0;
const VAL = 1;
const WARN = 2;
const ALERT = 3;
const SPATIAL = 4;

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

/**
 * Whole GLSL3 shaders, because this pass composites through
 * `MaterialFactory.createUnlit` + `RenderGraph.drawScene(clear=false)` rather
 * than through `RenderGraph.fullscreen`.
 *
 * WHY NOT `fullscreen`: it renders with the renderer's own `autoClear` still
 * true, so a fullscreen draw into the DEFAULT framebuffer clears whatever was
 * already there. That is correct for a post pass writing into a render target
 * and fatal for an overlay that must composite over the finished frame — the
 * scene would be wiped every frame and the readout would float over black.
 * `drawScene` is the primitive that takes `clear` as an argument.
 */
const VERTEX = /* glsl */ `
  // Fraction of the viewport the grid occupies, so the quad can be sized to an
  // EXACT integer number of screen pixels per font pixel. A 1-px bitmap font
  // resampled at 3.05x duplicates a column every twentieth character and reads
  // as a wobble; at exactly 3x it is crisp. The remainder of the frame is left
  // showing the live scene, which is also the proof the engine was running.
  uniform vec2 uSpan;
  out vec2 vUv;
  void main() {
    // The quad is authored in clip space; there is no camera transform.
    vec2 uv01 = position.xy * 0.5 + 0.5;
    vUv = uv01;
    gl_Position = vec4(
      -1.0 + uv01.x * uSpan.x * 2.0,
       1.0 - (1.0 - uv01.y) * uSpan.y * 2.0,
      0.0,
      1.0
    );
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  // One texel per character cell: r = glyph index + 1, g = colour index.
  uniform sampler2D uText;
  uniform sampler2D uFont;
  uniform vec2 uGrid;
  uniform float uGlyphCount;
  out vec4 outColor;

  vec3 paletteOf(float idx){
    // Terminal palette: dim label, bright value, amber warn, red alert, cyan for
    // anything spatial. Chosen to stay legible over a bright golden-hour frame.
    if (idx < 0.5) return vec3(0.56, 0.63, 0.70);
    if (idx < 1.5) return vec3(0.94, 0.96, 0.99);
    if (idx < 2.5) return vec3(0.99, 0.74, 0.29);
    if (idx < 3.5) return vec3(0.98, 0.36, 0.27);
    return vec3(0.36, 0.86, 0.96);
  }

  void main(){
    // vUv is bottom-up; the text grid is top-down.
    vec2 cellF = vec2(vUv.x, 1.0 - vUv.y) * uGrid;
    vec2 cell = floor(cellF);
    vec2 inCell = fract(cellF);

    // Scrim under the whole panel so the readout survives a blown-out sky behind
    // it; a debug view whose legibility depends on the scene is not a debug view.
    const vec3 back = vec3(0.012, 0.018, 0.024);
    const float scrim = 0.80;

    float code = floor(texture(uText, (cell + 0.5) / uGrid).r * 255.0 + 0.5);
    if (code < 0.5) { outColor = vec4(back, scrim); return; }

    // Glyph coordinates inside the padded cell. CELL is wider and taller than
    // GLYPH, and everything outside the glyph rectangle is inter-line leading.
    vec2 g = inCell * vec2(float(CELL_W), float(CELL_H)) - vec2(0.0, 1.0);
    if (g.x >= float(GLYPH_W) || g.y < 0.0 || g.y >= float(GLYPH_H)) {
      outColor = vec4(back, scrim);
      return;
    }

    // The atlas is a single row of glyphs. Index 0 is reserved as the
    // empty-cell sentinel above, so the stored code is index + 1.
    float glyph = code - 1.0;
    vec2 fontUv = vec2(
      (glyph + clamp(g.x / float(GLYPH_W), 0.01, 0.99)) / uGlyphCount,
      clamp(g.y / float(GLYPH_H), 0.01, 0.99)
    );
    float on = texture(uFont, fontUv).r;
    vec3 rgb = paletteOf(floor(texture(uText, (cell + 0.5) / uGrid).g * 255.0 + 0.5));
    outColor = vec4(mix(back, rgb, on), max(on, scrim));
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

  /** Private scene the overlay quad lives in. Built on first execute. */
  private quadScene: THREE.Scene | null = null;
  private readonly quadCamera = new THREE.Camera();
  /** Live uniform cell — see `uSpan` in the vertex shader. */
  private readonly span = new THREE.Vector2(1, 1);

  constructor(
    private readonly services: Services,
    private readonly snapshot: () => AudioSnapshot,
  ) {
    const chars = Object.keys(FONT);
    // +1: code 0 in the text buffer means "empty cell", so glyph 0 must not be
    // reachable. `Object.keys` hoists the integer-like keys '0'..'9' to the
    // front of the array, so without the bias the digit zero — the single most
    // common character in a numeric readout — would render as blank.
    chars.forEach((c, i) => this.glyphIndex.set(c, i + 1));

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
    // One byte per texel and an arbitrary glyph count, so the row stride is not
    // a multiple of 4. Without this the atlas shears one pixel per row.
    this.fontTex.unpackAlignment = 1;

    this.textData = new Uint8Array(COLS * ROWS * 4);
    this.textTex = new THREE.DataTexture(this.textData, COLS, ROWS, THREE.RGBAFormat);
    this.textTex.minFilter = THREE.NearestFilter;
    this.textTex.magFilter = THREE.NearestFilter;
    this.textTex.needsUpdate = true;
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
      // Unmapped characters fall back to code 0 (blank), which is the right
      // failure mode for a debug view: a hole, not a wrong glyph.
      const gi = this.glyphIndex.get(upper[i]!) ?? 0;
      const o = (row * COLS + c) * 4;
      this.textData[o] = gi;
      this.textData[o + 1] = colour;
      this.textData[o + 3] = 255;
    }
  }

  private line(text: string, colour = VAL): void {
    this.write(this.cursor++, 1, text, colour);
  }

  private rule(): void {
    this.write(this.cursor++, 1, '-'.repeat(COLS - 2), DIM);
  }

  /** dB → a 0..width bar over a -60…0 dB scale. */
  private static meter(db: number, width: number): string {
    const bars = Math.max(0, Math.min(width, Math.round(((db + 60) / 60) * width)));
    return '*'.repeat(bars) + '.'.repeat(width - bars);
  }

  private compose(s: AudioSnapshot): void {
    this.clear();
    const n = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '--');
    const pad = (v: string, w: number): string => (v.length >= w ? v.slice(0, w) : v + ' '.repeat(w - v.length));
    const rpad = (v: string, w: number): string => (v.length >= w ? v.slice(0, w) : ' '.repeat(w - v.length) + v);

    this.line(
      `IRONSIGHT AUDIO MIXER   CTX ${s.contextState} ${s.unlocked ? 'UNLOCKED' : 'LOCKED'}   ` +
        `${n(s.sampleRate / 1000, 1)}KHZ   T+${n(s.modelTime, 2)}S`,
      WARN,
    );
    this.rule();
    this.line(
      `VOICES ${rpad(String(s.voicesLive), 3)}/${s.voicesMax}  STEALS ${rpad(String(s.steals), 4)}  ` +
        `REJECT ${rpad(String(s.rejections), 4)}  PCM ${n(s.bufferBytes / 1048576, 2)}MB  ` +
        `CUES ${s.bakedCues} IN ${s.bakedVariations} TAKES`,
      s.rejections > 0 ? ALERT : VAL,
    );
    this.line(
      `DUCK ${rpad(n(s.duckDb) + 'DB', 7)}  DEAF ${n(s.deafness, 2)}  ` +
        `ENV ${pad(s.envName, 10)}ENCLOSE ${n(s.envEnclosure, 2)}  RT ${n(s.envReverbSeconds, 2)}S  ` +
        `WET ${n(s.envWetDb)}DB  XFADE ${n(s.envBlend, 2)}`,
      s.duckDb < -0.5 ? WARN : SPATIAL,
    );
    this.line(
      `LISTENER ${n(s.listener.x)} ${n(s.listener.y)} ${n(s.listener.z)}  YAW ${n(s.listener.yawDeg, 0)}DEG  ` +
        `OCCLUSION VIA ${s.occlusionSource}`,
      SPATIAL,
    );
    this.cursor++;

    this.line(
      pad('BUS', 10) + rpad('LEVEL', 9) + rpad('PEAK', 9) + rpad('GAIN', 8) + rpad('VOX', 5) + '  -60DB' + ' '.repeat(18) + '0',
      DIM,
    );
    for (const b of s.buses) {
      this.line(
        pad(b.name, 10) +
          rpad(n(b.levelDb) + 'DB', 9) +
          rpad(n(b.peakDb) + 'DB', 9) +
          rpad(n(b.gainDb) + 'DB', 8) +
          rpad(String(b.voices), 5) +
          '  ' +
          AudioDebugPass.meter(b.levelDb, 24),
        // Anything peaking above -1 dBFS on a bus is a mix defect, not a colour
        // choice: flag it red so a reviewer does not have to read the number.
        b.peakDb > -1 ? ALERT : b.name === 'master' ? VAL : DIM,
      );
    }
    this.cursor++;

    this.line(
      // 18, because `w.carbine.fire#0` is exactly 16 and would butt against the
      // bus column with no separator.
      pad('CUE', 18) +
        pad('BUS', 8) +
        rpad('DIST', 7) +
        rpad('LVL', 8) +
        rpad('LPF', 7) +
        rpad('OCC', 5) +
        rpad('PAN', 6) +
        rpad('DELAY', 7) +
        rpad('PROG', 5) +
        '   EMITTER XYZ',
      DIM,
    );
    const VOICE_ROWS = 11;
    for (const v of s.rows.slice(0, VOICE_ROWS)) {
      // Cyan = still in flight (the propagation delay has not elapsed), amber =
      // audibly occluded, white = sounding in the clear. Three states a reviewer
      // can check by eye before reading a single number.
      const colour = v.pending > 0.001 ? SPATIAL : v.occlusion > 0.35 ? WARN : VAL;
      this.line(
        pad(`${v.id}#${v.variation}`, 18) +
          pad(v.bus, 8) +
          // A head-locked cue has no distance and no emitter; saying so beats
          // printing 0.0M and letting a reviewer wonder what went wrong.
          rpad(!v.spatial ? 'DIFF' : v.loop ? 'LOOP' : n(v.distance) + 'M', 7) +
          rpad(n(v.levelDb) + 'DB', 8) +
          rpad(n(v.lowpassHz / 1000, 1) + 'K', 7) +
          rpad(n(v.occlusion, 2), 5) +
          rpad(n(v.pan, 2), 6) +
          rpad(n(v.delay * 1000, 0) + 'MS', 7) +
          rpad(n(v.progress * 100, 0) + '%', 5) +
          (v.spatial ? `   ${n(v.x, 0)} ${n(v.y, 0)} ${n(v.z, 0)}` : '   HEAD LOCKED'),
        colour,
      );
    }
    if (s.rows.length > VOICE_ROWS) {
      this.line(`+ ${s.rows.length - VOICE_ROWS} MORE LIVE VOICES BELOW THE FOLD`, DIM);
    } else if (s.rows.length === 0) {
      this.line('NO LIVE VOICES', ALERT);
    } else {
      this.cursor++;
    }

    // IRs on the left, acoustic blockers on the right — both answer "why does
    // this sound like this", so they belong side by side.
    const panelTop = this.cursor;
    this.write(panelTop, 1, pad('CONVOLUTION IR', 12) + rpad('RT60', 7) + '  TAIL ENVELOPE', DIM);
    let r = panelTop + 1;
    for (const ir of s.irs) {
      const env = ir.envelope;
      let spark = '';
      // 20-column peak sparkline of the tail. A room whose energy dies in the
      // first two columns is not a room, and that is visible here at a glance.
      for (let i = 0; i < 20; i++) {
        const a = env[Math.floor((i / 20) * env.length)] ?? 0;
        spark += a > 0.5 ? '*' : a > 0.18 ? '+' : a > 0.04 ? '-' : '.';
      }
      this.write(
        r++,
        1,
        pad(ir.active ? `>${ir.name}` : ` ${ir.name}`, 12) + rpad(n(ir.rt60, 2) + 'S', 7) + '  ' + spark,
        ir.active ? SPATIAL : DIM,
      );
    }

    // The analytic blockers are only CONSULTED when physics is not ready. Once
    // PHYS is live the occlusion column comes from real raycasts and these boxes
    // are inert — say so, because a panel that looks authoritative while being
    // ignored is worse than no panel.
    const blockersLive = !s.occlusionSource.startsWith('PHYS');
    const bx = 44;
    this.write(
      panelTop,
      bx,
      pad(blockersLive ? 'ACOUSTIC BLOCKER' : 'BLOCKER (INERT)', 20) + rpad('OPACITY', 9) + '  SPAN',
      DIM,
    );
    let br = panelTop + 1;
    for (const b of s.blockers.slice(0, 7)) {
      this.write(
        br++,
        bx,
        pad(b.label, 20) +
          rpad(n(b.opacity, 2), 9) +
          `  ${n(b.max.x - b.min.x, 0)}X${n(b.max.y - b.min.y, 0)}X${n(b.max.z - b.min.z, 0)}M`,
        !blockersLive ? DIM : b.opacity > 0.7 ? WARN : VAL,
      );
    }
    if (s.blockers.length === 0) this.write(br++, bx, 'NONE REGISTERED', DIM);
    this.cursor = Math.max(r, br) + 1;

    this.line(`LAST GUNSHOT CUE  ${s.lastGunLabel}  ENVELOPE 0 TO -${FLOOR_DB}DB`, WARN);
    // Envelope as a column chart, on a dB axis and NOT a linear one. A layered
    // gunshot's transient sits ~20 dB above its body, so on a linear scale the
    // body, the mechanical action and the baked room tail all collapse into the
    // bottom row and the chart proves only that there is an attack. On a 54 dB
    // axis the four layers are four distinct features, which is the thing this
    // panel exists to let a reviewer check.
    const env = s.lastGunWaveform;
    const w = Math.min(COLS - 4, env.length);
    const H = Math.max(3, ROWS - this.cursor);
    for (let y = 0; y < H; y++) {
      let row = '';
      const threshold = 1 - (y + 0.5) / H;
      for (let x = 0; x < w; x++) {
        const a = env[Math.floor((x / w) * env.length)] ?? 0;
        const norm = a <= 0 ? 0 : clamp01(1 + (20 * Math.log10(a)) / FLOOR_DB);
        row += norm >= threshold ? '*' : ' ';
      }
      this.write(this.cursor + y, 2, row, WARN);
    }
    this.cursor += H;
  }

  /**
   * The overlay quad. `MaterialFactory.createUnlit` is the only sanctioned way
   * to author a raw shader outside `src/render/` — CI fails the build on
   * `new THREE.ShaderMaterial` in a lane — and it is not available until the
   * factory exists, so the quad is built on first execute rather than in the
   * constructor.
   */
  private ensureQuad(): THREE.Scene {
    if (this.quadScene) return this.quadScene;
    const material = this.services.materials.createUnlit({
      id: AUDIO_DEBUG_PASS_ID,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uText: { value: this.textTex },
        uFont: { value: this.fontTex },
        uGrid: { value: new THREE.Vector2(COLS, ROWS) },
        uGlyphCount: { value: this.glyphIndex.size },
        uSpan: { value: this.span },
      },
      defines: { GLYPH_W, GLYPH_H, CELL_W, CELL_H },
      transparent: true,
      blending: 'alpha',
      depthTest: false,
      depthWrite: false,
      // Drawn after the tonemap, so it must NOT get three's tonemap/output
      // transform or the palette stops being the literal values authored here.
      toneMapped: false,
    });
    // A clip-space quad, so the vertex shader needs no camera at all.
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1000;
    const scene = new THREE.Scene();
    scene.add(mesh);
    this.quadScene = scene;
    return scene;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    // The graph short-circuits to a straight forward render only while NO pass
    // is registered, so arming this one would otherwise leave the overlay
    // floating over an uncleared buffer until RCORE's post chain lands. Draw the
    // world ourselves in that window: a debug overlay must never be the reason a
    // frame is blank, and a readout composited over a live frame is also the
    // proof that the engine was running when the numbers were sampled.
    if (graph.passes.length <= 1) {
      const camera = ctx.camera.world;
      const mask = camera.layers.mask;
      camera.layers.enableAll();
      camera.layers.disable(RenderLayer.Viewmodel as number);
      graph.drawScene(ctx, this.services.scene.root, camera, null, true);
      camera.layers.mask = mask;
    }

    this.compose(this.snapshot());
    this.textTex.needsUpdate = true;

    // Integer screen pixels per font pixel, sized off the NATIVE resolution —
    // we composite over the default framebuffer, which ignores renderScale. At
    // 1080p this is exactly 3, giving a 21x27 px character and an 1890x1080
    // grid; at 4K it becomes 6 and the readout stays the same physical size
    // rather than shrinking to illegibility.
    const px = Math.max(1, Math.floor(graph.nativeHeight / (ROWS * CELL_H)));
    this.span.set(
      Math.min(1, (COLS * CELL_W * px) / Math.max(graph.nativeWidth, 1)),
      Math.min(1, (ROWS * CELL_H * px) / Math.max(graph.nativeHeight, 1)),
    );

    graph.drawScene(ctx, this.ensureQuad(), this.quadCamera, null, false);
  }

  dispose(): void {
    this.textTex.dispose();
    this.fontTex.dispose();
    // The material is owned and cached by the factory; the geometry is ours.
    this.quadScene?.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.quadScene = null;
  }
}
