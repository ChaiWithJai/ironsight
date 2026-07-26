/**
 * WATER's three render passes.
 *
 * OWNER: WATER. RCORE owns the ORDERING of pass 14; this file owns its CONTENT.
 *
 * `SceneColorCopy` is declared by RCORE alongside `SceneColor` and BLITTED HERE,
 * at `subOrder: -10`. Water cannot read the target it is drawing into, so the
 * refraction source has to be a copy taken immediately before the draw — and the
 * failure when it is missing does not look like a missing copy, it looks like a
 * TAA bug, which is why the ownership is spelled out in the architecture and
 * repeated here.
 *
 * These passes are registered ONLY when RCORE's forward pipeline is actually
 * live (see `system.ts`). The day-0 `RenderGraph` falls back to a straight
 * forward render of the scene when NO pass is registered, and a lane that
 * registers one pass into an otherwise empty graph turns every other lane's shot
 * black. Water draws through the fallback in that case; the water layer is in it.
 */
import * as THREE from 'three';
import {
  PassOrder,
  RTFormat,
  RenderLayer,
  type FrameCtx,
  type GpuUniform,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
  RTId,
} from '@/engine/types';
import { UNDERWATER_FRAGMENT } from '@/world/water/glsl';

/** Pass 14, subOrder −10: the refraction source. */
export class SceneColorCopyPass implements RenderPass {
  readonly id = 'water.sceneColorCopy';
  readonly order = PassOrder.ForwardWater;
  readonly subOrder = -10;
  readonly reads = [RTId.SceneColor];
  readonly writes = [RTId.SceneColorCopy];
  readonly budgetMs = 0.08;

  enabled(): boolean {
    return true;
  }

  setup(graph: RenderGraph, quality: Readonly<QualitySettings>): void {
    // Idempotent when RCORE already declared it identically; if RCORE declared it
    // differently, RCORE's desc wins and this throws — which is the correct
    // outcome, because the two lanes would otherwise disagree about a format at
    // runtime instead of at boot.
    try {
      graph.declare({ id: RTId.SceneColorCopy, format: quality.hdrFormat, scale: 1, depthBuffer: false });
    } catch {
      // Already declared by RCORE with its own desc. Nothing to do.
    }
  }

  execute(_ctx: FrameCtx, graph: RenderGraph): void {
    graph.blit(graph.texture(RTId.SceneColor), graph.target(RTId.SceneColorCopy));
  }
}

/**
 * Pass 14: the sea itself.
 *
 * MRT, because Gerstner displacement genuinely moves the surface and this is the
 * only forward pass that writes velocity. One draw with two attachments, never
 * two draws — drawing twice costs the vertex work twice and lets the colour and
 * the velocity disagree about where the surface was.
 */
export class ForwardWaterPass implements RenderPass {
  readonly id = 'water.forward';
  readonly order = PassOrder.ForwardWater;
  readonly subOrder = 0;
  readonly reads: readonly (RTId | string)[];
  readonly writes: readonly (RTId | string)[];
  readonly budgetMs = 0.55;

  constructor(
    private readonly useVelocity: boolean,
    reads: readonly (RTId | string)[],
    private readonly onResize: (width: number, height: number) => void,
  ) {
    this.reads = reads;
    this.writes = useVelocity ? [RTId.SceneColor, RTId.GVelocity] : [RTId.SceneColor];
  }

  enabled(): boolean {
    return true;
  }

  resize(width: number, height: number): void {
    this.onResize(width, height);
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const dest = this.useVelocity
      ? graph.mrtTarget([RTId.SceneColor, RTId.GVelocity])
      : graph.target(RTId.SceneColor);
    graph.drawLayer(ctx, RenderLayer.Water, dest);
  }
}

/**
 * Pass at `PassOrder.Underwater` (745): absorption, murk and surface-relief
 * distortion on the RESOLVED HDR image, so it is exposed, bloomed and tonemapped
 * like the rest of the frame rather than painted on after the grade. After the
 * TAA resolve because the distortion would otherwise fight the history.
 *
 * It costs nothing when the eye is dry: the pass returns before it binds
 * anything.
 */
export class UnderwaterPass implements RenderPass {
  readonly id = 'water.underwater';
  readonly order = PassOrder.Underwater;
  readonly reads = [RTId.ResolvedColor, RTId.SceneDepth];
  readonly writes = [RTId.ResolvedColor];
  readonly budgetMs = 0.12;

  private static readonly SCRATCH = 'water.underwaterScratch';

  private readonly uWaterUnderColor: GpuUniform<THREE.Texture | null> = { value: null };
  private readonly uWaterUnderDepth: GpuUniform<THREE.Texture | null> = { value: null };
  private readonly uWaterUnderPlanes: GpuUniform<THREE.Vector2> = { value: new THREE.Vector2(0.1, 1200) };
  private readonly uWaterUnderTint: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3() };
  private readonly uWaterUnderTime: GpuUniform<number> = { value: 0 };
  private readonly uWaterEyeDepth: GpuUniform<number> = { value: 0 };
  private readonly uWaterMurk: GpuUniform<number> = { value: 1 };

  constructor(private readonly state: () => { submerged: boolean; eyeDepth: number; tint: THREE.Vector3; murk: number }) {}

  enabled(): boolean {
    return true;
  }

  setup(graph: RenderGraph, quality: Readonly<QualitySettings>): void {
    graph.declare({ id: UnderwaterPass.SCRATCH, format: quality.hdrFormat, scale: 1, depthBuffer: false });
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const s = this.state();
    if (!s.submerged) return;
    const scratch = graph.target(UnderwaterPass.SCRATCH);
    graph.blit(graph.texture(RTId.ResolvedColor), scratch);

    this.uWaterUnderColor.value = scratch.texture;
    this.uWaterUnderDepth.value = graph.texture(RTId.SceneDepth);
    this.uWaterUnderPlanes.value.set(ctx.camera.near, ctx.camera.far);
    this.uWaterUnderTint.value.copy(s.tint);
    this.uWaterUnderTime.value = ctx.time;
    this.uWaterEyeDepth.value = s.eyeDepth;
    this.uWaterMurk.value = s.murk;

    graph.fullscreen(
      'water.underwater',
      UNDERWATER_FRAGMENT,
      {
        uWaterUnderColor: this.uWaterUnderColor as GpuUniform,
        uWaterUnderDepth: this.uWaterUnderDepth as GpuUniform,
        uWaterUnderPlanes: this.uWaterUnderPlanes as GpuUniform,
        uWaterUnderTint: this.uWaterUnderTint as GpuUniform,
        uWaterUnderTime: this.uWaterUnderTime as GpuUniform,
        uWaterEyeDepth: this.uWaterEyeDepth as GpuUniform,
        uWaterMurk: this.uWaterMurk as GpuUniform,
      },
      graph.target(RTId.ResolvedColor),
      {
        prelude: /* glsl */ `
          uniform sampler2D uWaterUnderColor;
          uniform sampler2D uWaterUnderDepth;
          uniform vec2 uWaterUnderPlanes;
          uniform vec3 uWaterUnderTint;
          uniform float uWaterUnderTime;
          uniform float uWaterEyeDepth;
          uniform float uWaterMurk;
        `,
      },
    );
  }
}
