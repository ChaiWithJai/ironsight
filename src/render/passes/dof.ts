/**
 * Pass 24 — depth of field. OWNER: RCORE.
 *
 * TWO LENSES, AND WHICH ONE A FRAME GETS IS DECIDED BY WHETHER IT IS A GAMEPLAY
 * FRAME. That is the round-3 change and it is worth the paragraph.
 *
 * LOOK_SPEC §6.2 is a measurement of BF6 *gameplay* frames, and it is blunt:
 * hipfire puts 1.5–3.0 px on the viewmodel and NOTHING on the world, ADS adds a
 * far pull of about a pixel, "bokeh is never visible as discrete discs in
 * gameplay". That is correct and it stays. The mistake was applying it to every
 * frame in the roster, because most of the roster is not gameplay: `level_*`,
 * `light_*`, `water_*`, `sky_*`, `terrain_*` are beauty passes, and
 * AAA_RUBRIC's calibration notes 5 and 6 are equally blunt about what those
 * must do — "depth of field is used aggressively, especially with a near
 * foreground element", "almost every frame has an out-of-focus occluder in the
 * near field, anchoring depth".
 *
 * The old selector was `camera.fovDeg <= 40`, and no beauty shot in the roster
 * uses a 40° lens: `level_alpha` is 68°, `light_cascades` 70°, `water_golden`
 * 52°. So the establishing lens never once ran, every beauty frame took the
 * gameplay lens, and the gameplay lens on a frame with no viewmodel in it is
 * mathematically a no-op — CoC at 1.5 m is 0.926·|1/1.5 − 1/8| = 0.50 px, under
 * the pass's own 0.6 px floor. Three critics in a row measured the result and
 * called it what it was: "no depth of field at all", "a wall at ~1.5 m and
 * apartment blocks at ~150 m both rendered perfectly sharp".
 *
 * The selector is now "does this frame contain a viewmodel". A first-person
 * shooter frame has a weapon in it; a beauty pass does not. It is the honest
 * signal and it needs no cooperation from the shot files.
 *
 *     GAMEPLAY   near  0.926 px·m — LOOK_SPEC §6.2 verbatim, so 2.2 px at
 *                      0.40 m and 0.35 px at 2 m, i.e. the weapon and nothing
 *                      else. Clamp raised to 5 px so the parts of the receiver
 *                      that are genuinely at 15–20 cm keep going soft instead
 *                      of flattening onto the 3 px plateau — §6.2's 1.5–3.0 px
 *                      is quoted at 0.35–0.45 m and is untouched.
 *                far   0 in hipfire. In ADS it fades in with `adsBlend` to
 *                      1.1 px at 40 m (§6.2's ceiling) and 2.2 px at infinity,
 *                      which is what lets a crane field separate from sky.
 *
 *     ESTABLISHING     a 24 mm-equivalent at ~f/2, auto-focused on the near-mid
 *                      field. See the CoC table below.
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
 * slider range at 60–90°). It is no longer the primary selector — see the file
 * header — but it is kept as a second route into the establishing lens so a
 * deploy/scoreboard camera that DOES carry a viewmodel still gets one.
 */
const CINEMATIC_FOV_DEG = 40;

/** LOOK_SPEC §6.2's gameplay constant, in px·m at 1080p. */
const GAMEPLAY_COC_SCALE = 0.926;
/**
 * 5 px, not §6.2's 3. The clamp is not the curve: §6.2 quotes 1.5–3.0 px at
 * 0.35–0.45 m and the curve above still delivers exactly that (2.53 px at
 * 0.35 m, 2.15 px at 0.45 m). What the 3 px clamp did was flatten everything
 * INSIDE 0.30 m onto one value, and the near half of a viewmodel — the charging
 * handle, the ejection port, the near edge of the magazine well — lives at
 * 0.15–0.25 m, where the same formula asks for 4.5–6 px. Clamping those to the
 * same 3 px as the barrel is what made the weapon read as a flat cutout pasted
 * over the world rather than as a solid object receding from the eye.
 */
const GAMEPLAY_MAX_NEAR = 5;
/**
 * ADS far side, expressed as a SECOND focus plane rather than as a slope off the
 * first. §6.2 asks for a "mild far pull, CoC ≤ 1.2 px beyond 40 m, fading in
 * over the ADS transition", and read literally against a single-plane curve that
 * is unsatisfiable: any aperture that puts a visible CoC on a crane field at
 * 300 m puts several times that on the sky, and the same curve run backwards to
 * respect the 1.2 px ceiling at 40 m puts a fifth of a pixel at infinity, which
 * is nothing. Running the far half off a plane at FAR_START metres decouples
 * them: everything from the sight picture out to 60 m is exactly sharp, and the
 * blur only accumulates across the part of the scene §6.2 was not measuring.
 *
 *   | d      | 40 m | 60 m | 100 m | 150 m | 300 m |  ∞   |
 *   | CoC px |  0   |  0   | 0.53  | 0.80  | 1.07  | 1.20 |
 */
const ADS_FAR_SCALE = 80;
const ADS_FAR_START_M = 60;
const ADS_MAX_FAR = 1.2;

