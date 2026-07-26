/**
 * VFX — the shared GLSL library.
 *
 * OWNER: VFX. Every shader this lane ships is assembled from the chunks below
 * and handed to `MaterialFactory.createUnlit`, which is the only sanctioned way
 * to author a raw shader outside `src/render/`.
 *
 * WHY THESE ARE UNLIT AND NOT UBER-MATERIAL SURFACES
 * --------------------------------------------------
 * A participating-medium billboard is not a surface. It has no BRDF, no
 * geometric normal worth the name and no shadow-receiving footprint; what it
 * has is an optical depth, a phase function and a self-shadowing term. Feeding
 * it through a Cook-Torrance lobe produces the flat, plastic, uniformly-bright
 * puff that LOOK_SPEC §8 calls an automatic fail. So the scattering model lives
 * here, in full, and takes its inputs (sun vector, sun irradiance, two-lobe sky
 * irradiance, the nearest emitters) from `LightingService` and `SkyService`
 * through the uniform block in `globals.ts`.
 *
 * THE FOUR PROPERTIES THAT DO THE WORK, in order of how much they matter:
 *  1. `vfxScatter` — a real two-lobe sky term plus a Henyey-Greenstein sun term
 *     plus every nearby emitter, so smoke lit from behind glows and smoke in
 *     shade goes sky-blue-grey. LOOK_SPEC §3.3.
 *  2. `vfxAerial` — `surface·exp(-σd) + inscatter·(1-exp(-σd))` with a
 *     height-layered marine slab and a per-channel σ ratio of 1 : 1.25 : 1.5,
 *     never a lerp toward a constant fog colour. LOOK_SPEC §3.2.
 *  3. `vfxErode` — dissipation as an eroding noise THRESHOLD, so a body breaks
 *     up into filaments as it dies instead of fading uniformly. AAA_RUBRIC ax.6.
 *  4. `vfxSoftFade` — depth fade against `RTId.SceneDepth` when the graph has
 *     one. A hard-edged card intersecting the ground is the classic tell.
 *
 * All of it is written against GLSL3. `toneMapping()` only exists when three
 * decided to inject it (renderer tonemapping on AND `toneMapped: true`), so
 * every call site is guarded by `#ifdef TONE_MAPPING`; `linearToOutputTexel` is
 * unconditional for a non-raw ShaderMaterial and is an identity into a linear
 * HDR target, which is what makes these shaders correct both today (tonemapping
 * on the renderer) and after RCORE's `post.tonemap` pass takes it over.
 */

/** Declarations shared by every VFX program. Mirrors `VfxGlobals` exactly. */
export const VFX_GLOBALS = /* glsl */ `
uniform float uVfxTime;
/** Unit vector pointing FROM the medium TOWARD the sun. */
uniform vec3  uVfxSunDir;
/** Sun colour × irradiance, in the renderer's working units (see globals.ts). */
uniform vec3  uVfxSunIrradiance;
/** Two-lobe sky irradiance: upper hemisphere, and the ground-bounce lobe. */
uniform vec3  uVfxSkyUp;
uniform vec3  uVfxSkyDown;
/** In-scatter colour toward / away from the sun azimuth. */
uniform vec3  uVfxHazeSun;
uniform vec3  uVfxHazeAway;
/** x = distance scale D0, y = exponent, z = marine scale height, w = strength. */
uniform vec4  uVfxFog;
/** Camera basis, world space. Billboards are built from these, not from a matrix. */
uniform vec3  uVfxCamRight;
uniform vec3  uVfxCamUp;
uniform vec3  uVfxCamFwd;
uniform vec3  uVfxCamPos;
/** xyz = position, w = radius. Four brightest emitters near the camera. */
uniform vec4  uVfxEmitterPos[4];
/** rgb = colour × luminous intensity (cd), a = SOURCE radius in metres. */
uniform vec4  uVfxEmitterCol[4];
uniform sampler2D uVfxSceneDepth;
/** x = near, y = far, z = soft-fade metres, w = 1 when the depth texture is real. */
uniform vec4  uVfxDepthParams;
uniform vec2  uVfxResolution;
/**
 * The scene luminance that tonemaps to mid grey, i.e. 0.18 / exposureScale, in
 * whatever units the renderer is working in. EVERY emissive strength in this
 * lane is expressed in MULTIPLES OF MID GREY and multiplied by this, so a
 * fireball core at 12 lands at display ~220 and a flash core at 46 clips —
 * exactly the LOOK_SPEC §5.1 ramp — no matter what exposure the frame is at.
 */
uniform float uVfxEmissiveScale;

const float VFX_PI = 3.14159265359;
`;

/**
 * Value noise + curl. Deliberately the cheapest thing that still reads as
 * turbulence: the capture harness runs on a software rasteriser, and a
 * three-octave gradient-noise fragment shader over a screen-filling smoke body
 * turns a 40 s shot into a 400 s one. Two octaves, evaluated in a rotating
 * per-particle frame, is enough to break every silhouette.
 */
