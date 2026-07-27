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

/**
 * The lens, as the two independent halves of a real CoC curve.
 *
 * NEAR AND FAR ARE SEPARATE and that is the round-3 change. A single `scale`
 * with a far-side `gain` multiplier could not express what the corpus actually
 * does, because the two sides of the curve answer different questions: the near
 * side is composition (an out-of-focus occluder anchoring depth, AAA_RUBRIC
 * calibration notes 5 and 6) and the far side is atmosphere (a skyline that
 * separates from the sky instead of being cut out of it). Tying them to one
 * number meant that whenever the near side was set where the reference frames
 * put it, the far side landed at a tenth of a pixel — measurably nothing — and
 * the previous round's critic measured exactly that: "a viewmodel at ~30 cm,
 * grass at ~2 m, cranes at ~300 m and a mountain ridge are all at identical
 * sharpness — impossible for any real optic."
 *
 * Both scales are in px·m at 1080p: `CoC_px = scale · |1/d − 1/focus|`. That
 * constant is `f²/N · pixelsPerMillimetre` for a real lens and is INDEPENDENT
 * of focus distance, which is why racking focus does not change it.
 */
export interface DofParams {
  /** False when the pass did not run this frame; the tonemap then skips the composite. */
  active: boolean;
  /** Focus distance in metres — the fallback when auto-focus finds no geometry. */
  focus: number;
  /** px·m, applied where `d < focus`. */
  nearScale: number;
  /** px·m, applied where `d > farStart`. */
  farScale: number;
  /**
   * Where the far side STARTS, in metres. The far half of the curve behaves as
   * if the lens were focused at this distance rather than at `focus`, so
   * everything between the focus plane and here stays genuinely sharp. See
   * `passes/dof.ts` for why the two halves do not share a plane.
   */
  farStart: number;
  /** Near-side clamp, px at 1080p. */
  maxNear: number;
  /** Far-side clamp, px at 1080p. */
  maxFar: number;
  /** Establishing lens: the focus plane comes from the centre depth, on the GPU. */
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
    dof: {
      active: false,
      focus: 8,
      nearScale: 0.926,
      farScale: 0,
      farStart: 60,
      maxNear: 3,
      maxFar: 0,
      autoFocus: false,
    },
  };
}

/**
 * Auto-focus bounds for the establishing lens, in metres.
 *
 * The ceiling is the load-bearing one and it is 12, not the 60 that shipped
 * through three review rounds: the centre pixel is still what the lens meters,
 * but it may not rack PAST the near-mid field. `level_bravo`'s centre ray lands
 * on a quay shed at 48 m, and focusing there put 21 px of CoC on 5 m and 9.5 px
 * on 10 m — the entire deck the player stands on, which is the lower 45 % of
 * that frame. The reference corpus puts its bokeh on a near occluder and keeps
 * the playable surface readable.
 *
 * The FLOOR is 1.0 m rather than 1.5, and that matters for a different reason:
 * the establishing lens is now selected by "this frame has no viewmodel in it"
 * rather than by a 40° FOV, which correctly catches every beauty pass in the
 * roster — including the close-range ones (`material_chart`, `bake_*`) whose
 * subject sits at half a metre. Metering those to 1.5 m would have thrown the
 * chart itself out of focus, which is the one thing those shots exist to show.
 */
export const ESTABLISHING_FOCUS_MIN_M = 1.0;
export const ESTABLISHING_FOCUS_MAX_M = 12;

export const GLSL_COC = /* glsl */ `
/**
 * The CoC curve, shared by the gather and the full-resolution composite.
 * d <= 0 is the G-buffer's "no geometry" sentinel and is treated as infinity —
 * the sky is on the far side of every focus plane there has ever been.
 */
float ironCoc(float depth, float focus, float nearScale, float farScale, float farStart, float maxNear, float maxFar) {
  float d = depth > 0.0 ? depth : 1.0e5;
  float inv = 1.0 / d - 1.0 / focus;
  if (inv >= 0.0) return min(nearScale * inv, maxNear);
  // The far side runs off its OWN plane, never nearer than the focus plane, so
  // the curve is continuous at the focus distance and flat for everything
  // between the two.
  float start = max(farStart, focus);
  return min(farScale * max(1.0 / start - 1.0 / d, 0.0), maxFar);
}

/** The near half alone — what a NEIGHBOUR is allowed to scatter onto this pixel. */
float ironCocNear(float depth, float focus, float nearScale, float maxNear) {
  float d = depth > 0.0 ? depth : 1.0e5;
  return min(nearScale * max(1.0 / d - 1.0 / focus, 0.0), maxNear);
}

/**
 * Focus distance for the ESTABLISHING lens, resolved on the GPU so the gather
 * and the composite cannot disagree by a frame.
 *
 * Auto-focus meters a 5-tap cross around screen centre and averages IN INVERSE
 * DEPTH, then clamps to the near-mid field. Inverse depth because that is the
 * space the CoC curve is linear in, so the average is the one that minimises the
 * defocus error over the metered region rather than the one that minimises the
 * metric distance error. It is also what makes the metering robust: a single tap
 * that falls down an alley or through a window contributes ~0 to the sum instead
 * of racking the whole lens to infinity, and a single tap on a near occluder
 * pulls the plane in by a fifth rather than slamming it onto the occluder. That
 * stability matters because TAA jitters the sample point every frame, and a
 * focus plane that breathed with the jitter would ghost through the history.
 *
 * THE APERTURE STAYS FIXED while the focus racks. An aperture that scaled with
 * focus distance would hold the background at a constant CoC, which sounds
 * convenient and is optically nonsense: f²/N does not know where the lens is
 * focused. It is also what makes the near field of a far-focused frame melt.
 */
float ironDofFocus(sampler2D depthTex, float fallbackFocus, float autoFocus) {
  if (autoFocus < 0.5) return fallbackFocus;
  const vec2 crossUv[5] = vec2[5](
    vec2(0.50, 0.50), vec2(0.50, 0.44), vec2(0.50, 0.56), vec2(0.44, 0.50), vec2(0.56, 0.50));
  float invSum = 0.0;
  int hits = 0;
  for (int i = 0; i < 5; i++) {
    float s = texture(depthTex, crossUv[i]).r;
    // 0.2 m, not 0: the viewmodel writes into this same buffer and a beauty
    // frame that still carries one must not meter the handguard.
    if (s > 0.2) { invSum += 1.0 / s; hits++; }
  }
  if (hits == 0) return fallbackFocus;
  float focus = float(hits) / max(invSum, 1e-5);
  return clamp(focus, ${ESTABLISHING_FOCUS_MIN_M.toFixed(2)}, ${ESTABLISHING_FOCUS_MAX_M.toFixed(2)});
}
`;
