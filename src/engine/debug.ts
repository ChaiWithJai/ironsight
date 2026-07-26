/**
 * DebugService: world gizmos plus the frame overlay. CORE owns this file.
 *
 * The OVERLAY is DOM, not in-canvas, and that is deliberate: `tools/capture.mjs`
 * screenshots the canvas element only, so a DOM overlay is structurally
 * incapable of contaminating a shot even if someone forgets to hide it. (The
 * game HUD is the opposite case and must be in-canvas — see `src/ui/`.)
 *
 * It also deliberately uses inline SVG rather than a second `<canvas>` for the
 * frame-time graph: the capture tool grabs `document.querySelector('canvas')`,
 * and a second canvas anywhere in the document is a coin flip away from
 * screenshotting the debug graph instead of the game.
 *
 * The GIZMOS are in-canvas (they have to be — they are world-space) and live in
 * `SceneGroup.Debug`, which the driver hides for the duration of every capture.
 */
import * as THREE from 'three';
import {
  RenderStage,
  SceneGroup,
  type DebugService,
  type FrameCtx,
  type QualityService,
  type RenderSystem,
  type SceneGraph,
  type Vec3,
} from '@/engine/types';
import { tierName } from '@/engine/quality';
import type { EngineServiceRegistry } from '@/engine/services';
import type { FrameLoop } from '@/engine/loop';

/** Frames of history in the graph. 180 at 60 fps is a three-second window. */
const HISTORY = 180;
const GRAPH_W = 260;
const GRAPH_H = 46;
/** Graph ceiling in ms. 33.3 = two frames at 60 Hz; anything above is a stall. */
const GRAPH_MAX_MS = 33.3;

interface Gizmo {
  positions: number[];
  colour: number;
  expiresAtTick: number;
}

export class EngineDebugService implements DebugService, RenderSystem {
  readonly name = 'core.debug';
  readonly stage = RenderStage.Presentation;
  readonly order = 900;

  enabled = false;

  private readonly root = new THREE.Group();
  private readonly lineGeometry = new THREE.BufferGeometry();
  private readonly linePositions = new Float32Array(4096 * 3);
  private readonly lineColours = new Float32Array(4096 * 3);
  private readonly gizmos: Gizmo[] = [];
  private readonly texts = new Map<string, string>();

  private overlay: HTMLDivElement | null = null;
  private statsEl: HTMLDivElement | null = null;
  private graphPath: SVGPolylineElement | null = null;
  private readonly history = new Float32Array(HISTORY);
  private historyIndex = 0;
  private detach: (() => void) | null = null;