export const VFX_NOISE = /* glsl */ `
float vfxHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vfxNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = vfxHash(i + vec3(0.0, 0.0, 0.0));
  float n100 = vfxHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = vfxHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = vfxHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = vfxHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = vfxHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = vfxHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = vfxHash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float vfxFbm2(vec3 p) {
  // Non-harmonic ratio (LOOK_SPEC §4.1): 2.37, not 2.0, so the two octaves
  // never phase-lock into a visible lattice.
  return vfxNoise(p) * 0.64 + vfxNoise(p * 2.37 + 11.3) * 0.36;
}

vec3 vfxNoise3(vec3 p) {
  return vec3(vfxNoise(p), vfxNoise(p + 37.13), vfxNoise(p - 19.71));
}

/**
 * Curl of a noise potential — a DIVERGENCE-FREE field, which is why smoke
 * advected by it folds and shears instead of expanding radially like an
 * explosion of confetti. Four samples, forward differences: the asymmetry is
 * invisible at these amplitudes and halves the cost of a central difference.
 */
vec3 vfxCurl(vec3 p) {
  const float e = 0.42;
  vec3 n0 = vfxNoise3(p);
  vec3 nx = vfxNoise3(p + vec3(e, 0.0, 0.0));
  vec3 ny = vfxNoise3(p + vec3(0.0, e, 0.0));
  vec3 nz = vfxNoise3(p + vec3(0.0, 0.0, e));
  return vec3(
    (ny.z - n0.z) - (nz.y - n0.y),
    (nz.x - n0.x) - (nx.z - n0.z),
    (nx.y - n0.y) - (ny.x - n0.x)) / e;
}
`;

/**
 * Scattering, aerial perspective and the soft-particle fade. The three
 * functions that decide whether a particle reads as a lit volume or as a decal.
 */
