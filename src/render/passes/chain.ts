/**
 * The tiny piece of per-frame state the post passes share. OWNER: RCORE.
 *
 * Two things genuinely have to be agreed between passes that run minutes of
 * wall-clock apart in the source but 0.4 ms apart in the frame:
 *
 *  - **which target currently holds the image.** Motion blur cannot read and
 *    write one target, so it ping-pongs into `SceneColor` (dead after the TAA
 *    resolve) and tells everything downstream where the image went. The
 *    alternative is a full-resolution blit back every frame for nothing.
 *  - **the depth-of-field parameters**, because the CoC that decides how much
 *    of the half-res blur to composite has to be evaluated at FULL resolution in
 *    the tonemap, from the same numbers the gather used. Two copies of that
 *    formula would drift and the seam would show as a halo.
 */
import { RTId } from '@/engine/types';

export interface DofParams {
  /** False when the pass did not run this frame; the tonemap then skips the composite. */
  active: boolean;
  /** Focus distance in metres. */
  focus: number;
  /** `CoC_px = scale · |1/d − 1/focus|`, LOOK_SPEC §6.2. */
  scale: number;
  maxCoc: number;
  /** 0 in hipfire, 0.40 in ADS, 1.0 cinematic — the far-side CoC multiplier. */
  farGain: number;
  /** Cinematic: focus and aperture come from the centre depth, on the GPU. */
  autoFocus: boolean;
}

export interface PostChainState {
  /** Where the resolved HDR image lives right now. */
  source: RTId | string;
  readonly dof: DofParams;
}

export function createPostChainState(): PostChainState {
  return {
    source: RTId.ResolvedColor,
    dof: { active: false, focus: 8, scale: 0.926, maxCoc: 3, farGain: 0, autoFocus: false },
  };
}

/**
 * The CoC formula, as GLSL, shared by the gather and the composite.
 * `d <= 0` is the G-buffer's "no geometry" sentinel and is treated as infinity —
 * the sky is on the far side of every focus plane there has ever been.
 */
export const GLSL_COC = /* glsl */ `
float ironCoc(float depth, float focus, float scale, float maxCoc, float farGain) {
  float d = depth > 0.0 ? depth : 1.0e5;
  float coc = scale * abs(1.0 / d - 1.0 / focus);
  if (d > focus) coc *= farGain;
  return clamp(coc, 0.0, maxCoc);
}

/**
 * Focus distance and aperture for the CINEMATIC camera, resolved on the GPU so
 * the gather and the composite cannot disagree by a frame.
 *
 * Two things happen here and both are deliberate:
 *  - **Auto-focus off the centre pixel.** A cinematic camera is aimed at its
 *    subject, and §7.3 constraint 1 guarantees screen centre is never occluded
 *    by the viewmodel, so the centre depth IS the subject distance. It also
 *    means a shot file needs no route to a service it is not allowed to reach.
 *  - **The aperture stays FIXED.** An aperture that scaled with focus distance
 *    would hold the background at a constant 30 px, which sounds convenient and
 *    is optically nonsense: it makes a lens focused at 80 m an f/0.5 with a
 *    ten-metre depth of field, so a frame whose subject happens to be far away
 *    comes back entirely soft. A real 50 mm at f/1.4 is a razor at 4 m and
 *    nearly hyperfocal at 80 m, and §6.2's 20–40 px background is quoted
 *    against a 4 m subject for exactly that reason.
 */
vec2 ironDofFocus(sampler2D depthTex, float fallbackFocus, float scale, float autoFocus) {
  if (autoFocus < 0.5) return vec2(fallbackFocus, scale);
  float d = texture(depthTex, vec2(0.5, 0.5)).r;
  float focus = (d > 0.5) ? clamp(d, 1.5, 60.0) : fallbackFocus;
  return vec2(focus, scale);
}
`;
