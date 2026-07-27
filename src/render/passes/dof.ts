/**
 * Pass 24 — depth of field. OWNER: RCORE.
 *
 * LOOK_SPEC §6.2 resolves the corpus disagreement by title generation and we
 * ship the BF6 behaviour, which is far more restrained than a demo instinct
 * would suggest:
 *
 *   hipfire   near: the viewmodel at 0.35–0.45 m carries 1.5–3.0 px of CoC.
 *             far:  NONE. Terrain at 2 km is the sharpest thing in the frame.
 *   ADS       the ocular ring goes 4× softer than the sight picture and a mild
 *             far pull fades in with `adsBlend` (CoC ≤ 1.2 px past 40 m).
 *   cinematic subject at 4 m sharp, background at 20–40 px with REAL bokeh.
 *
 *     CoC_px = clamp(0.926 · |1/d − 1/d_focus|, 0, 3)
 *
 * "Bokeh is never visible as discrete discs in gameplay" — so the gameplay path
 * is a small, cheap, round gather and the aperture character (7-blade
 * truncation, bright rim, cat's-eye squash toward the corners) only switches on
 * for the cinematic camera. A gameplay frame with visible bokeh balls is a
 * defect, not a feature.
 *
 * The gather runs at half resolution and is composited back by full-resolution
 * CoC in the tonemap. At 3 px of CoC there is nothing at full res to lose, and a
 * 20 px cinematic disc has no half-res detail either.
 */
