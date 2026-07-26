/**
 * TextureSet production — the machine that makes "zero binary art assets"
 * survivable. OWNER: BAKE.
 *
 * Given a `MaterialRecipe` this produces the canonical two-sampler PBR set:
 *
 *   albedoHeight   RGBA8 sRGB    rgb = base colour, a = height
 *   normalRoughAo  RGBA8 linear  rg  = tangent normal xy, b = roughness, a = AO
 *   wear           RGBA8 linear  r   = edge wear, g = grime, b = cavity, a = convexity
 *
 * TWO PASSES, AND WHY
 * -------------------
 * Pass A evaluates the expensive part exactly once per texel: pattern relief,
 * domain-warped macro fBm, meso turbulence, micro grain, colour variation and
 * base roughness. It writes a FLOAT height field.
 *
 * Pass B is a gather over that height field, and every one of the three things
 * that make procedural material read as real comes out of it:
 *   - the NORMAL is a central difference of the final height, so it agrees with
 *     the height channel by construction (a normal map baked from a different
 *     field than the parallax height is the classic "why does POM swim" bug);
 *   - AMBIENT OCCLUSION is a real horizon search over the height, so mortar
 *     courses, plank gaps and cobble interstices are dark because they are
 *     GEOMETRICALLY occluded, not because someone painted a line there;
 *   - EDGE WEAR is driven by the height field's CURVATURE. Paint chips off
 *     convex edges and grime settles in concave creases, and both fall out of
 *     one Laplacian. This is the single strongest "this is a real object" cue
 *     available at bake time and it is free once you have the height.
 *
 * THREE SCALES, AND NO VISIBLE REPEAT
 * -----------------------------------
 * Every field is TILEABLE by construction (`*Tiled` noise with a cell period
 * equal to one UV repeat), so the map has no seam. Repeat is then broken at
 * three frequencies: a domain-warped macro field at ~3 cells per tile that
 * blotches colour and height, a meso field at ~12 that gives the surface its
 * texture, and a micro field at ~48 that keeps it from going smooth as the
 * camera closes. Domain warping the macro field is what stops the whole thing
 * looking like fBm on a wall.
 */
import * as THREE from 'three';
import { MipMode, RTFormat, type SurfaceId, type TextureSet } from '@/engine/types';
import type { IronGpuBakeDevice } from '@/bake/gpu-device';

/** Which relief generator drives the pattern term. */
export enum PatternKind {
  /** No pattern — stucco, plaster, sand, dirt, fabric. */
  None = 0,
  /** Running-bond ashlar masonry with mortar courses. */
  Ashlar = 1,
  /** Voronoi cobbles with sand-filled interstices. */
  Cobble = 2,
  /** Sawn planks with gaps and grain. */
  Planks = 3,
  /** Riveted sheet-metal panels with seams. */
  Panels = 4,
}

export interface MaterialRecipe {
  readonly id: string;
  readonly surface: SurfaceId;
  /** World metres covered by one UV repeat. */
  readonly tiling: number;
  readonly metalness: number;
  readonly pattern: PatternKind;
  /** LINEAR base colours; the macro field blends between them. */
  readonly colorA: readonly [number, number, number];
  readonly colorB: readonly [number, number, number];
  /** Revealed where edge wear cuts through — bare wood under paint, raw steel. */
  readonly wearColor: readonly [number, number, number];
  readonly grimeColor: readonly [number, number, number];
  readonly fleckColor: readonly [number, number, number];
  /** Noise cells per UV repeat at each of the three scales. */
  readonly freq: readonly [number, number, number];
  /** Amplitude of each scale, plus the pattern relief, in height units. */
  readonly amp: readonly [number, number, number, number];
  /** Domain-warp strength on the macro field, in macro cells. */
  readonly warp: number;
  /** Pattern: cells across U, cells across V, seam width, seam depth. */
  readonly patternParams: readonly [number, number, number, number];
  /** roughness base, roughness variation, wear roughness, AO→albedo strength. */
  readonly surfaceParams: readonly [number, number, number, number];
  /** edge wear, grime, crack density, fleck density. */
  readonly aging: readonly [number, number, number, number];
  /** hue jitter, value jitter, saturation jitter — separate fields, on purpose. */
  readonly variation: readonly [number, number, number];
  /** Tangent-normal strength. 1 is "believe the height field". */
  readonly normalStrength: number;
  /** Height-field AO strength and search radius in texels. */
  readonly ao: readonly [number, number];
}

