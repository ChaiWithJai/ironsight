/**
 * DEPTH / SHADOW / VELOCITY variants of a forward iron material.
 *
 * OWNER: RCORE.
 *
 * THE INVARIANT THESE FILES EXIST TO KEEP
 * ---------------------------------------
 * A variant must displace, alpha-test and cut out its geometry EXACTLY as the
 * forward material does. If the shadow variant misses a deform chunk, a palm
 * casts the shadow of a palm that is not there; if the velocity variant misses
 * one, TAA smears every frond and the bug gets blamed on TAA. So the deform
 * chunk, the alpha test and the side/blend state all come from one place and
 * are copied here rather than re-derived.
 *
 * The velocity material is written by hand rather than derived from a three
 * material because three has no velocity material and because velocity has one
 * requirement no built-in material can satisfy: it must rasterise with the
 * JITTERED projection (so the buffer aligns with the colour buffer) while
 * COMPUTING with the unjittered one (so the TAA jitter does not appear as
 * per-pixel motion). Both matrices are therefore explicit uniforms and
 * `gl_Position` and the varyings are computed from different ones.
 */
import * as THREE from 'three';
import type { DeformChunk, GpuUniform } from '@/engine/types';

export interface VelocityUniforms {
  readonly uIronCurrVP: GpuUniform;
  readonly uIronPrevVP: GpuUniform;
  readonly uIronTime: GpuUniform;
  readonly uIronPrevTime: GpuUniform;
}

