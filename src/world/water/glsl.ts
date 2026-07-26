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
import { RIPPLE_COUNT, DISPLACING_COUNT, WAVE_COUNT } from '@/world/water/spectrum';
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
    out vec3 vWaveNormal;
    out vec2 vBaseXZ;
    out float vJacobian;
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

      vec3 normal3;
      float jac;
      vec3 disp = ironWaterDisplace(base, uWaterTime, shoal, normal3, jac);
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
      vWaveNormal = normal3;
      vBaseXZ = base;
      vJacobian = jac;
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
    in vec3 vWaveNormal;
    in vec2 vBaseXZ;
    in float vJacobian;
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
    vec3 ironWaterSkyRadiance(vec3 dir) {
      float up = clamp(dir.y, -1.0, 1.0);
      vec2 flatDir = normalize(vec2(dir.x, dir.z) + vec2(1e-5));
      vec2 flatSun = normalize(vec2(uWaterSunDir.x, uWaterSunDir.z) + vec2(1e-5));
      float azAlign = dot(flatDir, flatSun);
      float cosSun = dot(dir, uWaterSunDir);

      // Horizon weight. 2.6 gives the measured "horizon is ~2x the sky 30 deg up".
      float h = pow(1.0 - clamp(abs(up), 0.0, 1.0), 2.6);
      float lum = mix(2200.0, 3300.0, h);
      // Mie forward scattering: the sun-side horizon reaches 9000 cd/m2, and the
      // broad lobe around the disc is what makes golden hour read as golden hour.
      float azWarm = pow(max(azAlign, 0.0), 3.0);
      lum += h * azWarm * 5700.0;
      // The solar aureole. Exponent 16 puts the half-value radius at ~20°, which
      // is what a turbidity-3.2 atmosphere actually produces; at exponent 7 the
      // lobe is 40° wide, and since a grazing sea reflects nothing BUT the region
      // around the sun, that error alone lifted the whole frame by a stop.
      lum += pow(max(cosSun, 0.0), 16.0) * 9000.0;
      lum += pow(max(cosSun, 0.0), 1.6) * 900.0;

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

      vec3 inscatter = ironWaterSkyRadiance(dir);
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
      // Cutoffs 0.35, 0.8, 1.8, 4, 9, 20, 45, 140 m — log-spaced, so the index
      // is linear in log lambda.
      float t = clamp((log2(max(lambda, 0.35) / 0.35)) / log2(140.0 / 0.35) * 7.0, 0.0, 7.0);
      int i = int(floor(t));
      int j = min(i + 1, 7);
      return mix(lut[i], lut[j], fract(t));
    }

    /**
     * The ripple band, evaluated per fragment as a normal perturbation.
     *
     * These are the waves the sun glitter is actually made of. Each component is
     * faded out by its own visibility against the pixel footprint, and what fades
     * out is handed to the roughness term instead of being dropped — that hand-off
     * is the entire difference between a glitter path and a field of aliasing
     * white dots, and no amount of TAA substitutes for it.
     */
    vec2 ironWaterRippleSlope(vec2 p, float t, float cutoff, float shoal) {
      vec2 slope = vec2(0.0);
      for (int i = ${DISPLACING_COUNT}; i < ${WAVE_COUNT}; i++) {
        vec4 wa = uWaterWaveA[i];
        float lambda = 6.2831853 / wa.z;
        float visible = smoothstep(cutoff * 0.55, cutoff * 1.9, lambda);
        if (visible <= 0.001) continue;
        float f = wa.z * dot(wa.xy, p) - wa.w * t + uWaterWaveB[i].z;
        slope += wa.xy * (uWaterWaveB[i].x * shoal * wa.z * cos(f)) * visible;
      }
      return slope;
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

    float ironWaterFoamNoise(vec2 p, float t) {
      // Two octaves drifting at different rates: foam is not a texture, it is a
      // pattern being pulled apart by the surface it sits on.
      vec2 drift = uWaterWaveA[0].xy * t;
      float a = ironWaterValueNoise(p * 0.55 - drift * 0.30);
      float b = ironWaterValueNoise(p * 1.85 + drift.yx * 0.18);
      float c = ironWaterValueNoise(p * 5.10 - drift * 0.09);
      return a * 0.50 + b * 0.33 + c * 0.17;
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

      // Pixel footprint on the surface. cos(incidence) in the denominator is what
      // makes the far water — seen at a few degrees — filter hundreds of times
      // harder than the water under the camera.
      float cosI = max(abs(dot(V, vec3(0.0, 1.0, 0.0))), 0.02);
      // Two filters, and the larger wins: the pixel's own footprint, and the
      // tessellation, because a ring 2 km out is 140 m across and the swell it
      // carries is no more resolved by the mesh than the ripples are by the pixel.
      float footprint = max(viewDist * uWaterPixelAngle / cosI, vRingRadius * 0.075);
      footprint = clamp(footprint, 0.02, 600.0);

      float shoal = ironWaterShoal(vStillDepth);
      vec2 slope = ironWaterRippleSlope(vBaseXZ, uWaterTime, footprint, min(shoal, 1.35));
      vec3 N = normalize(vWaveNormal + vec3(-slope.x, 0.0, -slope.y));
      // A displaced surface seen at grazing angles produces normals that face
      // away from the eye; letting them through gives black speckle on the far
      // water. Bend, do not clamp.
      float facing = dot(N, V);
      if (facing < 0.02) N = normalize(N + V * (0.02 - facing) * 1.4);

      /* --- microfacet roughness from what the pixel could not resolve ------ */
      // GGX alpha ~ 2 x mean-square slope. The base term is the sub-millimetre
      // capillary roughness that never resolves at any distance: LOOK_SPEC §8.5
      // puts real water at 0.02-0.06.
      float unresolved = ironWaterVariance(footprint * 1.6);
      float alpha = 0.0016 + 2.0 * unresolved;
      alpha = clamp(alpha, 0.0016, 0.28);

      /* ------------------------------------------------------- fresnel ---- */
      // n = 1.333 -> F0 = 0.0201. The grazing term is the whole reason water
      // reads as water: at 3 degrees off the surface it is a mirror.
      float NdotV = clamp(dot(N, V), 0.0, 1.0);
      float f90 = 1.0;
      float fresnel = 0.0201 + (f90 - 0.0201) * pow(max(1.0 - NdotV, 0.0), 5.0);

      /* ---------------------------------------------------- reflection ---- */
      vec3 R = reflect(-V, N);
      vec3 reflected = ironWaterSkyRadiance(normalize(R));

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
        float ssrLuma = dot(ssr.rgb, vec3(0.2126, 0.7152, 0.0722));
        float ssrWeight = ssr.a * step(1.0, ssrLuma) * smoothstep(0.30, 0.06, alpha);
        reflected = mix(reflected, ssr.rgb, clamp(ssrWeight, 0.0, 1.0));
      #elif defined(IRON_WATER_REFRACTION)
        // Our own march. Deliberately short and deliberately given up on early:
        // a grazing ray over water leaves the screen within a few steps and the
        // honest answer at that point is the sky probe, not a smeared edge texel.
        // DEGRADE AT GRAZING ANGLES RATHER THAN SMEAR. A reflection ray that runs
        // nearly parallel to the sea does two bad things: it leaves the screen in
        // a few steps, and it intersects the WATER'S OWN depth (the prepass draws
        // the water for depth), which returns the scene copy from before the water
        // was drawn — i.e. the sky, sampled at the wrong place. Below R.y 0.30 the
        // sky probe is simply the better answer, and this is where the fade lives.
        float rayRise = smoothstep(0.10, 0.30, R.y);
        vec4 rClip = uWaterViewProjection * vec4(vWorldPos + R * 0.35, 1.0);
        vec4 rEnd = uWaterViewProjection * vec4(vWorldPos + R * 55.0, 1.0);
        if (rayRise > 0.01 && rClip.w > 0.0 && rEnd.w > 0.0) {
          vec2 uv0 = (rClip.xy / rClip.w) * 0.5 + 0.5;
          vec2 uv1 = (rEnd.xy / rEnd.w) * 0.5 + 0.5;
          float z0 = rClip.w;
          float z1 = rEnd.w;
          float hit = 0.0;
          vec2 hitUv = uv0;
          for (int s = 1; s <= 20; s++) {
            float k = float(s) / 20.0;
            k = k * k;
            vec2 uv = mix(uv0, uv1, k);
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
            float rayZ = mix(z0, z1, k);
            // RTId.SceneDepth is an R32F COLOUR target already carrying LINEAR
            // VIEW DEPTH IN METRES (the contract is stated at the top of
            // src/render/fullscreen.ts, and VFX reads it the same way). It is
            // NOT a hardware depth buffer, so putting it through the usual
            // near/far NDC reconstruction turns 60 m into about -0.002 and every
            // comparison below silently stops meaning anything.
            float sceneZ = min(texture(uWaterSceneDepth, uv).r, uWaterDepthPlanes.y);
            float diff = rayZ - sceneZ;
            if (diff > 0.05 && diff < 2.5 + rayZ * 0.05) {
              hit = 1.0;
              hitUv = uv;
              break;
            }
          }
          // Fade the hit out at the screen edge, or the reflection acquires a
          // hard frame around it that reads worse than having no SSR at all.
          vec2 edge = min(hitUv, 1.0 - hitUv);
          float border = smoothstep(0.0, 0.09, min(edge.x, edge.y));
          vec3 hitColor = texture(uWaterSceneColor, hitUv).rgb;
          // Same rule as the refraction sample: a black hit is a pixel nothing was
          // drawn into, and trusting it punches a hole in the sea.
          float hitLuma = dot(hitColor, vec3(0.2126, 0.7152, 0.0722));
          float conf = hit * border * rayRise * step(1.0, hitLuma)
                     * smoothstep(0.30, 0.06, alpha);
          reflected = mix(reflected, hitColor, conf);
        }
      #endif

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
      // Sun angular radius 0.265 deg = 4.65e-3 rad.
      float alphaSun = clamp(alpha + 4.65e-3, 0.0016, 0.5);
      float a2 = alphaSun * alphaSun;
      float d0 = NdotH * NdotH * (a2 - 1.0) + 1.0;
      float D = a2 / (IRON_PI * d0 * d0);
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

      // Coastal-water extinction, per metre. Red is gone in a couple of metres,
      // blue survives twenty, and the whole turquoise-to-navy ramp of a harbour
      // is that one fact.
      vec3 sigma = vec3(0.42, 0.078, 0.048);
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
      float pathDown = depth / max(refrCos, 0.18);
      float pathUp = depth / sunRefrCos;
      vec3 seabedTrans = exp(-sigma * (pathDown + pathUp));

      // Seabed albedo. Sampled from the SAME sand the terrain lane is using, via
      // the material factory's public texture set, so the sand under 20 cm of
      // water and the sand 20 cm inshore of it are the same colour.
      vec3 sand = texture(uWaterSandAlbedo, vWorldPos.xz / max(uWaterSandTiling, 0.5)).rgb;
      float rockMask = smoothstep(0.35, 1.1, bed.y);
      vec3 seabedAlbedo = mix(sand, sand * vec3(0.52, 0.55, 0.58), rockMask);
      // Wetted grains are darker: the §4.5 mask, applied where the water is thin
      // enough that this is the beach rather than the seabed.
      seabedAlbedo *= mix(1.0, 0.62, smoothstep(0.55, 0.02, depth));
      seabedAlbedo = clamp(seabedAlbedo, vec3(0.035), vec3(0.82));

      vec3 seabedRadiance = seabedAlbedo / IRON_PI * downwelling * seabedTrans;

      // The water body itself. Backscatter out of the medium, saturating with
      // depth — LOOK_SPEC §4.3 puts the diffuse component of sea water at
      // 0.02-0.06 with a hue of 185-195 deg, which is what this is.
      vec3 bodyAlbedo = vec3(0.011, 0.047, 0.055);
      vec3 body = bodyAlbedo / IRON_PI * downwelling * (1.0 - exp(-sigma * (pathDown * 2.0)));

      vec3 transmitted = seabedRadiance + body;

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
        vec3 behindTrans = exp(-sigma * behindDepth * 1.6);
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
        float behindLuma = dot(behind, vec3(0.2126, 0.7152, 0.0722));
        float realGeometry = step(0.4, behindDepth)
                           * step(behindDepth, min(pathDown * 0.95, 12.0))
                           * step(1.0, behindLuma);
        transmitted = mix(transmitted, behind * behindTrans + body,
                          realGeometry * 0.8 * smoothstep(0.6, 1.4, depth));
      #endif

      /* ----------------------------------------------------------- foam ---- */
      // Four sources, all of them masks that cost a few smoothsteps. The drifting
      // noise that breaks them up costs twelve hashes, so it is evaluated only
      // where at least one mask is live — which over open water is nowhere.

      // 1. Whitecaps, from the Jacobian. Where the surface folds, it aerates —
      //    and only there. The steepness budget puts J at ~0.22 on the very
      //    steepest crest, so a threshold anywhere near 0.6 paints half the sea
      //    white in flat grey lenses. §8.1's rule that VFX are sparse applies to
      //    foam as much as to tracers.
      float crest = smoothstep(0.36, 0.14, vJacobian);

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

      float foam = 0.0;
      if (max(max(crest, surfBand), max(swashBand, obstacleBand)) > 0.002) {
        float noise = ironWaterFoamNoise(vWorldPos.xz, uWaterTime);
        float surfPhase = 0.5 + 0.5 * sin(uWaterWaveA[0].z * dot(uWaterWaveA[0].xy, vBaseXZ) * 0.35
                                          - uWaterWaveA[0].w * uWaterTime);
        float whitecap = crest * smoothstep(0.46, 0.84, noise);
        float surf = surfBand * smoothstep(0.30, 0.78, noise * 0.72 + 0.28 * surfPhase);
        float swashFoam = swashBand * (0.55 + 0.45 * noise);
        float obstacle = obstacleBand * smoothstep(0.42, 0.80, noise);
        foam = clamp(max(max(whitecap, surf), max(swashFoam, obstacle)), 0.0, 1.0);
      }
      // Foam is not a decal: it thins out with distance because the individual
      // bubbles stop resolving, exactly like every other micro-scale feature.
      foam *= smoothstep(900.0, 260.0, viewDist) * 0.85 + 0.15;

      /* -------------------------------------------------------- assemble --- */
      vec3 water = transmitted * (1.0 - fresnel) + reflected * fresnel + sunSpec;

      // Foam is a dense Lambertian scatterer sitting ON the surface: it takes the
      // sun and the sky directly and it OCCLUDES what is under it. Albedo 0.72,
      // under §4.3's 0.82 ceiling — sea foam is never white paint.
      vec3 foamNormal = normalize(vec3(0.0, 1.0, 0.0) * 0.62 + N * 0.38);
      vec3 foamRadiance = vec3(0.72) / IRON_PI *
                          (uWaterSunIlluminance * max(dot(foamNormal, L), 0.0)
                           + vec3(uWaterSkyIlluminance) * 1.05);
      vec3 color = mix(water, foamRadiance, foam);

      color = ironWaterAerial(color, vWorldPos, eye);

      // NaN GUARD. One NaN anywhere upstream — a pow() with a negative base, a
      // normalize() of a zero vector, an Inf that met a zero — arrives here as a
      // black hole in the sea and is invisible in every intermediate value. It
      // costs three compares to refuse to ship it.
      bvec3 bad = notEqual(color, color);
      color = mix(color, reflected * fresnel, vec3(bad));

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
      // 2.5e4 cd/m² is 4.7 in scene-linear at LOOK_SPEC §2.1's exposure — display
      // ~240 before bloom, so the glitter path still clips and still drives the
      // bloom pyramid, which is what §8.5 asks of it. It is NOT the physical
      // value, and if RCORE's post chain is verified to clamp its own inputs this
      // can go back up by two orders of magnitude.
      outColor = vec4(clamp(color * uWaterRadianceScale, vec3(0.0), vec3(2.5e4)), 1.0);
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
  float d = texture(uWaterUnderDepth, uv).r;
  float viewZ = uWaterUnderPlanes.x * uWaterUnderPlanes.y /
                (uWaterUnderPlanes.y - d * (uWaterUnderPlanes.y - uWaterUnderPlanes.x));
  viewZ = min(viewZ, 90.0);

  vec3 sigma = vec3(0.42, 0.078, 0.048) * uWaterMurk;
  vec3 trans = exp(-sigma * viewZ);
  // Ambient in-scatter: the murk you cannot see through, which is what makes
  // twenty metres of water read as a volume rather than as a blue filter.
  vec3 murk = uWaterUnderTint * (1.0 - trans);
  outColor = vec4(scene * trans + murk, 1.0);
`;
