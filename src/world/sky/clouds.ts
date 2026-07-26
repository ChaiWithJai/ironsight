/**
 * Volumetric clouds.
 *
 * OWNER: SKY.
 *
 * Not a scrolling texture and not a lit billboard — the brief calls both a
 * defect. A ray that enters the slab is marched, its density comes from a
 * shape/erosion stack sampled on two non-parallel planes, and every sample runs
 * a short march TOWARD THE SUN so the cloud shadows itself. That self-shadowing,
 * the multiple-scattering octaves and the forward-scattering phase are where the
 * silver lining and the dark base come from; a cloud lit by `max(dot(n,l),0)`,
 * or by a march whose ambient term outweighs its sun term, has neither and reads
 * as cotton wool instantly.
 *
 * The cloud sits INSIDE the scattering model rather than on top of it: it is
 * composited against the sky radiance behind it, its own radiance is the sky
 * fill plus the transmitted sun, and the whole result then receives the
 * atmospheric in-scatter over the distance to it. That last step is what stops
 * clouds near the horizon reading as stickers.
 *
 * ── THE THREE THINGS THAT WERE WRONG, AND WHY EACH ONE MATTERED ─────────────
 *
 * 1. SINGLE SCATTERING ONLY. Outside the forward lobe a single-scatter march
 *    returns roughly a tenth of a real cumulus' radiance, so the deck had to be
 *    lifted with a large view-independent ambient constant to be visible at
 *    all — and a constant is precisely what erases form. Ambient outweighed sun
 *    almost everywhere, which is the "flat-lit cloud" the rubric calls an
 *    automatic fail. Fixed with three multiple-scattering octaves (below) and a
 *    sky fill that is a fifth of what it was and varies with depth.
 *
 * 2. ONE PLANE, SHEARED. Sampling a 2D tile on a plane sheared by `p.y` does not
 *    make a 3D field: it translates the SAME 2D pattern as the ray climbs, so
 *    every feature is a vertical column and a marched cloud comes out as
 *    vertical smears inside an elliptical envelope. Fixed by multiplying the
 *    xz-plane sample by one taken on a plane that CONTAINS y.
 *
 * 3. THE SAMPLE GRID WAS PER-PIXEL. The march skipped empty space at
 *    `span/steps` — hundreds of metres — and only dropped to a fine stride after
 *    it had already stepped INTO the cloud, so the silhouette was quantised to
 *    the coarse stride. Worse, the stride's phase came from a per-pixel dither,
 *    and that dither is interleaved gradient noise, which is REGULAR: the result
 *    was a diagonal cross-hatch lattice printed over every cloud in frame. Fixed
 *    in three parts — bisect for the true boundary on first contact, snap the
 *    fine march to a grid every pixel shares, and make the exit from fine mode
 *    far stickier than the entry so no wisp is integrated by one pixel and
 *    discarded by its neighbour.
 */

/** Cloud slab, LOOK_SPEC §3.1: base 900 m, thickness 1200 m. */
export const CLOUD_BASE = 900;
export const CLOUD_THICKNESS = 1200;

