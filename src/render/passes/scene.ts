/**
 * The passes that put geometry on the screen: the MRT depth prepass, forward
 * opaque, forward transparent and the viewmodel. OWNER: RCORE.
 *
 * THE VELOCITY BUFFER IS BORN HERE AND EVERYTHING TEMPORAL EATS IT — TAA, motion
 * blur, and any lane that reprojects. It is computed analytically from the
 * fragment's world position against the previous frame's UNJITTERED
 * view-projection, which is exact for static geometry and for anything three
 * transforms for us (instancing, batching, skinning), because all three go
 * through the same `transformed`/`batchingMatrix`/`instanceMatrix` chain the
 * forward pass uses.
 *
 * WHAT IT DOES NOT COVER, HONESTLY: a vertex the MATERIAL moves in its own
 * shader — wind on a palm frond, a `registerDeform` chunk — is invisible to a
 * scene-wide override material, so its velocity is the static-geometry answer.
 * The fix is a per-material prepass variant carrying the same deform chunk, and
 * that lives in the material factory rather than here. Until then TAA's
 * neighbourhood clamp is what keeps a moving frond from smearing, which is why
 * that clamp is not negotiable either.
 */
import * as THREE from 'three';
import {
  PassOrder,
  RTId,
  RenderLayer,
  SceneGroup,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';
import type { IronRenderGraph } from '@/render/graph';
import { GLSL_OCT, IRON_CLASS_VIEWMODEL, IRON_CLASS_WORLD } from '@/render/fullscreen';

/**
 * Roughness written into `GNormalRough.b`.
 *
 * A scene-wide override material cannot read a per-object roughness — three
 * binds the OVERRIDE's uniforms, not the drawn material's — so the G-buffer
 * carries a constant here. Consumers that only need normals and depth (GTAO,
 * DOF, motion blur, TAA) are unaffected; SSR is the one that wants the real
 * value, and the honest fix is a per-material prepass variant from the factory.
 */
const GBUFFER_FALLBACK_ROUGHNESS = 0.6;

const GBUFFER_VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

uniform mat4 uCurViewProj;
uniform mat4 uPrevViewProj;
uniform mat3 uViewToWorld;

out vec3 vViewPos;
out vec3 vWorldNormal;
out vec4 vCurClip;
out vec4 vPrevClip;

void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  // project_vertex leaves mvPosition in view space and writes gl_Position with
  // whatever projection the camera currently holds — which, during this pass, is
  // the JITTERED one. That is deliberate: the draw must be jittered, the
  // velocity must not.
  #include <project_vertex>

  vec4 world = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    world = batchingMatrix * world;
  #endif
  #ifdef USE_INSTANCING
    world = instanceMatrix * world;
  #endif
  world = modelMatrix * world;

  vViewPos = mvPosition.xyz;
  vWorldNormal = uViewToWorld * transformedNormal;
  vCurClip = uCurViewProj * world;
  vPrevClip = uPrevViewProj * world;
}
`;

const GBUFFER_FRAGMENT = /* glsl */ `
precision highp float;
${GLSL_OCT}

in vec3 vViewPos;
in vec3 vWorldNormal;
in vec4 vCurClip;
in vec4 vPrevClip;

uniform float uSurfaceClass;
uniform float uRoughness;
uniform float uVelocityScale;

layout(location = 0) out vec4 outDepth;
layout(location = 1) out vec4 outNormalRough;
layout(location = 2) out vec4 outVelocity;

