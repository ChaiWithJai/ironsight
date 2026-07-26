/**
 * THE SHARED GLSL NOISE LIBRARY.
 *
 * OWNER: BAKE. Every chunk here has a bit-matched CPU twin in `src/bake/noise.ts`
 * — same integer hash, same lattice, same interpolant, same octave schedule. The
 * two are allowed to disagree only by float32-vs-float64 rounding (~1e-7
 * relative), which over a 600 m map is sub-micron. That parity is not a nicety:
 * `TerrainService.heightAt` feeds physics, nav and scatter while the terrain
 * vertex shader displaces the mesh, and if they fork, players float over bumps
 * and sink into dips.
 *
 * WHY AN INTEGER HASH. The usual `fract(sin(dot(p, k)) * 43758.5)` cannot be
 * reproduced on the CPU — `sin` at large arguments differs between float32 and
 * float64 by whole ULPs of the fractional part, so the two noises decorrelate
 * completely. `ironHashU` is Wellons' `lowbias32` over `uint`, which JS
 * reproduces exactly with `Math.imul` and `>>> 0`.
 *
 * TILEABILITY. Everything a texture bake touches has a `*Tiled` variant taking a
 * cell `period`; the lattice coordinate is wrapped with `mod` before hashing, so
 * the field is exactly periodic and a 512² albedo has no seam. Octaves double
 * the period along with the frequency, so every octave tiles on the same rect.
 *
 * DOMAIN WARPING is the single highest-value function in this file. Procedural
 * texture reads as procedural because its features are axis-aligned and
 * self-similar; warping the domain by another noise field destroys both, and it
 * is what separates "fBm on a wall" from stucco.
 */

/* -------------------------------------------------------------------- hash -- */

export const GLSL_HASH = /* glsl */ `
// Wellons' lowbias32. Reproduced EXACTLY in TS by Math.imul + >>> 0, which is
// what makes CPU/GPU noise parity possible at all.
uint ironHashU(uint x){
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
uint ironHash2u(ivec2 p, uint seed){
  // Sequential rather than xor-combined: xor of two independently hashed axes
  // is symmetric in x/y and produces a visible diagonal correlation.
  return ironHashU(uint(p.x) + ironHashU(uint(p.y) + seed));
}
uint ironHash3u(ivec3 p, uint seed){
  return ironHashU(uint(p.x) + ironHashU(uint(p.y) + ironHashU(uint(p.z) + seed)));
}
// 24 bits is the exact-integer range of a float32 mantissa, so this division is
// lossless on both devices.
float ironUnorm(uint h){ return float(h & 0x00ffffffu) / 16777216.0; }
float ironHash2(ivec2 p, uint seed){ return ironUnorm(ironHash2u(p, seed)); }
float ironHash3(ivec3 p, uint seed){ return ironUnorm(ironHash3u(p, seed)); }
vec2 ironHash2v2(ivec2 p, uint seed){
  uint h = ironHash2u(p, seed);
  return vec2(ironUnorm(h), ironUnorm(ironHashU(h)));
}
vec3 ironHash3v3(ivec3 p, uint seed){
  uint h = ironHash3u(p, seed);
  uint h2 = ironHashU(h);
  return vec3(ironUnorm(h), ironUnorm(h2), ironUnorm(ironHashU(h2)));
}
/** Unit gradient on the circle, from the top 16 bits of the cell hash. */
vec2 ironGrad2(ivec2 p, uint seed){
  float a = ironUnorm(ironHash2u(p, seed)) * 6.28318530718;
  return vec2(cos(a), sin(a));
}
/** Unit gradient on the sphere, area-uniform (z uniform, azimuth uniform). */
vec3 ironGrad3(ivec3 p, uint seed){
  uint h = ironHash3u(p, seed);
  float z = ironUnorm(h) * 2.0 - 1.0;
  float a = ironUnorm(ironHashU(h)) * 6.28318530718;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(a), r * sin(a), z);
}

// Legacy float hashes. Kept because every lane written against the day-0 null
// library calls them; they are NOT CPU-matched and must not be used for
// anything the CPU also evaluates.
float ironHash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float ironHash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ironHash31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }

int ironWrap(int v, int period){ return period > 0 ? ((v % period) + period) % period : v; }
ivec2 ironWrap2(ivec2 v, int period){ return ivec2(ironWrap(v.x, period), ironWrap(v.y, period)); }
`;

/* ------------------------------------------------------------------- value -- */