/* -------------------------------------------------------------- pass A GLSL */

const PATTERN_GLSL = /* glsl */ `
uniform ivec3 uFreq;
uniform vec4 uAmp;
uniform vec4 uPattern;
uniform vec4 uSurfaceP;
uniform vec4 uAging;
uniform vec3 uVary;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uFleckColor;
uniform float uWarp;
uniform uint uSeedU;

/**
 * Returns pattern RELIEF in [-1,1] and, through the out params, the per-cell
 * random used for colour/height variation and the normalised distance to the
 * nearest seam (which pass B turns into AO and wear).
 */
float ironPatternRelief(vec2 uv, out float cellRand, out float seamDist) {
  cellRand = 0.5;
  seamDist = 1.0;
#if IRON_PATTERN == 1
  // Running bond. Each course is offset half a block plus a per-course jitter,
  // because a perfectly regular offset reads as tiled at any distance.
  vec2 g = uv * uPattern.xy;
  float course = floor(g.y);
  float jitter = ironUnorm(ironHash2u(ivec2(0, int(course)), uSeedU)) * 0.22;
  g.x += mod(course, 2.0) * 0.5 + jitter;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  ivec2 ic = ivec2(ironWrap(int(cell.x), int(uPattern.x)), ironWrap(int(cell.y), int(uPattern.y)));
  cellRand = ironUnorm(ironHash2u(ic, uSeedU + 13u));
  float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  seamDist = clamp(e / max(uPattern.z, 1e-3), 0.0, 1.0);
  float face = smoothstep(uPattern.z * 0.3, uPattern.z, e);
  // Every block sits slightly proud or shy and tilts a little; a wall of blocks
  // all flush with each other is the giveaway that it came out of a modulo.
  float bow = (cellRand - 0.5) * 0.55
            + (f.x - 0.5) * (ironUnorm(ironHash2u(ic, uSeedU + 91u)) - 0.5) * 0.5
            + (f.y - 0.5) * (ironUnorm(ironHash2u(ic, uSeedU + 191u)) - 0.5) * 0.4;
  return mix(-uPattern.w, bow, face);
#elif IRON_PATTERN == 2
  // Cobbles: F1 gives the dome, F2-F1 the gap between stones.
  vec3 w = ironWorleyF(uv * uPattern.x, uSeedU, int(uPattern.x));
  cellRand = w.z;
  float gap = smoothstep(0.0, uPattern.z, w.y - w.x);
  seamDist = gap;
  float dome = 1.0 - smoothstep(0.05, 0.52, w.x);
  return mix(-uPattern.w, dome * (0.6 + cellRand * 0.4), gap);
#elif IRON_PATTERN == 3
  // Planks. Each board is offset along its length by a per-board hash so the
  // butt joints never line up across the surface.
  vec2 g = uv * uPattern.xy;
  float board = floor(g.x);
  float slide = ironUnorm(ironHash2u(ivec2(int(board), 0), uSeedU)) * 3.0;
  g.y += slide;
  vec2 cell = vec2(board, floor(g.y));
  vec2 f = vec2(fract(g.x), fract(g.y));
  ivec2 ic = ivec2(ironWrap(int(cell.x), int(uPattern.x)), int(cell.y));
  cellRand = ironUnorm(ironHash2u(ic, uSeedU + 13u));
  float eu = min(f.x, 1.0 - f.x);
  float ev = min(f.y, 1.0 - f.y);
  seamDist = clamp(min(eu / max(uPattern.z, 1e-3), ev / max(uPattern.z * 2.0, 1e-3)), 0.0, 1.0);
  float face = min(smoothstep(uPattern.z * 0.3, uPattern.z, eu),
                   smoothstep(uPattern.z * 0.6, uPattern.z * 2.0, ev));
  // Cupping: a weathered board is concave across its width.
  float cup = -(f.x - 0.5) * (f.x - 0.5) * 1.6 + 0.1;
  return mix(-uPattern.w, cup + (cellRand - 0.5) * 0.35, face);
#elif IRON_PATTERN == 4
  // Sheet panels with a rivet line inset from every seam.
  vec2 g = uv * uPattern.xy;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  ivec2 ic = ivec2(ironWrap(int(cell.x), int(uPattern.x)), ironWrap(int(cell.y), int(uPattern.y)));
  cellRand = ironUnorm(ironHash2u(ic, uSeedU + 13u));
  float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  seamDist = clamp(e / max(uPattern.z, 1e-3), 0.0, 1.0);
  float face = smoothstep(uPattern.z * 0.25, uPattern.z, e);
  // Sheet metal bows between its fixings; that slow curve is what catches the
  // sun in a line down a container and reads instantly as thin steel.
  float bow = sin(f.x * 3.14159) * sin(f.y * 3.14159) * 0.35 * (0.4 + cellRand * 0.6);
  vec2 rp = f * 8.0;
  vec2 ri = floor(rp);
  vec2 rf = fract(rp) - 0.5;
  float onBorder = (ri.x < 0.5 || ri.x > 6.5 || ri.y < 0.5 || ri.y > 6.5) ? 1.0 : 0.0;
  float rivet = onBorder * (1.0 - smoothstep(0.16, 0.30, length(rf))) * 0.55;
  return mix(-uPattern.w, bow + rivet, face);
#else
  return 0.0;
#endif
}
`;

