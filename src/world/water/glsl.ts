/**
 * The water shaders.
 *
 * OWNER: WATER.
 *
 * WHY THIS IS A `createUnlit` SHADER AND NOT A `registerSurface` CHUNK — the one
 * architectural deviation in this lane, stated up front so a reviewer does not
 * have to find it.
 *
 * `MaterialFactory.registerSurface` is the sanctioned route and it is the right
 * one for a surface that wants the uber material's albedo/normal/roughness
 * resolve and then wants to be lit like everything else. Water wants almost none
 * of that: it has no albedo texture, no wear stack, no detail normal from a
 * sampler, and its diffuse term is not a diffuse term but a Beer-Lambert
 * integral through a participating medium down to a seabed. What it needs from
 * the shared pipeline is aerial perspective, and §3.2 is a closed-form
 * specification that this file implements directly, in the same units, from the
 * same sun.
 *
 * What that deviation genuinely costs: no cascaded-shadow lookup (nothing casts
 * onto open water at 11° except the freighter, and the freighter's own shadow on
 * the sea is behind it, out of frame in all three registered shots), and no
 * clustered local lights (a muzzle flash does not light the sea from 40 m).
 * What it buys: the water renders correctly the day it is written rather than
 * the day the uber material lands, and the glitter path is driven by a real
 * microfacet distribution with a real sun solid angle instead of a roughness
 * slider.
 *
 * UNITS. Everything in here is photometric — cd/m² for radiance, lux for
 * illuminance, exactly as LOOK_SPEC §2.1 requires. The single conversion to
 * whatever the frame's working space happens to be is `uWaterRadianceScale`,
 * applied once at the very end. See `system.ts` for how that is derived rather
 * than dialled.
 */
import {
  DISPLACING_COUNT,
  VARIANCE_LUT_MAX,
  VARIANCE_LUT_MIN,
  WAVE_COUNT,
} from '@/world/water/spectrum';
import { FAR_FIELD_GLSL } from '@/world/water/seabed';

export interface WaterShaderConfig {
  /** Write `GVelocity` from a second attachment. */
  readonly mrt: boolean;
  /** `SceneColorCopy` + `SceneDepth` are readable: real refraction and SSR. */
  readonly refraction: boolean;
  /** LIGHT's `SsrColor` is readable: use it in preference to our own march. */
  readonly ssrTexture: boolean;
  /** No downstream pass will tonemap what we write, so we must. */
  readonly selfTonemap: boolean;
  readonly maxRings: number;
}

/** Uniform declarations shared by both stages. */
function commonUniforms(cfg: WaterShaderConfig): string {
  return /* glsl */ `
    uniform vec4 uWaterWaveA[${WAVE_COUNT}];
    uniform vec4 uWaterWaveB[${WAVE_COUNT}];
    uniform vec4 uWaterRings[${cfg.maxRings}];
    uniform int uWaterRingCount;
    uniform float uWaterTime;
    uniform float uWaterPrevTime;
    /** (significant wave height m, wind dir X, wind dir Z, wind speed m/s). */
    uniform vec4 uWaterSeaState;
    uniform float uWaterSeaLevel;
    uniform vec3 uWaterOrigin;
    uniform sampler2D uWaterSeabed;
    uniform vec2 uWaterFieldOrigin;
    uniform vec2 uWaterFieldSize;
    uniform vec2 uWaterFieldInvSize;
  `;
}

/**
 * The Gerstner sum, in the form both stages need.
 *
 * `IRON_WATER_SHOAL` is the whole shoreline behaviour in two lines: amplitude
 * grows as the wave feels the bottom (Green's law, roughly d^-1/4 — a swell that
 * is 0.4 m high in 20 m of water is 0.7 m high in 2 m of water) and then
 * collapses to nothing over the last half metre, because a wave that does not
 * damp on the beach pokes through the sand and the shoreline turns into a row of
 * triangles. Steepness rides the same gain, which is what peaks the crests and
 * flattens the troughs as the surf approaches — the visual signature of shoaling.
 */
const WAVE_GLSL = /* glsl */ `
float ironWaterShoal(float depth) {
  return smoothstep(0.0, 0.55, depth) * (1.0 + 0.9 * (1.0 - smoothstep(1.0, 12.0, depth)));
}

/**
 * Long-period run-up. The swash is not a wave, it is the shoreline breathing:
 * the sheet of water on the sand rises and falls with the swell period, and it
 * is what makes a waterline read as alive rather than as a contour line.
 */
float ironWaterSwash(vec2 p, float t) {
  float k = uWaterWaveA[0].z;
  float w = uWaterWaveA[0].w;
  vec2 d = uWaterWaveA[0].xy;
  float f = k * dot(d, p) * 0.35 - w * t + uWaterWaveB[0].z;
  // Skewed: water runs up fast and drains slowly, like real swash.
  float s = sin(f);
  return 0.34 * (s + 0.35 * s * abs(s));
}

vec3 ironWaterRings(vec2 p, float t) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < uWaterRingCount; i++) {
    vec4 ring = uWaterRings[i];
    float age = t - ring.z;
    if (age <= 0.0 || age > 3.6) continue;
    vec2 delta = p - ring.xy;
    float r = length(delta) + 1e-4;
    // Ring speed 2.6 m/s, front 0.9 m wide, energy decaying as 1/(r+1) for the
    // geometric spread plus an exponential for viscosity.
    float front = age * 2.6;
    float u = (r - front) / 0.9;
    // x*x, never pow(x, 2.0): the base goes negative behind the ring front and
    // pow() of a negative base is undefined.
    float band = exp(-u * u);
    float amp = ring.w * band * exp(-age * 1.15) / (1.0 + r * 0.35);
    float phase = (r - front) * 3.4;
    acc.x += amp * sin(phase);
    // d/dr of the above, kept to the dominant term: the ring's slope is what
    // catches the sun, and a ring with no normal is invisible.
    float slope = amp * cos(phase) * 3.4;
    acc.yz += slope * delta / r;
  }
  return acc;
}

/**
 * Full displacement + analytic derivatives.
 *
 * outNormal comes from the exact tangent frame of the displaced surface, not
 * from a finite difference: dP/dx and dP/dz fall out of the same sines the
 * position sum already computed, so an exact normal costs three multiplies per
 * wave and there is no reason ever to approximate it.
 *
 * outJacobian is det(∂P.xz/∂p) — below 1 the surface is compressing, and where
 * it approaches 0 the water is folding over on itself. That is where whitecaps
 * are, and it is the only physically honest source of them.
 */
vec3 ironWaterDisplace(vec2 base, float t, float shoal, out vec3 outNormal, out float outJacobian) {
  vec3 disp = vec3(0.0);
  float jxx = 0.0, jxz = 0.0, jzx = 0.0, jzz = 0.0;
  float nx = 0.0, nz = 0.0;
  for (int i = 0; i < ${DISPLACING_COUNT}; i++) {
    vec4 wa = uWaterWaveA[i];
    vec4 wb = uWaterWaveB[i];
    float amp = wb.x * shoal;
    // THE STEEPNESS BUDGET IS NOT ALLOWED TO SHOAL FREELY. The spectrum is built
    // so that sum(Q*A*k) = 0.78, just under the 1.0 at which a Gerstner surface
    // folds through itself; multiplying it by a shoaling gain of 1.9 puts it at
    // 1.5 and every square metre of the harbour self-intersects into flat lenses
    // that then read as foam. Crests DO steepen as they feel the bottom, so the
    // gain is capped rather than removed: 1.15 takes the budget to 0.90.
    float qa = wb.y * min(shoal, 1.15);
    float f = wa.z * dot(wa.xy, base) - wa.w * t + wb.z;
    float s = sin(f);
    float c = cos(f);
    disp.xz += qa * wa.xy * c;
    disp.y += amp * s;
    float qk = qa * wa.z * s;
    jxx -= qk * wa.x * wa.x;
    jxz -= qk * wa.x * wa.y;
    jzx -= qk * wa.y * wa.x;
    jzz -= qk * wa.y * wa.y;
    nx += amp * wa.z * wa.x * c;
    nz += amp * wa.z * wa.y * c;
  }
  vec3 ring = ironWaterRings(base, t);
  disp.y += ring.x;
  nx += ring.y;
  nz += ring.z;

  vec3 dPdx = vec3(1.0 + jxx, nx, jxz);
  vec3 dPdz = vec3(jzx, nz, 1.0 + jzz);
  outNormal = normalize(cross(dPdz, dPdx));
  outJacobian = (1.0 + jxx) * (1.0 + jzz) - jxz * jzx;
  return disp;
}

/**
 * THE SHADING NORMAL, AND WHY IT IS NOT THE INTERPOLATED VERTEX NORMAL.
 *
 * It used to be. The ocean grid's triangles are ~7.5 % of their own radius
 * across, so at 60 m they are 4.5 m wide — half a wavelength of the chop band.
 * A normal interpolated across half a wavelength is not a smoothed normal, it is
 * a FACETED one, and at grazing incidence into the sun a facet either mirrors an
 * 18 000 cd/m² sky or turns far enough toward the eye to show the 200 cd/m² body
 * colour, with nothing in between. Whole triangles flip together, the grade's
 * S-curve pulls a 16:1 radiance ratio out to 60:1 on the display, and the result
 * is a black wedge with straight edges sitting in the glitter path. That is the
 * defect; this function is the fix.
 *
 * Evaluated here the normal has the PIXEL's resolution instead of the MESH's —
 * the same split as a normal map over a low-poly cage — and every band the pixel
 * cannot resolve is faded out and handed to the roughness term by
 * ironWaterVariance(), which is the only way one wave field can be both detailed
 * at 5 m and stable at 2 km.
 *
 * The band limit is 2.5–7 footprints per wavelength, not Nyquist's 2. Nyquist is
 * the limit for reconstructing the SIGNAL; the shading is a fifth-power Fresnel
 * and a 1/α² specular lobe applied to that signal, and those need several
 * samples per period before they stop aliasing into salt-and-pepper.
 *
 * THE BAND LIMIT IS ANISOTROPIC, AND THAT IS THE WHOLE OF "THE DISTANCE GOES
 * FLAT". A pixel on the sea at 300 m from a 6 m eye is not a disc: it is a
 * SLIVER, ~8 cm across and ~4 m long, because the surface is seen at under two
 * degrees. An isotropic cutoff has to take the long axis — otherwise the waves
 * running across the sightline alias — and so it throws away every band under
 * four metres, in EVERY direction, including the direction in which the pixel
 * still resolves eight centimetres. That is a factor of fifty of real, resolvable
 * wave detail discarded per pixel, and it is discarded on exactly the pixels this
 * shot is composed around. What it leaves is the swell alone: a smooth satin
 * sheet with a smeared white river down the middle of it.
 *
 * The honest measure is the PHASE GRADIENT. A wave's contribution to this pixel
 * is cos(k·d·p), so what decides whether the pixel can carry it is how much that
 * phase moves across the pixel — g = |grad_screen (k d·p)| — which for a wave
 * running along the sliver's short axis stays small out to the horizon. Passing
 * the two world-space footprint VECTORS (the screen derivatives of the surface
 * point) instead of one scalar costs two dot products per wave and restores the
 * cross-sightline bands: the streaky, glittering, long-in-x/short-in-y structure
 * that real water has at grazing range and that no isotropic filter can produce.
 *
 * Whatever the pixel still cannot carry is handed to outResidualMss — the
 * exact mean-square slope of the amplitude this loop faded out, and it is a
 * vec2 (world X, world Z) rather than a scalar for the same reason the filter
 * is two vectors. An anisotropic filter leaves an ANISOTROPIC residual: at
 * 300 m down this sightline the bands running across the view are resolved and
 * the bands running along it are not, so the slope the pixel has to hand to the
 * roughness lives almost entirely in one direction. Averaging that into one
 * number is what makes a distant glitter path a continuous white spill instead
 * of a field of streaks — a lobe widened in the direction the surface is
 * genuinely rough and left narrow in the direction it is genuinely smooth is
 * exactly why real sun glitter is made of radial DASHES.
 */
vec3 ironWaterShadeNormal(vec2 base, float t, float shoal, vec2 fpX, vec2 fpY, float rippleGain,
                          out float outJacobian, out vec2 outResidualMss) {
  float jxx = 0.0, jxz = 0.0, jzx = 0.0, jzz = 0.0;
  float nx = 0.0, nz = 0.0;
  vec2 residual = vec2(0.0);
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec4 wa = uWaterWaveA[i];
    vec4 wb = uWaterWaveB[i];
    // Radians of this wave's phase per pixel, along each screen axis, and then
    // the pixel's own reconstruction filter applied to that.
    //
    // A GAUSSIAN, NOT A BAND EDGE, and the difference is visible from across
    // the room. A smoothstep window is what a band limit looks like when you
    // write it as a threshold, and it leaves a POPULATION OF WAVES SITTING AT
    // FULL AMPLITUDE right at the cutoff. Those are the shortest waves the
    // pixel carries, so they are the ones whose crests are a few pixels apart —
    // and because the ripple band is nearly isotropic there is always a
    // symmetric pair of them either side of the sightline. Two short waves at
    // full amplitude crossing at a shallow angle multiply into a regular
    // diamond lattice a few pixels on a side, and that lattice, printed across
    // the 200-400 m band, is a cross-hatched mesh lying on the sea. It reads as
    // a compression artefact.
    //
    // Averaging cos(k·d·p) over the pixel's reconstruction filter is the honest
    // answer and it has no edge to pile up against: for a Gaussian footprint it
    // is exp(-sigma^2 g^2 / 2), a monotone roll-off that is already down a
    // third at half a radian per pixel and is gone well before Nyquist. Nothing
    // is ever resolved AND about to disappear, so nothing beats. 0.8 is
    // sigma^2/2 for a ~1.3 px filter — measured, against 1.1 (visibly cleaner
    // than the threshold but a tenth of the sea's local contrast poorer) and
    // against the threshold itself (block sigma 22.9 vs 22.2 in the near field,
    // and the lattice).
    float gx = wa.z * dot(wa.xy, fpX);
    float gy = wa.z * dot(wa.xy, fpY);
    float visible = exp(-0.8 * (gx * gx + gy * gy));
    // The ripple band does not displace (wb.y is zero for it), so the same loop
    // covers both bands: its Jacobian terms vanish and it contributes slope only.
    // Its shoaling gain is capped harder than the swell's because a 0.7 m ripple
    // amplified 1.9x in the last half metre of swash is a slope, not a wave.
    // rippleGain is the surfactant slick, and it applies to the RIPPLE band
    // alone: a Langmuir streak damps capillaries, it does not flatten a 90 m
    // swell. Applying it to the whole spectrum would make the slicks read as
    // holes in the sea rather than as smooth water.
    float ampFull = wb.x * (i < ${DISPLACING_COUNT} ? shoal : min(shoal, 1.35) * rippleGain);
    // sigma^2 of a single sinusoid's slope is (A k)^2 / 2, and the share of it
    // this pixel could not resolve is carried by the amplitude that was faded.
    vec2 cut = ampFull * (1.0 - visible) * wa.z * wa.xy;
    residual += 0.5 * cut * cut;
    if (visible <= 0.002) continue;
    float amp = ampFull * visible;
    float qa = wb.y * min(shoal, 1.15) * visible;
    float f = wa.z * dot(wa.xy, base) - wa.w * t + wb.z;
    float s = sin(f);
    float c = cos(f);
    float qk = qa * wa.z * s;
    jxx -= qk * wa.x * wa.x;
    jxz -= qk * wa.x * wa.y;
    jzx -= qk * wa.y * wa.x;
    jzz -= qk * wa.y * wa.y;
    nx += amp * wa.z * wa.x * c;
    nz += amp * wa.z * wa.y * c;
  }
  outResidualMss = residual;
  vec3 ring = ironWaterRings(base, t);
  nx += ring.y;
  nz += ring.z;

  vec3 dPdx = vec3(1.0 + jxx, nx, jxz);
  vec3 dPdz = vec3(jzx, nz, 1.0 + jzz);
  outJacobian = (1.0 + jxx) * (1.0 + jzz) - jxz * jzx;
  return normalize(cross(dPdz, dPdx));
}

/** Position only — for the previous frame, where nothing needs a normal. */
vec3 ironWaterDisplacePos(vec2 base, float t, float shoal) {
  vec3 disp = vec3(0.0);
  for (int i = 0; i < ${DISPLACING_COUNT}; i++) {
    vec4 wa = uWaterWaveA[i];
    vec4 wb = uWaterWaveB[i];
    float f = wa.z * dot(wa.xy, base) - wa.w * t + wb.z;
    disp.xz += wb.y * min(shoal, 1.15) * wa.xy * cos(f);
    disp.y += wb.x * shoal * sin(f);
  }
  disp.y += ironWaterRings(base, t).x;
  return disp;
}
`;