export const GLSL_VALUE = /* glsl */ `
// Quintic fade: C2 continuous, so a normal map derived analytically from the
// field has no visible facet at the lattice lines. C1 (smoothstep) does.
float ironFade(float t){ return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float ironFadeD(float t){ return 30.0 * t * t * (t * (t - 2.0) + 1.0); }
vec2 ironFade2(vec2 t){ return vec2(ironFade(t.x), ironFade(t.y)); }

float ironValue2Seed(vec2 p, uint seed){
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = ironFade2(f);
  float a = ironHash2(i, seed);
  float b = ironHash2(i + ivec2(1, 0), seed);
  float c = ironHash2(i + ivec2(0, 1), seed);
  float d = ironHash2(i + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/** Value noise plus its ANALYTIC gradient: vec3(value, d/dx, d/dy). */
vec3 ironValueD2(vec2 p, uint seed){
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = ironFade2(f);
  vec2 du = vec2(ironFadeD(f.x), ironFadeD(f.y));
  float a = ironHash2(i, seed);
  float b = ironHash2(i + ivec2(1, 0), seed);
  float c = ironHash2(i + ivec2(0, 1), seed);
  float d = ironHash2(i + ivec2(1, 1), seed);
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
              du.x * (k1 + k3 * u.y),
              du.y * (k2 + k3 * u.x));
}
float ironValue2Tiled(vec2 p, int period, uint seed){
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = ironFade2(f);
  float a = ironHash2(ironWrap2(i, period), seed);
  float b = ironHash2(ironWrap2(i + ivec2(1, 0), period), seed);
  float c = ironHash2(ironWrap2(i + ivec2(0, 1), period), seed);
  float d = ironHash2(ironWrap2(i + ivec2(1, 1), period), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float ironValue3Seed(vec3 p, uint seed){
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 u = vec3(ironFade(f.x), ironFade(f.y), ironFade(f.z));
  float a = mix(mix(ironHash3(i, seed), ironHash3(i + ivec3(1,0,0), seed), u.x),
                mix(ironHash3(i + ivec3(0,1,0), seed), ironHash3(i + ivec3(1,1,0), seed), u.x), u.y);
  float b = mix(mix(ironHash3(i + ivec3(0,0,1), seed), ironHash3(i + ivec3(1,0,1), seed), u.x),
                mix(ironHash3(i + ivec3(0,1,1), seed), ironHash3(i + ivec3(1,1,1), seed), u.x), u.y);
  return mix(a, b, u.z);
}
// Day-0 spellings kept live so nothing written against the null lib breaks.
float ironValue2(vec2 p){ return ironValue2Seed(p, 0u); }
float ironValue3(vec3 p){ return ironValue3Seed(p, 0u); }
`;

/* ----------------------------------------------------------- perlin/simplex -- */

