/**
 * THE UBER MATERIAL — one shader family for every lit surface in the game.
 *
 * OWNER: RCORE. This is the only `onBeforeCompile` in the repo; CI greps for it.
 *
 * WHY ONE SHADER RATHER THAN A FAMILY OF HAND-WRITTEN ONES
 * -------------------------------------------------------
 * Sixteen lanes emit geometry. If each brought its own material, the town would
 * be lit by one lighting model, the terrain by a second and the weapon by a
 * third, and the frame would read as a collage — which is exactly what the
 * brief's defect list is describing when it says "everything at the same level
 * of contrast". Everything here goes through `MeshPhysicalMaterial`, so it also
 * inherits three's cascade sampling, clustered-light loop, fog and tonemap
 * plumbing for free rather than reimplementing four of them badly.
 *
 * WHAT THE FEATURE BITS ACTUALLY BUY
 * ----------------------------------
 * Feature bits become `#define`s and therefore permutations, so each one has to
 * earn its slot in the 96–192 program budget. The bits that only change a
 * uniform (`Emissive`, `Wetness`, `Anisotropic`) deliberately do NOT define
 * anything: they are free.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  SurfaceId,
  type GpuUniform,
  type MaterialSpec,
  type SurfaceChunk,
  type TextureSet,
} from '@/engine/types';
import {
  IRON_AO_AND_SHEEN,
  IRON_FRAGMENT_PARS,
  IRON_METALNESS,
  IRON_NORMAL_APPLY,
  IRON_ROUGHNESS,
  IRON_SURFACE,
  IRON_TRANSLUCENCY,
  IRON_VERTEX_PARS,
  IRON_VERTEX_RENORMAL,
  IRON_VERTEX_WORLD,
} from '@/render/material/chunks';
import type { DeformChunkRegistry } from '@/render/material/deform';
import { roughCentreOf } from '@/render/material/fallback';

/**
 * Uniform cells shared by EVERY iron material. One object per name, handed to
 * every program, so `updateGlobals` writes camera position or scene depth once
 * and 40 materials see it. Per-material cells live on the material itself.
 */
export interface IronGlobals {
  readonly uIronTime: GpuUniform;
  readonly uIronPrevTime: GpuUniform;
  readonly uIronCamPos: GpuUniform;
  readonly uIronScreen: GpuUniform;
  readonly uIronSceneDepth: GpuUniform;
  /** x soft fade distance is per-material; y/z/w are global (enable, near, far). */
  readonly uIronSoftGlobal: { enabled: number; near: number; far: number };
}

export function createIronGlobals(): IronGlobals {
  return {
    uIronTime: { value: 0 },
    uIronPrevTime: { value: 0 },
    uIronCamPos: { value: new THREE.Vector3() },
    uIronScreen: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uIronSceneDepth: { value: null },
    uIronSoftGlobal: { enabled: 0, near: 0.1, far: 1000 },
  };
}

/**
 * Surfaces whose shading response needs a separate sheen lobe. LOOK_SPEC §4.7:
 * without one, cloth reads as plastic, and a uniform edge is visible in every
 * reference frame. Three's `sheen` is a real Charlie-distribution lobe, so this
 * is two uniforms rather than a hand-rolled rim hack.
 */
const SHEEN_SURFACES: ReadonlySet<SurfaceId> = new Set([
  SurfaceId.Fabric,
  SurfaceId.Tarp,
  SurfaceId.Sandbag,
  SurfaceId.Rope,
  SurfaceId.Kevlar,
]);

/**
 * Default detail-normal frequency multiplier per material, in repeats per metre
 * BEFORE `MaterialSpec.detailScale` scales it. 20 rep/m is a 5 cm feature,
 * which is the middle of LOOK_SPEC §4.1's 2–6 cm detail band; the micro band
 * sits a further 6× up at ~8 mm and fades in inside 1.2 m.
 */
const DETAIL_BASE_FREQ = 20;
const MICRO_MULTIPLIER = 6;

