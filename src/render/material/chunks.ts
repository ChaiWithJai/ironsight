/**
 * THE UBER MATERIAL'S GLSL, in one place.
 *
 * OWNER: RCORE. Every string here is injected into `MeshPhysicalMaterial` by
 * `iron-material.ts` through the single sanctioned `onBeforeCompile`.
 *
 * The layer stack implemented below is LOOK_SPEC §4.1, in its order:
 *
 *   1 base albedo          the baked TextureSet, tinted per material
 *   2 mesoscale variation  the bake's own meso octave (albedo+rough+normal)
 *   3 macro variation      analytic 3-18 m noise, albedo only, ±8 %
 *   4 curvature wear       convexity → chip to a lighter substrate
 *   5 cavity grime         concavity + AO → darken, roughen, desaturate
 *   6 N·up dust            upward faces → pale ochre, flatter, rougher
 *   7 detail normal        ~2-5 cm, re-tiled from the same normal map
 *   8 micro normal         ~2-6 mm, fading in inside 3 m
 *
 * plus rain streaking on vertical faces, per-instance colour/roughness jitter,
 * triplanar projection, wetness, parallax occlusion and the grazing-angle
 * ambient specular lobe that LOOK_SPEC §4.2 requires of every "matte" surface.
 *
 * TWO CONVENTIONS
 * ---------------
 *  - Everything prefixed `iron`/`uIron`/`vIron`. Three's own chunks are in the
 *    same namespace and a collision is a link error at boot for every lane.
 *  - `texture2D` rather than `texture`: three's ES3 conversion defines the
 *    former for us, and writing the latter breaks the WebGL1 fallback path in
 *    a way nobody sees until a machine without WebGL2 boots the game.
 */

/* ========================================================================== *
 * VERTEX
 * ========================================================================== */

/** Declarations appended to the vertex shader's `<common>`. */
export const IRON_VERTEX_PARS = /* glsl */ `
varying vec3 vIronWorld;
varying vec3 vIronWorldN;
varying vec3 vIronOrigin;
varying vec2 vIronUv;
uniform float uIronTime;
uniform float uIronPrevTime;
`;

/**
 * Emitted after `<project_vertex>`. `transformed` and `objectNormal` are final
 * by this point (the deform chunk, if any, has already run), so this is the
 * only place the world-space position and normal can be captured once and
 * agree with what was rasterised.
 *
 * `vIronOrigin` is the instance's world origin, which is the seed for
 * per-instance colour variation: it is stable frame to frame, distinct per
 * instance and costs no attribute.
 */
export const IRON_VERTEX_WORLD = /* glsl */ `
  mat4 ironModel = modelMatrix;
  #ifdef USE_BATCHING
    ironModel = ironModel * batchingMatrix;
  #endif
  #ifdef USE_INSTANCING
    ironModel = ironModel * instanceMatrix;
  #endif
  vIronWorld = ( ironModel * vec4( transformed, 1.0 ) ).xyz;
  vIronWorldN = normalize( mat3( ironModel ) * objectNormal );
  vIronOrigin = ironModel[ 3 ].xyz;
  vIronUv = uv;
`;

/**
 * Re-derive the shading normal AFTER a deform chunk has moved the vertex.
 * `<defaultnormal_vertex>` runs BEFORE `<begin_vertex>` in three's vertex main,
 * so a deform that rotates `objectNormal` would otherwise light the surface as
 * if it had never moved — the classic "the palm bends but the light does not"
 * artefact.
 */
export const IRON_VERTEX_RENORMAL = /* glsl */ `
  #ifndef FLAT_SHADED
  {
    vec3 ironN = objectNormal;
    #ifdef USE_INSTANCING
      ironN = mat3( instanceMatrix ) * ironN;
    #endif
    #ifdef USE_BATCHING
      ironN = mat3( batchingMatrix ) * ironN;
    #endif
    vNormal = normalize( normalMatrix * ironN );
    #ifdef FLIP_SIDED
      vNormal = - vNormal;
    #endif
  }
  #endif
`;

/* ========================================================================== *
 * FRAGMENT
 * ========================================================================== */