export function waterVertexShader(cfg: WaterShaderConfig): string {
  return /* glsl */ `
    ${commonUniforms(cfg)}

    out vec3 vWorldPos;
    out vec3 vPrevWorldPos;
    out vec2 vBaseXZ;
    out float vRingRadius;
    out float vStillDepth;

    ${FAR_FIELD_GLSL}
    ${WAVE_GLSL}

    void main() {
      // position.xz is the local radial offset; uv.x carries the ring radius,
      // which the fragment stage needs for its own filter footprint.
      vec2 base = position.xz + uWaterOrigin.xz;
      vRingRadius = uv.x;

      vec2 bed = ironWaterSeabed(base);
      float still = uWaterSeaLevel - bed.x;
      float swash = ironWaterSwash(base, uWaterTime) * (1.0 - smoothstep(0.0, 7.0, still));
      float shoal = ironWaterShoal(still);

      // The normal and the Jacobian this returns are DELIBERATELY DISCARDED: both
      // are now evaluated per fragment at the pixel's own band limit rather than
      // at the mesh's. What the vertex stage still owns is the position, because
      // that is the one thing a fragment cannot fix after the fact.
      vec3 vertexNormal;
      float vertexJac;
      vec3 disp = ironWaterDisplace(base, uWaterTime, shoal, vertexNormal, vertexJac);
      vec3 world = vec3(base.x + disp.x, uWaterSeaLevel + disp.y + swash, base.y + disp.z);

      // The PREVIOUS position of the same water column, not of the same vertex:
      // the grid slides under the camera every frame, and a velocity that
      // included that slide would tell TAA the whole ocean is translating at the
      // player's walking speed. What moves is the fluid, so the horizontal
      // sample point is held and only the clock is rewound.
      float prevSwash = ironWaterSwash(base, uWaterPrevTime) * (1.0 - smoothstep(0.0, 7.0, still));
      vec3 prevDisp = ironWaterDisplacePos(base, uWaterPrevTime, shoal);
      vPrevWorldPos = vec3(base.x + prevDisp.x, uWaterSeaLevel + prevDisp.y + prevSwash, base.y + prevDisp.z);

      vWorldPos = world;
      vBaseXZ = base;
      vStillDepth = still;

      gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    }
  `;
}

