/**
 * Vegetation materials, wind deform chunks and the leaf-translucency surface
 * chunk. OWNER: VEG.
 *
 * THE MOTION-VECTOR CONTRACT (ARCHITECTURE decision #14). Every vertex this
 * lane animates moves inside a `DeformChunk` registered through
 * `MaterialFactory.registerDeform`, so the identical GLSL is injected into the
 * forward, depth-prepass, shadow and velocity materials and the four can never
 * disagree. `prevPosition` re-evaluates the same displacement at `uIronPrevTime`,
 * which is what stops TAA smearing every frond — the classic failure this lane
 * is warned about twice in its own stub.
 *
 * THE STATIC-POSE SPLIT. A plant's *growth* shape (its permanent downwind lean,
 * baked per instance at scatter time from the wind field at `WIND_POSE_TIME`)
 * lives in the instance matrix; its *motion* lives here. The deform therefore
 * emits `offset(t) − offset(WIND_POSE_TIME)`, so the two compose to exactly
 * `offset(t)` with no double-counting and no discontinuity, and a frame rendered
 * at t = WIND_POSE_TIME is identical whether the deform ran or not.
 *
 * ONE UNIFORM NAMESPACE PER MATERIAL. `MaterialFactory` throws if two specs
 * declare the same uniform name — deliberately, so two lanes cannot fight over
 * one block slot. Every name below is therefore suffixed with its material key.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  SurfaceId,
  type GpuUniform,
  type MaterialFactory,
  type MaterialSpec,
} from '@/engine/types';
import { WIND_POSE_TIME, glslField } from '@/world/vegetation/wind';

/** Which material a piece of vegetation geometry is drawn with. */
export type VegMaterialKey = 'frond' | 'leaf' | 'bark' | 'grass' | 'mat';

/**
 * Per-material wind response.
 *
 * `flex` is the fraction of the plant's height its tip travels at full bend.
 * `stiffness` is the plant's resistance in the saturating speed→bend curve.
 * `flutterHz`/`flutterAmp` are the uncorrelated per-instance chatter: this is
 * the term that makes two neighbouring plants disagree, and without it a field
 * moves in lockstep, which the brief correctly calls worse than not moving.
 */
interface WindProfile {
  readonly height: number;
  readonly flex: number;
  readonly stiffness: number;
  readonly flutterHz: number;
  readonly flutterAmp: number;
}

const WIND_PROFILES: Record<Exclude<VegMaterialKey, 'mat'>, WindProfile> = {
  // A frond is a 3.5 m cantilever hinged at the crown: large travel, slow.
  frond: { height: 3.6, flex: 0.30, stiffness: 0.55, flutterHz: 0.62, flutterAmp: 0.10 },
  // Olive and scrub leaves: small travel, fast chatter. Olive foliage
  // "flickering silver" in wind is entirely this term.
  leaf: { height: 1.2, flex: 0.10, stiffness: 1.15, flutterHz: 1.85, flutterAmp: 0.16 },
  // Woody parts: almost nothing. The whole-plant lean is done on the CPU by the
  // instance matrix, so the trunk chunk only carries a trace of high-frequency
  // life so the silhouette is never perfectly rigid.
  bark: { height: 6.0, flex: 0.020, stiffness: 2.4, flutterHz: 0.34, flutterAmp: 0.012 },
  // Grass is the floppiest thing in the scene and carries the whole gust read.
  grass: { height: 0.5, flex: 0.62, stiffness: 0.30, flutterHz: 1.25, flutterAmp: 0.20 },
};

function deformName(key: string): string {
  return `vegWind_${key}`;
}

/**
 * Build the deform GLSL for one material key. The wind field itself comes from
 * `wind.ts` so the shader and `VegetationService.windAt` are the same function.
 */
