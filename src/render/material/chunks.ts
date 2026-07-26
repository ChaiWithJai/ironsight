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
/**
 * The BLOCK LATTICE, which is how this material stops repeating.
 *
 *   x  cells across one texture repeat   (4 for the ashlar bake's 4×8 courses)
 *   y  cells down one texture repeat     (8)
 *   z  running-bond offset in cells      (0.5 for masonry, 0 for a stack bond)
 *   w  per-cell tonal amplitude, 0 disables the layer
 *
 * Both a quantiser and a cell size: the stochastic tile offset is rounded to
 * whole cells so every phase of the tile lands its mortar courses on the same
 * global grid, and the per-stone tonal field uses the same cell in world metres.
 */
uniform vec4 uIronBlock;
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

/**
 * Value noise AND its analytic gradient, from the same four hashes.
 *
 * This is what the detail and micro normal bands are built from, and the reason
 * they are not a re-tiled fetch of the baked normal map any more. That map
 * carries the material's STRUCTURE — for sandstone, a 4 × 8 ashlar grid — and
 * re-tiling it at twenty repeats per metre lays a two-centimetre brick lattice
 * over every surface in the game. On a wall it hides inside the real coursing;
 * on a flat sand plaza seen at a grazing angle it is a perfectly regular
 * diagonal cross-hatch running to the horizon, and it is the single most
 * findable repeat in the frame.
 *
 * What those bands are supposed to carry is GRAIN — pitting, sand, tool marks —
 * which has no structure at all. Four hashes per octave is also cheaper than the
 * dependent texture fetch it replaces.
 */
vec3 ironNoiseD2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  vec2 du = 6.0 * f * ( 1.0 - f );
  float a = ironHash13( vec3( i, 0.0 ) );
  float b = ironHash13( vec3( i + vec2( 1.0, 0.0 ), 0.0 ) );
  float c = ironHash13( vec3( i + vec2( 0.0, 1.0 ), 0.0 ) );
  float d = ironHash13( vec3( i + vec2( 1.0, 1.0 ), 0.0 ) );
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;
  return vec3(
    a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    du.x * ( k1 + k3 * u.y ),
    du.y * ( k2 + k3 * u.x ) );
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

/** Two decorrelated hashes of one lattice point. */
vec2 ironHash22( vec2 p, float s ) {
  return vec2( ironHash13( vec3( p, s ) ), ironHash13( vec3( p.yx, s + 19.73 ) ) );
}

/* --------------------------------------------------- stochastic tiling --- */

/**
 * Triangle-lattice decomposition (Heitz & Neyret, "High-Performance By-Example
 * Noise using a Histogram-Preserving Blending Operator", 2018). Every point
 * lies inside one triangle of a skewed unit grid; the three corners and their
 * barycentric weights are what the stochastic sampler blends between.
 *
 * A TRIANGLE lattice, not a square one: three taps is the minimum that can
 * cover the plane with a partition of unity, and a square grid needs four —
 * which on this shader is two more dependent fetches per map for no extra
 * decorrelation.
 */
void ironTriGrid( vec2 p, out vec2 v1, out vec2 v2, out vec2 v3, out vec3 w ) {
  mat2 ironSkew = mat2( 1.0, 0.0, -0.57735027, 1.15470054 );
  vec2 s = ironSkew * p;
  vec2 base = floor( s );
  vec2 f = fract( s );
  float z = 1.0 - f.x - f.y;
  if ( z > 0.0 ) {
    w = vec3( z, f.y, f.x );
    v1 = base;
    v2 = base + vec2( 0.0, 1.0 );
    v3 = base + vec2( 1.0, 0.0 );
  } else {
    w = vec3( - z, 1.0 - f.y, 1.0 - f.x );
    v1 = base + vec2( 1.0, 1.0 );
    v2 = base + vec2( 1.0, 0.0 );
    v3 = base + vec2( 0.0, 1.0 );
  }
}

/**
 * The per-vertex UV offset that decorrelates one tap from the next.
 *
 * On a material with a block lattice the offset is QUANTISED to whole cells.
 * That is the whole trick: an arbitrary offset slides the mortar courses by a
 * fraction of a block, so the blend boundary between two taps shows up as a
 * step in the coursing — a worse and more obviously synthetic artefact than the
 * repeat it was removing. Quantised, every tap puts its courses on the same
 * global grid and only the block CONTENT permutes, which is what a real wall
 * built from one quarry actually looks like.
 */