export const VFX_SHADING = /* glsl */ `
/**
 * Henyey-Greenstein, normalised so isotropic scattering returns 1.0. g = 0.6
 * for dust and 0.72 for the marine haze (LOOK_SPEC §3.2, §3.3): a low sun
 * behind a smoke column must make it GLOW, and a symmetric phase function
 * cannot do that.
 */
float vfxHG(float cosT, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosT;
  return (1.0 - g2) / max(d * sqrt(d), 1e-4);
}

/**
 * Single-scatter radiance leaving a medium element whose outward normal is 'n'.
 *
 *  - 'selfShadow' in 0..1 is how deep this element sits inside its own body.
 *    LOOK_SPEC §8.4 measures the shaded side of grenade smoke at ≈ 2.5× darker
 *    than the lit side, which is the range the mix below covers.
 *  - the sky term is TWO LOBES crossfaded by n.y, never a constant. Without it
 *    the top and bottom of a plume read identically and the body goes flat.
 *  - every nearby emitter is added with real inverse-square falloff, because a
 *    puff that does not pick up the fire next to it reads as a sticker.
 */
vec3 vfxScatter(vec3 worldPos, vec3 n, vec3 viewDir, float selfShadow, float g, vec3 albedo, float selfEmissive) {
  float cosT = dot(viewDir, -uVfxSunDir);
  // CLAMPED. A normalised HG lobe at g = 0.72 peaks at 21× isotropic, which is
  // correct for single scattering and wrong for anything you can see: a real
  // optically-thick medium multiple-scatters and flattens the lobe hard. The
  // clamp keeps the directional glow toward the sun — the property that makes
  // backlit smoke read — without turning the sun side into a white hole.
  float phase = clamp(vfxHG(cosT, g), 0.45, 1.65);
  float ndl = dot(n, uVfxSunDir);
  // Wrapped diffuse: light bleeds around a translucent body, so the terminator
  // sits well past 90° rather than on it.
  float wrap = clamp((ndl + 0.62) / 1.62, 0.0, 1.0);
  float lit = mix(0.30, 1.0, wrap) * mix(0.34, 1.0, selfShadow);
  vec3 sun = uVfxSunIrradiance * lit * phase;
  vec3 sky = mix(uVfxSkyDown, uVfxSkyUp, n.y * 0.5 + 0.5) * mix(0.62, 1.0, selfShadow);
  vec3 local = vec3(0.0);
  // A SELF-EMISSIVE element is not lit by the emitter it IS. A fireball lobe
  // sits ~2 m from a 2.5e6 cd source, which delivers 600 000 lx and blows the
  // lobe — and every dark soot filament in it — to flat white. That is the
  // difference between the saturated orange body of a real fireball and the
  // white blob this shader produced before the guard.
  if (selfEmissive < 0.5) {
    for (int i = 0; i < 4; i++) {
      float radius = uVfxEmitterPos[i].w;
      if (radius <= 0.0) continue;
      vec3 d = uVfxEmitterPos[i].xyz - worldPos;
      float r2 = dot(d, d);
      // Physical inverse square, clamped at the emitter's own SOURCE radius —
      // never a linear falloff, and never 1/r² inside the body of the source,
      // which is a singularity rather than a light.
      float src = uVfxEmitterCol[i].a;
      float atten = 1.0 / max(r2, max(src * src, 0.25));
      atten *= clamp(1.0 - r2 / (radius * radius), 0.0, 1.0);
      float lp = vfxHG(dot(viewDir, -normalize(d + 1e-4)), g * 0.6);
      local += uVfxEmitterCol[i].rgb * atten * lp * mix(0.45, 1.0, selfShadow);
    }
  }
  // 1/π, the SURFACE normalisation, and that is deliberate rather than sloppy.
  // Single scattering in a volume element would be E·albedo/(4π)·phase, but
  // 'alpha' on these billboards already carries the element's optical depth,
  // and a dust puff or a smoke lobe is optically THICK — multiply-scattered,
  // saturated, and radiometrically much closer to a diffuse surface than to a
  // thin slab. At 1/(4π) a sunlit dust puff comes out four times darker than
  // the wall behind it, which is the opposite of what every reference frame
  // shows: sunlit dust is among the BRIGHTEST things in the image.
  return (sun + sky + local) * albedo * (1.0 / VFX_PI);
}

/**
 * Aerial perspective, LOOK_SPEC §3.2, as an actual transmittance integral.
 *
 * 'surface·exp(-τ) + inscatter·(1-exp(-τ))', NOT 'mix(colour, fogColour, d)'.
 * The distinction is the whole point: the in-scatter is an additive term that
 * carries the sky's own directional colour, so saturation RISES with distance
 * through the near-mid range and haze in the sun azimuth outshines the sky.
 *
 * τ is fitted to the blend-fraction table in §3.2 (0.16 at 15 m, 0.33 at 60 m,
 * 0.79 at 400 m, 0.96 at 1.4 km) rather than to the σ constants beside it —
 * the table is the measured target and a single-σ exponential cannot hit all
 * four points. The marine slab modulates it by height with a 22 m scale.
 */
vec3 vfxAerial(vec3 color, vec3 worldPos) {
  vec3 d = worldPos - uVfxCamPos;
  float dist = length(d);
  if (dist < 0.01) return color;
  vec3 dir = d / dist;
  float midY = max(0.0, (uVfxCamPos.y + worldPos.y) * 0.5);
  float heightFalloff = exp(-midY / max(uVfxFog.z, 1.0));
  float tau = pow(dist / max(uVfxFog.x, 1.0), uVfxFog.y) * uVfxFog.w * mix(0.42, 1.0, heightFalloff);
  // σ_R : σ_G : σ_B = 1.00 : 1.25 : 1.50, normalised on green. Mie-dominated
  // (~λ^-1.5), NOT λ^-4 — a Rayleigh ratio here turns the haze cyan.
  vec3 transmittance = exp(-tau * vec3(0.80, 1.00, 1.20));
  float cosT = dot(dir, uVfxSunDir);
  vec3 inscatter = mix(uVfxHazeAway, uVfxHazeSun, smoothstep(-0.25, 0.92, cosT));
  // Forward scattering, g = 0.72: the haze near the sun azimuth is BRIGHTER
  // than the sky away from it (measured 1.21× on bf6_gp_039).
  inscatter *= 1.0 + 0.34 * vfxHG(cosT, 0.72) * 0.25;
  return color * transmittance + inscatter * (1.0 - transmittance);
}

/**
 * Soft-particle depth fade. Mandatory per LOOK_SPEC §8; degrades to a hard
 * edge (and costs nothing) when the graph has no 'SceneDepth', which is the
 * documented 'RenderGraph.has()' degradation path.
 */
/**
 * 'RTId.SceneDepth' is an R32F COLOUR target carrying LINEAR VIEW DEPTH IN
 * METRES (RCORE's G-buffer writes max(-viewPos.z, 1e-4)), not a window-space
 * depth buffer. Reading it as if it were hyperbolic [0,1] depth produces a
 * negative scene distance, every VFX fragment tests as occluded, and the whole
 * lane silently disappears — which is exactly what happened the first time.
 * A zero means the prepass wrote nothing there, i.e. sky: infinitely far.
 */
float vfxSceneDepth() {
  float metres = texture(uVfxSceneDepth, gl_FragCoord.xy / uVfxResolution).r;
  // TWO sentinels, and both were expensive to find:
  //
  //  - The prepass CLEARS this target with the renderer's clear colour, not
  //    with zero, so sky pixels read ~0.003 m rather than 0. Testing for
  //    "> 0" therefore says the sky is three millimetres away and occludes
  //    every particle drawn against it.
  //  - Anything under ~0.6 m is the VIEWMODEL's own linear depth, written
  //    through the viewmodel camera into the same buffer at pass 17a. A muzzle
  //    flash 0.7 m from the eye must not be clipped by the weapon that fired
  //    it — the two live in different depth ranges by design.
  //
  // Both cases mean "there is no world surface here": infinitely far.
  return metres > 0.6 ? metres : 1.0e6;
}

float vfxSoftFadeOver(float fragViewZ, float metres) {
  if (uVfxDepthParams.w < 0.5) return 1.0;
  return clamp((vfxSceneDepth() - fragViewZ) / max(metres, 0.01), 0.0, 1.0);
}

float vfxSoftFade(float fragViewZ) {
  return vfxSoftFadeOver(fragViewZ, uVfxDepthParams.z);
}

/**
 * HARD occlusion against scene depth, for the passes that run on a target with
 * no usable depth attachment: 'PostResolveVfx' operates on the resolved image,
 * and 'Decals' composites over scene colour. A decal sits ON its surface, so
 * its own depth matches to within a millimetre and a soft fade would erase it —
 * this is a reject with a tolerance, not a gradient.
 */
float vfxDepthOccluded(float fragViewZ, float tolerance) {
  if (uVfxDepthParams.w < 0.5) return 0.0;
  return fragViewZ > vfxSceneDepth() + tolerance ? 1.0 : 0.0;
}

/**
 * Dissipation. A body must break up as it dies — expanding AND losing opacity
 * AND eroding from the edges inward — not cross-fade to zero at constant shape.
 * 'threshold' climbs with age, so the noise field carves holes that grow.
 */
float vfxErode(float density, float noise, float threshold) {
  return density * smoothstep(threshold, threshold + 0.42, noise);
}

/**
 * Output, correct both before and after RCORE's post chain takes over.
 *
 * three defines TONE_MAPPING exactly when the RENDERER still owns tonemapping,
 * which is also exactly when this material is writing DISPLAY-REFERRED colour
 * into an 8-bit target — so that branch tonemaps and encodes. Once
 * 'setTonemapOwnedByGraph' switches the renderer to NoToneMapping, every VFX
 * draw lands in a LINEAR HDR target and must stay linear.
 *
 * Calling 'linearToOutputTexel' unconditionally is the trap: three picks its
 * transfer function from the CURRENT render target, and a program that was
 * compiled with the sRGB OETF and is then used against a float target clamps
 * everything at 1.0. A 16 000 cd/m² muzzle flash comes out at 1.0 — additive
 * over a background already near 1.0 — and vanishes. That is not hypothetical:
 * it is what happened here, and it cost most of a day.
 */
vec4 vfxResolve(vec3 color, float alpha) {
  #ifdef TONE_MAPPING
    return linearToOutputTexel(vec4(toneMapping(color), alpha));
  #else
    return vec4(color, alpha);
  #endif
}
`;

