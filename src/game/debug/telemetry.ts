/**
 * GAME — the locomotion / conquest telemetry panel.
 *
 * OWNER: GAME.
 *
 * WHY THIS EXISTS. Half of what this lane ships is invisible in a still frame.
 * A sprint and a walk are the same picture; a slide is a picture of the ground;
 * a contested flag with the tickets bleeding is, until HUD lands, no picture at
 * all. So GAME draws its own numbers over its own shots: mode, speed, stamina,
 * stance blend, eye height, landing dip, view roll, the traversal in flight, and
 * the live Conquest state with a capture bar per point and the killfeed.
 *
 * WHY IT IS A QUAD IN THE WORLD AND NOT A RENDER PASS. `RenderGraph.execute`
 * falls back to a straight forward render of the whole scene *only while no pass
 * is registered* — which is the state of the repo today. A debug pass would
 * therefore be the FIRST pass, the fallback would stop running, and every other
 * lane's shot would go black behind my overlay. A camera-attached quad in the
 * scene draws correctly on both paths and can never do that.
 *
 * It is opt-in: nothing is built and nothing is drawn until a GAME scenario arms
 * it, so no other lane's capture can ever pick it up.
 */
import * as THREE from 'three';
import {
  Btn,
  CaptureState,
  MatchPhase,
  MoveMode,
  RenderLayer,
  SceneGroup,
  Stance,
  SurfaceId,
  Team,
  type FrameCtx,
  type MaterialFactory,
  type SceneGraph,
  type Services,
} from '@/engine/types';
import { GLYPHS, GLYPH_H, GLYPH_ORDER, GLYPH_W } from '@/game/debug/font';
import type { GameActor } from '@/game/locomotion';
import { CONQUEST } from '@/game/tuning';

/** Character cells. 78×22 fits the locomotion block, three flags and a killfeed. */
const COLS = 78;
const ROWS = 22;

/**
 * Cell size in texels, glyph plus gutter. The glyphs are a full 6×7 with no
 * built-in bearing — every capital fills all seven scanlines — so without a
 * gutter the descender of one row touches the ascender of the next and the whole
 * panel turns into a hedge. One column and two rows of air is the minimum that
 * reads as text.
 */
const CELL_W = 7;
const CELL_H = 9;

/** Palette slots, matched to `paletteOf` in the fragment shader. */
export const enum Ink {
  Label = 0,
  Value = 1,
  Warn = 2,
  Alert = 3,
  Spatial = 4,
  Friendly = 5,
  Hostile = 6,
}

const VERTEX = /* glsl */ `
out vec2 vTexUv;
void main() {
  vTexUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vTexUv;
uniform sampler2D uText;
uniform sampler2D uFont;
uniform vec2 uGrid;
uniform vec2 uGlyphFrac;
uniform float uGlyphCount;
out vec4 outColor;

vec3 paletteOf(float idx) {
  // Deliberately terminal-flavoured and deliberately NOT graded: this is drawn
  // untonemapped so its contrast is the same in a blown-out golden-hour frame
  // as it is in shadow.
  if (idx < 0.5) return vec3(0.54, 0.61, 0.67);
  if (idx < 1.5) return vec3(0.94, 0.96, 0.98);
  if (idx < 2.5) return vec3(0.97, 0.72, 0.30);
  if (idx < 3.5) return vec3(0.93, 0.34, 0.27);
  if (idx < 4.5) return vec3(0.39, 0.82, 0.91);
  if (idx < 5.5) return vec3(0.42, 0.86, 0.55);
  return vec3(0.98, 0.46, 0.40);
}

void main() {
  // Row 0 of the text texture is the TOP row on screen.
  vec2 cellF = vec2(vTexUv.x * uGrid.x, (1.0 - vTexUv.y) * uGrid.y);
  vec2 cell = floor(cellF);
  vec2 inCell = fract(cellF);
  vec4 t = texture(uText, (cell + 0.5) / uGrid);
  float glyph = floor(t.r * 255.0 + 0.5);
  // Scrim behind every cell, so the panel reads over sky, water or sandstone.
  if (glyph < 0.5) { outColor = vec4(0.02, 0.03, 0.04, 0.55); return; }
  // The gutter: the glyph occupies only uGlyphFrac of the cell, the rest is air.
  vec2 g = inCell / uGlyphFrac;
  if (g.x > 1.0 || g.y > 1.0) { outColor = vec4(0.02, 0.03, 0.04, 0.55); return; }
  // g.y already runs top-to-bottom, and a DataTexture is uploaded with flipY
  // off, so row 0 of the glyph IS v = 0. Inverting here (the reflex) puts every
  // letter upside down.
  vec2 fontUv = vec2((glyph + g.x) / uGlyphCount, g.y);
  float on = texture(uFont, fontUv).r;
  vec3 rgb = paletteOf(floor(t.g * 255.0 + 0.5));
  outColor = vec4(mix(vec3(0.02, 0.03, 0.04), rgb, on), max(on, 0.55));
}
`;

