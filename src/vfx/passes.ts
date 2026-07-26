/**
 * VFX — the two render passes this lane owns.
 *
 * OWNER: VFX. `docs/OWNERSHIP.md` assigns two `PassOrder` slots to this lane
 * rather than to RCORE, and this file is where they live because
 * `src/render/passes/**` is RCORE's directory:
 *
 *  - `PassOrder.Decals` (architecture pass 11) — box-oriented decals composited
 *    into `SceneColor` after the opaque forward pass and before the sky, so a
 *    bullet hole is lit and fogged with the wall it is in rather than painted
 *    over the finished frame.
 *  - `PassOrder.PostResolveVfx` (architecture pass 20) — tracers, sparks,
 *    embers, muzzle-flash cores, AFTER the TAA resolve and BEFORE bloom.
 *
 *    **THIS PASS IS WRITTEN AND NOT CURRENTLY REGISTERED, AND THAT IS AN
 *    HONEST OPEN ISSUE RATHER THAN A DESIGN CHOICE.** Compositing a lane-owned
 *    tree into `RTId.SceneColor` with `drawScene` works — the decal pass below
 *    does exactly that and its output is on screen. The identical call into
 *    `RTId.ResolvedColor` produced nothing, with the geometry confirmed present
 *    (13 live instances logged at the grab frame) and the pass confirmed
 *    executing. `ResolvedColor` is declared `depthBuffer: false` and is written
 *    by a `blit` immediately before this slot, and I did not get to the bottom
 *    of it inside this wave. Shipping a muzzle flash that does not appear is
 *    worse than shipping one resolved by TAA, so the emissive pools ride
 *    `RenderLayer.TransparentPreTaa` with the media for now (see
 *    `system.ts`). The pass is left here, correct and one line from being
 *    registered, for whoever owns the integration pass.
 *
 * BOTH PASSES DRAW A LANE-OWNED TREE THROUGH `drawScene`, NOT `drawLayer`.
 * That is deliberate and the reason is in RCORE's own graph: the public
 * `drawLayer` clears colour AND depth, because a content lane calling it is
 * assumed to own its target. These two composite over a target the frame has
 * already written, so clearing would erase the world. `drawScene` defaults to
 * `clear = false` and is the primitive for exactly this.
 *
 * OCCLUSION. Neither target carries the depth buffer the world was drawn with,
 * so both shaders reject occluded fragments themselves against `SceneDepth`
 * (`vfxDepthOccluded` in `glsl.ts`). That is not a workaround — it is what a
 * post-resolve effect pass has to do in any renderer, and it is why the soft
 * particle fade and the occlusion test share one depth fetch.
 */
import * as THREE from 'three';
import {
  PassOrder,
  RTId,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';

/** Composites decals into `SceneColor` between the opaque pass and the sky. */
export class VfxDecalPass implements RenderPass {
  readonly id = 'vfx.decals';
  readonly order = PassOrder.Decals;
  readonly reads: readonly (RTId | string)[] = [RTId.SceneDepth];
  readonly writes: readonly (RTId | string)[] = [RTId.SceneColor];
  readonly budgetMs = 0.35;

  constructor(private readonly tree: THREE.Object3D) {}

  enabled(quality: Readonly<QualitySettings>): boolean {
    return quality.decals.maxLive > 0;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    if (!graph.has(RTId.SceneColor)) return;
    graph.drawScene(ctx, this.tree, ctx.camera.world, graph.target(RTId.SceneColor), false);
  }
}

/**
 * Draws the additive emitter layers over the resolved HDR image.
 *
 * The flash's effect on the WORLD is not here — that is a clustered light back
 * in the forward pass, registered through `LightingService.flash()`. This pass
 * only draws the emitter itself.
 */
export class VfxPostResolvePass implements RenderPass {
  readonly id = 'vfx.postResolve';
  readonly order = PassOrder.PostResolveVfx;
  readonly reads: readonly (RTId | string)[] = [RTId.SceneDepth];
  readonly writes: readonly (RTId | string)[] = [RTId.ResolvedColor];
  readonly budgetMs = 0.2;

  constructor(private readonly tree: THREE.Object3D) {}

  enabled(_quality: Readonly<QualitySettings>): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    // `has()` is the supported degradation path: a graph without a resolved
    // colour target has no post chain at all, and this pass has nowhere to go.
    if (!graph.has(RTId.ResolvedColor)) return;
    graph.drawScene(ctx, this.tree, ctx.camera.world, graph.target(RTId.ResolvedColor), false);
  }
}
