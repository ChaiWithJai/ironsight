/**
 * THE TERRAIN SURFACE SHADER. Owned by TERRAIN.
 *
 * Registered with `MaterialFactory.registerSurface`, which is the sanctioned
 * route for a lane to own its own shading: the chunk runs after the uber
 * material has resolved albedo/normal/roughness and BEFORE lighting, so the
 * ground still receives CSM, clustered lights, GTAO and in-shader aerial
 * perspective exactly like every other surface in the frame. A hand-rolled
 * ShaderMaterial would compile and would be the one object in the frame lit
 * differently.
 *
 * What it does, in order:
 *   1. splat weights from the world-space map (sand · dry scrub · rock)
 *   2. two triplanar TextureSet fetches — sand and sandstone — so a 60° cliff
 *      face samples in the plane it faces instead of stretching the XZ layout
 *   3. procedural mesoscale / macro / micro variation at NON-HARMONIC scale
 *      ratios, which is what keeps the ground from tiling and from going smooth
 *      as the camera approaches
 *   4. the wet mask at the waterline: albedo ×0.6, roughness → 0.15, micro
 *      relief flattened — all four of LOOK_SPEC §4.5's simultaneous effects,
 *      because doing only some of them is what makes wet ground read as plastic
 *   5. the ground-transition band where LEVEL's geometry meets the terrain
 *
 * Sampler budget is the reason there are two TextureSets and not three. The dry
 * terrace layer is the sand set under the soil tint with its own roughness and
 * mottle: two more samplers would put this material within a couple of units of
 * the WebGL2 guaranteed minimum once the uber material's shadow atlas, LUTs and
 * cluster buffers are counted, and running out of texture units is a link
 * failure, not a soft degradation.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  SurfaceId,
  type GpuUniform,
  type MaterialFactory,
  type SurfaceChunk,
  type TextureSet,
} from '@/engine/types';
import { LAYER_ALBEDO, SHORE_RANGE_METRES, type TerrainMaps } from '@/world/terrain/maps';

export const TERRAIN_SURFACE_CHUNK = 'terrain.ground';

/** Metres per texture repeat, per layer. Both are inside the "mesoscale
 *  variation 0.15–0.6 m" band once the set's own tiling is folded in. */
const SAND_METRES = 1.45;
const ROCK_METRES = 2.30;

const COMMON = /* glsl */ `
uniform sampler2D uTerrainSplat;
uniform sampler2D uTerrainShore;
uniform sampler2D uTerrainSandAlbedo;
uniform sampler2D uTerrainSandSurface;
uniform sampler2D uTerrainRockAlbedo;
uniform sampler2D uTerrainRockSurface;
/** xy = map rect min, zw = 1 / map rect size. */
uniform vec4 uTerrainRect;
/** x = shore range m, y = sea level, z = sand m/repeat, w = rock m/repeat. */
uniform vec4 uTerrainParams;
uniform vec3 uTerrainSandTint;
uniform vec3 uTerrainScrubTint;
uniform vec3 uTerrainRockTint;

float ironTerrainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float ironTerrainValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = ironTerrainHash(i);
  float b = ironTerrainHash(i + vec2(1.0, 0.0));
  float c = ironTerrainHash(i + vec2(0.0, 1.0));
  float d = ironTerrainHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * Three octaves at 1.00 / 3.70 / 13.90. The ratios are deliberately
 * non-harmonic: harmonic octaves beat against each other and the beat period is
 * exactly the repeat a viewer's eye finds.
 */
float ironTerrainFbm(vec2 p) {
  return ironTerrainValue(p) * 0.54 + ironTerrainValue(p * 3.70) * 0.31 + ironTerrainValue(p * 13.90) * 0.15;
}

/**
 * Two-plane triplanar. The horizontal plane always samples; the vertical plane
 * is whichever of ZY / XY the face points at most. Both are always fetched —
 * branching around the vertical fetch would put a texture read in non-uniform
 * control flow, where implicit derivatives (and therefore mip selection) are
 * undefined, and the artefact is a hard LOD seam along every slope contour.
 */
vec4 ironTerrainTriplanar(sampler2D tex, vec3 wp, vec3 an, float upness, float invMetres) {
  vec4 horizontal = texture2D(tex, wp.xz * invMetres);
  vec2 uvV = an.x > an.z ? wp.zy * invMetres : wp.xy * invMetres;
  return mix(texture2D(tex, uvV), horizontal, upness);
}

/**
 * Re-level a sampled TextureSet onto an AUTHORED albedo.
 *
 * BAKE owns what the sand and sandstone sets actually look like and it is
 * allowed to change them; LOOK_SPEC §4.3 owns what dry sand and sandstone are
 * ALLOWED to reflect (0.45–0.58 and 0.32–0.48 linear). Multiplying a tint by a
 * raw sample honours neither: a bright baked set pushes the ground past the
 * 0.82 ceiling, everything clips to cream and every material distinction on the
 * map is lost — which is exactly what happened before this function existed.
 *
 * So: take the texture's own average level from its smallest mip, divide it out,
 * and re-apply the authored albedo. What survives is the texture's VARIATION
 * (which is what it is for) and a fraction of its chroma; what does not survive
 * is its absolute level (which is ours to decide). A flat placeholder set lands
 * exactly on the authored value instead of dragging the frame with it.
 */
vec3 ironTerrainRelevel(vec4 texel, vec3 mean, vec3 tint) {
  const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
  float meanL = max(dot(mean, luma), 0.02);
  float texL = max(dot(texel.rgb, luma), 1e-4);
  vec3 chroma = texel.rgb / texL;
  return tint * clamp(texL / meanL, 0.55, 1.6) * mix(vec3(1.0), chroma, 0.35);
}
`;