export const GLSL_SIMPLEX = /* glsl */ `
/** Gradient (Perlin) noise, signed, roughly [-1,1]. vec3(value, ddx, ddy). */
vec3 ironPerlinD2(vec2 p, uint seed){
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = ironFade2(f);
  vec2 du = vec2(ironFadeD(f.x), ironFadeD(f.y));
  vec2 ga = ironGrad2(i, seed);
  vec2 gb = ironGrad2(i + ivec2(1, 0), seed);
  vec2 gc = ironGrad2(i + ivec2(0, 1), seed);
  vec2 gd = ironGrad2(i + ivec2(1, 1), seed);
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float k1 = vb - va, k2 = vc - va, k3 = va - vb - vc + vd;
  float v = va + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  // Chain rule through BOTH the interpolant and the corner gradients — this is
  // what makes a normal map exact instead of a 4-tap finite difference.
  vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);
  return vec3(v * 1.4142136, g * 1.4142136);
}
float ironPerlin2(vec2 p, uint seed){ return ironPerlinD2(p, seed).x; }
float ironPerlin2Tiled(vec2 p, int period, uint seed){
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = ironFade2(f);
  vec2 ga = ironGrad2(ironWrap2(i, period), seed);
  vec2 gb = ironGrad2(ironWrap2(i + ivec2(1, 0), period), seed);
  vec2 gc = ironGrad2(ironWrap2(i + ivec2(0, 1), period), seed);
  vec2 gd = ironGrad2(ironWrap2(i + ivec2(1, 1), period), seed);
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.4142136;
}
/** Tileable gradient noise WITH its analytic gradient. vec3(value, ddx, ddy). */
vec3 ironPerlinD2Tiled(vec2 p, int period, uint seed){
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = ironFade2(f);
  vec2 du = vec2(ironFadeD(f.x), ironFadeD(f.y));
  vec2 ga = ironGrad2(ironWrap2(i, period), seed);
  vec2 gb = ironGrad2(ironWrap2(i + ivec2(1, 0), period), seed);
  vec2 gc = ironGrad2(ironWrap2(i + ivec2(0, 1), period), seed);
  vec2 gd = ironGrad2(ironWrap2(i + ivec2(1, 1), period), seed);
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float k1 = vb - va, k2 = vc - va, k3 = va - vb - vc + vd;
  float v = va + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);
  return vec3(v * 1.4142136, g * 1.4142136);
}

/** 3D gradient noise with its analytic gradient in yzw. */
vec4 ironPerlinD3(vec3 p, uint seed){
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 u = vec3(ironFade(f.x), ironFade(f.y), ironFade(f.z));
  vec3 du = vec3(ironFadeD(f.x), ironFadeD(f.y), ironFadeD(f.z));
  vec3 g000 = ironGrad3(i, seed);
  vec3 g100 = ironGrad3(i + ivec3(1,0,0), seed);
  vec3 g010 = ironGrad3(i + ivec3(0,1,0), seed);
  vec3 g110 = ironGrad3(i + ivec3(1,1,0), seed);
  vec3 g001 = ironGrad3(i + ivec3(0,0,1), seed);
  vec3 g101 = ironGrad3(i + ivec3(1,0,1), seed);
  vec3 g011 = ironGrad3(i + ivec3(0,1,1), seed);
  vec3 g111 = ironGrad3(i + ivec3(1,1,1), seed);
  float v000 = dot(g000, f);
  float v100 = dot(g100, f - vec3(1,0,0));
  float v010 = dot(g010, f - vec3(0,1,0));
  float v110 = dot(g110, f - vec3(1,1,0));
  float v001 = dot(g001, f - vec3(0,0,1));
  float v101 = dot(g101, f - vec3(1,0,1));
  float v011 = dot(g011, f - vec3(0,1,1));
  float v111 = dot(g111, f - vec3(1,1,1));
  float k0 = v000;
  float k1 = v100 - v000;
  float k2 = v010 - v000;
  float k3 = v001 - v000;
  float k4 = v000 - v100 - v010 + v110;
  float k5 = v000 - v010 - v001 + v011;
  float k6 = v000 - v100 - v001 + v101;
  float k7 = -v000 + v100 + v010 - v110 + v001 - v101 - v011 + v111;
  float v = k0 + k1*u.x + k2*u.y + k3*u.z + k4*u.x*u.y + k5*u.y*u.z + k6*u.z*u.x + k7*u.x*u.y*u.z;
  vec3 gi = g000
    + u.x * (g100 - g000) + u.y * (g010 - g000) + u.z * (g001 - g000)
    + u.x*u.y * (g000 - g100 - g010 + g110)
    + u.y*u.z * (g000 - g010 - g001 + g011)
    + u.z*u.x * (g000 - g100 - g001 + g101)
    + u.x*u.y*u.z * (-g000 + g100 + g010 - g110 + g001 - g101 - g011 + g111);
  vec3 gd2 = du * vec3(k1 + k4*u.y + k6*u.z + k7*u.y*u.z,
                       k2 + k5*u.z + k4*u.x + k7*u.z*u.x,
                       k3 + k6*u.x + k5*u.y + k7*u.x*u.y);
  return vec4(v * 1.1547005, (gi + gd2) * 1.1547005);
}
float ironPerlin3(vec3 p, uint seed){ return ironPerlinD3(p, seed).x; }

const float IRON_F2 = 0.36602540378;   // 0.5*(sqrt(3)-1)
const float IRON_G2 = 0.21132486540;   // (3-sqrt(3))/6

/** True 2D simplex noise with its analytic gradient. vec3(value, ddx, ddy). */
vec3 ironSimplexD2(vec2 p, uint seed){
  float s = (p.x + p.y) * IRON_F2;
  vec2 ij = floor(p + s);
  float t = (ij.x + ij.y) * IRON_G2;
  vec2 p0 = p - (ij - t);
  vec2 o = p0.x > p0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 p1 = p0 - o + IRON_G2;
  vec2 p2 = p0 - 1.0 + 2.0 * IRON_G2;
  ivec2 i0 = ivec2(ij);
  vec2 g0 = ironGrad2(i0, seed);
  vec2 g1 = ironGrad2(i0 + ivec2(o), seed);
  vec2 g2 = ironGrad2(i0 + ivec2(1, 1), seed);
  float n = 0.0;
  vec2 grad = vec2(0.0);
  // corner 0
  float w = 0.5 - dot(p0, p0);
  if (w > 0.0) {
    float w2 = w * w, w4 = w2 * w2, d = dot(g0, p0);
    n += w4 * d;
    grad += w4 * g0 - 8.0 * w * w2 * d * p0;
  }
  w = 0.5 - dot(p1, p1);
  if (w > 0.0) {
    float w2 = w * w, w4 = w2 * w2, d = dot(g1, p1);
    n += w4 * d;
    grad += w4 * g1 - 8.0 * w * w2 * d * p1;
  }
  w = 0.5 - dot(p2, p2);
  if (w > 0.0) {
    float w2 = w * w, w4 = w2 * w2, d = dot(g2, p2);
    n += w4 * d;
    grad += w4 * g2 - 8.0 * w * w2 * d * p2;
  }
  return vec3(n * 70.0, grad * 70.0);
}
float ironSimplex2(vec2 p, uint seed){ return ironSimplexD2(p, seed).x; }
float ironSimplex3(vec3 p, uint seed){ return ironPerlinD3(p, seed).x; }
`;

