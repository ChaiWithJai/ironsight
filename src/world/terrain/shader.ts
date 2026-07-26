/**
 * THE TERRAIN SURFACE SHADER. Owned by TERRAIN.
 *
 * Registered with `MaterialFactory.registerSurface`, which is the sanctioned
 * route for a lane to own its own shading: the chunk runs after the uber
 * material has resolved albedo/normal/roughness and BEFORE lighting, so the
 * ground still receives CSM, clustered lights, GTAO and in-shader aerial
 * perspective exactly like every other surface in the frame. A hand-rolled
 * ShaderMaterial would compile and would be the one object in the frame lit
 * differently.
 *
 * What it does, in order:
 *   1. STOCHASTIC (hex-tile) fetches of the two TextureSets, so the ground
 *      layer has no texture period at all
 *   2. HEIGHT-BLENDED splat weights, so a material boundary interlocks at three
 *      scales instead of being a 1-bit mask with a stair-stepped silhouette
 *   3. procedural mesoscale / macro / micro variation at NON-HARMONIC scale
 *      ratios, with ANALYTIC C1 normals — see ironTerrainNoiseD for why that is
 *      the single most load-bearing thing in the file
 *   4. wind ripple, pebbles, grain, tracks, drift collars against props
 *   5. the wet mask at the waterline (LOOK_SPEC §4.5, all four effects at once)
 *
 * Sampler budget is the reason there are two TextureSets and not three. The dry
 * terrace layer is the sand set under the soil tint with its own roughness and
 * mottle: two more samplers would put this material within a couple of units of
 * the WebGL2 guaranteed minimum once the uber material's shadow atlas, LUTs and
 * cluster buffers are counted, and running out of texture units is a link
 * failure, not a soft degradation.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  SurfaceId,
  type GpuUniform,
  type MaterialFactory,
  type SurfaceChunk,
  type TextureSet,
} from '@/engine/types';
import { LAYER_ALBEDO, SHORE_RANGE_METRES, type TerrainMaps } from '@/world/terrain/maps';

export const TERRAIN_SURFACE_CHUNK = 'terrain.ground';

/** Metres per texture repeat, per layer. Both are inside the "mesoscale
 *  variation 0.15–0.6 m" band once the set's own tiling is folded in. */
const SAND_METRES = 1.45;
const ROCK_METRES = 2.30;