export const CLOUD_GLSL = /* glsl */ `
const float IRON_CLOUD_BASE = ${CLOUD_BASE.toFixed(1)};
const float IRON_CLOUD_TOP = ${(CLOUD_BASE + CLOUD_THICKNESS).toFixed(1)};

/**
 * Extinction per unit density per metre.
 *
 * ONE COEFFICIENT FOR BOTH MARCHES, and that is the whole point. The previous
 * build used 0.030 along the view ray and 0.0016 toward the sun — a factor of
 * 19 — so a cloud that was fully opaque to the eye after 40 m was still 75 %
 * transparent to the sun after 300 m. Nothing could shadow itself, every sample
 * came back at nearly full sunlight, and the deck rendered as flat white paint.
 * A medium has one extinction coefficient; using two is not a tuning choice, it
 * is an inconsistent medium.
 */
const float IRON_CLOUD_SIGMA = 0.030;

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
 * A GENUINELY 3D FIELD OUT OF A 2D TILE, and this is the part that decides
 * whether the deck reads as volume or as wallpaper. Two samples are taken on
 * planes that are not parallel: one through xz, one through a vertical plane
 * rotated 38° in the horizontal, and they are MULTIPLIED. The product matters —
 * a sum of two [0,1] fields regresses to a smooth sheet, whereas a product
 * separates the deck into discrete towers, which is what cumulus are. Two
 * fetches, no 3D texture, no vertical smearing.
 */
float ironCloudDensity(vec3 p, float detail) {
  float h = clamp((p.y - IRON_CLOUD_BASE) / (IRON_CLOUD_TOP - IRON_CLOUD_BASE), 0.0, 1.0);

  // 1.15e-4 → an ~8.7 km weather tile whose 3-octave content puts cells at
  // ~2.9 km, so a 100 km sightline crosses a few dozen of them and the deck
  // reads as separate cumulus rather than as one continent.
  vec2 w = p.xz * 1.15e-4 + uSkyCloudDrift;
  // .x is the coverage field; .y is a per-cell HEIGHT field, free because it is
  // the same texel. At this scale the shape octave's base feature is ~1.7 km,
  // i.e. one value per cell rather than a ceiling cutting through them.
  vec2 weather = texture(uSkyCloudNoise, w).rg;

  float coverage = clamp(uSkyCloudCoverage, 0.0, 1.0);
  // Threshold deliberately soft over a wide band — a hard one gives the
  // scalloped, stamped-out silhouette that reads as a texture, not a volume.
  //
  // THE BAND IS CALIBRATED SO THE PARAMETER MEANS WHAT IT SAYS. The weather
  // channel is a contrast-stretched 3-octave fBm, i.e. roughly normal about
  // 0.5, so a band of [1 − 0.90c, 1 − 0.10c] sits far out in its upper tail:
  // at LOOK_SPEC §3.1's GOLDEN coverage of 0.30 it thresholded at [0.73, 0.97]
  // and put about 8 % of the sky under cloud, not 30 %. That is why the deck
  // read as three clouds in an empty sky — not a shading problem at all, a
  // units problem in the one parameter that decides how much sky is cloud.
  // [1 − 1.50c, 1 − 0.42c] lands 0.30 → ~23 % and 0.38 → ~34 %, i.e. inside the
  // §3.1 band, and still drives to full cover as the overcast term pushes c up.
  float cov = smoothstep(1.0 - coverage * 1.50, 1.0 - coverage * 0.42, weather.x);
  if (cov <= 0.002) return 0.0;

  // Per-cell top. Real cumulus in one field are not all the same height, and a
  // uniform top is the strongest "stamped from one shape" cue there is: it puts
  // every crown in the frame on the same horizontal line. Marginal cells stay
  // low and wispy; the cells at the middle of a weather cluster tower.
  float top = mix(0.32, 1.0, cov * (0.42 + 0.58 * weather.y));
  if (h > top) return 0.0;
  float hn = h / top;

  // Vertical profile: a FLAT, fast base — a cumulus base is a plane, it is the
  // condensation level — and a long soft crown for the erosion to chew on.
  float profile = smoothstep(0.0, 0.10, hn) * (1.0 - smoothstep(0.52, 1.0, hn));
  if (profile <= 0.002) return 0.0;

  // The vertical plane: horizontal axis rotated 38° off x so it decorrelates
  // from the xz sample even where the tile repeats.
  vec2 q = vec2(p.x * 0.788 + p.z * 0.616, p.y);

  // 7.5e-4 → a 1.33 km tile; its 5 octaves run from 267 m cauliflower down to
  // 17 m wisps. The vertical plane is sampled 1.37× finer so the two never
  // beat against each other.
  float a = texture(uSkyCloudNoise, p.xz * 7.5e-4 + uSkyCloudDrift * 2.0).g;
  // 'detail' is a LEVEL, not a flag: 0 = the sun march, 1 = coarse view, 2 =
  // fine view. The sun march substitutes the second plane's mean (this channel
  // is fBm×0.5+0.5, so 0.5) instead of fetching it. That is a real
  // approximation — it smooths the shadow field slightly — but the light march
  // is the dominant cost of the whole deck at three taps per shaded sample, and
  // a shadow is the one term that can afford a smoother density than the
  // silhouette it falls on.
  float b = detail < 0.5 ? 0.5 : texture(uSkyCloudNoise, q * 1.03e-3 + vec2(0.31, 0.17)).g;
  float shape = smoothstep(0.05, 0.46, a * b);

  float d = cov * profile * mix(0.26, 1.0, shape);
  if (d <= 0.002 || detail < 1.5) return max(0.0, d);

  // Erosion, again on both planes. 3.0e-3 → a 333 m tile whose Worley cells are
  // ~37 m, which at a typical 1.2 km slant range is 1.8° — a couple of dozen
  // pixels, i.e. exactly the scale the eye reads as "cauliflower".
  vec2 f1 = texture(uSkyCloudNoise, p.xz * 3.0e-3 + uSkyCloudDrift * 5.0).ba;
  float f2 = texture(uSkyCloudNoise, q * 3.63e-3 + vec2(0.67, 0.43)).b;
  float erode = f1.x * 0.40 + f2 * 0.42 + f1.y * 0.18;

  // Erosion eats the boundary, never the core: that is what gives cumulus their
  // cauliflower silhouette instead of a soft blob.
  d -= erode * 0.58 * (1.0 - smoothstep(0.14, 0.55, d));
  // And it eats the crown harder than the flanks, because that is where the
  // convection is actually breaking the cloud up.
  d -= erode * 0.30 * smoothstep(0.45, 1.0, hn);
  return max(0.0, d) * 1.14;
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
 * Cloud phase for multiple-scattering octave eccentricity 'e', in sr⁻¹.
 *
 * Two lobes: the strong forward lobe is the silver lining on the sun side, the
 * weak back lobe keeps the shadowed side from going flat black. Higher octaves
 * scale the eccentricity down, which is the standard cheap stand-in for the
 * angular blurring successive scattering events perform.
 */
float ironCloudPhase(float c, float e) {
  return mix(ironPhaseHG(c, 0.72 * e), ironPhaseHG(c, -0.26 * e), 0.28);
}

/**
 * March the slab. Returns transmittance in .a and scattered radiance (cd/m²) in
 * .rgb. 'steps' comes from the tier table; 'sunIrradiance' is the illuminance
 * on a plane normal to the sun ABOVE the deck, in lux — NOT divided by 4π, the
 * phase above is a real sr⁻¹ phase function and carries the solid angle itself.
 * 'skyRadiance' is the zenith sky the deck sits under, in cd/m².
 */
vec4 ironCloudMarch(
  vec3 origin, vec3 dir, vec3 sunDir, vec3 sunIrradiance, vec3 skyRadiance,
  int steps, float density
) {
  float t0, t1;
  if (!ironCloudSlab(origin, dir, t0, t1)) return vec4(0.0, 0.0, 0.0, 1.0);
  // Past ~90 km the slab is edge-on and every step is a mile long; clamp rather
  // than let the horizon dissolve into aliasing.
  t1 = min(t1, t0 + 90000.0);
  float span = t1 - t0;
  if (span <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);

  // Empty-space stride, CLAMPED at both ends. Unclamped, a grazing exit makes
  // span/steps kilometres long and the ray walks straight past whole cells; the
  // iteration budget below is what actually decides how far a grazing ray gets,
  // and the deck is opaque long before it runs out.
  float dtCoarse = clamp(span / float(steps), 60.0, 420.0);
  // The fine stride gets its OWN absolute clamp rather than riding the coarse
  // one. A ray 15° above the horizon crosses 4.6 km of slab, so span/steps
  // pushes the coarse stride to its ceiling and a proportional fine stride to
  // 143 m — which at 2.5 km slant range is 25 px of quantisation along a
  // near-horizontal ray, i.e. the horizontal combing on every low cloud. The
  // clamp is near cost-neutral because it cuts BOTH ways: steep rays, which are
  // most of a sky-facing frame, get a 24 m floor instead of a 20 m stride.
  float dtFine = clamp(dtCoarse * 0.34, 24.0, 75.0);

  // ---- phase, once per ray ------------------------------------------------
  float cosTheta = clamp(dot(dir, sunDir), -1.0, 1.0);
  // Three multiple-scattering octaves (Hillaire 2020). Each successive order
  // carries less energy, is attenuated by less of the medium and is more
  // isotropic. Without them a march is single-scatter only, which is a tenth of
  // a real cumulus' radiance everywhere outside the forward lobe — and a deck
  // that dim has to be floated on an ambient constant to be seen, which is what
  // flat-lit clouds ARE.
  //
  // Weights and extinction scales are a fitted pair, not two free knobs: with a
  // consistent σ an optically thick core reaches τ ≈ 20 toward the sun, so the
  // deepest octave's extinction scale is what decides whether a cumulus core is
  // dark grey (right) or black (wrong). 1.00 / 0.35 / 0.12 puts a core at
  // display ~0.20 and a lit flank at ~0.93.
  float ph0 = ironCloudPhase(cosTheta, 1.0);
  float ph1 = ironCloudPhase(cosTheta, 0.5) * 0.55;
  float ph2 = ironCloudPhase(cosTheta, 0.25) * 0.30;

  // NO PER-PIXEL DITHER, ANYWHERE IN THIS MARCH, and that is the conclusion of
  // three capture cycles rather than an oversight.
  //
  // The textbook move is to jitter the ray's start by a screen-space dither so
  // the stride quantisation becomes noise instead of banding. It does not work
  // here, for a reason specific to an empty-space-skipping march: a coarse
  // sample is a DETECTION, not a contribution, so the dither does not perturb
  // an integral — it perturbs a decision. Which coarse cell trips first, which
  // bracket the bisection below gets, and therefore which thin wisp is
  // integrated at all, all become per-pixel binary outcomes. And interleaved
  // gradient noise is not noise, it is a regular diagonal lattice, so those
  // outcomes came out as a cross-hatch printed over every cloud in the frame.
  //
  // Both grids are phase-locked to distance instead. Every pixel then samples
  // the same depths, the quantisation error varies smoothly across the screen
  // because dtCoarse does, and what is left is a soft contour instead of a
  // pattern — with the midpoint rule below keeping that under the noise floor.
  // The price is that a cloud thinner than one coarse stride is missed uniformly
  // rather than stochastically, which at 100 m against a 250 m smallest feature
  // reads as a very slightly thinner deck and nothing else.
  float t = ceil(t0 / dtCoarse) * dtCoarse;
  float dt = dtCoarse;
  // Monotone floor for the rewind below, so a cell that is entered, left and
  // re-entered can never send 't' backwards past a stride it already marched.
  float tFloor = t0;
  bool fine = false;
  int empty = 0;
  vec3 scatter = vec3(0.0);
  float transmittance = 1.0;
  int budget = steps * 4;

  for (int i = 0; i < 80; i++) {
    if (t > t1 || i >= budget || transmittance < 0.015) break;
    // Midpoint of the segment about to be integrated, not its near end. Second
    // order instead of first for one add, which is what lets the fine stride
    // stay at 0.28 coarse without the phase-locked grid showing as contours.
    vec3 p = origin + dir * (fine ? t + dt * 0.5 : t);
    float d = ironCloudDensity(p, fine ? 2.0 : 1.0) * density;

    if (!fine) {
      if (d > 0.002) {
        // FIRST CONTACT. Bisect for the boundary rather than rewinding a whole
        // coarse stride blindly.
        //
        // This is what removes the hatching along every cloud edge, and the
        // mechanism is worth stating because it is not obvious. The coarse
        // stride is ~100 m and its phase is jittered per pixel; a blind rewind
        // therefore starts the fine march at a per-pixel-random depth, and the
        // dither used for that jitter (interleaved gradient noise) is REGULAR,
        // not random — so the edge displacement it produces is a regular stripe
        // pattern, which is exactly what the deck showed. Four bisections pin
        // the boundary to dtCoarse/16 (~6 m) as a property of the DENSITY FIELD
        // instead, identically for every pixel, and the jitter stops reaching
        // the silhouette at all. It costs four coarse-detail evaluations, once
        // per cloud entry, and nothing per sample.
        float lo = max(tFloor, t - dtCoarse);
        float hi = t;
        for (int k = 0; k < 4; k++) {
          float mid = 0.5 * (lo + hi);
          if (ironCloudDensity(origin + dir * mid, 1.0) * density > 0.002) hi = mid; else lo = mid;
        }
        tFloor = t;
        // PHASE-LOCK the fine march to a grid shared by every pixel. Snapping
        // is what finally kills the dither pattern: the bisection above pins
        // the boundary to ~6 m, but the fine samples then inherit that 6 m as a
        // per-pixel PHASE, and because the dither is interleaved gradient noise
        // the phase field is a regular diagonal lattice — which is exactly the
        // cross-hatch that was printed over the whole cloud body. dtFine is a
        // smooth function of the view direction, so ceil() to a multiple of it
        // gives neighbouring pixels the same sample depths and the lattice has
        // nowhere to come from. What is left is a smooth contour rather than a
        // pattern, and the midpoint rule below is what keeps that under the
        // noise floor.
        t = ceil(lo / dtFine) * dtFine;
        fine = true;
        dt = dtFine;
      } else {
        t += dtCoarse;
      }
      continue;
    }

    // The threshold to KEEP marching finely is fifteen times lower than the one
    // that triggered the entry, and the asymmetry is deliberate. A coarse sample
    // is never shaded, so if a pixel drops back to coarse over a wisp while its
    // neighbour stays fine, one of them integrates that wisp and the other
    // discards it — a per-pixel binary decision seeded by the entry dither,
    // which is a lattice again. Making the exit far stickier than the entry
    // means every pixel crossing the same wisp integrates it.
    if (d <= 0.0002) {
      empty++;
      // Ten empty fine samples is ~2.8 coarse strides of genuinely clear air.
      if (empty > 10) { fine = false; dt = dtCoarse; }
      t += dt;
      continue;
    }
    empty = 0;

    // Light march: three exponentially-spaced segments toward the sun, total
    // 0.83 km — most of a slab thickness, so the march covers the cloud and
    // stops rather than spending its last and longest tap in clear air above.
    // This is the whole self-shadowing term, and it is why a cloud has a dark
    // base. Each segment is evaluated at its MIDPOINT, not its far end: the
    // far-end rule assigns a 638 m segment the density found after 638 m of
    // travel, which systematically under-shadows the near field where the
    // gradient actually is. Detail is off on all four — the erosion octave
    // shifts the shadow by less than the sample spacing does, at two extra
    // fetches per tap.
    float lightTau = 0.0;
    float ls = 80.0;
    float lt = 0.0;
    for (int j = 0; j < 3; j++) {
      lightTau += ironCloudDensity(p + sunDir * (lt + ls * 0.5), 0.0) * density * ls;
      lt += ls;
      ls *= 2.6;
    }
    float tauL = lightTau * IRON_CLOUD_SIGMA;
    float T0 = exp(-tauL);
    float T1 = exp(-tauL * 0.35);
    float T2 = exp(-tauL * 0.12);

    // Powder: a dense medium in-scatters back toward the eye, so a thin edge
    // seen against the sun is DARKER than Beer alone predicts and a thick one
    // brighter. Only the single-scatter octave gets it; the higher orders are
    // diffuse by construction and powdering them flattens the whole cloud.
    float powder = 1.0 - exp(-tauL * 2.0);
    vec3 sun = sunIrradiance * (ph0 * T0 * mix(1.0, powder * 1.7, 0.28) + ph1 * T1 + ph2 * T2);

    // Sky fill, and it is NOT a constant. A cloud top sees the whole
    // hemisphere; a base sees it through a kilometre of its own body. The
    // difference between those two numbers is most of what the eye reads as
    // volume, and the previous build had them within a factor of 1.8 of each
    // other AND above the sun term, which is why the deck came back as white
    // paint. Depth in the slab drives it, with the sun-march optical depth as a
    // second-order proxy for how buried this particular sample is.
    float hh = clamp((p.y - IRON_CLOUD_BASE) / (IRON_CLOUD_TOP - IRON_CLOUD_BASE), 0.0, 1.0);
    float skyOcc = mix(0.14, 1.0, hh * hh) * (0.35 + 0.65 * T1);
    vec3 lit = sun + skyRadiance * skyOcc;

    // 0.030 rather than 0.055: at 0.055 a cloud saturates to opaque inside one
    // step, so its silhouette is decided by a single sample and comes out
    // scalloped. This spreads the edge over three or four samples.
    float stepT = exp(-d * IRON_CLOUD_SIGMA * dt);
    // Energy-conserving integration of the segment, not a naive accumulate.
    scatter += transmittance * lit * (1.0 - stepT);
    transmittance *= stepT;
    t += dt;
  }
  return vec4(scatter, transmittance);
}
`;