export interface IronMaterialOptions {
  readonly spec: MaterialSpec;
  readonly textures: TextureSet;
  readonly globals: IronGlobals;
  readonly deforms: DeformChunkRegistry;
  readonly surfaceChunk?: SurfaceChunk;
  /** Anisotropic maximum for the sampler, from the quality tier. */
  readonly anisotropy: number;
}

export interface IronMaterialResult {
  readonly material: THREE.MeshPhysicalMaterial;
  /** Per-material uniform cells, so the factory can expose them to `setUniform`. */
  readonly cells: Map<string, GpuUniform>;
  readonly defines: Record<string, string>;
}

/** `MaterialFeature` bits that change GLSL, and therefore cost a permutation. */
function definesFor(spec: MaterialSpec, hasWear: boolean): Record<string, string> {
  const f = spec.features;
  const d: Record<string, string> = {};
  if (f & MaterialFeature.Triplanar) d.IRON_TRIPLANAR = '1';
  if (f & MaterialFeature.WearMask && hasWear) d.IRON_WEAR = '1';
  if (f & MaterialFeature.ParallaxOcclusion) d.IRON_PARALLAX = '1';
  if (f & MaterialFeature.AlphaFromHeight) d.IRON_ALPHA_FROM_HEIGHT = '1';
  if (f & MaterialFeature.SoftParticle) d.IRON_SOFT_PARTICLE = '1';
  if (f & MaterialFeature.DitherFade) d.IRON_DITHER_FADE = '1';
  if (f & MaterialFeature.Translucency) d.IRON_TRANSLUCENCY = '1';
  if (f & MaterialFeature.Anisotropic) d.IRON_ANISO = '1';
  return d;
}

/**
 * Wrap a lane-authored `SurfaceChunk` so its documented scope actually exists.
 *
 * The contract (`types.ts` §10) promises the chunk `vWorldPosition`, `vUv`,
 * `uResolution`, `normal` in WORLD space, `material.roughness/metalness`,
 * `diffuseColor` and `IRON_EXTRA_RADIANCE`. Half of those are either view-space
 * or not declared at all at this point in three's fragment main, so the block
 * below materialises them as locals, runs the chunk, and copies the results
 * back out. A lane that guessed the calling convention wrong gets a compile
 * error at boot instead of water lit differently from everything else.
 */
function wrapSurfaceChunk(shade: string): string {
  return /* glsl */ `
  {
    IronLaneMaterial material;
    material.roughness = ironRoughness;
    material.metalness = ironMetalness;
    vec3 normal = ironNormalW;
    vec3 vWorldPosition = vIronWorld;
    vec2 vUv = vIronUv;
    vec2 uResolution = 1.0 / uIronScreen;
${shade}
    ironRoughness = clamp( material.roughness, 0.03, 1.0 );
    ironMetalness = clamp( material.metalness, 0.0, 1.0 );
    ironNormalW = normalize( normal );
  }
`;
}

const LANE_MATERIAL_STRUCT = /* glsl */ `
struct IronLaneMaterial { float roughness; float metalness; };
`;

