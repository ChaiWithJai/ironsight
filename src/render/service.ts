/**
 * RenderService — the renderer-facing facade a lane uses when it is not
 * registering a pass, plus the submit system and the resize path.
 *
 * OWNER: RCORE.
 *
 * The resize path is the non-obvious part. There are THREE resolutions in play
 * and confusing them is the classic soft-HUD bug:
 *   - the CSS size of the canvas (what the user sees, what Playwright grabs);
 *   - the internal render resolution (canvas × renderScale), which everything
 *     in the graph before `post.tonemap` runs at;
 *   - native canvas resolution, which the HUD pass alone runs at, because
 *     scaling text is instantly visible in a way that scaling a lit surface
 *     is not.
 */
import * as THREE from 'three';
import {
  RenderStage,
  type AssetRegistry,
  type BootContext,
  type FrameCtx,
  type FrameStats,
  type Profiler,
  type QualitySettings,
  type QualityService,
  type RenderGraph,
  type RenderService,
  type RenderSystem,
} from '@/engine/types';
import type { IronRenderGraph } from '@/render/graph';
import type { IronCameraRig } from '@/render/camera-rig';

export class IronRenderService implements RenderService {
  readonly overlays = { viewmodel: true, hud: true };
  private environmentDirty = true;
  private lastEnvironmentReason = 'boot';

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    readonly graph: IronRenderGraph,
    readonly camera: IronCameraRig,
    private readonly quality: QualityService,
    private readonly profiler: Profiler,
  ) {}

  requestEnvironmentRebake(reason: string): void {
    this.environmentDirty = true;
    this.lastEnvironmentReason = reason;
  }

  /** LIGHT/SKY consume this once per frame and clear it. */
  consumeEnvironmentRebake(): string | null {
    if (!this.environmentDirty) return null;
    this.environmentDirty = false;
    return this.lastEnvironmentReason;
  }

  get stats(): Readonly<FrameStats> {
    return this.profiler.frame;
  }

  /**
   * Resize to the canvas' CSS box.
   *
   * TWO RESOLUTIONS, AND THE DIFFERENCE MATTERS. The DRAWING BUFFER stays at
   * native (capped) resolution; `renderScale` shrinks the graph's INTERNAL
   * targets only, and `post.tonemap` / `present` resolve one to the other. That
   * is what lets pass 27 draw the HUD at native pixels on every tier — a HUD
   * rendered at 0.70× and upscaled is the exact tell the rule exists to prevent
   * — while dynamic resolution still buys back the expensive pixels.
   */
  resize(cssWidth: number, cssHeight: number): void {
    const q = this.quality.settings;
    // Never render more pixels than the tier's base resolution asks for: a 4K
    // monitor on the Low tier should get 720p upscaled, not 4K at 12 fps.
    const capW = Math.min(cssWidth, q.baseWidth);
    const capH = Math.min(cssHeight, q.baseHeight);
    const scale = this.quality.renderScale;
    const w = Math.max(1, Math.round(capW * scale));
    const h = Math.max(1, Math.round(capH * scale));

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(capW, capH, false);
    this.graph.setSize(w, h, capW, capH);
    this.camera.setAspect(cssWidth, cssHeight);
    this.camera.renderWidth = w;
    this.camera.renderHeight = h;
  }
}

/**
 * Watches the canvas' CSS box and the live render scale, and resizes when
 * either changes. Polling once per frame rather than listening for `resize`
 * covers every case that fires no event — a devtools dock, a CSS layout change,
 * the dynamic-resolution governor stepping the scale — with one integer compare.
 */
export class ResizeSystem implements RenderSystem {
  readonly name = 'render.resize';
  readonly stage = RenderStage.Camera;
  readonly order = -100;

  private lastWidth = -1;
  private lastHeight = -1;
  private lastScale = -1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly service: IronRenderService,
    private readonly quality: QualityService,
  ) {}

  update(_ctx: FrameCtx): void {
    const width = this.canvas.clientWidth || this.canvas.width;
    const height = this.canvas.clientHeight || this.canvas.height;
    const scale = this.quality.renderScale;
    if (width === this.lastWidth && height === this.lastHeight && scale === this.lastScale) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.lastScale = scale;
    this.service.resize(width, height);
  }
}

/**
 * `RenderGraph.execute()` — the last thing that happens in a frame. Registered
 * at `RenderStage.Submit` so a lane can be sure that anything it does at
 * `RenderStage.Scene` or earlier is visible this frame.
 */
export class SubmitSystem implements RenderSystem {
  readonly name = 'render.submit';
  readonly stage = RenderStage.Submit;
  readonly order = 1000;

  constructor(private readonly graph: RenderGraph) {}

  update(ctx: FrameCtx): void {
    ctx.services.materials.updateGlobals(ctx);
    this.graph.execute(ctx);
  }
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * RCORE: replace the BODY of this file, keep this signature and this path.
 */
export function createRenderService(ctx: BootContext): RenderService {
  // The narrowing happens HERE and nowhere else, so `src/bootstrap/subsystems.ts`
  // — which is frozen on day 0 — only ever deals in contract interfaces and
  // cannot break when RCORE renames a class.
  const { canvas, quality } = ctx;
  const service = new IronRenderService(
    ctx.renderer,
    ctx.services.graph as IronRenderGraph,
    ctx.services.camera as IronCameraRig,
    quality,
    ctx.services.profiler,
  );
  ctx.addRender(new ResizeSystem(canvas, service, quality));
  ctx.addRender(new SubmitSystem(ctx.services.graph));
  service.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
  return service;
}

/** Present/upscale LUTs would be declared here. */
export function registerRendererBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Nothing.
}

/**
 * Harness reset chain. The overlay flags are set per shot by
 * `ShotContext.setOverlays`, but the environment-rebake latch is not — leave it
 * DIRTY so the first frame of a capture rebuilds the probe from the shot's own
 * sun angle rather than the previous shot's.
 */
export function resetRenderer(_seed: number): void {
  // The null service holds no other transient state.
}