/* ============================================================================
 * VOLUMETRIC BILLBOARD — smoke, dust, fire, haze, muzzle blast, spray
 * ========================================================================= */

/**
 * Kind codes, shared by the TS pools and the shaders. The vertex shader
 * branches on these for motion; the fragment shader branches for colour.
 */
export const VFX_KIND = {
  Smoke: 0,
  Dust: 1,
  Fire: 2,
  Haze: 3,
  Mote: 4,
} as const;

export const SOFT_VERTEX = /* glsl */ `
${VFX_GLOBALS}
${VFX_NOISE}

in vec3 iOrigin;
in vec3 iVelocity;
in vec3 iAccel;
in vec4 iLife;    // birthTime, lifetime, sizeStart, sizeEnd
in vec4 iShape;   // seed, drag 1/s, curl amplitude, spin rad/s
in vec4 iColorA;  // scattering albedo rgb, peak alpha
in vec4 iColorB;  // emissive rgb, emissive strength
in vec4 iFlags;   // kind, erode amount, self-shadow bias, curl spatial scale

out vec2 vCorner;
out float vLife;
out float vSeed;
out vec3 vWorld;
out vec3 vAlbedo;
out float vAlpha;
out vec3 vEmissive;
out float vEmissiveK;
out vec4 vFlags;
out float vViewZ;
out vec3 vOutward;
out float vRadius;

void main() {
  float age = uVfxTime - iLife.x;
  float life = age / max(iLife.y, 1e-3);

  // Dead or unborn slots collapse to a degenerate triangle behind the camera.
  // Cheaper and far more robust than compacting the buffer every frame for a
  // handful of expiring particles.
  if (age < 0.0 || life >= 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vCorner = vec2(0.0);
    vLife = 1.0;
    vSeed = 0.0;
    vWorld = vec3(0.0);
    vAlbedo = vec3(0.0);
    vAlpha = 0.0;
    vEmissive = vec3(0.0);
    vEmissiveK = 0.0;
    vFlags = vec4(0.0);
    vViewZ = 1.0;
    vOutward = vec3(0.0, 1.0, 0.0);
    vRadius = 1.0;
    return;
  }

  // Exponential drag, integrated in closed form. Everything about a particle's
  // path is evaluated on the GPU from its spawn state — the CPU writes 32
  // floats once and never touches the particle again.
  float k = iShape.y;
  float ed = (k > 1e-3) ? (1.0 - exp(-k * age)) / k : age;
  vec3 pos = iOrigin + iVelocity * ed;
  pos += (k > 1e-3) ? iAccel * (age - ed) / k : iAccel * 0.5 * age * age;

  if (iShape.z > 0.0) {
    // Curl advection. The field itself drifts downward through the particle so
    // a rising column shears and folds rather than translating a fixed pattern.
    vec3 q = pos * iFlags.w + vec3(iShape.x * 7.31, -age * 0.34, iShape.x * 3.17);
    pos += vfxCurl(q) * iShape.z * age;
  }

  float grow = 1.0 - pow(1.0 - clamp(life, 0.0, 1.0), 2.2);
  float size = mix(iLife.z, iLife.w, grow);

  // Billboard from the camera basis. Spin is per-particle so no two puffs in a
  // burst share an orientation — repeated identical sprites in one cluster is
  // the single most recognisable particle tell there is.
  float spin = iShape.w * age + iShape.x * 6.2831;
  float cs = cos(spin), sn = sin(spin);
  vec2 c = vec2(position.x, position.y);
  vec2 r = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  vec3 world = pos + (uVfxCamRight * r.x + uVfxCamUp * r.y) * size;

  vCorner = c;
  vRadius = size;
  vLife = life;
  vSeed = iShape.x;
  vWorld = world;
  vAlbedo = iColorA.rgb;
  vAlpha = iColorA.a;
  vEmissive = iColorB.rgb;
  vEmissiveK = iColorB.a;
  vFlags = iFlags;
  // Outward direction of this element within its own body: what turns a flat
  // card into something that self-shadows across a plume.
  vOutward = normalize(uVfxCamRight * c.x + uVfxCamUp * c.y + uVfxCamFwd * 0.55);

  vec4 view = viewMatrix * vec4(world, 1.0);
  vViewZ = -view.z;
  gl_Position = projectionMatrix * view;
}
`;

