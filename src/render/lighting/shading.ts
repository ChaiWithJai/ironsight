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
export const V_BIAS = 6; // [depthBiasTexels, normalBiasTexels, blockerSearchTexels, blendBand]
export const V_MISC = 7; // [localLightCount, contactAoStrength, cascadeFadeStart, debugMode]
/** Four tile rects in the atlas: [offsetU, offsetV, scaleU, scaleV]. */
export const V_TILE0 = 8;
export const V_LIGHT_BASE = 12;
export const VEC_COUNT = V_LIGHT_BASE + IRON_MAX_LOCAL_LIGHTS * 3;

/**
 * `ironVec[V_MISC].w` — a channel-isolation debug, off in every shipped frame.
 *
 * A shadow bug is invisible in a tonemapped, fogged, DOF'd beauty frame: a term
 * that returns a flat 1.0 and a term that is correct but staged out of shot look
 * identical. These modes write the raw term to the framebuffer instead of the
 * shaded colour, which turns "is there a shadow here" into a yes/no rather than
 * a judgement call. Set from `DEBUG_MODE` in `service.ts`.
 */
export const DEBUG_OFF = 0;
export const DEBUG_SUN_SHADOW = 1;
export const DEBUG_CASCADE_INDEX = 2;
export const DEBUG_AO = 3;
export const DEBUG_NDL = 4;
export const DEBUG_CONTACT = 5;
/** Geometric (non-normal-mapped) N·L — the reference the terminator clamp works against. */
export const DEBUG_NDL_GEOM = 6;
/** Blocker gap in metres / 40 — how far up-sun the occluder that shadows this pixel is. */
export const DEBUG_GAP = 7;
/** A linear 0..1 horizontal ramp — reads the post chain's whole transfer curve in one frame. */
export const DEBUG_RAMP = 8;

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
/**
 * Safety ceilings. Both are generous on purpose — the receiver-plane bias in
 * \`ironCascade\` is what actually removes grazing acne now, so these only have to
 * stop a degenerate normal from producing an infinity. See ironCascade.
 */
#define IRON_MAX_NORMAL_OFFSET 1.0
#define IRON_MAX_DEPTH_BIAS 0.6
/** Minimum |N·L_axis|. Below this the receiver is edge-on and its plane is unusable. */
#define IRON_MIN_NZ 0.05
/** tan of the steepest receiver slope the plane bias will follow (83°). */
#define IRON_MAX_PLANE_SLOPE 8.0
/**
 * How much of the geometric cosine the normal map is allowed to add or take
 * away. See \`ironTerminatorNormal\`. 0.6 lets the relief modulate the sun by
 * ±60 % — visually a strong, clearly readable raking texture — while capping the
 * lit:shaded ratio inside one pixel's worth of relief at 4:1 instead of the
 * infinity a hard \`max(N·L, 0)\` allows.
 */
#define IRON_TERMINATOR_CAP 0.30
/**
 * Fraction of a surface's SKY irradiance that arrives from the circumsolar cone,
 * and is therefore lost when something up-sun puts it in shadow. See
 * \`ironAureoleLoss\`. MIN is the near-horizontal-ground case (the cone is caught
 * at a glancing 11°), MAX a face square to the sun.
 */
#define IRON_AUREOLE_MIN 0.12
#define IRON_AUREOLE_MAX 0.35
#define IRON_MAX_LOCAL_LIGHTS ${IRON_MAX_LOCAL_LIGHTS}
#define IRON_LIGHT_BASE ${V_LIGHT_BASE}
/** Debug mode selectors. \`#define\` so the ints never land in float context. */
#define IRON_DBG_SHADOW ${DEBUG_SUN_SHADOW}
#define IRON_DBG_CASCADE ${DEBUG_CASCADE_INDEX}
#define IRON_DBG_AO ${DEBUG_AO}
#define IRON_DBG_NDL ${DEBUG_NDL}
#define IRON_DBG_CONTACT ${DEBUG_CONTACT}
#define IRON_DBG_NDL_GEOM ${DEBUG_NDL_GEOM}
#define IRON_DBG_GAP ${DEBUG_GAP}
#define IRON_DBG_RAMP ${DEBUG_RAMP}