export function buildIronMaterial(opts: IronMaterialOptions): IronMaterialResult {
  const { spec, textures, globals } = opts;
  const f = spec.features;

  const albedoHeight = textures.albedoHeight;
  const normalRoughAo = textures.normalRoughAo;
  const wear = textures.wear ?? normalRoughAo;
  for (const t of [albedoHeight, normalRoughAo, wear]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    if (t.anisotropy < opts.anisotropy) t.anisotropy = opts.anisotropy;
  }

  const hasWear = textures.wear !== undefined;
  const defines = definesFor(spec, hasWear);

  // Metres per repeat. `tilingScale` > 1 means "smaller features", which is how
  // a lane asks for the same material at a different physical scale.
  const tiling = Math.max(0.05, textures.tiling / Math.max(spec.tilingScale ?? 1, 1e-3));
  const detailFreq = DETAIL_BASE_FREQ * Math.max(spec.detailScale ?? 1, 0.05);

  const tintColor = new THREE.Color();
  let tintStrength = 0;
  if (spec.baseColor !== undefined) {
    tintColor.set(spec.baseColor as THREE.ColorRepresentation);
    tintColor.convertSRGBToLinear();
    // 0.8, not 1.0: the bake's own colour variation is part of what makes the
    // surface read as material rather than paint, and a full-strength tint
    // would flatten every wall to one chroma.
    tintStrength = 0.8;
  }

  const wearBias = spec.wearBias ?? 0.4;
  const metalness = spec.metalness ?? textures.metalness;
  const roughness = spec.roughness ?? 0.85;

  // Per-instance jitter. Deliberately small: LOOK_SPEC's macro band is ±8 % and
  // anything past that reads as different materials rather than as one material
  // weathered differently. Zero for anything that must match exactly (glass,
  // emissive), where the variation would read as a manufacturing defect.
  const suppressVariation = (f & MaterialFeature.Emissive) !== 0 || spec.surface === SurfaceId.Glass;
  const hueJitter = suppressVariation ? 0 : 0.05;
  const valueJitter = suppressVariation ? 0 : 0.09;
  const roughJitter = suppressVariation ? 0 : 0.08;

  const cells = new Map<string, GpuUniform>();
  const own: Record<string, GpuUniform> = {
    uIronAlbedoHeight: { value: albedoHeight },
    uIronNormalRoughAo: { value: normalRoughAo },
    uIronWearMap: { value: wear },
    uIronTiling: { value: new THREE.Vector4(tiling, detailFreq, MICRO_MULTIPLIER, 4.0) },
    uIronDetail: {
      value: new THREE.Vector4(
        // Detail amplitude. Stone and stucco carry more relief than metal or
        // glass, so it rides the material's own roughness.
        0.55 * THREE.MathUtils.clamp(roughness + 0.2, 0.2, 1.1),
        0.32,
        // Fade distances: detail is gone by 14 m, micro by 2.4 m. Past those a
        // 5 cm feature is sub-pixel and is pure aliasing.
        14,
        2.4,
      ),
    },
    uIronWearP: {
      // Wetness is a MATERIAL STATE, not a global: the tide line, the boat ramp
      // and the spray zone at the breakwater are wet while the street two
      // metres away is not, and LOOK_SPEC §4.5's mask has to move with the
      // geometry. A lane retunes it through `setUniform('uIronWearP', …)`.
      value: new THREE.Vector4(
        wearBias,
        wearBias * 0.85 + 0.15,
        wearBias * 0.7 + 0.2,
        f & MaterialFeature.Wetness ? 0.8 : spec.surface === SurfaceId.WetSand ? 0.6 : 0,
      ),
    },
    uIronTint: { value: new THREE.Vector4(tintColor.r, tintColor.g, tintColor.b, tintStrength) },
    uIronVary: {
      value: new THREE.Vector4(hueJitter, valueJitter, roughJitter, ((spec.tintSeed ?? 0) % 997) + 1),
    },
    uIronMat: {
      value: new THREE.Vector4(
        roughness,
        metalness,
        roughCentreOf(textures),
        // Parallax depth in metres. A weapon's relief is millimetres; a wall's
        // mortar course is over a centimetre, and `detailScale` is the only
        // signal in the spec for which of the two this is.
        (spec.detailScale ?? 1) > 8 ? 0.002 : 0.012,
      ),
    },
    uIronSoft: { value: new THREE.Vector4(spec.softFadeDistance ?? 0.5, 0, 0.1, 1000) },
  };
  for (const [name, cell] of Object.entries(own)) cells.set(name, cell);

  const material = new THREE.MeshPhysicalMaterial({
    // White: albedo is resolved entirely in the shader, and leaving a tint here
    // would multiply it a second time.
    color: 0xffffff,
    roughness,
    metalness,
    side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: spec.transparent === true,
    alphaTest: spec.alphaTest ?? 0,
    flatShading: false,
    // Dielectric F0. LOOK_SPEC §4.2 wants 0.04 on stone and stucco (ior 1.5)
    // and higher on glass; `specular` arrives as 0..1 over the physical 0..0.08.
    ior: spec.ior ?? 1.5,
  });
  if (spec.specular !== undefined) material.specularIntensity = THREE.MathUtils.clamp(spec.specular, 0, 1);
  material.name = spec.id;

  if (SHEEN_SURFACES.has(spec.surface)) {
    material.sheen = 0.55;
    material.sheenRoughness = 0.45;
    // Warm, low-saturation: a dusty webbing rim, not a satin one.
    material.sheenColor = new THREE.Color(0.55, 0.5, 0.44);
  }
  if (spec.emissive !== undefined) {
    material.emissive = new THREE.Color(spec.emissive as THREE.ColorRepresentation);
    material.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  if (f & MaterialFeature.AlphaClip && material.alphaTest === 0) material.alphaTest = 0.5;

  const deform = spec.deform !== undefined ? opts.deforms.get(spec.deform) : undefined;
  const surfaceShade = opts.surfaceChunk;

  material.onBeforeCompile = (shader) => {
    for (const [name, cell] of Object.entries(own)) {
      shader.uniforms[name] = cell as THREE.IUniform;
    }
    shader.uniforms.uIronTime = globals.uIronTime as THREE.IUniform;
    shader.uniforms.uIronPrevTime = globals.uIronPrevTime as THREE.IUniform;
    shader.uniforms.uIronCamPos = globals.uIronCamPos as THREE.IUniform;
    shader.uniforms.uIronScreen = globals.uIronScreen as THREE.IUniform;
    shader.uniforms.uIronSceneDepth = globals.uIronSceneDepth as THREE.IUniform;
    for (const [name, cell] of Object.entries(spec.uniforms ?? {})) {
      shader.uniforms[name] = cell as THREE.IUniform;
    }

    /* ------------------------------------------------------------- vertex */
    let vs = shader.vertexShader;
    vs = vs.replace(
      '#include <common>',
      `#include <common>\n${IRON_VERTEX_PARS}\n${deform?.common ?? ''}`,
    );
    vs = vs.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${deform ? deform.displace : ''}`,
    );
    vs = vs.replace(
      '#include <project_vertex>',
      `${deform ? IRON_VERTEX_RENORMAL : ''}\n#include <project_vertex>\n${IRON_VERTEX_WORLD}`,
    );

    /* ----------------------------------------------------------- fragment */
    let fs = shader.fragmentShader;
    fs = fs.replace(
      '#include <common>',
      `#include <common>\n${LANE_MATERIAL_STRUCT}\n${IRON_FRAGMENT_PARS}\n${surfaceShade?.common ?? ''}`,
    );
    fs = fs.replace(
      '#include <map_fragment>',
      `vec3 IRON_EXTRA_RADIANCE = vec3( 0.0 );\n${IRON_SURFACE}\n${
        surfaceShade ? wrapSurfaceChunk(surfaceShade.shade) : ''
      }`,
    );
    fs = fs.replace('#include <roughnessmap_fragment>', IRON_ROUGHNESS);
    fs = fs.replace('#include <metalnessmap_fragment>', IRON_METALNESS);
    fs = fs.replace('#include <normal_fragment_maps>', IRON_NORMAL_APPLY);
    fs = fs.replace(
      '#include <aomap_fragment>',
      `${IRON_AO_AND_SHEEN}\n${f & MaterialFeature.Translucency ? IRON_TRANSLUCENCY : ''}`,
    );
    fs = fs.replace(
      '#include <opaque_fragment>',
      `outgoingLight += IRON_EXTRA_RADIANCE;\n#include <opaque_fragment>`,
    );

    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };

  // Three's default cache key is the SOURCE TEXT of onBeforeCompile, which is
  // identical for every material built here — so without this, two materials
  // with different `#define`s would silently share one compiled program and the
  // second would render with the first's feature set.
  const cacheKey = `iron|${spec.id}|${spec.features}|${Object.keys(defines).join(',')}|${
    spec.deform ?? ''
  }|${spec.surfaceShader ?? ''}`;
  material.customProgramCacheKey = () => cacheKey;
  material.defines = { ...(material.defines ?? {}), ...defines };

  return { material, cells, defines };
}