export const SOFT_FRAGMENT = /* glsl */ `
${VFX_GLOBALS}
${VFX_NOISE}
${VFX_SHADING}

in vec2 vCorner;
in float vLife;
in float vSeed;
in vec3 vWorld;
in vec3 vAlbedo;
in float vAlpha;
in vec3 vEmissive;
in float vEmissiveK;
in vec4 vFlags;
in float vViewZ;
in vec3 vOutward;
in float vRadius;

out vec4 outColor;

/**
 * The four-zone fire ramp from LOOK_SPEC §8.3, driven by a synthetic
 * temperature rather than by a colour lerp: core → body → cooling shell → soot,
 * so the red-to-soot handoff (which is where the AAA look lives) happens for
 * the right reason and the highlights desaturate toward white on the way up.
 */
vec3 vfxFireRamp(float temp) {
  vec3 soot  = vec3(0.055, 0.048, 0.042);
  vec3 shell = vec3(0.62, 0.13, 0.055);
  vec3 body  = vec3(1.00, 0.42, 0.16);
  vec3 core  = vec3(1.00, 0.88, 0.62);
  vec3 c = mix(soot, shell, smoothstep(0.02, 0.34, temp));
  c = mix(c, body, smoothstep(0.30, 0.66, temp));
  c = mix(c, core, smoothstep(0.62, 0.94, temp));
  return c;
}

void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 >= 1.0) discard;

  // Chord length through a unit sphere: the particle is treated as a small
  // BALL of medium, so its optical depth peaks at the centre and reaches zero
  // at the silhouette. This alone kills the hard-rimmed-disc look; the round
  // white blob on the brief's defect list is a disc with a constant alpha.
  float chord = sqrt(1.0 - r2);
  float density = chord * chord;

  float kind = vFlags.x;
  // Internal structure, evaluated in a 3D frame that INCLUDES THE CHORD, so the
  // noise is genuinely volumetric across the body rather than a printed pattern
  // on a flat card. Haze gets one octave rather than two: it is the cheapest
  // possible break-up, and without ANY break-up a low-alpha body reads as a
  // soft white ellipse floating in the sky — which is worse than no haze at all.
  vec3 np = vec3(vCorner * 1.45, chord * 0.9 + vSeed * 31.7 + vLife * 0.55);
  float detail = kind == ${VFX_KIND.Haze}.0 ? vfxNoise(np * 1.15) : vfxFbm2(np * 1.9);

  // Dissipation: the erosion threshold climbs with age, so the body loses
  // material from the outside in and ends as filaments.
  float threshold = vFlags.y * smoothstep(0.12, 1.0, vLife);
  float shape = vfxErode(density, mix(0.62, detail, kind == ${VFX_KIND.Haze}.0 ? 0.62 : 0.85), threshold);

  // Fade envelope: fast rise, long tail. Never a linear cross-fade.
  float rise = smoothstep(0.0, 0.09, vLife);
  float fall = 1.0 - smoothstep(0.42, 1.0, vLife);
  float alpha = shape * vAlpha * rise * fall;
  // The additive variant of this shader runs in the post-resolve pass, where
  // the bound depth buffer is not the scene's; the alpha variant runs in the
  // sorted transparent pass, where it is, and the test is then redundant but
  // free (uVfxDepthParams.w gates the fetch entirely on a graph without depth).
  if (alpha < 0.002 || vfxDepthOccluded(vViewZ, 0.02) > 0.5) discard;

  vec3 viewDir = normalize(vWorld - uVfxCamPos);
  // Blend the ball's own normal with the body-outward direction; the second
  // term is what makes a cluster read as one volume instead of N cards.
  vec3 n = normalize(vOutward * 0.55 + normalize(uVfxCamRight * vCorner.x + uVfxCamUp * vCorner.y - uVfxCamFwd * chord) * 0.45);
  float selfShadow = mix(1.0, clamp(1.0 - density * vFlags.z, 0.0, 1.0), 0.85);

  float g = kind == ${VFX_KIND.Dust}.0 ? 0.52 : (kind == ${VFX_KIND.Haze}.0 ? 0.72 : 0.62);
  vec3 color = vfxScatter(vWorld, n, viewDir, selfShadow, g, vAlbedo, vEmissiveK > 0.0 ? 1.0 : 0.0);

  if (kind == ${VFX_KIND.Haze}.0) {
    // AMBIENT HAZE IS PART OF THE AERIAL PERSPECTIVE, NOT AN OBJECT IN IT.
    // Its radiance is pulled hard toward the sky radiance in this direction, so
    // against open sky it is very nearly invisible (which is exactly why real
    // haze is invisible against the sky — same brightness) and against dark
    // geometry it lifts and desaturates. Shading it as an independent lump is
    // what makes a haze field read as a row of soft white ellipses floating in
    // the air, which was the loudest artefact in this lane's first captures.
    float cosSun = dot(viewDir, uVfxSunDir);
    vec3 skyHere = mix(uVfxHazeAway, uVfxHazeSun, smoothstep(-0.25, 0.92, cosSun));
    color = mix(color, skyHere, 0.80);
  }

  if (vEmissiveK > 0.0) {
    // Temperature: hot in the core, hot early, and broken by the SAME noise
    // field that carves the shape, so the dark soot filaments sit immediately
    // next to over-range cores exactly as they do in the reference.
    float temp = clamp((1.0 - vLife * vLife) * (0.34 + 0.66 * density) * (0.45 + 0.85 * detail), 0.0, 1.0);
    vec3 fire = vfxFireRamp(temp);
    color += vEmissive * fire * vEmissiveK * uVfxEmissiveScale * pow(temp, 1.35);
    // A fireball occludes: its alpha rises with temperature so the core is
    // nearly opaque and genuinely silhouettes geometry in front of it.
    alpha = clamp(alpha + temp * temp * 0.55 * vAlpha, 0.0, 1.0);
  }

  // The fade distance SCALES WITH THE BODY. A fixed 0.55 m is right for a
  // half-metre impact puff and is a hard clip line across a 25 m haze body —
  // which is exactly the "flat white puddle where the medium meets the ground"
  // artefact. A third of the radius reads as a volume in both cases.
  alpha *= vfxSoftFadeOver(vViewZ, max(0.35, vRadius * 0.34));
  color = vfxAerial(color, vWorld);
  outColor = vfxResolve(color, alpha);
}
`;