/**
 * Declarations appended to the fragment shader's `<common>`: the two-sampler
 * TextureSet, the packed parameter vectors, and the helper library.
 *
 * Parameters are packed into vec4s rather than shipped as fifteen named floats
 * because every uniform costs a location and a per-draw upload, and because a
 * packed block is one `setUniform` write when a lane retunes a material.
 */
export const IRON_FRAGMENT_PARS = /* glsl */ `
varying vec3 vIronWorld;
varying vec3 vIronWorldN;
varying vec3 vIronOrigin;
varying vec2 vIronUv;

uniform sampler2D uIronAlbedoHeight;
uniform sampler2D uIronNormalRoughAo;
uniform sampler2D uIronWearMap;

/** x metres per texture repeat · y detail repeats/m · z micro multiplier · w triplanar sharpness */
uniform vec4 uIronTiling;
/** x detail strength · y micro strength · z detail fade end (m) · w micro fade end (m) */
uniform vec4 uIronDetail;
/** x edge-wear bias · y grime bias · z dust bias · w wetness */
uniform vec4 uIronWearP;
/** rgb target tint (linear) · a tint strength */
uniform vec4 uIronTint;
/** x hue jitter · y value jitter · z roughness jitter · w per-material seed */
uniform vec4 uIronVary;
/** x roughness · y metalness · z texture roughness centre · w parallax depth (m) */
uniform vec4 uIronMat;
/** x soft-particle fade distance (m) · y enable (0/1) · z camera near · w camera far */
uniform vec4 uIronSoft;
uniform vec2 uIronScreen;         // 1 / render target size
uniform sampler2D uIronSceneDepth;
uniform vec3 uIronCamPos;

/* --------------------------------------------------------------- hashing --- */

float ironHash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

/**
 * 2D value noise, bilinear. Four hashes against the 3D version's eight, and
 * the macro/instance terms only ever need variation ACROSS a surface — so this
 * is evaluated on the surface's dominant world plane rather than in the volume.
 * Halving the hash count here is worth ~1 ms/frame at 1080p on the tier that
 * matters and considerably more under the capture harness' software rasteriser.
 */
float ironNoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n00 = ironHash13( vec3( i, 0.0 ) );
  float n10 = ironHash13( vec3( i + vec2( 1.0, 0.0 ), 0.0 ) );
  float n01 = ironHash13( vec3( i + vec2( 0.0, 1.0 ), 0.0 ) );
  float n11 = ironHash13( vec3( i + vec2( 1.0, 1.0 ), 0.0 ) );
  return mix( mix( n00, n10, f.x ), mix( n01, n11, f.x ), f.y );
}

/** Value noise. One octave, trilinear — for the terms that need real volume. */
float ironNoise3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = ironHash13( i + vec3( 0.0, 0.0, 0.0 ) );
  float n100 = ironHash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = ironHash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = ironHash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = ironHash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = ironHash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = ironHash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = ironHash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ),
    f.z );
}

/* ------------------------------------------------------------- triplanar --- */

vec3 ironTriWeights( vec3 n, float sharpness ) {
  vec3 w = pow( abs( n ), vec3( sharpness ) );
  return w / max( w.x + w.y + w.z, 1e-4 );
}

vec4 ironTriSample( sampler2D tex, vec3 p, vec3 w ) {
  return texture2D( tex, p.zy ) * w.x
       + texture2D( tex, p.xz ) * w.y
       + texture2D( tex, p.xy ) * w.z;
}

/**
 * Whiteout triplanar normal blend (Golus). The three tangent normals are
 * swizzled into world orientation and added to the geometric normal before the
 * blend, which keeps the result unit-length-ish and — unlike a naive lerp of
 * the three tangent normals — does not flatten detail on the 45° faces where
 * two projections overlap. Those faces are exactly the ones a player sees on a
 * cliff or a rubble pile.
 */
vec3 ironTriNormal( sampler2D tex, vec3 p, vec3 w, vec3 n, float strength ) {
  vec2 tx = ( texture2D( tex, p.zy ).rg * 2.0 - 1.0 ) * strength;
  vec2 ty = ( texture2D( tex, p.xz ).rg * 2.0 - 1.0 ) * strength;
  vec2 tz = ( texture2D( tex, p.xy ).rg * 2.0 - 1.0 ) * strength;
  vec3 nx = vec3( tx + n.zy, abs( n.x ) );
  vec3 ny = vec3( ty + n.xz, abs( n.y ) );
  vec3 nz = vec3( tz + n.xy, abs( n.z ) );
  return normalize( nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z );
}

/* ------------------------------------------------------------------- TBN --- */

/**
 * Cotangent frame from screen-space derivatives. The level geometry ships
 * position/normal/uv and no tangent (a tangent attribute would be a third of
 * the vertex budget for a town made of flat quads), so the frame is
 * reconstructed here. World space, not view space: the whole surface evaluation
 * below is world-space so triplanar and UV paths produce the same units.
 */
mat3 ironTangentFrame( vec3 n, vec3 p, vec2 uv ) {
  vec3 dp1 = dFdx( p );
  vec3 dp2 = dFdy( p );
  vec2 duv1 = dFdx( uv );
  vec2 duv2 = dFdy( uv );
  vec3 dp2perp = cross( dp2, n );
  vec3 dp1perp = cross( n, dp1 );
  vec3 t = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 b = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt( max( max( dot( t, t ), dot( b, b ) ), 1e-12 ) );
  return mat3( t * invmax, b * invmax, n );
}

/** UDN blend: keep the base normal's z, add the detail's slope. Cheap, stable. */
vec3 ironBlendNormal( vec3 base, vec2 detailXY ) {
  return normalize( vec3( base.xy + detailXY, base.z ) );
}

/* ------------------------------------------------------------------ misc --- */

float ironLuminance( vec3 c ) {
  return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
}

/**
 * Rain streaking. Vertical faces in every reference frame carry washed and
 * unwashed bands running down from every ledge; it is one of the strongest
 * "this building has stood outside" cues and it costs one noise call.
 * Anisotropic on purpose: 40 cm across, 6 m down.
 */
float ironStreak( vec3 p, float broad ) {
  float s = ironNoise3( vec3( p.x * 2.6, p.y * 0.16, p.z * 2.6 ) );
  return smoothstep( 0.42, 0.92, s * 0.65 + broad * 0.45 );
}

/** Linear eye depth from a hardware depth value, for the soft-particle fade. */
float ironLinearDepth( float z, float near, float far ) {
  float ndc = z * 2.0 - 1.0;
  return ( 2.0 * near * far ) / ( far + near - ndc * ( far - near ) );
}
`;