const FIELD_FS = /* glsl */ `
${PATTERN_GLSL}

void main() {
  vec2 uv = vUv;
  int fMacro = uFreq.x;
  int fMeso = uFreq.y;
  int fMicro = uFreq.z;

  float cellRand;
  float seamDist;
  float pattern = ironPatternRelief(uv, cellRand, seamDist);

  // MACRO — domain warped. This is the term that destroys the "fBm on a wall"
  // read: the warp bends the blotches into filaments that no octave schedule
  // produces, and it is tileable because the warp field is tileable too.
  vec2 warped = ironWarp2Tiled(uv * float(fMacro), fMacro, uWarp, 2, uSeedU + 3u);
  vec3 macro = ironFbmD2Tiled(warped, fMacro, 4, 0.5, uSeedU + 5u);

  // MESO — the surface's own texture at arm's length.
  vec3 meso = ironFbmD2Tiled(uv * float(fMeso), fMeso, 3, 0.55, uSeedU + 29u);

  // MICRO — what stops the surface going smooth as the camera approaches, which
  // is item two on the brief's list of things that betray a hobby demo.
  vec3 micro = ironFbmD2Tiled(uv * float(fMicro), fMicro, 2, 0.5, uSeedU + 71u);

  float h = 0.5
    + pattern * uAmp.w
    + macro.x * uAmp.x
    + meso.x * uAmp.y
    + micro.x * uAmp.z;

  // Cracks ride the boundaries of a coarse Voronoi, so they are connected
  // networks rather than isolated scratches.
  float crackEdge = ironWorleyEdge(uv * float(fMeso) * 0.5, uSeedU + 401u, fMeso / 2);
  float crack = (1.0 - smoothstep(0.0, 0.06, crackEdge)) * uAging.z;
  crack *= smoothstep(0.35, 0.75, macro.x * 0.5 + 0.5);   // only where it is weathered
  h -= crack * 0.09;

  // ---- colour -------------------------------------------------------------
  float blend = clamp(macro.x * 0.75 + 0.5 + (cellRand - 0.5) * 0.7, 0.0, 1.0);
  vec3 col = mix(uColorA, uColorB, blend);
  // Hue, value and saturation are jittered on DIFFERENT fields at different
  // scales. Driving all three from one multiplier reads as a lighting change,
  // not as a different piece of stone.
  col = ironTintVary(
    col,
    (cellRand - 0.5) * uVary.x + macro.y * 0.05 * uVary.x,
    1.0 + meso.x * uVary.y + (cellRand - 0.5) * uVary.y * 0.6,
    1.0 + micro.x * uVary.z);
  float fleck = ironFlecks2(uv * float(fMicro), uAging.w, fMicro, uSeedU + 511u);
  col = mix(col, uFleckColor, fleck * 0.65);
  col *= 1.0 - crack * 0.35;

  float rough = clamp(uSurfaceP.x + meso.x * uSurfaceP.y + micro.x * uSurfaceP.y * 0.6
                      + (cellRand - 0.5) * uSurfaceP.y * 0.5, 0.03, 1.0);

  outColor0 = vec4(col, h);
  outColor1 = vec4(rough, seamDist, cellRand, crack);
}
`;