const VELOCITY_VERTEX = (deform: DeformChunk | undefined): string => /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform mat4 uIronPrevModel;
uniform mat4 uIronCurrVP;
uniform mat4 uIronPrevVP;
uniform float uIronTime;
uniform float uIronPrevTime;
varying vec4 vIronCurrClip;
varying vec4 vIronPrevClip;
varying vec2 vIronVelUv;
${deform?.common ?? ''}
void main() {
  vIronVelUv = uv;
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <morphinstance_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
${deform ? deform.displace : ''}
  // Evaluated with LAST frame's uniforms. prevPosition is an EXPRESSION by
  // contract, so it can be captured before the skinning/morph chunks rewrite
  // transformed underneath it.
  vec3 ironPrevLocal = ${deform ? `( ${deform.prevPosition} )` : 'position'};
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>

  mat4 ironModel = modelMatrix;
  mat4 ironPrevModelFull = uIronPrevModel;
  #ifdef USE_BATCHING
    ironModel = ironModel * batchingMatrix;
    ironPrevModelFull = ironPrevModelFull * batchingMatrix;
  #endif
  #ifdef USE_INSTANCING
    ironModel = ironModel * instanceMatrix;
    ironPrevModelFull = ironPrevModelFull * instanceMatrix;
  #endif
  vIronCurrClip = uIronCurrVP * ironModel * vec4( transformed, 1.0 );
  vIronPrevClip = uIronPrevVP * ironPrevModelFull * vec4( ironPrevLocal, 1.0 );
}
`;

const VELOCITY_FRAGMENT = /* glsl */ `
varying vec4 vIronCurrClip;
varying vec4 vIronPrevClip;
varying vec2 vIronVelUv;
uniform sampler2D uIronAlphaMap;
uniform float uIronAlphaCut;
void main() {
  if ( uIronAlphaCut > 0.0 ) {
    if ( texture2D( uIronAlphaMap, vIronVelUv ).a < uIronAlphaCut ) discard;
  }
  vec2 a = vIronCurrClip.xy / max( abs( vIronCurrClip.w ), 1e-6 ) * sign( vIronCurrClip.w );
  vec2 b = vIronPrevClip.xy / max( abs( vIronPrevClip.w ), 1e-6 ) * sign( vIronPrevClip.w );
  // NDC delta halved: the convention the whole post chain reads is UV-space
  // motion, so a full-screen pan is ±0.5 rather than ±1.
  gl_FragColor = vec4( ( a - b ) * 0.5, 0.0, 1.0 );
}
`;

export interface VelocityMaterialOptions {
  readonly id: string;
  readonly deform?: DeformChunk;
  readonly alphaTest: number;
  readonly alphaMap: THREE.Texture | null;
  readonly side: THREE.Side;
  readonly uniforms: VelocityUniforms;
  /** The forward material's declared uniforms, so a deform reads the same cells. */
  readonly laneUniforms?: Readonly<Record<string, GpuUniform>>;
}

/**
 * Per-object previous world matrix. A WeakMap rather than a field on the object
 * because the objects belong to twelve other lanes and RCORE may not add
 * properties to them; a WeakMap also drops the entry when the object dies,
 * which a `Map` keyed on uuid would not.
 */
interface PrevEntry {
  readonly matrix: THREE.Matrix4;
  epoch: number;
}
const PREV_MATRIX = new WeakMap<THREE.Object3D, PrevEntry>();

/**
 * Bumped by the harness reset chain. An entry from an older epoch is re-seeded
 * from the object's CURRENT matrix, which writes zero velocity for that frame —
 * the correct answer after a teleport or a capture reset, where the alternative
 * is a full-screen smear that TAA resolves into a ghost lasting the whole shot.
 */
let velocityEpoch = 0;

export function buildVelocityMaterial(opts: VelocityMaterialOptions): THREE.ShaderMaterial {
  const prevModel = { value: new THREE.Matrix4() };
  const material = new THREE.ShaderMaterial({
    vertexShader: VELOCITY_VERTEX(opts.deform),
    fragmentShader: VELOCITY_FRAGMENT,
    uniforms: {
      uIronPrevModel: prevModel,
      uIronCurrVP: opts.uniforms.uIronCurrVP as THREE.IUniform,
      uIronPrevVP: opts.uniforms.uIronPrevVP as THREE.IUniform,
      uIronTime: opts.uniforms.uIronTime as THREE.IUniform,
      uIronPrevTime: opts.uniforms.uIronPrevTime as THREE.IUniform,
      uIronAlphaMap: { value: opts.alphaMap },
      uIronAlphaCut: { value: opts.alphaTest },
      ...(opts.laneUniforms as { [k: string]: THREE.IUniform } | undefined),
    },
    side: opts.side,
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
  });
  material.name = `velocity:${opts.id}`;

  /**
   * The per-object half of the velocity contract. Three calls this immediately
   * before the draw, which is the only hook that sees BOTH the material and the
   * object when the material is an override — and an override material is
   * exactly how a velocity pass is drawn.
   *
   * Latching the current matrix here (rather than in a Scene-stage system) also
   * means an object that was not drawn this frame does not accumulate a stale
   * delta and streak on the frame it reappears.
   */
  material.onBeforeRender = (_renderer, _scene, _camera, _geometry, object) => {
    let prev = PREV_MATRIX.get(object);
    if (!prev || prev.epoch !== velocityEpoch) {
      prev = { matrix: object.matrixWorld.clone(), epoch: velocityEpoch };
      PREV_MATRIX.set(object, prev);
    }
    (prevModel.value as THREE.Matrix4).copy(prev.matrix);
    prev.matrix.copy(object.matrixWorld);
    // Shared program, one object at a time: without this three uploads the
    // first object's matrix for every draw and every object but one writes
    // somebody else's motion.
    material.uniformsNeedUpdate = true;
  };
  return material;
}

/** Invalidate every latched previous matrix — harness reset, teleport, resize. */
export function resetVelocityHistory(): void {
  velocityEpoch++;
}

/**
 * Depth / shadow variant. `MeshDepthMaterial` already handles instancing,
 * batching, skinning and morphs; all it is missing is the lane's deform chunk,
 * which is injected through the same three slots the forward material uses so
 * the two cannot drift.
 */
export function buildDepthMaterial(
  id: string,
  deform: DeformChunk | undefined,
  alphaTest: number,
  alphaMap: THREE.Texture | null,
  side: THREE.Side,
  laneUniforms: Readonly<Record<string, GpuUniform>> | undefined,
  globals: { uIronTime: GpuUniform; uIronPrevTime: GpuUniform },
): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    alphaTest,
    side,
  });
  material.name = `depth:${id}`;
  if (alphaTest > 0 && alphaMap) {
    // The cut-out must match the forward pass exactly or foliage casts the
    // shadow of a solid quad — the single most common shadow defect in a
    // vegetated scene.
    material.alphaMap = alphaMap;
    material.map = alphaMap;
  }
  if (deform === undefined && !laneUniforms) return material;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uIronTime = globals.uIronTime as THREE.IUniform;
    shader.uniforms.uIronPrevTime = globals.uIronPrevTime as THREE.IUniform;
    for (const [name, cell] of Object.entries(laneUniforms ?? {})) {
      shader.uniforms[name] = cell as THREE.IUniform;
    }
    if (!deform) return;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uIronTime;\nuniform float uIronPrevTime;\n${deform.common}`,
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${deform.displace}`);
  };
  const key = `ironDepth|${id}|${deform ? 'deform' : 'rigid'}`;
  material.customProgramCacheKey = () => key;
  return material;
}
