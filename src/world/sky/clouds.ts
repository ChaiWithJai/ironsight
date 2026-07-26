/**
 * Volumetric clouds.
 *
 * OWNER: SKY.
 *
 * Not a scrolling texture and not a lit billboard — the brief calls both a
 * defect. A ray that enters the slab is marched, its density comes from a
 * three-octave shape/erosion stack, and every sample runs a short march TOWARD
 * THE SUN so the cloud shadows itself. That self-shadowing plus the
 * forward-scattering phase is where the silver lining comes from; a cloud lit by
 * `max(dot(n,l),0)` has neither and reads as cotton wool instantly.
 *
 * The cloud sits INSIDE the scattering model rather than on top of it: it is
 * composited against the sky radiance behind it, its own radiance is the sky
 * ambient plus the transmitted sun, and the whole result then receives the
 * atmospheric in-scatter over the distance to it. That last step is what stops
 * clouds near the horizon reading as stickers.
 */

/** Cloud slab, LOOK_SPEC §3.1: base 900 m, thickness 1200 m. */
export const CLOUD_BASE = 900;
export const CLOUD_THICKNESS = 1200;

export const CLOUD_GLSL = /* glsl */ `
const float IRON_CLOUD_BASE = ${CLOUD_BASE.toFixed(1)};
const float IRON_CLOUD_TOP = ${(CLOUD_BASE + CLOUD_THICKNESS).toFixed(1)};

uniform sampler2D uSkyCloudNoise;
uniform float uSkyCloudCoverage;
uniform vec2 uSkyCloudDrift;

/**
 * Density at a world point. The baked tile carries four decorrelated octaves:
 *   r = 3-octave fBm      (the weather / coverage field)
 *   g = 5-octave fBm      (billow shape)
 *   b = inverted Worley   (the cauliflower erosion)
 *   a = high-frequency fBm (wisp detail at the edges)
 *
 * Verticality comes from sampling the SAME tile on two sheared planes rather
 * than from a 3D volume: at 900 m base and 1200 m thickness the vertical
 * correlation length of real cumulus is comparable to the horizontal one, and
 * the shear reproduces that at a quarter of the bake cost and half the fetches.
 */
float ironCloudDensity(vec3 p, float detail) {
  float h = clamp((p.y - IRON_CLOUD_BASE) / (IRON_CLOUD_TOP - IRON_CLOUD_BASE), 0.0, 1.0);
  // 1.4e-4 → a ~7 km weather cell, so a 100 km sightline crosses a dozen of
  // them and the deck reads as separate cumulus rather than as one continent.
  vec2 w = p.xz * 1.4e-4 + uSkyCloudDrift;

  // Weather field: where clouds are allowed to exist at all. The threshold is
  // deliberately soft over a wide band — a hard one gives the scalloped,
  // stamped-out silhouette that reads as a texture rather than as a volume.
  float weather = texture(uSkyCloudNoise, w).r;
  float coverage = clamp(uSkyCloudCoverage, 0.0, 1.0);
  float cov = smoothstep(1.0 - coverage * 0.85, 1.0 - coverage * 0.12, weather);
  if (cov <= 0.001) return 0.0;

  // Vertical profile: rounded bottoms, anvil-flattened tops, and thinner where
  // coverage is marginal so the edges of a cell are wisps rather than cliffs.
  float profile = smoothstep(0.0, 0.14 + 0.16 * (1.0 - cov), h) * smoothstep(1.0, 0.45 + 0.25 * cov, h);

  vec2 s1 = p.xz * 6.5e-4 + vec2(p.y * 3.4e-4, -p.y * 2.8e-4) + uSkyCloudDrift * 2.0;
  float shape = texture(uSkyCloudNoise, s1).g;
  float d = cov * profile * mix(0.35, 1.0, shape);

  if (d <= 0.001 || detail < 0.5) return max(0.0, d);

  vec2 s2 = p.xz * 3.4e-3 + vec2(-p.y * 2.0e-3, p.y * 1.6e-3) + uSkyCloudDrift * 5.0;
  vec3 fine = texture(uSkyCloudNoise, s2).baa;
  // Erosion eats the edges, never the core: that is what gives cumulus their
  // cauliflower silhouette instead of a soft blob. Weighted hard, because at a
  // 3.5 km slab crossing the shape octave alone is two features wide and reads
  // as an airbrushed ellipse.
  float erode = fine.x * 0.62 + fine.y * 0.38;
  d -= erode * 0.62 * (1.0 - smoothstep(0.18, 0.62, d));
  return max(0.0, d) * 1.05;
}

/** Slab entry/exit for a ray. Returns false when the ray misses the layer. */
bool ironCloudSlab(vec3 origin, vec3 dir, out float t0, out float t1) {
  if (abs(dir.y) < 1e-4) return false;
  float a = (IRON_CLOUD_BASE - origin.y) / dir.y;
  float b = (IRON_CLOUD_TOP - origin.y) / dir.y;
  t0 = min(a, b);
  t1 = max(a, b);
  t0 = max(t0, 0.0);
  return t1 > t0;
}

/**
 * March the slab. Returns transmittance in .a and scattered radiance (cd/m²) in
 * .rgb. 'steps' comes from the tier table; 'sunRadiance' is the sun's disc
 * radiance already reddened by the atmosphere.
 */
vec4 ironCloudMarch(
  vec3 origin, vec3 dir, vec3 sunDir, vec3 sunRadiance, vec3 ambient,
  int steps, float jitter, float density
) {
  float t0, t1;
  if (!ironCloudSlab(origin, dir, t0, t1)) return vec4(0.0, 0.0, 0.0, 1.0);
  // Past ~90 km the slab is edge-on and every step is a mile long; clamp rather
  // than let the horizon dissolve into aliasing.
  t1 = min(t1, t0 + 90000.0);
  float span = t1 - t0;
  if (span <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);

  // Adaptive stepping: a coarse stride while the ray is in clear air, dropped to
  // a third of it the moment density appears and restored after eight empty
  // samples. Uniform stepping over a 3–90 km slab crossing is what produces the
  // brush-stroke banding across a cloud face, and it spends most of its samples
  // on nothing. Same budget, roughly three times the resolution where it counts.
  float dtCoarse = span / float(steps);
  float dtFine = dtCoarse * 0.34;
  float dt = dtCoarse;
  int emptyRun = 0;
  float t = t0 + dt * jitter;
  vec3 scatter = vec3(0.0);
  float transmittance = 1.0;
  float cosTheta = clamp(dot(dir, sunDir), -1.0, 1.0);
  // Two lobes: the strong forward lobe is the silver lining on the sun side,
  // the weak back lobe keeps the shadowed side from going flat black.
  float phase = mix(ironPhaseHG(cosTheta, 0.72), ironPhaseHG(cosTheta, -0.26), 0.28) * 4.0 * IRON_PI;

  // The loop bound is 3× 'steps' because a fine step costs a third of a coarse
  // one; the marched DISTANCE, which is what actually costs time, is unchanged.
  for (int i = 0; i < 96; i++) {
    if (t > t1 || i >= steps * 3 || transmittance < 0.02) break;
    vec3 p = origin + dir * t;
    float d = ironCloudDensity(p, 1.0) * density;
    if (d <= 0.002) {
      emptyRun++;
      if (emptyRun > 8) dt = dtCoarse;
    } else {
      emptyRun = 0;
      dt = dtFine;
    }
    if (d > 0.002) {
      // Light march: four exponentially-spaced taps toward the sun. This is the
      // whole self-shadowing term, and it is why a cloud has a dark base.
      float lightTau = 0.0;
      float ls = 110.0;
      vec3 lp = p;
      for (int j = 0; j < 4; j++) {
        lp += sunDir * ls;
        lightTau += ironCloudDensity(lp, j < 2 ? 1.0 : 0.0) * density * ls;
        ls *= 2.4;
      }
      // Beer-Powder: plain Beer makes the sunlit edge too dark, because it
      // ignores the in-scattering that a dense medium does back toward the eye.
      float beer = exp(-lightTau * 0.0016);
      float powder = 1.0 - exp(-lightTau * 0.0032);
      vec3 sunLight = sunRadiance * beer * mix(1.0, powder * 2.0, 0.35) * phase;
      // The shaded side of a real cumulus is not dark — it is filled by the
      // whole sky hemisphere plus inter-cloud bounce, at roughly half the lit
      // face. A low floor here is what makes procedural clouds read as dirty
      // brown lumps on the anti-sun side of the frame.
      vec3 lit = sunLight + ambient * (0.55 + 0.45 * exp(-lightTau * 0.0006));

      // 0.030 rather than 0.055: at 0.055 a cloud saturates to opaque inside
      // one step, so its silhouette is decided by a single sample and comes out
      // scalloped. Halving it spreads the edge over three or four samples.
      float sigma = d * 0.030;
      float stepT = exp(-sigma * dt);
      // Energy-conserving integration of the segment, not a naive accumulate.
      scatter += transmittance * lit * (1.0 - stepT);
      transmittance *= stepT;
    }
    t += dt;
  }
  return vec4(scatter, transmittance);
}
`;