/* -------------------------------------------------------------- pass B GLSL */

const COMPOSE_FS = /* glsl */ `
uniform sampler2D uFieldA;
uniform sampler2D uFieldB;
uniform vec4 uCompose;     // normalStrength, aoStrength, aoRadius(texels), aoAlbedo
uniform vec4 uAgingB;      // edgeWear, grime, curvatureScale, wearRoughness
uniform vec3 uWearColor;
uniform vec3 uGrimeColor;
uniform ivec3 uFreqB;
uniform uint uSeedB;

float heightAt(vec2 uv) { return texture(uFieldA, uv).a; }

void main() {
  vec2 uv = vUv;
  vec2 texel = 1.0 / uResolution;
  float h = heightAt(uv);
  float hL = heightAt(uv - vec2(texel.x, 0.0));
  float hR = heightAt(uv + vec2(texel.x, 0.0));
  float hD = heightAt(uv - vec2(0.0, texel.y));
  float hU = heightAt(uv + vec2(0.0, texel.y));

  // Central difference of the FINAL height, so the normal and the height
  // channel cannot disagree — which is what makes parallax occlusion stable.
  // 2/res is the texel spacing in the same units as the height difference, so
  // the strength knob stays meaningful when the bake degrades resolution.
  vec3 n = normalize(vec3((hL - hR) * uCompose.x, (hD - hU) * uCompose.x, 2.0 * texel.x));

  // ---- height-derived ambient occlusion -----------------------------------
  // Horizon search: eight directions, four steps. Anything occluding this texel
  // has to rise above the line of sight, so mortar courses and plank gaps go
  // dark because they are IN a groove, not because a mask says so.
  float ao = 0.0;
  const int DIRS = 8;
  for (int d = 0; d < DIRS; d++) {
    float a = (float(d) + 0.5) * 6.2831853 / float(DIRS);
    vec2 dir = vec2(cos(a), sin(a));
    float maxSlope = 0.0;
    for (int s = 1; s <= 4; s++) {
      float dist = float(s) * uCompose.z;
      float hs = heightAt(uv + dir * texel * dist);
      maxSlope = max(maxSlope, (hs - h) / (dist * texel.x));
    }
    ao += 1.0 - clamp(maxSlope * uCompose.y * 0.02, 0.0, 1.0);
  }
  ao /= float(DIRS);
  ao = clamp(ao, 0.0, 1.0);

  // ---- curvature ----------------------------------------------------------
  // Discrete Laplacian. Positive = the texel sits below its neighbours (a
  // crease); negative = it stands proud (an edge).
  float lap = (hL + hR + hU + hD) - 4.0 * h;
  float convex = clamp(-lap * uAgingB.z, 0.0, 1.0);
  float concave = clamp(lap * uAgingB.z, 0.0, 1.0);

  // Wear is never uniform: a mask at the meso scale decides WHICH edges got
  // knocked about, or every corner in the level wears identically.
  float wearMask = ironFbm2Tiled(uv * float(uFreqB.y), uFreqB.y, 3, 0.5, uSeedB + 901u) * 0.5 + 0.5;
  float seam = texture(uFieldB, uv).g;
  float wear = clamp(convex * uAgingB.x * (0.25 + wearMask * 1.5), 0.0, 1.0);
  // Grime settles where water sits: creases, seams, and anything the horizon
  // search says is occluded.
  float grimeMask = ironFbm2Tiled(uv * float(uFreqB.x), uFreqB.x, 3, 0.5, uSeedB + 77u) * 0.5 + 0.5;
  float grime = clamp((concave * 0.6 + (1.0 - ao) * 1.1 + (1.0 - seam) * 0.5) * uAgingB.y * (0.35 + grimeMask), 0.0, 1.0);

  vec3 albedo = texture(uFieldA, uv).rgb;
  albedo = mix(albedo, uWearColor, wear);
  albedo = mix(albedo, uGrimeColor, grime * 0.8);
  // A LITTLE baked cavity darkening. Not full AO — the renderer applies that —
  // but the sub-texel occlusion no screen-space term can ever recover.
  albedo *= mix(1.0, ao, uCompose.w);

  float rough = texture(uFieldB, uv).r;
  rough = clamp(mix(rough, uAgingB.w, wear), 0.03, 1.0);
  rough = clamp(rough + grime * 0.12, 0.03, 1.0);

  outColor0 = vec4(albedo, h);
  outColor1 = vec4(n.xy * 0.5 + 0.5, rough, ao);
  outColor2 = vec4(wear, grime, ao, convex);
}
`;