/* ------------------------------------------------------------------ worley -- */

export const GLSL_WORLEY = /* glsl */ `
/** F1, F2 and a per-cell id hash. The workhorse for cobble, cracks and scales. */
vec3 ironWorleyF(vec2 p, uint seed, int period){
  ivec2 ip = ivec2(floor(p));
  vec2 fp = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 c = ip + ivec2(x, y);
      ivec2 hc = period > 0 ? ironWrap2(c, period) : c;
      vec2 jitter = ironHash2v2(hc, seed);
      vec2 d = vec2(x, y) + jitter - fp;
      float dist = length(d);
      if (dist < f1) { f2 = f1; f1 = dist; id = ironUnorm(ironHash2u(hc, seed + 977u)); }
      else if (dist < f2) { f2 = dist; }
    }
  }
  return vec3(f1, f2, id);
}
float ironWorley2Seed(vec2 p, uint seed){ return ironWorleyF(p, seed, 0).x; }
float ironWorley2Tiled(vec2 p, int period, uint seed){ return ironWorleyF(p, seed, period).x; }
/** F2-F1: bright ridges exactly on the cell boundaries. Mortar, cracks, veins. */
float ironWorleyEdge(vec2 p, uint seed, int period){
  vec3 f = ironWorleyF(p, seed, period);
  return f.y - f.x;
}
/**
 * Voronoi with a SMOOTH minimum. A hard `min` puts a first-derivative
 * discontinuity along every cell boundary, which shows up as a hairline crease
 * in any normal map derived from it; the exponential blend removes it.
 */
float ironVoronoiSmooth(vec2 p, float k, uint seed, int period){
  ivec2 ip = ivec2(floor(p));
  vec2 fp = fract(p);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 c = ip + ivec2(x, y);
      ivec2 hc = period > 0 ? ironWrap2(c, period) : c;
      vec2 d = vec2(x, y) + ironHash2v2(hc, seed) - fp;
      acc += exp2(-k * length(d));
    }
  }
  return -log2(max(acc, 1e-6)) / k;
}
float ironWorley3(vec3 p, uint seed){
  ivec3 ip = ivec3(floor(p));
  vec3 fp = fract(p);
  float f1 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    ivec3 c = ip + ivec3(x, y, z);
    vec3 d = vec3(x, y, z) + ironHash3v3(c, seed) - fp;
    f1 = min(f1, length(d));
  }
  return f1;
}
// Day-0 spelling.
float ironWorley2(vec2 p){ return ironWorleyF(p, 0u, 0).x; }
`;

/* --------------------------------------------------------------------- fbm -- */