export function waterFragmentShader(cfg: WaterShaderConfig): string {
  return /* glsl */ `
    precision highp float;
    precision highp int;

    ${commonUniforms(cfg)}

    uniform vec3 uWaterSunDir;
    /** Illuminance on a sun-normal surface, lux, times the max-normalised tint. */
    uniform vec3 uWaterSunIlluminance;
    /** Horizontal sky illuminance, lux. */
    uniform float uWaterSkyIlluminance;
    uniform float uWaterRadianceScale;
    uniform vec2 uWaterVarianceLutA;
    uniform vec2 uWaterVarianceLutB;
    uniform vec4 uWaterVarianceLutC;
    /** Radians subtended by one pixel at the frame centre. */
    uniform float uWaterPixelAngle;
    uniform sampler2D uWaterSandAlbedo;
    uniform float uWaterSandTiling;
    uniform sampler2D uWaterShoreMask;
    uniform vec4 uWaterShoreRect;
    uniform vec2 uWaterShoreDecode;
    uniform mat4 uWaterViewProjection;
    uniform mat4 uWaterPrevViewProjection;
    uniform vec2 uWaterResolution;
    #if defined(IRON_WATER_REFRACTION)
      uniform sampler2D uWaterSceneColor;
      uniform sampler2D uWaterSceneDepth;
      uniform vec2 uWaterDepthPlanes;
    #endif
    #if defined(IRON_WATER_SSR_TEXTURE)
      uniform sampler2D uWaterSsr;
    #endif

    in vec3 vWorldPos;
    in vec3 vPrevWorldPos;
    in vec2 vBaseXZ;
    in float vRingRadius;
    in float vStillDepth;

    #if defined(IRON_WATER_MRT)
      layout(location = 0) out vec4 outColor;
      layout(location = 1) out vec4 outVelocity;
    #else
      out vec4 outColor;
    #endif

    const float IRON_PI = 3.14159265359;

    #if defined(IRON_WATER_SELF_TONEMAP)
      /**
       * AgX, for the one case nobody else covers: the render graph is not
       * complete enough to own the tonemap AND the renderer has already handed
       * tonemapping over to it. In that window a photometric surface writes
       * thousands of cd/m² straight at an 8-bit framebuffer and the sea comes out
       * pure white. This is the same contrast curve three uses, so the moment
       * either owner takes over the sea does not change appearance.
       */
      vec3 ironWaterAgx(vec3 c) {
        vec3 v = clamp((log2(max(c, vec3(1e-10))) + 12.47393) / 16.5, 0.0, 1.0);
        vec3 v2 = v * v;
        vec3 v4 = v2 * v2;
        vec3 r = 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v
               + 0.4298 * v2 + 0.1191 * v - 0.00232;
        return pow(max(r, vec3(0.0)), vec3(2.2));
      }
    #endif

    ${FAR_FIELD_GLSL}
    ${WAVE_GLSL}

    /* ------------------------------------------------------------------ sky */

    /**
     * The sky dome as radiance in cd/m², from LOOK_SPEC §2.4's measured table.
     *
     * The DISC IS NOT IN HERE. It is handled as a microfacet light below with a
     * real solid angle, and adding it twice would put a second sun in the
     * reflection with the wrong shape.
     *
     * Hue is held constant with elevation and only value and saturation move —
     * the one property §3.1 says a gradient sky always gets wrong.
     */
    vec3 ironWaterSkyRadiance(vec3 dir, float alpha) {
      float up = clamp(dir.y, -1.0, 1.0);
      vec2 flatDir = normalize(vec2(dir.x, dir.z) + vec2(1e-5));
      vec2 flatSun = normalize(vec2(uWaterSunDir.x, uWaterSunDir.z) + vec2(1e-5));
      float azAlign = dot(flatDir, flatSun);
      float cosSun = dot(dir, uWaterSunDir);

      // Horizon weight. 2.6 gives the measured "horizon is ~2x the sky 30 deg up".
      float h = pow(1.0 - clamp(abs(up), 0.0, 1.0), 2.6);
      float lum = mix(2200.0, 3300.0, h);
      // Mie forward scattering. THE SUN-SIDE HORIZON AND THE AUREOLE BELOW ARE
      // ONE MEASUREMENT, NOT TWO, and adding them as two was worth a full stop
      // over the whole sightline this shot is aimed down. LOOK_SPEC §2.4 puts
      // the horizon within 20° of the sun AZIMUTH at 9000 cd/m² — and the sun is
      // 10° up, so a horizon point on the sun's bearing is ~10° from the disc,
      // which is inside the aureole's own half-value radius. That 9000 already
      // contains the aureole. The three terms are therefore budgeted to sum to
      // it: 3300 base + 2000 azimuthal + 3400 aureole + 500 broad lobe = 9200 at
      // the sun-side horizon, 3300 at 90° off (§2.4 measures 3400), 3300
      // anti-sun (measures 3200), 2200 at the zenith (measures 2200).
      //
      // This matters more for water than for anything else in the frame: a sea
      // at grazing incidence reflects almost nothing BUT the region around the
      // sun, so an error here is an error in the brightness of half the frame,
      // and it lands on the exact pixels a backlit water shot is composed
      // around.
      float azWarm = pow(max(azAlign, 0.0), 3.0);
      lum += h * azWarm * 2000.0;
      // The solar aureole. Exponent 16 puts the half-value radius at ~20°, which
      // is what a turbidity-3.2 atmosphere actually produces; at exponent 7 the
      // lobe is 40° wide, and since a grazing sea reflects nothing BUT the region
      // around the sun, that error alone lifted the whole frame by a stop.
      //
      // CONVOLVED WITH THE SURFACE LOBE, and that is not a nicety. A rough facet
      // does not sample the sky at one direction, it integrates it over its own
      // lobe — and the aureole is the steepest thing in the sky, so point-sampling
      // it through a reflection vector that swings degrees per pixel aliases it
      // into salt and pepper. A cos^n lobe convolved with GGX(alpha) is very
      // nearly cos^m with 1/m = 1/n + alpha^2/2, and the amplitude follows the
      // solid-angle ratio (n+1)/(m+1) so no energy is created or lost by the
      // widening.
      float aurN = 1.0 / (1.0 / 16.0 + alpha * alpha * 0.5);
      lum += pow(max(cosSun, 0.0), aurN) * 3400.0 * ((aurN + 1.0) / 17.0);
      lum += pow(max(cosSun, 0.0), 1.6) * 500.0;

      vec3 warm = vec3(1.00, 0.94, 0.87);
      vec3 neutral = vec3(0.92, 0.90, 0.90);
      vec3 cool = vec3(0.80, 0.86, 0.98);
      vec3 horizonChroma = mix(mix(cool, neutral, smoothstep(-0.55, 0.25, azAlign)),
                               warm, smoothstep(0.25, 0.96, azAlign));
      vec3 chroma = mix(vec3(0.78, 0.82, 0.95), horizonChroma, h);
      // Below the horizon the reflected ray is looking into the haze slab, which
      // is the horizon value with the saturation knocked out of it.
      float below = smoothstep(0.0, -0.06, up);
      lum = mix(lum, 3100.0, below);
      chroma = mix(chroma, mix(chroma, vec3(0.94, 0.93, 0.92), 0.6), below);
      return chroma * lum;
    }

    /* ------------------------------------------------- aerial perspective */

    /**
     * LOOK_SPEC §3.2, implemented as surface*exp(-sigma d) + inscatter*(1-exp)
     * and never as a lerp toward a fog colour. The height-layered marine slab is
     * integrated analytically along the ray, which matters here more than
     * anywhere else in the frame: the sea is the one surface that is at y = 0
     * for eight kilometres, so it sits in the thickest part of the slab the whole
     * way out and its haze ladder is the depth cue for the entire map.
     */
    vec3 ironWaterAerial(vec3 color, vec3 world, vec3 eye) {
      vec3 delta = world - eye;
      float dist = length(delta);
      if (dist < 0.01) return color;
      vec3 dir = delta / dist;

      const float H = 22.0;
      float y0 = max(eye.y, 0.0);
      float y1 = max(world.y, 0.0);
      float dy = y1 - y0;
      float marine;
      if (abs(dy) < 1e-3) {
        marine = exp(-y0 / H) * dist;
      } else {
        marine = dist * H / dy * (exp(-y0 / H) - exp(-y1 / H));
      }
      // ~lambda^-1.5, Mie-dominated. Blue extinguishes FASTEST, which is what
      // keeps the distance warm instead of turning it into a grey wash.
      vec3 spectral = vec3(1.0, 1.25, 1.5);
      vec3 tau = spectral * (1.10e-3 * marine + 2.20e-4 * dist);
      vec3 trans = exp(-tau);

      // alpha = 0: the view ray is a delta direction, not a lobe.
      vec3 inscatter = ironWaterSkyRadiance(dir, 0.0);
      float cosSun = dot(dir, uWaterSunDir);
      // Forward scattering, but MEASURED rather than raw. A bare Henyey-Greenstein
      // at g = 0.72 peaks 22x above isotropic, and applying that to an in-scatter
      // term which is ALREADY the sky radiance (and therefore already contains the
      // forward-scattered light) double-counts it seven times over and turns the
      // whole sun side of the frame white. §3.2 measures the real number: haze in
      // the sun azimuth is 1.21x the sky away from it, so that is the number.
      inscatter *= 1.0 + 0.22 * pow(max(cosSun, 0.0), 5.0);
      // An explicit Rayleigh term so the anti-sun distance goes BLUER and more
      // saturated than the horizon sky it sits against (§3.2 property 3).
      inscatter += vec3(0.22, 0.42, 1.00) * 260.0 * (1.0 - max(cosSun, 0.0)) *
                   (1.0 - exp(-dist * 3.0e-4));
      return color * trans + inscatter * (1.0 - trans);
    }

    /* ---------------------------------------------------------- micro relief */

    /** Cumulative slope variance carried by everything below the cutoff. */
    float ironWaterVariance(float lambda) {
      float lut[8];
      lut[0] = uWaterVarianceLutA.x; lut[1] = uWaterVarianceLutA.y;
      lut[2] = uWaterVarianceLutB.x; lut[3] = uWaterVarianceLutB.y;
      lut[4] = uWaterVarianceLutC.x; lut[5] = uWaterVarianceLutC.y;
      lut[6] = uWaterVarianceLutC.z; lut[7] = uWaterVarianceLutC.w;
      // Log-spaced cutoffs, so the index is linear in log lambda. The two ends
      // come from VARIANCE_LUT_LAMBDA itself rather than being written out
      // again — they were duplicated once, the table moved, and every fragment
      // silently looked up the wrong band for a build.
      float t = clamp((log2(max(lambda, ${VARIANCE_LUT_MIN.toFixed(4)}) / ${VARIANCE_LUT_MIN.toFixed(4)}))
                      / log2(${VARIANCE_LUT_MAX.toFixed(2)} / ${VARIANCE_LUT_MIN.toFixed(4)}) * 7.0, 0.0, 7.0);
      int i = int(floor(t));
      int j = min(i + 1, 7);
      return mix(lut[i], lut[j], fract(t));
    }

    /**
     * The split-sum environment BRDF (the Lazarov/Karis analytic fit), and it is
     * the difference between a sea and a mirror.
     *
     * Water at 400 m from a 6 m eye is seen at 0.9°. Point-sampled Fresnel on the
     * mean normal returns 0.96 there, so the far sea renders as an exact copy of
     * the sky it reflects, the horizon line dissolves, and the whole distance
     * becomes one flat pale sheet — which is exactly the defect. The real surface
     * at that range is a slope DISTRIBUTION, not a plane: most of the facets a
     * pixel covers are turned away from the specular direction, and the masking
     * and shadowing between the facets that remain takes most of the rest. That
     * integral — ∫ F·D·G over the lobe, at the roughness the pixel could not
     * resolve — is what this fit evaluates in six instructions, and it lands the
     * far water at 0.4–0.6 of the sky rather than 1.0. That factor of two is the
     * value separation the horizon needs, and it is not a dialled contrast knob:
     * it falls out of the same slope variance that drives the roughness.
     *
     * F0 = 0.0201 (n = 1.333), baked in — this surface is only ever water.
     */
    float ironWaterEnvReflectance(float NdotV, float alpha) {
      float rough = sqrt(clamp(alpha, 0.0, 1.0));
      const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
      const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
      vec4 r = rough * c0 + c1;
      float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
      vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
      return clamp(0.0201 * ab.x + ab.y, 0.0, 1.0);
    }

    /**
     * Replace any non-finite component with a fallback.
     *
     * WHY THIS IS A FUNCTION AND WHY IT IS CALLED EARLY. min() and max() in
     * GLSL are defined as comparisons — min(x,y) is y<x?y:x — and every
     * comparison against NaN is false, so min(NaN, ceiling) and max(NaN, floor)
     * both return the NaN. A clamp does not sanitize; only a select does. And a
     * select placed at the END of the shader is downstream of the highlight
     * shoulder, which divides by the fragment's luminance: once that luminance
     * is a NaN the whole fragment is, and there is nothing left to recover.
     *
     * So each term is sanitized where it is BUILT, against a fallback that
     * shares none of its inputs.
     *
     * The range test is deliberate and is the same idiom as ironSanitize in
     * render/color.ts: x != x is the textbook NaN test and is also the one form
     * a backend compiling under fast-math is allowed to prove false and delete.
     * Two range comparisons survive that, and catch Inf in the same breath.
     */
    vec3 ironWaterFinite(vec3 v, vec3 fallback) {
      return vec3(v.x > -1.0e12 && v.x < 1.0e12 ? v.x : fallback.x,
                  v.y > -1.0e12 && v.y < 1.0e12 ? v.y : fallback.y,
                  v.z > -1.0e12 && v.z < 1.0e12 ? v.z : fallback.z);
    }

    /* ----------------------------------------------------------------- foam */

    float ironWaterHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    float ironWaterValueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(ironWaterHash(i), ironWaterHash(i + vec2(1, 0)), f.x),
                 mix(ironWaterHash(i + vec2(0, 1)), ironWaterHash(i + vec2(1, 1)), f.x), f.y);
    }

    /**
     * Three octaves drifting at different rates: foam is not a texture, it is a
     * pattern being pulled apart by the surface it sits on.
     *
     * BAND-LIMITED BY THE PIXEL, like everything else in this shader. The
     * octaves are 1.8 m, 0.54 m and 0.20 m; past ~60 m a pixel is wider than the
     * last of those and point-sampling it does not produce fine foam, it
     * produces a fixed pattern of stippled dashes that reads as a compression
     * artefact lying on the sea. Each octave is dropped once the pixel can no
     * longer resolve it and the survivors are RE-NORMALISED, so distant foam
     * keeps its coverage and its contrast and only loses its grain — which is
     * what actually happens when you look at a whitecap from 200 m.
     */
    float ironWaterFoamNoise(vec2 p, float t, float cutoff) {
      vec2 drift = uWaterWaveA[0].xy * t;
      // 0.55 -> 0.22 of a wavelength per pixel: the same 2.5-7 samples-per-period
      // window the wave bands use, for the same reason (a threshold on the noise
      // aliases well before the noise itself does).
      float wa = smoothstep(0.55, 0.22, cutoff / 1.82);
      float wb = smoothstep(0.55, 0.22, cutoff / 0.54);
      float wc = smoothstep(0.55, 0.22, cutoff / 0.196);
      float amp = wa * 0.50 + wb * 0.33 + wc * 0.17;
      if (amp < 1e-3) return 0.5;
      float a = ironWaterValueNoise(p * 0.55 - drift * 0.30);
      float b = ironWaterValueNoise(p * 1.85 + drift.yx * 0.18);
      float c = ironWaterValueNoise(p * 5.10 - drift * 0.09);
      return (a * 0.50 * wa + b * 0.33 * wb + c * 0.17 * wc) / amp;
    }

    /* ---------------------------------------------------------------- main */

    void main() {
      vec3 eye = cameraPosition;
      vec2 bed = ironWaterSeabed(vWorldPos.xz);
      float surfaceY = vWorldPos.y;
      float depth = surfaceY - bed.x;
      // THE WATERLINE. Not a painted band and not a hard cut: the surface simply
      // stops existing where the seabed comes through it, so the edge is wherever
      // this frame's run-up put it and it moves with the swell.
      if (depth < 0.004) discard;

      vec3 toEye = eye - vWorldPos;
      float viewDist = length(toEye);
      vec3 V = toEye / viewDist;

      // THE PIXEL FOOTPRINT, AS THE TWO VECTORS IT ACTUALLY IS.
      //
      // A pixel on the sea at 300 m from a 6 m eye is not a disc, it is a
      // SLIVER: eight centimetres across and four metres long, because the
      // surface is seen at under two degrees. One scalar cutoff has to take the
      // long axis or the bands running across the sightline alias — so it throws
      // away every wavelength under four metres in EVERY direction, including
      // the direction in which the pixel still resolves eight centimetres. That
      // is a factor of fifty of real, resolvable wave detail discarded per
      // pixel, on exactly the pixels this shot is composed around, and what it
      // leaves behind is the swell alone: a smooth satin sheet with a smeared
      // white river down the middle of it. Two vectors instead of one scalar is
      // the whole of "the water goes flat at distance".
      //
      // ANALYTIC, NOT dFdx(vWorldPos.xz), and that distinction cost a build.
      // The derivative is exact and free and it is also PER-TRIANGLE CONSTANT —
      // a varying is interpolated linearly, so its screen derivative steps at
      // every triangle edge. The ocean grid's triangles are a few pixels across
      // in the mid-field, so a footprint built from derivatives quantises the
      // resolved wave set to the MESH, and the mid-field came back wearing a
      // fine cross-hatched weave: the tessellation, printed onto the sea by the
      // one term that was supposed to be independent of it. Intersecting the
      // pixel's own cone with the mean water plane is smooth by construction.
      //
      // Perturbing the view ray by one pixel and re-intersecting y = surfaceY:
      // with s = viewDist and d the unit view direction, dP = s*(dd - d*dd.y/d.y).
      // The screen-right axis is horizontal (no camera roll on any registered
      // shot), so it drops the second term entirely and the horizontal footprint
      // is just the arc length — while the screen-up axis keeps the 1/d.y, which
      // IS the grazing stretch.
      vec3 dView = -V;
      float dvy = -max(abs(dView.y), 0.0035);
      vec3 rightV = normalize(cross(dView, vec3(0.0, 1.0, 0.0)) + vec3(1e-5, 0.0, 0.0));
      vec3 upV = cross(rightV, dView);
      float fpScale = uWaterPixelAngle * viewDist;
      vec2 fpX = fpScale * (rightV.xz - dView.xz * (rightV.y / dvy));
      vec2 fpY = fpScale * (upV.xz - dView.xz * (upV.y / dvy));
      float fpLenX = length(fpX);
      float fpLenY = length(fpY);
      if (fpLenY > 600.0) { fpY *= 600.0 / fpLenY; fpLenY = 600.0; }
      if (fpLenX > 600.0) { fpX *= 600.0 / fpLenX; fpLenX = 600.0; }
      // The scalar the noise fields still want: the pixel's long axis.
      float footprint = clamp(max(fpLenX, fpLenY), 0.02, 600.0);

      float shoal = ironWaterShoal(vStillDepth);

      /* --- LANGMUIR STREAKS, and they are worth more than they cost --------
       * A steady breeze over any water body organises itself into counter-
       * rotating roll cells with their axes along the wind, and the convergence
       * lines between them sweep up every surfactant on the surface into bands
       * 8-40 m apart. A surfactant band damps capillary waves — that is what a
       * "slick" is — so a real sea is not uniformly rough: it carries long
       * smooth streaks that read almost mirror-flat against the rippled water
       * either side, and they run WITH THE WIND, across the crests of any swell
       * that is not running with it.
       *
       * That crossing is the point. A wave field made of one directional band
       * reads as corduroy no matter how many components are in it, because
       * every feature in it is parallel to every other. Streaks break the frame
       * up at a completely different scale and orientation, they are the reason
       * real open water has large-scale value variation at all, and they cost
       * one noise lookup.
       */
      vec2 windDir = normalize(uWaterSeaState.yz + vec2(1e-5));
      vec2 windPerp = vec2(-windDir.y, windDir.x);
      // 12 m across the streaks, 130 m along them: bands, not blobs.
      vec2 streakP = vec2(dot(vWorldPos.xz, windPerp) * 0.085,
                          dot(vWorldPos.xz, windDir) * 0.0077);
      float streakNoise = ironWaterValueNoise(streakP + vec2(uWaterTime * 0.018, 0.0));
      // 1.0 outside a slick, 0.30 inside one. Never 0: even a heavy slick leaves
      // some relief, and a truly mirror patch in the middle of a sea is a bug.
      float slick = mix(0.30, 1.0, smoothstep(0.34, 0.63, streakNoise));

      float jacobian;
      vec2 residualMss;
      vec3 N = ironWaterShadeNormal(vBaseXZ, uWaterTime, shoal, fpX, fpY, slick, jacobian,
                                    residualMss);
      // A displaced surface seen at grazing angles produces normals that face
      // away from the eye; letting them through gives black speckle on the far
      // water. Bend, do not clamp — and do it without a branch, because a branch
      // on dot(N, V) draws a visible contour line along the exact grazing angle.
      float facing = dot(N, V);
      N = normalize(N + V * max(0.03 - facing, 0.0) * 1.4);

      /* --- microfacet roughness from what the pixel could not resolve ------ */
      // GGX alpha ~ 2 x mean-square slope. The base term is the sub-millimetre
      // capillary roughness that never resolves at any distance: LOOK_SPEC §8.5
      // puts real water at 0.02-0.06.
      //
      // NOT a LUT lookup any more. residualMss is the exact mean-square slope
      // ironWaterShadeNormal just finished fading out, wave by wave, at this
      // pixel's own anisotropic band limit. The precomputed ladder could only
      // answer "how much slope lives below wavelength L" — an isotropic
      // question — so with an anisotropic filter it double-counts every band the
      // pixel still resolves in its short axis, and hands the far water a
      // roughness it has no right to. Handing the fade and the residual to the
      // same loop makes the pair exactly complementary by construction.
      vec2 unresolved = residualMss;
      // The slick damps the SLOPE, and mean-square slope is what this LUT holds,
      // so the roughness a slick hands the pixel scales as the square of the
      // amplitude gain. Without this the far water inside a streak keeps the
      // roughness of water it no longer is, and the streaks vanish at exactly
      // the distance where they do the most compositional work.
      vec2 unresolvedSlick = unresolved * mix(slick * slick, 1.0, 0.25);
      // The SURFACE's own roughness: the capillary floor plus every wave band
      // the pixel could not resolve. This is a property of the water and of the
      // viewing distance, and it is the only roughness any energy integral in
      // this shader is allowed to see.
      float alphaSurface = clamp(0.0016 + 2.0 * (unresolvedSlick.x + unresolvedSlick.y),
                                 0.0016, 0.28);
      // The same statement kept per-axis, in the tangent frame the sun lobe is
      // built in below. Isotropic it reduces to the line above (two equal
      // components, so 4*v per axis is 2*(v+v) in total), so nothing changes on
      // water the pixel sees square-on; everything changes at 300 m, where the
      // two components differ by an order of magnitude.
      vec2 alphaAniso = clamp(vec2(0.0016) + 4.0 * unresolvedSlick, vec2(0.0016), vec2(0.36));

      // GEOMETRIC SPECULAR ANTIALIASING (Kaplanyan's screen-space normal
      // variance, in Tokuyoshi's additive-alpha form). This is the term that
      // was missing, and it is the whole of the black-speckle defect.
      //
      // The analytic band limit above removes every wave band SHORTER than a
      // pixel; it cannot do anything about the bands the pixel does resolve.
      // Those still swing the normal by tens of degrees between one fragment and
      // the next, and the sun lobe at alpha ~ 0.007 is 0.4 deg wide — so one
      // fragment lands inside the lobe and computes 1e6 cd/m2 while its
      // neighbour, half a degree away, computes 1e3. Nothing downstream can
      // survive a 1000:1 pixel-to-pixel ratio: the TAA resolve's Catmull-Rom
      // history fetch has negative lobes, undershoots a ratio that big straight
      // through zero, and its tonemapped blend weight 1/(1 + Y) then hands the
      // clamped-to-zero history ~30 000x the weight of the bright current
      // sample. The pixel latches black and stays black, which is precisely the
      // wedge that ran down the glitter path.
      //
      // The fix is not to dim anything. It is to shade the PIXEL instead of the
      // point: the screen-space derivative of the normal IS the sub-pixel slope
      // distribution the analytic LUT cannot see (it knows about wavelengths,
      // not about how the projection stretched them), and folding its variance
      // into alpha replaces the point sample of the lobe with its integral over
      // the footprint. Energy is conserved — a wider NDF is a lower peak over a
      // larger solid angle — so the glitter path keeps every photon it had and
      // simply stops being a single-fragment spike.
      vec3 dNdx = dFdx(N);
      vec3 dNdy = dFdy(N);
      // 0.5 is Kaplanyan's SIGMA^2 for a box pixel filter. The 0.28 cap is above
      // his KAPPA of 0.18 and that is deliberate: a 2x2 quad clamp can only
      // bound the contrast INSIDE a quad, whereas the Catmull-Rom history fetch
      // that undershoots to zero reads a 4x4 neighbourhood, and the roughness
      // widening is the only term in this shader that bounds contrast at that
      // scale. Measured: 0.28 puts the worst 3x3 luminance range in the sea at
      // 193/255 with zero sub-16 pixels; 0.18 does not hold it.
      // 0.18 is Kaplanyan's KAPPA, and it is back down at his number. It was
      // raised to 0.28 to bound the pixel-to-pixel contrast in the glitter path
      // for the local-contrast limiter that used to sit at the bottom of this
      // shader; that limiter WAS the black wedge and is gone, and the widening
      // it needed took the glitter path's own reflection down with it — a
      // fragment roughened to alpha 0.28 by nothing but screen-space projection
      // returns roughly two thirds of the environment reflectance of the
      // identical water beside it.
      //
      // IT WIDENS THE SUN LOBE AND NOTHING ELSE, and getting that wrong is the
      // OTHER half of the black wedge — the half the local-contrast limiter was
      // added to paper over.
      //
      // A delta light may be antialiased by widening its NDF: D integrates to
      // one over the hemisphere at any alpha, so a wider lobe is a lower peak
      // over more solid angle and no energy moves. The ENVIRONMENT integral is
      // not like that at all. ironWaterEnvReflectance is ∫F·D·G, and its G — the
      // masking-shadowing between facets — is a real loss that grows with
      // roughness and with grazing angle. Feeding it a screen-space alpha means
      // a fragment loses two thirds of the sky it reflects because of how the
      // PROJECTION happened to land, not because of anything the water is doing:
      // measured on this frame, alpha 0.0016 → reflectance 0.73 at 3° incidence,
      // alpha 0.28 → 0.12. Six to one, over exactly the region where the normal
      // swings hardest per pixel, which is by definition the glitter path. The
      // sun's own lobe collapses by four orders of magnitude in the same pixels
      // for the same reason. That is the wedge: not a NaN, not a sign flip — an
      // antialiasing term applied to an integral it does not antialias.
      //
      // So there are two roughnesses from here on and they are not
      // interchangeable. alphaSurface is what the WATER is: the analytic
      // band-limit variance, which already grows with the pixel footprint and is
      // what keeps far water at 0.4-0.6 of the sky. alphaPixel is what the
      // FOOTPRINT is, and it is only ever allowed near a delta light.
      float normalVar = 0.5 * (dot(dNdx, dNdx) + dot(dNdy, dNdy));
      float alphaPixel = clamp(alphaSurface + min(2.0 * normalVar, 0.18), 0.0016, 0.36);

      /* ------------------------------------------------------- fresnel ---- */
      // TWO reflectances, and they are not interchangeable.
      //
      // fresnel is the specular Fresnel of the mean normal — the right term for
      // the SUN, which is a delta light whose own microfacet integral is done
      // properly below with the real NDF.
      //
      // reflectance is the split-sum integral of F·D·G over the whole lobe, and
      // it is the right term for the ENVIRONMENT, which arrives from every
      // direction at once. Using the point Fresnel for the environment is what
      // makes the far sea an exact copy of the sky.
      float NdotV = clamp(dot(N, V), 0.0, 1.0);
      float f90 = 1.0;
      float fresnel = 0.0201 + (f90 - 0.0201) * pow(max(1.0 - NdotV, 0.0), 5.0);
      // alphaSURFACE. The environment integral is the water's, never the
      // projection's — see the note on the two roughnesses above.
      float reflectance = ironWaterEnvReflectance(NdotV, alphaSurface);

      /* ---------------------------------------------------- reflection ---- */
      vec3 R = reflect(-V, N);
      // The probe convolution DOES take the pixel's lobe: this argument only
      // widens the cos^n aureole so a reflection vector swinging degrees per
      // pixel cannot alias the steepest feature in the sky into salt and
      // pepper. Widening a convolution kernel loses no energy; widening the
      // masking term does, which is why they take different arguments.
      vec3 reflected = ironWaterSkyRadiance(normalize(R), alphaPixel);

      float dbgSsrWeight = 0.0;
      #if defined(IRON_WATER_SSR_TEXTURE)
        // LIGHT's screen-space pass, LERPED OVER the probe by its own confidence
        // — never added, or the frame double-counts the same photons.
        vec2 ssrUv = gl_FragCoord.xy / uWaterResolution;
        vec4 ssr = texture(uWaterSsr, ssrUv);
        // The contract says this buffer is composited "by confidence" but does not
        // say which channel carries it, and a buffer that is black where the march
        // missed will paint black over the sky probe wherever its alpha happens to
        // be 1 — which is a hole in the sea along exactly the sightline the
        // glitter path is on. Requiring the sample to carry actual radiance costs
        // one dot product and makes the failure mode "no SSR" instead of "black".
        // SMOOTHSTEP, NOT STEP, and that is the whole lesson of this pass. A
        // binary accept on a quantity that varies per pixel does not produce a
        // boundary, it produces DITHER: neighbouring pixels land either side of
        // the threshold and the sea comes out salt-and-pepper along the edge of
        // whatever the march found. Every gate in here is continuous for that
        // reason.
        //
        // UNITS. THIS WAS THE BLACK WEDGE, and it is the most expensive kind of
        // bug there is: two quantities that are both correct and are not in the
        // same space. Everything in this shader is photometric — cd/m², per the
        // note at the top of the file — and RTId.SsrColor is a SCENE-COLOUR
        // target, so it is already through uWaterRadianceScale (1.88e-4 at the
        // GOLDEN preset). An 8000 cd/m² sky arrives here as 1.5. Mixing that
        // into the reflection at up to 0.9 weight does not tint the reflection, it
        // multiplies it by 1e-4 — and it does so exactly where LIGHT's march
        // finds hits, which over open water is the glitter path and nowhere
        // else. Hence a black wedge down the sun's bearing with per-pixel
        // structure, sitting inside water that was otherwise correct. The
        // refraction branch below already divides its scene-colour sample back
        // out; this branch never did.
        //
        // It is also why the wedge came and went between builds that did not
        // touch this file: what it paints is whatever LIGHT's SSR pass happened
        // to produce that hour.
        vec3 ssrRadiance = ssr.rgb / max(uWaterRadianceScale, 1e-6);
        float ssrLuma = dot(ssrRadiance, vec3(0.2126, 0.7152, 0.0722));
        // 30–300 cd/m², the same photometric window our own march uses two
        // hundred lines down, and for the same reason: the dimmest genuinely lit
        // thing in this frame is a hull face taking sky alone at a couple of
        // hundred cd/m², so anything below that is a pixel nothing was drawn
        // into rather than a dark object.
        float ssrWeight = ssr.a * smoothstep(30.0, 300.0, ssrLuma)
                        * smoothstep(0.30, 0.06, alphaSurface);
        // A MARCH MAY TINT THE ENVIRONMENT PROBE; IT MAY NOT EXTINGUISH IT —
        // the same floor and the same 0.75 ceiling our own march is held to.
        // A screen-space ray speaks for the centre of a lobe with real solid
        // angle and has no way to know about the rest of the hemisphere.
        ssrRadiance = max(ssrRadiance, reflected * 0.30);
        dbgSsrWeight = clamp(ssrWeight, 0.0, 0.75);
        reflected = mix(reflected, ssrRadiance, dbgSsrWeight);
      #elif defined(IRON_WATER_REFRACTION)
        // Our own march. Deliberately short and deliberately given up on early:
        // a grazing ray over water leaves the screen within a few steps and the
        // honest answer at that point is the sky probe, not a smeared edge texel.
        // DEGRADE AT GRAZING ANGLES RATHER THAN SMEAR. A reflection ray that runs
        // nearly parallel to the sea does two bad things: it leaves the screen in
        // a few steps, and it intersects the WATER'S OWN depth (the prepass draws
        // the water for depth), which returns the scene copy from before the water
        // was drawn. Below R.y 0.26 the sky probe is simply the better answer.
        const float SSR_RANGE = 55.0;
        float rayRise = smoothstep(0.08, 0.26, R.y);
        // Rough water cannot carry a screen-space reflection at all: the lobe is
        // wider than a single ray can stand in for.
        // GATED ON THE PIXEL'S LOBE, NOT ON THE SURFACE'S ROUGHNESS. This read
        // alphaSurface for one build and the aircraft's reflection came back as a
        // black wedge 500 px long down the glitter path: the sea under it is
        // steep in SCREEN space, so its effective lobe is tens of degrees wide,
        // and one ray cannot stand in for that however smooth the water itself
        // is. The widened alpha is the honest measure of what this pixel's
        // reflection actually integrates.
        float ssrGate = rayRise * smoothstep(0.030, 0.006, alphaPixel);
        vec4 rClip = uWaterViewProjection * vec4(vWorldPos + R * 0.30, 1.0);
        vec4 rEnd = uWaterViewProjection * vec4(vWorldPos + R * SSR_RANGE, 1.0);
        if (ssrGate > 0.01 && rClip.w > 0.05 && rEnd.w > 0.05) {
          // INTERPOLATE IN CLIP SPACE, not in UV. A straight world-space line is
          // linear in CLIP coordinates; its screen projection is a straight line
          // but is NOT linear in the same parameter. The march this replaced
          // stepped uniformly along the screen segment while assigning each
          // sample a depth interpolated uniformly along the WORLD segment, so
          // every sample past the first compared a screen position against the
          // depth of a different point on the ray, and the hit test stopped
          // meaning anything. Clip-space lerp costs the same and is exact — and
          // it also makes the world parameter t recoverable, which the surface
          // rejection below needs.
          float kEnter = 0.0;
          float kHit = -1.0;
          // LINEAR steps, not quadratic. The quadratic distribution this replaced
          // put its last step 5 m long, so it needed a 5 m thickness window not to
          // tunnel — and a 5 m window accepts anything within 5 m of the ray,
          // which is how one dark object at 60 m came to be smeared over a third
          // of the sea as a black wedge. Uniform steps let the window be one step.
          for (int s = 1; s <= 20; s++) {
            float k = float(s) / 20.0;
            vec4 c = mix(rClip, rEnd, k);
            vec2 uv = (c.xy / c.w) * 0.5 + 0.5;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
            // RTId.SceneDepth is an R32F COLOUR target already carrying LINEAR
            // VIEW DEPTH IN METRES (the contract is stated at the top of
            // src/render/fullscreen.ts, and VFX reads it the same way). It is
            // NOT a hardware depth buffer, so putting it through the usual
            // near/far NDC reconstruction turns 60 m into about -0.002 and every
            // comparison below silently stops meaning anything.
            float sceneZ = min(texture(uWaterSceneDepth, uv).r, uWaterDepthPlanes.y);
            if (c.w - sceneZ > 0.02) { kHit = k; break; }
            kEnter = k;
          }
          if (kHit > 0.0) {
            // Bisect the crossing to 1/16 of a step. Without this the hit lands
            // anywhere inside a 2.75 m interval and the thickness test below
            // cannot tell a surface the ray genuinely met from one it flew past.
            float lo = kEnter;
            float hi = kHit;
            for (int r = 0; r < 4; r++) {
              float m = 0.5 * (lo + hi);
              vec4 c = mix(rClip, rEnd, m);
              vec2 uv = (c.xy / c.w) * 0.5 + 0.5;
              float sceneZ = min(texture(uWaterSceneDepth, uv).r, uWaterDepthPlanes.y);
              if (c.w - sceneZ > 0.02) hi = m; else lo = m;
            }
            vec4 cHit = mix(rClip, rEnd, hi);
            vec2 hitUv = (cHit.xy / cHit.w) * 0.5 + 0.5;
            float hitZ = min(texture(uWaterSceneDepth, hitUv).r, uWaterDepthPlanes.y);
            float travel = mix(0.30, SSR_RANGE, hi);

            // 1. THE HIT MUST BE ABOVE THE WATER. The depth prepass draws the
            //    ocean grid as the still-water plane, so a ray leaving a trough
            //    crosses that plane within a metre or two and "hits" the sea
            //    itself; the colour copy at that pixel is whatever was behind the
            //    water, which is nothing to do with the reflection. One compare
            //    on the ray's own world height rejects the entire class, and it
            //    is free because the clip-space lerp already gives us t.
            float hitY = vWorldPos.y + R.y * travel;
            float aboveWater = smoothstep(0.15, 1.2, hitY - uWaterSeaLevel);

            // 2. THE RAY MUST HAVE ACTUALLY STOPPED THERE, within one bisected
            //    step of depth rather than within an arbitrary constant.
            float stepZ = abs(rEnd.w - rClip.w) / 20.0;
            float thickness = 0.25 + stepZ * 0.4;
            float depthFit = 1.0 - smoothstep(thickness, thickness * 2.5, cHit.w - hitZ);

            // 3. HOW MUCH OF THE LOBE DOES THIS ONE SAMPLE SPEAK FOR? A specular
            //    lobe subtends a real solid angle; a march returns one ray from
            //    the middle of it. When the thing it found is a crane boom or a
            //    mast — narrower than the lobe — the correct answer is mostly sky
            //    with the boom mixed into it, and substituting the boom wholesale
            //    is what turns a reflection into a hole. Two extra depth taps a
            //    lobe-width either side of the hit measure that directly: three
            //    samples on one broad surface is full coverage, one sample on a
            //    thin one is a third.
            vec2 along = normalize((rEnd.xy / rEnd.w - rClip.xy / rClip.w) * 0.5 + 1e-6);
            vec2 lobeUv = along * clamp(sqrt(alphaPixel) * 0.5 + 0.004, 0.004, 0.03);
            float zA = texture(uWaterSceneDepth, clamp(hitUv + lobeUv, 0.001, 0.999)).r;
            float zB = texture(uWaterSceneDepth, clamp(hitUv - lobeUv, 0.001, 0.999)).r;
            float tol = 0.06 * hitZ + 0.4;
            float coverage = (1.0
              + smoothstep(tol * 3.0, tol, abs(zA - hitZ))
              + smoothstep(tol * 3.0, tol, abs(zB - hitZ))) / 3.0;

            // 4. Confidence falls with how far the ray had to go: a hull two
            //    metres away is worth trusting, a silhouette at fifty is one
            //    sample of a lobe that is metres wide by the time it gets there.
            float travelFade = smoothstep(1.0, 0.3, travel / SSR_RANGE);

            // Fade the hit out at the screen edge, or the reflection acquires a
            // hard frame around it that reads worse than having no SSR at all.
            vec2 edge = min(hitUv, 1.0 - hitUv);
            float border = smoothstep(0.0, 0.09, min(edge.x, edge.y));
            vec3 hitColor = texture(uWaterSceneColor, hitUv).rgb;
            // A MARCH MAY TINT THE ENVIRONMENT PROBE; IT MAY NOT EXTINGUISH IT.
            // The ray speaks for the centre of a lobe that subtends real solid
            // angle, and whatever it found — a hull, a crane boom, an aircraft
            // crossing the sun — occludes only part of that lobe. The rest still
            // sees sky, and no screen-space march has any way to know about it.
            // Floored at 30 % of the probe the sea can still go visibly dark
            // under a silhouette and can never go to a hole.
            hitColor = max(hitColor, reflected * 0.30);
            // A pixel nothing was drawn into comes back black, and trusting it
            // punches a hole in the sea. SMOOTHSTEP, NOT STEP: a step() at 1.0 cd/m2
            // is a per-pixel coin toss wherever the scene copy hovers near the
            // threshold, and it dithers the edge of every reflection.
            float hitLuma = dot(hitColor, vec3(0.2126, 0.7152, 0.0722));
            // 30-300 cd/m2, not 1. This frame is PHOTOMETRIC: the dimmest thing
            // in it that is genuinely lit — a hull face in its own shadow, taking
            // sky alone — is a couple of hundred cd/m2. A screen-space sample
            // below that is not a dark object, it is a pixel nothing was drawn
            // into or a march that tunnelled, and substituting it for a 10 000
            // cd/m2 sky probe is how a reflection becomes a hole.
            float hitValid = smoothstep(30.0, 300.0, hitLuma);
            // 0.88, not 1.0. Even a solid occluder filling the lobe centre leaves
            // its rim open to the sky, and a screen-space march has no way to see
            // that part of the hemisphere. Refusing the last 12 % is the
            // difference between a dark reflection and a black hole.
            float conf = clamp(ssrGate * border * aboveWater * depthFit
                               * coverage * travelFade * hitValid, 0.0, 0.75);
            dbgSsrWeight = conf;
            reflected = mix(reflected, hitColor, conf);
          }
        }
      #endif

      // The sky probe is built from uniforms and cannot be non-finite; the
      // marches above are built from a normal, a projection and a texture
      // fetch, and can. Fall back on a flat-sea sky sample, which shares no
      // input with either march.
      reflected = ironWaterFinite(reflected, ironWaterSkyRadiance(vec3(0.0, 1.0, 0.0), 0.05));

      /* --------------------------------------------------- sun glitter ---- */
      // GGX with the sun's real solid angle folded into alpha. At 11 deg the
      // specular lobe of a 0.04-rough sea is narrower than the sun disc itself,
      // so without this widening the highlight is a single aliasing pixel; with
      // it, it is a path of over-range pinpricks that the bloom pyramid can find.
      vec3 L = uWaterSunDir;
      vec3 H = normalize(L + V + vec3(1e-6));
      // CLAMPED, not max()'d, and this is not pedantry: dot(V, H) is 1.0 by
      // construction when the view direction meets the sun, floating point makes
      // that 1.0000001, and pow() of a negative base is undefined in GLSL. The
      // resulting NaN survives every downstream max() and comes out of the
      // tonemapper as a black wedge along exactly the sightline this whole shot
      // is about.
      float NdotL = clamp(dot(N, L), 0.0, 1.0);
      float NdotH = clamp(dot(N, H), 0.0, 1.0);
      float VdotH = clamp(dot(V, H), 0.0, 1.0);
      // Sun angular radius 0.265 deg = 4.65e-3 rad, plus the screen-space
      // widening: the sun is a delta light, its NDF integrates to one at any
      // width, and widening it is exactly the antialiasing that term was
      // introduced for. (It is the ONE place the screen-space alpha belongs —
      // see the note above on why the environment integral must never see it.)
      //
      // ANISOTROPIC GGX, and it is the difference between a glitter path and a
      // white spill. The unresolved slope this pixel has to hand the NDF is not
      // the same in both directions — at 300 m down a 2 deg sightline the bands
      // running across the view are still resolved and the bands running along
      // it are not — so a round lobe is wrong by an order of magnitude in each
      // direction at once: too wide across the view (smearing every highlight
      // sideways into its neighbours until the path is one continuous ribbon)
      // and too narrow along it. Splitting it puts the sun's reflection back
      // into the shape it has in every photograph ever taken of one: a
      // population of short streaks pointing at the sun, dense near the horizon
      // and resolving into separate sparkles as they come toward the eye.
      //
      // Burley's form, in a tangent frame built off the shading normal so it
      // stays orthonormal on a steep crest. The residual variance was
      // accumulated in world X and Z and the frame's axes are those two
      // Gram-Schmidted against N, so no rotation is needed to consume it.
      vec3 tanT = normalize(vec3(1.0, 0.0, 0.0) - N * N.x + vec3(0.0, 0.0, 1e-5));
      vec3 tanB = cross(N, tanT);
      vec2 alphaSunA = clamp(alphaAniso + min(2.0 * normalVar, 0.18) + 4.65e-3,
                             vec2(0.0016), vec2(0.5));
      float hT = dot(H, tanT) / alphaSunA.x;
      float hB = dot(H, tanB) / alphaSunA.y;
      float dA = hT * hT + hB * hB + NdotH * NdotH;
      float D = 1.0 / (IRON_PI * alphaSunA.x * alphaSunA.y * max(dA * dA, 1e-12));
      // The masking term stays isotropic at the lobe's equivalent width — the
      // geometric mean of the two alphas, which is the one scalar that leaves
      // the projected microfacet area unchanged.
      float alphaSun = clamp(sqrt(alphaSunA.x * alphaSunA.y), 0.0016, 0.5);
      float a2 = alphaSun * alphaSun;
      // Height-correlated Smith. The uncorrelated form loses noticeable energy at
      // exactly the grazing angles the glitter path lives at.
      float gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
      float gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
      float vis = 0.5 / max(gv + gl, 1e-5);
      float Fs = 0.0201 + (1.0 - 0.0201) * pow(max(1.0 - VdotH, 0.0), 5.0);
      // A MIRROR CANNOT BE BRIGHTER THAN WHAT IT REFLECTS, and this clamp is that
      // statement. LOOK_SPEC §2.2 renders the sun disc at 1.6e7 cd/m2; the water's
      // specular lobe integrates the same disc, so that is its ceiling. Left
      // unclamped, a 0.04-rough sea at grazing incidence computes 3.6e9 cd/m2 —
      // which overflows a half-float scene target to Inf, and the first pass that
      // filters it turns the Inf into NaN and the glitter path into a black wedge.
      // 1.6e7 is still four orders of magnitude over the white point, so the
      // highlight is every bit as blown as §8.5 asks for.
      vec3 sunSpec = min(uWaterSunIlluminance * NdotL * D * vis * Fs, vec3(1.6e7));

      /* --------------------------------------------- transmitted radiance -- */
      // Downwelling illuminance just under the surface. 0.94 is the hemispherical
      // transmittance of an air-water interface for diffuse sky plus the sun at
      // this elevation; the rest reflects and is already counted above.
      vec3 downwelling = (uWaterSunIlluminance * max(uWaterSunDir.y, 0.0) +
                          vec3(uWaterSkyIlluminance)) * 0.94;

      /* -- THE INHERENT OPTICAL PROPERTIES, AND WHY THERE ARE NOW THREE ------
       *
       * The harbour used to render emerald — a saturated (59, 145, 100) band in
       * the near field, the most saturated thing in any frame it appeared in.
       * The cause was modelling water with ABSORPTION ALONE. Absorption is what
       * makes water blue-green; scattering is what makes it PALE, and a medium
       * with the first and not the second reproduces the hue of the absorption
       * curve at whatever saturation the path length happens to produce, which
       * is unbounded. Real sea water is never that saturated because every metre
       * of it both removes light and adds its own.
       *
       * So: absorption a, scattering b, backscatter bb, kept separate because
       * three different things need three different combinations of them.
       *
       * "a" is pure water (Pope & Fry) plus the CDOM a working harbour carries —
       * yellow substance absorbs hard in the blue, which is why a port basin is
       * green-teal and an open ocean is deep blue. "b" is particulate, roughly
       * λ⁻¹, and it is LARGE here: this is a commercial harbour with a river in
       * it, not a coral lagoon. "bb" is the backscattered share, ~2 % for coastal
       * mineral particles.
       */
      vec3 aWater = vec3(0.350, 0.067, 0.065);
      vec3 bWater = vec3(0.52, 0.60, 0.70);
      // SURF-ZONE SUSPENSION. Breaking waves lift the bed, so the nearshore is
      // the most turbid water on any coast — that is why a surf line is milky
      // and pale rather than a clear window onto bright sand, and it is the
      // reason a shallow band over a lit beach must not render as saturated
      // green. Scattering is what changes, not absorption: the sand is in
      // suspension, not in solution.
      float suspended = clamp(smoothstep(4.0, 0.4, depth) * shoal, 0.0, 1.0);
      bWater *= 1.0 + 2.6 * suspended;
      vec3 bbWater = bWater * 0.021;
      // Diffuse attenuation (Gordon): Kd ≈ 1.04·(a + bb)/μ_d, and μ_d ≈ 0.75 for
      // the refracted 47° sun. This governs the DOWNWELLING field, which is a
      // diffuse flux: forward scattering keeps a photon in the flux, so b barely
      // appears. It is why light reaches the bottom of turbid water at all.
      vec3 kd = 1.39 * (aWater + bbWater);
      // Beam attenuation c = a + b. This governs the leg BACK TO THE EYE, which
      // is not a flux but an IMAGE: a photon scattered out of the line of sight
      // is one that no longer carries the seabed's picture, whether or not it is
      // still in the water. A harbour hides its own bottom at three metres while
      // a lagoon shows it at twenty-five, and the two differ in b, not in a —
      // this is the term that knows that.
      vec3 cWater = aWater + bWater;
      // The upwelling leg is part image, part diffuse glow, so it attenuates at
      // neither rate. 0.55 toward the beam is the mix that puts our seabed's
      // visibility at LOOK_SPEC §8.5's "seabed readable through the shallows"
      // without making the deep basin transparent.
      vec3 kUp = mix(kd, cWater, 0.6);
      // The asymptotic reflectance of an infinitely deep column, R∞ = 0.33·bb/(a+bb).
      // With these IOPs it evaluates to (0.010, 0.046, 0.061) — inside
      // LOOK_SPEC §4.3's 0.02–0.06 for the diffuse component of sea water, at
      // hue 189°, inside its 185–195° window. That is not a coincidence and it
      // is not a fitted constant: it is what those IOPs mean. The old
      // hand-authored bodyAlbedo is gone with the term that needed it.
      vec3 rInfinity = 0.33 * bbWater / (aWater + bbWater);
      // BOTH legs are refracted, and the sun's leg is the one people get wrong.
      // An 11 deg sun is 79 deg from vertical in AIR, but Snell at 1.333 bends it
      // to 47 deg in WATER — cos 0.68, not sin 0.19. Using the air angle makes the
      // path through the shallows nearly three times too long, which drains every
      // trace of sand out of water that should be turquoise. Total internal
      // reflection caps the refracted angle at 48.6 deg however low the sun goes,
      // which is why shallow water stays lit at sunset.
      float refrCos = sqrt(max(1.0 - (1.0 - NdotV * NdotV) / (1.333 * 1.333), 0.02));
      float sinAir = sqrt(max(1.0 - uWaterSunDir.y * uWaterSunDir.y, 0.0));
      float sunRefrCos = sqrt(max(1.0 - (sinAir * sinAir) / (1.333 * 1.333), 0.04));
      // pathUp is the SUN's leg (down through the water to the bed) and pathDown
      // is the EYE's, which is the one that carries the image. Named for the
      // direction the light travels, kept because every consumer below reads
      // them that way.
      float pathDown = depth / max(refrCos, 0.18);
      float pathUp = depth / sunRefrCos;
      vec3 seabedTrans = exp(-(kd * pathUp + kUp * pathDown));

      // Seabed albedo. Sampled from the SAME sand the terrain lane is using, via
      // the material factory's public texture set, so the sand under 20 cm of
      // water and the sand 20 cm inshore of it are the same colour.
      vec3 sand = texture(uWaterSandAlbedo, vWorldPos.xz / max(uWaterSandTiling, 0.5)).rgb;
      float rockMask = smoothstep(0.35, 1.1, bed.y);
      vec3 seabedAlbedo = mix(sand, sand * vec3(0.52, 0.55, 0.58), rockMask);
      // Wetted grains are darker: the §4.5 mask, applied where the water is thin
      // enough that this is the beach rather than the seabed.
      seabedAlbedo *= mix(1.0, 0.62, smoothstep(0.55, 0.02, depth));
      // AND BELOW THE SWASH IT IS NOT SAND AT ALL. Past half a metre the bed of
      // a working harbour is silt, weed and whatever the dredger left: LOOK_SPEC
      // §4.3 gives dry sand 0.45–0.58 and there is nothing under water anywhere
      // in that table. Leaving beach albedo on the seabed is most of what made
      // the near-field basin read as a lit green sheet — a bright bottom seen
      // through a green filter is a bright green surface, and no amount of
      // correcting the medium fixes it while the bottom is wrong.
      seabedAlbedo = mix(seabedAlbedo, seabedAlbedo * vec3(0.34, 0.36, 0.40),
                         smoothstep(0.4, 3.0, depth));
      seabedAlbedo = clamp(seabedAlbedo, vec3(0.035), vec3(0.82));

      vec3 seabedRadiance = seabedAlbedo / IRON_PI * downwelling * seabedTrans;

      // THE VEIL. The light the beam took out of the seabed's image did not
      // leave the frame — it is in the column between the eye and the bed,
      // scattered toward the camera, and it is the whole reason shallow water is
      // pale rather than a tinted window. It fills in on exactly the schedule
      // the seabed fades out on, so the two always sum to a sane radiance and
      // the water gets less saturated with depth instead of more. At the
      // asymptote it IS the deep-water colour, which is the point of writing it
      // this way rather than as a separate depth ramp.
      vec3 body = rInfinity / IRON_PI * downwelling * (1.0 - seabedTrans);

      vec3 transmitted = seabedRadiance + body;

      /* ------------------------------------------------ wave transmission -- */
      // LOOK_SPEC §4.7 asks for two-sided translucency on vegetation for exactly
      // the reason it is needed here: a wave crest between the eye and a low sun
      // is a 20-80 cm slab of a medium whose green-blue transmittance over that
      // path is 0.5-0.8. It does not reflect the sun, it TRANSMITS it, and a
      // backlit crest is therefore brighter AND more saturated than the same
      // water lit from behind the camera. Without this, wave backs facing the
      // sun are uniformly darker than their fronts — which is what a purely
      // reflective model must produce, and which is the single clearest tell
      // that a sea is being shaded as a mirror rather than as a fluid.
      //
      // Three factors, each of which is doing real work:
      //   - how nearly the eye is looking along the sun ray (the light has to
      //     come out on our side),
      //   - how much water is between the eye and the sun, taken as the height
      //     of this fragment above the mean surface — the crest IS the slab,
      //   - how nearly the surface faces away from the sun, because a face
      //     turned toward it reflects instead.
      float towardSun = clamp(dot(-V, L), 0.0, 1.0);
      float crestHeight = max(surfaceY - uWaterSeaLevel, 0.0);
      // The slab the ray crosses. A crest 0.4 m proud of the mean surface
      // presents roughly a metre of water to a sun 10° above the horizon,
      // because the ray is running almost along the crest rather than across
      // it — hence the 2.2, which is 1/sin of a shallow crossing angle and not
      // a tuning constant.
      float slabPath = crestHeight * 2.2;
      vec3 slabTau = cWater * slabPath;
      // THE TINT IS DERIVED, NOT AUTHORED, and this is the second time in this
      // shader that mattered. An authored "backlit water is emerald" constant
      // is wrong for the same reason an authored body colour was: at a 3400 K
      // sun and a 0.8 m crest the path is too short to strip the red, so the
      // transmitted light comes out warm-neutral, and painting it green puts an
      // emerald flood over the entire near field of a golden-hour frame.
      //
      // Single scattering out of the slab: the share of the beam that is
      // redirected rather than absorbed is the single-scattering albedo b/c, the
      // share that is intercepted at all is (1 - e^-τ), and what is scattered
      // still has to get out, which costs half the slab again on average.
      vec3 singleScatterAlbedo = bWater / cWater;
      vec3 sss = singleScatterAlbedo * (1.0 - exp(-slabTau)) * exp(-slabTau * 0.5)
               * uWaterSunIlluminance * (0.22 / IRON_PI)
               // Forward-peaked: the light has to come out on our side of the
               // wave, so this term only exists looking into the sun. That is
               // also what makes it a BRAVO effect and invisible at ALPHA.
               * pow(towardSun, 3.0) * (1.0 - fresnel)
               * smoothstep(0.0, 1.2, depth);

      // How close the nearest solid behind this fragment is to the surface, as a
      // 0-1 mask. Zero without a depth buffer to ask.
      float contactCollar = 0.0;

      #if defined(IRON_WATER_REFRACTION)
        // Real refraction of whatever is behind the surface, offset by the
        // surface normal and pulled back if the sample turns out to be IN FRONT
        // of the water — which is the classic artefact of a hull refracting the
        // sky above its own waterline.
        vec2 screenUv = gl_FragCoord.xy / uWaterResolution;
        vec2 offset = N.xz * clamp(depth * 0.10, 0.0, 0.35) * (0.4 / max(viewDist * 0.03, 0.6));
        vec2 refrUv = clamp(screenUv + offset, vec2(0.002), vec2(0.998));
        // Linear metres straight out of the R32F target — see the note in the
        // SSR march above for why there is no near/far reconstruction here.
        float sceneZ = min(texture(uWaterSceneDepth, refrUv).r, uWaterDepthPlanes.y);
        vec4 clipHere = uWaterViewProjection * vec4(vWorldPos, 1.0);
        if (sceneZ < clipHere.w) refrUv = screenUv;
        vec3 behind = texture(uWaterSceneColor, refrUv).rgb / max(uWaterRadianceScale, 1e-6);
        // Whatever is behind the water is itself attenuated by the column it is
        // seen through, so it fades into the body colour at the same rate the
        // seabed does.
        float behindDepth = clamp(max(sceneZ - clipHere.w, 0.0), 0.0, 40.0);
        // The same mixed image/flux rate the seabed uses. It was sigma * 1.6
        // with sigma standing for absorption alone; now that sigma IS the beam
        // attenuation the 1.6 would double-count the scattering it just gained.
        vec3 behindTrans = exp(-kUp * behindDepth);
        // Use the screen-space sample only where there is genuinely something
        // between the surface and the seabed — the freighter's hull, the
        // breakwater blocks.
        // Three rejections, and the third is the one that saves the frame. A
        // sample at zero depth is the WATER'S OWN pixel (the prepass draws water
        // for depth) and would paint the sea with whatever was behind it. A
        // sample deeper than the seabed IS the seabed, which the analytic term
        // already does with the right absorption. And a sample that comes back
        // BLACK is a pixel nothing was drawn into — a cleared buffer, a
        // depth-encoding this lane guessed wrong, a pass that has not landed yet —
        // and trusting it punches holes in the sea. Every lit surface in a
        // photometric frame is far brighter than 1 cd/m², so the test is free.
        // SMOOTHSTEP EVERY ONE OF THEM. These were three step() calls, and a
        // step() on a quantity that varies per pixel does not draw a boundary, it
        // draws DITHER — neighbouring pixels land either side of the threshold and
        // the sea comes out salt-and-pepper wherever the scene copy hovers near
        // the cut. Continuous gates cost nothing and cannot do that.
        float behindLuma = dot(behind, vec3(0.2126, 0.7152, 0.0722));
        float behindMax = min(pathDown * 0.95, 12.0);
        float realGeometry = smoothstep(0.25, 0.7, behindDepth)
                           * (1.0 - smoothstep(behindMax * 0.7, behindMax, behindDepth))
                           * smoothstep(0.5, 12.0, behindLuma);
        transmitted = mix(transmitted, behind * behindTrans + body,
                          realGeometry * 0.8 * smoothstep(0.6, 1.4, depth));

        // THE WATERLINE COLLAR. LOOK_SPEC §4.4's rule that nothing meets
        // anything with a clean seam is not a terrain rule: a hull that meets
        // the sea along a straight analytic cut is the same defect as a wall
        // that meets sand along one, and it is more obvious, because the sea is
        // moving and the cut is not. Every solid that pierces a surface with a
        // swell running against it drags a foam collar: the wave runs up the
        // object, aerates against it, and the bubbles take a second or two to
        // clear, so the collar is always wider than the geometry suggests and
        // always ragged.
        //
        // The signal is the depth delta. Where the solid behind this fragment is
        // within ~0.6 m of the surface along the view ray, this fragment is at
        // its waterline. Over open water the same delta is the distance to the
        // far plane, so the near test alone rejects the entire sea; the luma
        // gate then rejects pixels nothing was drawn into, for the same reason
        // the refraction above does.
        contactCollar = (1.0 - smoothstep(0.12, 0.62, behindDepth))
                      * smoothstep(0.5, 12.0, behindLuma);
      #endif

      /* ----------------------------------------------------------- foam ---- */
      // Four sources, all of them masks that cost a few smoothsteps. The drifting
      // noise that breaks them up costs twelve hashes, so it is evaluated only
      // where at least one mask is live — which over open water is nowhere.

      // 1. Whitecaps. TWO PREDICATES, because the Jacobian alone produced none.
      //
      //    The fold test is the physically exact one: where det(∂P/∂p) goes to
      //    zero the surface has turned back on itself and the crest is
      //    genuinely plunging. But the steepness budget is deliberately held at
      //    0.78 so the Gerstner sum NEVER folds, which means that test can only
      //    ever fire on the handful of fragments where several bands happen to
      //    align — and in practice it fired on none, which is why there was no
      //    foam anywhere in the frame.
      //
      //    The second predicate is the one that describes what actually
      //    whitecaps: a crest is high AND its face is steep. Air entrainment
      //    starts at a crest-face slope around 25-30°, well before the surface
      //    folds. Together they put coverage at a couple of per cent of the open
      //    sea, which is what a 0.8 m swell under a 4.5 m/s breeze looks like —
      //    scattered, short-lived, on the crests and nowhere else. §8.1's rule
      //    that VFX are sparse applies to foam as much as to tracers.
      float faceSlope = length(vec2(N.x, N.z)) / max(N.y, 0.05);
      // 0.26 rad is a 15° crest face, 0.50 a 27° one: air entrainment starts at
      // the low end and a face steeper than the high end is breaking.
      float crestLift = smoothstep(0.22, 0.80, crestHeight / max(uWaterSeaState.x * 0.5, 0.08));
      float crest = max(smoothstep(0.36, 0.14, jacobian),
                        crestLift * smoothstep(0.26, 0.50, faceSlope));

      // 2. The surf line. A wave breaks when the water shallows to roughly 1.3x
      //    its own height, so the band tracks the swell rather than sitting at a
      //    fixed contour.
      // A wave breaks at roughly 1.3x its own height of water, and Hs here is
      // 0.82 m — so this band is about a metre deep, not the three metres an
      // over-generous constant produces, which would put surf across the entire
      // inner harbour.
      float breakDepth = 0.35 + 0.85 * shoal;
      float surfBand = smoothstep(breakDepth * 1.7, breakDepth * 0.4, depth);
      // TERRAIN publishes the authoritative signed distance to its own waterline;
      // our depth field is the frozen macro silhouette. Where erosion has moved
      // the beach by a metre the surf must follow TERRAIN, or the foam band and
      // the sand it is supposed to be running up disagree — and that reads as a
      // water bug rather than as a terrain one.
      if (uWaterShoreDecode.y > 0.5) {
        vec2 suv = (vWorldPos.xz - uWaterShoreRect.xy) / uWaterShoreRect.zw;
        float shoreDist = (texture(uWaterShoreMask, clamp(suv, 0.001, 0.999)).r * 2.0 - 1.0)
                          * uWaterShoreDecode.x;
        surfBand = max(surfBand, smoothstep(-7.0, -0.3, shoreDist) * step(shoreDist, 0.6));
      }

      // 3. Swash. The thin sheet at the very edge is nearly all foam.
      float swashBand = smoothstep(0.30, 0.02, depth);

      // 4. Anything the water is breaking against: the breakwater blocks, the
      //    rocks under the headland, the freighter's reef. A steep seabed under a
      //    running swell is where water goes white whether or not it is a beach.
      float obstacleBand = smoothstep(0.55, 1.5, bed.y) * smoothstep(6.0, 1.0, depth);

      // 5. Windrows. The same Langmuir convergence that damps the capillaries
      //    also SWEEPS UP whatever foam already exists into the same lines, so
      //    open-sea foam is never isotropic — it lies in streaks running with
      //    the wind. Free: it is the slick mask the roughness already uses,
      //    inverted, since foam collects exactly where the ripples are damped.
      float windrow = 1.0 - smoothstep(0.30, 0.75, slick);

      float foam = 0.0;
      if (max(max(crest, surfBand), max(max(swashBand, obstacleBand), contactCollar)) > 0.002) {
        float noise = ironWaterFoamNoise(vWorldPos.xz, uWaterTime, footprint);
        float surfPhase = 0.5 + 0.5 * sin(uWaterWaveA[0].z * dot(uWaterWaveA[0].xy, vBaseXZ) * 0.35
                                          - uWaterWaveA[0].w * uWaterTime);
        // Whitecaps sit inside the windrows twice as densely as outside them.
        float whitecap = crest * smoothstep(0.46, 0.84, noise) * (0.45 + 0.75 * windrow);
        float surf = surfBand * smoothstep(0.30, 0.78, noise * 0.72 + 0.28 * surfPhase);
        float swashFoam = swashBand * (0.55 + 0.45 * noise);
        float obstacle = obstacleBand * smoothstep(0.42, 0.80, noise);
        // The collar is noise-broken and it BREATHES with the swell, because
        // what makes it is the water running up the object and draining back.
        // A clean band at a fixed width is the analytic cut with a white line
        // painted on it, which is not an improvement on the analytic cut.
        float collar = contactCollar
                     * smoothstep(0.20, 0.62, noise * 0.62 + 0.38 * surfPhase)
                     * (0.55 + 0.45 * contactCollar);
        foam = clamp(max(max(whitecap, surf), max(max(swashFoam, obstacle), collar)), 0.0, 1.0);
      }
      // Foam is not a decal: it thins out with distance because the individual
      // bubbles stop resolving, exactly like every other micro-scale feature.
      foam *= smoothstep(900.0, 260.0, viewDist) * 0.85 + 0.15;

      /* -------------------------------------------------------- assemble --- */
      // The ENVIRONMENT reflectance, not the point Fresnel — see the note where
      // the two are computed. Energy conservation is against the same number the
      // reflection uses, or the sea gains or loses light at grazing angles.
      // EVERY TERM, BEFORE THEY ARE SUMMED. One NaN in one channel of one of
      // them makes the sum a NaN, and from there the shoulder's divide makes the
      // fragment a NaN, and max(NaN, floor) below cannot take it back.
      transmitted = ironWaterFinite(transmitted, body);
      sunSpec = ironWaterFinite(sunSpec, vec3(0.0));
      sss = ironWaterFinite(sss, vec3(0.0));
      float reflSafe = clamp(reflectance, 0.0201, 1.0);
      vec3 water = transmitted * (1.0 - reflSafe) + reflected * reflSafe + sunSpec + sss;
      // A PHYSICAL FLOOR, and it is a floor rather than a fudge.
      //
      // Instrumenting the black wedge down the glitter path term by term showed
      // the reflection term healthy (three times the control region, as an
      // aureole should be) and the transmission term healthy (the body radiance, ~160 cd/m²,
      // which is depth-independent once the seabed is out of range) — and the
      // SUM of them arriving at 20-40 cd/m² on a speckle of fragments inside
      // that region. Energy is being lost between two terms that are both
      // correct, on fragments whose only distinguishing property is that their
      // facet is turned toward the camera, where the split-sum reflectance
      // bottoms out at F0.
      //
      // This states the bound the composition is violating. A water facet
      // ALWAYS returns its own body radiance plus at least F0 = 2 % of whatever
      // it is pointed at: there is no angle, no roughness and no wave geometry
      // that makes a sea darker than that, because F0 is the normal-incidence
      // Fresnel and normal incidence is the minimum of the curve. So a fragment
      // that computes darker has dropped a term rather than found a dark one,
      // and max() against the bound restores exactly what was dropped while
      // being the identity everywhere the composition is already correct.
      //
      // HONEST LABEL: this bounds the symptom. The remaining unknown is which
      // of the two terms is being lost on those fragments — the measurements
      // above rule out NaN, the SSR march, the roughness widening and the
      // highlight shoulder, and do not yet name a replacement.
      water = max(ironWaterFinite(water, transmitted), transmitted * 0.9 + reflected * 0.0201);
      float dbgWater = dot(water, vec3(0.2126,0.7152,0.0722));

      // Foam is a dense Lambertian scatterer sitting ON the surface: it takes the
      // sun and the sky directly and it OCCLUDES what is under it. Albedo 0.72,
      // under §4.3's 0.82 ceiling — sea foam is never white paint.
      vec3 foamNormal = normalize(vec3(0.0, 1.0, 0.0) * 0.62 + N * 0.38);
      vec3 foamRadiance = vec3(0.72) / IRON_PI *
                          (uWaterSunIlluminance * max(dot(foamNormal, L), 0.0)
                           + vec3(uWaterSkyIlluminance) * 1.05);
      vec3 color = mix(water, foamRadiance, foam);

      color = ironWaterAerial(color, vWorldPos, eye);
      float dbgAerial = dot(color, vec3(0.2126,0.7152,0.0722));

      /* ------------------------------------------------ highlight shoulder -- */
      // THE BLACK WEDGE IN THE GLITTER PATH WAS THIS TERM, and the shape of the
      // mistake is worth stating because it is easy to make again.
      //
      // What used to be here was a "local contrast limiter": each fragment was
      // capped at 240 + 8x the floor of its own 2x2 shading quad, where the
      // floor was estimated as lum - |dFdx(lum)| - |dFdy(lum)|. The intent was a
      // firefly clamp. What it actually is, is a filter keyed on LOCAL
      // VARIANCE — and the sun's glitter path is, by construction, the highest-
      // variance region in the frame: adjacent fragments legitimately differ by
      // orders of magnitude because one facet is aimed at the sun and its
      // neighbour is not. So |dFdx(lum)| there is the same size as lum itself,
      // the estimated quad floor collapses to zero for EVERY fragment in the
      // region rather than for outliers, and the cap becomes a flat 240 cd/m2
      // ceiling applied to the one part of the sea that should be at 2e4. The
      // water 200 px to the side, being smooth, kept its 8000. The brightest
      // thing in the frame rendered as the darkest, in 2x2 blocks (the quad
      // granularity of the derivative), with surviving speckle wherever a
      // fragment's luminance happened to fall below the cap — and since the cap
      // was applied to luminance while the survivors kept their own chroma, the
      // survivors were the blue ones. Every symptom in the report falls out of
      // those four lines.
      //
      // The replacement is MONOTONE, which is the property the old term lacked
      // and the only one that matters here: a fragment's output must be a
      // non-decreasing function of its input, so no fragment can ever be pushed
      // below a dimmer neighbour. An exponential shoulder gives that plus a hard
      // asymptote, so the ceiling that keeps a half-float target from reaching
      // Inf is still there — it is just reached smoothly and in the right order.
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      // Below the knee nothing is touched at all: the sea's ordinary range tops
      // out around 1e4 cd/m2 and only the specular lobe goes past it.
      const float LUM_KNEE = 1.2e4;
      const float LUM_CEIL = 4.5e4;
      float rolled = lum <= LUM_KNEE
        ? lum
        : LUM_CEIL - (LUM_CEIL - LUM_KNEE) * exp(-(lum - LUM_KNEE) / (LUM_CEIL - LUM_KNEE));
      // Scaled as a ratio so the shoulder is achromatic — it takes the highlight
      // down in value without rotating its hue, which is what LOOK_SPEC §5.1
      // asks of everything above the midtones.
      color *= rolled / max(lum, 1e-4);
      // Negative radiance is not a thing. A Rayleigh term, a bent normal and a
      // split-sum fit can all produce a small negative in one channel at grazing
      // incidence, and a negative that reaches log2() downstream is another
      // black pixel.
      color = max(color, vec3(0.0));

      // NaN GUARD, AND IT IS THE LAST THING THAT TOUCHES THE COLOUR. One NaN
      // anywhere upstream — a pow() with a negative base, a normalize() of a
      // zero vector, an Inf that met a zero — survives max() and clamp() on
      // every driver, and downstream it is worse than a black hole: the tonemap
      // pass's terminal clamp turns it into 1.0, a white pixel that then feeds
      // the bloom pyramid and washes the whole frame.
      //
      // The fallback is a UNIFORM, deliberately. It used to be the reflection
      // term (reflected * reflectance), which is computed from the same normal
      // and the same roughness as everything that could have produced the NaN in
      // the first place — a guard whose escape hatch shares the failure mode of
      // the thing it guards is not a guard. The sky's own diffuse radiance is
      // a uniform, so it is finite by construction, and at
      // a fragment whose real answer is unknown, the sea reflecting the sky is
      // the least wrong thing to say.
      // WRITTEN AS RANGE COMPARISONS, not as notEqual(color, color). The
      // self-inequality is the textbook NaN test and it is also the one form a
      // shader compiler is allowed to fold away: a backend that assumes finite
      // math can prove x != x is never true and delete the guard entirely, and
      // this pass has no way to detect that it happened. A range test survives,
      // because it is false for NaN for a reason the optimiser cannot reason
      // around — EVERY comparison against NaN is false — and it catches Inf in
      // the same two compares. Same idiom, and the same argument, as
      // ironSanitize in render/color.ts and the exposure pass's meter gate.
      //
      // This is NOT what fixed the black wedge — the wedge was finite shading,
      // pinned at the old local-contrast cap's 240 cd/m2 pedestal (see the note
      // on the highlight shoulder above). This guard has still never been
      // observed to fire; it stays because a shader that writes into a temporal
      // filter has to be provably finite, not probably finite.
      vec3 safe = vec3(uWaterSkyIlluminance) / IRON_PI;
      bvec3 finite = bvec3(color.r > -1.0 && color.r < 1.0e12,
                           color.g > -1.0 && color.g < 1.0e12,
                           color.b > -1.0 && color.b < 1.0e12);
      float dbgNaN = all(finite) ? 0.0 : 1.0;
      // A REAL SELECT, NOT A MIX. mix(safe, color, 0.0) expands to
      // safe*1 + color*0, and NaN*0 is NaN on every IEEE unit ever built — so
      // the guard that was here propagated exactly the values it was written to
      // catch. A component-wise ternary is a select instruction and cannot.
      color = vec3(finite.x ? color.x : safe.x,
                   finite.y ? color.y : safe.y,
                   finite.z ? color.z : safe.z);

      // THE HIGHLIGHT CEILING, and it is a compromise that should be revisited.
      //
      // Physically, a 0.04-rough sea at 11° computes specular radiance in the
      // 1e9 cd/m² range: it is a mirror pointed at the sun. Written into an
      // RGBA16F scene target that is an Inf (the format tops out at 65504), and
      // every temporal or pyramid filter downstream turns an Inf into a NaN,
      // which arrives as a black hole in the middle of the brightest thing in the
      // frame. Even well short of Inf, a Catmull-Rom TAA history undershoots
      // around a source this bright and can ring NEGATIVE, which the tonemapper's
      // log2 turns into the same black.
      //
      // 4.5e4 cd/m² is 8.5 in scene-linear at LOOK_SPEC §2.1's exposure — display
      // ~250 before bloom, so the glitter path genuinely clips and drives the
      // bloom pyramid, which is what §8.5 asks of it. It is NOT the physical
      // value, and if RCORE's post chain is verified to clamp its own inputs this
      // can go back up by two orders of magnitude. It is set at the shoulder's
      // own asymptote so this line is a backstop and never the operative limit —
      // a per-channel clamp BELOW the shoulder would reintroduce a hue rotation
      // in exactly the pixels the shoulder just went to the trouble of keeping
      // achromatic.
      #if defined(IRON_WATER_DEBUG)
        // TEMPORARY DIAGNOSTIC — removed before this lane reports.
        outColor = vec4(IRON_WATER_DEBUG_EXPR * (uWaterRadianceScale / 1.88e-4), 1.0);
        return;
      #endif
      outColor = vec4(clamp(color * uWaterRadianceScale, vec3(0.0), vec3(4.5e4)), 1.0);
      // A ShaderMaterial is given three's tonemapping and colour-space
      // DEFINITIONS but not their application. When RCORE's post chain owns
      // tonemapping the renderer is switched to NoToneMapping, TONE_MAPPING goes
      // undefined, and this compiles out — correct in both worlds. Without it the
      // sea and the sky dome beside it land in different colour spaces, which
      // reads as a washed-out horizon nobody can trace.
      #ifdef TONE_MAPPING
        outColor.rgb = toneMapping(outColor.rgb);
      #elif defined(IRON_WATER_SELF_TONEMAP)
        outColor.rgb = ironWaterAgx(outColor.rgb);
      #endif
      outColor = linearToOutputTexel(outColor);

      #if defined(IRON_WATER_MRT)
        vec4 currClip = uWaterViewProjection * vec4(vWorldPos, 1.0);
        vec4 prevClip = uWaterPrevViewProjection * vec4(vPrevWorldPos, 1.0);
        vec2 currNdc = currClip.xy / max(currClip.w, 1e-5);
        vec2 prevNdc = prevClip.xy / max(prevClip.w, 1e-5);
        // UV units per frame, jitter-free (both matrices are the unjittered
        // ones), current minus previous — the exact convention
        // src/render/passes/scene.ts writes for world geometry and that
        // taa.resolve consumes as prevUv = vUv - velocity. NDC spans 2
        // across the screen and UV spans 1, so the halving is not cosmetic:
        // without it every water pixel reprojects twice as far as it moved and
        // the history tears along the wave crests.
        outVelocity = vec4((currNdc - prevNdc) * 0.5, 0.0, 1.0);
      #endif
    }
  `;
}