/**
 * THE SURFACE EVALUATION. Replaces `<map_fragment>`, so it runs before
 * `<alphatest_fragment>` (which needs the final alpha) and before
 * `<normal_fragment_begin>` (which needs nothing from us but whose result we
 * overwrite in `<normal_fragment_maps>`).
 *
 * Writes the four globals the rest of the chain reads: `ironAlbedo`,
 * `ironRoughness`, `ironMetalness`, `ironNormalW`, `ironAo`.
 */
export const IRON_SURFACE = /* glsl */ `
  vec3 ironGeoN = normalize( vIronWorldN );
  vec3 ironViewVec = uIronCamPos - vIronWorld;
  float ironDist = length( ironViewVec );
  vec3 ironViewDirW = ironViewVec / max( ironDist, 1e-4 );

  // Metres per texture repeat → repeats per metre.
  float ironScale = 1.0 / max( uIronTiling.x, 1e-3 );
  vec3 ironTriP = vIronWorld * ironScale;
  vec2 ironUv = vIronUv * ironScale;

  #ifdef IRON_TRIPLANAR
    vec3 ironTriW = ironTriWeights( ironGeoN, uIronTiling.w );
  #endif

  // ---- 4.5 wetness mask, needed early: it fills the height field's low points
  float ironWet = clamp( uIronWearP.w, 0.0, 1.0 );

  // ---- parallax occlusion, UV path only ------------------------------------
  // Triplanar POM needs three independent ray marches and is not worth 3× the
  // cost on terrain that is already displaced geometry.
  #if defined( IRON_PARALLAX ) && !defined( IRON_TRIPLANAR )
  {
    mat3 ironPomTbn = ironTangentFrame( ironGeoN, vIronWorld, ironUv );
    vec3 ironVt = normalize( vec3( dot( ironViewDirW, ironPomTbn[ 0 ] ),
                                   dot( ironViewDirW, ironPomTbn[ 1 ] ),
                                   dot( ironViewDirW, ironPomTbn[ 2 ] ) ) );
    // Depth is authored in metres and the UV is in repeats, so the sweep has to
    // be converted or the effect changes strength with the tiling rate.
    float ironPomDepth = uIronMat.w * ironScale;
    // Steps fall off with distance: parallax past ~8 m is below a pixel and is
    // pure cost. 12 steps at contact, 4 at range.
    float ironSteps = mix( 12.0, 4.0, clamp( ironDist / 8.0, 0.0, 1.0 ) );
    vec2 ironDelta = ( ironVt.xy / max( abs( ironVt.z ), 0.35 ) ) * ironPomDepth / ironSteps;
    float ironLayer = 1.0 / ironSteps;
    float ironCurD = 1.0;
    vec2 ironCurUv = ironUv;
    float ironCurH = texture2D( uIronAlbedoHeight, ironCurUv ).a;
    for ( int i = 0; i < 12; i ++ ) {
      if ( float( i ) >= ironSteps || ironCurH >= ironCurD ) break;
      ironCurD -= ironLayer;
      ironCurUv -= ironDelta;
      ironCurH = texture2D( uIronAlbedoHeight, ironCurUv ).a;
    }
    // One secant refinement: without it the silhouette of a mortar course
    // stair-steps, which reads worse than no parallax at all.
    vec2 ironPrevUv = ironCurUv + ironDelta;
    float ironAfter = ironCurH - ironCurD;
    float ironBefore = texture2D( uIronAlbedoHeight, ironPrevUv ).a - ironCurD - ironLayer;
    ironUv = mix( ironCurUv, ironPrevUv, ironAfter / max( ironAfter - ironBefore, 1e-4 ) );
  }
  #endif

  // ---- 1+2 base albedo and the baked mesoscale layer ------------------------
  #ifdef IRON_TRIPLANAR
    vec4 ironTexA = ironTriSample( uIronAlbedoHeight, ironTriP, ironTriW );
    vec4 ironTexN = ironTriSample( uIronNormalRoughAo, ironTriP, ironTriW );
  #else
    vec4 ironTexA = texture2D( uIronAlbedoHeight, ironUv );
    vec4 ironTexN = texture2D( uIronNormalRoughAo, ironUv );
  #endif

  vec3 ironAlbedo = ironTexA.rgb;
  float ironAo = ironTexN.a;

  // Baked roughness is a VARIATION around the texture's own centre, not an
  // absolute: the lane authored its roughness against LOOK_SPEC §4.2 and the
  // bake authored a texture around its own recipe. Subtracting the centre
  // leaves the texture's deviation and nothing else, so a lane can ask for
  // 0.93 stucco and still get the bake's rain-washed strips at 0.60.
  float ironRoughness = clamp( uIronMat.x + ( ironTexN.b - uIronMat.z ) * 0.55, 0.045, 1.0 );
  float ironMetalness = clamp( uIronMat.y, 0.0, 1.0 );

  // ---- 7+8 detail and micro normal -----------------------------------------
  // Both are the SAME normal map re-tiled at a much higher frequency. A second
  // baked map would cost a third sampler for information the eye cannot tell
  // apart from this at 2 cm; what matters is that the surface keeps resolving
  // as the camera closes, which is item two on the brief's defect list.
  float ironDetailFreq = max( uIronTiling.y, 0.25 );
  float ironDetailFade = 1.0 - smoothstep( uIronDetail.z * 0.45, uIronDetail.z, ironDist );
  float ironMicroFade = 1.0 - smoothstep( uIronDetail.w * 0.4, uIronDetail.w, ironDist );

  // Analytic footprint guard: a layer whose wavelength has fallen below ~2 px
  // is noise, not detail, and aliases into a shimmering carpet that TAA then
  // smears. fwidth of the world position is the pixel's world size.
  float ironFootprint = max( length( fwidth( vIronWorld ) ), 1e-5 );
  ironDetailFade *= 1.0 - smoothstep( 0.35, 0.9, ironFootprint * ironDetailFreq );
  ironMicroFade *= 1.0 - smoothstep( 0.35, 0.9, ironFootprint * ironDetailFreq * uIronTiling.z );

  // ---- 3 macro variation, and per-instance variation ------------------------
  // Evaluated on the surface's dominant world plane. The macro band exists to
  // break up a large FACE, so plane noise is what it wants; using volume noise
  // here doubles the hash count and changes nothing anyone can see.
  float ironUp = clamp( dot( ironGeoN, vec3( 0.0, 1.0, 0.0 ) ), 0.0, 1.0 );
  vec3 ironAbsN = abs( ironGeoN );
  vec2 ironPlane = ironAbsN.y > max( ironAbsN.x, ironAbsN.z )
    ? vIronWorld.xz : ( ironAbsN.x > ironAbsN.z ? vIronWorld.zy : vIronWorld.xy );
  float ironMacro = ironNoise2( ironPlane * 0.28 );          // ≈ 3.5 m
  float ironMacroBig = ironNoise2( ironPlane * 0.075 );      // ≈ 13 m
  float ironInstance = ironHash13( floor( vIronOrigin * 3.7 ) + uIronVary.w );

  // ---- the wear stack, LOOK_SPEC §4.4 --------------------------------------
  #ifdef IRON_WEAR
    #ifdef IRON_TRIPLANAR
      vec4 ironTexW = texture2D( uIronWearMap, ironTriP.xz * ironTriW.y
                               + ironTriP.zy * ironTriW.x + ironTriP.xy * ironTriW.z );
    #else
      vec4 ironTexW = texture2D( uIronWearMap, ironUv );
    #endif
    float ironConvex = ironTexW.a;
    float ironBakedWear = ironTexW.r;
    float ironBakedGrime = ironTexW.g;
  #else
    float ironConvex = 0.0;
    float ironBakedWear = 0.0;
    float ironBakedGrime = 0.0;
  #endif

  // Convex → chip to a lighter substrate. Broken by macro noise so the wear is
  // not uniform along an edge — a perfectly even chipped edge is worse than a
  // clean one, because clean at least reads as new.
  float ironChip = clamp( ( ironConvex * 0.75 + ironBakedWear * 0.55 )
                        * uIronWearP.x * ( 0.30 + 1.35 * ironMacro ), 0.0, 1.0 );

  // Concave → grime. Cavity comes from the bake's horizon-searched AO, so it
  // settles where water actually would.
  float ironCavity = 1.0 - ironTexN.a;
  float ironDirt = clamp( ( ironBakedGrime * 0.75 + ironCavity * 0.85 )
                        * uIronWearP.y * ( 0.40 + 1.0 * ironMacroBig ), 0.0, 1.0 );
  // Rain streaking is a VERTICAL-face phenomenon, so the ground — which is most
  // of the pixels in a grazing frame — skips the volume-noise call entirely.
  if ( ironUp < 0.72 ) {
    ironDirt = max( ironDirt, ironStreak( vIronWorld, ironMacroBig ) * ( 1.0 - ironUp ) * uIronWearP.y * 0.55 );
  }

  // N·up → dust. 40-70 % coverage on horizontals, nothing on verticals.
  float ironDust = smoothstep( 0.30, 0.86, ironUp ) * uIronWearP.z * ( 0.45 + 0.75 * ironMacro );

  // ---- apply, in the spec's order ------------------------------------------
  // Chip: a lighter, less weathered substrate, rougher-to-0.35 and metallic if
  // the material is painted metal.
  ironAlbedo = mix( ironAlbedo, ironAlbedo * 1.30 + vec3( 0.05, 0.047, 0.042 ), ironChip );
  ironRoughness = mix( ironRoughness, 0.35, ironChip * 0.75 );
  ironMetalness = mix( ironMetalness, min( 1.0, ironMetalness + 0.6 ), ironChip * step( 0.05, uIronMat.y ) );

  // Grime: darken 30-35 %, desaturate toward brown, roughen to 0.85.
  vec3 ironGrimeCol = vec3( 0.66, 0.60, 0.52 );
  ironAlbedo *= mix( vec3( 1.0 ), ironGrimeCol, ironDirt );
  ironRoughness = mix( ironRoughness, 0.85, ironDirt * 0.65 );

  // Dust: pale ochre, flat, matte.
  ironAlbedo = mix( ironAlbedo, mix( ironAlbedo, vec3( 0.44, 0.37, 0.26 ), 0.62 ), ironDust );
  ironRoughness = mix( ironRoughness, 0.88, ironDust * 0.8 );

  // Macro break-up — the term that stops a 70 m wall reading as one surface at
  // silhouette distance. LOOK_SPEC §4.1 puts the albedo band at ±8 %; the
  // roughness moves with it, because real weathering zones are both paler AND
  // rougher than the sheltered stone beside them, and a value-only break-up
  // reads as a lighting artefact rather than as weather.
  ironAlbedo *= 1.0 + 0.08 * ( ironMacroBig * 2.0 - 1.0 ) + 0.04 * ( ironMacro * 2.0 - 1.0 );
  ironRoughness = clamp( ironRoughness + 0.07 * ( ironMacroBig - 0.5 ), 0.045, 1.0 );

  // Per-instance: value, a small chroma rotation, and roughness. Two crates
  // from the same spec must not be the same crate.
  ironAlbedo *= 1.0 + uIronVary.y * ( ironInstance * 2.0 - 1.0 );
  ironAlbedo *= 1.0 + uIronVary.x * vec3( ironInstance - 0.5, 0.0, 0.5 - ironInstance );
  ironRoughness = clamp( ironRoughness + uIronVary.z * ( ironInstance - 0.5 ), 0.045, 1.0 );

  // ---- tint toward the lane's authored colour ------------------------------
  // Luminance-preserving: the baked albedo's VALUE and all of its variation
  // survive, and only its chroma moves to what the lane asked for. Multiplying
  // by the tint instead would darken every wall by the tint's own luminance and
  // crush the plaster washes into mud.
  if ( uIronTint.a > 0.0 ) {
    float ironBaseL = ironLuminance( ironAlbedo );
    float ironTintL = max( ironLuminance( uIronTint.rgb ), 1e-3 );
    // The authored colour is also the authored VALUE, so the texture's
    // luminance is pulled 35 % of the way toward it. Without that compression a
    // recipe tuned for a review chart lands on a wall as leopard print: the
    // acceptance test in LOOK_SPEC §4.1 wants σ 20–40 inside a uniform patch,
    // and the raw bake runs well past it on sand and stucco.
    float ironTargetL = mix( ironBaseL, ironTintL, 0.35 );
    vec3 ironTinted = uIronTint.rgb * ( ironTargetL / ironTintL );
    ironAlbedo = mix( ironAlbedo, ironTinted, uIronTint.a );
  }

  // ---- 4.5 wet ------------------------------------------------------------
  ironAlbedo *= mix( 1.0, 0.60, ironWet );
  ironRoughness = mix( ironRoughness, 0.15, ironWet );

  // LOOK_SPEC §4.3: nothing below linear 0.035, nothing above 0.82. Values
  // outside are physically impossible and read as such.
  ironAlbedo = clamp( ironAlbedo, vec3( 0.035 ), vec3( 0.82 ) );

  // ---- normal assembly ------------------------------------------------------
  // ONE tangent frame for all three layers. Building a fresh frame per layer
  // costs four screen-space derivatives and two cross products each, and the
  // frames only differ in their z axis — so the slopes are accumulated in the
  // geometric frame and transformed once, which is what UDN blending is anyway.
  float ironNStr = ( 1.0 - 0.45 * ironDust ) * ( 1.0 - 0.8 * ironWet );

  #ifdef IRON_TRIPLANAR
    // Detail on the DOMINANT axis only — the same plane the macro band used.
    // At 2 cm the projection seam is far below a pixel and three more dependent
    // fetches on terrain are not.
    vec2 ironDetUv = ironPlane;
  #else
    vec2 ironDetUv = vIronUv;
  #endif

  // Machined and turned metal carries its scratch band ALONG the direction of
  // use, never isotropically (LOOK_SPEC §4.2). Stretching the detail lookup
  // 6:1 turns the same normal map into directional scratches for free.
  #ifdef IRON_ANISO
    ironDetUv *= vec2( 0.17, 1.0 );
  #endif

  mat3 ironTbn = ironTangentFrame( ironGeoN, vIronWorld, ironDetUv );

  vec2 ironSlope = vec2( 0.0 );
  if ( ironDetailFade > 0.002 ) {
    ironSlope += ( texture2D( uIronNormalRoughAo, ironDetUv * ironDetailFreq ).rg * 2.0 - 1.0 )
      * uIronDetail.x * ironDetailFade * ironNStr;
  }
  if ( ironMicroFade > 0.002 ) {
    ironSlope += ( texture2D( uIronNormalRoughAo,
      ironDetUv * ironDetailFreq * uIronTiling.z + vec2( 0.37, 0.11 ) ).rg * 2.0 - 1.0 )
      * uIronDetail.y * ironMicroFade * ironNStr;
  }

  vec3 ironNormalW;
  #ifdef IRON_TRIPLANAR
    ironNormalW = ironTriNormal( uIronNormalRoughAo, ironTriP, ironTriW, ironGeoN, ironNStr );
    ironNormalW = normalize( ironNormalW + ironTbn[ 0 ] * ironSlope.x + ironTbn[ 1 ] * ironSlope.y );
  #else
    // 0.8, not 1.0. The bake authors its normal strength against a flat review
    // chart lit head-on; on a real facade at a raking 11° sun the same relief
    // reads embossed, because every block edge is catching a terminator. This
    // is the one place the bake's own number is deliberately not believed.
    ironSlope += ( ironTexN.rg * 2.0 - 1.0 ) * ironNStr * 0.7;
    ironNormalW = normalize( ironTbn * vec3( ironSlope, 1.0 ) );
  #endif

  // Wet surfaces flatten toward the geometric normal: water fills the relief.
  ironNormalW = normalize( mix( ironNormalW, ironGeoN, ironWet * 0.8 ) );

  // Toksvig-ish roughness lift where the normal has been bent a long way from
  // geometric. Without it, distant micro-detail sparkles and no amount of TAA
  // fixes it — the same reason the bake ships RoughnessToksvig mips.
  ironRoughness = clamp( ironRoughness
    + ( 1.0 - clamp( dot( ironNormalW, ironGeoN ), 0.0, 1.0 ) ) * 0.35, 0.045, 1.0 );

  diffuseColor.rgb = ironAlbedo;

  #ifdef IRON_ALPHA_FROM_HEIGHT
    diffuseColor.a *= ironTexA.a;
  #endif

  #ifdef IRON_SOFT_PARTICLE
  if ( uIronSoft.y > 0.5 ) {
    vec2 ironScreenUv = gl_FragCoord.xy * uIronScreen;
    float ironSceneZ = texture2D( uIronSceneDepth, ironScreenUv ).x;
    float ironSceneLin = ironLinearDepth( ironSceneZ, uIronSoft.z, uIronSoft.w );
    float ironFragLin = ironLinearDepth( gl_FragCoord.z, uIronSoft.z, uIronSoft.w );
    diffuseColor.a *= clamp( ( ironSceneLin - ironFragLin ) / max( uIronSoft.x, 1e-3 ), 0.0, 1.0 );
  }
  #endif

  #ifdef IRON_DITHER_FADE
  {
    // Hashed alpha. Converts a fractional alpha into a stable stochastic
    // pattern that TAA resolves into a real crossfade, which is how an impostor
    // swaps LOD without a visible pop and without sorting as a transparent.
    float ironDither = ironHash13( vec3( gl_FragCoord.xy, uIronVary.w ) );
    if ( diffuseColor.a < ironDither ) discard;
    diffuseColor.a = 1.0;
  }
  #endif
`;