export const GLSL_FBM = /* glsl */ `
float ironFbm2Seed(vec2 p, int octaves, float lacunarity, float gain, uint seed){
  float a = 0.5, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    sum += a * ironPerlin2(p, seed + uint(i) * 131u);
    norm += a;
    p *= lacunarity;
    a *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
/** fBm with its analytic gradient carried through every octave. */
vec3 ironFbmD2(vec2 p, int octaves, float lacunarity, float gain, uint seed){
  float a = 0.5, norm = 0.0, freq = 1.0;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    vec3 n = ironPerlinD2(p * freq, seed + uint(i) * 131u);
    sum += vec3(a * n.x, a * freq * n.y, a * freq * n.z);
    norm += a;
    freq *= lacunarity;
    a *= gain;
  }
  return norm > 0.0 ? sum / norm : vec3(0.0);
}
/**
 * DERIVATIVE-DAMPED fBm ("swiss"/erosion fBm). Each octave's amplitude is
 * divided by 1 + |accumulated gradient|², so detail is suppressed on slopes and
 * survives on flats. That single term is what turns generic cloud-fBm into
 * something that reads as WEATHERED rock and eroded stucco.
 */
float ironFbmEroded2(vec2 p, int octaves, float lacunarity, float gain, uint seed){
  float a = 0.5, sum = 0.0, norm = 0.0, freq = 1.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    vec3 n = ironPerlinD2(p * freq, seed + uint(i) * 131u);
    grad += n.yz * freq;
    float damp = 1.0 / (1.0 + dot(grad, grad) * 0.35);
    sum += a * n.x * damp;
    norm += a;
    freq *= lacunarity;
    a *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float ironFbm2Tiled(vec2 p, int period, int octaves, float gain, uint seed){
  float a = 0.5, sum = 0.0, norm = 0.0;
  int per = period;
  vec2 q = p;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    sum += a * ironPerlin2Tiled(q, per, seed + uint(i) * 131u);
    norm += a;
    q *= 2.0;
    per *= 2;
    a *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
/**
 * Tileable fBm carrying its analytic gradient through every octave. This is the
 * one to reach for when the field becomes a height map: the gradient IS the
 * normal map, exactly, with no finite-difference low-pass eating the finest
 * octave — which is the octave the whole "does it stay detailed as you approach"
 * test lives in.
 */
vec3 ironFbmD2Tiled(vec2 p, int period, int octaves, float gain, uint seed){
  float a = 0.5, norm = 0.0, freq = 1.0;
  int per = period;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    vec3 n = ironPerlinD2Tiled(p * freq, per, seed + uint(i) * 131u);
    sum += vec3(a * n.x, a * freq * n.y, a * freq * n.z);
    norm += a;
    freq *= 2.0;
    per *= 2;
    a *= gain;
  }
  return norm > 0.0 ? sum / norm : vec3(0.0);
}
float ironTurbulence2Tiled(vec2 p, int period, int octaves, float gain, uint seed){
  float a = 0.5, sum = 0.0, norm = 0.0;
  int per = period;
  vec2 q = p;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    sum += a * abs(ironPerlin2Tiled(q, per, seed + uint(i) * 131u));
    norm += a;
    q *= 2.0;
    per *= 2;
    a *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float ironFbm3(vec3 p, int octaves, float lacunarity, float gain, uint seed){
  float a = 0.5, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    sum += a * ironPerlin3(p, seed + uint(i) * 131u);
    norm += a;
    p *= lacunarity;
    a *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
// Day-0 spellings.
float ironFbm2(vec2 p, int octaves, float lacunarity, float gain){
  return ironFbm2Seed(p, octaves, lacunarity, gain, 0u) * 0.5 + 0.5;
}
`;

export const GLSL_RIDGED = /* glsl */ `
/**
 * Ridged MULTIFRACTAL (Musgrave): each octave is weighted by the previous one,
 * so ridges reinforce along their length instead of being modulated uniformly.
 * `offset` sets the ridge height, `gain` how strongly a high octave feeds the
 * next. This is the cliff-strata and cracked-render generator.
 */
float ironRidgedMulti2(vec2 p, int octaves, float lacunarity, float gain, float offset, uint seed){
  float sum = 0.0, freq = 1.0, amp = 0.5, weight = 1.0, norm = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    float n = offset - abs(ironPerlin2(p * freq, seed + uint(i) * 131u));
    n *= n;
    n *= weight;
    weight = clamp(n * gain, 0.0, 1.0);
    sum += n * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float ironRidgedTiled2(vec2 p, int period, int octaves, float offset, uint seed){
  float sum = 0.0, amp = 0.5, weight = 1.0, norm = 0.0;
  int per = period;
  vec2 q = p;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    float n = offset - abs(ironPerlin2Tiled(q, per, seed + uint(i) * 131u));
    n *= n * weight;
    weight = clamp(n * 2.0, 0.0, 1.0);
    sum += n * amp;
    norm += amp;
    q *= 2.0;
    per *= 2;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
/** Billow: |noise| stacked. Puffy, rounded lobes — sand, cumulus, rust bloom. */
float ironBillow2Tiled(vec2 p, int period, int octaves, uint seed){
  float sum = 0.0, amp = 0.5, norm = 0.0;
  int per = period;
  vec2 q = p;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    sum += amp * (abs(ironPerlin2Tiled(q, per, seed + uint(i) * 131u)) * 2.0 - 1.0);
    norm += amp;
    q *= 2.0;
    per *= 2;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm * 0.5 + 0.5 : 0.0;
}
// Day-0 spelling.
float ironRidged2(vec2 p, int octaves){ return ironRidgedMulti2(p, octaves, 2.03, 2.0, 1.0, 0u); }
`;

/* -------------------------------------------------------------------- curl -- */

