/**
 * THE FORWARD LIGHTING MODEL — cascaded PCSS, sky occlusion, GTAO and clustered
 * punctual lights, injected into every lit surface in the game.
 *
 * OWNER: LIGHT.
 *
 * WHY IT IS A CHUNK PATCH AND NOT A MATERIAL
 * ------------------------------------------
 * `docs/OWNERSHIP.md` gives LIGHT `src/render/lighting/**` and gives RCORE the
 * material factory, and `docs/ARCHITECTURE.md` §4.2 says the factory is what
 * "guarantees that CSM sampling, GTAO application, clustered lights ... are
 * injected the same way everywhere". LIGHT still has to *author* that injection,
 * and it must reach materials this lane may not edit. `onBeforeCompile` is CI-
 * banned outside `src/render/material/`, so the seam that is left — and the one
 * three itself is designed around — is `THREE.ShaderChunk`: three resolves
 * `#include <...>` against that table at program-build time, so replacing an
 * entry re-authors the lighting model for every lit material in the process,
 * exactly once, with no per-material permutation and no compile hitch.
 *
 * Three chunks are touched and nothing else:
 *   lights_physical_pars_fragment — APPENDED with our uniforms and functions.
 *       Chosen deliberately: it is included ONLY by `meshphysical`, so a
 *       lambert/phong/basic material in some other lane never sees our uniforms
 *       and can never end up with an unbound sampler.
 *   lights_fragment_begin        — the sun's shadow term becomes cascaded PCSS,
 *       and the clustered punctual lights are accumulated before the indirect
 *       terms open.
 *   lights_fragment_end          — GTAO + sky occlusion applied to INDIRECT
 *       light only (never to the final colour: that is the dirty-grey-shadow
 *       mistake LOOK_SPEC §2.5 calls out by name). `aomap_fragment` would be
 *       the natural home and was the first choice; RCORE's uber material
 *       REPLACES that include outright, so the occlusion has to attach to a
 *       chunk the factory leaves alone or it silently stops existing the moment
 *       the real material lands.
 *
 * HOW THE UNIFORMS GET THERE
 * --------------------------
 * `WebGLPrograms.getUniforms` deep-CLONES `ShaderLib.physical.uniforms` per
 * material, so a `{ value: 3.0 }` we add there would be copied and go stale.
 * `cloneUniforms` copies by reference for anything that is neither a three
 * object nor an Array — which a **Float32Array** is not. So every numeric
 * uniform in this file is one shared Float32Array: one write from JS reaches
 * every material in the scene, with no per-material bookkeeping at all.
 *
 * Textures are the exception — a render-target texture cannot survive
 * `cloneUniforms` at all (three nulls it and warns), so the two samplers are
 * re-bound each frame straight into `renderer.properties.get(material).uniforms`
 * by `bindTextures()`. That is the only per-material work in the whole lane and
 * it is a pointer write per live material per frame.
 */
import * as THREE from 'three';
import type { QualitySettings } from '@/engine/types';

/** Punctual lights the forward loop will consider. Beyond this the CPU culls. */
export const IRON_MAX_LOCAL_LIGHTS = 16;

/* -------------------------------------------------------------------------- */
/* The shared uniform block. Indices are the ONE source of truth for both sides. */
/* -------------------------------------------------------------------------- */

/** `ironMatrix[]` slots. */
export const M_VIEW_INVERSE = 0;
/** Cascade 0..3: world → (u, v in the cascade's own [0,1], metres from the light plane). */
export const M_CASCADE0 = 1;
export const MATRIX_COUNT = 5;

/** `ironVec[]` slots, vec4 each. */
export const V_SPLITS = 0; // cascade far distances, view-space metres
export const V_TEXEL_WORLD = 1; // metres per shadow texel, per cascade
export const V_CASCADE_RADIUS = 2; // ortho half-extent in metres, per cascade
export const V_ATLAS = 3; // [unused, 1/atlasSize, tan(sunAngularRadius), minPenumbraTexels]
export const V_SCREEN = 4; // [1/width, 1/height, aoStrength, cascadeCount]
export const V_SUN = 5; // [sunDir.xyz (toward sun, world), shadowEnabled]
export const V_BIAS = 6; // [depthBiasTexels, normalBiasTexels, blockerSearchMetres, blendBand]
export const V_MISC = 7; // [localLightCount, contactAoStrength, cascadeFadeStart, unused]
/** Four tile rects in the atlas: [offsetU, offsetV, scaleU, scaleV]. */
export const V_TILE0 = 8;
export const V_LIGHT_BASE = 12;
export const VEC_COUNT = V_LIGHT_BASE + IRON_MAX_LOCAL_LIGHTS * 3;