/**
 * A text grid with a cursor, and the quad that shows it.
 *
 * The quad is re-posed from `CameraState` every frame rather than parented to
 * the camera object: `CameraRig` owns the camera transform and nothing else may
 * put a child on it (architecture §4.2), and re-posing costs one matrix compose.
 */
export class TelemetryPanel {
  private readonly glyphIndex = new Map<string, number>();
  private readonly textData: Uint8Array;
  private readonly textTex: THREE.DataTexture;
  private readonly fontTex: THREE.DataTexture;
  private mesh: THREE.Mesh | null = null;
  private cursor = 0;
  private visible = false;

  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(
    private readonly scene: SceneGraph,
    private readonly materials: MaterialFactory,
  ) {
    const chars = GLYPH_ORDER;
    chars.forEach((c, i) => this.glyphIndex.set(c, i));

    // Font atlas: one row of glyphs, GLYPH_W texels each. Nearest-filtered, so
    // a cell that lands on a fractional texel stays a crisp block rather than a
    // grey smear — the whole reason to use a bitmap here.
    const fw = chars.length * GLYPH_W;
    const font = new Uint8Array(fw * GLYPH_H);
    chars.forEach((c, gi) => {
      const rows = GLYPHS[c] ?? [];
      for (let y = 0; y < GLYPH_H; y++) {
        const bits = rows[y] ?? 0;
        for (let x = 0; x < GLYPH_W; x++) {
          font[y * fw + gi * GLYPH_W + x] = (bits >> (GLYPH_W - 1 - x)) & 1 ? 255 : 0;
        }
      }
    });
    this.fontTex = new THREE.DataTexture(font, fw, GLYPH_H, THREE.RedFormat);
    this.fontTex.minFilter = THREE.NearestFilter;
    this.fontTex.magFilter = THREE.NearestFilter;
    this.fontTex.needsUpdate = true;

    this.textData = new Uint8Array(COLS * ROWS * 4);
    this.textTex = new THREE.DataTexture(this.textData, COLS, ROWS, THREE.RGBAFormat);
    this.textTex.minFilter = THREE.NearestFilter;
    this.textTex.magFilter = THREE.NearestFilter;
    this.textTex.needsUpdate = true;
  }

  /* ------------------------------------------------------------ text buffer */

  clear(): void {
    this.textData.fill(0);
    this.cursor = 0;
  }