/* ============================================================================
 * STREAK — tracers, sparks, embers, whizby. Velocity-stretched, additive.
 * ========================================================================= */

export const STREAK_VERTEX = /* glsl */ `
${VFX_GLOBALS}

in vec3 iOrigin;
in vec3 iVelocity;
in vec3 iAccel;
in vec4 iLife;    // birthTime, lifetime, width, rod length (m)
in vec4 iShape;   // seed, drag, streak seconds, kind
in vec4 iColorA;  // rgb, peak intensity
in vec4 iColorB;  // rgb tail colour, glow multiplier

out vec2 vCorner;
out float vLife;
out vec3 vColor;
out vec3 vTail;
out float vGlow;
out float vIntensity;
out float vViewZ;
out vec3 vWorld;

void main() {
  float age = uVfxTime - iLife.x;
  float life = age / max(iLife.y, 1e-3);
  if (age < 0.0 || life >= 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vCorner = vec2(0.0); vLife = 1.0; vColor = vec3(0.0); vTail = vec3(0.0);
    vGlow = 0.0; vIntensity = 0.0; vViewZ = 1.0; vWorld = vec3(0.0);
    return;
  }

  float k = iShape.y;
  float ed = (k > 1e-3) ? (1.0 - exp(-k * age)) / k : age;
  vec3 pos = iOrigin + iVelocity * ed + ((k > 1e-3) ? iAccel * (age - ed) / k : iAccel * 0.5 * age * age);
  vec3 vel = iVelocity * exp(-k * age) + iAccel * age;

  float speed = length(vel);
  vec3 dir = speed > 1e-3 ? vel / speed : uVfxCamUp;

  // LENGTH: a fixed rod for a tracer (1.8–3.2 m, LOOK_SPEC §8.1) plus a
  // shutter-proportional streak for sparks and embers, which is what gives a
  // spark visible motion rather than a dead pixel.
  float halfLen = max(iLife.w, speed * iShape.z) * 0.5;
  float halfWid = iLife.z * 0.5;

  // Screen-space alignment: project the rod axis into the camera plane so a
  // tracer coming at the camera degenerates to a dot instead of vanishing.
  vec3 side = cross(dir, normalize(pos - uVfxCamPos));
  float sideLen = length(side);
  side = sideLen > 1e-3 ? side / sideLen : uVfxCamRight;

  vec3 world = pos + dir * (position.y * halfLen) + side * (position.x * halfWid);

  vCorner = position.xy;
  vLife = life;
  vColor = iColorA.rgb;
  vTail = iColorB.rgb;
  vGlow = iColorB.a;
  vIntensity = iColorA.a;
  vWorld = world;
  vec4 view = viewMatrix * vec4(world, 1.0);
  vViewZ = -view.z;
  gl_Position = projectionMatrix * view;
}
`;