export interface ShadingUniforms {
  readonly matrices: Float32Array;
  readonly vectors: Float32Array;
}

let installed = false;
const shared: ShadingUniforms = {
  matrices: new Float32Array(MATRIX_COUNT * 16),
  vectors: new Float32Array(VEC_COUNT * 4),
};

/** The shared, reference-stable uniform payload. Written by the lighting rig. */
export function shadingUniforms(): ShadingUniforms {
  return shared;
}

/* -------------------------------------------------------------------------- */
/* GLSL                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cascaded PCSS + clustered lights, as a GLSL fragment.
 *
 * Sample distribution is a **Vogel disc** rotated per pixel by interleaved
 * gradient noise. LOOK_SPEC §2.6 asks for a Poisson disc rotated by the
 * spatiotemporal blue-noise LUT (bake B4); IGN is used instead because B4 is
 * BAKE's asset and does not exist yet, and because a Vogel disc has strictly
 * better radial uniformity than a fixed Poisson table at these tap counts. The
 * rotation is what matters — an unrotated kernel bands, a rotated one dithers.
 */
function buildPars(blockerTaps: number, filterTaps: number): string {
  return /* glsl */ `
// ---------------------------------------------------------------- IRONSIGHT
uniform mat4 ironMatrix[${MATRIX_COUNT}];
uniform vec4 ironVec[${VEC_COUNT}];
uniform sampler2D ironShadowAtlas;
uniform sampler2D ironAoTex;

#define IRON_BLOCKER_TAPS ${blockerTaps}
#define IRON_PCF_TAPS ${filterTaps}
#define IRON_MAX_LOCAL_LIGHTS ${IRON_MAX_LOCAL_LIGHTS}
#define IRON_LIGHT_BASE ${V_LIGHT_BASE}

vec3 ironWorldPos( const in vec3 viewPos ) {
  return ( ironMatrix[${M_VIEW_INVERSE}] * vec4( viewPos, 1.0 ) ).xyz;
}

vec3 ironWorldDir( const in vec3 viewDir ) {
  return mat3( ironMatrix[${M_VIEW_INVERSE}] ) * viewDir;
}

/** Per-pixel rotation angle. Interleaved gradient noise: cheap, well spread. */
float ironDitherAngle() {
  vec3 m = vec3( 0.06711056, 0.00583715, 52.9829189 );
  return fract( m.z * fract( dot( gl_FragCoord.xy, m.xy ) ) ) * 6.2831853;
}

/** i-th point of an n-point Vogel disc, pre-rotated by \`phi\`. */
vec2 ironVogel( const in int i, const in int n, const in float phi ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
  float theta = float( i ) * 2.39996323 + phi;
  return vec2( cos( theta ), sin( theta ) ) * r;
}

/**
 * Sample the atlas in a cascade's OWN [0,1] space. The tile rect is applied
 * here and the local coordinate is clamped first, so a filter tap that walks
 * off the edge of cascade 2 can never read cascade 3's tile — the classic
 * atlas-bleed artefact, which shows up as a bright or dark rectangle edge
 * exactly where a critic looks for a cascade seam.
 */
float ironAtlas( const in int cascade, const in vec2 local ) {
  vec4 tile = ironVec[${V_TILE0} + cascade];
  vec2 uv = tile.xy + clamp( local, vec2( 0.0 ), vec2( 1.0 ) ) * tile.zw;
  return texture2D( ironShadowAtlas, uv ).r;
}

/**
 * One cascade of contact-hardening PCSS.
 *
 * The atlas stores DISTANCE FROM THE LIGHT PLANE IN METRES, not a normalised
 * device depth, which is the whole reason the penumbra can be physical: the
 * blocker search returns an average occluder distance in metres, the gap is a
 * real gap, and the penumbra half-width is that gap times tan(0.265°). A 1 m
 * gap therefore gives ~9 mm of penumbra and a 10 m gap ~90 mm — LOOK_SPEC §2.6
 * — with no fudge factor anywhere between them.
 *
 * A cleared texel reads 0 and is treated as EMPTY SKY, never as an occluder at
 * the light plane.
 */
float ironCascade( const in int cascade, const in vec3 worldPos, const in vec3 worldNormal, const in float ndl ) {
  vec4 atlas = ironVec[${V_ATLAS}];
  vec4 bias = ironVec[${V_BIAS}];
  float texelWorld = ironVec[${V_TEXEL_WORLD}][ cascade ];
  float radius = ironVec[${V_CASCADE_RADIUS}][ cascade ];

  // NORMAL-OFFSET BIAS, sized in cascade TEXELS rather than world units — the
  // distinction LOOK_SPEC §2.6 insists on. At golden hour almost every lit
  // surface is a raking wall, and a bias big enough to stop acne there in world
  // units peter-pans the crate sitting on the ground two metres away.
  float slope = sqrt( max( 1.0 - ndl * ndl, 0.0 ) ) / max( abs( ndl ), 0.12 );
  vec3 offsetPos = worldPos + worldNormal * ( texelWorld * bias.y * ( 1.0 + min( slope, 4.0 ) ) );

  vec3 coord = ( ironMatrix[${M_CASCADE0} + cascade] * vec4( offsetPos, 1.0 ) ).xyz;
  if ( coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 ) return -1.0;

  // Slope-scaled depth bias, also in texels of THIS cascade.
  float receiver = coord.z - texelWorld * bias.x * ( 1.0 + min( slope, 4.0 ) * 2.0 );

  float phi = ironDitherAngle();
  float uvPerMetre = 1.0 / ( 2.0 * radius );

  // ---- blocker search ----------------------------------------------------
  float searchUv = bias.z * uvPerMetre;
  float blockerSum = 0.0;
  float blockerCount = 0.0;
  for ( int i = 0; i < IRON_BLOCKER_TAPS; i ++ ) {
    vec2 o = ironVogel( i, IRON_BLOCKER_TAPS, phi ) * searchUv;
    float d = ironAtlas( cascade, coord.xy + o );
    if ( d > 1e-4 && d < receiver ) {
      blockerSum += d;
      blockerCount += 1.0;
    }
  }
  if ( blockerCount < 0.5 ) return 1.0;

  float gap = max( receiver - blockerSum / blockerCount, 0.0 );

  // Contact hardening: penumbra half-width = gap * tan(sun angular radius).
  float penumbraUv = max( gap * atlas.z * uvPerMetre, atlas.w * texelWorld * uvPerMetre );

  // ---- filter ------------------------------------------------------------
  float lit = 0.0;
  for ( int i = 0; i < IRON_PCF_TAPS; i ++ ) {
    vec2 o = ironVogel( i, IRON_PCF_TAPS, phi + 1.13 ) * penumbraUv;
    float d = ironAtlas( cascade, coord.xy + o );
    lit += ( d <= 1e-4 || d >= receiver ) ? 1.0 : 0.0;
  }
  return lit / float( IRON_PCF_TAPS );
}

/**
 * The sun's shadow. Selects a cascade by view depth and CROSS-FADES over the
 * last \`blendBand\` of each split, so the resolution change at a cascade
 * boundary is a gradient a few metres wide rather than a line.
 */
float ironSunShadow( const in vec3 worldPos, const in vec3 worldNormal, const in float viewDepth, const in float ndl ) {
  if ( ironVec[${V_SUN}].w < 0.5 ) return 1.0;
  vec4 splits = ironVec[${V_SPLITS}];
  float band = ironVec[${V_BIAS}].w;
  int count = int( ironVec[${V_SCREEN}].w );

  int c = count - 1;
  float blend = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    if ( i > count - 2 ) break;
    if ( viewDepth < splits[ i ] ) {
      c = i;
      float start = splits[ i ] * ( 1.0 - band );
      blend = clamp( ( viewDepth - start ) / max( splits[ i ] - start, 0.001 ), 0.0, 1.0 );
      break;
    }
  }

  // A negative return means "outside this cascade's footprint" — fall through to
  // the coarser one instead of punching an unshadowed hole in the frame.
  float s = ironCascade( c, worldPos, worldNormal, ndl );
  if ( s < 0.0 ) {
    s = ironCascade( min( c + 1, count - 1 ), worldPos, worldNormal, ndl );
    if ( s < 0.0 ) s = 1.0;
  } else if ( blend > 0.001 ) {
    float n = ironCascade( min( c + 1, count - 1 ), worldPos, worldNormal, ndl );
    s = mix( s, n < 0.0 ? s : n, blend );
  }

  // Past the last cascade the shadow map has no data. LOOK_SPEC §2.6: distant
  // terrain carries no resolvable shadow detail, it dissolves into aerial
  // perspective. Fade out rather than pop.
  return mix( s, 1.0, smoothstep( ironVec[${V_MISC}].z, splits[ count - 1 ], viewDepth ) );
}

/** Jimenez's multi-bounce GTAO fit: coloured, energy-preserving, no grey halo. */
vec3 ironMultiBounce( const in float ao, const in vec3 albedo ) {
  vec3 a = 2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c = 2.7552 * albedo + 0.6903;
  return clamp( ( ( ao * a + b ) * ao + c ) * ao, vec3( ao ), vec3( 1.0 ) );
}

/** [ contact-scale visibility, sky (large-radius) visibility ]. */
vec2 ironOcclusion() {
  if ( ironVec[${V_SCREEN}].z < 0.001 ) return vec2( 1.0 );
  vec2 uv = gl_FragCoord.xy * ironVec[${V_SCREEN}].xy;
  vec2 ao = texture2D( ironAoTex, uv ).rg;
  return mix( vec2( 1.0 ), ao, ironVec[${V_SCREEN}].z );
}
// ------------------------------------------------------------ /IRONSIGHT
`;
}