const COMMON = /* glsl */ `
uniform sampler2D uTerrainSplat;
uniform sampler2D uTerrainShore;
uniform sampler2D uTerrainSandAlbedo;
uniform sampler2D uTerrainSandSurface;
uniform sampler2D uTerrainRockAlbedo;
uniform sampler2D uTerrainRockSurface;
/** xy = map rect min, zw = 1 / map rect size. */
uniform vec4 uTerrainRect;
/** x = shore range m, y = sea level, z = sand m/repeat, w = rock m/repeat. */
uniform vec4 uTerrainParams;
uniform vec3 uTerrainSandTint;
uniform vec3 uTerrainScrubTint;
uniform vec3 uTerrainRockTint;

float ironTerrainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * The same hash, evaluated at all FOUR corners of the cell in one go.
 *
 * Bit-identical to ironTerrainHash per corner — it is the same expression with
 * the intermediate 3-vector algebraically collapsed onto its two independent
 * terms (a from x, b from y) and then run in vec4 lanes. This shader evaluates
 * ~30 noise fields per ground pixel and the ground is most of the frame, so the
 * four scalar hashes per field were the largest single ALU cost in it; this is
 * roughly a 3x cut on that, for free and with no change to the output.
 */
vec4 ironTerrainHash4(vec2 i) {
  vec4 a = fract(vec4(i.x, i.x + 1.0, i.x, i.x + 1.0) * 0.1031);
  vec4 b = fract(vec4(i.y, i.y, i.y + 1.0, i.y + 1.0) * 0.1031);
  vec4 s = 2.0 * a * b + a * a + 33.33 * (2.0 * a + b);
  return fract((a + b + 2.0 * s) * (a + s));
}

vec2 ironTerrainHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** 2x2 rotation, and its transpose (= its inverse, for chain-ruling gradients). */
vec2 ironTerrainRot(vec2 v, float c, float s) {
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}
vec2 ironTerrainRotT(vec2 v, float c, float s) {
  return vec2(c * v.x + s * v.y, -s * v.x + c * v.y);
}

/**
 * QUINTIC value noise — value AND analytic gradient, in one evaluation.
 *
 * THIS FUNCTION IS THE ROUND-2 BUG FIX. The previous version interpolated with
 * smoothstep, which is C1: its second derivative jumps across every lattice
 * line. The near-field relief normals are the DERIVATIVE of this field, so a C1
 * field hands the normal a kink on x = n and z = n, and under an 11° sun a kink
 * of a fraction of a degree is a visible line. At the mesoscale frequency the
 * lattice is 0.29 m, which at 4 m from the lens is ~55 px — precisely the
 * "straight parallel seam lines plus a diagonal criss-cross lattice at a second
 * frequency" three separate round-2 critiques measured on open ground. Quintic
 * (6t⁵-15t⁴+10t³) is C2, so the gradient below is C1 and no lattice survives.
 *
 * Analytic rather than finite-differenced for the same reason it is cheaper:
 * one hash quad instead of three, and the answer is the true derivative rather
 * than a secant that itself carries the lattice.
 */
vec3 ironTerrainNoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec4 h = ironTerrainHash4(i);
  float k1 = h.y - h.x;
  float k2 = h.z - h.x;
  float k3 = h.x - h.y - h.z + h.w;
  return vec3(
    h.x + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    du.x * (k1 + k3 * u.y),
    du.y * (k2 + k3 * u.x));
}

/** Value only. Kept separate so the scalar fields do not pay for the gradient. */
float ironTerrainValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec4 h = ironTerrainHash4(i);
  return h.x + (h.y - h.x) * u.x + (h.z - h.x) * u.y + (h.x - h.y - h.z + h.w) * u.x * u.y;
}

/**
 * The relief field the near-field normals are built from: two octaves at a
 * non-harmonic ratio, the second ROTATED 41° off the first, value and gradient.
 *
 * Quintic interpolation removes the derivative kink on the lattice, but value
 * noise still has a genuinely zero gradient ALONG every lattice line — a grid of
 * flat spots. One octave prints that grid onto the normal. Two octaves whose
 * lattices share no direction cannot: wherever one is flat the other is not.
 * The gradient of the rotated octave is chain-ruled back through the rotation
 * (R⁻¹ = Rᵀ) and its scale, so this is the exact derivative of what it returns.
 */
vec3 ironTerrainReliefD(vec2 p) {
  const float C = 0.7547; // cos 41°
  const float S = 0.6561; // sin 41°
  const float F = 2.63;
  vec3 a = ironTerrainNoiseD(p);
  vec3 b = ironTerrainNoiseD(ironTerrainRot(p, C, S) * F);
  return vec3(
    a.x * 0.62 + b.x * 0.38,
    a.yz * 0.62 + ironTerrainRotT(b.yz, C, S) * (F * 0.38));
}

/**
 * Three octaves at 1.00 / 3.70 / 13.90, EACH ROTATED off the previous one.
 * Scalar only — used for domain warping and patch masks, never for a normal.
 */
float ironTerrainFbm(vec2 p) {
  vec2 p1 = ironTerrainRot(p, 0.7986, 0.6019) * 3.70;   // +37°
  vec2 p2 = ironTerrainRot(p, 0.3256, -0.9455) * 13.90; // -71°
  return ironTerrainValue(p) * 0.54 + ironTerrainValue(p1) * 0.31 + ironTerrainValue(p2) * 0.15;
}

/**
 * Triangle (hex) lattice: the three cell centres whose Voronoi regions overlap
 * the point, and their barycentric weights. Heitz & Neyret 2018, tiling half.
 */
void ironTerrainTriGrid(vec2 p, out vec3 w, out vec2 c1, out vec2 c2, out vec2 c3) {
  // Columns, not rows: skews the square lattice into equilateral triangles.
  const mat2 toSkew = mat2(1.0, 0.0, -0.57735027, 1.15470054);
  vec2 s = toSkew * p;
  vec2 b = floor(s);
  vec3 t = vec3(fract(s), 0.0);
  t.z = 1.0 - t.x - t.y;
  if (t.z > 0.0) {
    w = vec3(t.z, t.y, t.x);
    c1 = b;
    c2 = b + vec2(0.0, 1.0);
    c3 = b + vec2(1.0, 0.0);
  } else {
    w = vec3(-t.z, 1.0 - t.y, 1.0 - t.x);
    c1 = b + vec2(1.0, 1.0);
    c2 = b + vec2(1.0, 0.0);
    c3 = b + vec2(0.0, 1.0);
  }
}

/** One tile: the texture rotated and offset by that tile's own hash. */
vec4 ironTerrainTile(sampler2D tex, vec2 uv, vec2 dx, vec2 dy, vec2 cell) {
  vec2 h = ironTerrainHash2(cell);
  float ang = h.x * 6.2831853;
  float c = cos(ang);
  float s = sin(ang);
  // Rotating about the origin and then translating by an unrelated offset is
  // the same set of transforms as rotating about the tile centre, and saves the
  // centre from having to be computed. Derivatives are rotated with the uv, so
  // mip selection stays correct and no LOD seam appears on a tile boundary —
  // which is the one artefact stochastic tiling can trade a repeat for.
  return textureGrad(tex,
    ironTerrainRot(uv, c, s) + h * vec2(41.13, 27.71),
    ironTerrainRot(dx, c, s),
    ironTerrainRot(dy, c, s));
}

/**
 * STOCHASTIC SAMPLING. Three tiles of the same texture, each independently
 * rotated and offset, blended by hex barycentrics — so no feature of the source
 * texture can ever appear twice in the same orientation at a fixed spacing,
 * which is the exact tell AAA_RUBRIC axis 2 names ("an identical stain or crack
 * appearing on a grid").
 *
 * Two corrections on top of the plain blend, both necessary:
 *   · the weights are cubed and renormalised, which shrinks the three-way blend
 *     region to roughly a third of the hex and keeps the ghosting confined;
 *   · the blend is VARIANCE-PRESERVING — a linear combination of three
 *     independent samples has 1/√Σw² of the contrast of one, so without the
 *     rescale the ground would visibly lose its texture in a soft hex pattern,
 *     which is just a different periodic tell.
 */
vec4 ironTerrainStochastic(sampler2D tex, vec4 mean, vec2 uv, vec2 gp) {
  vec3 w;
  vec2 c1, c2, c3;
  ironTerrainTriGrid(gp, w, c1, c2, c3);
  w = w * w * w;
  w /= max(1e-5, w.x + w.y + w.z);
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  vec4 col = ironTerrainTile(tex, uv, dx, dy, c1) * w.x
           + ironTerrainTile(tex, uv, dx, dy, c2) * w.y
           + ironTerrainTile(tex, uv, dx, dy, c3) * w.z;
  return clamp((col - mean) * inversesqrt(dot(w, w)) + mean, vec4(0.0), vec4(1.0));
}

/**
 * Two-plane triplanar. The horizontal plane always samples; the vertical plane
 * is whichever of ZY / XY the face points at most. Both are always fetched —
 * branching around the vertical fetch would put a texture read in non-uniform
 * control flow, where implicit derivatives (and therefore mip selection) are
 * undefined, and the artefact is a hard LOD seam along every slope contour.
 */
vec4 ironTerrainTriplanar(sampler2D tex, vec3 wp, vec3 an, float upness, float invMetres) {
  vec4 horizontal = texture2D(tex, wp.xz * invMetres);
  vec2 uvV = an.x > an.z ? wp.zy * invMetres : wp.xy * invMetres;
  return mix(texture2D(tex, uvV), horizontal, upness);
}

/**
 * De-tiled triplanar for the layer that covers the ground the player walks on:
 * the horizontal plane goes through the stochastic path above, the vertical
 * plane keeps the cheap read (a slope steep enough to weight it is read at an
 * angle where the repeat is not resolvable).
 *
 * The hex lattice is 3.4 m — a bit over two texture repeats — so the tiling
 * decision changes far more slowly than the texture it is hiding, and the blend
 * itself contributes no frequency the eye can lock onto.
 */
vec4 ironTerrainGroundTri(sampler2D tex, vec4 mean, vec3 wp, vec3 an, float upness, float invMetres) {
  vec4 horizontal = ironTerrainStochastic(tex, mean, wp.xz * invMetres, wp.xz * 0.294);
  vec2 uvV = an.x > an.z ? wp.zy * invMetres : wp.xy * invMetres;
  return mix(texture2D(tex, uvV), horizontal, upness);
}

/**
 * Re-level a sampled TextureSet onto an AUTHORED albedo.
 *
 * BAKE owns what the sand and sandstone sets actually look like and it is
 * allowed to change them; LOOK_SPEC §4.3 owns what dry sand and sandstone are
 * ALLOWED to reflect (0.45–0.58 and 0.32–0.48 linear). Multiplying a tint by a
 * raw sample honours neither: a bright baked set pushes the ground past the
 * 0.82 ceiling, everything clips to cream and every material distinction on the
 * map is lost — which is exactly what happened before this function existed.
 *
 * So: take the texture's own average level from its smallest mip, divide it out,
 * and re-apply the authored albedo. What survives is the texture's VARIATION
 * (which is what it is for) and a fraction of its chroma; what does not survive
 * is its absolute level (which is ours to decide).
 */
vec3 ironTerrainRelevel(vec4 texel, vec3 mean, vec3 tint) {
  const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
  float meanL = max(dot(mean, luma), 0.02);
  float texL = max(dot(texel.rgb, luma), 1e-4);
  vec3 chroma = texel.rgb / texL;
  // The contrast window is narrow ON PURPOSE. A generic baked set carries its
  // own large-scale swirl; let it through at full swing and the ground reads as
  // marbled wood grain rather than as sand. ±22 % is enough for the set to
  // contribute mesoscale break-up while the sand's actual character (ripple,
  // grain, pebbles) is authored below, where it can be tied to scale and to
  // distance.
  return tint * clamp(texL / meanL, 0.78, 1.22) * mix(vec3(1.0), chroma, 0.28);
}
`;