vec2 ironTileOffset( vec2 v ) {
  vec2 o = ironHash22( v, 1.0 + uIronVary.w );
  #ifdef IRON_TILE_LATTICE
    o = floor( o * uIronBlock.xy ) / uIronBlock.xy;
  #endif
  return o;
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
 * Rain streaking, as the RAW field. Vertical faces in every reference frame
 * carry washed and unwashed bands running down from every ledge; it is one of
 * the strongest "this building has stood outside" cues and it costs one noise
 * call. Anisotropic on purpose: 40 cm across, 6 m down.
 *
 * Returned unthresholded because the field has to be read from BOTH ends. Its
 * high tail is where run-off has deposited and the wall is dirty and rough; its
 * low tail is where the same water has SCOURED, and that strip is cleaner,
 * paler and — the part that matters for the specular — markedly smoother than
 * the sheltered stone beside it. Taking only the dirty end, which is what this
 * did, leaves a wall whose roughness never leaves a 0.05 band, and a surface
 * with no roughness structure has no specular structure either.
 */
float ironStreakField( vec3 p, float broad ) {
  float s = ironNoise3( vec3( p.x * 2.6, p.y * 0.16, p.z * 2.6 ) );
  return s * 0.65 + broad * 0.45;
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
  vec2 ironUv = vIronUv * ironScale;
  // Derivatives of the UNSHIFTED uv, captured before parallax and before the
  // stochastic offsets move it. Every base fetch below uses them explicitly:
  // an offset that jumps at a lattice edge makes the implicit derivative there
  // enormous, and the hardware answers with mip 8 — a blurred line along every
  // cell boundary, which is precisely the lattice the offsets exist to hide.
  vec2 ironDdx = dFdx( ironUv );
  vec2 ironDdy = dFdy( ironUv );

  // ---- the dominant world plane, needed by everything below -----------------
  float ironUp = clamp( dot( ironGeoN, vec3( 0.0, 1.0, 0.0 ) ), 0.0, 1.0 );
  vec3 ironAbsN = abs( ironGeoN );
  vec2 ironPlane = ironAbsN.y > max( ironAbsN.x, ironAbsN.z )
    ? vIronWorld.xz : ( ironAbsN.x > ironAbsN.z ? vIronWorld.zy : vIronWorld.xy );

  // ---- 3 the low-frequency field set, LOOK_SPEC §4.1 ------------------------
  // Three octaves at the spec's non-harmonic ratios 1.00 / 3.70 / 13.90 on an
  // 11.1 m base — 11.1 m, 3.0 m, 0.80 m — plus the 0.03 m⁻¹ (33 m) mask the
  // spec requires to modulate them.
  //
  // Every one of those wavelengths is IRRATIONAL against every tiling rate the
  // bake ships (1.4-2.6 m). That is not decoration: a break-up layer whose
  // wavelength is commensurate with the tile beats against it and produces a
  // second, COARSER lattice — which is worse than the repeat it was hiding,
  // because a 2.4 m repeat is at least small enough to read as masonry and a
  // 12 m beat reads as nothing at all.
  float ironLf0 = ironNoise2( ironPlane * 0.0901 );                              // 11.1 m
  float ironLf1 = ironNoise2( ironPlane * 0.3333 + vec2( 17.31, 5.77 ) );        //  3.0 m
  float ironLf2 = ironNoise2( ironPlane * 1.2524 + vec2( 3.19, 41.70 ) );        //  0.8 m
  float ironLfMask = 0.45 + 1.10 * ironNoise2( ironPlane * 0.0303 + vec2( 61.3, 8.9 ) );

  #ifdef IRON_TRIPLANAR
    vec3 ironTriW = ironTriWeights( ironGeoN, uIronTiling.w );
    // DOMAIN WARP, the triplanar answer to visible tiling.
    //
    // Triplanar cannot take the stochastic path: three projections × three taps
    // is nine dependent fetches per map on the heaviest fragment in the frame
    // (the terrain covers most of a grazing shot). It does not need to. Sand,
    // rock and rubble have no straight structure to protect, so bending the
    // sample position with the low-frequency field already computed above
    // destroys the lattice for the cost of two multiply-adds — and a warp
    // cannot produce a seam, because it is continuous everywhere.
    //
    // Amplitude is expressed in TILES so it scales with whatever tiling rate
    // the bake ships: ±0.53 tiles of coarse bend plus ±0.16 of fine, which is
    // enough to break the alignment of two neighbouring repeats completely.
    vec2 ironWarpM = ( vec2( ironLf0, ironLf1 ) - 0.5 ) * ( uIronTiling.x * 1.05 )
                   + ( vec2( ironLf1, ironLf2 ) - 0.5 ) * ( uIronTiling.x * 0.32 );
    vec3 ironTriP = ( vIronWorld
      + vec3( ironWarpM.x, ( ironLf2 - 0.5 ) * uIronTiling.x * 0.55, ironWarpM.y ) ) * ironScale;
  #else
    vec3 ironTriP = vIronWorld * ironScale;
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
  // ironWearUv is the offset the wear map is fetched at further down, so the
  // wear stack stays registered with whichever phase of the tile won here.
  vec2 ironWearUv = vec2( 0.0 );
  #ifdef IRON_TRIPLANAR
    vec4 ironTexA = ironTriSample( uIronAlbedoHeight, ironTriP, ironTriW );
    vec4 ironTexN = ironTriSample( uIronNormalRoughAo, ironTriP, ironTriW );
  #elif defined( IRON_STOCHASTIC )
    vec4 ironTexA;
    vec4 ironTexN;
    {
      // The lattice is ~1.2 tiles across, and its input is warped by the 0.8 m
      // and 3.0 m bands so the cell boundaries are irregular curves. A straight
      // cell edge is itself a lattice, and the eye finds a straight line far
      // faster than it finds a repeated texture.
      vec2 sv1, sv2, sv3;
      vec3 sw;
      ironTriGrid( ironUv * 0.85 + vec2( ironLf2 - 0.5, ironLf1 - 0.5 ) * 0.42,
                   sv1, sv2, sv3, sw );
      vec2 o1 = ironTileOffset( sv1 );
      vec2 o2 = ironTileOffset( sv2 );
      vec2 o3 = ironTileOffset( sv3 );
      // Two taps, not three, wherever the third corner contributes less than 4 %.
      // That is roughly a fifth of the plane and it is two dependent fetches
      // saved on every one of those pixels; the result is continuous because the
      // weight being dropped is already going to zero. Legal inside non-uniform
      // control flow only because every fetch here carries explicit gradients.
      float ironTap3 = step( 0.04, sw.z );
      vec4 a1 = texture2DGradEXT( uIronAlbedoHeight, ironUv + o1, ironDdx, ironDdy );
      vec4 a2 = texture2DGradEXT( uIronAlbedoHeight, ironUv + o2, ironDdx, ironDdy );
      vec4 a3 = vec4( 0.0 );
      if ( ironTap3 > 0.5 ) a3 = texture2DGradEXT( uIronAlbedoHeight, ironUv + o3, ironDdx, ironDdy );

      // HEIGHT-WEIGHTED, not barycentric. A linear blend of three phases of the
      // same masonry is three walls superimposed — every block ghosted, every
      // course half-strength, and a flatter histogram than the source. Biasing
      // the weights by the height channel makes the PROUDEST sample win almost
      // everywhere, so each patch of wall shows one phase at full contrast and
      // the crossings run down the mortar, which is where a real wall's
      // discontinuities are anyway.
      vec3 hw = sw * exp2( vec3( a1.a, a2.a, a3.a ) * 8.0 ) * vec3( 1.0, 1.0, ironTap3 );
      hw /= max( hw.x + hw.y + hw.z, 1e-5 );
      ironTexA = a1 * hw.x + a2 * hw.y + a3 * hw.z;
      ironTexN = texture2DGradEXT( uIronNormalRoughAo, ironUv + o1, ironDdx, ironDdy ) * hw.x
               + texture2DGradEXT( uIronNormalRoughAo, ironUv + o2, ironDdx, ironDdy ) * hw.y;
      if ( ironTap3 > 0.5 ) {
        ironTexN += texture2DGradEXT( uIronNormalRoughAo, ironUv + o3, ironDdx, ironDdy ) * hw.z;
      }
      // One tap for the wear map, at the winning phase. Wear is a mask that the
      // macro band modulates before anything sees it, so a hard switch inside it
      // is invisible — and a fourth, fifth and sixth fetch to soften something
      // nobody can see is not a trade worth making.
      ironWearUv = hw.x > max( hw.y, hw.z ) ? o1 : ( hw.y > hw.z ? o2 : o3 );
    }
  #else
    vec4 ironTexA = texture2DGradEXT( uIronAlbedoHeight, ironUv, ironDdx, ironDdy );
    vec4 ironTexN = texture2DGradEXT( uIronNormalRoughAo, ironUv, ironDdx, ironDdy );
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
  // Procedural grain, two bands, from ironNoiseD2's analytic gradient. What
  // matters is that the surface keeps resolving as the camera closes — item two
  // on the brief's defect list — WITHOUT importing the base map's block pattern
  // into a band where a block pattern has no business being.
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
  // Composed from the octave set built at the top of the shader, so the wear
  // stack, the tile warp and the albedo band all ride the SAME field — a
  // grimier zone is also a paler zone is also a rougher zone, which is what
  // weathering does and what three independent noise fields never look like.
  float ironMacro = ironLf0 * 0.54 + ironLf1 * 0.31 + ironLf2 * 0.15;
  float ironMacroBig = ironLf0;
  float ironInstance = ironHash13( floor( vIronOrigin * 3.7 ) + uIronVary.w );

  // ---- 2 the per-stone tonal field, LOOK_SPEC §4.1 layer 2 ------------------
  // "Two bricks in a wall are never the same colour." The bake carries a
  // per-block colour jitter, but it is INSIDE a 2.4 m tile, so a 20 m facade is
  // the same thirty-two stones eight times over and the eye finds that grid in
  // about a second. This lattice is in WORLD metres and therefore never recurs.
  //
  // Cell size and running bond come from the bake pattern's own geometry
  // (uIronBlock), so the tonal units are block-sized and block-shaped. Their
  // PHASE cannot be matched — the bake's per-course jitter is not exposed and
  // LEVEL's uvs restart at every quad — so the field is feathered to neutral
  // over the outer fifth of each cell instead of being cut hard at the edge. A
  // soft-edged tonal patch that misses the joint by 10 cm reads as weathering;
  // a hard-edged one reads as a bug.
  float ironStone = 0.0;
  #ifdef IRON_STONE
  {
    vec2 cellM = uIronTiling.x / max( uIronBlock.xy, vec2( 0.25 ) );
    vec2 g = ironPlane / cellM;
    float course = floor( g.y );
    g.x += mod( course, 2.0 ) * uIronBlock.z + ironHash13( vec3( 0.0, course, 3.17 ) ) * 0.37;
    vec2 fc = fract( vec2( g.x, g.y ) );
    float rnd = ironHash13( vec3( floor( g.x ), course, 7.31 + uIronVary.w ) );
    float face = smoothstep( 0.0, 0.20, min( fc.x, 1.0 - fc.x ) )
               * smoothstep( 0.0, 0.20, min( fc.y, 1.0 - fc.y ) );
    // ±1, zero on the joints. Modulated by the 33 m mask so whole quarters of
    // the town are more varied than others, which is what a real street does.
    ironStone = ( rnd - 0.5 ) * 2.0 * face * uIronBlock.w * clamp( ironLfMask, 0.35, 1.4 );
  }
  #endif

  // ---- the wear stack, LOOK_SPEC §4.4 --------------------------------------
  #ifdef IRON_WEAR
    #ifdef IRON_TRIPLANAR
      // Blend the three SAMPLES, never the three coordinates. Summing the
      // coordinates first and taking one fetch lands the lookup at a point that
      // exists on no projection at all, and on a 45° face — every cliff and every
      // rubble pile — it sweeps that point across the map as the normal turns,
      // which reads as the wear mask sliding over the geometry it is supposed to
      // be bolted to.
      vec4 ironTexW = ironTriSample( uIronWearMap, ironTriP, ironTriW );
    #else
      vec4 ironTexW = texture2DGradEXT( uIronWearMap, ironUv + ironWearUv, ironDdx, ironDdy );
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
  //
  // GATED ON EXPOSURE, and that gate is the difference between a chip and a
  // noise field. ironConvex is the bake's discrete Laplacian of the height map
  // (src/bake/textures.ts): it fires on every texel-scale inflection there is,
  // including the ones at the BOTTOM of a mortar joint, so used raw it lays a
  // high-frequency wash of pale speckle across the whole face — the "identical
  // crumpled-foil noise patch" of the round-1 material critique — instead of the
  // chipped arrises LOOK_SPEC §4.4 is actually describing. Physically a chip
  // needs three things at once: convex curvature, material standing PROUD of the
  // mean surface, and exposure to whatever knocked it off. The bake ships the
  // first; the height and AO channels are the other two, and requiring all three
  // collapses the mask from a texture-wide wash onto the edges.
  float ironExposed = smoothstep( 0.45, 0.85, ironTexA.a ) * smoothstep( 0.55, 0.90, ironTexN.a );
  // 0.18 rather than 0.55 on the baked channel because the bake has ALREADY
  // mixed its own wear channel into the albedo and the roughness it shipped, so the
  // old weight was applying one mask twice and roughly doubling its contrast.
  // What is left is a hint that keeps the shader's chip registered with the
  // bake's rather than a second, independent layer of it.
  float ironChip = clamp( ( ironConvex * 0.85 * ironExposed + ironBakedWear * 0.18 )
                        * uIronWearP.x * ( 0.30 + 1.35 * ironMacro ), 0.0, 1.0 );

  // Concave → grime. Cavity comes from the bake's horizon-searched AO, so it
  // settles where water actually would.
  //
  // GATED ON DEPTH, for the mirror-image reason the chip is gated on exposure.
  // The bake's AO is a texel-scale horizon search, so it is nonzero all over a
  // rough face — every pit, every fleck, every grain of the finest octave — and
  // driving a 34 % albedo darkening straight off it paints a high-frequency
  // brown mottle over the whole block that reads as camouflage rather than as
  // weathering. LOOK_SPEC §4.4 is specific about where grime goes: "follows
  // creases, rivet lines, panel gaps". Those are the parts of the surface that
  // are genuinely RECESSED, which the height channel knows and the AO channel
  // does not. Requiring both puts the darkening back into the coursing and off
  // the faces, which is also where a real wall's run-off collects.
  float ironCavity = ( 1.0 - ironTexN.a ) * smoothstep( 0.62, 0.18, ironTexA.a );
  float ironDirt = clamp( ( ironBakedGrime * 0.75 + ironCavity * 0.85 )
                        * uIronWearP.y * ( 0.40 + 1.0 * ironMacroBig ), 0.0, 1.0 );
  // Rain streaking is a VERTICAL-face phenomenon, so the ground — which is most
  // of the pixels in a grazing frame — skips the volume-noise call entirely.
  // One noise evaluation, read from both tails: the deposit band darkens and
  // roughens, the scoured band (applied further down, after the dust) polishes.
  float ironWash = 0.0;
  if ( ironUp < 0.72 ) {
    float ironStreakV = ironStreakField( vIronWorld, ironMacroBig );
    // 0.50-0.80 rather than 0.42-0.92, and 1.05 rather than 0.55. The old band
    // was both too wide and too weak: it spread a 9 % darkening over most of
    // every vertical face, which is a uniform tint by another name. Run-off
    // makes NARROW tracks with clean stone between them, and the round-1
    // critique's "no grime running from the cornice, no water streaking below
    // the arch springers" is the shape of that failure, not its amount. Tightened
    // and strengthened, the deposit reaches a 17 % darkening inside the track,
    // against LOOK_SPEC §4.4's 30-35 % for a full cavity.
    ironDirt = max( ironDirt, smoothstep( 0.50, 0.80, ironStreakV )
      * ( 1.0 - ironUp ) * uIronWearP.y * 1.05 );
    ironWash = smoothstep( 0.30, 0.02, ironStreakV ) * ( 1.0 - ironUp );
  }

  // N·up → dust. 40-70 % coverage on horizontals, nothing on verticals.
  float ironDust = smoothstep( 0.30, 0.86, ironUp ) * uIronWearP.z * ( 0.45 + 0.75 * ironMacro );

  // SILT — dust that has FILLED rather than coated.
  //
  // Wind-blown dust does not settle evenly: it drops out of the air into the low
  // points first and only coats the high ones once the low ones are level. A
  // paved square is therefore a field of block faces with silted-up joints, and
  // the joints that are still legible are the ones the wind scours — never all
  // of them, and never on a grid.
  //
  // Without this term the dust is a flat wash laid over relief still at full
  // strength, and a horizontal ashlar surface keeps a razor-sharp joint grid
  // running unbroken to the horizon. That grid is a texture repeat by any other
  // name and it is the first thing the rubric's material test looks for. The
  // fill is driven by the height channel and gated by the same macro field the
  // dust is, so it varies over 3-11 m and never reads as a uniform blur.
  // 1.7, not 2.4. At 2.4 the joint grid went, and so did LOOK_SPEC §4.1's
  // acceptance floor: the paving measured a display-luminance σ of 8.8 in a
  // nominally uniform patch against a floor of 12, i.e. it had crossed from
  // "silted" into "untextured", which is the defect on the other side of the
  // one this term exists to fix. The fill has to remove the GRID without
  // removing the relief that is not on a grid.
  float ironSilt = clamp( ironDust * ( 1.0 - ironTexA.a ) * 1.7, 0.0, 1.0 );

  // ---- apply, in the spec's order ------------------------------------------
  // Chip: a lighter, less weathered substrate, and metallic if the material is
  // painted metal.
  //
  // The 0.35 roughness LOOK_SPEC §4.4 gives for a chip is a PAINT-to-METAL
  // number — its evidence is a chipped MG receiver. A chip in sandstone exposes
  // fresh mineral, which is a little smoother than the weathered face it broke
  // out of and nothing like satin. Applying 0.35 to stone puts a specular
  // highlight on every arris in the town, and under an 11° raking sun a wall of
  // those reads as white speckle rather than as stone — so the substrate
  // gloss follows the substrate, which is what the material's metalness says.
  //
  // 1.18 and a 0.035 lift, down from 1.30 and 0.05. Fresh sandstone broken out
  // of a weathered face is about a fifth brighter than the crust, not half again
  // — and the old numbers were being applied through a mask that covered the
  // whole surface, so together they were most of the frame's excess luminance
  // variance (measured σ 50 against LOOK_SPEC §4.1's 20-40 window).
  float ironChipRough = mix( 0.72, 0.35, step( 0.05, uIronMat.y ) );
  ironAlbedo = mix( ironAlbedo, ironAlbedo * 1.18 + vec3( 0.035, 0.033, 0.030 ), ironChip );
  ironRoughness = mix( ironRoughness, ironChipRough, ironChip * 0.75 );
  ironMetalness = mix( ironMetalness, min( 1.0, ironMetalness + 0.6 ), ironChip * step( 0.05, uIronMat.y ) );

  // Grime: darken 30-35 %, desaturate toward brown, roughen to 0.85.
  vec3 ironGrimeCol = vec3( 0.66, 0.60, 0.52 );
  ironAlbedo *= mix( vec3( 1.0 ), ironGrimeCol, ironDirt );
  ironRoughness = mix( ironRoughness, 0.85, ironDirt * 0.65 );

  // Dust: pale ochre, flat, matte. Coverage is the coat plus the fill, so a
  // silted joint takes the dust's colour fully while the block face beside it
  // only takes the wash.
  float ironDustCover = clamp( ironDust + ironSilt * 0.75, 0.0, 1.0 );
  ironAlbedo = mix( ironAlbedo, mix( ironAlbedo, vec3( 0.44, 0.37, 0.26 ), 0.62 ), ironDustCover );
  ironRoughness = mix( ironRoughness, 0.88, ironDustCover * 0.8 );
  // A silted groove is no longer a groove: it has stopped occluding. Leaving the
  // baked cavity AO at full strength under a filled joint is what keeps the grid
  // legible even after the albedo has stopped showing it.
  ironAo = mix( ironAo, 1.0, ironSilt * 0.58 );

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

  // ---- the variation bands, applied AFTER the tint -------------------------
  // Order matters and this is the one place it was wrong. The tint pulls the
  // albedo 35 % of the way to one authored luminance; anything applied before
  // it therefore comes out at ~72 % strength, which is most of the reason a
  // twenty-metre facade of thirty-two individually-jittered blocks was reading
  // as one flat colour. Weathering sits ON a material, not under its paint.

  // Per-stone (mesoscale, 0.15-0.6 m). Value, a small chroma rotation and
  // roughness on the same field: real stone that has weathered paler has also
  // weathered rougher, and a value-only jitter reads as a lighting artefact.
  ironAlbedo *= 1.0 + 0.115 * ironStone;
  ironAlbedo *= 1.0 + 0.05 * ironStone * vec3( 1.0, 0.12, -0.85 );
  ironRoughness = clamp( ironRoughness + 0.085 * ironStone, 0.045, 1.0 );

  // Macro break-up (3-12 m) — the term that stops a 70 m wall reading as one
  // surface at silhouette distance. LOOK_SPEC §4.1 puts the albedo band at
  // ±8 %, modulated by the 0.03 m⁻¹ mask; the roughness moves with it, because
  // weathering zones are both paler AND rougher than the sheltered stone beside
  // them.
  ironAlbedo *= 1.0 + 0.08 * ironLfMask * ( ironMacroBig * 2.0 - 1.0 )
                    + 0.035 * ( ironMacro * 2.0 - 1.0 );
  ironRoughness = clamp( ironRoughness + 0.07 * ( ironMacroBig - 0.5 ), 0.045, 1.0 );

  // Per-instance: value, a small chroma rotation, and roughness. Two crates
  // from the same spec must not be the same crate.
  ironAlbedo *= 1.0 + uIronVary.y * ( ironInstance * 2.0 - 1.0 );
  ironAlbedo *= 1.0 + uIronVary.x * vec3( ironInstance - 0.5, 0.0, 0.5 - ironInstance );
  ironRoughness = clamp( ironRoughness + uIronVary.z * ( ironInstance - 0.5 ), 0.045, 1.0 );

  // ---- rain-scoured strips, LOOK_SPEC §4.2 ---------------------------------
  // "Weathered stucco / plaster 0.72-0.88, rain-washed strips → 0.60, sheltered
  // → 0.90." The sheltered end of that range was the only end this material
  // implemented, so every architectural surface in the frame sat inside a 0.05
  // roughness band and the round-1 critique's "roughness is uniform across every
  // material in frame, and there is no Fresnel response anywhere" was simply
  // true: at roughness 0.95 three's split-sum DFG returns the same number at 0°
  // and at 85° incidence, so a surface pinned there CANNOT show a grazing lift
  // no matter how correct the Fresnel underneath it is.
  //
  // 0.60 against a 0.93 substrate is a 0.33 spread on one wall, and it is what
  // puts the specular back: the scoured tracks catch the sky where the sheltered
  // stone between them does not, which is the vertical banding visible on every
  // weathered facade in the reference corpus. Paler by 7 % on the same mask,
  // because scouring removes the weathering crust rather than adding to it.
  ironRoughness = mix( ironRoughness, 0.60, ironWash * 0.75 );
  ironAlbedo *= 1.0 + 0.07 * ironWash;

  // ---- 4.5 wet ------------------------------------------------------------
  ironAlbedo *= mix( 1.0, 0.60, ironWet );
  ironRoughness = mix( ironRoughness, 0.15, ironWet );

  // LOOK_SPEC §4.3: nothing below linear 0.035, nothing above 0.82. Values
  // outside are physically impossible and read as such.
  ironAlbedo = clamp( ironAlbedo, vec3( 0.035 ), vec3( 0.82 ) );

  // ---- normal assembly ------------------------------------------------------
  // TWO frames, and only two. The baked band keeps the uv frame it was authored
  // in because it carries the material's structure; the two procedural grain
  // bands take an analytic world-plane frame because they carry no structure at
  // all and must not inherit a lane's uv layout. Both are accumulated as slopes
  // and combined once at the end, which is what UDN blending is anyway.
  // Silt flattens harder than a dust coat does, because it has physically
  // removed the relief rather than powdered it.
  float ironNStr = ( 1.0 - 0.42 * ironDust ) * ( 1.0 - 0.44 * ironSilt ) * ( 1.0 - 0.8 * ironWet );

  // ---- the GRAIN FRAME, in world metres -------------------------------------
  // The detail and micro bands are PHYSICAL features — 2-5 cm pitting and 2-6 mm
  // grain — so their frequency has to be quoted per metre, not per uv unit. Read
  // in uv the way they were, their scale is at the mercy of whatever
  // parameterisation the emitting lane happened to author: a facade quad whose u
  // runs across 30 m and whose v runs across 4 m stretches the band 7:1, and the
  // result is the "identical crumpled-foil patch, stretched into vertical
  // streaks as the wall recedes" that the round-1 material critique named. It
  // cannot be fixed from the uv side, because sixteen lanes author uvs sixteen
  // ways and the ones that are atlases must not be touched at all.
  //
  // Evaluated instead on the dominant world plane at repeats per METRE, the
  // grain's texel density is uniform across every face of every mesh in the game
  // by construction, and no lane can break it.
  //
  // MINUS THE OBJECT ORIGIN on the uv path. A world-locked grain field crawls
  // over anything that MOVES through it — most visibly the viewmodel, which
  // translates several metres a second while the player walks. Subtracting the
  // instance origin makes the field object-stationary; for static level geometry
  // the origin is one constant per mesh, so this is a pure phase offset and the
  // field stays continuous across every triangle of a merged building. The
  // triplanar path keeps raw world coordinates instead, because terrain chunks
  // each carry their own origin and subtracting it would put a phase step along
  // every chunk seam.
  vec3 ironPlaneT, ironPlaneB;
  vec2 ironOriginPlane;
  if ( ironAbsN.y > max( ironAbsN.x, ironAbsN.z ) ) {
    ironPlaneT = vec3( 1.0, 0.0, 0.0 );
    ironPlaneB = vec3( 0.0, 0.0, 1.0 );
    ironOriginPlane = vIronOrigin.xz;
  } else if ( ironAbsN.x > ironAbsN.z ) {
    ironPlaneT = vec3( 0.0, 0.0, 1.0 );
    ironPlaneB = vec3( 0.0, 1.0, 0.0 );
    ironOriginPlane = vIronOrigin.zy;
  } else {
    ironPlaneT = vec3( 1.0, 0.0, 0.0 );
    ironPlaneB = vec3( 0.0, 1.0, 0.0 );
    ironOriginPlane = vIronOrigin.xy;
  }
  // The two plane axes are by construction the normal's two SMALLER components,
  // so neither is ever near-parallel to it and this Gram-Schmidt is
  // unconditionally stable. Analytic, so it costs no screen-space derivatives —
  // which also takes four dFdx/dFdy off the triplanar path, where the frame used
  // to come from a uv that projection does not even use.
  ironPlaneT = normalize( ironPlaneT - ironGeoN * dot( ironGeoN, ironPlaneT ) );
  ironPlaneB = normalize( cross( ironGeoN, ironPlaneT ) );

  #ifdef IRON_TRIPLANAR
    vec2 ironDetUv = ironPlane;
  #else
    mat3 ironTbn = ironTangentFrame( ironGeoN, vIronWorld, vIronUv );
    vec2 ironDetUv = ironPlane - ironOriginPlane;
    #ifdef IRON_ANISO
      // Machined and turned metal carries its scratch band ALONG the direction
      // of use, never isotropically (LOOK_SPEC §4.2), and the only thing that
      // knows which direction that is on a receiver or a barrel is the uv layout
      // the weapon was authored with. So the anisotropic class stays in uv
      // space, stretched 6:1 across the turn axis. It is also the one class with
      // no tiling uvs to stretch, so it has nothing to gain from world space.
      //
      // The frame is rebuilt from the STRETCHED uv on purpose. ironTangentFrame
      // normalises t and b by the longer of the two, so a 6:1 uv stretch leaves
      // t six times the length of b — and that length ratio is what turns the
      // isotropic grain into a slope field that is steep across the scratch and
      // shallow along it. Handing this branch the unstretched frame would keep
      // the stretched PATTERN but throw away the directional relief, which is
      // the half of the effect that survives at ADS distance.
      ironDetUv = vIronUv * vec2( 0.17, 1.0 );
      mat3 ironTbnA = ironTangentFrame( ironGeoN, vIronWorld, ironDetUv );
      ironPlaneT = ironTbnA[ 0 ];
      ironPlaneB = ironTbnA[ 1 ];
    #endif
  #endif

  // One grain octave per band, from an analytic noise gradient. No texture fetch
  // and — the point — no structure: the band carries pitting, not a shrunken
  // copy of the material's own masonry. One octave rather than two because the
  // micro band already sits a further 6× up and covers what a second octave here
  // would have, at half the hashes.
  vec2 ironSlope = vec2( 0.0 );
  if ( ironDetailFade > 0.002 ) {
    ironSlope += ironNoiseD2( ironDetUv * ironDetailFreq ).yz
      * uIronDetail.x * ironDetailFade * ironNStr;
  }
  if ( ironMicroFade > 0.002 ) {
    vec3 gm = ironNoiseD2( ironDetUv * ironDetailFreq * uIronTiling.z + vec2( 0.37, 0.11 ) );
    ironSlope += gm.yz * uIronDetail.y * ironMicroFade * ironNStr;
  }
  vec3 ironGrainVec = ironPlaneT * ironSlope.x + ironPlaneB * ironSlope.y;

  vec3 ironNormalW;
  #ifdef IRON_TRIPLANAR
    ironNormalW = ironTriNormal( uIronNormalRoughAo, ironTriP, ironTriW, ironGeoN, ironNStr );
    ironNormalW = normalize( ironNormalW + ironGrainVec );
  #else
    // 0.46, not 1.0, and down from 0.7 after seeing it at 79° incidence.
    //
    // The bake authors its normal strength (3.2 for sandstone) against a flat
    // review chart lit head-on. On a real facade at an 11° sun the light is
    // within 11° of the surface PLANE, so any slope past that angle flips N·L
    // through zero: the wall stops being shaded and becomes a two-tone mask of
    // blown highlight and black self-shadow. Summed with the two grain bands the
    // old numbers reached ~1.6 of slope — 58° of tilt — and a sandstone arcade
    // rendered as white speckle. This is the one place the bake's own number is
    // deliberately not believed.
    //
    // FOOTPRINT GUARD, the same one the grain bands get. The bake's finest
    // octave is ~4 cm; on a facade seen at 79° incidence the pixel footprint
    // ALONG the surface is five times its footprint across, and an isotropic mip
    // chain cannot represent that — so what arrives is a sub-pixel normal
    // DISTRIBUTION being drawn as though it were shape. At a raking sun every
    // one of those normals lands on one side or the other of the terminator and
    // the result is speckle, not stone. Past the guard the relief is handed to
    // roughness, which is what a filtered normal distribution physically is;
    // 0.30 rather than 0 keeps the silhouette-scale relief that stops a distant
    // wall going to paper.
    //
    // The BAKED band stays in the uv frame it was authored in — it carries the
    // material's structure (course joints, plank edges, panel lines) and those
    // have to stay registered with the albedo they came from. Only the two
    // procedural grain bands moved to the world frame, and they are added as a
    // world vector rather than through this matrix for exactly that reason.
    float ironBaseSharp = 1.0 - smoothstep( 0.020, 0.075, ironFootprint );
    vec2 ironBaseSlope = ( ironTexN.rg * 2.0 - 1.0 ) * ironNStr * 0.46
      * mix( 0.30, 1.0, ironBaseSharp );
    ironRoughness = clamp( ironRoughness + 0.15 * ( 1.0 - ironBaseSharp ), 0.045, 1.0 );
    ironNormalW = normalize( ironTbn * vec3( ironBaseSlope, 1.0 ) + ironGrainVec );
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
 *
 * THE MESOSTRUCTURE HORIZON BOUND, and why this block is the single most
 * important twelve lines in the material.
 * ------------------------------------------------------------------------
 * A normal map is a slope field with NO horizon: every bump is told it can see
 * the whole sky and the whole sun, whatever its neighbours are doing. That is a
 * harmless lie at midday and a catastrophic one at HARBOUR REACH's 11° sun,
 * because the light then sits within 11° of most surface PLANES. At that
 * incidence a slope of 0.4 — an ordinary mortar chamfer — swings N·L from 0.19
 * to 0.9 on one side of the bump and to −0.3 on the other. The frame that comes
 * out is not stone: it is a two-tone mask of blown-white speckle and holes with
 * no direct light at all, and it was the visible defect on every column, every
 * voussoir and every crate in the round-1 captures. Turning the amplitude down
 * far enough to hide it turns the material off.
 *
 * The physics the map is missing is SHADOWING AND MASKING. A bump that tilts
 * into a grazing sun is standing in the shadow of the bump in front of it, so
 * the lit fraction of the mesostructure collapses as the light approaches the
 * plane, and the pixel average must converge on what the flat surface receives —
 * that convergence is exactly the energy conservation a bare slope field breaks.
 *
 * So: bound how far the perturbed normal may move N·L away from the geometric
 * N·L, with a bound that shrinks as the key light grazes. Symmetric, because
 * both tails are the same error. At a sunlit wall (N·L 0.9) the bound is 0.55
 * and nothing is touched — the relief is free to do its work. At 79° incidence
 * (N·L 0.19) it is 0.20, so the mesostructure modulates between roughly nothing
 * and twice the flat response instead of between black and blown. On a face
 * turned away from the sun the bound is 0.10 and no amount of slope can light
 * it, which kills the "lit facets on a shadowed wall" artefact for free.
 *
 * Bounded on the KEY light only. It is the one with the dynamic range to break
 * anything, and evaluating this per clustered light would be a second dot
 * product and a normalize inside the light loop for a term whose whole purpose
 * is to fix a 100:1 contrast the fill lights cannot produce.
 */
export const IRON_NORMAL_APPLY = /* glsl */ `
  {
    vec3 ironVN = normalize( ( viewMatrix * vec4( ironNormalW, 0.0 ) ).xyz );
    #ifdef DOUBLE_SIDED
      ironVN *= faceDirection;
    #endif
    #if NUM_DIR_LIGHTS > 0
    {
      vec3 ironGVN = normalize( ( viewMatrix * vec4( ironGeoN, 0.0 ) ).xyz );
      #ifdef DOUBLE_SIDED
        ironGVN *= faceDirection;
      #endif
      // three transforms light directions into VIEW space, which is why the
      // geometric normal is taken there too rather than doing this in world.
      vec3 ironKeyL = directionalLights[ 0 ].direction;
      float ironNlG = dot( ironGVN, ironKeyL );
      float ironNlP = dot( ironVN, ironKeyL );
      float ironBound = 0.10 + 0.50 * max( ironNlG, 0.0 );
      float ironT = min( 1.0, ironBound / max( abs( ironNlP - ironNlG ), 1e-4 ) );
      ironVN = normalize( mix( ironGVN, ironVN, ironT ) );
    }
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

    #ifndef USE_ENVMAP
      // Three's own split-sum term, off the same DFG LUT the IBL path uses, so
      // the fallback lobe and the real IBL lobe agree exactly in shape and only
      // differ in where the radiance came from.
      vec3 ironFssEss = EnvironmentBRDF( geometryNormal, geometryViewDir,
        material.specularColor, material.specularF90, material.roughness );
      reflectedLight.indirectSpecular += ironAmbientRadiance * ironFssEss
        * computeSpecularOcclusion( ironDotNV, ironAoFinal, material.roughness );
    #endif

    // THE GRAZING TAIL, and why it has to be added by hand.
    //
    // LOOK_SPEC §4.2 opens with "nothing is at roughness 1.0 with a flat normal;
    // every matte surface still shows a broad grazing sheen along its top edge",
    // and the rubric's material axis fails a frame outright if a large flat
    // surface does not brighten toward the horizon. Three's DFGApprox cannot
    // deliver that above roughness ~0.8: its F90 lobe is multiplied by a masking
    // term that has already collapsed, so at roughness 0.95 the split-sum
    // returns 0.0174 at 84° incidence and 0.0174 head-on — a flat line. The
    // Fresnel is not missing, it is being masked to death, and dry stone,
    // concrete and sand are all authored above that threshold.
    //
    // That masking is right for a true microfacet slope distribution and wrong
    // for a real mineral surface, whose top few microns are a smooth air/solid
    // interface: the roughness lives in the SUB-surface scattering and in relief
    // below it, and the specular reflection off that interface survives at
    // grazing regardless. It is why a dusty kerb still has a bright top edge
    // against the sky and why wet-looking sheen appears on dry sand toward the
    // horizon. Restored as a Schlick tail, weighted UP with roughness so it only
    // supplies what DFGApprox threw away, and taken on the GEOMETRIC normal so it
    // is a smooth ramp across a surface rather than a second speckle field.
    //
    // 0.16 is a ceiling on how much of the incident sky a silhouette-grazing
    // pixel may return this way; the equivalent diffuse is removed so the term
    // redistributes energy instead of inventing it.
    float ironDotNVG = saturate( dot( ironGeoN, ironViewDirW ) );
    float ironGrazeF = pow( 1.0 - ironDotNVG, 5.0 );
    float ironGrazeW = 0.16 * smoothstep( 0.55, 0.95, material.roughness ) * ironGrazeF;
    reflectedLight.indirectSpecular += ironAmbientRadiance * ironGrazeW * ironAoFinal;
    reflectedLight.indirectDiffuse *= 1.0 - ironGrazeW;
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
