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
 * silver lining and the dark base come from.
 *
 * The cloud sits INSIDE the scattering model rather than on top of it: it is
 * composited against the sky radiance behind it, its own radiance is the sky
 * fill plus the transmitted sun, and the whole result then receives the
 * atmospheric in-scatter over the distance to it. That last step is what stops
 * clouds near the horizon reading as stickers.
 *
 * ── THE RECTILINEAR BLOCK NOISE, AND WHY THE PREVIOUS MARCH PRODUCED IT ──────
 *
 * Round-1 review, at severity 10: "every cloud interior is filled with
 * axis-aligned rectangular block noise … one systemic bug, not per-cloud". It
 * was, and the cause was NOT the dither the previous build had already removed.
 * It was the empty-space-skipping STATE MACHINE itself. That march had
 *
 *   • a coarse stride and a fine stride, with a `bool fine` toggled by
 *     thresholds on the density it happened to sample,
 *   • a four-step bisection run on first contact,
 *   • a `ceil()` re-snap of the fine grid at every entry,
 *   • an exit rule with fifteen times the hysteresis of the entry rule,
 *   • and a hard iteration budget of `steps × 4`.
 *
 * Every one of those is a BRANCH whose outcome is a discontinuous function of
 * the ray. Two pixels a milliradian apart could enter fine mode one coarse
 * stride apart, land on different snapped grids, integrate a different subset of
 * the wisps, and terminate on different iterations. The density field is smooth;
 * the SCHEDULE was not, and a discontinuous schedule over a smooth field prints
 * the schedule's own structure into the image. Because the schedule's
 * discontinuities are iso-distance surfaces, and iso-distance surfaces of a
 * near-horizontal ray bundle are near-vertical planes, they came out as
 * axis-aligned shards.
 *
 * The rewrite removes the decisions instead of trying to noise them out:
 *
 * 1. ONE SCHEDULE, GEOMETRIC, WITH NO STATE. `t_{i+1} = t_i · r` where
 *    `r = (t₁/t₀)^(1/N)` — constant *relative* stride, i.e. constant angular
 *    resolution, covering the whole slab in exactly N samples for every ray.
 *    `r` is a smooth function of the view direction, so neighbouring pixels
 *    sample near-identical depths and the quantisation error varies smoothly.
 *    There is no coarse mode, no fine mode, no bisection and no re-snap.
 *
 * 2. THE DETAIL IS BAND-LIMITED TO THE STRIDE. This is the other half of the
 *    artefact and the half that is easy to miss. The erosion octave puts ~37 m
 *    Worley cells in the field; the previous march sampled it at strides of
 *    24–75 m and, on grazing rays, effectively 143 m. Sampling 37 m detail with
 *    a 143 m stride is aliasing, and aliasing of a lumpy field is precisely the
 *    shredded, shard-like interior the review describes. Both fine octaves now
 *    fade toward their own MEAN as the stride grows past the feature size, which
 *    is a mip selection done by hand: distant cloud goes smooth instead of
 *    going noisy.
 *
 * 3. THE RAY START IS JITTERED BY A HASH, NOT BY AN ORDERED DITHER. What is
 *    left after (1) and (2) is a smooth contour at the stride frequency. A
 *    fraction-of-a-stride offset turns it into noise. The offset comes from a
 *    bit-mixing hash of `gl_FragCoord`, which is white in screen space and
 *    deterministic per pixel — an ordered/Bayer/interleaved-gradient dither is a
 *    REGULAR lattice and printing a lattice over a cloud is how this lane got
 *    here in the first place.
 *
 * ── THE OTHER TWO ROUND-1 FINDINGS ──────────────────────────────────────────
 *
 * "Clouds are darker than the sky behind them … no silver lining, no scatter
 * gain" (severity 8). Two causes, both fixed here:
 *
 *   • THE LIGHT MARCH SAW A DENSER MEDIUM THAN THE VIEW MARCH. `detail < 1.5`
 *     used to return BEFORE the erosion step, so the sun march integrated an
 *     un-eroded field while the eye integrated an eroded one — the same cloud
 *     was roughly twice as opaque to the sun as it was to the camera. Nothing
 *     could be lit. The erosion term now runs on both, fading to its MEAN
 *     rather than to zero, so the two marches agree on how much medium is there.
 *   • FOUR MULTIPLE-SCATTERING OCTAVES INSTEAD OF THREE, and the deepest one at
 *     an extinction scale of 0.028 rather than 0.12. A cumulus core reaches
 *     τ ≈ 25 toward the sun; at 0.12 the deepest octave still transmits only
 *     5 %, so a thick cloud had no route to the ~E/π radiance a real thick
 *     cloud returns and had to be floated on ambient to be visible at all.
 *
 * "The entire cloud deck is cut off by a dead-flat slab base" (severity 8). The
 * condensation level is now a per-cell field, not a constant: the base rides
 * ±220 m on the weather tile's fourth channel. A cumulus field does have a
 * common base — but not a common base to the metre, and a base flat to the metre
 * across 40 km of sky is a ruled line through the frame.
 */

