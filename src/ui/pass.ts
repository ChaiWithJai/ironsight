/**
 * The HUD render pass. OWNER: HUD. `PassOrder.Hud` (pass 27).
 *
 * Runs AFTER `Tonemap` and `LensFx` and before `Present`, at NATIVE canvas
 * resolution rather than `renderScale`, and composites over the finished image
 * with a lane-owned scene and a lane-owned camera via `RenderGraph.drawScene` —
 * the only sanctioned way to render an orthographic screen-space overlay
 * (`types.ts` §12).
 *
 * IT DRAWS INTO `post.ldr` WHEN THAT EXISTS AND INTO THE DEFAULT FRAMEBUFFER
 * OTHERWISE. RCORE's post chain lands in parallel with this lane; `graph.has()`
 * is the documented degrade path and the difference matters twice — a
 * `Present` pass would blit over a HUD drawn to the back buffer, and an
 * `RGBA8_SRGB` target encodes on write so the shader has to hand it linear.
 *
 * §9 of the HUD spec gives the draw order as a z-layer table. There is no depth
 * buffer and no sort here: the composition function calls the widgets in that
 * order and emission order IS z-order.
 */
import * as THREE from 'three';
import {
  PassOrder,
  RTId,
  RenderLayer,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
  type Services,
} from '@/engine/types';
import type { HudContext } from './context';
import { drawCompass, drawTicketBar, drawCaptureRow, drawNotices } from './widgets/top';
import { drawKillfeed } from './widgets/killfeed';
import { drawMinimap, drawSquadList } from './widgets/left';
import { drawAbilityRail, drawGadgetTiles, drawStowedRow, drawThrowableRow, drawWeaponCard } from './widgets/loadout';
import {
  drawBleedout,
  drawBlood,
  drawCrosshair,
  drawDamageDirection,
  drawDamageNumbers,
  drawHitmarker,
  drawKillCluster,
  drawPrompt,
  drawSpotPins,
  drawSpotted,
  drawXpToast,
} from './widgets/combat';
import { drawGadgetMarkers, drawNameplates, drawObjectiveMarkers } from './widgets/world';
import { drawDeployScreen, drawScoreboard } from './screens';
import type { HudRenderer } from './renderer';

export const HUD_PASS_ID = 'ui.hud';

/**
 * Compose one frame. The call order below IS `docs/HUD_SPEC.md` §3's z-order
 * table, read top to bottom:
 *
 *    0/10 minimap surface + contents
 *    20   world-space markers            (UNDER the screen-space clusters)
 *    30   panel scrims  ─┐ interleaved per widget, because each panel's scrim
 *    40   screen HUD    ─┘ and content belong to the same element
 *    50   crosshair
 *    60   transient feedback
 *    70   alert layer
 *    80   prompts + chips
 *    90   full-screen states
 */
export function composeHud(ctx: HudContext): void {
  const root = ctx.state.root;

  if (root === 'spawnmenu') {
    // Live HUD hidden except the ticket bar and the capture row (§10.11).
    drawDeployScreen(ctx);
    drawTicketBar(ctx);
    drawCaptureRow(ctx);
    return;
  }

  drawMinimap(ctx);
  drawSquadList(ctx);

  drawObjectiveMarkers(ctx);
  drawNameplates(ctx);
  drawGadgetMarkers(ctx);
  drawSpotPins(ctx);

  drawCompass(ctx);
  drawTicketBar(ctx);
  drawCaptureRow(ctx);
  drawNotices(ctx);
  drawKillfeed(ctx);

  if (root !== 'dead') {
    drawWeaponCard(ctx);
    drawStowedRow(ctx);
    drawGadgetTiles(ctx);
    drawThrowableRow(ctx);
    drawAbilityRail(ctx);
    drawCrosshair(ctx);
    drawSpotted(ctx);
  }

  drawHitmarker(ctx);
  drawDamageNumbers(ctx);
  drawKillCluster(ctx);
  drawXpToast(ctx);

  drawDamageDirection(ctx);
  drawBleedout(ctx);
  drawBlood(ctx);

  drawPrompt(ctx);

  if (root === 'scoreboard') drawScoreboard(ctx);
}

export class HudPass implements RenderPass {
  readonly id = HUD_PASS_ID;
  readonly order = PassOrder.Hud;
  readonly subOrder = 0;
  readonly reads: readonly string[] = [];
  readonly writes: readonly string[] = [];
  readonly budgetMs = 0.15;

  constructor(
    private readonly services: Services,
    private readonly renderer: HudRenderer,
    private readonly build: (ctx: FrameCtx, width: number, height: number) => HudContext | null,
  ) {}

  enabled(_quality: Readonly<QualitySettings>): boolean {
    // A pure function of quality, per the contract. Visibility is a per-frame
    // decision and is taken inside `execute` instead — a pass that flickers on
    // anything but the tier breaks `validate()`'s guarantee.
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    // Day-0 path: while this is the ONLY registered pass the graph's fallback
    // forward render never runs, so the HUD would composite over an uncleared
    // buffer. Draw the world ourselves in that window — a HUD must never be the
    // reason a frame is blank, and a HUD over a live frame is also the proof
    // that the layout is reacting to a running game.
    if (graph.passes.length <= 1) {
      const camera = ctx.camera.world;
      const mask = camera.layers.mask;
      camera.layers.enableAll();
      camera.layers.disable(RenderLayer.Viewmodel as number);
      graph.drawScene(ctx, this.services.scene.root, camera, null, true);
      camera.layers.mask = mask;
      // The viewmodel is deliberately NOT drawn here. It needs its own depth
      // range and therefore a depth clear between the two draws, and `drawScene`
      // owns clear control — asking it to clear would wipe the world we just
      // rendered. RCORE's `viewmodel` pass does it properly; this branch stops
      // existing the moment any other pass is registered.
    }

    const width = graph.nativeWidth;
    const height = graph.nativeHeight;
    const hud = this.build(ctx, width, height);
    if (!hud) return;

    this.renderer.batch.reset();
    composeHud(hud);

    const dest = graph.has(RTId.LdrColor) ? graph.target(RTId.LdrColor) : null;
    const srgbTarget = dest !== null && (dest.texture as THREE.Texture).colorSpace === THREE.SRGBColorSpace;
    const scene = this.renderer.upload(width, height, srgbTarget);
    if (!scene) return;
    graph.drawScene(ctx, scene, this.camera, dest, false);
  }

  private readonly camera = new THREE.Camera();

  dispose(): void {
    this.renderer.dispose();
  }
}