export const STREAK_FRAGMENT = /* glsl */ `
${VFX_GLOBALS}
${VFX_SHADING}

in vec2 vCorner;
in float vLife;
in vec3 vColor;
in vec3 vTail;
in float vGlow;
in float vIntensity;
in float vViewZ;
in vec3 vWorld;

out vec4 outColor;

void main() {
  // Core + glow: the core is a thin over-range line, the glow is ~3× its width
  // (LOOK_SPEC §8.1). One without the other is either a dead pixel or a blob.
  float across = abs(vCorner.x);
  float along = vCorner.y;
  float core = pow(clamp(1.0 - across, 0.0, 1.0), 6.0);
  float glow = pow(clamp(1.0 - across, 0.0, 1.0), 1.6) * vGlow;
  // Taper the trailing end so the rod has a head and a tail, not two ends.
  float taper = smoothstep(-1.0, -0.35, along) * (1.0 - smoothstep(0.72, 1.0, along));
  float fade = (1.0 - smoothstep(0.55, 1.0, vLife));

  vec3 color = mix(vTail, vColor, core);
  float amount = (core + glow * 0.34) * taper * fade * vIntensity;
  // Drawn after the TAA resolve, on a target with no scene depth attached, so
  // occlusion is done here against 'SceneDepth' rather than by the depth test.
  if (amount < 0.0015 || vfxDepthOccluded(vViewZ, 0.02) > 0.5) discard;

  amount *= vfxSoftFade(vViewZ);
  vec3 lit = vfxAerial(color * amount * uVfxEmissiveScale, vWorld);
  // Alpha-blended (see 'vfx.streak' in pools.ts). A tracer core is thin and
  // very bright, so its coverage is driven up hard: an over-range rod that
  // only ever reaches 8 % alpha would be invisible however bright its colour.
  outColor = vfxResolve(lit, clamp(amount * 2.6, 0.0, 1.0));
}
`;

/* ============================================================================
 * DECALS — surface-conforming, noise-broken, lit by the same model
 * ========================================================================= */

export const DECAL_VERTEX = /* glsl */ `
${VFX_GLOBALS}

in vec3 iCentre;
in vec3 iNormal;
in vec3 iTangent;
in vec4 iParams;   // size (m), birthTime, lifetime (0 = permanent), seed
in vec4 iColor;    // rgb, opacity
in vec4 iKind;     // kind, roughnessHint, unused, unused

out vec2 vUv;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColor;
out vec4 vKind;
out float vSeed;
out float vAge;
out float vViewZ;

void main() {
  vec3 n = normalize(iNormal);
  vec3 t = normalize(iTangent - n * dot(n, iTangent));
  vec3 b = cross(n, t);
  float extent = iParams.x * 0.5;
  vec3 world = iCentre + (t * position.x + b * position.y) * extent;

  vUv = position.xy;
  vWorld = world;
  vNormal = n;
  vColor = iColor;
  vKind = iKind;
  vSeed = iParams.w;
  vAge = iParams.z > 0.0 ? clamp((uVfxTime - iParams.y) / iParams.z, 0.0, 1.0) : 0.0;
  vec4 view = viewMatrix * vec4(world, 1.0);
  vViewZ = -view.z;
  gl_Position = projectionMatrix * view;
}
`;