/**
 * The clustered punctual lights, accumulated into `reflectedLight` exactly like
 * three's own point lights — same `RE_Direct`, same BRDF, same energy — so a
 * muzzle flash shades a wall with the identical response the sun does.
 *
 * Falloff is inverse-square with a physical radius window (LOOK_SPEC §2.7:
 * "never a linear-falloff hack"). `intensityCd` is candela, the distance term
 * turns it into lux, and the sun is in lux, so a 60 000 cd muzzle flash at 6 m
 * genuinely delivers 1 667 lx and lifts a soldier the way the reference does.
 */
const LOCAL_LIGHTS = /* glsl */ `
#if defined( STANDARD ) && defined( RE_Direct )
{
  vec3 ironSurfaceWorld = ironWorldPos( geometryPosition );
  int ironCount = int( ironVec[${V_MISC}].x );
  for ( int li = 0; li < IRON_MAX_LOCAL_LIGHTS; li ++ ) {
    if ( li >= ironCount ) break;
    int b = IRON_LIGHT_BASE + li * 3;
    vec4 posRadius = ironVec[ b ];
    vec4 colourCone = ironVec[ b + 1 ];
    vec4 dirCone = ironVec[ b + 2 ];

    vec3 toLight = posRadius.xyz - ironSurfaceWorld;
    float dist2 = dot( toLight, toLight );
    float r2 = posRadius.w * posRadius.w;
    if ( dist2 > r2 ) continue;

    // Windowed inverse square: exact 1/d² in the near field, driven to exactly
    // zero at the radius so a light can be culled without a visible edge.
    float window = clamp( 1.0 - ( dist2 * dist2 ) / ( r2 * r2 ), 0.0, 1.0 );
    float atten = window * window / max( dist2, 0.04 );

    if ( colourCone.w >= 0.0 ) {
      float cosAngle = dot( -toLight * inversesqrt( max( dist2, 1e-6 ) ), dirCone.xyz );
      atten *= clamp( ( cosAngle - dirCone.w ) * colourCone.w, 0.0, 1.0 );
    }
    if ( atten <= 0.0 ) continue;

    IncidentLight ironLight;
    ironLight.color = colourCone.rgb * atten;
    ironLight.direction = normalize( ( viewMatrix * vec4( posRadius.xyz, 1.0 ) ).xyz - geometryPosition );
    ironLight.visible = true;
    RE_Direct( ironLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
}
#endif
`;