const SHADE = /* glsl */ `
{
  vec3 wp = vWorldPosition;
  vec3 baseNormal = normalize(normal);
  vec3 an = abs(baseNormal);
  float upness = smoothstep(0.42, 0.88, an.y);
  float viewDist = length(vViewPosition);

  vec2 mapUv = (wp.xz - uTerrainRect.xy) * uTerrainRect.zw;
  vec4 splat = texture2D(uTerrainSplat, mapUv);
  float shoreM = (texture2D(uTerrainShore, mapUv).r * 2.0 - 1.0) * uTerrainParams.x;

  // The splat map is 0.5 m/texel; without this the transitions would be soft
  // 0.5 m gradients. Two octaves push the boundary around at 1.6 m and 0.3 m so
  // it interlocks instead of dissolving. Single-octave value noise, not fBm:
  // this shader is evaluated over every ground pixel in the frame and each fBm
  // call is three more hash quads.
  float edgeNoise = ironTerrainValue(wp.xz * 0.62) + ironTerrainValue(wp.xz * 3.1) * 0.45;
  float sharpen = (edgeNoise - 0.72) * 0.55;
  float wSand = max(0.0, splat.r + sharpen);
  float wScrub = max(0.0, splat.g - sharpen * 0.4);
  float wRock = max(0.0, splat.b + sharpen * 0.7);
  float wSum = max(1e-4, wSand + wScrub + wRock);
  wSand /= wSum; wScrub /= wSum; wRock /= wSum;

  // ---- procedural variation, independent of what BAKE baked ----------------
  // Mesoscale (0.55 m), macro break-up (9 m and 37 m) and a micro band that
  // fades in inside 9 m. This is the layer that guarantees the look spec's
  // "luminance sigma >= 12 in a nominally uniform patch" even before a single
  // texel of the TextureSet is read, and it is what stops the ground going
  // smooth as the camera walks up to it.
  vec2 mesoP = wp.xz * 3.40;
  float meso = ironTerrainFbm(mesoP);
  // Two macro bands (9 m and 47 m). The long one is what stops 200 m of open
  // ground reading as one flat tone at range, where the mesoscale has mipped
  // away and only this survives.
  float macro = ironTerrainValue(wp.xz * 0.111) * 0.55 + ironTerrainValue(wp.xz * 0.021) * 0.45;
  float microFade = 1.0 - smoothstep(2.0, 9.0, viewDist);

  // ---- layer 1: sand / dry scrub (one fetch group, two tints) --------------
  vec3 albedo = vec3(0.0);
  float rough = 0.94;
  float cavity = 1.0;
  vec2 slopeNormal = vec2(0.0);

  float wGround = wSand + wScrub;
  {
    float invM = 1.0 / uTerrainParams.z;
    vec4 ga = ironTerrainTriplanar(uTerrainSandAlbedo, wp, an, upness, invM);
    vec4 gs = ironTerrainTriplanar(uTerrainSandSurface, wp, an, upness, invM);
    vec3 tint = mix(uTerrainScrubTint, uTerrainSandTint, wSand / max(1e-4, wGround));
    albedo += ironTerrainRelevel(ga, textureLod(uTerrainSandAlbedo, vec2(0.5), 12.0).rgb, tint) * wGround;
    rough = mix(rough, mix(0.90, 0.97, wSand / max(1e-4, wGround)) * (0.82 + 0.36 * gs.b), wGround);
    cavity = mix(cavity, gs.a, wGround * 0.8);
    // Half strength: the baked set's own relief is authored for a wall at
    // arm's length, and at full strength across a whole beach it reads as
    // marbling rather than as sand.
    slopeNormal += (gs.rg * 2.0 - 1.0) * wGround * 0.55;
  }

  // ---- layer 2: sandstone / rock ------------------------------------------
  {
    float invM = 1.0 / uTerrainParams.w;
    vec4 ra = ironTerrainTriplanar(uTerrainRockAlbedo, wp, an, upness, invM);
    vec4 rs = ironTerrainTriplanar(uTerrainRockSurface, wp, an, upness, invM);
    vec3 rockCol = ironTerrainRelevel(ra, textureLod(uTerrainRockAlbedo, vec2(0.5), 12.0).rgb, uTerrainRockTint);
    // Bedding: the strata carved into the heightfield continue as an albedo
    // banding keyed on ALTITUDE, so a cliff reads as sedimentary rock rather
    // than as noise projected on a slope.
    float bedding = sin(wp.y * 0.92 + macro * 3.4);
    rockCol *= 0.90 + 0.13 * bedding;
    albedo += rockCol * wRock;
    rough = mix(rough, 0.86 * (0.80 + 0.40 * rs.b), wRock);
    cavity = mix(cavity, rs.a, wRock * 0.8);
    slopeNormal += (rs.rg * 2.0 - 1.0) * wRock;
  }

  // ---- multi-scale modulation ---------------------------------------------
  // ±20 % at 0.29 m. LOOK_SPEC §4.1's acceptance test is a luminance sigma of
  // 12–40 inside a nominally uniform patch at 1 m, and this term is what pays
  // for it — it is not decoration, it is the difference between a material and
  // a colour. Kept FINE deliberately: the same amplitude at half a metre reads
  // as marbling rather than as grain.
  albedo *= 0.80 + 0.40 * meso;
  albedo *= 0.74 + 0.52 * macro;
  rough = clamp(rough + (meso - 0.5) * 0.16 + (macro - 0.5) * 0.05, 0.30, 1.0);
  // Cavity darkening only, never a flat AO multiply: LOOK_SPEC is explicit that
  // scaling the final colour by AO is what produces dirty grey shadows.
  albedo *= mix(1.0, cavity, 0.55);

  // Procedural relief from the noise gradient, so the surface still self-shades
  // at 0.3 m when the baked normal map has nothing left. Gated on distance:
  // these taps are pure ALU with no implicit derivatives, so branching around
  // them is safe, and past 60 m the perturbation is under a pixel anyway.
  if (viewDist < 60.0) {
    float m0 = ironTerrainValue(mesoP);
    slopeNormal += vec2(m0 - ironTerrainValue(mesoP + vec2(0.55, 0.0)),
                        m0 - ironTerrainValue(mesoP + vec2(0.0, 0.55))) * 1.8;
    // WIND RIPPLE, sand only, dry only. Beach ripple is periodic and has a
    // direction — an isotropic noise field never reads as sand no matter how
    // much of it you add, and the corpus's beaches are unmistakably combed.
    float ripplePhase = dot(wp.xz, vec2(0.94, 0.34)) * 6.8 + m0 * 5.5;
    slopeNormal.x += cos(ripplePhase) * 0.55 * wSand;
    if (microFade > 0.02) {
      vec2 microP = wp.xz * 11.3;
      float u0 = ironTerrainValue(microP);
      albedo *= mix(1.0, 0.86 + 0.30 * u0, microFade);
      slopeNormal += vec2(u0 - ironTerrainValue(microP + vec2(0.35, 0.0)),
                          u0 - ironTerrainValue(microP + vec2(0.0, 0.35))) * 3.4 * microFade;
    }
  }

  // ---- wet mask (LOOK_SPEC 4.5) -------------------------------------------
  // The tide line is scalloped by the same along-shore noise that shapes the
  // beach cusps, and the boundary is hard-ish with a feather, not a gradient.
  float wet = 0.0;
  if (shoreM < 16.0) {
    float tide = (ironTerrainValue(wp.xz * 0.055) - 0.5) * 2.4;
    wet = clamp(1.0 - smoothstep(-0.25 + tide, 2.1 + tide, shoreM), 0.0, 1.0);
    // THE WRACK LINE. A real beach carries a dark band of organic debris and
    // damp sand a few metres above the swash, and it is the only horizontal
    // value break in an otherwise uniform sheet of sand — without it the beach
    // is one tone from the water to the berm, which is the single flattest
    // thing in these frames.
    float d = (shoreM - 3.4 - tide * 1.6) / 2.8;
    float wrack = exp(-d * d) * (0.45 + 0.55 * edgeNoise);
    albedo *= 1.0 - 0.22 * wrack;
    rough = mix(rough, 0.88, wrack * 0.5);
  }
  albedo *= mix(1.0, 0.60, wet);
  rough = mix(rough, 0.15, wet);
  slopeNormal *= 1.0 - 0.8 * wet;

  // ---- ground transition where LEVEL's geometry lands ---------------------
  float trans = splat.a;
  if (trans > 0.004) {
    vec2 gp = wp.xz * 3.3;
    float grit = ironTerrainValue(gp);
    albedo = mix(albedo, albedo * (0.70 + 0.62 * grit), trans);
    rough = mix(rough, 0.94, trans * 0.75);
    albedo *= 1.0 - 0.26 * trans * trans;
    slopeNormal += vec2(grit - ironTerrainValue(gp + vec2(0.3, 0.0)),
                        grit - ironTerrainValue(gp + vec2(0.0, 0.3))) * 4.0 * trans;
  }

  // ---- resolve ------------------------------------------------------------
  // The perturbation is built in world space (the surface-chunk contract's
  // stated frame) and orthogonalised against the incoming normal before it is
  // added, so it can only ever tilt the normal — it can never flip or
  // denormalise it.
  vec3 pert = mix(
    an.x > an.z ? vec3(0.0, slopeNormal.y, slopeNormal.x) : vec3(slopeNormal.x, slopeNormal.y, 0.0),
    vec3(slopeNormal.x, 0.0, slopeNormal.y),
    upness);
  pert -= baseNormal * dot(pert, baseNormal);
  normal = normalize(baseNormal + pert * 0.34);

  diffuseColor.rgb = clamp(albedo, vec3(0.035), vec3(0.82));
  material.roughness = clamp(rough, 0.08, 1.0);
  material.metalness = 0.0;
}
`;