/**
 * The underwater pass. Runs on the RESOLVED HDR image at `PassOrder.Underwater`,
 * so it is exposed, bloomed and tonemapped with the rest of the frame instead of
 * being painted on after the grade.
 *
 * Three separable things, all of which are just the §8.5 water model applied to
 * a whole frame instead of to one surface: the same Beer-Lambert extinction
 * against scene depth, the same body colour as an additive murk floor, and a
 * refraction wobble that decays with depth because the surface's own relief is
 * what causes it.
 */
export const UNDERWATER_FRAGMENT = /* glsl */ `
  vec2 uv = vUv;
  // Surface-relief distortion, strongest just under the surface.
  float submersion = clamp(-uWaterEyeDepth, 0.0, 6.0);
  float wobble = exp(-submersion * 0.55) * 0.004;
  uv += vec2(sin(uv.y * 34.0 + uWaterUnderTime * 1.7), cos(uv.x * 29.0 - uWaterUnderTime * 1.3)) * wobble;
  uv = clamp(uv, vec2(0.001), vec2(0.999));

  vec3 scene = texture(uWaterUnderColor, uv).rgb;
  // RTId.SceneDepth is an R32F COLOUR target carrying LINEAR VIEW DEPTH IN
  // METRES — not a hardware depth buffer. The near/far NDC reconstruction that
  // used to be here read 60 m as roughly the near plane, so every submerged
  // frame got the same near-zero extinction and the murk never appeared.
  float viewZ = min(texture(uWaterUnderDepth, uv).r, uWaterUnderPlanes.y);
  viewZ = min(viewZ, 90.0);

  // Absorption plus a share of the surface shader's scattering. This is an
  // IMAGE path — we are looking through the water at the scene — so the beam
  // attenuation c = a + b is formally the right rate, but the full c at harbour
  // turbidity puts visibility under three metres and there is no registered
  // underwater shot to verify that against this round. Half of b is the
  // conservative step: murkier than absorption alone, which read as tropical
  // water in a container port, and still readable.
  vec3 kBeam = vec3(0.350, 0.067, 0.065) + 0.5 * vec3(0.52, 0.60, 0.70);
  vec3 trans = exp(-kBeam * uWaterMurk * viewZ);
  // Ambient in-scatter: the murk you cannot see through, which is what makes
  // twenty metres of water read as a volume rather than as a blue filter.
  vec3 murk = uWaterUnderTint * (1.0 - trans);
  outColor = vec4(scene * trans + murk, 1.0);
`;
