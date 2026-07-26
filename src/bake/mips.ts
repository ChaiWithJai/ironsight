/**
 * Mip chain generation. OWNER: BAKE.
 *
 * The wrong mip mode is a visible defect at distance, and three of the four
 * modes here exist because `gl.generateMipmap` is wrong for the data:
 *
 *  - NORMAL. Box-filtering two unit normals gives a SHORTER vector, not a
 *    normal. Left unrenormalised, distant surfaces progressively flatten toward
 *    the geometric normal and the whole mid-distance loses its material read.
 *
 *  - ROUGHNESS_TOKSVIG. This is the one the architecture calls non-optional.
 *    When a normal map's high-frequency detail is averaged away, the ENERGY it
 *    scattered has to go somewhere or the surface gets shinier as it recedes.
 *    Toksvig recovers it: the length of the averaged normal measures how much
 *    variance was lost, and that variance is folded into the roughness mip. The
 *    brief demands micro-detail everywhere; without this, distant metal, glass
 *    and stucco sparkle, TAA either smears the sparkle or boils it, and no
 *    resolve-time tuning fixes a bake-time problem.
 *
 *  - COLOR on an sRGB texture. Averaging sRGB-encoded bytes darkens; the GL
 *    sRGB attachment path here decodes on sample and encodes on write, so the
 *    average happens in linear where it belongs.
 */
import { MipMode } from '@/engine/types';
import type { BakeGl, BakeTexture } from '@/bake/gl';

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
in vec2 vUv;
uniform vec2 uResolution;
uniform sampler2D uSrc;
uniform int uLevel;
out vec4 outColor;

ivec2 srcCoord(ivec2 dst, int dx, int dy, ivec2 srcSize){
  return clamp(dst * 2 + ivec2(dx, dy), ivec2(0), srcSize - 1);
}
`;

const COLOR_FS = `${COMMON}
void main() {
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 srcSize = textureSize(uSrc, uLevel);
  vec4 c = texelFetch(uSrc, srcCoord(dst, 0, 0, srcSize), uLevel)
         + texelFetch(uSrc, srcCoord(dst, 1, 0, srcSize), uLevel)
         + texelFetch(uSrc, srcCoord(dst, 0, 1, srcSize), uLevel)
         + texelFetch(uSrc, srcCoord(dst, 1, 1, srcSize), uLevel);
  outColor = c * 0.25;
}`;

const MASK_FS = COLOR_FS;

const NORMAL_FS = `${COMMON}
void main() {
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 srcSize = textureSize(uSrc, uLevel);
  vec3 n = vec3(0.0);
  vec2 rest = vec2(0.0);
  for (int dy = 0; dy < 2; dy++) {
    for (int dx = 0; dx < 2; dx++) {
      vec4 s = texelFetch(uSrc, srcCoord(dst, dx, dy, srcSize), uLevel);
      vec2 xy = s.xy * 2.0 - 1.0;
      n += vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
      rest += s.zw;
    }
  }
  n = normalize(n);
  outColor = vec4(n.xy * 0.5 + 0.5, rest * 0.25);
}`;

/**
 * rg = tangent normal xy, b = roughness, a = AO — the packing declared by
 * `TextureSet.normalRoughAo`. The averaged normal's LENGTH is the variance
 * estimator; everything else is the standard GGX roughness ⇄ Blinn power
 * round trip.
 */
const TOKSVIG_FS = `${COMMON}
void main() {
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 srcSize = textureSize(uSrc, uLevel);
  vec3 nSum = vec3(0.0);
  float rough = 0.0;
  float ao = 0.0;
  for (int dy = 0; dy < 2; dy++) {
    for (int dx = 0; dx < 2; dx++) {
      vec4 s = texelFetch(uSrc, srcCoord(dst, dx, dy, srcSize), uLevel);
      vec2 xy = s.xy * 2.0 - 1.0;
      nSum += vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
      rough += s.z;
      ao += s.w;
    }
  }
  nSum *= 0.25;
  rough *= 0.25;
  ao *= 0.25;
  float len = clamp(length(nSum), 1e-3, 1.0);

  // GGX alpha from perceptual roughness, then the equivalent Blinn power.
  float a = max(rough * rough, 1e-3);
  float power = 2.0 / (a * a) - 2.0;
  // Toksvig: the fraction of the original specular power that survives the
  // averaging. len == 1 means nothing was lost and ft == 1.
  float ft = len / max(1e-4, len + power * (1.0 - len));
  float powerOut = max(ft * power, 1e-3);
  float aOut = sqrt(2.0 / (powerOut + 2.0));
  float roughOut = clamp(sqrt(aOut), rough, 1.0);

  outColor = vec4(normalize(nSum).xy * 0.5 + 0.5, roughOut, ao);
}`;

export function buildMipChain(bgl: BakeGl, tex: BakeTexture, mode: MipMode): void {
  if (mode === MipMode.None || tex.levels <= 1) return;
  const source =
    mode === MipMode.Normal
      ? NORMAL_FS
      : mode === MipMode.RoughnessToksvig
        ? TOKSVIG_FS
        : mode === MipMode.Mask
          ? MASK_FS
          : COLOR_FS;
  const prog = bgl.program(source, undefined);
  for (let level = 1; level < tex.levels; level++) {
    bgl.draw(
      prog,
      [tex],
      (u) => {
        // Clamp the sampler to the level BELOW the one being written: sampling
        // and rendering the same texture is only legal when the accessible mip
        // range excludes the draw target.
        u.setTextureLevels('uSrc', tex, level - 1, level - 1);
        u.set('uLevel', level - 1);
      },
      level,
    );
  }
  // Restore the full range or the texture samples as if it had one mip.
  const gl = bgl.gl;
  gl.bindTexture(tex.target, tex.handle);
  gl.texParameteri(tex.target, gl.TEXTURE_BASE_LEVEL, 0);
  gl.texParameteri(tex.target, gl.TEXTURE_MAX_LEVEL, tex.levels - 1);
  gl.bindTexture(tex.target, null);
}
