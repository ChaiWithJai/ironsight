/**
 * Sky lookup tables, baked once at load. Architecture §4 rows B1, B2 and the
 * cloud volume of bake step 5.
 *
 * OWNER: SKY.
 *
 *   sky.lut.transmittance  RGBA16F 256×64    T(altitude, view zenith) → space
 *   sky.lut.multiScatter   RGBA16F 32×32     Hillaire's ψ_ms(altitude, sun zenith)
 *   sky.lut.skyView        RGBA16F 64×2304   24 sun-elevation slices of a
 *                                            64×96 (azimuth × zenith) sky
 *   sky.noise.cloud        RGBA8   256²      the four cloud octaves
 *
 * Why an ATLAS rather than the architecture's per-frame 192×108 `SkyView`
 * target: `ShotContext.setTimeOfDay` moves the sun between shots, and this lane
 * ships without registering a render pass (see `system.ts` for why), so there is
 * no per-frame opportunity to re-integrate. Baking the sun-elevation axis into
 * the table makes time of day a texture coordinate instead of a re-bake, at a
 * cost of 1.1 MB. It also means the shot camera can move without the sky
 * shimmering, which the per-frame version has to spend TAA on.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeKind,
  MipMode,
  RTFormat,
  type AssetKey,
  type AssetRegistry,
  type QualitySettings,
} from '@/engine/types';
import {
  ATMOSPHERE_GLSL,
  SKYVIEW_ELEV_MAX,
  SKYVIEW_ELEV_MIN,
  SKYVIEW_H,
  SKYVIEW_SLICES,
  SKYVIEW_W,
  SKYVIEW_GLSL,
  TRANSMITTANCE_GLSL,
} from '@/world/sky/glsl';

export interface SkyLuts {
  transmittance: AssetKey<THREE.Texture>;
  multiScatter: AssetKey<THREE.Texture>;
  skyView: AssetKey<THREE.Texture>;
  cloudNoise: AssetKey<THREE.Texture>;
}

let keys: SkyLuts | null = null;

/** The keys declared by `registerSkyBakes`, or null if it never ran. */
export function skyLutKeys(): SkyLuts | null {
  return keys;
}

/* ----------------------------------------------------------- B1 transmittance */

const TRANSMITTANCE_FS = /* glsl */ `
  float r, mu;
  ironTransmittanceParams(vUv, r, mu);
  float ground = ironDistToSphere(r, mu, IRON_RG);
  float top = ironDistToSphere(r, mu, IRON_RT);
  float len = ground > 0.0 ? ground : max(top, 0.0);

  const int STEPS = 40;
  vec3 tau = vec3(0.0);
  float ds = len / float(STEPS);
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + 0.5) * ds;
    float h = max(0.0, ironStepR(r, mu, t) - IRON_RG);
    tau += ironExtinction(h, uMieScale) * ds;
  }
  outColor = vec4(exp(-tau), 1.0);
`;

/* ---------------------------------------------------------- B2 multiscatter */

/**
 * Hillaire 2020's second-order-and-beyond term. For a point at altitude h with
 * the sun at zenith angle μs, integrate over the whole sphere the radiance
 * arriving after exactly one bounce, plus the fraction of energy that leaves the
 * point per unit of incoming energy; the infinite series then sums in closed
 * form as `L₂ / (1 − f_ms)`.
 *
 * Without this the sky is 20–30 % too dark and, worse, too SATURATED — multiple
 * scattering is what desaturates a real sky toward the horizon, and its absence
 * is why hand-rolled Rayleigh domes look like coloured gels.
 */
const MULTISCATTER_PRELUDE = /* glsl */ `
uniform sampler2D uTransmittance;
uniform float uMieScale;

vec3 ironT(float r, float mu) {
  return texture(uTransmittance, ironTransmittanceUv(r, mu)).rgb;
}
`;