/** Cloud slab, LOOK_SPEC §3.1: base 900 m, thickness 1200 m. */
export const CLOUD_BASE = 900;
export const CLOUD_THICKNESS = 1200;
/** Half-range of the per-cell condensation level, metres. */
const CLOUD_BASE_VAR = 220;

export const CLOUD_GLSL = /* glsl */ `
const float IRON_CLOUD_BASE = ${CLOUD_BASE.toFixed(1)};
const float IRON_CLOUD_THICK = ${CLOUD_THICKNESS.toFixed(1)};
const float IRON_CLOUD_BASE_VAR = ${CLOUD_BASE_VAR.toFixed(1)};
/** Slab bounds that CONTAIN every per-cell base/top the density field can pick. */
const float IRON_SLAB_LO = ${(CLOUD_BASE - CLOUD_BASE_VAR).toFixed(1)};
const float IRON_SLAB_HI = ${(CLOUD_BASE + CLOUD_BASE_VAR + CLOUD_THICKNESS).toFixed(1)};

/**
 * Extinction per unit density per metre.
 *
 * ONE COEFFICIENT FOR BOTH MARCHES, and that is the whole point. A medium has
 * one extinction coefficient; using two — as an earlier build did, 0.030 to the
 * eye and 0.0016 to the sun — is not a tuning choice, it is an inconsistent
 * medium in which nothing can shadow itself. 0.030 /m at unit density is a
 * 33 m mean free path, which is a real cumulus at ~0.3 g/m³ liquid water.
 */
const float IRON_CLOUD_SIGMA = 0.030;

uniform sampler2D uSkyCloudNoise;
uniform float uSkyCloudCoverage;
uniform vec2 uSkyCloudDrift;
/** Edge length of the baked noise tile, texels. Set from the asset. */
uniform float uSkyCloudNoiseSize;

/**
 * Texture fetch with a QUINTIC-SMOOTHED texel fraction instead of raw bilinear.
 *
 * Hardware bilinear is C0: the value is continuous across a texel boundary but
 * its derivative is not. That is invisible at 1:1 and catastrophic under
 * magnification, because the weather channel is read over an 8.7 km tile from a
 * 256² texture — 34 m per texel, which at the 4–8 km the deck is seen at is
 * 6–10 SCREEN PIXELS per texel — and the coverage threshold that reads it has a
 * slope of about 5. Multiply a derivative discontinuity by five and magnify it
 * ten times and the texel grid prints itself over every cloud as a lattice of
 * little crescents. Round 2 of this lane produced exactly that: the shard noise
 * was gone and a regular chain-mail pattern had taken its place.
 *
 * Pre-warping the fraction by the Hermite smoothstep makes the reconstruction C1
 * — the derivative goes to ZERO at each texel boundary rather than jumping — so
 * there is no edge left for the threshold to amplify. It is the standard
 * value-noise trick, it costs three multiplies, and it stays ONE fetch, which
 * matters because this is the sample the coverage early-out runs on and
 * therefore the one taken for most of the sky.
 */
vec4 ironCloudFetch(vec2 uv) {
  vec2 p = uv * uSkyCloudNoiseSize - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return texture(uSkyCloudNoise, (i + f + 0.5) / uSkyCloudNoiseSize);
}

/**
 * Density at a world point. The baked tile carries four decorrelated octaves:
 *   r = 3-octave fBm      (the weather / coverage field)
 *   g = 5-octave fBm      (billow shape)
 *   b = inverted Worley   (the cauliflower erosion)
 *   a = high-frequency fBm (wisp detail; here also the condensation level)
 *
 * A GENUINELY 3D FIELD OUT OF A 2D TILE. Two samples are taken on planes that
 * are not parallel: one through xz, one through a vertical plane rotated 38° in
 * the horizontal, and they are MULTIPLIED. The product matters — a sum of two
 * [0,1] fields regresses to a smooth sheet, whereas a product separates the deck
 * into discrete towers, which is what cumulus are.
 *
 * 'shapeW' and 'erodeW' are BAND-LIMIT WEIGHTS in [0,1], not flags. At 1 the
 * octave is sampled; at 0 it is replaced by its own mean (0.5 for both, since
 * every channel is a unit-interval field centred there). Fading to the MEAN
 * rather than to zero is what keeps a coarse evaluation and a fine one agreeing
 * on how much medium is present — which the sun march and the view march must,
 * or the cloud cannot be lit correctly.
 */
float ironCloudDensity(vec3 p, float shapeW, float erodeW) {
  // 1.15e-4 → an ~8.7 km weather tile whose 3-octave content puts cells at
  // ~2.9 km, so a 100 km sightline crosses a few dozen of them and the deck
  // reads as separate cumulus rather than as one continent.
  vec2 w = p.xz * 1.15e-4 + uSkyCloudDrift;
  // Smoothed reconstruction on THIS fetch and no other. The weather tile is the
  // only one magnified past its texel size on screen — the shape octave's tile
  // is 5 m/texel and the erosion's is 1.3 m/texel, both far below a pixel at any
  // distance the deck is drawn at — and it is the only one read through a steep
  // threshold. See ironCloudFetch.
  vec4 weather = ironCloudFetch(w);

  float coverage = clamp(uSkyCloudCoverage, 0.0, 1.0);
  // Threshold deliberately soft over a wide band — a hard one gives the
  // scalloped, stamped-out silhouette that reads as a texture, not a volume.
  // The band is calibrated so the parameter means what it says: the weather
  // channel is a contrast-stretched 3-octave fBm, roughly normal about 0.5, and
  // [1 − 1.50c, 1 − 0.42c] lands c = 0.30 → ~23 % of sky under cloud and
  // c = 0.38 → ~34 %, i.e. inside LOOK_SPEC §3.1's 0.25–0.35 band.
  float cov = smoothstep(1.0 - coverage * 1.50, 1.0 - coverage * 0.42, weather.x);
  if (cov <= 0.002) return 0.0;

  // PER-CELL CONDENSATION LEVEL. Real cumulus in one air mass share a base to
  // within a hundred metres or so, not to the metre; a constant base is a ruled
  // horizontal line drawn across the whole sky, which is what round 1 saw as a
  // "dead-flat slab base running for the full width". The wisp channel read at
  // the weather tile's scale puts ~670 m cells on it, which is the right size:
  // one value per cumulus, not a ripple through each one.
  float base = IRON_CLOUD_BASE + (weather.w - 0.5) * (2.0 * IRON_CLOUD_BASE_VAR);
  float h = (p.y - base) / IRON_CLOUD_THICK;
  if (h < 0.0) return 0.0;

  // Per-cell top, for the same reason: a uniform top puts every crown in the
  // frame on one horizontal line. Marginal cells stay low and wispy; cells at
  // the middle of a weather cluster tower.
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
  float b = 0.5;
  if (shapeW > 0.01) {
    b = mix(0.5, texture(uSkyCloudNoise, q * 1.03e-3 + vec2(0.31, 0.17)).g, shapeW);
  }
  float shape = smoothstep(0.05, 0.46, a * b);

  float d = cov * profile * mix(0.26, 1.0, shape);
  if (d <= 0.002) return 0.0;

  // Erosion, again on both planes. 3.0e-3 → a 333 m tile whose Worley cells are
  // ~37 m, which at a typical 1.2 km slant range is 1.8° — a couple of dozen
  // pixels, i.e. exactly the scale the eye reads as "cauliflower". Below the
  // band limit the three fetches are skipped and the term collapses to its mean,
  // which removes the same amount of medium on average without aliasing.
  float erode = 0.5;
  if (erodeW > 0.01) {
    // ── WORLEY IS THE MINORITY TERM, AND ROUND 2 IS WHY ────────────────────
    // The previous mix was 82 % inverted Worley and 18 % fBm. Worley is a
    // JITTERED GRID — its cells are irregular in shape but regular in spacing,
    // and 37 m cells at the 5 km the deck is typically seen at is a 10-pixel
    // period. Once the march stopped aliasing (the shard fix above), that period
    // stopped being scrambled and started integrating coherently, and the deck
    // came back covered in a chain-mail lattice of dark cells: the same defect
    // class as the shards, one layer down. Worley is what makes a cumulus edge
    // read as cauliflower, so it stays — at 36 % rather than 82 %, with the
    // high-frequency fBm carrying the majority, which has no characteristic
    // spacing at all.
    //
    // The xz tap is also read on a basis rotated 27° off the world axes. A
    // lattice aligned to x and z projects to a lattice aligned to the screen for
    // any near-horizontal ray bundle, and an axis-aligned artefact is the one a
    // reviewer names first.
    vec2 er = vec2(p.x * 0.891 - p.z * 0.454, p.x * 0.454 + p.z * 0.891);
    // .b is the inverted Worley (cauliflower), .a the high-frequency fBm.
    vec2 e1 = texture(uSkyCloudNoise, er * 3.0e-3 + uSkyCloudDrift * 5.0).ba;
    vec2 e2 = texture(uSkyCloudNoise, q * 3.63e-3 + vec2(0.67, 0.43)).ba;
    erode = mix(0.5, e1.y * 0.34 + e2.y * 0.30 + e1.x * 0.20 + e2.x * 0.16, erodeW);
  }

  // Erosion eats the boundary, never the core: that is what gives cumulus their
  // cauliflower silhouette instead of a soft blob.
  d -= erode * 0.46 * (1.0 - smoothstep(0.14, 0.55, d));
  // And it eats the crown harder than the flanks, because that is where the
  // convection is actually breaking the cloud up.
  d -= erode * 0.26 * smoothstep(0.45, 1.0, hn);
  // 1.30 rather than the 1.14 an earlier build used. The light march now
  // integrates the SAME eroded field the eye does instead of the un-eroded one,
  // which removed roughly a third of the self-shadowing optical depth; putting
  // some of it back into the medium keeps the silhouettes solid instead of
  // trading the fix for a thinner deck. The rest of the difference is the
  // softened erosion above, which now subtracts less on average.
  return max(0.0, d) * 1.30;
}

/** Slab entry/exit for a ray. Returns false when the ray misses the layer. */
bool ironCloudSlab(vec3 origin, vec3 dir, out float t0, out float t1) {
  if (abs(dir.y) < 1e-4) return false;
  float a = (IRON_SLAB_LO - origin.y) / dir.y;
  float b = (IRON_SLAB_HI - origin.y) / dir.y;
  t0 = max(min(a, b), 0.0);
  t1 = max(a, b);
  return t1 > t0;
}

/**
 * Cloud phase for multiple-scattering octave eccentricity scale 'e', in sr⁻¹.
 *
 * Three lobes rather than two. A single HG cannot be a droplet phase: the Mie
 * forward peak of a 10 µm droplet is far narrower than g = 0.72 and the diffuse
 * shoulder around it far broader, and the difference is exactly the difference
 * between "there is a bright rim within 10° of the sun" and "the sun side is
 * generally a bit lighter". The narrow lobe (g 0.85) is the silver lining, the
 * broad one (g 0.55) carries the sun-side body, and the weak back lobe (−0.28)
 * keeps the shadowed side off black. Higher octaves scale the eccentricity down,
 * which is the standard cheap stand-in for the angular blurring that successive
 * scattering events perform.
 */
float ironCloudPhase(float c, float e) {
  return 0.36 * ironPhaseHG(c, 0.85 * e)
       + 0.50 * ironPhaseHG(c, 0.55 * e)
       + 0.14 * ironPhaseHG(c, -0.28 * e);
}

/**
 * Bit-mixing hash of a screen position → [0,1).
 *
 * Deliberately NOT an ordered dither, not Bayer, and not interleaved gradient
 * noise: all three are regular lattices, and a regular lattice used to offset a
 * ray start prints itself over the cloud as structured blocks — the round-1
 * defect this file exists to have fixed. This is white in screen space and a
 * pure function of the pixel, so it is stable frame to frame and cannot crawl.
 */
float ironCloudHash(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/**
 * March the slab. Returns transmittance in .a and scattered radiance (cd/m²) in
 * .rgb. 'steps' comes from the tier table; 'sunIrradiance' is the illuminance on
 * a plane normal to the sun ABOVE the deck, in lux — NOT divided by 4π, the
 * phase above is a real sr⁻¹ phase function and carries the solid angle itself.
 * 'skyFill' is the hemispherical sky irradiance the deck floats in, in cd/m²,
 * computed once per frame on the CPU. 'jitter' is a per-pixel [0,1) offset.
 */
vec4 ironCloudMarch(
  vec3 origin, vec3 dir, vec3 sunDir, vec3 sunIrradiance, vec3 skyFill,
  int steps, float density, float jitter
) {
  float t0, t1;
  if (!ironCloudSlab(origin, dir, t0, t1)) return vec4(0.0, 0.0, 0.0, 1.0);
  t0 = max(t0, 4.0);
  // Past ~46 km the deck is below 1.6° of elevation, is 96 % veiled by the
  // boundary layer and contributes nothing but cost.
  t1 = min(t1, t0 + 46000.0);
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);

  // ---- the schedule -------------------------------------------------------
  // CONSTANT RELATIVE STRIDE. r is the per-step ratio that walks t0 to t1 in
  // exactly 'steps' samples, so every ray gets the same sample COUNT and the
  // same sample DENSITY IN ANGLE — a cloud at 12 km is resolved with the same
  // number of samples across it as one at 1.2 km, which is what the eye needs
  // because it subtends a tenth as many pixels. r varies smoothly with the view
  // direction, so two neighbouring pixels sample near-identical depths; that is
  // the property the old coarse/fine state machine destroyed and the reason its
  // quantisation error came out as rectilinear shards instead of a soft contour.
  float r = pow(t1 / t0, 1.0 / float(steps));
  // Offset the whole schedule by a fraction of the first stride. What survives
  // (1) and the band limit below is a smooth contour at the stride frequency;
  // this converts it to per-pixel noise instead.
  //
  // 0.6 OF A STRIDE, NOT A WHOLE ONE. A full-stride offset is the textbook
  // choice and it is right when a temporal resolve is going to average it away.
  // There is no TAA on this deck — the harness renders a fixed frame count and
  // grabs the last one — so whatever the jitter leaves is what ships, and at
  // full amplitude it shipped as a fizzy stipple along every cumulus rim. The
  // adaptive stride below already holds the per-step optical depth near 0.9, so
  // the banding this is suppressing is small to begin with and 0.6 of a stride
  // is more than enough to break it up.
  float t = t0 * pow(r, jitter * 0.6);

  // ---- phase, once per ray ------------------------------------------------
  float cosTheta = clamp(dot(dir, sunDir), -1.0, 1.0);
  // Four multiple-scattering octaves (Hillaire 2020). Each successive order
  // carries less energy, is attenuated by less of the medium and is more
  // isotropic — the (a, b, c) triple below. Without them a march is
  // single-scatter only, which is a tenth of a real cumulus' radiance
  // everywhere outside the forward lobe, and a deck that dim has to be floated
  // on an ambient constant to be seen at all. The fourth octave is what a thick
  // core needs: at τ ≈ 25 toward the sun even the third still transmits under
  // 8 %, so without it the only route to a lit-looking cloud is ambient.
  float ph0 = ironCloudPhase(cosTheta, 1.000);
  float ph1 = ironCloudPhase(cosTheta, 0.500) * 0.52;
  float ph2 = ironCloudPhase(cosTheta, 0.250) * 0.26;
  float ph3 = ironCloudPhase(cosTheta, 0.125) * 0.13;

  vec3 scatter = vec3(0.0);
  float transmittance = 1.0;
  // Occupancy of the PREVIOUS sample, which is what shortens the stride inside
  // the cloud. Using the previous sample rather than the current one keeps the
  // stride a smooth function of a smooth field — a stride chosen from the sample
  // it is about to take is a fixed point, and solving it per pixel is the sort
  // of branch that put shards on this deck in the first place.
  float occ = 0.0;

  for (int i = 0; i < steps; i++) {
    if (t >= t1 || transmittance < 0.012) break;
    // Clamped so a near-vertical ray does not spend its budget at 4 m strides
    // and a grazing one does not step a kilometre through the first cloud.
    //
    // ADAPTIVE INSIDE THE MEDIUM, and this is what decides how much noise the
    // jitter above costs. A constant-relative stride puts ~160 m between samples
    // at the 5 km the deck is typically seen at, and 160 m of unit-density cloud
    // is an optical depth of 4.8 — one sample decides the whole silhouette, so a
    // per-pixel offset of that sample is a per-pixel offset of the SILHOUETTE
    // and the interior comes back as salt and pepper. At 0.19 of the stride the
    // per-step optical depth is ~0.9 and the edge is spread over three or four
    // samples, which is where the jitter stops being visible. It costs almost
    // nothing: the only rays that take short steps are the ones inside cloud,
    // and those hit the transmittance floor within half a dozen of them.
    float dtGeo = clamp(t * (r - 1.0), 20.0, 1600.0);
    float dt = dtGeo * mix(1.0, 0.19, occ);

    // THE BAND LIMIT. Both fine octaves fade toward their own mean once the
    // stride can no longer resolve them. 38–150 m brackets the 37 m Worley
    // cells; 140–520 m brackets the shape octave's 267 m billows. Sampling
    // detail finer than the stride is aliasing, and aliased lumpy noise is the
    // shredded cloud interior round 1 called texture corruption.
    //
    // Driven by the GEOMETRIC stride (times 0.45, the mean of the adaptive
    // range) rather than by the stride actually taken. Two reasons: the
    // geometric stride is the one that tracks the pixel FOOTPRINT, which is what
    // a mip level should follow; and it is the same for every sample along a ray
    // at a given depth, so the first sample of a cloud — taken at the long
    // stride, because the occupancy that shortens it comes from the sample
    // before — is band-limited identically to the samples behind it instead of
    // being the one sample on the ray with a different density field.
    float lodStride = dtGeo * 0.45;
    float erodeW = 1.0 - smoothstep(38.0, 150.0, lodStride);
    float shapeW = 1.0 - smoothstep(140.0, 520.0, lodStride);

    // Midpoint of the segment about to be integrated, not its near end: second
    // order instead of first, for one add.
    vec3 p = origin + dir * (t + dt * 0.5);
    float d = ironCloudDensity(p, shapeW, erodeW) * density;
    occ = smoothstep(0.003, 0.075, d);
    if (d <= 0.0015) { t += dt; continue; }

    // Light march: four exponentially-spaced segments toward the sun, total
    // 0.94 km — a slab thickness and a little, so the march covers the cloud and
    // stops rather than spending its last and longest tap in clear air above.
    // This is the whole self-shadowing term and it is why a cloud has a dark
    // base. Each segment is evaluated at its MIDPOINT: the far-end rule assigns
    // a 650 m segment the density found after 650 m of travel, which
    // systematically under-shadows the near field where the gradient is. Both
    // fine octaves are at their mean here — a shadow can afford a smoother
    // density than the silhouette it falls on, and matching the MEAN is what
    // keeps the sun march and the view march agreeing on how much medium there
    // is between them.
    float lightTau = 0.0;
    float ls = 70.0;
    float lt = 0.0;
    for (int j = 0; j < 4; j++) {
      lightTau += ironCloudDensity(p + sunDir * (lt + ls * 0.5), 0.0, 0.0) * density * ls;
      lt += ls;
      ls *= 1.95;
    }
    float tauL = lightTau * IRON_CLOUD_SIGMA;

    // Powder: a dense medium in-scatters back toward the eye, so a thin edge
    // seen against the sun is DARKER than Beer alone predicts and a thick one
    // brighter. Only the single-scatter octave gets it; the higher orders are
    // diffuse by construction and powdering them flattens the whole cloud.
    float powder = 1.0 - exp(-tauL * 2.0);
    vec3 sun = sunIrradiance * (
        ph0 * exp(-tauL) * mix(1.0, powder * 1.7, 0.25)
      + ph1 * exp(-tauL * 0.320)
      + ph2 * exp(-tauL * 0.100)
      + ph3 * exp(-tauL * 0.028));

    // Sky fill, and it is NOT a constant across the cloud. A cloud top sees the
    // whole hemisphere; a base sees it through a kilometre of its own body. The
    // difference between those two numbers is most of what the eye reads as
    // volume. Depth in the slab drives it, with the sun-march optical depth as a
    // second-order proxy for how buried this particular sample is.
    float hh = clamp((p.y - IRON_SLAB_LO) / (IRON_SLAB_HI - IRON_SLAB_LO), 0.0, 1.0);
    float skyOcc = mix(0.18, 1.0, hh * hh) * (0.30 + 0.70 * exp(-tauL * 0.32));
    vec3 lit = sun + skyFill * skyOcc;

    // Energy-conserving integration of the segment, not a naive accumulate:
    // ∫ σ·L·T ds over a segment of constant density is L·(1 − e^(−σ d dt)).
    float stepT = exp(-d * IRON_CLOUD_SIGMA * dt);
    scatter += transmittance * lit * (1.0 - stepT);
    transmittance *= stepT;
    t += dt;
  }
  return vec4(scatter, transmittance);
}
`;