/** Replaces `<roughnessmap_fragment>`. */
export const IRON_ROUGHNESS = /* glsl */ `
  float roughnessFactor = ironRoughness;
`;

/** Replaces `<metalnessmap_fragment>`. */
export const IRON_METALNESS = /* glsl */ `
  float metalnessFactor = ironMetalness;
`;

/**
 * Replaces `<normal_fragment_maps>`. `normal` at this point is the interpolated
 * view-space vertex normal, already flipped for the back face; ours is world
 * space, so it goes through the view matrix and takes the same flip.
 */
export const IRON_NORMAL_APPLY = /* glsl */ `
  {
    vec3 ironVN = normalize( ( viewMatrix * vec4( ironNormalW, 0.0 ) ).xyz );
    #ifdef DOUBLE_SIDED
      ironVN *= faceDirection;
    #endif
    normal = ironVN;
  }
`;

/**
 * Replaces `<aomap_fragment>`, and carries the two things three cannot do for
 * us with no env map bound.
 *
 * 1. AO on INDIRECT only. A scalar AO multiply on the final colour is the
 *    mistake LOOK_SPEC §2.5 names explicitly: it produces dirty grey shadows.
 * 2. The ambient SPECULAR lobe. Without an env map three's `indirectSpecular`
 *    is zero, so a matte wall has no grazing sheen at all and every large flat
 *    surface reads as paper. LOOK_SPEC §4.2 is explicit that it must be there.
 *    The lobe is built from whatever ambient the lighting lane has actually
 *    put in the scene — hemisphere first, flat ambient second — so it vanishes
 *    the moment a real PMREM env map arrives and three does the job properly.
 */