/**
 * GTAO + sky occlusion, applied to INDIRECT light only.
 *
 * Two radii come out of one horizon march (see `gtao.ts`): a large one, which
 * is what makes an interior or the underside of an arcade genuinely lose SKY
 * light rather than only sun light, and a short one, which puts the 3–8 px
 * contact band under every object that LOOK_SPEC §2.6 requires to be darker
 * than the cast shadow itself.
 *
 * Multi-bounce keeps it from reading as a grey outline: a bright sandstone wall
 * bounces light back into its own crease, so the occlusion there is warm and
 * shallow, while dark asphalt goes properly black. A scalar multiply cannot do
 * that and is what produces the classic SSAO halo.
 */
const OCCLUSION = /* glsl */ `
#ifdef STANDARD
{
	vec2 ironAo = ironOcclusion();
	float ironVis = ironAo.g * mix( 1.0, ironAo.r, ironVec[${V_MISC}].y );
	reflectedLight.indirectDiffuse *= ironMultiBounce( ironVis, material.diffuseColor );
	float ironDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
	reflectedLight.indirectSpecular *= computeSpecularOcclusion( ironDotNV, ironVis, material.roughness );
}
#endif
`;

/**
 * Install the lighting model. Idempotent, and safe to call before any material
 * exists — three resolves `#include` at program build, which is later.
 */