import {
  PassOrder,
  RTId,
  type FrameCtx,
  type QualitySettings,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';
import { GLSL_NOISE, ut, uf, uv2 } from '@/render/fullscreen';
import { GLSL_COC, type PostChainState } from '@/render/passes/chain';

/**
 * A camera at or below this vertical FOV is a cinematic/deploy camera by
 * definition (LOOK_SPEC §7.1 puts cinematic at 38° and the player's own FOV
 * slider range at 60–90°), and cinematic cameras get the full aperture. This is
 * the only signal available: `ShotContext` exposes no route from a shot file to
 * a service, so the pose itself has to carry the intent.
 */
const CINEMATIC_FOV_DEG = 40;

/** LOOK_SPEC §6.2's gameplay constant, in px·m at 1080p. */
const GAMEPLAY_COC_SCALE = 0.926;
const GAMEPLAY_MAX_COC = 3;

/*
 * THE CINEMATIC APERTURE — re-derived after a critic opened a review with
 * "this is an out-of-focus photograph".
 *
 * What was here: scale 120, cap 32 px, far gain 1.0, auto-focus metering the
 * centre pixel anywhere in [1.5, 60] m. On `level_bravo` the centre pixel is a
 * quay shed at 48 m, so the lens focused at 48 m — and `CoC = 120·|1/d − 1/48|`
 * then puts 21 px on 5 m, 17 px on 6 m, 9.5 px on 10 m and 3.5 px on 20 m. That
 * is the whole DECK the player stands on, i.e. the lower 45 % of the frame,
 * smeared past legibility: sandbags fused into one lump, bollards reduced to
 * discs. Optically it is exactly what an f/1.4 focused at 48 m does. It is also
 * the wrong lens for the shot.
 *
 * What the reference corpus actually does (AAA_RUBRIC calibration note 5/6, and
 * every establishing frame in `reference/gameplay/`): the heavy bokeh sits on a
 * NEAR OCCLUDER — a shoulder, a wall edge, a rock inside ~3 m — and everything
 * from the playable surface outward stays readable. Our two bands were swapped.
 *
 * So the cinematic path is now an ESTABLISHING lens rather than a portrait lens:
 * near-focused and effectively hyperfocal beyond, i.e. stopped down. With
 * `scale 40`, focus 8 m and the far side at a quarter weight:
 *
 *   | d      | 1.5 m | 2 m  | 3 m | 4 m | 6 m | 8 m | 20 m | 48 m |  ∞   |
 *   | CoC px | 15*   | 15.0 | 8.3 | 5.0 | 1.7 | 0   | 0.75 | 1.05 | 1.25 |
 *                                                    (far side ×0.25)
 *
 * — a near occluder that genuinely melts, a deck that reads from 5 m out, and a
 * background that is sharp, which is what §6.2's hipfire row asks for anyway
 * ("terrain at 2 km is the sharpest thing in the frame"). The 20–40 px
 * background figure in §6.2's third row is quoted against a 4 m SUBJECT, i.e. a
 * deploy portrait; an establishing shot of a harbour is not that frame and
 * borrowing that lens for it is what produced the defect.
 */
const CINEMATIC_COC_SCALE = 40;
const CINEMATIC_MAX_COC = 15;
/**
 * The far-side weight. Not 1.0: at f-numbers this low the near and far sides of
 * the CoC curve are wildly asymmetric in what they cost the frame — the near
 * side buys depth framing, the far side buys nothing here and costs the cranes,
 * the town and the headland, which are the subjects of every establishing shot
 * in the roster.
 */
const CINEMATIC_FAR_GAIN = 0.25;

export class DepthOfFieldPass implements RenderPass {
  readonly id = 'post.dof';
  readonly order = PassOrder.DepthOfField;
  readonly reads: readonly RTId[] = [RTId.ResolvedColor, RTId.SceneDepth];
  readonly writes: readonly RTId[] = [RTId.DofResult];
  readonly budgetMs = 0.4;

  constructor(private readonly state: PostChainState) {}

  enabled(quality: Readonly<QualitySettings>): boolean {
    return quality.dof.enabled;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    const dof = this.state.dof;
    const ads = ctx.services.viewmodel.state.adsBlend;
    // FOV alone is NOT a sufficient signal and shipping it as one was a live
    // gameplay bug. `defs/dmr-marksman.ts` is 4× glass: aiming it multiplies the
    // world FOV by a third, so a player pressing the aim button in normal play
    // takes the camera to ~23° — under CINEMATIC_FOV_DEG — and the branch below
    // would hand him the establishing lens: 15 px of CoC, a 40 px·m aperture and
    // a centre-pixel auto-focus clamped to 12 m, on the one frame in the game
    // where he most needs the far field readable. §6.2's ADS row asks for the
    // opposite (CoC ≤ 1.2 px past 40 m). Nothing in the shot roster is affected
    // — every pose at or under 40° is a viewmodel-less establishing shot, where
    // adsBlend is 0 — so this costs the captures nothing and closes the hole.
    const cinematic = ctx.camera.fovDeg <= CINEMATIC_FOV_DEG && ads < 0.01;

    if (cinematic) {
      // 8 m is the fallback when the centre ray misses geometry entirely (a
      // camera aimed at sky): the same near-field focus the clamp below biases
      // toward, so a metered and an unmetered frame do not look like two lenses.
      dof.focus = 8;
      dof.scale = CINEMATIC_COC_SCALE;
      dof.maxCoc = CINEMATIC_MAX_COC;
      dof.farGain = CINEMATIC_FAR_GAIN;
      dof.autoFocus = true;
    } else {
      // Hipfire focuses at 8 m and pulls to the sight picture through the ADS
      // transition; the far side only opens as `adsBlend` rises, so the world
      // stays sharp in hipfire exactly as §6.2 requires.
      dof.focus = 8 + 12 * ads;
      dof.scale = GAMEPLAY_COC_SCALE;
      dof.maxCoc = GAMEPLAY_MAX_COC;
      dof.farGain = 0.4 * ads;
      dof.autoFocus = false;
    }
    dof.active = true;

    const target = graph.target(RTId.DofResult);
    const taps = cinematic ? 25 : 12;

    graph.fullscreen(
      `post.dof.${taps}`,
      /* glsl */ `
        vec2 lens = ironDofFocus(uDepth, uFocus, uScale, uAutoFocus);
        float focus = lens.x;
        float scale = lens.y;
        float centreDepth = texture(uDepth, vUv).r;
        vec3 centre = texture(uColor, vUv).rgb;
        float centreCoc = ironCoc(centreDepth, focus, scale, uMaxCoc, uFarGain);

        // Under half a pixel there is nothing to gather and this is most of the
        // frame in gameplay — the whole point of §6.2's restraint.
        if (centreCoc < 0.6) {
          outColor = vec4(centre, centreCoc);
          return;
        }

        // Half-res gather: the radius is in DESTINATION pixels.
        float radius = centreCoc * 0.5;
        float angleOffset = ironIgn(gl_FragCoord.xy) * 6.2831853;

        // Cat's-eye: a real lens clips the exit pupil off-axis, squashing the
        // bokeh along the radial direction toward the corners.
        vec2 toCentre = vUv - 0.5;
        float rNorm = clamp(length(toCentre * vec2(uAspect, 1.0)) * 2.0, 0.0, 1.4);
        vec2 radial = normalize(toCentre + vec2(1e-5));
        float squash = uCatsEye * smoothstep(0.35, 1.2, rNorm);

        vec3 sum = centre;
        float weightSum = 1.0;
        for (int i = 0; i < TAPS; i++) {
          // Golden-angle spiral: even coverage at any tap count, no rings.
          float fi = float(i) + 0.5;
          float t = fi / float(TAPS);
          float angle = fi * 2.39996323 + angleOffset;
          float r = sqrt(t);
          #ifdef APERTURE
            // 7-blade polygon truncation, softened so it never reads as a
            // hard heptagon; plus a brighter rim, which is what makes a real
            // bokeh disc read as glass rather than as a gaussian.
            float blade = cos(3.14159265 / 7.0) / cos(mod(angle, 6.2831853 / 7.0) - 3.14159265 / 7.0);
            r *= mix(1.0, blade, 0.75);
          #endif
          vec2 offset = vec2(cos(angle), sin(angle)) * r * radius;
          offset -= radial * dot(offset, radial) * squash;
          vec2 uv = vUv + offset * uTexel;

          float d = texture(uDepth, uv).r;
          float sampleCoc = ironCoc(d, focus, scale, uMaxCoc, uFarGain) * 0.5;
          float dist = length(offset);
          // Scatter-as-gather: a sample only reaches this pixel if its own
          // circle of confusion is wide enough to cover the distance.
          float w = clamp((sampleCoc - dist + 1.0) * 0.6, 0.0, 1.0);
          // A sharp foreground must not leak into a blurred background.
          if (d > 0.0 && centreDepth > 0.0 && d < centreDepth && sampleCoc < 0.75) w *= 0.15;
          #ifdef APERTURE
            w *= 1.0 + 0.9 * pow(r, 6.0);
          #endif
          sum += texture(uColor, uv).rgb * w;
          weightSum += w;
        }
        outColor = vec4(sum / max(weightSum, 1e-4), centreCoc);
      `,
      {
        uColor: ut(graph.texture(this.state.source)),
        uDepth: ut(graph.texture(RTId.SceneDepth)),
        uTexel: uv2(1 / target.width, 1 / target.height),
        uFocus: uf(dof.focus),
        uScale: uf(dof.scale),
        uMaxCoc: uf(dof.maxCoc),
        uFarGain: uf(dof.farGain),
        uAspect: uf(ctx.camera.aspect),
        uCatsEye: uf(cinematic ? 0.45 : 0),
        uAutoFocus: uf(dof.autoFocus ? 1 : 0),
      },
      target,
      {
        prelude: `
          ${GLSL_NOISE}
          ${GLSL_COC}
          uniform sampler2D uColor;
          uniform sampler2D uDepth;
          uniform vec2 uTexel;
          uniform float uFocus;
          uniform float uScale;
          uniform float uMaxCoc;
          uniform float uFarGain;
          uniform float uAspect;
          uniform float uCatsEye;
          uniform float uAutoFocus;
        `,
        defines: cinematic ? { TAPS: taps, APERTURE: 1 } : { TAPS: taps },
      },
    );
  }
}