function deformChunk(key: Exclude<VegMaterialKey, 'mat'>): { common: string; displace: string; prevPosition: string } {
  const p = `veg${key[0].toUpperCase()}${key.slice(1)}`;
  const w = WIND_PROFILES[key];
  const strengthUniform = `uVegStrength_${key}`;

  const common = /* glsl */ `
uniform float ${strengthUniform};
${glslField(p, strengthUniform)}

/**
 * Object-space displacement of one vertex under the wind field at time t.
 * axX/axZ are the instance's world-space X and Z axes, which is how a
 * world-space wind direction is brought into the instance's own yawed frame
 * without a matrix inverse.
 */
vec3 ${p}Offset(vec3 local, vec3 origin, vec3 axX, vec3 axZ, float t) {
  vec2 w = ${p}Wind(origin.xz, t);
  float speed = length(w);
  vec2 wdir = speed > 1e-4 ? w / speed : vec2(0.0, 1.0);
  float amp = ${p}Bend(speed, ${w.stiffness.toFixed(4)});
  vec3 wworld = vec3(wdir.x, 0.0, wdir.y);
  vec2 wo = vec2(dot(wworld, axX), dot(wworld, axZ));

  float h = clamp(local.y / ${w.height.toFixed(4)}, 0.0, 1.0);
  // Cantilever profile: a beam clamped at one end deflects as height^1.55 under
  // distributed load. Linear bend is the classic shader-wind "jelly" look.
  float k = pow(h, 1.55);
  vec2 off = wo * (k * amp * ${(w.flex * w.height).toFixed(4)});

  // Per-instance decorrelation. Two plants a quarter-metre apart get unrelated
  // phases; the field still gusts together because amp is shared.
  float ph = ${p}Hash(origin.xz) * 6.2831853;
  float fl = sin(t * ${(w.flutterHz * Math.PI * 2).toFixed(4)} + ph + local.y * 3.1)
           * ${w.flutterAmp.toFixed(4)} * k * (0.30 + 0.70 * amp);
  off += vec2(-wo.y, wo.x) * fl;

  // Arc-length preservation. A stem that bends sideways must also shorten, or
  // the plant visibly grows as the wind rises.
  float drop = 0.5 * dot(off, off) / ${Math.max(w.height, 0.05).toFixed(4)};
  return vec3(off.x, -drop, off.y);
}

/**
 * Object-space posed position, basis and all. Written as ONE self-contained
 * function because prevPosition is an expression with no statements available
 * to it: anything it needs must be reachable from global scope, and
 * instanceMatrix and modelMatrix both are.
 */
vec3 ${p}Posed(vec3 local, float t) {
  vec3 origin;
  vec3 axX;
  vec3 axZ;
  #ifdef USE_INSTANCING
    origin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    axX = normalize(mat3(modelMatrix) * mat3(instanceMatrix)[0]);
    axZ = normalize(mat3(modelMatrix) * mat3(instanceMatrix)[2]);
  #else
    origin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    axX = normalize(mat3(modelMatrix)[0]);
    axZ = normalize(mat3(modelMatrix)[2]);
  #endif
  // Static growth pose is already in the instance matrix; emit only the delta,
  // so mesh and shader compose to exactly offset(t) with no double count.
  return local
       + ${p}Offset(local, origin, axX, axZ, t)
       - ${p}Offset(local, origin, axX, axZ, ${WIND_POSE_TIME.toFixed(1)});
}
`;

  // three's own names inside <begin_vertex> are transformed and objectNormal.
  const displace = /* glsl */ `
  vec3 ${p}P = ${p}Posed(transformed, uIronTime);
  // Rotate the normal by the tangent tilt the bend introduces. A displaced
  // surface with an undisplaced normal lights as if it never moved, which on
  // foliage reads as a canopy that changes shape without changing shading.
  vec3 ${p}Tan = normalize(${p}Posed(transformed + vec3(0.0, 0.06, 0.0), uIronTime) - ${p}P);
  vec3 ${p}Axis = cross(vec3(0.0, 1.0, 0.0), ${p}Tan);
  float ${p}S = length(${p}Axis);
  if (${p}S > 1e-5) {
    ${p}Axis /= ${p}S;
    float ${p}C = ${p}Tan.y;
    objectNormal = objectNormal * ${p}C
                 + cross(${p}Axis, objectNormal) * ${p}S
                 + ${p}Axis * dot(${p}Axis, objectNormal) * (1.0 - ${p}C);
  }
  transformed = ${p}P;
`;

  const prevPosition = `${p}Posed(position, uIronPrevTime)`;

  return { common, displace, prevPosition };
}

/**
 * Live uniform cells for one material, kept so the runtime can push per frame.
 *
 * There is exactly one, and that is the point. Leaf translucency is NOT a
 * lane-authored surface chunk here: `MaterialFeature.Translucency` already
 * carries a wrapped back-lobe transmission term inside the uber material, sited
 * where it belongs — after AO, inside the light loop, against the real
 * directional light. Registering a second one on top would double the effect
 * and would light the canopy differently from everything else in the frame,
 * which is precisely the failure `registerSurface` exists to prevent.
 */
