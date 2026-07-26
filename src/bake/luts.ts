/**
 * BAKE's own lookup tables — the assets §6.1 of the architecture lists with no
 * owning lane. OWNER: BAKE.
 *
 *   B3  brdfLut    RG16F 256²      split-sum GGX environment BRDF
 *   B4  blueNoise  R8 3D            void-and-cluster, spatiotemporal
 *
 * Both are consumed by lanes that cannot import `src/bake/**`, so both are
 * published through `BakeAssets` in `engine/types.ts`.
 */
import * as THREE from 'three';
import { MipMode, RTFormat, type GpuBakeDesc } from '@/engine/types';
import type { IronGpuBakeDevice } from '@/bake/gpu-device';
import type { BlueNoiseRequest, BlueNoiseResponse } from '@/bake/workers/protocol';

/* ------------------------------------------------------------------ BRDF -- */

/**
 * Karis' split-sum environment BRDF: for each (NdotV, roughness) it integrates
 * the GGX visibility term twice, giving the scale and bias applied to F0 at
 * shading time.
 *
 * It is view-independent and material-independent, which is exactly why it is a
 * table: the alternative is running a 32-sample importance loop in the forward
 * pass of every lit fragment in the frame.
 */
const BRDF_PRELUDE = /* glsl */ `
uniform int uSamples;

float radicalInverseVdC(uint bits){
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}

vec3 importanceSampleGgx(vec2 xi, float roughness, vec3 n){
  float a = roughness * roughness;
  float phi = 6.2831853 * xi.x;
  float cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  vec3 h = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
  vec3 up = abs(n.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tx = normalize(cross(up, n));
  vec3 ty = cross(n, tx);
  return normalize(tx * h.x + ty * h.y + n * h.z);
}

/** Smith height-correlated visibility, IBL parameterisation (k = a/2). */
float geometrySmithIbl(float nDotV, float nDotL, float roughness){
  float a = roughness * roughness;
  float k = a * 0.5;
  float gv = nDotV / (nDotV * (1.0 - k) + k);
  float gl = nDotL / (nDotL * (1.0 - k) + k);
  return gv * gl;
}
`;

const BRDF_FS = /* glsl */ `
  // Guard the poles: NdotV = 0 makes the view vector degenerate and NdotV = 1
  // collapses the tangent frame, and both show up as a bright seam at the edge
  // of the table that every grazing-angle surface in the game then samples.
  float nDotV = clamp(vUv.x, 0.02, 1.0);
  float roughness = clamp(vUv.y, 0.03, 1.0);
  vec3 v = vec3(sqrt(1.0 - nDotV * nDotV), 0.0, nDotV);
  vec3 n = vec3(0.0, 0.0, 1.0);

  float scale = 0.0;
  float bias = 0.0;
  for (int i = 0; i < 512; i++) {
    if (i >= uSamples) break;
    vec2 xi = vec2(float(i) / float(uSamples), radicalInverseVdC(uint(i)));
    vec3 h = importanceSampleGgx(xi, roughness, n);
    vec3 l = normalize(2.0 * dot(v, h) * h - v);
    float nDotL = max(l.z, 0.0);
    if (nDotL <= 0.0) continue;
    float nDotH = max(h.z, 0.0);
    float vDotH = max(dot(v, h), 0.0);
    float g = geometrySmithIbl(nDotV, nDotL, roughness);
    float gVis = (g * vDotH) / max(1e-4, nDotH * nDotV);
    float fc = pow(1.0 - vDotH, 5.0);
    scale += (1.0 - fc) * gVis;
    bias += fc * gVis;
  }
  outColor = vec4(scale / float(uSamples), bias / float(uSamples), 0.0, 1.0);
`;

export interface LutBudget {
  /** Table edge in texels. */
  readonly size: number;
  /** Importance samples per texel. */
  readonly samples: number;
}

export function bakeBrdfLut(device: IronGpuBakeDevice, budget: LutBudget): THREE.Texture {
  const desc: GpuBakeDesc = {
    name: 'bake.lut.brdf',
    width: budget.size,
    height: budget.size,
    // RG16F, not RG8: the bias term is small and quantising it to 8 bits puts a
    // visible step in the Fresnel ramp on every smooth surface at a grazing
    // angle, which is precisely the angle the brief calls out as a quality gate.
    format: device.gl.floatRenderable ? RTFormat.RG16F : RTFormat.RG8,
    // Clamp: the table's edges ARE the boundary conditions (NdotV → 0 and
    // roughness → 1). Repeat would wrap a mirror surface onto a rough one.
    wrap: 'clamp',
    filter: 'linear',
    mips: MipMode.None,
    prelude: BRDF_PRELUDE,
    fragment: BRDF_FS,
    uniforms: { uSamples: { value: budget.samples } },
  };
  return device.render(desc);
}

/* ------------------------------------------------------------ blue noise -- */

export interface BlueNoiseBudget {
  /** Tile edge. Power of two; void-and-cluster is O(n²) in the texel count. */
  readonly size: number;
  /** Temporal slices. Each is the same tile offset along the R1 sequence. */
  readonly slices: number;
  readonly seed: number;
}

/**
 * Spatiotemporal blue noise as a `Data3DTexture`.
 *
 * It comes back from the worker pool rather than the GPU because void-and-
 * cluster is an inherently serial relaxation — each placement depends on the
 * energy field the previous one left — and there is no fragment-shader form of
 * it that is not a different, worse algorithm.
 */
export async function bakeBlueNoise(
  /**
   * A job runner, not the pool itself, so the caller decides whether the result
   * goes through the IndexedDB cache. Void-and-cluster is the one bake here that
   * is both expensive AND serialisable, which is exactly the population the
   * cache exists for.
   */
  run: (job: string, payload: BlueNoiseRequest) => Promise<BlueNoiseResponse>,
  budget: BlueNoiseBudget,
): Promise<THREE.Data3DTexture> {
  const request: BlueNoiseRequest = { size: budget.size, slices: budget.slices, seed: budget.seed };
  const response = await run('bake.blueNoise', request);
  const data = new Uint8Array(response.data);
  const texture = new THREE.Data3DTexture(data, budget.size, budget.size, budget.slices);
  texture.name = 'bake.noise.blue';
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  // NEAREST on purpose. Filtering blue noise between texels reintroduces exactly
  // the low-frequency energy void-and-cluster spent its whole runtime removing,
  // and the dither pattern starts to crawl under TAA instead of resolving.
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