export const GLSL_CURL = /* glsl */ `
/**
 * ANALYTIC curl of a three-component Perlin potential. Finite differencing the
 * potential costs six noise evaluations and still leaks divergence at the
 * epsilon scale, which shows up as particles slowly clumping; the exact
 * gradients from ironPerlinD3 are divergence-free to float precision.
 */
vec3 ironCurl3Seed(vec3 p, uint seed){
  vec4 a = ironPerlinD3(p, seed);
  vec4 b = ironPerlinD3(p + vec3(31.416, 0.0, 0.0), seed + 5171u);
  vec4 c = ironPerlinD3(p + vec3(0.0, 0.0, 57.13), seed + 9161u);
  return vec3(c.z - b.w, a.w - c.y, b.y - a.z);
}
vec3 ironCurl3(vec3 p){ return ironCurl3Seed(p, 0u); }
`;

/* -------------------------------------------------------------------- warp -- */

export const GLSL_WARP = /* glsl */ `
/**
 * DOMAIN WARPING — the highest-value function in this file.
 *
 * fBm alone is axis-aligned and self-similar, and the eye reads that instantly
 * as "procedural". Displacing the sample point by another noise field bends the
 * features into filaments and swirls that no octave schedule can produce.
 * Two levels (warp the warp) is Iñigo Quílez's arrangement and is where the
 * character comes from; one level looks wobbly, three costs a lot for little.
 *
 * The offsets are large irrational-ish constants so the three fields decorrelate
 * without needing three separate seeds in the hot path.
 */
vec2 ironWarp2Tiled(vec2 p, int period, float amount, int octaves, uint seed){
  vec2 q = vec2(ironFbm2Tiled(p, period, octaves, 0.5, seed + 17u),
                ironFbm2Tiled(p + vec2(5.2, 1.3), period, octaves, 0.5, seed + 91u));
  vec2 r = vec2(ironFbm2Tiled(p + 4.0 * q + vec2(1.7, 9.2), period, octaves, 0.5, seed + 233u),
                ironFbm2Tiled(p + 4.0 * q + vec2(8.3, 2.8), period, octaves, 0.5, seed + 409u));
  return p + amount * r;
}
float ironWarpedFbm2Tiled(vec2 p, int period, float amount, int octaves, uint seed){
  return ironFbm2Tiled(ironWarp2Tiled(p, period, amount, max(2, octaves - 2), seed), period, octaves, 0.5, seed + 5u);
}
/** Single-level warp for cheap cases (detail layers, mesoscale break-up). */
vec2 ironWarp2Seed(vec2 p, float amount, uint seed){
  return p + amount * vec2(ironPerlin2(p + vec2(11.7, 3.1), seed),
                           ironPerlin2(p - vec2(5.3, 7.9), seed + 61u));
}
// Day-0 spelling.
vec2 ironWarp2(vec2 p, float amount){ return ironWarp2Seed(p, amount, 0u); }
`;

/* ------------------------------------------------------------------- gabor -- */

export const GLSL_GABOR = /* glsl */ `
float ironGabor(vec2 p, float freq, float angle){
  vec2 d = vec2(cos(angle), sin(angle));
  return exp(-dot(p, p) * 2.0) * cos(6.2831853 * freq * dot(p, d));
}
/**
 * Anisotropic streak noise: bands stretched along `angle`, jittered per band.
 * Wood grain, brushed metal, rain streaking down stucco, sand ripple.
 */
float ironStreak2(vec2 p, float angle, float stretch, int period, uint seed){
  float c = cos(angle), s = sin(angle);
  vec2 q = vec2(c * p.x - s * p.y, (s * p.x + c * p.y) * stretch);
  return ironFbm2Tiled(q, period, 5, 0.5, seed);
}
/** Sparse impulse field — flecks, aggregate, mica. Returns 0..1 coverage. */
float ironFlecks2(vec2 p, float density, int period, uint seed){
  ivec2 ip = ivec2(floor(p));
  vec2 fp = fract(p);
  float best = 1.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    ivec2 c = ironWrap2(ip + ivec2(x, y), period);
    uint h = ironHash2u(c, seed);
    if (ironUnorm(h) > density) continue;
    vec2 o = vec2(ironUnorm(ironHashU(h)), ironUnorm(ironHashU(ironHashU(h))));
    float r = 0.08 + 0.22 * ironUnorm(ironHashU(ironHashU(ironHashU(h))));
    best = min(best, length(vec2(x, y) + o - fp) / r);
  }
  return 1.0 - clamp(best, 0.0, 1.0);
}
`;

/* --------------------------------------------------------------- triplanar -- */

