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
  type SurfaceChunk,
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

/* ========================================================================== */
/* THE GRASS SURFACE CHUNK                                                    */
/* ========================================================================== */

/**
 * WHY THIS CHUNK EXISTS — the "black slashes" defect, diagnosed.
 *
 * Round 0 shipped a grass field that read as flat, near-black strokes at a
 * uniform value regardless of which way any individual blade pointed. Three
 * separate causes stacked, and none of them can be fixed from the shared
 * material stack, because all three are specific to blade geometry:
 *
 *  1. THE TWO-SIDED NORMAL FLIP (the big one; fixed in `geometry.ts`, not here).
 *     A zero-thickness blade must be drawn `DoubleSide`, and the uber material
 *     then multiplies the shading normal by `gl_FrontFacing`. That drags EVERY
 *     visible grass normal into the camera's hemisphere, so on any framing more
 *     than 90° off the sun — i.e. every golden-hour hero shot in this game —
 *     N·L is negative on the entire field simultaneously and the sun term is
 *     exactly zero everywhere. The blades were lit by sky light alone, which is
 *     why they were all the same value. Blades are solids now and the material
 *     is `FrontSide`, so this is gone at the source.
 *
 *  2. THE SCREEN-DERIVATIVE TANGENT FRAME. The uber material reconstructs a
 *     tangent frame from `dFdx`/`dFdy` of the world position. On geometry one to
 *     three pixels wide those derivatives step across the blade's silhouette and
 *     sample whatever is behind it, so the frame — and the detail normal built
 *     on it — is noise. The chunk therefore throws the perturbed normal away and
 *     rebuilds the blade's authored normal from its surviving azimuth.
 *
 *  3. THE ALBEDO LEVEL. This material samples the shared FOLIAGE bake, which is
 *     authored for canopy (LOOK_SPEC §4.3: 0.06–0.14 linear), and the uber
 *     material's luminance-preserving tint only pulls it 35 % of the way toward
 *     the colour a lane asks for. Dry straw is 0.18–0.30. The blade was landing
 *     near 0.13 — a wet-season green's albedo — and no amount of light fixes an
 *     albedo that is half what it should be.
 *
 * What is NOT done here: a second translucency lobe.
 * `MaterialFeature.Translucency` stays on, and it stays the only wrapped
 * transmission term in the frame, sited inside the light loop where it belongs.
 * The tip-ward normal bend below is a different thing and does not double it: it
 * biases the blade's macroscopic reflectance lobe toward the sun, which is what
 * an optically thin blade's lobe genuinely does, and — crucially — it acts
 * INSIDE the shadowed direct-light term. An additive rim would not be shadowed,
 * and grass that glows inside a building's shadow is a worse defect than the one
 * being fixed.
 */
/**
 * The blade's albedo at its root and at its tip, ABSOLUTE linear.
 *
 * The tip sits at the top of LOOK_SPEC §4.3's dry-vegetation band (luminance
 * 0.29) and is warm and desaturated — August straw, bleached by two months of
 * sun. The root sits at 0.15 and keeps a trace of green, because the sheath is
 * the last part of the plant to dry out and because it is buried in the tuft's
 * own shade; the ramp between them IS the canopy self-shadow, and it is what
 * stops a field of blades reading as one flat colour chip.
 */
const STRAW_ROOT = 'vec3( 0.112, 0.116, 0.070 )';
const STRAW_TIP = 'vec3( 0.352, 0.292, 0.164 )';

function vegSunUniform(key: string): string {
  return `uVegSun_${key}`;
}

function vegSkyUniform(key: string): string {
  return `uVegSky_${key}`;
}

function vegBeamUniform(key: string): string {
  return `uVegBeam_${key}`;
}

/**
 * `blade` shapes the chunk for real blade geometry, whose `uv` is
 * (across the strip, root → tip). `patch` shapes it for the ground-hugging
 * distance mat, whose uv is a radial disc — the mat has to end up the same
 * COLOUR and the same average normal as the blades it is standing in for, or
 * the hand-over between the two shows up as a ring on the ground.
 */