const SHADE = /* glsl */ `
{
  vec3 wp = vWorldPosition;
  vec3 baseNormal = normalize(normal);
  vec3 an = abs(baseNormal);
  float upness = smoothstep(0.42, 0.88, an.y);
  float viewDist = length(vViewPosition);

  vec2 mapUv = (wp.xz - uTerrainRect.xy) * uTerrainRect.zw;
  vec4 splat = texture2D(uTerrainSplat, mapUv);
  float shoreM = (texture2D(uTerrainShore, mapUv).r * 2.0 - 1.0) * uTerrainParams.x;

  // Every scalar noise field below is evaluated on a coordinate frame ROTATED
  // off the world axes. Value noise is built on an axis-aligned lattice and its
  // cell structure is faintly visible even when its derivative is not used; with
  // half a dozen fields all sharing x/z, those faint structures reinforce into
  // the rectangular grid two rounds of critique found in the foreground.
  vec2 rp1 = ironTerrainRot(wp.xz, 0.8829, 0.4696);  // +28°
  vec2 rp2 = ironTerrainRot(wp.xz, 0.5150, 0.8572);  // +59°
  vec2 rp3 = ironTerrainRot(wp.xz, -0.2079, 0.9781); // +102°

  // ---- texture fetches -----------------------------------------------------
  vec4 sandMeanA = textureLod(uTerrainSandAlbedo, vec2(0.5), 12.0);
  vec4 sandMeanS = textureLod(uTerrainSandSurface, vec2(0.5), 12.0);
  float invSand = 1.0 / uTerrainParams.z;
  float invRock = 1.0 / uTerrainParams.w;
  vec4 ga = ironTerrainGroundTri(uTerrainSandAlbedo, sandMeanA, wp, an, upness, invSand);
  vec4 gs = ironTerrainGroundTri(uTerrainSandSurface, sandMeanS, wp, an, upness, invSand);
  vec4 ra = ironTerrainTriplanar(uTerrainRockAlbedo, wp, an, upness, invRock);
  vec4 rs = ironTerrainTriplanar(uTerrainRockSurface, wp, an, upness, invRock);

  // ---- macro fields --------------------------------------------------------
  // Three albedo bands (9 m, 47 m, 125 m). The longest is LOOK_SPEC §4.1's
  // "large low-frequency macro variation": at range the mesoscale has mipped
  // away and this is the only thing left keeping 200 m of open ground from
  // reading as one flat tone.
  float macro = ironTerrainValue(rp1 * 0.111) * 0.42
              + ironTerrainValue(rp2 * 0.021 + 11.3) * 0.34
              + ironTerrainValue(rp3 * 0.0079 + 3.7) * 0.24;
  // A SEPARATE ~38 m field for roughness. Sharing the albedo field would make
  // every pale patch also a dusty patch, which is a correlation the eye reads as
  // "one texture tinted twice"; in reality the compacted, wind-scoured ground is
  // smoother AND slightly darker, and the loose drifted ground is rougher and
  // paler, so the two fields have to be able to disagree.
  float compact = ironTerrainValue(rp3 * 0.0265 + 61.4) * 0.68 + ironTerrainValue(rp2 * 0.094 + 7.9) * 0.32;

  // ---- HEIGHT-BLENDED SPLAT ------------------------------------------------
  // The splat map is 0.5 m/texel. Read straight, its boundaries are 0.5 m
  // gradients with stair-stepped silhouettes — the "two puddles of paint" the
  // round-2 critique measured. Instead each layer carries a HEIGHT (the alpha
  // of its albedo set for sand and rock, a clump field for scrub), the heights
  // are jittered by noise at two scales, and only the layers within a fixed depth of
  // the tallest survive. That is what makes sand sit in the hollows of gravel
  // and scrub push through sand in clumps, with an organic edge at every scale.
  float clump = ironTerrainValue(rp2 * 2.15) * 0.6 + ironTerrainValue(rp1 * 7.4) * 0.4;
  vec3 hJit = vec3(
    ironTerrainValue(rp1 * 0.62) - 0.5,
    ironTerrainValue(rp3 * 1.07 + 3.1) - 0.5,
    ironTerrainValue(rp2 * 0.41 + 8.8) - 0.5) * 0.34
    + (ironTerrainValue(rp2 * 3.1) - 0.5) * 0.22;
  // ×1.35 on the classifier's own weights, deliberately. The heights and the
  // jitter together swing ±0.36, so without the extra separation a layer the
  // classifier said was ABSENT could still out-height the dominant one and
  // speckle rock through clean beach sand. At 1.35 the jitter can only decide
  // contests the classifier already left open, which is the whole intent.
  vec3 hw = vec3(splat.r, splat.g, splat.b) * 1.35
          + 0.42 * (vec3(ga.a, clump, ra.a) - 0.5)
          + hJit;
  float peak = max(hw.x, max(hw.y, hw.z));
  // 0.17 of "depth": layers within it interpenetrate, layers below it are gone.
  // Small enough that the boundary is a boundary, wide enough that it is never
  // one pixel wide and never aliases.
  vec3 sw = max(hw - (peak - 0.17), 0.0);
  sw /= max(1e-4, sw.x + sw.y + sw.z);
  float wSand = sw.x;
  float wScrub = sw.y;
  float wRock = sw.z;
  float wGround = wSand + wScrub;
  // How contested this pixel is. Debris collects along material boundaries in
  // the real world for the same reason the boundary exists at all, and scattering
  // clasts there is what stops the transition reading as a drawn line.
  float contested = 1.0 - abs(wGround - wRock) * abs(wSand - wScrub);

  // ---- STAGGERED, DITHERED DETAIL FADES ------------------------------------
  // Every band fades over its OWN range and every threshold is displaced by a
  // 3 m noise field, so no two fronts coincide and none of them is a circle
  // centred on the camera. The ranges are long — 12 m for grain, 30 for pebbles,
  // 80 for ripple — because a fade is a change in mean shading (perturbed
  // normals lose more light than they gain under an 11° sun) and a change in
  // mean shading spread over 4 m is a line across the ground. Round 2 measured
  // exactly that: −28 levels over 12 px at 7 m.
  float jit = ironTerrainValue(rp3 * 0.33 + 5.1) - 0.5;
  float fGrain  = 1.0 - smoothstep(1.5 + jit * 1.2, 13.5 + jit * 4.5, viewDist);
  float fPebble = 1.0 - smoothstep(4.0 + jit * 2.6, 34.0 + jit * 9.0, viewDist);
  float fRipple = 1.0 - smoothstep(16.0 + jit * 7.0, 96.0 + jit * 26.0, viewDist);
  float fRelief = 1.0 - smoothstep(34.0 + jit * 12.0, 190.0 + jit * 40.0, viewDist);

  // ---- layers --------------------------------------------------------------
  vec3 tint = mix(uTerrainScrubTint, uTerrainSandTint, wSand / max(1e-4, wGround));
  vec3 albedo = ironTerrainRelevel(ga, sandMeanA.rgb, tint) * wGround;
  float rough = mix(0.90, 0.97, wSand / max(1e-4, wGround)) * (0.82 + 0.36 * gs.b);
  float cavity = mix(1.0, gs.a, wGround * 0.8);
  // A THIRD strength. The baked set's relief is authored for a wall at arm's
  // length; across a whole beach, lit by an 11° sun where a 5° normal tilt is
  // most of the NdotL range, it is the single biggest contributor to a swirled,
  // marbled albedo. The sand's real character is authored below at scales tied
  // to distance; this layer only keeps the two sets coherent.
  vec2 slopeNormal = (gs.rg * 2.0 - 1.0) * wGround * 0.20;

  {
    vec3 rockCol = ironTerrainRelevel(ra, textureLod(uTerrainRockAlbedo, vec2(0.5), 12.0).rgb, uTerrainRockTint);
    // Bedding: the strata carved into the heightfield continue as an albedo
    // banding keyed on ALTITUDE, so a cliff reads as sedimentary rock rather
    // than as noise projected on a slope.
    float bedding = sin(wp.y * 0.92 + macro * 3.4);
    rockCol *= 0.90 + 0.13 * bedding;
    albedo += rockCol * wRock;
    rough = mix(rough, 0.86 * (0.80 + 0.40 * rs.b), wRock);
    cavity = mix(cavity, rs.a, wRock * 0.8);
    slopeNormal += (rs.rg * 2.0 - 1.0) * wRock;
  }

  // ---- multi-scale modulation ---------------------------------------------
  // Mesoscale at 0.29 m and macro over 9–125 m. LOOK_SPEC §4.1 puts macro
  // variation at ±8 %, albedo only; above that amplitude it stops reading as
  // sun-bleaching and starts reading as marble.
  vec3 mesoD = ironTerrainReliefD(rp1 * 3.40);
  albedo *= 0.87 + 0.26 * mesoD.x;
  albedo *= 0.93 + 0.14 * macro;
  // Macro drives HUE as well as level — sun-bleached crests go pale and slightly
  // cool, sheltered hollows keep the iron-oxide warmth.
  albedo *= mix(vec3(1.035, 0.998, 0.952), vec3(0.972, 0.994, 1.030), smoothstep(0.32, 0.72, macro));
  // ROUGHNESS ON ITS OWN LOW-FREQUENCY FIELD. Compacted ground is scoured
  // smooth and reads very slightly darker and cooler; loose drifted ground is
  // rougher and paler. Uniform roughness is what makes procedural ground read as
  // one plastic sheet, and this is a bigger perceptual win than any albedo edit.
  float compacted = smoothstep(0.34, 0.72, compact);
  rough = clamp(rough + (mesoD.x - 0.5) * 0.16 - compacted * 0.20 + (1.0 - compacted) * 0.05, 0.30, 1.0);
  albedo *= mix(1.0, 0.90, compacted * wGround);
  // Cavity darkening only, never a flat AO multiply: LOOK_SPEC is explicit that
  // scaling the final colour by AO is what produces dirty grey shadows.
  albedo *= mix(1.0, cavity, 0.34);

  // ---- TRACKS ---------------------------------------------------------------
  // Braided foot and wheel tracks: a ridge field at 26 m thresholded to a narrow
  // band, so the terrace carries a few sinuous compacted routes rather than
  // being uniformly walked. They are darker (broken crust exposes damp sand),
  // smoother (compaction) and they kill the wind ripple, all of which are the
  // same physical event. AAA_RUBRIC axis 5: "detail should concentrate where the
  // player goes".
  float trackField = abs(ironTerrainFbm(rp2 * 0.038 + 17.2) - 0.5) * 2.0;
  float track = (1.0 - smoothstep(0.05, 0.30, trackField)) * wGround * upness;
  track *= 0.35 + 0.65 * ironTerrainValue(rp1 * 0.17 + 4.4);
  albedo *= 1.0 - 0.16 * track;
  rough = mix(rough, 0.66, track * 0.7);

  // ---- near-field mesostructure and microstructure -------------------------
  // Everything in this block is pure ALU with no implicit derivatives, so the
  // branch is safe; it is placed past the last band's fade-out so it can never
  // itself be the boundary.
  float drift = 0.0;
  if (fRelief + fRipple + fPebble + fGrain > 0.004) {
    slopeNormal += mesoD.yz * 0.38 * fRelief;

    // WIND RIPPLE. Aeolian ripple is periodic and directional — an isotropic
    // noise field never reads as sand — but a plain cos() of a fixed direction
    // is a diffraction grating. Four things fix it and all four are real
    // properties of a ripple field:
    //   · the wind direction wanders over the map, so the ripple bearing is a
    //     55 m noise field with a full π of swing rather than a constant;
    //   · the crest lines are domain-warped by a 2.4 m field, so they meander
    //     and fork the way ripples actually do instead of running straight;
    //   · ripple only forms where the wind can load sand, so the amplitude is
    //     masked by a 12 m patch field and dies on slopes, on scrub and on
    //     compacted ground;
    //   · nothing ripples in a wind shadow — behind a wall, a crate or a kerb,
    //     which is what the splat alpha marks, the field goes to zero and drift piles
    //     up instead.
    float lee = 1.0 - smoothstep(0.05, 0.55, splat.a);
    float bearing = (ironTerrainValue(rp1 * 0.0182 + 21.7) - 0.5) * 3.1;
    vec2 rdir = vec2(cos(bearing), sin(bearing));
    float warp = ironTerrainFbm(rp3 * 0.30) * 1.05;
    float rField = smoothstep(0.24, 0.70, ironTerrainValue(rp2 * 0.083 + 9.4));
    float rAmp = wSand * rField * upness * fRipple * lee * (1.0 - 0.7 * track) * (0.45 + 0.55 * (1.0 - compacted));
    float phase = dot(wp.xz, rdir) * (7.0 + 3.0 * rField) + warp;
    // Asymmetric profile: a real ripple has a short steep lee face and a long
    // shallow stoss face, and that asymmetry is most of why a lit ripple field
    // reads as sand rather than as corrugated iron.
    float c = cos(phase);
    slopeNormal -= rdir * c * (0.32 + 0.14 * sin(phase)) * rAmp;
    // Crests are winnowed pale, troughs collect the darker coarse fraction.
    albedo *= 1.0 + 0.085 * sin(phase) * rAmp;
    // A second, much finer ripple set riding on the first, at 11 cm — the scale
    // that only exists inside a few metres of the lens.
    slopeNormal -= rdir * cos(phase * 4.3 + warp * 1.4) * 0.14 * rAmp * fPebble;

    // DRIFT. Where the wind shadow is (behind and against every prop LEVEL put
    // on the ground) loose pale sand piles up: brighter, rougher, no ripple, and
    // a soft mound in the normal leaning away from the obstacle. Round 2:
    // "no drift piled against the kerb face, no sand collar under any prop".
    drift = smoothstep(0.12, 0.62, splat.a) * wGround * upness;
    float driftN = ironTerrainValue(rp1 * 1.9 + 31.0);
    albedo *= 1.0 + 0.14 * drift * (0.4 + 0.6 * driftN);
    rough = mix(rough, 0.98, drift * 0.6);
    slopeNormal += ironTerrainReliefD(rp3 * 0.9 + 12.0).yz * drift * 0.9 * fRelief;

    // PEBBLES AND CLASTS. Sparse individually-shaded lumps on a 17 cm jittered
    // lattice. Grain alone still reads as a painted surface, because the eye
    // judges the scale of a ground plane from discrete objects and their contact
    // shadows, not from texture frequency. Denser on gravel, on scrub and along
    // material boundaries than on clean dune sand, which is where they collect.
    if (fPebble > 0.01) {
      vec2 pg = rp2 * 5.9;
      vec2 pi = floor(pg);
      float ph = ironTerrainHash(pi);
      vec2 poff = (vec2(ironTerrainHash(pi + 17.31), ironTerrainHash(pi + 41.77)) - 0.5) * 0.62;
      vec2 pd = pg - pi - 0.5 - poff;
      // Radius capped at 0.30 cells so the clast AND its contact shadow (out to
      // 1.5 r) stay inside the cell. They did not before: the shadow was clipped
      // on the cell wall, which drew a 17 cm grid of hard lines across the whole
      // near field — the second, finer lattice the round-2 critique measured.
      float pr = 0.14 + 0.16 * fract(ph * 7.31);
      float pn = length(pd) / pr;
      float occupied = step(0.55 + 0.26 * wSand - 0.15 * contested - 0.10 * wRock, ph) * fPebble;
      float body = (1.0 - smoothstep(0.55, 1.0, pn)) * occupied;
      // Dome flank: the normal leans outward, strongest at the shoulder.
      slopeNormal += normalize(pd + 1e-4) * body * min(pn, 1.0) * 2.6;
      // Clasts are a different rock from the matrix they sit in, and each one
      // parks a small contact shadow on the sand immediately around it.
      albedo *= mix(vec3(1.0), vec3(0.62 + 0.66 * fract(ph * 31.7)), body);
      albedo *= 1.0 - 0.30 * occupied * (1.0 - smoothstep(1.0, 1.5, pn)) * (1.0 - body);
      rough = mix(rough, 0.68, body * 0.7);
    }

    // GRAIN. 2 cm relief plus a 6 mm speckle, fading IN over the last 13 m. This
    // is the layer that answers "surfaces that go smooth as they approach the
    // camera fail": at 1 m the ground must gain structure, not lose it.
    if (fGrain > 0.01) {
      vec3 g0 = ironTerrainReliefD(rp3 * 34.0);
      // Grain is mostly RELIEF, barely albedo: sand grains are the same mineral
      // as each other, so what separates them at 30 cm is self-shadowing, not
      // colour. Pushing the albedo instead is what makes procedural sand read as
      // speckled paint.
      albedo *= mix(1.0, 0.90 + 0.20 * g0.x, fGrain);
      slopeNormal += g0.yz * 0.58 * fGrain;
      // The 8 mm band is cubed against distance rather than faded linearly: it
      // is only resolvable inside about a metre, and past that it is smaller
      // than a pixel footprint, where keeping it would buy shimmer and nothing
      // else. TAA cannot rescue detail that is already below Nyquist.
      float fSpeck = fGrain * fGrain * fGrain;
      vec3 g1 = ironTerrainReliefD(rp1 * 128.0);
      albedo *= mix(1.0, 0.93 + 0.14 * g1.x, fSpeck);
      slopeNormal += g1.yz * 0.16 * fSpeck;
      // Quartz sand is not Lambertian at 30 cm: the grain faces catch a broad
      // sheen and the shaded sides do not, so roughness has to break up too.
      rough = clamp(rough - (g0.x - 0.5) * 0.13 * fGrain, 0.30, 1.0);
    }
  }

  // ---- wet mask (LOOK_SPEC 4.5) -------------------------------------------
  // The tide line is scalloped by the same along-shore noise that shapes the
  // beach cusps, and the boundary is hard-ish with a feather, not a gradient.
  float wet = 0.0;
  if (shoreM < 16.0) {
    float tide = (ironTerrainValue(rp2 * 0.055) - 0.5) * 2.4;
    wet = clamp(1.0 - smoothstep(-0.25 + tide, 2.1 + tide, shoreM), 0.0, 1.0);
    // THE WRACK LINE. A real beach carries a dark band of organic debris and
    // damp sand a few metres above the swash, and it is the only horizontal
    // value break in an otherwise uniform sheet of sand — without it the beach
    // is one tone from the water to the berm, which is the single flattest
    // thing in these frames.
    float d = (shoreM - 3.4 - tide * 1.6) / 2.8;
    float wrack = exp(-d * d) * (0.45 + 0.55 * ironTerrainValue(rp1 * 0.62));
    albedo *= 1.0 - 0.22 * wrack;
    rough = mix(rough, 0.88, wrack * 0.5);
  }
  albedo *= mix(1.0, 0.60, wet);
  rough = mix(rough, 0.15, wet);
  slopeNormal *= 1.0 - 0.8 * wet;

  // ---- ground transition where LEVEL's geometry lands ---------------------
  // The grit band itself: spalled material and a contact darkening that widens
  // the junction from a line into a band. The drift above is the wind half of
  // the same event; this is the debris half.
  float trans = splat.a;
  if (trans > 0.004) {
    vec3 gd = ironTerrainReliefD(rp1 * 3.3);
    albedo = mix(albedo, albedo * (0.70 + 0.62 * gd.x), trans);
    rough = mix(rough, 0.94, trans * 0.75);
    albedo *= 1.0 - 0.26 * trans * trans;
    slopeNormal += gd.yz * 0.75 * trans;
  }

  // ---- resolve ------------------------------------------------------------
  // The perturbation is built in world space (the surface-chunk contract's
  // stated frame) and orthogonalised against the incoming normal before it is
  // added, so it can only ever tilt the normal — it can never flip or
  // denormalise it.
  vec3 pert = mix(
    an.x > an.z ? vec3(0.0, slopeNormal.y, slopeNormal.x) : vec3(slopeNormal.x, slopeNormal.y, 0.0),
    vec3(slopeNormal.x, 0.0, slopeNormal.y),
    upness);
  pert -= baseNormal * dot(pert, baseNormal);
  normal = normalize(baseNormal + pert * 0.34);
  // TOKSVIG-STYLE ROUGHNESS COMPENSATION. Perturbation that has faded out with
  // distance has not gone away, it has gone below the pixel — so the roughness
  // has to absorb it, or the ground changes its specular response at the fade
  // and draws exactly the ring the fade ranges above were widened to avoid.
  float lost = (1.0 - fGrain) * 0.05 + (1.0 - fRipple) * 0.03 + (1.0 - fRelief) * 0.03;
  rough = clamp(rough + lost * wGround * upness, 0.08, 1.0);

  diffuseColor.rgb = clamp(albedo, vec3(0.035), vec3(0.82));
  material.roughness = clamp(rough, 0.08, 1.0);
  material.metalness = 0.0;
}
`;