  write(row: number, col: number, text: string, ink: Ink = Ink.Value): void {
    if (row < 0 || row >= ROWS) return;
    const upper = text.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const c = col + i;
      if (c < 0 || c >= COLS) continue;
      const o = (row * COLS + c) * 4;
      this.textData[o] = this.glyphIndex.get(upper[i] ?? ' ') ?? 0;
      this.textData[o + 1] = ink;
      this.textData[o + 3] = 255;
    }
  }

  line(text: string, ink: Ink = Ink.Value): void {
    this.write(this.cursor++, 1, text, ink);
  }

  blank(): void {
    this.cursor++;
  }

  /* ------------------------------------------------------------------ quad */

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.ensureMesh();
    if (this.mesh) this.mesh.visible = visible;
  }

  private ensureMesh(): void {
    if (this.mesh) return;
    const material = this.materials.createUnlit({
      id: 'game.telemetry',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uText: { value: this.textTex },
        uFont: { value: this.fontTex },
        uGrid: { value: new THREE.Vector2(COLS, ROWS) },
        uGlyphFrac: { value: new THREE.Vector2(GLYPH_W / CELL_W, GLYPH_H / CELL_H) },
        uGlyphCount: { value: this.glyphIndex.size },
      },
      transparent: true,
      blending: 'alpha',
      // Always on top of the world: this is instrumentation, not a decal, and a
      // readout that a lamp post can hide is a readout you cannot trust.
      depthTest: false,
      depthWrite: false,
      side: 'double',
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.name = 'game.telemetry';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 10_000;
    this.scene.group(SceneGroup.Props).add(mesh);
    // No bounds: camera-attached geometry must never be sector- or frustum-culled.
    this.scene.addDynamic(mesh, RenderLayer.TransparentPostTaa);
    this.mesh = mesh;
  }

  /**
   * Re-pose the quad into the bottom-left of the view and upload the grid.
   *
   * The panel is placed at a fixed distance and sized from the CURRENT fov and
   * aspect, so it occupies the same fraction of the frame at any FOV — an
   * overlay that grows when the player aims down sights is unreadable exactly
   * when the shot is most interesting.
   */
  update(ctx: FrameCtx): void {
    if (!this.visible || !this.mesh) return;
    this.textTex.needsUpdate = true;

    const camera = ctx.camera;
    const distance = 0.42; // well inside WORLD_NEAR..1 m, never clipped
    const viewH = 2 * distance * Math.tan((camera.fovDeg * Math.PI) / 360);
    const viewW = viewH * camera.aspect;

    // 56% of the frame width; the cell grid's own aspect then fixes the height,
    // so glyphs stay square whatever the canvas is. Wider reads more easily but
    // starts to be the shot rather than annotate it — at 1080p this is a 6 px
    // cell, which is the floor for a nearest-filtered 6×7 bitmap.
    const width = viewW * 0.56;
    const height = (width / (COLS * CELL_W)) * (ROWS * CELL_H);

    this.tmpQuat.copy(camera.rotation as THREE.Quaternion);
    this.forward.set(0, 0, -1).applyQuaternion(this.tmpQuat);
    this.right.set(1, 0, 0).applyQuaternion(this.tmpQuat);
    this.up.set(0, 1, 0).applyQuaternion(this.tmpQuat);

    // TOP-left, not bottom-left. The moves these shots exist to show — the slide
    // drop, the parapet going under the eye on a vault — all happen in the LOWER
    // half of a first-person frame, which is exactly where a bottom-anchored
    // readout would sit on top of them.
    const margin = viewH * 0.03;
    const left = -viewW * 0.5 + margin + width * 0.5;
    const top = viewH * 0.5 - margin - height * 0.5;

    this.tmpPos
      .copy(camera.position as THREE.Vector3)
      .addScaledVector(this.forward, distance)
      .addScaledVector(this.right, left)
      .addScaledVector(this.up, top);
    this.tmpScale.set(width, height, 1);
    this.mesh.matrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
    this.mesh.matrixWorld.copy(this.mesh.matrix);
    this.mesh.matrixWorldNeedsUpdate = false;
  }

  dispose(): void {
    this.textTex.dispose();
    this.fontTex.dispose();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
  }
}

/** Fixed-width column helper. Right-pads, and truncates rather than wrapping. */
function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

/** Fixed-width right-aligned number. */
function num(value: number, decimals = 2, width = 0): string {
  const s = Number.isFinite(value) ? value.toFixed(decimals) : '--';
  return width > 0 ? ' '.repeat(Math.max(0, width - s.length)) + s : s;
}

/**
 * A capture bar drawn from the signed −1…+1 progress, centred on neutral.
 * Left half fills toward Insurgent, right half toward Coalition, so the shape
 * of the bar alone says which way the flag is going and by how much — which a
 * single 0..1 fraction cannot.
 */
function captureBar(progress: number, cells = 20): string {
  const half = Math.floor(cells / 2);
  const filled = Math.min(half, Math.round(Math.abs(progress) * half));
  const left = progress < 0 ? '#'.repeat(filled) : '';
  const right = progress > 0 ? '#'.repeat(filled) : '';
  return '[' + ' '.repeat(half - left.length) + left + '|' + right + ' '.repeat(half - right.length) + ']';
}

const MOVE_NAMES: Readonly<Record<number, string>> = {
  [MoveMode.Idle]: 'IDLE',
  [MoveMode.Walk]: 'WALK',
  [MoveMode.Sprint]: 'SPRINT',
  [MoveMode.TacticalSprint]: 'TAC-SPRINT',
  [MoveMode.Crouch]: 'CROUCH',
  [MoveMode.Prone]: 'PRONE',
  [MoveMode.Air]: 'AIR',
  [MoveMode.Slide]: 'SLIDE',
  [MoveMode.Vault]: 'VAULT',
  [MoveMode.Mantle]: 'MANTLE',
  [MoveMode.Downed]: 'DOWNED',
  [MoveMode.Dead]: 'DEAD',
};