/* ---------------------------------------------------------------- producer */

export interface TextureBakeOptions {
  /** Texel edge for the produced set. Power of two. */
  readonly size: number;
  readonly anisotropy: number;
  readonly seed: number;
}

/**
 * Bake one `MaterialRecipe` into a full PBR set. Synchronous: both passes are
 * GPU draws and the caller yields between materials, not inside one.
 */
export function produceTextureSet(
  device: IronGpuBakeDevice,
  recipe: MaterialRecipe,
  opts: TextureBakeOptions,
): TextureSet {
  const size = Math.max(64, opts.size);
  const seed = (opts.seed >>> 0) || 1;
  const floatField = device.gl.floatRenderable ? RTFormat.RGBA16F : RTFormat.RGBA8;

  const fields = device.renderMrtTyped(
    {
      name: `${recipe.id}.field`,
      width: size,
      height: size,
      fragment: FIELD_FS,
      prelude: '',
      targets: 2,
      wrap: 'repeat',
      filter: 'linear',
      mips: MipMode.None,
      defines: { IRON_PATTERN: recipe.pattern },
      uniforms: {
        uFreq: { value: [recipe.freq[0], recipe.freq[1], recipe.freq[2]] },
        uAmp: { value: [recipe.amp[0], recipe.amp[1], recipe.amp[2], recipe.amp[3]] },
        uPattern: { value: [...recipe.patternParams] },
        uSurfaceP: { value: [...recipe.surfaceParams] },
        uAging: { value: [...recipe.aging] },
        uVary: { value: [...recipe.variation] },
        uColorA: { value: [...recipe.colorA] },
        uColorB: { value: [...recipe.colorB] },
        uFleckColor: { value: [...recipe.fleckColor] },
        uWarp: { value: recipe.warp },
        uSeedU: { value: seed },
      },
    },
    [floatField, floatField],
  );

  const out = device.renderMrtTyped(
    {
      name: `${recipe.id}.set`,
      width: size,
      height: size,
      fragment: COMPOSE_FS,
      prelude: '',
      targets: 3,
      wrap: 'repeat',
      filter: 'linear',
      anisotropy: opts.anisotropy,
      uniforms: {
        uFieldA: { value: fields[0] },
        uFieldB: { value: fields[1] },
        uCompose: {
          value: [recipe.normalStrength, recipe.ao[0], recipe.ao[1], recipe.surfaceParams[3]],
        },
        uAgingB: {
          value: [recipe.aging[0], recipe.aging[1], size * 0.9, recipe.surfaceParams[2]],
        },
        uWearColor: { value: [...recipe.wearColor] },
        uGrimeColor: { value: [...recipe.grimeColor] },
        uFreqB: { value: [recipe.freq[0], recipe.freq[1], recipe.freq[2]] },
        uSeedB: { value: seed },
      },
    },
    [RTFormat.RGBA8_SRGB, RTFormat.RGBA8, RTFormat.RGBA8],
    // Mip modes are per-attachment and this is the whole reason MipMode exists:
    // colour box-filters, the packed normal/roughness gets the Toksvig
    // treatment, the wear mask is a plain mask.
    [MipMode.Color, MipMode.RoughnessToksvig, MipMode.Mask],
  );

  device.release(fields[0]);
  device.release(fields[1]);

  return {
    albedoHeight: out[0],
    normalRoughAo: out[1],
    wear: out[2],
    tiling: recipe.tiling,
    metalness: recipe.metalness,
  };
}