/** Debug channel, written in \`lights_fragment_begin\`, read in \`opaque_fragment\`. */
vec4 ironDebug = vec4( 0.0 );
/**
 * The shading normal, parked while the sun is shaded with the terminator-clamped
 * one and restored before the indirect terms. Zero means "never saved", which is
 * what a material compiled without a directional light leaves it at.
 */
vec3 ironNormalSaved = vec3( 0.0 );
/** Geometric N·L, kept for the debug channel. */
float ironNdlGeom = 0.0;
/** Occluder-receiver gap in metres, kept for the debug channel. */
float ironGapDebug = 0.0;
/**
 * The sun's cascade visibility, read back by the indirect terms. It defaults to
 * FULLY VISIBLE so a material that compiles without a directional light gets no
 * circumsolar loss rather than all of it.
 */
float ironSunVis = 1.0;

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
 * Centre of the atlas texel that \`uv\` (cascade-local) lands in. The clamp
 * mirrors \`ironAtlas\`'s exactly: a tap that walks off the tile reads the edge
 * texel, so the receiver plane has to be evaluated at that same edge texel or
 * the two disagree by the whole overshoot and the cascade border shadows itself.
 */
vec2 ironTexelCentre( const in vec2 uv, const in float texels ) {
  return ( floor( clamp( uv, vec2( 0.0 ), vec2( 1.0 ) ) * texels ) + 0.5 ) / texels;
}

/**
 * One cascade of contact-hardening PCSS, with a RECEIVER-PLANE DEPTH BIAS.
 *
 * The atlas stores DISTANCE FROM THE LIGHT PLANE IN METRES, not a normalised
 * device depth, which is the whole reason the penumbra can be physical: the
 * blocker search returns an average occluder gap in metres and the penumbra
 * half-width is that gap times tan(0.265°). A 1 m gap therefore gives ~9 mm of
 * penumbra and a 10 m gap ~90 mm — LOOK_SPEC §2.6 — with no fudge factor.
 *
 * THE RECEIVER PLANE IS WHY THIS WORKS AT ALL AT GOLDEN HOUR, AND ITS ABSENCE
 * IS WHAT PREVIOUSLY BLACKENED THE ENTIRE FRAME.
 * ---------------------------------------------------------------------------
 * With the sun 11° up, open ground is only 11° off parallel to the light rays,
 * so the depth stored in the atlas changes by 1/tan(11°) = 5.1 METRES for every
 * metre the kernel walks sideways. A PCSS kernel in cascade 0 is ~0.17 m wide,
 * which is 0.85 m of legitimate depth change — six times any constant bias that
 * would not peter-pan a crate. Every tap therefore read "something closer than
 * me" and the ground shadowed itself to zero everywhere, in every shot in the
 * game. What looked like "no shadow pass is running" was in fact a shadow pass
 * returning FULL occlusion for the whole world, with all the apparent lighting
 * coming from the sky environment.
 *
 * The fix is exact rather than a fudge. coord = M * P is affine, so the three
 * rows of M give u, v and depth as linear functions of world position. For a
 * displacement t inside the receiver's own tangent plane (N·t = 0), decomposing
 * t in the orthonormal light basis eU = 2R·rowU, eV = 2R·rowV, eZ = rowZ gives
 *
 *     dz = -4R² · ( (N·rowU)·du + (N·rowV)·dv ) / (N·rowZ)
 *
 * i.e. the exact depth of the receiver's own surface at any other point of the
 * shadow map. Comparing each tap against THAT instead of against one constant
 * makes a flat receiver compare equal to itself no matter how grazing it is,
 * while a real occluder — which is not on the plane — still fails the test.
 *
 * The tap's plane depth is evaluated at the TEXEL CENTRE, not at the tap uv,
 * because the atlas is point-sampled and therefore returns the depth the
 * rasteriser wrote at that texel's centre. Matching the two removes the last
 * half-texel of gradient error and is what lets the residual constant bias be
 * centimetres rather than metres.
 *
 * A cleared texel reads 0 and is treated as EMPTY SKY, never as an occluder at
 * the light plane.
 */
float ironCascade( const in int cascade, const in vec3 worldPos, const in vec3 worldNormal, const in float ndl ) {
  vec4 atlas = ironVec[${V_ATLAS}];
  vec4 bias = ironVec[${V_BIAS}];
  float texelWorld = ironVec[${V_TEXEL_WORLD}][ cascade ];
  float radius = ironVec[${V_CASCADE_RADIUS}][ cascade ];
  mat4 m = ironMatrix[${M_CASCADE0} + cascade];

  // Rows of the affine part: u, v and depth as linear functions of world pos.
  // (GLSL indexes mat4 by COLUMN, hence the transpose by hand.)
  vec3 rowU = vec3( m[0][0], m[1][0], m[2][0] );
  vec3 rowV = vec3( m[0][1], m[1][1], m[2][1] );
  vec3 rowZ = vec3( m[0][2], m[1][2], m[2][2] );

  // NORMAL-OFFSET BIAS, sized in cascade TEXELS rather than world units — the
  // distinction LOOK_SPEC §2.6 insists on. It is scaled by sin(θ) so it vanishes
  // on a surface facing the sun (where it would only peter-pan) and is at full
  // strength on a raking one. It is not doing the anti-acne work any more — the
  // receiver plane is — so 1.5 texels is enough to cover interpolated vertex
  // normals disagreeing with the rasterised triangle.
  float sinTheta = sqrt( max( 1.0 - ndl * ndl, 0.0 ) );
  float normalOffset = min( texelWorld * bias.y * sinTheta, IRON_MAX_NORMAL_OFFSET );
  vec3 offsetPos = worldPos + worldNormal * normalOffset;

  vec3 coord = ( m * vec4( offsetPos, 1.0 ) ).xyz;
  if ( coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 ) return -1.0;

  // ---- receiver plane -----------------------------------------------------
  float nz = dot( worldNormal, rowZ );
  float nzSafe = nz < 0.0 ? min( nz, -IRON_MIN_NZ ) : max( nz, IRON_MIN_NZ );
  vec2 grad = ( -4.0 * radius * radius / nzSafe )
            * vec2( dot( worldNormal, rowU ), dot( worldNormal, rowV ) );
  // |grad| is exactly 2R·tan(angle between the receiver and the light axis), so
  // clamping tan caps how far the plane may be extrapolated before a near
  // edge-on surface starts inventing depth.
  float gradMax = IRON_MAX_PLANE_SLOPE * 2.0 * radius;
  float gradLen = length( grad );
  if ( gradLen > gradMax ) grad *= gradMax / gradLen;

  float tileTexels = 2.0 * radius / max( texelWorld, 1e-5 );
  // The residual: sub-texel non-planarity (terrain, brick relief) and fp error.
  // Proportional to how much depth one texel spans on THIS receiver, which is
  // texelWorld·tan(θ), and small because the plane carries the systematic part.
  float tanSlope = min( sinTheta / max( abs( ndl ), 0.02 ), IRON_MAX_PLANE_SLOPE );
  float depthBias = min( 0.015 + bias.x * texelWorld * tanSlope, IRON_MAX_DEPTH_BIAS );

  float phi = ironDitherAngle();
  float uvPerMetre = 1.0 / ( 2.0 * radius );

  // ---- blocker search ----------------------------------------------------
  // THE SEARCH RADIUS IS PER-CASCADE, AND THAT IS WHAT MAKES CONTACT HARDENING
  // REAL. A blocker sitting r metres to the side can only widen the penumbra
  // at this receiver if the occluder-receiver gap is at least r / tan(0.265°) —
  // so a fixed 0.9 m search in cascade 0 was averaging in occluders 190 m up-sun
  // that cannot physically shade this pixel, inflating the gap and giving the
  // crate that touches the paving the same soft edge as the roofline behind it.
  // Sizing it in cascade texels ties the search to the resolution that cascade
  // can actually resolve: ~0.17 m in cascade 0, ~5 m in cascade 3.
  float searchUv = clamp( texelWorld * bias.z, 0.05, 2.5 ) * uvPerMetre;
  float gapSum = 0.0;
  float blockerCount = 0.0;
  for ( int i = 0; i < IRON_BLOCKER_TAPS; i ++ ) {
    vec2 tap = coord.xy + ironVogel( i, IRON_BLOCKER_TAPS, phi ) * searchUv;
    float reference = coord.z + dot( grad, ironTexelCentre( tap, tileTexels ) - coord.xy ) - depthBias;
    float d = ironAtlas( cascade, tap );
    if ( d > 1e-4 && d < reference ) {
      gapSum += reference - d;
      blockerCount += 1.0;
    }
  }
  if ( blockerCount < 0.5 ) return 1.0;

  // Contact hardening: penumbra half-width = gap * tan(sun angular radius).
  float gap = gapSum / blockerCount;
  ironGapDebug = gap;
  float penumbraUv = max( gap * atlas.z * uvPerMetre, atlas.w * texelWorld * uvPerMetre );

  // ---- filter ------------------------------------------------------------
  float lit = 0.0;
  for ( int i = 0; i < IRON_PCF_TAPS; i ++ ) {
    vec2 tap = coord.xy + ironVogel( i, IRON_PCF_TAPS, phi + 1.13 ) * penumbraUv;
    float reference = coord.z + dot( grad, ironTexelCentre( tap, tileTexels ) - coord.xy ) - depthBias;
    float d = ironAtlas( cascade, tap );
    lit += ( d <= 1e-4 || d >= reference ) ? 1.0 : 0.0;
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

  ironDebug.z = float( c );

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

/**
 * THE BUMPED-SURFACE TERMINATOR CLAMP.
 *
 * A normal map is a stand-in for relief the geometry does not carry, and
 * \`max(N·L, 0)\` on a point-sampled perturbed normal is a bad estimator of what
 * that relief actually does to the sun near the terminator. Two physical facts
 * are being ignored at once: the relief SELF-SHADOWS as the light grazes (the
 * raised facets shade the pits, so no facet can be delivering full irradiance on
 * a surface the sun is skimming), and a pixel covers a whole distribution of
 * facet normals rather than the one that happened to be sampled. The result on a
 * plaster wall lit at 11° is the classic shadow-terminator artefact: N·L flips
 * between +0.4 and −0.4 from one normal-map texel to the next, and the frame
 * carries a band of fully-lit and fully-black blobs where it should carry a
 * smooth ramp with the relief legible inside it. Measured on \`light_cascades\`
 * before this existed: a horizontal luma profile across the near wall's
 * terminator swung ±100 display luma between samples 10 px apart, while the same
 * wall in full sun held a standard deviation of 10.
 *
 * The clamp is on the PERTURBATION, not on the normal, and that is what keeps it
 * from flattening the look. Write the perturbed cosine as
 *
 *     ndlShading = ndlGeom + perturbation
 *
 * and cap |perturbation| at a fraction of \`ndlGeom\` itself. Where the sun is
 * properly on the surface the cap is far larger than the perturbation ever gets
 * and the normal map passes through completely untouched — raking micro-detail,
 * which is a headline requirement of LOOK_SPEC §2.2, is fully preserved. As the
 * geometric surface turns edge-on the cap closes proportionally, so the relief
 * fades out exactly and only where it would otherwise manufacture a black hole
 * next to a blown highlight. The perturbed cosine can then never cross zero
 * while the geometry still faces the sun, which is what makes the terminator
 * monotonic.
 *
 * It is applied by MIXING THE NORMAL rather than by scaling the light, because
 * scaling \`directLight.color\` can only ever darken: a pixel whose perturbed
 * cosine has already gone negative is dead inside \`RE_Direct\` and no multiplier
 * brings it back. \`t\` is chosen so the mixed normal lands on the capped cosine.
 */
vec3 ironTerminatorNormal( const in vec3 shading, const in vec3 geom, const in vec3 lightDir ) {
  float ndlG = dot( geom, lightDir );
  float ndlS = dot( shading, lightDir );
  float perturbation = ndlS - ndlG;
  // The floor keeps a face that is exactly edge-on from losing its normal map
  // discontinuously; 0.012 is about a degree of tilt and is invisible.
  float limit = IRON_TERMINATOR_CAP * max( ndlG, 0.0 ) + 0.012;
  float t = clamp( limit / max( abs( perturbation ), 1e-4 ), 0.0, 1.0 );
  vec3 mixed = mix( geom, shading, t );
  float len = length( mixed );
  return len > 1e-4 ? mixed / len : geom;
}

/**
 * THE CIRCUMSOLAR LOSS — the sky a cast shadow's own occluder takes away.
 *
 * The environment cube is a real directional sky, so a surface already receives
 * the right irradiance for its ORIENTATION. What no environment lookup can know
 * is that a point sitting in the sun's cast shadow is being shadowed by
 * something standing on the sun vector, and that something is covering the
 * brightest part of the dome by a wide margin: LOOK_SPEC §2.4 measures the
 * horizon within 20° of the sun azimuth at 9 000 cd/m² against 3 400 cd/m² at
 * 90° off and 2 200 at the zenith. At an 11° sun that circumsolar cone carries
 * roughly a quarter of the diffuse irradiance a sun-facing surface collects, and
 * a building 40 m up-sun — the thing that put this pixel in shadow in the first
 * place — sits squarely on it.
 *
 * GTAO cannot supply this: its far radius is 10 m, so an occluder that is
 * shadowing the ground from 40 m away is invisible to it, and the shadowed
 * ground keeps its full 8 200 lx of sky. That is the whole reason a cast shadow
 * on open ground was measuring 1.5:1 in display luma against LOOK_SPEC §2.5's
 * 2.5–4.5:1 acceptance band — the sun was being removed correctly and the sky
 * was not being touched at all.
 *
 * The share is scaled by the geometric N·L because the cosine weighting decides
 * how much of the cone a surface actually sees, and the two ends of that scale
 * are very different sizes. Near-horizontal ground catches the circumsolar cone
 * at a glancing 11°, so an 8 m occluder 40 m up-sun covers a band of about
 * 0.13 sr of the hemisphere's cosine measure at roughly 3× the dome's mean
 * radiance — 12 %. A face square to the sun has that same cone dead centre in
 * its own hemisphere and loses about 35 %. Those are the two numbers below, and
 * they are why this term deepens a shadow on a sunward WALL far more than one on
 * open ground: that asymmetry is real, and it is the same asymmetry LOOK_SPEC
 * §2.5 records when it asks for 2.5–4.5:1 on ground and 5.0–9.0:1 on a sunward
 * vertical face out of one pair of illuminances.
 *
 * It is gated on the cascade's own visibility, so ground in full sun is
 * untouched — this can only ever deepen a shadow that already exists, never
 * darken the frame generally.
 */
float ironAureoleLoss( const in float sunVisibility, const in float ndlGeom ) {
  float share = IRON_AUREOLE_MIN + ( IRON_AUREOLE_MAX - IRON_AUREOLE_MIN ) * clamp( ndlGeom, 0.0, 1.0 );
  return 1.0 - share * clamp( 1.0 - sunVisibility, 0.0, 1.0 );
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

/**
 * The SUN's screen-space contact occlusion (see gtao.ts), in B of the same
 * buffer. It multiplies the cascade rather than the ambient, because it is not
 * an ambient term at all: it is the half metre of the sun's own shadow that a
 * 1.5 cm shadow texel filtered through a multi-tap PCSS kernel cannot hold.
 * Applying occlusion to direct light is normally the "dirty grey shadow"
 * mistake LOOK_SPEC §2.5 names; this is the one case where it is correct,
 * because the quantity really is sun visibility and not sky visibility.
 */
float ironContactSun() {
  if ( ironVec[${V_SCREEN}].z < 0.001 ) return 1.0;
  vec2 uv = gl_FragCoord.xy * ironVec[${V_SCREEN}].xy;
  return mix( 1.0, texture2D( ironAoTex, uv ).b, ironVec[${V_SCREEN}].z );
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
	float ironAureole = ironAureoleLoss( ironSunVis, ironNdlGeom );
	reflectedLight.indirectDiffuse *= ironAureole;
	reflectedLight.indirectSpecular *= ironAureole;
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

  // THE SHADOW LOOKUP TAKES THE GEOMETRIC NORMAL, NOT THE SHADED ONE, AND THAT
  // IS NOT A DETAIL. `ironCascade` builds a receiver PLANE from the normal and
  // extrapolates the atlas depth across the whole PCSS kernel with it; the
  // gradient it uses is `4R²/(N·rowZ)`, which at an 11° sun is thousands of
  // metres per unit of uv. Feeding that a normal-mapped normal makes the plane
  // wrong by the normal map's own slope at every pixel, and the error lands
  // exactly where the kernel is widest — inside the penumbra — which is a second
  // texture-shaped noise field on top of the terminator one. The vertex normal
  // is what the rasteriser actually wrote depth from, so it is what the plane
  // has to be built on.
  const cascaded = /* glsl */ `
		#ifdef STANDARD
		{
			vec3 ironWp = ironWorldPos( geometryPosition );
			vec3 ironWn = normalize( ironWorldDir( nonPerturbedNormal ) );
			float ironNdl = dot( ironWn, ironVec[${V_SUN}].xyz );
			ironNdlGeom = ironNdl;
			float ironS = ironSunShadow( ironWp, ironWn, -geometryPosition.z, ironNdl );
			ironDebug.x = ironS;
			ironSunVis = ironS;
			ironDebug.y = dot( normalize( ironWorldDir( geometryNormal ) ), ironVec[${V_SUN}].xyz );
			ironDebug.w = ironContactSun();
			directLight.color *= ironS * ironDebug.w;
			// Park the shading normal and shade the sun through the clamped one.
			// Restored at \`ironRestoreNormal\` below, before any indirect term
			// reads it — the sky ambient must keep the full normal map.
			ironNormalSaved = geometryNormal;
			geometryNormal = ironTerminatorNormal( geometryNormal, nonPerturbedNormal, directLight.direction );
		}
		#else