const STANCE_NAMES: Readonly<Record<number, string>> = {
  [Stance.Stand]: 'STAND',
  [Stance.Crouch]: 'CROUCH',
  [Stance.Prone]: 'PRONE',
};

const TEAM_NAMES: Readonly<Record<number, string>> = {
  [Team.Coalition]: 'COALITION',
  [Team.Insurgent]: 'INSURGENT',
  [Team.Neutral]: 'NEUTRAL',
};

const CAPTURE_NAMES: Readonly<Record<number, string>> = {
  [CaptureState.Neutral]: 'NEUTRAL',
  [CaptureState.OwnedCoalition]: 'HELD-COA',
  [CaptureState.OwnedInsurgent]: 'HELD-INS',
  [CaptureState.Contested]: 'CONTESTED',
  [CaptureState.CapturingCoalition]: 'CAP-COA',
  [CaptureState.CapturingInsurgent]: 'CAP-INS',
};

/** The buttons worth naming in a readout. Order is the order they are shown. */
const BUTTON_NAMES: readonly (readonly [number, string])[] = [
  [Btn.Fire, 'FIRE'],
  [Btn.Ads, 'ADS'],
  [Btn.Sprint, 'SPRINT'],
  [Btn.Crouch, 'CROUCH'],
  [Btn.Prone, 'PRONE'],
  [Btn.Jump, 'JUMP'],
  [Btn.LeanLeft, 'LEAN-L'],
  [Btn.LeanRight, 'LEAN-R'],
];

/** Everything the panel reads, so it never has to reach into the service. */
export interface TelemetryView {
  readonly label: string;
  readonly elapsedSeconds: number;
  readonly actor: GameActor;
  readonly actorCount: number;
  readonly services: Services;
  /** Newest first. Fed from the FxBus by whoever owns the panel. */
  readonly killfeed: readonly string[];
}

/**
 * Lay the whole panel out. Rebuilt from scratch every frame: the grid is 6 KB
 * and a diffing scheme would be a cache to keep coherent for no measurable win.
 */