export const GLSL_TRIPLANAR = /* glsl */ `
vec3 ironTriplanarWeights(vec3 n, float sharpness){
  vec3 w = pow(abs(n), vec3(sharpness));
  return w / max(dot(w, vec3(1.0)), 1e-4);
}
vec4 ironTriplanarSample(sampler2D tex, vec3 worldPos, vec3 n, float scale, float sharpness){
  vec3 w = ironTriplanarWeights(n, sharpness);
  return texture(tex, worldPos.zy * scale) * w.x
       + texture(tex, worldPos.xz * scale) * w.y
       + texture(tex, worldPos.xy * scale) * w.z;
}
/** Whiteout blend for triplanar TANGENT normals — keeps detail on all 3 axes. */
vec3 ironTriplanarNormal(vec3 nx, vec3 ny, vec3 nz, vec3 n, vec3 w){
  nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
  ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
  nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
  return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
}
`;

/* -------------------------------------------------------------- stochastic -- */

export const GLSL_STOCHASTIC = /* glsl */ `
/**
 * Stochastic (hex-tile) texture sampling. Three hexagonal lattice cells each
 * offset the UV by a per-cell random vector and the results are blended by the
 * barycentric weights, so a 4 m texture covering a 200 m terrain shows NO
 * repeat — which is item one on the brief's list of hobby-demo tells.
 *
 * The caller must pass explicit derivatives: the per-cell offset is discontinuous
 * at hex boundaries and implicit derivatives would blur a one-pixel line along
 * every edge.
 */
vec4 ironStochasticSample(sampler2D tex, vec2 uv, vec2 ddx, vec2 ddy, uint seed){
  // Triangle-grid variant (Heitz & Neyret, simplified): three lattice vertices,
  // barycentric weights, per-vertex UV offset from the cell hash.
  const mat2 toSkewed = mat2(1.0, 0.0, -0.57735027, 1.15470054);
  vec2 sk = toSkewed * uv * 3.0;
  ivec2 base = ivec2(floor(sk));
  vec3 bary;
  bary.xy = fract(sk);
  bary.z = 1.0 - bary.x - bary.y;
  ivec2 v0, v1, v2;
  if (bary.z > 0.0) {
    bary = vec3(bary.z, bary.y, bary.x);
    v0 = base; v1 = base + ivec2(0, 1); v2 = base + ivec2(1, 0);
  } else {
    bary = vec3(-bary.z, 1.0 - bary.y, 1.0 - bary.x);
    v0 = base + ivec2(1, 1); v1 = base + ivec2(1, 0); v2 = base + ivec2(0, 1);
  }
  vec4 c0 = textureGrad(tex, uv + ironHash2v2(v0, seed), ddx, ddy);
  vec4 c1 = textureGrad(tex, uv + ironHash2v2(v1, seed), ddx, ddy);
  vec4 c2 = textureGrad(tex, uv + ironHash2v2(v2, seed), ddx, ddy);
  // Variance-preserving blend: a plain linear blend of three decorrelated
  // samples has 1/sqrt(3) of the original contrast and reads as washed out.
  vec4 mean = (c0 + c1 + c2) / 3.0;
  vec4 blend = c0 * bary.x + c1 * bary.y + c2 * bary.z;
  float wsum = inversesqrt(dot(bary, bary));
  return mean + (blend - mean) * wsum;
}
// Day-0 spelling.
vec2 ironStochasticUv(vec2 uv, out float w){ vec2 i = floor(uv); w = 1.0; return uv + ironHash2v2(ivec2(i), 0u); }
`;

/* ------------------------------------------------------------------ detail -- */

export const GLSL_DETAIL = /* glsl */ `
float ironDetailFade(float dist, float start, float end){ return 1.0 - smoothstep(start, end, dist); }
/** Reoriented normal mapping (Barré-Brisebois): correct detail-over-base blend. */
vec3 ironBlendNormalRnm(vec3 base, vec3 detail){
  vec3 t = base * vec3(2.0, 2.0, 2.0) + vec3(-1.0, -1.0, 0.0);
  vec3 u = detail * vec3(-2.0, -2.0, 2.0) + vec3(1.0, 1.0, -1.0);
  return normalize(t * dot(t, u) - u * t.z);
}
/**
 * Height-based layer blend. A linear lerp between two materials produces a soft
 * dissolve that reads as fog; biasing by the height channels makes gravel sit IN
 * the gaps of the cobble instead of over it.
 */
float ironHeightBlend(float ha, float hb, float t, float contrast){
  float a = ha + (1.0 - t);
  float b = hb + t;
  float m = max(a, b) - contrast;
  return clamp((b - m) / max(1e-4, (a - m) + (b - m)), 0.0, 1.0);
}
`;

/* -------------------------------------------------------------------- wear -- */

