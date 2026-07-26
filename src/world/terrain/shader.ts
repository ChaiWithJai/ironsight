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
 *   1. splat weights from the world-space map (sand · dry scrub · rock)
 *   2. two triplanar TextureSet fetches — sand and sandstone — so a 60° cliff
 *      face samples in the plane it faces instead of stretching the XZ layout
 *   3. procedural mesoscale / macro / micro variation at NON-HARMONIC scale
 *      ratios, which is what keeps the ground from tiling and from going smooth
 *      as the camera approaches
 *   4. the wet mask at the waterline: albedo ×0.6, roughness → 0.15, micro
 *      relief flattened — all four of LOOK_SPEC §4.5's simultaneous effects,
 *      because doing only some of them is what makes wet ground read as plastic
 *   5. the ground-transition band where LEVEL's geometry meets the terrain
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

float ironTerrainValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = ironTerrainHash(i);
  float b = ironTerrainHash(i + vec2(1.0, 0.0));
  float c = ironTerrainHash(i + vec2(0.0, 1.0));
  float d = ironTerrainHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** 2x2 rotation. Used to decorrelate noise octaves — see ironTerrainFbm. */
vec2 ironTerrainRot(vec2 v, float c, float s) {
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

/**
 * Three octaves at 1.00 / 3.70 / 13.90, EACH ROTATED off the previous one.
 *
 * Two separate anti-pattern measures, and both are load-bearing:
 *   · the frequency ratios are non-harmonic, so the octaves never beat into a
 *     period the eye can lock onto;
 *   · every octave is rotated ~37° and ~-71° from the lattice of the one below.
 *     Smoothstep value noise is built on an axis-aligned integer lattice and its
 *     second derivative is discontinuous across every lattice line, so stacking
 *     un-rotated octaves piles those discontinuities on top of each other at
 *     x = n and z = n. That is what turns into the faint rectangular grid the
 *     round-1 critique measured across the whole foreground.
 */
float ironTerrainFbm(vec2 p) {
  vec2 p1 = ironTerrainRot(p, 0.7986, 0.6019) * 3.70;   // +37°
  vec2 p2 = ironTerrainRot(p, 0.3256, -0.9455) * 13.90; // -71°
  return ironTerrainValue(p) * 0.54 + ironTerrainValue(p1) * 0.31 + ironTerrainValue(p2) * 0.15;
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
 * DE-TILED triplanar, for the layer that covers the ground the player walks on.
 *
 * A 1.45 m texture read once per world position repeats about forty times
 * across the near field, and the round-1 critique found it without hunting:
 * "a rectangular lattice of cells is directly countable; inside each cell the
 * same pattern repeats identically". The fix is to break the periodicity of the
 * SAMPLING, not to hide the texture.
 *
 * The horizontal plane is read twice: once at the authored scale and once at
 * 0.3137× (a deliberately irrational-looking ratio — 3.188 repeats of one per
 * repeat of the other, so the combined pattern's period is ~46 m rather than
 * 1.45 m) and rotated 37° so the two reads share no axis. The cross-fade weight
 * is itself a 23 m noise field, so even the blend ratio does not repeat.
 *
 * Three fetches instead of one for the ground layer; the rock layer keeps the
 * cheap path because cliff faces are read at a distance and at an angle where
 * the repeat never became visible.
 */
vec4 ironTerrainGroundTri(sampler2D tex, vec3 wp, vec3 an, float upness, float invMetres) {
  vec2 uv0 = wp.xz * invMetres;
  vec2 uv1 = ironTerrainRot(wp.xz, 0.7986, 0.6019) * (invMetres * 0.3137) + vec2(0.371, 0.617);
  float k = ironTerrainValue(wp.xz * 0.0435);
  vec4 horizontal = mix(texture2D(tex, uv0), texture2D(tex, uv1), 0.30 + 0.36 * k);
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
 * is its absolute level (which is ours to decide). A flat placeholder set lands
 * exactly on the authored value instead of dragging the frame with it.
 */
vec3 ironTerrainRelevel(vec4 texel, vec3 mean, vec3 tint) {
  const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
  float meanL = max(dot(mean, luma), 0.02);
  float texL = max(dot(texel.rgb, luma), 1e-4);
  vec3 chroma = texel.rgb / texL;
  // The contrast window is narrow ON PURPOSE. A generic baked set carries its
  // own large-scale swirl; let it through at full swing and the ground reads as
  // marbled wood grain rather than as sand — which is exactly what round 1
  // measured. ±22 % is enough for the set to contribute mesoscale break-up
  // while the sand's actual character (ripple, grain, pebbles) is authored
  // below, where it can be tied to scale and to distance.
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

  // The splat map is 0.5 m/texel; without this the transitions would be soft
  // 0.5 m gradients. Two octaves push the boundary around at 1.6 m and 0.3 m so
  // it interlocks instead of dissolving. Single-octave value noise, not fBm:
  // this shader is evaluated over every ground pixel in the frame and each fBm
  // call is three more hash quads.
  float edgeNoise = ironTerrainValue(wp.xz * 0.62) + ironTerrainValue(wp.xz * 3.1) * 0.45;
  float sharpen = (edgeNoise - 0.72) * 0.55;
  float wSand = max(0.0, splat.r + sharpen);
  float wScrub = max(0.0, splat.g - sharpen * 0.4);
  float wRock = max(0.0, splat.b + sharpen * 0.7);
  float wSum = max(1e-4, wSand + wScrub + wRock);
  wSand /= wSum; wScrub /= wSum; wRock /= wSum;

  // ---- procedural variation, independent of what BAKE baked ----------------
  // Mesoscale (0.55 m), macro break-up (9 m and 37 m) and a micro band that
  // fades in inside 9 m. This is the layer that guarantees the look spec's
  // "luminance sigma >= 12 in a nominally uniform patch" even before a single
  // texel of the TextureSet is read, and it is what stops the ground going
  // smooth as the camera walks up to it.
  vec2 mesoP = wp.xz * 3.40;
  float meso = ironTerrainFbm(mesoP);
  // Three macro bands (9 m, 47 m, 125 m). The longest is LOOK_SPEC §4.1's
  // "large low-frequency macro variation": at range the mesoscale has mipped
  // away and this is the only thing left keeping 200 m of open ground from
  // reading as one flat tone.
  float macro = ironTerrainValue(wp.xz * 0.111) * 0.42
              + ironTerrainValue(wp.xz * 0.021 + 11.3) * 0.34
              + ironTerrainValue(wp.xz * 0.0079 + 3.7) * 0.24;

  // ---- STAGGERED, DITHERED DETAIL FADES ------------------------------------
  // Round 1 found "a straight-edged wedge where the warm detail stops, the
  // colour steps and the grass thins — three things changing at one line". That
  // is what one shared fade radius looks like. Every band below therefore fades
  // over its own, deliberately different range, and every threshold is
  // displaced by a 3 m noise field so the front is ragged instead of being a
  // circle centred on the camera.
  float jit = ironTerrainValue(wp.xz * 0.33 + 5.1) - 0.5;
  float fGrain  = 1.0 - smoothstep(2.4 + jit * 1.5, 7.5 + jit * 3.2, viewDist);
  float fPebble = 1.0 - smoothstep(8.0 + jit * 3.4, 21.0 + jit * 7.5, viewDist);
  float fRipple = 1.0 - smoothstep(30.0 + jit * 11.0, 74.0 + jit * 22.0, viewDist);
  float fRelief = 1.0 - smoothstep(52.0 + jit * 16.0, 125.0 + jit * 30.0, viewDist);

  // ---- layer 1: sand / dry scrub (one fetch group, two tints) --------------
  vec3 albedo = vec3(0.0);
  float rough = 0.94;
  float cavity = 1.0;
  vec2 slopeNormal = vec2(0.0);

  float wGround = wSand + wScrub;
  {
    float invM = 1.0 / uTerrainParams.z;
    vec4 ga = ironTerrainGroundTri(uTerrainSandAlbedo, wp, an, upness, invM);
    vec4 gs = ironTerrainGroundTri(uTerrainSandSurface, wp, an, upness, invM);
    vec3 tint = mix(uTerrainScrubTint, uTerrainSandTint, wSand / max(1e-4, wGround));
    albedo += ironTerrainRelevel(ga, textureLod(uTerrainSandAlbedo, vec2(0.5), 12.0).rgb, tint) * wGround;
    rough = mix(rough, mix(0.90, 0.97, wSand / max(1e-4, wGround)) * (0.82 + 0.36 * gs.b), wGround);
    cavity = mix(cavity, gs.a, wGround * 0.8);
    // A THIRD strength. The baked set's relief is authored for a wall at arm's
    // length; across a whole beach, lit by an 11° sun where a 5° normal tilt is
    // most of the NdotL range, it is the single biggest contributor to the
    // "swirled marbled albedo that reads as wood grain" the round-1 critique
    // measured. The sand's real character is authored below at scales that are
    // tied to distance; this layer is only here to keep the two sets coherent.
    slopeNormal += (gs.rg * 2.0 - 1.0) * wGround * 0.34;
  }

  // ---- layer 2: sandstone / rock ------------------------------------------
  {
    float invM = 1.0 / uTerrainParams.w;
    vec4 ra = ironTerrainTriplanar(uTerrainRockAlbedo, wp, an, upness, invM);
    vec4 rs = ironTerrainTriplanar(uTerrainRockSurface, wp, an, upness, invM);
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
  // ±13 % at 0.29 m (mesoscale) and ±7 % over 9–125 m (macro). The macro swing
  // used to be ±26 %, which is what produced the swirled "wood grain" albedo
  // round 1 called out: LOOK_SPEC §4.1 puts macro variation at ±8 %, albedo
  // only, and everything above that amplitude stops reading as sun-bleaching
  // and starts reading as a marble texture.
  albedo *= 0.87 + 0.26 * meso;
  albedo *= 0.93 + 0.14 * macro;
  // Macro drives HUE as well as level — sun-bleached crests go pale and slightly
  // cool, sheltered hollows keep the iron-oxide warmth. Same field, so the two
  // never disagree about where a patch is.
  albedo *= mix(vec3(1.035, 0.998, 0.952), vec3(0.972, 0.994, 1.030), smoothstep(0.32, 0.72, macro));
  rough = clamp(rough + (meso - 0.5) * 0.16 + (macro - 0.5) * 0.11, 0.30, 1.0);
  // Cavity darkening only, never a flat AO multiply: LOOK_SPEC is explicit that
  // scaling the final colour by AO is what produces dirty grey shadows.
  albedo *= mix(1.0, cavity, 0.34);

  // ---- near-field mesostructure and microstructure -------------------------
  // Everything in this block is pure ALU with no implicit derivatives, so the
  // branch is safe; it is placed past the last band's fade-out so it can never
  // itself be the boundary. Each layer's weight was computed above with its own
  // staggered, noise-dithered radius.
  if (fRelief + fRipple + fPebble + fGrain > 0.004) {
    float m0 = ironTerrainValue(mesoP);
    slopeNormal += vec2(m0 - ironTerrainValue(mesoP + vec2(0.55, 0.0)),
                        m0 - ironTerrainValue(mesoP + vec2(0.0, 0.55))) * 1.15 * fRelief;

    // WIND RIPPLE. Aeolian ripple is periodic and directional — an isotropic
    // noise field never reads as sand — but a plain cos() of a fixed direction
    // is a diffraction grating, and that is exactly what round 1 measured:
    // "dead-straight parallel seams at roughly even spacing". Three things fix
    // it and all three are real properties of a ripple field:
    //   · the wind direction wanders, so the ripple bearing is driven by a 55 m
    //     noise field rather than by a constant;
    //   · the crest lines are domain-warped by a 2.4 m field, so they meander
    //     and fork the way ripples actually do instead of running straight;
    //   · ripple only forms where the wind can load sand, so the amplitude is
    //     masked by a 12 m patch field and dies out on slopes and on scrub.
    float bearing = 0.55 + (ironTerrainValue(wp.xz * 0.0182 + 21.7) - 0.5) * 1.9;
    vec2 rdir = vec2(cos(bearing), sin(bearing));
    float warp = ironTerrainFbm(wp.xz * 0.42) * 2.15;
    float rField = smoothstep(0.28, 0.68, ironTerrainValue(wp.xz * 0.083 + 9.4));
    float rAmp = wSand * rField * upness * fRipple;
    float phase = dot(wp.xz, rdir) * 8.2 + warp;
    // Asymmetric profile: a real ripple has a short steep lee face and a long
    // shallow stoss face, and that asymmetry is most of why a lit ripple field
    // reads as sand rather than as corrugated iron.
    float c = cos(phase);
    slopeNormal -= rdir * c * (0.50 + 0.22 * sin(phase)) * rAmp;
    // Crests are winnowed pale, troughs collect the darker coarse fraction.
    albedo *= 1.0 + 0.085 * sin(phase) * rAmp;
    // A second, much finer ripple set riding on the first, at 11 cm — the scale
    // that only exists inside a few metres of the lens.
    slopeNormal -= rdir * cos(phase * 6.7 + warp * 2.1) * 0.30 * rAmp * fPebble;

    // PEBBLES AND CLASTS. Sparse individually-shaded lumps on a 17 cm jittered
    // lattice. Grain alone still reads as a painted surface, because the eye
    // judges the scale of a ground plane from discrete objects and their
    // contact shadows, not from texture frequency. Denser on scrub and gravel
    // than on clean dune sand, which is also where they really collect.
    if (fPebble > 0.01) {
      vec2 pg = wp.xz * 5.9;
      vec2 pi = floor(pg);
      float ph = ironTerrainHash(pi);
      vec2 poff = (vec2(ironTerrainHash(pi + 17.31), ironTerrainHash(pi + 41.77)) - 0.5) * 0.62;
      vec2 pd = pg - pi - 0.5 - poff;
      float pr = 0.17 + 0.20 * fract(ph * 7.31);
      float pn = length(pd) / pr;
      float occupied = step(0.55 + 0.26 * wSand, ph) * fPebble;
      float body = (1.0 - smoothstep(0.55, 1.0, pn)) * occupied;
      // Dome flank: the normal leans outward, strongest at the shoulder.
      slopeNormal += normalize(pd + 1e-4) * body * min(pn, 1.0) * 2.6;
      // Clasts are a different rock from the matrix they sit in, and each one
      // parks a small contact shadow on the sand immediately around it.
      albedo *= mix(vec3(1.0), vec3(0.62 + 0.66 * fract(ph * 31.7)), body);
      albedo *= 1.0 - 0.30 * occupied * (1.0 - smoothstep(0.95, 1.7, pn)) * (1.0 - body);
      rough = mix(rough, 0.68, body * 0.7);
    }

    // GRAIN. 2 cm relief plus a 6 mm speckle, fading IN over the last 7 m. This
    // is the layer that answers "surfaces that go smooth as they approach the
    // camera fail": at 1 m the ground must gain structure, not lose it.
    if (fGrain > 0.01) {
      vec2 g0 = wp.xz * 34.0;
      float u0 = ironTerrainValue(g0);
      // Grain is mostly RELIEF, barely albedo: sand grains are the same mineral
      // as each other, so what separates them at 30 cm is self-shadowing, not
      // colour. Pushing the albedo instead is what makes procedural sand read as
      // speckled paint.
      albedo *= mix(1.0, 0.90 + 0.20 * u0, fGrain);
      slopeNormal += vec2(u0 - ironTerrainValue(g0 + vec2(0.42, 0.0)),
                          u0 - ironTerrainValue(g0 + vec2(0.0, 0.42))) * 5.6 * fGrain;
      // The 8 mm band is cubed against distance rather than faded linearly: it
      // is only resolvable inside about a metre, and past that it is smaller
      // than a pixel footprint, where keeping it would buy shimmer and nothing
      // else. TAA cannot rescue detail that is already below Nyquist.
      float fSpeck = fGrain * fGrain * fGrain;
      vec2 g1 = ironTerrainRot(wp.xz, 0.3256, -0.9455) * 128.0;
      float u1 = ironTerrainValue(g1);
      albedo *= mix(1.0, 0.93 + 0.14 * u1, fSpeck);
      slopeNormal += vec2(u1 - ironTerrainValue(g1 + vec2(0.5, 0.0)),
                          u1 - ironTerrainValue(g1 + vec2(0.0, 0.5))) * 3.0 * fSpeck;
      // Quartz sand is not Lambertian at 30 cm: the grain faces catch a broad
      // sheen and the shaded sides do not, so roughness has to break up too.
      rough = clamp(rough - (u0 - 0.5) * 0.13 * fGrain, 0.30, 1.0);
    }
  }

  // ---- wet mask (LOOK_SPEC 4.5) -------------------------------------------
  // The tide line is scalloped by the same along-shore noise that shapes the
  // beach cusps, and the boundary is hard-ish with a feather, not a gradient.
  float wet = 0.0;
  if (shoreM < 16.0) {
    float tide = (ironTerrainValue(wp.xz * 0.055) - 0.5) * 2.4;
    wet = clamp(1.0 - smoothstep(-0.25 + tide, 2.1 + tide, shoreM), 0.0, 1.0);
    // THE WRACK LINE. A real beach carries a dark band of organic debris and
    // damp sand a few metres above the swash, and it is the only horizontal
    // value break in an otherwise uniform sheet of sand — without it the beach
    // is one tone from the water to the berm, which is the single flattest
    // thing in these frames.
    float d = (shoreM - 3.4 - tide * 1.6) / 2.8;
    float wrack = exp(-d * d) * (0.45 + 0.55 * edgeNoise);
    albedo *= 1.0 - 0.22 * wrack;
    rough = mix(rough, 0.88, wrack * 0.5);
  }
  albedo *= mix(1.0, 0.60, wet);
  rough = mix(rough, 0.15, wet);
  slopeNormal *= 1.0 - 0.8 * wet;

  // ---- ground transition where LEVEL's geometry lands ---------------------
  float trans = splat.a;
  if (trans > 0.004) {
    vec2 gp = wp.xz * 3.3;
    float grit = ironTerrainValue(gp);
    albedo = mix(albedo, albedo * (0.70 + 0.62 * grit), trans);
    rough = mix(rough, 0.94, trans * 0.75);
    albedo *= 1.0 - 0.26 * trans * trans;
    slopeNormal += vec2(grit - ironTerrainValue(gp + vec2(0.3, 0.0)),
                        grit - ironTerrainValue(gp + vec2(0.0, 0.3))) * 4.0 * trans;
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