export function composeTelemetry(panel: TelemetryPanel, view: TelemetryView): void {
  const a = view.actor;
  const s = a.state;
  panel.clear();

  panel.line(
    `IRONSIGHT GAME  SCENARIO ${pad(view.label.toUpperCase(), 10)} T+${num(view.elapsedSeconds, 2)}S  ` +
      `ACTORS ${view.actorCount}`,
    Ink.Warn,
  );
  panel.blank();

  const mode = MOVE_NAMES[s.move ?? MoveMode.Idle] ?? '?';
  const airborne = !s.grounded;
  panel.line(
    pad(`MODE ${mode}`, 24) +
      pad(`STANCE ${STANCE_NAMES[s.stance] ?? '?'}`, 20) +
      (airborne ? 'AIRBORNE' : 'GROUNDED'),
    airborne ? Ink.Spatial : Ink.Value,
  );
  panel.line(
    pad(`SPEED ${num(s.groundSpeed, 2)} M/S`, 24) +
      pad(`VERT ${num(a.velocity.y, 2)}`, 20) +
      `STAMINA ${num(s.stamina, 2)}`,
    s.stamina < 0.2 ? Ink.Alert : Ink.Value,
  );
  panel.line(
    pad(`EYE ${num(s.eyeHeight, 3)} M`, 24) +
      pad(`DIP ${num(a.landDip.value, 3)}`, 20) +
      `ROLL ${num((s.viewRoll ?? 0) * (180 / Math.PI), 2)} DEG`,
  );
  panel.line(
    pad(`CAPSULE ${num(a.capsuleHeight, 2)} M`, 24) +
      pad(`BLEND ${num(a.stanceBlend, 2)}`, 20) +
      `LEAN ${num(s.lean, 2)}`,
  );
  panel.line(
    pad(`SLIDE ${a.slideTimer > 0 ? num(a.slideTimer, 2) + 'S' : '-'}`, 24) +
      pad(`TRAVERSE ${a.traverse ? MOVE_NAMES[a.traverse.kind] + ' ' + num(a.traverse.t, 2) : '-'}`, 20) +
      `AIR ${num(a.airTime, 2)}S`,
    a.traverse || a.slideTimer > 0 ? Ink.Spatial : Ink.Label,
  );
  panel.line(
    pad(`POS ${num(s.position.x, 1)} ${num(s.position.y, 1)} ${num(s.position.z, 1)}`, 24) +
      pad(`YAW ${num((s.yaw * 180) / Math.PI, 0)}`, 20) +
      `SURFACE ${SurfaceId[a.groundSurface] ?? '?'}`,
    Ink.Label,
  );

  const held = BUTTON_NAMES.filter(([bit]) => (a.intent.buttons & bit) !== 0).map(([, name]) => name);
  panel.line(
    pad(`INTENT F ${num(a.intent.moveZ, 2)} R ${num(a.intent.moveX, 2)}`, 24) +
      pad(`HP ${num(s.health, 0)}`, 20) +
      `HELD ${held.length ? held.join(' ') : '-'}`,
    Ink.Label,
  );
  panel.blank();

  /* ------------------------------------------------------------- conquest */

  const match = view.services.mode.state;
  const tickets = match.tickets;
  panel.line(
    pad('FLAG', 9) + pad('OWNER', 11) + pad('STATE', 11) + pad('CAPTURE', 30) + 'OCCUPANTS',
    Ink.Label,
  );
  for (const point of match.points) {
    const ink =
      point.state === CaptureState.Contested
        ? Ink.Warn
        : point.owner === Team.Coalition
          ? Ink.Friendly
          : point.owner === Team.Insurgent
            ? Ink.Hostile
            : Ink.Value;
    panel.line(
      pad(point.id, 9) +
        pad(TEAM_NAMES[point.owner] ?? '?', 11) +
        pad(CAPTURE_NAMES[point.state] ?? '?', 11) +
        pad(`${captureBar(point.progress)} ${num(point.progress, 2, 5)}`, 30) +
        `${point.occupants[Team.Coalition]} V ${point.occupants[Team.Insurgent]}`,
      ink,
    );
  }
  const score = match.localScore;

  // Held-point margin, and therefore the bleed, recomputed here rather than
  // exposed on `MatchState`: it is one line of arithmetic over data the contract
  // already publishes, and a derived field on a contract is a field that can go
  // stale.
  let coalitionPoints = 0;
  let insurgentPoints = 0;
  for (const p of match.points) {
    if (p.owner === Team.Coalition) coalitionPoints++;
    else if (p.owner === Team.Insurgent) insurgentPoints++;
  }
  const margin = Math.abs(coalitionPoints - insurgentPoints);
  const losing = coalitionPoints === insurgentPoints ? null : coalitionPoints > insurgentPoints ? 'INS' : 'COA';
  const bleed = CONQUEST.bleedByMargin[Math.min(margin, CONQUEST.bleedByMargin.length - 1)] ?? 0;

  panel.line(
    pad(`TICKETS COA ${num(tickets[Team.Coalition], 0, 4)}`, 24) +
      pad(`INS ${num(tickets[Team.Insurgent], 0, 4)}`, 20) +
      `OF ${match.ticketsMax}  CLOCK ${num(match.timeRemaining, 0)}S`,
    Ink.Value,
  );
  panel.line(
    pad(`FLAGS COA ${coalitionPoints} INS ${insurgentPoints}`, 24) +
      pad(`MARGIN ${margin}`, 20) +
      (losing === null ? 'BLEED NONE - EVEN SPLIT' : `BLEED ${num(bleed, 1)}/S VS ${losing}`),
    losing === null ? Ink.Label : Ink.Warn,
  );
  panel.line(
    pad(`PHASE ${MatchPhase[match.phase] ?? '?'}`, 24) +
      pad(`YOU ${TEAM_NAMES[match.localTeam] ?? '?'}`, 20) +
      `K ${score.kills} D ${score.deaths} A ${score.assists} CAP ${score.captures} SCORE ${score.score}`,
    Ink.Label,
  );

  if (view.killfeed.length > 0) {
    panel.blank();
    for (const entry of view.killfeed.slice(0, 3)) panel.line(`KILLFEED  ${entry}`, Ink.Hostile);
  }
}
