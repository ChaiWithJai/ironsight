/**
 * The frame, assembled. OWNER: RCORE.
 *
 * Registered from `BootContext.afterBoot` — never from a factory body, because
 * `ctx.services.graph` may still be the NULL graph while a factory is running
 * and `addPass` on the null graph succeeds silently, which produces a black shot
 * and no error (`docs/ARCHITECTURE.md` §2.2).
 *
 * The ORDER of the list below is documentation only; `PassOrder` decides what
 * actually runs when, and the correctness ordering of the post chain
 * (TaaResolve < MotionBlur < Exposure < Bloom < DepthOfField < Tonemap < LensFx
 * < Hud < present) is encoded in the enum precisely so that a dozen lanes
 * registering passes in parallel physically cannot get it wrong.
 *
 * Slots deliberately left to other lanes and NOT registered here: `SkyLuts`,
 * `SkyRender` (SKY), `Gtao`, `Ssr`, `Volumetrics` (LIGHT), `Decals`,
 * `PostResolveVfx` (VFX), `ForwardWater`, `Underwater` (WATER), `Hud` (HUD).
 * If none of them ever land the frame still resolves — every one of those is an
 * addition to an image this file already produces end to end.
 */
import type { BootContext } from '@/engine/types';
import type { IronRenderGraph } from '@/render/graph';
import type { IronCameraRig } from '@/render/camera-rig';
import { declareCoreTargets } from '@/render/targets';
import { createPostChainState } from '@/render/passes/chain';
import {
  DepthPrepass,
  ForwardOpaquePass,
  ForwardTransparentPass,
  ViewmodelGBufferPass,
  ViewmodelPass,
} from '@/render/passes/scene';
import { TaaResolvePass, VelocityDilatePass } from '@/render/passes/temporal';
import { MotionBlurPass } from '@/render/passes/motion-blur';
import { ExposurePass } from '@/render/passes/exposure';
import { BloomPass } from '@/render/passes/bloom';
import { DepthOfFieldPass } from '@/render/passes/dof';
import { LensFxPass, PresentPass, TonemapPass } from '@/render/passes/grade';

export function registerCorePasses(ctx: BootContext): void {
  ctx.afterBoot((services) => {
    const graph = services.graph as IronRenderGraph;
    const rig = services.camera as IronCameraRig;
    const state = createPostChainState();

    declareCoreTargets(graph, ctx.quality.settings);

    graph.addPass(new DepthPrepass());
    graph.addPass(new ForwardOpaquePass());
    graph.addPass(new ForwardTransparentPass());
    graph.addPass(new ViewmodelGBufferPass());
    graph.addPass(new ViewmodelPass());
    graph.addPass(new VelocityDilatePass());
    graph.addPass(new TaaResolvePass(state));
    graph.addPass(new MotionBlurPass(state, rig));
    graph.addPass(new ExposurePass(state, rig));
    graph.addPass(new BloomPass(state));
    graph.addPass(new DepthOfFieldPass(state));
    graph.addPass(new TonemapPass(state));
    graph.addPass(new LensFxPass(rig));
    graph.addPass(new PresentPass());
  });
}