export interface VegMaterialCells {
  readonly strength?: GpuUniform<number>;
}

export interface VegMaterials {
  readonly material: Record<VegMaterialKey, THREE.Material>;
  readonly cells: Record<VegMaterialKey, VegMaterialCells>;
}

/**
 * Base colours. Linear albedo bounds from LOOK_SPEC §4.3: foliage 0.06–0.14,
 * weathered timber 0.12–0.22, dry soil/straw 0.18–0.30. These are the sRGB
 * values that land inside those bounds, and nothing here is allowed near black.
 */
const BASE = {
  // Date-palm frond, late summer: green with a strong yellow bias. Linear ≈ 0.10.
  frond: 0x59632f,
  // Olive foliage: the pale silvery upper surface averaged with the darker
  // underside. Linear ≈ 0.13, and noticeably desaturated — olive is not green.
  leaf: 0x717a58,
  // Weathered palm/olive bark. Linear ≈ 0.16.
  bark: 0x736450,
  // Dry summer grass. Linear ≈ 0.22, hue ~44°. Mediterranean coastal grass in
  // August is straw, not lawn — reading it green is the commonest tell in a
  // procedural Mediterranean scene.
  grass: 0x9d8b5c,
  mat: 0x8d7f55,
} as const;

export function createVegetationMaterials(materials: MaterialFactory): VegMaterials {
  const material = {} as Record<VegMaterialKey, THREE.Material>;
  const cells = {} as Record<VegMaterialKey, VegMaterialCells>;

  const foliage = (key: Exclude<VegMaterialKey, 'mat' | 'bark'>, baseColor: number, roughness: number): void => {
    materials.registerDeform(deformName(key), deformChunk(key));
    const strength: GpuUniform<number> = { value: 1 };
    const set = materials.textures(SurfaceId.Foliage);

    const spec: MaterialSpec = {
      id: `veg.${key}`,
      surface: SurfaceId.Foliage,
      layer: materials.allocateLayer(`veg.${key}`, set.albedoHeight, set.normalRoughAo),
      // Translucency is the one that matters (LOOK_SPEC §4.7): backlit fronds
      // are brighter AND more saturated than front-lit ones, which reflection
      // alone cannot produce. DitherFade lets a LOD swap resolve through TAA.
      // NO AlphaClip anywhere in this lane — every leaf is solid geometry.
      features:
        MaterialFeature.VertexDeform |
        MaterialFeature.Translucency |
        MaterialFeature.DitherFade |
        MaterialFeature.DetailNormal,
      baseColor,
      roughness,
      metalness: 0,
      doubleSided: true,
      instanced: true,
      deform: deformName(key),
      uniforms: { [`uVegStrength_${key}`]: strength },
    };
    material[key] = materials.create(spec);
    cells[key] = { strength };
  };

  foliage('frond', BASE.frond, 0.78);
  foliage('leaf', BASE.leaf, 0.80);
  foliage('grass', BASE.grass, 0.86);

  // Bark: opaque, single-sided, essentially rigid.
  const barkChunk = deformChunk('bark');
  materials.registerDeform(deformName('bark'), barkChunk);
  const barkStrength: GpuUniform<number> = { value: 1 };
  material.bark = materials.create({
    id: 'veg.bark',
    surface: SurfaceId.Bark,
    layer: materials.allocateLayer('veg.bark', materials.textures(SurfaceId.Bark).albedoHeight, materials.textures(SurfaceId.Bark).normalRoughAo),
    features: MaterialFeature.VertexDeform | MaterialFeature.DetailNormal | MaterialFeature.WearMask,
    baseColor: BASE.bark,
    roughness: 0.88,
    metalness: 0,
    doubleSided: false,
    instanced: true,
    deform: deformName('bark'),
    uniforms: { [`uVegStrength_bark`]: barkStrength },
  });
  cells.bark = { strength: barkStrength };

  // The distance mat never moves — it is the ground, dressed. No deform, no
  // translucency, no cost.
  material.mat = materials.create({
    id: 'veg.mat',
    surface: SurfaceId.Foliage,
    layer: materials.allocateLayer('veg.mat', materials.textures(SurfaceId.Foliage).albedoHeight, materials.textures(SurfaceId.Foliage).normalRoughAo),
    features: MaterialFeature.DetailNormal | MaterialFeature.DitherFade,
    baseColor: BASE.mat,
    roughness: 0.93,
    metalness: 0,
    doubleSided: true,
    instanced: true,
  });
  cells.mat = {};

  return { material, cells };
}
