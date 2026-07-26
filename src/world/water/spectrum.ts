/**
 * The wave spectrum — WATER's model of the sea state.
 *
 * OWNER: WATER.
 *
 * A Gerstner hierarchy, not a stack of hand-picked sines. The amplitudes come
 * from a Phillips spectrum evaluated at each component's wavenumber and then
 * renormalised so the whole set carries a chosen significant wave height, which
 * is the number a person can actually reason about ("Hs 0.8 m" is a working
 * harbour; "amplitude 0.14" is nothing).
 *
 * FOUR BANDS, BECAUSE THEY ARE CONSUMED IN FOUR DIFFERENT PLACES:
 *
 *   SWELL   58–132 m   displaces geometry, drives buoyancy, tight directional
 *                      spread (swell has travelled and has forgotten the local
 *                      wind), and is the reason the sea has a silhouette at all
 *   CROSS   30–64 m    displaces geometry, runs 62° off the wind. THE SECOND
 *                      WAVE SYSTEM, and it is not a decoration. A sea built
 *                      from one bearing produces parallel diagonal corduroy at
 *                      one wavelength — the single loudest "this is a sum of
 *                      sines" tell there is. Every real coast carries a remote
 *                      swell that arrives on a different bearing from the local
 *                      wind sea, and the interference between the two is what
 *                      makes crests short-crested: they build, run a few
 *                      wavelengths and die, instead of striping the frame.
 *   CHOP     7–34 m    displaces geometry, wide spread, carries the crests that
 *                      break into whitecaps
 *   RIPPLE 0.09–4.5 m  NORMAL ONLY, evaluated per-fragment. These are the waves
 *                      the glitter path is actually made of: at 11° sun a 1.5 m
 *                      ripple with 8 cm amplitude has a 20° slope, which is
 *                      exactly the facet population that throws the sun at the
 *                      camera. Displacing them in the mesh would need a 20 cm
 *                      tessellation and would alias anyway.
 *                      THE BAND RUNS DOWN TO 9 cm, and that is what keeps the
 *                      near field from going to plastic. A pixel at 3 m covers
 *                      about 7 mm of sea, so a 9 cm capillary is eleven pixels
 *                      across and fully resolved; at 60 m the same wave is a
 *                      fifth of a pixel and the shader's band limit has already
 *                      handed its slope to the roughness term. That hand-off is
 *                      a LOD blend, not a fade to flat — the energy never
 *                      leaves the frame, it changes from a normal into a
 *                      roughness.
 *
 * EVERYTHING HERE IS EVALUATED TWICE — once in TypeScript for buoyancy,
 * `heightAt` and `normalAt`, and once in GLSL for the surface itself. The two
 * must agree exactly or players float over crests, so the wave table is the
 * single source of truth and both sides read the same numbers out of it.
 */
import type { Rng } from '@/engine/types';

export const SWELL_COUNT = 3;
export const CROSS_COUNT = 2;
export const CHOP_COUNT = 5;
export const RIPPLE_COUNT = 8;
/** Bands that displace geometry. The CPU height query evaluates exactly these. */
export const DISPLACING_COUNT = SWELL_COUNT + CROSS_COUNT + CHOP_COUNT;
export const WAVE_COUNT = DISPLACING_COUNT + RIPPLE_COUNT;

/** Standard gravity. Deep-water dispersion is ω = √(gk) and nothing else. */
const G = 9.80665;

/**
 * Cutoff wavelengths of the slope-variance LUT, in metres, ascending.
 *
 * The bottom of the ladder is the shortest wave in the spectrum, not the
 * shortest wave anyone expects to see: the LUT's job is to tell a fragment how
 * much slope lives BELOW its own footprint, so if the table starts above a band
 * that band's variance is invisible to it and the water loses that energy
 * instead of converting it to roughness. `ironWaterVariance` maps λ onto this
 * ladder in log space, so the two ends here and the two ends there are one
 * number and must move together.
 */
export const VARIANCE_LUT_LAMBDA = [0.09, 0.22, 0.55, 1.4, 3.5, 9.0, 30.0, 140.0] as const;
/** Bottom and top of that ladder, exported so the shader cannot drift from it. */
export const VARIANCE_LUT_MIN = VARIANCE_LUT_LAMBDA[0];
export const VARIANCE_LUT_MAX = VARIANCE_LUT_LAMBDA[VARIANCE_LUT_LAMBDA.length - 1];