export const TERRAIN_SURFACE: SurfaceChunk = { common: COMMON, shade: SHADE };

export interface TerrainMaterialDeps {
  readonly materials: MaterialFactory;
  readonly maps: TerrainMaps;
  readonly sand: TextureSet;
  readonly rock: TextureSet;
}

export function createTerrainMaterial(deps: TerrainMaterialDeps): THREE.Material {
  const { materials, maps, sand, rock } = deps;
  materials.registerSurface(TERRAIN_SURFACE_CHUNK, TERRAIN_SURFACE);

  const uniforms: Record<string, GpuUniform> = {
    uTerrainSplat: { value: maps.splatMap },
    uTerrainShore: { value: maps.shoreMask },
    uTerrainSandAlbedo: { value: sand.albedoHeight },
    uTerrainSandSurface: { value: sand.normalRoughAo },
    uTerrainRockAlbedo: { value: rock.albedoHeight },
    uTerrainRockSurface: { value: rock.normalRoughAo },
    uTerrainRect: {
      value: new THREE.Vector4(maps.rect.minX, maps.rect.minZ, 1 / maps.rect.sizeX, 1 / maps.rect.sizeZ),
    },
    uTerrainParams: {
      value: new THREE.Vector4(
        SHORE_RANGE_METRES,
        0,
        SAND_METRES * Math.max(0.25, sand.tiling / 2),
        ROCK_METRES * Math.max(0.25, rock.tiling / 2),
      ),
    },
    uTerrainSandTint: { value: new THREE.Vector3(...LAYER_ALBEDO.sand) },
    uTerrainScrubTint: { value: new THREE.Vector3(...LAYER_ALBEDO.scrub) },
    uTerrainRockTint: { value: new THREE.Vector3(...LAYER_ALBEDO.rock) },
  };

  return materials.create({
    id: 'terrain.ground',
    surface: SurfaceId.Sand,
    layer: materials.allocateLayer('terrain.ground', sand.albedoHeight, sand.normalRoughAo),
    // Triplanar is declared as well as implemented: it states the intent to the
    // factory (steep faces must not stretch) and keeps any base-layer sampling
    // the uber material does on the same projection as the splat above it.
    features: MaterialFeature.Triplanar | MaterialFeature.DetailNormal,
    baseColor: new THREE.Color().setRGB(LAYER_ALBEDO.scrub[0], LAYER_ALBEDO.scrub[1], LAYER_ALBEDO.scrub[2], THREE.LinearSRGBColorSpace),
    roughness: 0.94,
    metalness: 0,
    surfaceShader: TERRAIN_SURFACE_CHUNK,
    uniforms,
  });
}