const MULTISCATTER_FS = /* glsl */ `
  float muS = clamp(vUv.x * 2.0 - 1.0, -1.0, 1.0);
  float r = IRON_RG + clamp(vUv.y, 0.0, 1.0) * (IRON_RT - IRON_RG);

  const int DIRS = 32;
  const int STEPS = 20;
  vec3 lumTotal = vec3(0.0);
  vec3 fmsTotal = vec3(0.0);

  for (int d = 0; d < DIRS; d++) {
    // Fibonacci sphere: the cheapest low-discrepancy set on S², and 32 of them
    // is enough because the quantity being integrated is nearly isotropic.
    float fi = (float(d) + 0.5) / float(DIRS);
    float mu = 1.0 - 2.0 * fi;
    float sinT = sqrt(max(0.0, 1.0 - mu * mu));
    float phi = 2.39996323 * float(d);
    // The sun sits in the x-y plane at (sqrt(1-muS²), muS, 0); with the view
    // direction at (sinT·cosφ, mu, sinT·sinφ) their dot product is nu.
    float nu = sinT * cos(phi) * sqrt(max(0.0, 1.0 - muS * muS)) + mu * muS;

    float ground = ironDistToSphere(r, mu, IRON_RG);
    float top = ironDistToSphere(r, mu, IRON_RT);
    float len = ground > 0.0 ? ground : max(top, 0.0);
    if (len <= 0.0) continue;
    float ds = len / float(STEPS);

    vec3 throughput = vec3(1.0);
    vec3 lum = vec3(0.0);
    vec3 fms = vec3(0.0);
    for (int i = 0; i < STEPS; i++) {
      float t = (float(i) + 0.5) * ds;
      float sr = ironStepR(r, mu, t);
      float h = max(0.0, sr - IRON_RG);
      float muSun = ironStepMuS(r, muS, nu, t, sr);
      vec3 dens = ironDensity(h, uMieScale);
      vec3 sigmaS = IRON_RAY_S * dens.x + vec3(IRON_MIE_S) * dens.y;
      vec3 sigmaE = ironExtinction(h, uMieScale);
      vec3 stepT = exp(-sigmaE * ds);

      float shadow = ironSunOccluded(sr, muSun) ? 0.0 : 1.0;
      vec3 sunT = ironT(sr, muSun) * shadow;

      // Isotropic phase (1/4π) — this term is by construction direction-free.
      vec3 inScatter = sigmaS * (1.0 / (4.0 * IRON_PI)) * sunT;
      vec3 integral = (inScatter - inScatter * stepT) / max(sigmaE, vec3(1e-9));
      lum += throughput * integral;
      vec3 fIntegral = (sigmaS - sigmaS * stepT) / max(sigmaE, vec3(1e-9));
      fms += throughput * fIntegral;
      throughput *= stepT;
    }
    lumTotal += lum;
    fmsTotal += fms;
  }

  // Uniform sampling of the sphere: (1/4π)∮ … dω ≈ (1/N) Σ. Both integrals
  // carry the same factor, so both are just the mean over the direction set.
  float w = 1.0 / float(DIRS);
  vec3 L2 = lumTotal * w;
  vec3 fms = fmsTotal * w;
  outColor = vec4(L2 / max(vec3(1e-4), 1.0 - fms), 1.0);
`;

/* ------------------------------------------------------------- B3 sky view */

const SKYVIEW_PRELUDE = /* glsl */ `
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform float uMieScale;
uniform float uGroundAlbedo;

vec3 ironT(float r, float mu) {
  return texture(uTransmittance, ironTransmittanceUv(r, mu)).rgb;
}

vec3 ironMs(float r, float muS) {
  float v = clamp((r - IRON_RG) / (IRON_RT - IRON_RG), 0.0, 1.0);
  return texture(uMultiScatter, vec2(muS * 0.5 + 0.5, v)).rgb;
}
`;

/**
 * One texel = one (view azimuth, view zenith, sun elevation) triple. The eye is
 * put at 2 m, which is standing head height; the difference between that and
 * 100 m is invisible in the sky and enormous in the horizon band, so it is worth
 * being specific about.
 *
 * The Rayleigh phase is folded in HERE and the Mie phase is deliberately NOT:
 * `1 + cos²θ` is smooth enough to survive 64 azimuth samples, whereas the Mie
 * aureole is ~8° wide and would be smeared into nothing. The Mie integral is
 * stored channel-averaged in alpha and gets its phase at sample time.
 */