export const IRON_AO_AND_SHEEN = /* glsl */ `
  {
    float ironAoFinal = ironAo;
    reflectedLight.indirectDiffuse *= ironAoFinal;
    #if defined( USE_SHEEN )
      sheenSpecularIndirect *= ironAoFinal;
    #endif
    float ironDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( ironDotNV, ironAoFinal, material.roughness );

    #ifndef USE_ENVMAP
      vec3 ironAmbientRadiance = vec3( 0.0 );
      #if NUM_HEMI_LIGHTS > 0
        vec3 ironRefl = reflect( - ironViewDirW, ironNormalW );
        // Irradiance → radiance. Three's hemisphere uniforms are irradiance-like
        // (they are consumed through BRDF_Lambert, which carries the 1/π), so
        // reusing them as radiance without this is a π× too-bright rim.
        ironAmbientRadiance = mix( hemisphereLights[ 0 ].groundColor,
                                   hemisphereLights[ 0 ].skyColor,
                                   smoothstep( -0.25, 0.45, ironRefl.y ) ) * RECIPROCAL_PI;
      #else
        ironAmbientRadiance = ambientLightColor * RECIPROCAL_PI;
      #endif
      // Three's own split-sum term, off the same DFG LUT the IBL path uses, so
      // the fallback lobe and the real IBL lobe agree exactly in shape and only
      // differ in where the radiance came from.
      vec3 ironFssEss = EnvironmentBRDF( geometryNormal, geometryViewDir,
        material.specularColor, material.specularF90, material.roughness );
      reflectedLight.indirectSpecular += ironAmbientRadiance * ironFssEss
        * computeSpecularOcclusion( ironDotNV, ironAoFinal, material.roughness );
    #endif
  }
`;

/**
 * Two-sided translucency for foliage, injected after `<lights_fragment_end>`.
 * LOOK_SPEC §4.7: a backlit palm frond is BRIGHTER and more saturated than a
 * front-lit one, which reflection alone cannot produce. Wrap-transmission
 * through the leaf, with a forward-scattering lobe.
 */
export const IRON_TRANSLUCENCY = /* glsl */ `
  #if NUM_DIR_LIGHTS > 0
  {
    IncidentLight ironTL;
    DirectionalLight ironDL = directionalLights[ 0 ];
    getDirectionalLightInfo( ironDL, ironTL );
    // IncidentLight.direction points TOWARD the light. Backlit therefore
    // means the light lies opposite the eye: dot(-V, L) > 0.
    float ironBack = saturate( dot( - geometryViewDir, ironTL.direction ) );
    float ironThrough = pow( ironBack, 3.0 ) * 0.85
      + saturate( dot( geometryNormal, - ironTL.direction ) ) * 0.25;
    reflectedLight.directDiffuse += ironTL.color * ironThrough * diffuseColor.rgb * 1.35;
  }
  #endif
`;