void main() {
  vec2 cur = vCurClip.xy / max(vCurClip.w, 1e-5);
  vec2 prev = vPrevClip.xy / max(vPrevClip.w, 1e-5);
  // NDC spans 2 units across the screen, UV spans 1.
  vec2 velocity = (cur - prev) * 0.5 * uVelocityScale;

  outDepth = vec4(max(-vViewPos.z, 1e-4), 0.0, 0.0, 1.0);
  outNormalRough = vec4(ironOctEncode(normalize(vWorldNormal)), uRoughness, uSurfaceClass);
  outVelocity = vec4(velocity, 0.0, 1.0);
}
`;

function createGBufferMaterial(surfaceClass: number, velocityScale: number, depthTest: boolean): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: GBUFFER_VERTEX,
    fragmentShader: GBUFFER_FRAGMENT,
    uniforms: {
      uCurViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uViewToWorld: { value: new THREE.Matrix3() },
      uSurfaceClass: { value: surfaceClass / 255 },
      uRoughness: { value: GBUFFER_FALLBACK_ROUGHNESS },
      uVelocityScale: { value: velocityScale },
    },
  });
  material.depthTest = depthTest;
  material.depthWrite = true;
  material.side = THREE.FrontSide;
  material.name = `iron.gbuffer.${surfaceClass}`;
  return material;
}

const TMP_VIEW_TO_WORLD = new THREE.Matrix3();

function syncCamera(material: THREE.ShaderMaterial, ctx: FrameCtx, viewmodel: boolean): void {
  const camera = viewmodel ? ctx.camera.viewmodel : ctx.camera.world;
  (material.uniforms.uCurViewProj.value as THREE.Matrix4).multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  (material.uniforms.uPrevViewProj.value as THREE.Matrix4).copy(ctx.camera.prevViewProjection as THREE.Matrix4);
  TMP_VIEW_TO_WORLD.setFromMatrix4(camera.matrixWorld);
  (material.uniforms.uViewToWorld.value as THREE.Matrix3).copy(TMP_VIEW_TO_WORLD);
}

/**
 * Pass 5. Writes `SceneDepth` + `GNormalRough` + `GVelocity` in ONE draw through
 * an MRT framebuffer whose depth attachment comes from `SceneDepth`.
 *
 * WHICH LAYERS, AND WHY — this is the seam that decides whether TAA works.
 * `taa.resolve` treats a pixel with NO prepass depth as sky and reprojects it
 * with the analytic camera-rotation formula (`ironSkyVelocity`), which assumes
 * infinite distance. A layer missing from this draw therefore does not merely
 * lose AO: every pixel it covers is reprojected against the wrong parallax and
 * the history shatters. That is what it looked like when `Water` and
 * `Vegetation` were absent — the sea resolved as torn black/white blocks.
 *
 *   • `WorldOpaque`  — always.
 *   • `Water`        — WATER builds its ocean grid with `position.y = 0`
 *     precisely so a foreign override material rasterises the STILL-WATER PLANE
 *     here instead of a 32 km cone. Wave height (≈0.8 m) is the only error, and
 *     `water.forward` overwrites the velocity attachment with real fluid motion
 *     later in the frame anyway.
 *   • `Vegetation` / `Impostor` — VEG ships zero alpha-tested foliage; every
 *     blade, leaflet and impostor is solid geometry, so an override rasterises
 *     it correctly. Per-leaf wind lives in a deform chunk this override does not
 *     carry, so a fluttering tip's depth is its rest-pose depth — centimetres,
 *     and nothing here depth-tests EQUAL. Whole-plant lean rides the instance
 *     matrix, which the override does see.
 *
 * `WorldAlphaTest` stays out, and that exclusion is real: an override cannot
 * sample the drawn material's alpha map, so those layers would write SOLID QUADS
 * into depth and normals and put a black AO blob around every cutout.
 */
export class DepthPrepass implements RenderPass {
  readonly id = 'depth.prepass';
  readonly order = PassOrder.DepthPrepass;
  readonly reads: readonly RTId[] = [];
  readonly writes: readonly RTId[] = [RTId.SceneDepth, RTId.GNormalRough, RTId.GVelocity];
  readonly budgetMs = 0.7;

  private readonly material = createGBufferMaterial(IRON_CLASS_WORLD, 1, true);

  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const g = graph as IronRenderGraph;
    syncCamera(this.material, ctx, false);
    const target = g.mrtTarget([RTId.SceneDepth, RTId.GNormalRough, RTId.GVelocity]);
    g.drawLayers(
      ctx,
      [RenderLayer.WorldOpaque, RenderLayer.Water, RenderLayer.Vegetation, RenderLayer.Impostor],
      target,
      {
        override: this.material,
        clearColor: true,
        clearDepth: true,
        jitter: true,
        hideGroups: [ctx.services.scene.group(SceneGroup.Sky)],
      },
    );
  }

  dispose(): void {
    this.material.dispose();
  }
}

/**
 * Pass 17a. The viewmodel's own G-buffer, through the viewmodel camera, at
 * `subOrder -10` so it lands before the colour draw.
 *
 * Its linear depth is in the SAME metres as the world's, which is what lets
 * depth of field give the weapon its 1.5–3 px near-field CoC (LOOK_SPEC §6.2)
 * without a second depth buffer. Velocity is written as EXACTLY ZERO: the
 * weapon is rigid to the camera, so camera reprojection would claim it is
 * moving whenever the player turns and TAA would smear the sight picture.
 */
export class ViewmodelGBufferPass implements RenderPass {
  readonly id = 'viewmodel.gbuffer';
  readonly order = PassOrder.Viewmodel;
  readonly subOrder = -10;
  readonly reads: readonly RTId[] = [];
  readonly writes: readonly RTId[] = [RTId.SceneDepth, RTId.GNormalRough, RTId.GVelocity];
  readonly budgetMs = 0.1;

  private readonly material = createGBufferMaterial(IRON_CLASS_VIEWMODEL, 0, true);

  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    if (!ctx.services.renderer.overlays.viewmodel) return;
    const g = graph as IronRenderGraph;
    syncCamera(this.material, ctx, true);
    const target = g.mrtTarget([RTId.SceneDepth, RTId.GNormalRough, RTId.GVelocity]);
    // Colour attachments survive; depth is cleared so the weapon depth-sorts
    // against itself and always beats the world, exactly as the colour pass
    // treats it. Nothing reads the prepass depth buffer after this point.
    g.drawLayers(ctx, [RenderLayer.Viewmodel], target, {
      override: this.material,
      clearColor: false,
      clearDepth: true,
      viewmodelCamera: true,
      jitter: true,
    });
  }

  dispose(): void {
    this.material.dispose();
  }
}

/**
 * Pass 10. Opaque world into `SceneColor`, at the jittered projection.
 *
 * The sky dome rides on `WorldOpaque` with `depthWrite` off and a shader that
 * pins it to the far plane, so it composites into the background of the same
 * draw. Aerial perspective is applied IN-SHADER by the material (architecture
 * §4, pass 10) and is deliberately not a screen-space pass here.
 */
export class ForwardOpaquePass implements RenderPass {
  readonly id = 'forward.opaque';
  readonly order = PassOrder.ForwardOpaque;
  readonly reads: readonly RTId[] = [];
  readonly writes: readonly RTId[] = [RTId.SceneColor];
  readonly budgetMs = 4.2;

  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const g = graph as IronRenderGraph;
    g.drawLayers(
      ctx,
      [RenderLayer.WorldOpaque, RenderLayer.WorldAlphaTest, RenderLayer.Vegetation, RenderLayer.Impostor],
      g.target(RTId.SceneColor),
      { clearColor: true, clearDepth: true, jitter: true },
    );
  }
}

/** Pass 16. Sorted transparents that must be resolved by TAA (smoke, dust, heat haze). */
export class ForwardTransparentPass implements RenderPass {
  readonly id = 'forward.transparent';
  readonly order = PassOrder.ForwardTransparent;
  readonly reads: readonly RTId[] = [RTId.SceneColor];
  readonly writes: readonly RTId[] = [RTId.SceneColor];
  readonly budgetMs = 1.0;

  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const g = graph as IronRenderGraph;
    g.drawLayers(ctx, [RenderLayer.TransparentPreTaa], g.target(RTId.SceneColor), { jitter: true });
  }
}

/**
 * Pass 17. The viewmodel, on its own camera (near 0.01 / far 6) with the depth
 * buffer cleared first, so the weapon can never clip a wall and never eats world
 * depth precision. LOOK_SPEC §7.1: it keeps its own narrower FOV, so the
 * receiver reads long and straight instead of violently distorted.
 */
export class ViewmodelPass implements RenderPass {
  readonly id = 'forward.viewmodel';
  readonly order = PassOrder.Viewmodel;
  readonly subOrder = 0;
  readonly reads: readonly RTId[] = [RTId.SceneColor];
  readonly writes: readonly RTId[] = [RTId.SceneColor];
  readonly budgetMs = 0.5;

  enabled(_quality: Readonly<QualitySettings>): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    if (!ctx.services.renderer.overlays.viewmodel) return;
    const g = graph as IronRenderGraph;
    g.drawLayers(ctx, [RenderLayer.Viewmodel], g.target(RTId.SceneColor), {
      clearDepth: true,
      viewmodelCamera: true,
      jitter: true,
    });
  }
}