function grassSurfaceChunk(key: 'grass' | 'mat', kind: 'blade' | 'patch'): SurfaceChunk {
  const sun = vegSunUniform(key);
  const sky = vegSkyUniform(key);
  const beam = vegBeamUniform(key);
  const p = `veg${key[0].toUpperCase()}${key.slice(1)}`;

  const common = /* glsl */ `
/** xyz: unit world vector TOWARD the sun. w: 1 while the sun is above the horizon. */
uniform vec4 ${sun};
/** rgb: sky irradiance on an unoccluded upward face, renderer units. */
uniform vec4 ${sky};
/** rgb: direct beam irradiance normal to the sun, renderer units. */
uniform vec4 ${beam};

float ${p}Luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

/**
 * The average shading normal of a grass CANOPY seen from far enough away that
 * individual blades are sub-pixel. Up, biased toward the sun: a canopy of thin
 * blades is strongly forward-scattering, so an up-only normal at an 11° sun
 * turns the far field into a dark band and puts a visible ring where the blade
 * LOD hands over to the mat.
 */
vec3 ${p}Canopy() {
  return normalize( vec3( 0.0, 1.0, 0.0 ) + ${sun}.xyz * 0.55 * ${sun}.w );
}
`;

  const param =
    kind === 'blade'
      ? /* glsl */ `
  // On a blade, vUv is ( across the strip, root to tip ) — see stripe() in
  // geometry.ts. It is the only per-blade parameter a fragment can have.
  float ${p}T = clamp( vUv.y, 0.0, 1.0 );`
      : /* glsl */ `
  // The mat is a domed 7-gon with a radial uv. Its centre stands in for the top
  // of the canopy and its rim for the litter layer, so the same ramp applies —
  // but compressed into the middle of it, because a mat is an AVERAGE over a
  // patch of blades and a full root-to-tip swing across one 2 m polygon reads
  // as a blob rather than as ground cover.
  float ${p}T = clamp( 0.74 - length( vUv - 0.5 ) * 0.58, 0.0, 1.0 );`;

  const normalBlock =
    kind === 'blade'
      ? /* glsl */ `
  // Rebuild the blade's AUTHORED normal from the azimuth of the incoming one.
  // The perturbation the shared stack applied is a rotation of at most ~35°, so
  // the azimuth survives it while the elevation — the part that decides how much
  // sky the blade sees — does not. 0.80 outward / 0.62 up is what grass.ts
  // wrote into the mesh.
  vec2 ${p}H = ${p}N.xz;
  float ${p}HL = length( ${p}H );
  if ( ${p}HL > 1e-3 ) {
    ${p}H /= ${p}HL;
    ${p}N = normalize( vec3( ${p}H.x * 0.80, 0.62, ${p}H.y * 0.80 ) );
    // Cross-blade curl. A blade is a shallow trough, not a plane; swinging the
    // normal across its width gives it a highlight that travels along the blade
    // as the camera moves. A flat facet gives a field that flips between two
    // values as you turn, which is the cardboard look.
    vec3 ${p}Side = normalize( cross( vec3( 0.0, 1.0, 0.0 ), ${p}N ) );
    ${p}N = normalize( ${p}N + ${p}Side * ( vUv.x * 2.0 - 1.0 ) * 0.42 );
  }
  // TRANSMISSION, as a lobe bias rather than an additive rim.
  //
  // A 0.2 mm blade of dry grass transmits most of what lands on its far side, so
  // its MACROSCOPIC reflectance lobe is pulled hard toward the sun on both
  // faces. This matters more than it sounds: from any camera you predominantly
  // see the blade faces pointing AT you, and on a cross-sun or contre-jour
  // framing those faces are the ones turned away from the sun. Without a
  // transmission term the visible half of every tuft is unlit by construction
  // and the field reads as dark stalks on bright ground, which is what the first
  // two passes of this fix still showed.
  //
  // At 0.92 the anti-sun face lands at N·L ≈ 0.22 and the sunward face at ≈ 0.93
  // — a 4:1 lit-to-shaded ratio, which keeps the two-lobe read while lifting the
  // shaded face to roughly the value of the soil it is standing on. Bending the
  // NORMAL rather than adding radiance keeps all of it inside the direct term,
  // so the cascades still shadow it and grass does not glow indoors.
  ${p}N = normalize( ${p}N + ${sun}.xyz * ( 0.30 + 0.62 * ${p}Tip ) * ${sun}.w );`
      : /* glsl */ `
  ${p}N = normalize( mix( ${p}N, ${p}Canopy(), 0.75 ) );`;

  const shade = /* glsl */ `
${param}
  float ${p}Tip = smoothstep( 0.08, 0.95, ${p}T );
  float ${p}Dist = length( cameraPosition - vWorldPosition );
  vec3 ${p}N = normal;

${normalBlock}

  // Past ~40 m a tuft is a couple of pixels and its individual normal is pure
  // aliasing; the field has to shade as one canopy surface instead. This is also
  // what makes the blade layer and the distance mat agree in value across the
  // hand-over band rather than showing a ring.
  float ${p}Mass = smoothstep( 12.0, 42.0, ${p}Dist );
  normal = normalize( mix( ${p}N, ${p}Canopy(), ${p}Mass * 0.7 ) );

  // Absolute albedo, LOOK_SPEC §4.3's dry-vegetation band. Only the bake's
  // RELATIVE variation is kept — its level is wrong for straw by construction.
  float ${p}L = max( ${p}Luma( diffuseColor.rgb ), 1e-4 );
  float ${p}Var = clamp( ${p}L / 0.13, 0.72, 1.35 );
  vec3 ${p}Ramp = mix( ${STRAW_ROOT}, ${STRAW_TIP}, pow( ${p}T, 1.05 ) );
  diffuseColor.rgb = ${p}Ramp * mix( 1.0, ${p}Var, 0.32 );

  // Straw is matte at the sheath and waxy along the blade: the tip carries the
  // low-sun sheen that separates a grass field from bare dirt. Lifted back to
  // matte with distance or a sub-pixel blade sparkles and TAA cannot fix it.
  material.roughness = mix( mix( 0.82, 0.62, ${p}Tip ), 0.93, ${p}Mass );
  material.metalness = 0.0;

  /* ---- the light a one-centimetre blade actually receives -------------------
   *
   * THIS IS THE TERM THAT ACTUALLY FIXES THE BLACK GRASS, and it took three
   * measured passes to find out why. Everything above — solid blades, the
   * rebuilt normal, the straw albedo — is necessary and none of it was
   * sufficient, because on a contre-jour framing the blade faces a camera can
   * SEE are, by construction, the ones turned away from the sun and therefore
   * sitting inside their own tuft's shadow. No amount of lobe bias reaches
   * them: the cascade has already multiplied the beam to zero. Measured on
   * veg_field, blades sat at 6 % of the radiance of the soil they stand in.
   *
   * So the two things that genuinely light a blade in that situation are added
   * here, outside the occlusion chain, in real photometric units taken from
   * LightingService rather than as a constant lift:
   *
   * 1. SKY FILL. Both occlusion terms the shared stack applies are wrong for
   *    grass and wrong in the same direction. ironAo is the FOLIAGE bake's
   *    cavity AO, authored for a leaf cluster; a blade has no cavities. GTAO
   *    marches a metre-scale radius across geometry thinner than one of its
   *    texels. Together they were removing most of the sky light from every
   *    blade — and at a 10° sun, sky light IS a near-vertical surface's light.
   *
   * 2. TRANSMISSION. LOOK_SPEC §4.7: backlit vegetation is brighter and more
   *    saturated than reflection permits. A 0.2 mm blade passes most of what
   *    lands on its far face. This is the golden-hour rim, and it is the single
   *    biggest difference between our field and the reference's.
   *
   * The honest cost: neither term is shadowed, so a blade standing inside a
   * building's shadow with the sun behind it still catches some rim. The sky
   * fill is correct that way (sky light is not occluded by the sun cascade);
   * the transmission term is not, and it is kept deliberately narrow — squared
   * in the view-to-sun cosine and weighted to the tip — so it only fires in the
   * framing it is modelling.
   */
  // Sky fill: a FLOOR, not the field's main light. Pushed any higher it lights
  // every blade in the frame by the same amount, the two-lobe read collapses,
  // and the field goes back to being one flat value — the opposite failure to
  // the one this whole pass started from, and just as readable.
  float ${p}Open = 0.18 + 0.36 * ${p}Tip;
  IRON_EXTRA_RADIANCE += ${sky}.rgb * diffuseColor.rgb * RECIPROCAL_PI * ${p}Open;

  // Transmission, wrapped. The wrap is what keeps the field's SHAPE: a blade
  // turned toward the sun passes and reflects three times what one turned away
  // does, so the tufts still have a sunward face and a sky-lit face even though
  // neither is coming through the cascade. Squared in the view-to-sun cosine, so
  // it is a contre-jour term and nearly absent when the camera looks down-sun.
  vec3 ${p}Vw = normalize( vWorldPosition - cameraPosition );
  float ${p}Back = clamp( dot( ${p}Vw, ${sun}.xyz ), 0.0, 1.0 );
  float ${p}Wrap = 0.32 + 0.68 * clamp( dot( normal, ${sun}.xyz ) * 0.5 + 0.5, 0.0, 1.0 );
  IRON_EXTRA_RADIANCE += ${beam}.rgb * diffuseColor.rgb * RECIPROCAL_PI
    * ${p}Back * ${p}Back * ${p}Wrap * ( 0.28 + 0.72 * ${p}Tip ) * ${sun}.w;
`;

  return { common, shade };
}