export const DECAL_FRAGMENT = /* glsl */ `
${VFX_GLOBALS}
${VFX_NOISE}
${VFX_SHADING}

in vec2 vUv;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vColor;
in vec4 vKind;
in float vSeed;
in float vAge;
in float vViewZ;

out vec4 outColor;

void main() {
  float r = length(vUv);
  // NOISE-BROKEN OUTLINE, never a circular stamp (LOOK_SPEC §8.2). The radius
  // itself is modulated by angle, so no two holes share a silhouette.
  float ang = atan(vUv.y, vUv.x);
  // Two angular octaves: a lobed outline plus a fine ragged one. A single
  // octave still reads as a circle with a wobble, which is not what a fracture
  // does — the boundary has to be broken at two scales or it stamps.
  float wob = vfxFbm2(vec3(cos(ang) * 1.7, sin(ang) * 1.7, vSeed * 53.0)) - 0.5;
  float wob2 = vfxFbm2(vec3(cos(ang) * 6.1, sin(ang) * 6.1, vSeed * 17.0 + 5.0)) - 0.5;
  float edge = 0.86 + wob * 0.46 + wob2 * 0.22;
  if (r > edge) discard;

  float kind = vKind.x;
  float grain = vfxFbm2(vec3(vUv * 4.1, vSeed * 17.0));

  // Bullet holes: a dark crater with a lighter spalled ring around it. The ring
  // is substrate-coloured because it IS substrate — powdered stone, not paint.
  float crater = 1.0 - smoothstep(0.0, 0.42 + grain * 0.18, r);
  float spall = smoothstep(0.34, 0.58, r) * (1.0 - smoothstep(0.66, edge, r));
  // The spalled ring is a DUSTING, not a second solid stamp. At full coverage
  // it reads as a painted target ring; at 0.4 it reads as powdered stone.
  float coverage = clamp(crater + spall * 0.40 * (0.35 + grain), 0.0, 1.0);

  vec3 albedo = vColor.rgb;
  if (kind < 4.5) {
    // Impact: crater core is near-black soot (LOOK_SPEC §4.3 floor 0.035),
    // spall ring is the substrate lightened by fracture.
    albedo = mix(vColor.rgb * 1.12, vec3(0.045, 0.040, 0.036), crater);
  } else if (kind < 5.5) {
    // Scorch: broad, sooty, edge-feathered, no crater.
    coverage = (1.0 - smoothstep(0.15, edge, r)) * (0.55 + grain * 0.75);
    albedo = mix(vec3(0.09, 0.075, 0.062), vec3(0.038, 0.034, 0.031), grain);
  } else {
    coverage = (1.0 - smoothstep(0.25, edge, r)) * (0.4 + grain * 0.8);
  }

  float alpha = coverage * vColor.a * (1.0 - vAge);
  // The decal pass composites over scene colour on a target whose depth buffer
  // is not the one the world was drawn with, so the occlusion test is explicit.
  if (alpha < 0.004 || vfxDepthOccluded(vViewZ, 0.14) > 0.5) discard;

  // Lit with the same sun/sky model as everything else in the lane so it takes
  // the substrate's light rather than sitting on top of it as a sticker. The
  // 1.0 self-shadow term makes it behave as an opaque surface, not a medium.
  vec3 viewDir = normalize(vWorld - uVfxCamPos);
  float ndl = clamp(dot(vNormal, uVfxSunDir), 0.0, 1.0);
  vec3 sky = mix(uVfxSkyDown, uVfxSkyUp, vNormal.y * 0.5 + 0.5);
  vec3 color = (uVfxSunIrradiance * ndl + sky) * albedo * (1.0 / VFX_PI);
  for (int i = 0; i < 4; i++) {
    vec3 d = uVfxEmitterPos[i].xyz - vWorld;
    float r2 = dot(d, d);
    if (uVfxEmitterPos[i].w <= 0.0) continue;
    float atten = clamp(1.0 - r2 / (uVfxEmitterPos[i].w * uVfxEmitterPos[i].w), 0.0, 1.0) / max(r2, 0.25);
    color += uVfxEmitterCol[i].rgb * atten * max(dot(vNormal, normalize(d + 1e-4)), 0.0) * albedo * (1.0 / VFX_PI);
  }

  color = vfxAerial(color, vWorld);
  outColor = vfxResolve(color, alpha);
}
`;