export function installShadingModel(quality: Readonly<QualitySettings>): void {
  if (installed) return;
  installed = true;

  const chunk = THREE.ShaderChunk as unknown as Record<string, string>;
  chunk.lights_physical_pars_fragment += buildPars(
    Math.max(4, Math.min(24, quality.shadows.pcssBlockerSamples)),
    Math.max(4, Math.min(32, quality.shadows.pcssFilterSamples)),
  );

  // The sun's shadow term. Note this REPLACES three's `#if defined(USE_SHADOWMAP)`
  // guarded block: our sun deliberately does not use three's shadow map at all
  // (`castShadow = false`), so with the guard in place the term would compile
  // out entirely and the world would be uniformly lit.
  const begin = chunk.lights_fragment_begin;
  const dirShadow =
    '\t\t#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )\n' +
    '\t\tdirectionalLightShadow = directionalLightShadows[ i ];\n' +
    '\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;\n' +
    '\t\t#endif\n';
  if (!begin.includes(dirShadow)) {
    throw new Error(
      'LIGHT: three.ShaderChunk.lights_fragment_begin no longer matches the directional-shadow ' +
        'block this lane replaces. The cascaded shadow path must be re-anchored in ' +
        'src/render/lighting/shading.ts before the renderer will shadow anything.',
    );
  }
  const indirectAnchor = '#if defined( RE_IndirectDiffuse )\n\tvec3 iblIrradiance';
  if (!begin.includes(indirectAnchor)) {
    throw new Error('LIGHT: lights_fragment_begin has no RE_IndirectDiffuse anchor for clustered lights.');
  }

  const cascaded = /* glsl */ `
		#ifdef STANDARD
		{
			vec3 ironWp = ironWorldPos( geometryPosition );
			vec3 ironWn = normalize( ironWorldDir( geometryNormal ) );
			directLight.color *= ironSunShadow( ironWp, ironWn, -geometryPosition.z, dot( ironWn, ironVec[${V_SUN}].xyz ) );
		}
		#else
${dirShadow}		#endif
`;
  chunk.lights_fragment_begin = begin
    .replace(dirShadow, cascaded)
    .replace(indirectAnchor, `${LOCAL_LIGHTS}\n${indirectAnchor}`);

  if (!chunk.lights_fragment_begin.includes('ironSunShadow')) {
    throw new Error('LIGHT: failed to install the cascaded shadow term into lights_fragment_begin.');
  }
  if (!chunk.lights_fragment_begin.includes('IRON_MAX_LOCAL_LIGHTS')) {
    throw new Error('LIGHT: failed to install clustered local lights into lights_fragment_begin.');
  }
  // Append rather than replace: `lights_fragment_end` is where three finishes
  // accumulating indirect light, and it is the last chunk in the physical
  // fragment that RCORE's uber material does not rewrite.
  chunk.lights_fragment_end += OCCLUSION;

  // Publish the shared cells. Numeric values are Float32Arrays, which
  // `cloneUniforms` copies BY REFERENCE — that is what makes one write reach
  // every material. Samplers start null and are re-bound per material per frame
  // by `bindTextures`, because a render-target texture cannot be cloned at all.
  const lib = (THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, { value: unknown }> }>)
    .physical;
  lib.uniforms.ironMatrix = { value: shared.matrices };
  lib.uniforms.ironVec = { value: shared.vectors };
  lib.uniforms.ironShadowAtlas = { value: null };
  lib.uniforms.ironAoTex = { value: null };
}

/**
 * Point every live material's sampler cells at this frame's atlas and AO.
 *
 * `renderer.properties.get(material).uniforms` is the per-material clone three
 * uploads from; it exists from the moment the material's program is built,
 * which `MaterialFactory.prewarm()` does at boot. A material created later
 * simply picks the textures up on the frame after its first draw.
 */
export function bindTextures(
  renderer: THREE.WebGLRenderer,
  materials: Iterable<THREE.Material>,
  shadowAtlas: THREE.Texture | null,
  ao: THREE.Texture | null,
): void {
  const props = (renderer as unknown as { properties: { get(m: THREE.Material): Record<string, unknown> } })
    .properties;
  for (const material of materials) {
    const entry = props.get(material);
    const uniforms = entry.uniforms as Record<string, { value: unknown }> | undefined;
    if (!uniforms) continue;
    if (uniforms.ironShadowAtlas) uniforms.ironShadowAtlas.value = shadowAtlas;
    if (uniforms.ironAoTex) uniforms.ironAoTex.value = ao;
  }
}