/*
 * THE ESTABLISHING LENS.
 *
 * Parameterised as a real lens rather than as a taste knob, because that is what
 * makes the near and far sides consistent with each other. For a lens of focal
 * length f at f-number N, with the subject far outside the near focus limit:
 *
 *     CoC_mm = (f² / N) · |1/d − 1/focus|          (d, focus in metres)
 *     CoC_px = CoC_mm · (frameHeightPx / sensorHeightMm)
 *
 * A 24 mm full-frame lens (74° horizontal — within a few degrees of every
 * beauty pose in the roster) at f/2.9, on a 24 mm-high sensor at 1080p:
 *
 *     (24² / 2.88) · (1080 / 24) = 200 · 45 = 9 000 mm·m/mm → 9.0 px·m
 *
 * — which is where NEAR_SCALE comes from, and f/2.9 is the middle of the
 * f/2.8–f/4 the last review asked for. The resulting near curve, focused at
 * 12 m:
 *
 *   | d      | 1.0 m | 1.5 m | 2 m  | 3 m  | 5 m  | 8 m  | 12 m |
 *   | CoC px |  8.25 |  5.25 | 3.75 | 2.25 | 1.05 | 0.38 |  0   |
 *
 * f/2 was tried first (12.96 px·m) and measured too hot: on `level_alpha` it put
 * 7.3 px on the paving the player would stand on at 1.5 m and dropped the
 * Laplacian energy of the frame's bottom fifth from 13.3 to 6.0, which is not
 * "aggressive depth of field", it is a soft frame. At f/2.9 the same band holds
 * 8.3–11.6 while the near metre still melts.
 */
const ESTABLISHING_NEAR_SCALE = 9.0;
const ESTABLISHING_MAX_NEAR = 10;
/**
 * The far side, off its own plane at 60 m. The number the critic asked for was
 * "a mild ~2–3 px CoC beyond ~150 m so the crane field separates from sky", and
 * the version of this that ran off the FOCUS plane delivered it — along with
 * 1.8 px on the sea at 30 m and on every building in the mid distance, which
 * halved the measured Laplacian energy of `water_golden`'s whole lower half and
 * turned the sun glitter into a smear. A landscape does not defocus at 30 m.
 *
 *   | d      | 30 m | 60 m | 100 m | 150 m | 300 m |  ∞   |
 *   | CoC px |  0   |  0   | 0.80  | 1.20  | 1.60  | 2.00 |
 */