export const GLSL_WEAR = /* glsl */ `
float ironWear(float curvature, float ao, float bias){ return clamp(curvature * (1.0 - ao) + bias, 0.0, 1.0); }
/**
 * CURVATURE from a height field's second derivative, via its analytic gradient.
 * Positive on convex edges, negative in creases. Edge wear driven by this is the
 * single strongest "this is a real object" cue: paint chips off corners and
 * grime settles in creases, and both fall out of one number.
 */
float ironCurvatureFromGrad(vec2 gradCentre, vec2 gradDx, vec2 gradDy){
  return (gradDx.x - gradCentre.x) + (gradDy.y - gradCentre.y);
}
/** Convexity mask: 1 on exposed edges, 0 in occluded creases. */
float ironEdgeWear(float curvature, float strength, float threshold){
  return clamp((curvature * strength - threshold) / max(1e-4, 1.0 - threshold), 0.0, 1.0);
}
/** Grime settles by gravity: more where the surface faces up and is concave. */
float ironGrime(vec3 worldNormal, float cavity, float amount){
  float up = clamp(worldNormal.y * 0.5 + 0.5, 0.0, 1.0);
  return clamp((up * up * 0.7 + (1.0 - cavity) * 0.6) * amount, 0.0, 1.0);
}
/** Wetness darkens albedo and drops roughness — the porosity model, cheaply. */
vec3 ironWetAlbedo(vec3 albedo, float wetness, float porosity){
  return mix(albedo, albedo * mix(1.0, 0.35, porosity), wetness);
}
`;

/* ----------------------------------------------------------------- packing -- */

export const GLSL_PACKING = /* glsl */ `
vec2 ironOctEncode(vec3 n){
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * sign(n.xy);
  return e * 0.5 + 0.5;
}
vec3 ironOctDecode(vec2 e){
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}
/**
 * Tangent-space normal from an ANALYTIC height gradient. `strength` is metres of
 * height per UV unit; feeding a finite difference here instead is what makes
 * procedural normal maps look faceted at high zoom.
 */
vec3 ironNormalFromGrad(vec2 grad, float strength){
  return normalize(vec3(-grad.x * strength, -grad.y * strength, 1.0));
}
vec2 ironPackNormalXY(vec3 n){ return normalize(n).xy * 0.5 + 0.5; }
vec3 ironUnpackNormalXY(vec2 e){
  vec2 xy = e * 2.0 - 1.0;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}
`;

/* -------------------------------------------------------------- colorspace -- */

export const GLSL_COLORSPACE = /* glsl */ `
vec3 ironSrgbToLinear(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 ironLinearToSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float ironLuminance(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 ironHueShift(vec3 c, float shift){
  const vec3 k = vec3(0.57735);
  float cosA = cos(shift);
  return c * cosA + cross(k, c) * sin(shift) + k * dot(k, c) * (1.0 - cosA);
}
/**
 * Perceptual variation of a base colour. Hue/value/saturation are jittered on
 * SEPARATE noise fields at different scales: a single multiplier moves all three
 * together and reads as a lighting change rather than as different material.
 */
vec3 ironTintVary(vec3 base, float hue, float value, float sat){
  vec3 c = ironHueShift(base, hue);
  float l = ironLuminance(c);
  c = mix(vec3(l), c, sat);
  return clamp(c * value, 0.0, 1.0);
}
`;

/**
 * The registered chunk table, in DEPENDENCY ORDER. `GpuBakeDevice` prepends all
 * of it to every bake fragment, so a bake body can call anything here without an
 * include directive; `RenderGraph.fullscreen` deliberately does NOT, so a lane
 * writing a runtime pass pastes the chunks it needs into `prelude`.
 */
export const NOISE_GLSL = Object.freeze({
  hash: GLSL_HASH,
  value: GLSL_VALUE,
  simplex: GLSL_SIMPLEX,
  worley: GLSL_WORLEY,
  fbm: GLSL_FBM,
  ridged: GLSL_RIDGED,
  curl: GLSL_CURL,
  warp: GLSL_WARP,
  gabor: GLSL_GABOR,
  triplanar: GLSL_TRIPLANAR,
  stochastic: GLSL_STOCHASTIC,
  detail: GLSL_DETAIL,
  wear: GLSL_WEAR,
  packing: GLSL_PACKING,
  colorspace: GLSL_COLORSPACE,
});

/** Concatenated in dependency order — what the bake device actually prepends. */
export const NOISE_GLSL_PRELUDE: string = [
  GLSL_HASH,
  GLSL_VALUE,
  GLSL_SIMPLEX,
  GLSL_WORLEY,
  GLSL_FBM,
  GLSL_RIDGED,
  GLSL_CURL,
  GLSL_WARP,
  GLSL_GABOR,
  GLSL_TRIPLANAR,
  GLSL_STOCHASTIC,
  GLSL_DETAIL,
  GLSL_WEAR,
  GLSL_PACKING,
  GLSL_COLORSPACE,
].join('\n');