export interface WaveTable {
  /** Per wave, `vec4(dirX, dirZ, k, omega)`. */
  readonly a: Float32Array;
  /**
   * Per wave, `vec4(amplitude, steepness·amplitude, phase, 0)`. The second
   * component is pre-multiplied because every consumer wants `QA`, never `Q`.
   */
  readonly b: Float32Array;
  /**
   * Cumulative mean-square surface slope carried by every component whose
   * wavelength is BELOW `VARIANCE_LUT_LAMBDA[i]`, packed as two vec4s.
   *
   * This is what turns distant sea from a field of aliasing white dots into a
   * coherent glitter path: a pixel two kilometres out covers thousands of
   * ripples, so their slope distribution is a ROUGHNESS, not a normal. The
   * shader looks the cutoff up from its own footprint and folds the unresolved
   * variance into GGX α.
   */
  readonly varianceLut: Float32Array;
  /** 4√m0. The number the sea state is actually authored in. */
  readonly significantHeight: number;
  /** Unit wind vector in XZ, the direction the sea is running toward. */
  readonly windX: number;
  readonly windZ: number;
}

interface BandSpec {
  readonly count: number;
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /** Half-angle of the directional spread, radians. */
  readonly spread: number;
  /** Mean bearing of the band, as an offset from the wind bearing, radians. */
  readonly bearing: number;
  /** Share of the total variance this band is allowed to carry. */
  readonly variance: number;
}

/**
 * The four bands. The variance split is the sea state's character: half in the
 * primary swell gives a harbour with a long, calm heave under it; pushing it
 * into the chop gives a windier, choppier, less Mediterranean sea.
 *
 * The RIPPLE share is 0.09 rather than the 0.05 it was, and the band now runs
 * an octave and a half further down. Both changes buy the same thing: mean-
 * square slope. Cox and Munk measured mss ≈ 0.003 + 0.00512·U for a clean sea,
 * which at our 4.5 m/s breeze is 0.026 — rms slope 9°, and essentially all of it
 * lives below a metre of wavelength. A spectrum that stops at 0.7 m carries
 * about a third of that, and a sea missing two thirds of its slope variance has
 * a glitter path a third as wide and a near field with nothing in it.
 */
const BANDS: readonly BandSpec[] = [
  { count: SWELL_COUNT, lambdaMin: 58, lambdaMax: 132, spread: 0.24, bearing: 0, variance: 0.5 },
  // 62° off the wind, the classic remote-swell-against-wind-sea angle. Wide
  // enough that the two systems beat rather than lock, narrow enough that it
  // still reads as a swell and not as noise.
  { count: CROSS_COUNT, lambdaMin: 30, lambdaMax: 64, spread: 0.3, bearing: 1.08, variance: 0.14 },
  { count: CHOP_COUNT, lambdaMin: 7, lambdaMax: 34, spread: 0.66, bearing: -0.26, variance: 0.27 },
  {
    count: RIPPLE_COUNT,
    lambdaMin: 0.09,
    lambdaMax: 4.5,
    spread: 1.08,
    bearing: 0.34,
    variance: 0.09,
  },
];

/**
 * Phillips, in the form that matters here: relative energy against wavenumber
 * for a fully-developed sea under wind speed `v`. The `exp` term is what kills
 * everything longer than the wind can raise; the `k^-4` tail is what makes a
 * real sea's slope spectrum flat enough that the sun finds a facet everywhere.
 */
function phillips(k: number, v: number): number {
  const l = (v * v) / G;
  const kl = k * l;
  return Math.exp(-1 / Math.max(kl * kl, 1e-6)) / Math.pow(k, 4);
}

/**
 * Build the wave table.
 *
 * `windSpeed` seeds the spectrum SHAPE; `significantHeight` sets its scale. The
 * two are separate on purpose: HARBOUR REACH is a sheltered basin open to the
 * west, so the local 4.5 m/s breeze does not explain the swell that comes in
 * past the breakwater. A spectrum built from the local wind alone gives
 * centimetric water, which is the classic "sea looks like a puddle" failure.
 */