const SKYVIEW_FS = /* glsl */ `
  float sliceH = ${SKYVIEW_H.toFixed(1)};
  float slices = ${SKYVIEW_SLICES.toFixed(1)};
  float py = vUv.y * sliceH * slices;
  float slice = floor(py / sliceH);
  float vy = (py - slice * sliceH) / sliceH;

  float elevDeg = mix(${SKYVIEW_ELEV_MIN.toFixed(1)}, ${SKYVIEW_ELEV_MAX.toFixed(1)},
                      slice / max(1.0, slices - 1.0));
  float elev = radians(elevDeg);
  vec3 sunDir = vec3(cos(elev), sin(elev), 0.0);

  float azimuth = vUv.x * IRON_PI;
  float mu = ironSvVToSinAltitude(vy);
  float cosAlt = sqrt(max(0.0, 1.0 - mu * mu));
  vec3 dir = vec3(cosAlt * cos(azimuth), mu, cosAlt * sin(azimuth));
  float nu = clamp(dot(dir, sunDir), -1.0, 1.0);
  float muS = sin(elev);

  // Eye at 2 m. The difference between that and 100 m is invisible in the sky
  // and enormous in the horizon band, so it is worth being specific about.
  float r0 = IRON_RG + 0.002;
  float ground = ironDistToSphere(r0, mu, IRON_RG);
  float top = ironDistToSphere(r0, mu, IRON_RT);
  bool hitGround = ground > 0.0;
  float len = hitGround ? ground : max(top, 0.0);
  if (len <= 0.0) { outColor = vec4(0.0); return; }

  const int STEPS = 32;
  vec3 rayleigh = vec3(0.0);
  vec3 mie = vec3(0.0);
  vec3 throughput = vec3(1.0);
  float phaseR = ironPhaseR(nu);

  for (int i = 0; i < STEPS; i++) {
    // Quadratic step distribution: dense near the eye where the Mie layer is,
    // sparse out at 100 km where nothing changes.
    float f0 = float(i) / float(STEPS);
    float f1 = float(i + 1) / float(STEPS);
    float d0 = len * f0 * f0;
    float d1 = len * f1 * f1;
    float ds = d1 - d0;
    if (ds <= 0.0) continue;
    float t = d0 + ds * 0.5;
    float sr = ironStepR(r0, mu, t);
    float h = max(0.0, sr - IRON_RG);
    float muSun = ironStepMuS(r0, muS, nu, t, sr);
    vec3 dens = ironDensity(h, uMieScale);
    vec3 sigmaR = IRON_RAY_S * dens.x;
    float sigmaM = IRON_MIE_S * dens.y;
    vec3 sigmaE = ironExtinction(h, uMieScale);
    vec3 stepT = exp(-sigmaE * ds);

    float shadow = ironSunOccluded(sr, muSun) ? 0.0 : 1.0;
    vec3 sunT = ironT(sr, muSun) * shadow;
    vec3 ms = ironMs(sr, muSun);

    // Analytic integral of a constant source over the segment: avoids the
    // banding a midpoint accumulate leaves in the first two steps.
    vec3 srcR = (sigmaR * phaseR * sunT + (sigmaR + vec3(sigmaM)) * ms);
    vec3 intR = (srcR - srcR * stepT) / max(sigmaE, vec3(1e-9));
    rayleigh += throughput * intR;

    vec3 srcM = vec3(sigmaM) * sunT;
    vec3 intM = (srcM - srcM * stepT) / max(sigmaE, vec3(1e-9));
    mie += throughput * intM;

    throughput *= stepT;
  }

  if (hitGround) {
    // The sea and the far coast. Lambertian, so the sun term carries cos.
    float muSun = ironStepMuS(r0, muS, nu, len, IRON_RG);
    vec3 sunT = ironT(IRON_RG, muSun);
    rayleigh += throughput * uGroundAlbedo * max(0.0, muSun) * sunT / IRON_PI;
  }

  outColor = vec4(rayleigh, dot(mie, vec3(0.33333333)));
`;

/* -------------------------------------------------------------- cloud noise */

/**
 * Four decorrelated octave sets in one RGBA tile. `NoiseLib`'s GLSL chunks are
 * already in scope inside a bake body, so the CPU and GPU noise agree by
 * construction — which matters here because the cloud-shadow direction has to
 * be derivable on the CPU later without a readback.
 */