${dirShadow}		#endif
`;
  const restoreNormal = /* glsl */ `
#ifdef STANDARD
	// > 0.5 rather than > 0.0: the saved slot is a unit vector when it has been
	// written and exactly zero when the material compiled with no directional
	// light at all, in which case there is nothing to put back.
	if ( dot( ironNormalSaved, ironNormalSaved ) > 0.5 ) geometryNormal = ironNormalSaved;
#endif
`;
  chunk.lights_fragment_begin = begin
    .replace(dirShadow, cascaded)
    .replace(indirectAnchor, `${restoreNormal}${LOCAL_LIGHTS}\n${indirectAnchor}`);

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

  // Channel isolation. Compiled in always (it is four compares on a uniform that
  // is zero in every shipped frame, and the branch is uniform so it costs
  // nothing), because a shadow term that silently returns 1.0 is otherwise
  // indistinguishable from a shadow that is merely staged out of shot.
  chunk.dithering_fragment += /* glsl */ `
#ifdef STANDARD
{
  int ironMode = int( ironVec[${V_MISC}].w + 0.5 );
  // Undo the scene exposure so a debug term of 1.0 lands at white rather than at
  // the 0.04 the golden-hour exposure would otherwise crush it to.
  float ironGain = ironVec[${V_ATLAS}].x;
  if ( ironMode == IRON_DBG_SHADOW ) gl_FragColor = vec4( vec3( ironDebug.x ) * ironGain, 1.0 );
  else if ( ironMode == IRON_DBG_CASCADE ) gl_FragColor = vec4( (
    ironDebug.z < 0.5 ? vec3( 1.0, 0.2, 0.2 ) :
    ironDebug.z < 1.5 ? vec3( 0.2, 1.0, 0.2 ) :
    ironDebug.z < 2.5 ? vec3( 0.2, 0.4, 1.0 ) : vec3( 1.0, 1.0, 0.2 ) ) * ironGain, 1.0 );
  else if ( ironMode == IRON_DBG_AO ) gl_FragColor = vec4( ironOcclusion().rgr * ironGain, 1.0 );
  else if ( ironMode == IRON_DBG_NDL ) gl_FragColor = vec4( vec3( max( ironDebug.y, 0.0 ) ) * ironGain, 1.0 );
  else if ( ironMode == IRON_DBG_CONTACT ) gl_FragColor = vec4( vec3( ironDebug.w ) * ironGain, 1.0 );
  else if ( ironMode == IRON_DBG_NDL_GEOM ) gl_FragColor = vec4( vec3( max( ironNdlGeom, 0.0 ) ) * ironGain, 1.0 );
  else if ( ironMode == IRON_DBG_GAP ) gl_FragColor = vec4( vec3( ironGapDebug / 40.0 ) * ironGain, 1.0 );
  else if ( ironMode == IRON_DBG_RAMP ) gl_FragColor = vec4( vec3( gl_FragCoord.x / 1920.0 ) * ironGain, 1.0 );
}
#endif
`;

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