export function buildWaveTable(
  rng: Rng,
  windDirectionRad: number,
  windSpeed: number,
  significantHeight: number,
): WaveTable {
  const a = new Float32Array(WAVE_COUNT * 4);
  const b = new Float32Array(WAVE_COUNT * 4);

  // The sea runs WITH the wind. `windDirectionRad` follows the sky service's
  // convention: 0 = toward +Z, increasing toward +X.
  const windX = Math.sin(windDirectionRad);
  const windZ = Math.cos(windDirectionRad);
  // Swell has a longer memory than the local breeze; 8.5 m/s is the fetch the
  // open water west of the headland actually provides.
  const spectrumWind = Math.max(4, windSpeed * 0.55 + 6.1);

  const lambda = new Float32Array(WAVE_COUNT);
  const raw = new Float32Array(WAVE_COUNT);
  const bandOf = new Int32Array(WAVE_COUNT);

  let w = 0;
  for (let bandIndex = 0; bandIndex < BANDS.length; bandIndex++) {
    const band = BANDS[bandIndex];
    for (let i = 0; i < band.count; i++) {
      // Log-spaced with a jittered offset: even spacing in log λ makes octaves
      // beat against each other and the sea visibly repeats.
      const t = (i + 0.5 + rng.range(-0.32, 0.32)) / band.count;
      const lam = band.lambdaMin * Math.pow(band.lambdaMax / band.lambdaMin, t);
      const k = (2 * Math.PI) / lam;

      const theta = windDirectionRad + band.bearing + rng.gaussian() * band.spread * 0.5;
      const dirX = Math.sin(theta);
      const dirZ = Math.cos(theta);
      // cos² directional spreading, the standard shape, plus Phillips' own
      // suppression of components running across the wind.
      const align = Math.max(0, dirX * windX + dirZ * windZ);
      // cos² spreading, floored. Without the floor a band whose mean bearing is
      // far off the wind — which is the entire point of the cross-swell — has
      // components whose directional weight is nearly zero, and the per-band
      // renormalisation below then has to multiply the survivors by hundreds to
      // recover the band's variance. That collapses a five-component band into
      // one enormous sine, which is the artefact this band exists to remove.
      const spread = Math.max(align * align, 0.05);

      const dLam = (lam * Math.log(band.lambdaMax / band.lambdaMin)) / band.count;
      const dk = (2 * Math.PI * dLam) / (lam * lam);
      // THE RING MEASURE, and leaving it out is why the sea had no small waves.
      //
      // `phillips` is the TWO-DIMENSIONAL spectrum S(k⃗) ∝ k⁻⁴. Each component
      // here stands for an annulus of the k-plane of radius k and width dk, and
      // the energy in an annulus is S(k⃗)·(2πk)·dk — the circumference grows
      // with k, so a one-dimensional reduction of a 2D spectrum carries a factor
      // of k that is not optional. Without it every component was weighted one
      // full power of k too steeply: A ∝ k⁻¹·⁵ instead of k⁻¹, so A·k — which
      // IS the surface slope, the only thing the shading actually sees — fell as
      // k⁻⁰·⁵ instead of staying flat.
      //
      // Flat is the correct answer and it is not a coincidence: a k⁻⁴ spectrum
      // is Phillips' SATURATION range, defined as the state where each octave of
      // wavelength carries the same slope variance. Restoring the k puts the sea
      // back in it — total mean-square slope lands at 0.037 against Cox and
      // Munk's measured 0.003 + 0.00512·U = 0.026 for a clean sea at our 4.5 m/s
      // breeze, and the excess is the swell, which their fetch-limited fit does
      // not contain. Before this the ripple band's slope was dominated by its
      // own longest component and the near field had nothing in it.
      const energy = phillips(k, spectrumWind) * k * dk * spread;

      lambda[w] = lam;
      raw[w] = Math.sqrt(Math.max(energy, 1e-12));
      bandOf[w] = bandIndex;
      a[w * 4] = dirX;
      a[w * 4 + 1] = dirZ;
      a[w * 4 + 2] = k;
      a[w * 4 + 3] = Math.sqrt(G * k);
      b[w * 4 + 2] = rng.range(0, Math.PI * 2);
      w++;
    }
  }

  // Renormalise band by band so the authored variance split survives whatever
  // the Phillips evaluation happened to produce, then scale the whole set to the
  // requested significant height. m0 = Σ A²/2, Hs = 4√m0.
  const targetM0 = (significantHeight * significantHeight) / 16;
  for (let bandIndex = 0; bandIndex < BANDS.length; bandIndex++) {
    let sum = 0;
    for (let i = 0; i < WAVE_COUNT; i++) if (bandOf[i] === bandIndex) sum += raw[i] * raw[i] * 0.5;
    if (sum <= 0) continue;
    const scale = Math.sqrt((targetM0 * BANDS[bandIndex].variance) / sum);
    for (let i = 0; i < WAVE_COUNT; i++) if (bandOf[i] === bandIndex) raw[i] *= scale;
  }

  // Steepness. Σ Q·A·k > 1 makes a Gerstner surface self-intersect and the
  // crests curl into visible loops, so the budget is shared out across the
  // DISPLACING components only and held at 0.78 — high enough that crests are
  // peaked and troughs are broad (which is what a real sea does and what a plain
  // sine cannot), low enough that nothing folds.
  let steepSum = 0;
  for (let i = 0; i < DISPLACING_COUNT; i++) steepSum += raw[i] * (2 * Math.PI) / lambda[i];
  const qScale = steepSum > 0 ? 0.78 / steepSum : 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    b[i * 4] = raw[i];
    // Ripples never displace, so they never spend steepness budget.
    b[i * 4 + 1] = i < DISPLACING_COUNT ? raw[i] * qScale : 0;
  }

  // Slope variance below each cutoff. σ² for a single component is (Ak)²/2.
  const varianceLut = new Float32Array(8);
  for (let c = 0; c < VARIANCE_LUT_LAMBDA.length; c++) {
    let v = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      if (lambda[i] >= VARIANCE_LUT_LAMBDA[c]) continue;
      const ak = raw[i] * ((2 * Math.PI) / lambda[i]);
      v += ak * ak * 0.5;
    }
    varianceLut[c] = v;
  }

  let m0 = 0;
  for (let i = 0; i < WAVE_COUNT; i++) m0 += raw[i] * raw[i] * 0.5;

  return { a, b, varianceLut, significantHeight: 4 * Math.sqrt(m0), windX, windZ };
}