/* ------------------------------------------------------------- the recipes */

const srgb = (hex: number): [number, number, number] => {
  const c = new THREE.Color();
  c.setHex(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

/**
 * HARBOUR REACH's material vocabulary. Colours are authored as sRGB hex because
 * that is how anyone reads a palette, and converted to linear here — the bake
 * shader works in linear throughout and the sRGB render target re-encodes on
 * write.
 */
export function harbourMaterials(surfaces: typeof SURFACE_IDS): MaterialRecipe[] {
  return [
    {
      id: 'mat.sandstone',
      surface: surfaces.Sandstone,
      tiling: 2.4,
      metalness: 0,
      pattern: PatternKind.Ashlar,
      colorA: srgb(0xc4a878),
      colorB: srgb(0x9d8358),
      wearColor: srgb(0xd9c8a4),
      grimeColor: srgb(0x4a4335),
      fleckColor: srgb(0xe6dcc2),
      freq: [3, 14, 56],
      amp: [0.10, 0.05, 0.018, 0.20],
      warp: 0.55,
      patternParams: [4, 8, 0.05, 0.55],
      surfaceParams: [0.82, 0.10, 0.68, 0.35],
      aging: [0.85, 0.55, 0.35, 0.10],
      variation: [0.05, 0.16, 0.25],
      normalStrength: 3.2,
      ao: [1.5, 1.1],
    },
    {
      id: 'mat.stucco',
      surface: surfaces.Stucco,
      tiling: 1.8,
      metalness: 0,
      pattern: PatternKind.None,
      colorA: srgb(0xe0d3bb),
      colorB: srgb(0xb9a88c),
      wearColor: srgb(0x8d7a60),
      grimeColor: srgb(0x50493c),
      fleckColor: srgb(0xf2ece0),
      freq: [3, 18, 72],
      amp: [0.16, 0.08, 0.03, 0.0],
      warp: 0.9,
      patternParams: [1, 1, 0.05, 0.2],
      surfaceParams: [0.88, 0.09, 0.78, 0.4],
      aging: [0.55, 0.75, 0.85, 0.06],
      variation: [0.04, 0.20, 0.18],
      normalStrength: 2.4,
      ao: [1.2, 1.0],
    },
    {
      id: 'mat.cobble',
      surface: surfaces.Cobble,
      tiling: 2.0,
      metalness: 0,
      pattern: PatternKind.Cobble,
      colorA: srgb(0x8c8175),
      colorB: srgb(0x5d564d),
      wearColor: srgb(0xa9a094),
      grimeColor: srgb(0x3b382f),
      fleckColor: srgb(0xbdb4a6),
      freq: [3, 16, 60],
      amp: [0.08, 0.05, 0.02, 0.30],
      warp: 0.45,
      patternParams: [7, 7, 0.16, 0.60],
      surfaceParams: [0.74, 0.14, 0.55, 0.45],
      aging: [0.95, 0.85, 0.15, 0.14],
      variation: [0.07, 0.26, 0.30],
      normalStrength: 3.6,
      ao: [1.9, 1.2],
    },
    {
      id: 'mat.rusted_metal',
      surface: surfaces.RustedMetal,
      tiling: 2.6,
      metalness: 1,
      pattern: PatternKind.Panels,
      colorA: srgb(0x7d5236),
      colorB: srgb(0x53575a),
      wearColor: srgb(0x9a9ea1),
      grimeColor: srgb(0x2e2a26),
      fleckColor: srgb(0xa8623a),
      freq: [3, 12, 48],
      amp: [0.09, 0.05, 0.022, 0.26],
      warp: 1.15,
      patternParams: [2, 3, 0.045, 0.5],
      surfaceParams: [0.62, 0.22, 0.32, 0.30],
      aging: [0.75, 0.60, 0.20, 0.18],
      variation: [0.06, 0.30, 0.35],
      normalStrength: 3.0,
      ao: [1.4, 1.0],
    },
    {
      id: 'mat.painted_wood',
      surface: surfaces.PaintedWood,
      tiling: 2.2,
      metalness: 0,
      pattern: PatternKind.Planks,
      colorA: srgb(0x4c6b74),
      colorB: srgb(0x36505a),
      wearColor: srgb(0x8a6b4a),
      grimeColor: srgb(0x30302a),
      fleckColor: srgb(0x6e8b93),
      freq: [3, 20, 90],
      amp: [0.07, 0.04, 0.02, 0.24],
      warp: 0.35,
      patternParams: [5, 3, 0.06, 0.55],
      surfaceParams: [0.55, 0.20, 0.80, 0.35],
      aging: [1.0, 0.45, 0.25, 0.05],
      variation: [0.05, 0.22, 0.24],
      normalStrength: 3.0,
      ao: [1.5, 1.1],
    },
    {
      id: 'mat.sand',
      surface: surfaces.Sand,
      tiling: 1.4,
      metalness: 0,
      pattern: PatternKind.None,
      colorA: srgb(0xd8c39a),
      colorB: srgb(0xb59e77),
      wearColor: srgb(0xe6d6b4),
      grimeColor: srgb(0x6b5c44),
      fleckColor: srgb(0x6a5b46),
      freq: [4, 22, 96],
      amp: [0.12, 0.07, 0.035, 0.0],
      warp: 1.4,
      patternParams: [1, 1, 0.05, 0.2],
      surfaceParams: [0.95, 0.05, 0.92, 0.30],
      aging: [0.25, 0.30, 0.0, 0.22],
      variation: [0.03, 0.14, 0.12],
      normalStrength: 2.0,
      ao: [1.0, 1.0],
    },
  ];
}

/**
 * The `SurfaceId` members the recipes above name. Passed in rather than
 * imported as a value so `textures.ts` stays a pure producer with no opinion
 * about RCORE's enum numbering.
 */
export const SURFACE_IDS = {
  Sandstone: 0 as SurfaceId,
  Stucco: 1 as SurfaceId,
  Cobble: 10 as SurfaceId,
  RustedMetal: 14 as SurfaceId,
  PaintedWood: 12 as SurfaceId,
  Sand: 6 as SurfaceId,
};
