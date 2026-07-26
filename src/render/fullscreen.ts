/**
 * Shared vocabulary for RCORE's fullscreen passes. OWNER: RCORE.
 *
 * Two halves:
 *  - TS-side uniform constructors, so a pass reads as a list of values rather
 *    than as a wall of `{ value: … }`;
 *  - GLSL chunks every post pass needs. They are STRINGS rather than a shader
 *    include system because `RenderGraph.fullscreen` takes a prelude and a body,
 *    and inventing a second include mechanism on top of three's would be two
 *    ways to do one thing.
 *
 * THE G-BUFFER CONTRACT IS DEFINED HERE and is the thing to read before touching
 * any pass:
 *
 *   RTId.SceneDepth      R32F   .r = LINEAR VIEW DEPTH IN METRES.
 *                               **0.0 means "no geometry" (sky/background)**,
 *                               because the target is cleared to black and a
 *                               cleared MRT attachment cannot carry a sentinel
 *                               of its own. Every consumer tests `d > 0.0`.
 *   RTId.GNormalRough    .rg = octahedral WORLD-space normal in [-1,1]
 *                        .b  = perceptual roughness
 *                        .a  = surface class / 255 (see IRON_CLASS_*)
 *   RTId.GVelocity       RG16F = this frame's screen motion in UV UNITS PER
 *                        FRAME, jitter removed. `prevUv = uv - velocity`.
 */
import * as THREE from 'three';
import type { GpuUniform } from '@/engine/types';

/* ------------------------------------------------------------ uniform sugar */

export function uf(value: number): GpuUniform {
  return { value };
}
export function ut(value: THREE.Texture | null): GpuUniform {
  return { value };
}
export function uv2(x: number, y: number): GpuUniform {
  return { value: new THREE.Vector2(x, y) };
}
export function um4(value: THREE.Matrix4): GpuUniform {
  return { value };
}

/* ------------------------------------------------------------------ classes */

/** Written into `GNormalRough.a` as `class/255`. Read by TAA and motion blur. */
export const IRON_CLASS_WORLD = 0;
export const IRON_CLASS_VEGETATION = 1;
/**
 * The viewmodel. Motion blur is FORBIDDEN on it (LOOK_SPEC §6.3 — recoil must
 * stay crisp) and TAA clamps it tighter, because a gun that ghosts on a
 * 40 ms recoil impulse is the single most visible temporal artefact in a
 * first-person frame.
 */
export const IRON_CLASS_VIEWMODEL = 2;

/* -------------------------------------------------------------- GLSL chunks */

/** Octahedral normal encoding. Cheap, and 16-bit oct is well under a degree. */
export const GLSL_OCT = /* glsl */ `
vec2 ironOctEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.xy;
  if (n.z < 0.0) {
    e = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  }
  return e;
}

vec3 ironOctDecode(vec2 e) {
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;

/**
 * Deterministic per-pixel noise. Blue-noise-ish (interleaved gradient noise is
 * the standard rotated-grid dither; it decorrelates sample patterns between
 * neighbouring pixels well enough that TAA resolves them) and derived only from
 * pixel coordinates and the frame index, so a captured frame is reproducible.
 */
export const GLSL_NOISE = /* glsl */ `
float ironIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float ironHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Catmull-Rom history fetch, 5-tap (Jimenez). A bilinear history fetch is the
 * classic cause of "TAA is blurry": every reprojection round-trips through a
 * linear filter and the image loses a little each frame, permanently. This costs
 * five taps instead of one and holds the detail.
 */
export const GLSL_CATMULL_ROM = /* glsl */ `
vec4 ironSampleCatmullRom(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 texPos0 = (texPos1 - 1.0) / texSize;
  vec2 texPos3 = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;

  vec4 result = vec4(0.0);
  result += texture(tex, vec2(texPos12.x, texPos0.y)) * w12.x * w0.y;
  result += texture(tex, vec2(texPos0.x, texPos12.y)) * w0.x * w12.y;
  result += texture(tex, vec2(texPos12.x, texPos12.y)) * w12.x * w12.y;
  result += texture(tex, vec2(texPos3.x, texPos12.y)) * w3.x * w12.y;
  result += texture(tex, vec2(texPos12.x, texPos3.y)) * w12.x * w3.y;
  float weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return result / max(weight, 1e-5);
}
`;

/**
 * Camera-motion reprojection for pixels with NO geometry (sky, and anything the
 * prepass skipped). Without it the sky ghosts every time the player turns,
 * because a cleared velocity buffer claims the sky is nailed to the screen.
 *
 * Direction-only: the sky is at infinity, so the translation column of the
 * previous view-projection must not participate — hence `vec4(dir, 0.0)`.
 */
export const GLSL_SKY_VELOCITY = /* glsl */ `
vec2 ironSkyVelocity(vec2 uv, mat4 invViewProj, mat4 prevViewProj, vec3 cameraPos) {
  vec4 far = invViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - cameraPos);
  vec4 prevClip = prevViewProj * vec4(dir, 0.0);
  if (abs(prevClip.w) < 1e-6) return vec2(0.0);
  vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
  return uv - prevUv;
}
`;