/**
 * CPU Gerstner evaluation of the DISPLACING bands — the same sum the vertex
 * shader runs, to the last term.
 *
 * Gerstner displaces horizontally as well as vertically, so "the height at
 * (x, z)" is not a function evaluation but a root find: the water column whose
 * displaced position lands on (x, z) started somewhere up-wind of it. Three
 * fixed-point iterations converge well inside a centimetre at our steepness,
 * and a floating body that is a centimetre out is a body nobody notices.
 */
export function sampleWaveHeight(table: WaveTable, x: number, z: number, time: number): number {
  let bx = x;
  let bz = z;
  for (let iter = 0; iter < 3; iter++) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < DISPLACING_COUNT; i++) {
      const dirX = table.a[i * 4];
      const dirZ = table.a[i * 4 + 1];
      const k = table.a[i * 4 + 2];
      const omega = table.a[i * 4 + 3];
      const qa = table.b[i * 4 + 1];
      const f = k * (dirX * bx + dirZ * bz) - omega * time + table.b[i * 4 + 2];
      const c = Math.cos(f);
      dx += qa * dirX * c;
      dz += qa * dirZ * c;
    }
    bx = x - dx;
    bz = z - dz;
  }
  let y = 0;
  for (let i = 0; i < DISPLACING_COUNT; i++) {
    const dirX = table.a[i * 4];
    const dirZ = table.a[i * 4 + 1];
    const k = table.a[i * 4 + 2];
    const omega = table.a[i * 4 + 3];
    const f = k * (dirX * bx + dirZ * bz) - omega * time + table.b[i * 4 + 2];
    y += table.b[i * 4] * Math.sin(f);
  }
  return y;
}

/** Analytic surface normal of the displacing bands at the same point. */
export function sampleWaveNormal(
  table: WaveTable,
  x: number,
  z: number,
  time: number,
  out: { x: number; y: number; z: number },
): void {
  let txx = 1;
  let txy = 0;
  let txz = 0;
  let tzx = 0;
  let tzy = 0;
  let tzz = 1;
  for (let i = 0; i < DISPLACING_COUNT; i++) {
    const dirX = table.a[i * 4];
    const dirZ = table.a[i * 4 + 1];
    const k = table.a[i * 4 + 2];
    const omega = table.a[i * 4 + 3];
    const amp = table.b[i * 4];
    const qa = table.b[i * 4 + 1];
    const f = k * (dirX * x + dirZ * z) - omega * time + table.b[i * 4 + 2];
    const s = Math.sin(f);
    const c = Math.cos(f);
    txx -= qa * k * dirX * dirX * s;
    txz -= qa * k * dirZ * dirX * s;
    txy += amp * k * dirX * c;
    tzx -= qa * k * dirX * dirZ * s;
    tzz -= qa * k * dirZ * dirZ * s;
    tzy += amp * k * dirZ * c;
  }
  // n = normalize(cross(dP/dz, dP/dx)), which for a flat surface gives +Y.
  const nx = tzy * txz - tzz * txy;
  const ny = tzz * txx - tzx * txz;
  const nz = tzx * txy - tzy * txx;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
}