export const TERRAIN_SURFACE: SurfaceChunk = { common: COMMON, shade: SHADE };

export interface TerrainMaterialDeps {
  readonly materials: MaterialFactory;
  readonly maps: TerrainMaps;
  readonly sand: TextureSet;
  readonly rock: TextureSet;
}

export function createTerrainMaterial(deps: TerrainMaterialDeps): THREE.Material {
  const { materials, maps, sand, rock } = deps;
  materials.registerSurface(TERRAIN_SURFACE_CHUNK, TERRAIN_SURFACE);

  const uniforms: Record<string, GpuUniform> = {
    uTerrainSplat: { value: maps.splatMap },
    uTerrainShore: { value: maps.shoreMask },
    uTerrainSandAlbedo: { value: sand.albedoHeight },
    uTerrainSandSurface: { value: sand.normalRoughAo },
    uTerrainRockAlbedo: { value: rock.albedoHeight },
    uTerrainRockSurface: { value: rock.normalRoughAo },
    uTerrainRect: {
      value: new THREE.Vector4(maps.rect.minX, maps.rect.minZ, 1 / maps.rect.sizeX, 1 / maps.rect.sizeZ),
    },
    uTerrainParams: {
      value: new THREE.Vector4(
        SHORE_RANGE_METRES,
        0,
        SAND_METRES * Math.max(0.25, sand.tiling / 2),
        ROCK_METRES * Math.max(0.25, rock.tiling / 2),
      ),
    },
    uTerrainSandTint: { value: new THREE.Vector3(...LAYER_ALBEDO.sand) },
    uTerrainScrubTint: { value: new THREE.Vector3(...LAYER_ALBEDO.scrub) },
    uTerrainRockTint: { value: new THREE.Vector3(...LAYER_ALBEDO.rock) },
  };

  return materials.create({
    id: 'terrain.ground',
    surface: SurfaceId.Sand,
    layer: materials.allocateLayer('terrain.ground', sand.albedoHeight, sand.normalRoughAo),
    // Triplanar is declared as well as implemented: it states the intent to the
    // factory (steep faces must not stretch) and keeps any base-layer sampling
    // the uber material does on the same projection as the splat above it.
    features: MaterialFeature.Triplanar | MaterialFeature.DetailNormal,
    baseColor: new THREE.Color().setRGB(LAYER_ALBEDO.scrub[0], LAYER_ALBEDO.scrub[1], LAYER_ALBEDO.scrub[2], THREE.LinearSRGBColorSpace),
    roughness: 0.94,
    metalness: 0,
    surfaceShader: TERRAIN_SURFACE_CHUNK,
    uniforms,
  });
}