const CLOUD_NOISE_FS = /* glsl */ `
  // Tileable variants throughout: this texture is sampled with REPEAT wrapping
  // over tens of kilometres of sky, and a seam would be a straight line across
  // the whole cloud deck.
  float weather = ironFbm2Tiled(vUv * 3.0, 3, 3, 0.55, 11u) * 0.5 + 0.5;
  float shape = ironFbm2Tiled(vUv * 5.0, 5, 5, 0.52, 173u) * 0.5 + 0.5;
  // ── THE HARD CLAMP WAS A VORONOI-SHAPED CREASE, AND IT PRINTED ─────────────
  // The previous form was \`1 - clamp(F1 * 1.9, 0, 1)\`. F1 is the distance to
  // the nearest feature point, so the set where that clamp engages —
  // F1 = 0.526 — is a CLOSED LOOP around every feature point, and a clamp is a
  // gradient discontinuity. The cloud march reads this channel through
  // \`d -= erode * 0.46 * (1 - smoothstep(...))\`, which amplifies a gradient
  // discontinuity into a visible line, so once round 3's march stopped
  // scrambling the field with per-pixel schedule noise the deck came back with
  // a network of thin bright closed loops running through every cloud body —
  // a few units high, unmistakable at 1:1, and shaped exactly like a Voronoi
  // diagram. (Round 2 saw the same defect one layer up and treated it by
  // halving the channel's weight; that reduced the amplitude without removing
  // the crease.)
  //
  // A Hermite ramp has zero derivative at BOTH ends, so there is no crease left
  // to amplify. The knee is unchanged at 0.526, so the cauliflower keeps the
  // silhouette scale it was tuned for.
  float wd = clamp(ironWorley2Tiled(vUv * 9.0, 9, 311u) * 1.9, 0.0, 1.0);
  float worley = 1.0 - wd * wd * (3.0 - 2.0 * wd);
  float wisp = ironFbm2Tiled(vUv * 13.0, 13, 4, 0.5, 523u) * 0.5 + 0.5;
  // ── THE CONTRAST STRETCH IS A SIGMOID, NOT A CLAMPED LINE, AND THAT IS THE
  //    WHOLE OF ROUND 3'S LAST CLOUD ARTEFACT ──────────────────────────────
  //
  // Contrast the weather field so coverage is a threshold on real structure
  // rather than on a mush centred at 0.5. The gain is unchanged at 1.7.
  //
  // What changed is the saturation. "clamp((w-0.5)*1.7+0.5, 0, 1)" reaches its
  // upper knee at w = 0.794, and the coverage threshold that reads this channel
  // is "smoothstep(1-1.5c, 1-0.42c, w)" — at GOLDEN's c = 0.30 that is
  // smoothstep(0.55, 0.874, ·). The knee therefore lands INSIDE the ramp, at the
  // point where the ramp's slope is near its maximum, and a clamp is a gradient
  // discontinuity. An fBm's level sets are closed loops, so the deck came out
  // with a network of thin bright closed contours running through every cloud
  // body, a couple of dozen levels high and unmistakable at 1:1. Three separate
  // suspects in the march were eliminated before the arithmetic pointed here:
  // the artefact is invariant under step count, under the integration schedule
  // and under the erosion octave, because it is baked into the texture.
  //
  // The algebraic sigmoid e/sqrt(a²+e²) has the same slope at the centre — a is
  // set to 0.5 so f'(0) = 1 and the 1.7 gain carries through unchanged — and it
  // is C∞ everywhere, with no knee to differentiate. It also never reaches 0 or
  // 1, so the RGBA8 store cannot reintroduce a clamp of its own.
  float we = (weather - 0.5) * 1.7;
  weather = 0.5 + 0.5 * we / sqrt(0.25 + we * we);
  outColor = vec4(weather, shape, worley, wisp);
`;

/* ------------------------------------------------------------------ declare */