  constructor(
    private readonly scene: SceneGraph,
    private readonly quality: QualityService,
    private readonly registry: EngineServiceRegistry,
    private readonly loop: FrameLoop,
  ) {
    this.root.name = 'debug.gizmos';
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true, toneMapped: false });
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.lineGeometry.setAttribute('color', new THREE.BufferAttribute(this.lineColours, 3));
    this.lineGeometry.setDrawRange(0, 0);
    const lines = new THREE.LineSegments(this.lineGeometry, material);
    lines.frustumCulled = false;
    this.root.add(lines);
    scene.group(SceneGroup.Debug).add(this.root);
  }

  /* -------------------------------------------------------------- gizmo API */

  line(from: Vec3, to: Vec3, colour: number, ttlSeconds = 0): void {
    if (!this.enabled) return;
    this.push([from.x, from.y, from.z, to.x, to.y, to.z], colour, ttlSeconds);
  }

  sphere(centre: Vec3, radius: number, colour: number, ttlSeconds = 0): void {
    if (!this.enabled) return;
    const pts: number[] = [];
    const SEGMENTS = 16;
    // Three great circles: enough to read as a sphere, cheap enough to spam.
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < SEGMENTS; i++) {
        const a0 = (i / SEGMENTS) * Math.PI * 2;
        const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
        const p = (a: number): [number, number, number] => {
          const c = Math.cos(a) * radius;
          const s = Math.sin(a) * radius;
          if (axis === 0) return [centre.x + c, centre.y + s, centre.z];
          if (axis === 1) return [centre.x + c, centre.y, centre.z + s];
          return [centre.x, centre.y + c, centre.z + s];
        };
        pts.push(...p(a0), ...p(a1));
      }
    }
    this.push(pts, colour, ttlSeconds);
  }

  box(min: Vec3, max: Vec3, colour: number, ttlSeconds = 0): void {
    if (!this.enabled) return;
    const c: [number, number, number][] = [
      [min.x, min.y, min.z], [max.x, min.y, min.z], [max.x, min.y, max.z], [min.x, min.y, max.z],
      [min.x, max.y, min.z], [max.x, max.y, min.z], [max.x, max.y, max.z], [min.x, max.y, max.z],
    ];
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const pts: number[] = [];
    for (const i of edges) pts.push(...c[i]);
    this.push(pts, colour, ttlSeconds);
  }

  text(key: string, value: string | number): void {
    this.texts.set(key, String(value));
  }

  private push(positions: number[], colour: number, ttlSeconds: number): void {
    this.gizmos.push({ positions, colour, expiresAtTick: ttlSeconds });
  }

  /* ------------------------------------------------------------- the overlay */

  attach(host: HTMLElement): void {
    const overlay = document.createElement('div');
    overlay.id = 'ironsight-debug';
    overlay.style.cssText = [
      'position:fixed', 'top:10px', 'left:10px', 'z-index:20', 'pointer-events:none',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#cfe4ef', 'background:rgba(6,10,14,0.74)', 'border:1px solid rgba(120,170,200,0.28)',
      'border-radius:3px', 'padding:8px 10px', 'min-width:270px',
      'text-shadow:0 1px 2px rgba(0,0,0,0.9)', 'display:none',
    ].join(';');

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', String(GRAPH_W));
    svg.setAttribute('height', String(GRAPH_H));
    svg.setAttribute('viewBox', `0 0 ${GRAPH_W} ${GRAPH_H}`);
    svg.style.cssText = 'display:block;margin-bottom:6px;background:rgba(0,0,0,0.35)';
    // 16.6 ms budget line — the only number on the graph that matters.
    const budget = document.createElementNS(svgNs, 'line');
    const budgetY = GRAPH_H - (16.6 / GRAPH_MAX_MS) * GRAPH_H;
    budget.setAttribute('x1', '0');
    budget.setAttribute('x2', String(GRAPH_W));
    budget.setAttribute('y1', String(budgetY));
    budget.setAttribute('y2', String(budgetY));
    budget.setAttribute('stroke', '#e0a44a');
    budget.setAttribute('stroke-dasharray', '3 3');
    budget.setAttribute('stroke-width', '1');
    svg.appendChild(budget);
    const path = document.createElementNS(svgNs, 'polyline');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#7fd4a0');
    path.setAttribute('stroke-width', '1');
    svg.appendChild(path);
    overlay.appendChild(svg);

    const stats = document.createElement('div');
    overlay.appendChild(stats);
    host.appendChild(overlay);

    this.overlay = overlay;
    this.statsEl = stats;
    this.graphPath = path;

    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'F1' && e.code !== 'Backquote') return;
      e.preventDefault();
      this.setEnabled(!this.enabled);
    };
    window.addEventListener('keydown', onKey);
    this.detach = () => window.removeEventListener('keydown', onKey);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.overlay) this.overlay.style.display = enabled ? 'block' : 'none';
    this.root.visible = enabled;
    this.scene.group(SceneGroup.Debug).visible = enabled;
  }

  dispose(): void {
    this.detach?.();
    this.overlay?.remove();
  }

  /* ------------------------------------------------------------------ update */

  update(ctx: FrameCtx): void {
    // Never draw during a capture, whatever the toggle says. A debug gizmo in a
    // review PNG wastes a critic's attention and an overlay in one is worse.
    if (ctx.deterministic) {
      this.root.visible = false;
      if (this.overlay) this.overlay.style.display = 'none';
      this.gizmos.length = 0;
      this.lineGeometry.setDrawRange(0, 0);
      return;
    }

    this.history[this.historyIndex] = ctx.dt * 1000;
    this.historyIndex = (this.historyIndex + 1) % HISTORY;

    if (!this.enabled) {
      this.gizmos.length = 0;
      this.lineGeometry.setDrawRange(0, 0);
      return;
    }

    this.root.visible = true;
    this.uploadGizmos();
    this.updateOverlay(ctx);
    // Gizmos are immediate-mode: whatever was submitted this frame is what is
    // drawn, and it is cleared afterwards. TTLs are honoured by the submitter
    // re-submitting; a retained list would need per-gizmo identity nobody has.
    this.gizmos.length = 0;
  }

  private uploadGizmos(): void {
    let vertex = 0;
    const maxVertices = this.linePositions.length / 3;
    for (const g of this.gizmos) {
      const count = g.positions.length / 3;
      if (vertex + count > maxVertices) break;
      const r = ((g.colour >> 16) & 0xff) / 255;
      const gg = ((g.colour >> 8) & 0xff) / 255;
      const b = (g.colour & 0xff) / 255;
      for (let i = 0; i < count; i++) {
        this.linePositions[(vertex + i) * 3] = g.positions[i * 3];
        this.linePositions[(vertex + i) * 3 + 1] = g.positions[i * 3 + 1];
        this.linePositions[(vertex + i) * 3 + 2] = g.positions[i * 3 + 2];
        this.lineColours[(vertex + i) * 3] = r;
        this.lineColours[(vertex + i) * 3 + 1] = gg;
        this.lineColours[(vertex + i) * 3 + 2] = b;
      }
      vertex += count;
    }
    (this.lineGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.lineGeometry.setDrawRange(0, vertex);
  }

  private updateOverlay(ctx: FrameCtx): void {
    if (this.graphPath) {
      const pts: string[] = [];
      for (let i = 0; i < HISTORY; i++) {
        const v = this.history[(this.historyIndex + i) % HISTORY];
        const x = (i / (HISTORY - 1)) * GRAPH_W;
        const y = GRAPH_H - Math.min(1, v / GRAPH_MAX_MS) * GRAPH_H;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      this.graphPath.setAttribute('points', pts.join(' '));
    }
    if (!this.statsEl) return;

    const stats = ctx.profiler.frame;
    const budgets = ctx.quality.budgets;
    const sceneStats = this.scene.stats;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const heapMb = mem ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(0) : '—';
    const violations = ctx.profiler.checkBudgets();

    const rows: string[] = [
      row('frame', `${stats.cpuMs.toFixed(2)} ms cpu · ${ctx.services.clock.fpsEma.toFixed(0)} fps`),
      row('gpu', stats.gpuMs > 0 ? `${stats.gpuMs.toFixed(2)} ms` : 'no timer query'),
      row('draws', `${stats.drawCalls} / ${budgets.drawCalls}`, stats.drawCalls > budgets.drawCalls),
      row('tris', `${(stats.triangles / 1000).toFixed(0)}k / ${(budgets.triangles / 1000).toFixed(0)}k`, stats.triangles > budgets.triangles),
      row('programs', `${stats.programs} / ${budgets.shaderPrograms}`, stats.programs > budgets.shaderPrograms),
      row('heap', `${heapMb} MB`),
      row('tier', `${tierName(ctx.quality.tier)} · scale ${this.quality.renderScale.toFixed(2)} · ${ctx.quality.aa}`),
      row('cull', `${sceneStats.visible} vis · ${sceneStats.culledFrustum} frustum · ${sceneStats.culledOcclusion} occl`),
      row('sim', `tick ${ctx.services.clock.tick} · ${this.loop.lastTicks} tick/frame · a=${ctx.alpha.toFixed(2)}`),
      row('nulls', `${this.registry.nullKeys().length} services still null`),
    ];
    for (const [k, v] of this.texts) rows.push(row(k, v));
    if (violations.length > 0) {
      rows.push(`<div style="margin-top:5px;color:#ff8a6a">${violations.join('<br>')}</div>`);
    }
    this.statsEl.innerHTML = rows.join('');
  }
}

function row(label: string, value: string, bad = false): string {
  const colour = bad ? '#ff8a6a' : '#cfe4ef';
  return `<div><span style="display:inline-block;width:64px;color:#7f97a6">${label}</span><span style="color:${colour}">${value}</span></div>`;
}

export function createDebugService(
  scene: SceneGraph,
  quality: QualityService,
  registry: EngineServiceRegistry,
  loop: FrameLoop,
): EngineDebugService {
  return new EngineDebugService(scene, quality, registry, loop);
}