/**
 * Live uniform cells for one material, kept so the runtime can push per frame.
 */
export interface VegMaterialCells {
  readonly strength?: GpuUniform<number>;
  /** xyz world direction toward the sun, w = sun-up gate. Pushed every frame. */
  readonly sun?: GpuUniform<THREE.Vector4>;
  /** rgb sky irradiance on an unoccluded upward face. Pushed every frame. */
  readonly sky?: GpuUniform<THREE.Vector4>;
  /** rgb direct beam irradiance normal to the sun. Pushed every frame. */
  readonly beam?: GpuUniform<THREE.Vector4>;
}

/** The three live cells a lit-vegetation surface chunk needs, made as a set. */
function vegLightCells(): {
  sun: GpuUniform<THREE.Vector4>;
  sky: GpuUniform<THREE.Vector4>;
  beam: GpuUniform<THREE.Vector4>;
} {
  return {
    sun: { value: new THREE.Vector4(0, 1, 0, 0) },
    sky: { value: new THREE.Vector4(0, 0, 0, 0) },
    beam: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
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

  const foliage = (
    key: Exclude<VegMaterialKey, 'mat' | 'bark'>,
    baseColor: number,
    roughness: number,
    extra?: {
      readonly surfaceShader: string;
      readonly light: ReturnType<typeof vegLightCells>;
    },
  ): void => {
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
      // Blades are 1 mm SOLIDS, so both faces exist in the mesh with their own
      // outward normals and the material must NOT be double-sided: three's
      // gl_FrontFacing flip is what zeroed the sun term across the whole field.
      // See the header of `grassSurfaceChunk` and of `stripe()` in geometry.ts.
      doubleSided: extra === undefined,
      instanced: true,
      deform: deformName(key),
      surfaceShader: extra?.surfaceShader,
      uniforms: extra
        ? {
            [`uVegStrength_${key}`]: strength,
            [vegSunUniform(key)]: extra.light.sun,
            [vegSkyUniform(key)]: extra.light.sky,
            [vegBeamUniform(key)]: extra.light.beam,
          }
        : { [`uVegStrength_${key}`]: strength },
    };
    material[key] = materials.create(spec);
    cells[key] = extra ? { strength, ...extra.light } : { strength };
  };

  foliage('frond', BASE.frond, 0.78);
  foliage('leaf', BASE.leaf, 0.80);

  materials.registerSurface('veg.blade', grassSurfaceChunk('grass', 'blade'));
  materials.registerSurface('veg.patch', grassSurfaceChunk('mat', 'patch'));
  const grassLight = vegLightCells();
  const matLight = vegLightCells();
  foliage('grass', BASE.grass, 0.86, { surfaceShader: 'veg.blade', light: grassLight });

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
  // translucency, no cost. It DOES take the same albedo ramp and the same canopy
  // normal as the blades, because it is standing in for them: two layers that
  // hand over across a band have to agree on colour and on how they take the
  // light, or the hand-over is a ring on the ground.
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
    surfaceShader: 'veg.patch',
    uniforms: {
      [vegSunUniform('mat')]: matLight.sun,
      [vegSkyUniform('mat')]: matLight.sky,
      [vegBeamUniform('mat')]: matLight.beam,
    },
  });
  cells.mat = { ...matLight };

  return { material, cells };
}