const ESTABLISHING_FAR_SCALE = 120;
const ESTABLISHING_FAR_START_M = 60;
const ESTABLISHING_MAX_FAR = 2.0;
/** Fallback focus when the metering cross finds no geometry at all (camera on sky). */
const ESTABLISHING_FALLBACK_FOCUS_M = 12;

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
    // A frame with no weapon in it is not a gameplay frame, and
    // `RenderService.overlays.viewmodel` is the authoritative flag for that:
    // it is what `ViewmodelPass` and `ViewmodelGBufferPass` themselves gate on
    // (`passes/scene.ts`), and what the harness's `setOverlays({ viewmodel:
    // false })` drives. NOT `viewmodel.root.visible` — that was tried first and
    // silently never fired, because the viewmodel is registered with
    // `SceneGraph.addDynamic` and NO bounds, and `engine/culling.ts` writes
    // `object.visible = true` on every unbounded dynamic every single frame. The
    // rig's own `setVisible(false)` survives exactly until the next cull.
    //
    // FOV alone is NOT a sufficient signal and shipping it as one was a live
    // gameplay bug. `defs/dmr-marksman.ts` is 4× glass: aiming it multiplies the
    // world FOV by a third, so a player pressing the aim button in normal play
    // takes the camera to ~23° — under CINEMATIC_FOV_DEG — and the branch below
    // would hand him the establishing lens on the one frame in the game where he
    // most needs the far field readable. Hence the `ads < 0.01` guard on that
    // route.
    const noWeapon = !ctx.services.renderer.overlays.viewmodel;
    const establishing = noWeapon || (ctx.camera.fovDeg <= CINEMATIC_FOV_DEG && ads < 0.01);

    if (establishing) {
      dof.focus = ESTABLISHING_FALLBACK_FOCUS_M;
      dof.nearScale = ESTABLISHING_NEAR_SCALE;
      dof.farScale = ESTABLISHING_FAR_SCALE;
      dof.farStart = ESTABLISHING_FAR_START_M;
      dof.maxNear = ESTABLISHING_MAX_NEAR;
      dof.maxFar = ESTABLISHING_MAX_FAR;
      dof.autoFocus = true;
    } else {
      // Hipfire focuses at 8 m and pulls to the sight picture through the ADS
      // transition; the far side only opens as `adsBlend` rises, so the world
      // stays sharp in hipfire exactly as §6.2 requires.
      dof.focus = 8 + 12 * ads;
      dof.nearScale = GAMEPLAY_COC_SCALE;
      dof.farScale = ADS_FAR_SCALE * ads;
      dof.farStart = ADS_FAR_START_M;
      dof.maxNear = GAMEPLAY_MAX_NEAR;
      dof.maxFar = ADS_MAX_FAR * ads;
      dof.autoFocus = false;
    }
    dof.active = true;

    const target = graph.target(RTId.DofResult);
    const taps = establishing ? 32 : 12;

    graph.fullscreen(
      `post.dof.${taps}`,
      /* glsl */ `
        float focus = ironDofFocus(uDepth, uFocus, uAutoFocus);
        float centreDepth = texture(uDepth, vUv).r;
        vec3 centre = texture(uColor, vUv).rgb;
        float centreCoc = ironCoc(centreDepth, focus, uNearScale, uFarScale, uFarStart, uMaxNear, uMaxFar);

        // NEAR-FIELD PROBE. A pixel whose own CoC is zero still has to gather
        // when a blurred foreground sits next to it, or the occluder's
        // silhouette is masked to a hard edge and the near field reads as a
        // decal instead of as glass — which is precisely what the last review
        // called out. Four taps at the widest the near clamp allows are enough
        // to notice one; the gather radius then covers the rest.
        float gatherCoc = centreCoc;
        float probeR = uMaxNear * 0.5;
        for (int i = 0; i < 4; i++) {
          vec2 dir = vec2(i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0);
          float pd = texture(uDepth, vUv + dir * probeR * uTexel).r;
          gatherCoc = max(gatherCoc, ironCocNear(pd, focus, uNearScale, uMaxNear));
        }

        // Under half a pixel there is nothing to gather and this is most of the
        // frame in gameplay — the whole point of §6.2's restraint.
        if (gatherCoc < 0.6) {
          outColor = vec4(centre, centreCoc);
          return;
        }

        // Half-res gather: the radius is in DESTINATION pixels.
        float radius = gatherCoc * 0.5;
        float angleOffset = ironIgn(gl_FragCoord.xy) * 6.2831853;

        // Cat's-eye: a real lens clips the exit pupil off-axis, squashing the
        // bokeh along the radial direction toward the corners.
        vec2 toCentre = vUv - 0.5;
        float rNorm = clamp(length(toCentre * vec2(uAspect, 1.0)) * 2.0, 0.0, 1.4);
        vec2 radial = normalize(toCentre + vec2(1e-5));
        float squash = uCatsEye * smoothstep(0.35, 1.2, rNorm);

        vec3 sum = vec3(0.0);
        float weightSum = 0.0;
        // How much of this pixel a BLURRED FOREGROUND covers, 0–1. Drives both
        // the centre sample's own weight (so the sharp background does not show
        // through its own occluder) and the alpha the tonemap composites with.
        float nearCover = 0.0;
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
          float sampleCoc = ironCoc(d, focus, uNearScale, uFarScale, uFarStart, uMaxNear, uMaxFar) * 0.5;
          float dist = length(offset);
          // Scatter-as-gather: a sample only reaches this pixel if its own
          // circle of confusion is wide enough to cover the distance.
          float w = clamp((sampleCoc - dist + 1.0) * 0.6, 0.0, 1.0);
          // A SHARP foreground must not leak into a blurred background — but a
          // BLURRED one must, and the difference is the sample's own CoC.
          bool inFront = d > 0.0 && centreDepth > 0.0 && d < centreDepth;
          if (inFront && sampleCoc < 0.75) w *= 0.15;
          if (inFront) {
            float nearW = clamp(ironCocNear(d, focus, uNearScale, uMaxNear) * 0.5 - dist + 0.5, 0.0, 1.0);
            nearCover = max(nearCover, nearW);
          }
          #ifdef APERTURE
            w *= 1.0 + 0.9 * pow(r, 6.0);
          #endif
          sum += texture(uColor, uv).rgb * w;
          weightSum += w;
        }
        // The centre sample last, and weighted DOWN by the foreground coverage:
        // where a near occluder fully covers this pixel the background behind it
        // contributes 2 %, which is what stops a sharp silhouette ghosting
        // through its own bokeh.
        float centreW = max(1.0 - nearCover, 0.02);
        sum += centre * centreW;
        weightSum += centreW;
        outColor = vec4(sum / max(weightSum, 1e-4), max(centreCoc, nearCover * uMaxNear));
      `,
      {
        uColor: ut(graph.texture(this.state.source)),
        uDepth: ut(graph.texture(RTId.SceneDepth)),
        uTexel: uv2(1 / target.width, 1 / target.height),
        uFocus: uf(dof.focus),
        uNearScale: uf(dof.nearScale),
        uFarScale: uf(dof.farScale),
        uFarStart: uf(dof.farStart),
        uMaxNear: uf(dof.maxNear),
        uMaxFar: uf(dof.maxFar),
        uAspect: uf(ctx.camera.aspect),
        uCatsEye: uf(establishing ? 0.45 : 0),
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
          uniform float uNearScale;
          uniform float uFarScale;
          uniform float uFarStart;
          uniform float uMaxNear;
          uniform float uMaxFar;
          uniform float uAspect;
          uniform float uCatsEye;
          uniform float uAutoFocus;
        `,
        defines: establishing ? { TAPS: taps, APERTURE: 1 } : { TAPS: taps },
      },
    );
  }
}