export function declareSkyBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): SkyLuts {
  // Turbidity 3.2 is LOOK_SPEC §3.1's aerosol loading for GOLDEN; the reference
  // Mie coefficient above is a turbidity-2.0 clear atmosphere, so the tables are
  // baked 1.6× loaded and the runtime turbidity trims the aureole around that.
  const mieScale = 1.6;

  const transmittance = assets.define<THREE.Texture>('sky.lut.transmittance', AssetKind.Lut, {
    kind: BakeKind.GpuTexture,
    version: 1,
    cost: 4,
    run: (ctx) =>
      ctx.gpu.render({
        name: 'sky.lut.transmittance',
        width: 256,
        height: 64,
        format: RTFormat.RGBA16F,
        wrap: 'clamp',
        filter: 'linear',
        mips: MipMode.None,
        prelude: `${ATMOSPHERE_GLSL}\n${TRANSMITTANCE_GLSL}\nuniform float uMieScale;`,
        fragment: TRANSMITTANCE_FS,
        uniforms: { uMieScale: { value: mieScale } },
      }),
  });

  const multiScatter = assets.define<THREE.Texture>('sky.lut.multiScatter', AssetKind.Lut, {
    kind: BakeKind.GpuTexture,
    version: 1,
    cost: 8,
    dependsOn: [transmittance],
    run: (ctx) =>
      ctx.gpu.render({
        name: 'sky.lut.multiScatter',
        width: 32,
        height: 32,
        format: RTFormat.RGBA16F,
        wrap: 'clamp',
        filter: 'linear',
        mips: MipMode.None,
        prelude: `${ATMOSPHERE_GLSL}\n${TRANSMITTANCE_GLSL}\n${MULTISCATTER_PRELUDE}`,
        fragment: MULTISCATTER_FS,
        uniforms: {
          uTransmittance: { value: ctx.require(transmittance) },
          uMieScale: { value: mieScale },
        },
      }),
  });

  const skyView = assets.define<THREE.Texture>('sky.lut.skyView', AssetKind.Lut, {
    kind: BakeKind.GpuTexture,
    version: 1,
    cost: 22,
    dependsOn: [transmittance, multiScatter],
    run: (ctx) =>
      ctx.gpu.render({
        name: 'sky.lut.skyView',
        width: SKYVIEW_W,
        height: SKYVIEW_H * SKYVIEW_SLICES,
        format: RTFormat.RGBA16F,
        wrap: 'clamp',
        // Sampled with texelFetch, so the hardware filter never runs; NEAREST
        // also means the atlas cannot bleed one sun elevation into the next.
        filter: 'nearest',
        mips: MipMode.None,
        prelude: `${ATMOSPHERE_GLSL}\n${TRANSMITTANCE_GLSL}\n${SKYVIEW_GLSL}\n${SKYVIEW_PRELUDE}`,
        fragment: SKYVIEW_FS,
        uniforms: {
          uTransmittance: { value: ctx.require(transmittance) },
          uMultiScatter: { value: ctx.require(multiScatter) },
          uMieScale: { value: mieScale },
          // Mediterranean water plus pale limestone coast, averaged.
          uGroundAlbedo: { value: 0.12 },
        },
      }),
  });

  const cloudNoise = assets.define<THREE.Texture>('sky.noise.cloud', AssetKind.Texture, {
    kind: BakeKind.GpuTexture,
    // 4: RGBA8 -> RGBA16F, Worley clamp -> Hermite ramp, weather contrast clamp
    // -> algebraic sigmoid. All three printed contours into the deck.
    version: 4,
    cost: 6,
    run: (ctx) => {
      // 512 requested rather than 256. The weather channel is read over an
      // 8.7 km tile, so 256² is 34 m per texel — 6–10 screen pixels at the
      // distance the deck is actually drawn at, which is magnification, not
      // minification. `ironCloudFetch` removes the reconstruction artefact that
      // causes; halving the texel size removes half of what it has to fix.
      const size = Math.max(256, Math.min(512, ctx.grantedTexelSize(512)));
      return ctx.gpu.render({
        name: 'sky.noise.cloud',
        width: size,
        height: size,
        // ── HALF-FLOAT, AND THE REASON IS AN AMPLIFICATION FACTOR OF FIFTY ────
        // The weather channel is read through
        // `smoothstep(1 - 1.5c, 1 - 0.42c, w)`, whose slope at GOLDEN's
        // c = 0.30 is 4.6 per unit, and the density that comes out of it is
        // then integrated along a ray to an optical depth of ~5. One RGBA8 LSB
        // is 1/255 of the channel, so it moves cov by 1.8 % of full scale and
        // the ray's total τ by ~0.2 — an 18 % swing in transmittance through
        // any semi-transparent part of the deck. The level sets of an fBm are
        // closed loops, so that quantisation staircase printed as a network of
        // thin bright closed contours running through every cloud body, a
        // couple of dozen levels high at 1:1, and INVARIANT under every change
        // to the march: step count, schedule, budget accounting and erosion
        // octave were each eliminated in turn before the arithmetic pointed
        // here. 16F carries ~11 bits of mantissa over this range, which puts
        // the same staircase four hundred times below the noise floor.
        //
        // The cost is 2 MB at 512² instead of 1 MB, on a texture that is baked
        // once and read with one fetch per march sample.
        format: RTFormat.RGBA16F,
        wrap: 'repeat',
        filter: 'linear',
        mips: MipMode.None,
        fragment: CLOUD_NOISE_FS,
        uniforms: { uSeed: { value: 7.0 } },
      });
    },
  });

  void quality;
  keys = { transmittance, multiScatter, skyView, cloudNoise };
  return keys;
}
