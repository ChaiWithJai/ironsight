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
 * A 35 mm full-frame lens at f/2.8, on a 24 mm-high sensor at 1080p:
 *
 *     (35² / 2.8) / 1000 · (1080 / 24) = 0.4375 · 45 = 19.7 px·m
 *
 * ROUND 4 DOUBLED THIS, FROM THE 9.0 px·m OF A 24 mm f/2.9, AND THE REASON IS
 * THAT 9.0 NEVER PRODUCED A MEASURABLE BLUR ON ANY SHOT IN THE ROSTER. The
 * arithmetic is unforgiving: paired with round 3's 12 m focus ceiling it asked
 * for 1.39 px on `sky_golden`'s 4.2 m gantry leg and 0.66 px on
 * `light_cascades`' 2 m block wall — both under this pass's own 0.6 px gather
 * floor or close enough to it to be invisible — and the frames measured exactly
 * as sharp in the near field as at 200 m. A 24 mm lens has enormous depth of
 * field; that is what 24 mm lenses are for, and it is the wrong lens for a
 * frame whose whole job is a defocused near occluder.
 *
 * The resulting near curve, focused at 40 m (a typical metered midground):
 *
 *   | d      | 0.5 m | 1.0 m | 1.5 m | 2 m  | 3 m  | 5 m  | 10 m | 20 m |
 *   | CoC px | 38.9→ | 19.2  | 12.6  | 9.4  | 6.1  | 3.4  | 1.5  | 0.49 |
 *
 * — the first entry clamped by MAX_NEAR. That is the shape the reference corpus
 * has: a near occluder frankly out of focus, a playable surface at 3–5 m that is
 * softened but still reads its own material, and everything past ~15 m sharp.
 */
const ESTABLISHING_NEAR_SCALE = 27.6;
/**
 * 26 px, which the curve above reaches at 1.03 m. The clamp exists to stop the
 * gather radius running away on geometry that is almost against the lens (a
 * shot standing inside a doorway); it is deliberately set where the curve
 * naturally arrives at 1 m so that everything a beauty frame actually contains
 * is on the physical curve rather than on the plateau.
 */
const ESTABLISHING_MAX_NEAR = 26;
/**
 * The FLOOR the readable-plane solve is allowed to stop down to, in px·m.
 *
 * 3.2 px·m is the same 35 mm at about f/17 — a documentary aperture rather than
 * a portrait one. It is no longer a second operating point selected by a ramp
 * (see `DOF_READABLE_M` in `chain.ts` for what replaced that); it is the bottom
 * of the clamp, and it exists so that a frame metered almost against the lens
 * cannot solve its way to a pinhole and then read with a visibly different
 * microcontrast from every other frame in the roster.
 */
const ESTABLISHING_CLOSE_NEAR_SCALE = 3.2;
/**
 * The far side, off its own plane. ROUND 5 BROUGHT THE PLANE IN FROM 60 m TO
 * 34 m AND THE CEILING UP FROM 2.0 px TO 2.8 px.
 *
 * The 60 m plane was set to stop `water_golden` softening its own sea at 30 m,
 * and that constraint is real — but 60 m also puts ZERO blur on everything a
 * town-scale establishing frame actually has in its background. Measured on
 * `level_alpha`, whose deepest plane is the colonnade at ~70 m: the old curve
 * asked for 0.29 px there, i.e. nothing, and the frame's 70 m band came back
 * measurably SHARPER than its 1 m band. AAA_RUBRIC's calibration note 5 is
 * explicit that both ends are supposed to carry bokeh.
 *
 * 34 m is chosen against `water_golden` rather than away from it: that frame
 * meters at 54 m, and `ironCoc` runs the far half off `max(farStart, focus)`,
 * so its own plane is still 54 m and its sea is still untouched. The plane only
 * comes forward on frames metered NEARER than 34 m, which is precisely the set
 * of frames that have a foreground subject and therefore want a background.
 *
 *   | d      | 34 m | 50 m | 70 m | 100 m | 150 m | 300 m |  ∞   |
 *   | CoC px |  0   | 1.29 | 2.11 | 2.80  | 2.80  | 2.80  | 2.80 |
 */
const ESTABLISHING_FAR_SCALE = 140;
const ESTABLISHING_FAR_START_M = 34;
const ESTABLISHING_MAX_FAR = 2.8;
/** Fallback focus when the metering cross finds no geometry at all (camera on sky). */
const ESTABLISHING_FALLBACK_FOCUS_M = 30;

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
      dof.closeNearScale = ESTABLISHING_CLOSE_NEAR_SCALE;
      dof.farScale = ESTABLISHING_FAR_SCALE;
      dof.farStart = ESTABLISHING_FAR_START_M;
      // Half the clamp when a WEAPON is in the frame on the cinematic route
      // (deploy camera, `post_dof_bokeh`). A viewmodel at 0.2 m is the roster's
      // worst case for gather variance — small, near-black, and carrying the
      // highest-frequency material in the game — and at the full 26 px clamp the
      // 96-tap spiral stops averaging it and the bokeh discs grow a visible
      // fibrous texture. Halving the radius quarters the area each tap has to
      // cover. A near-field WALL, which is what every other establishing frame
      // has, shows none of this and keeps the full clamp.
      dof.maxNear = noWeapon ? ESTABLISHING_MAX_NEAR : ESTABLISHING_MAX_NEAR * 0.5;
      dof.maxFar = ESTABLISHING_MAX_FAR;
      dof.autoFocus = true;
    } else {
      // Hipfire focuses at 8 m and pulls to the sight picture through the ADS
      // transition; the far side only opens as `adsBlend` rises, so the world
      // stays sharp in hipfire exactly as §6.2 requires.
      dof.focus = 8 + 12 * ads;
      dof.nearScale = GAMEPLAY_COC_SCALE;
      // The gameplay lens never stops down: it is already at 0.926 px m and its
      // whole job is the viewmodel, which is always inside the ramp.
      dof.closeNearScale = GAMEPLAY_COC_SCALE;
      dof.farScale = ADS_FAR_SCALE * ads;
      dof.farStart = ADS_FAR_START_M;
      dof.maxNear = GAMEPLAY_MAX_NEAR;
      dof.maxFar = ADS_MAX_FAR * ads;
      dof.autoFocus = false;
    }
    dof.active = true;

    const target = graph.target(RTId.DofResult);
    // Tap count scales with the AREA the gather has to cover, not with taste.
    // The establishing lens reaches a 13 half-res-pixel radius — 530 texels of
    // area — and the tap count has to keep the samples-per-texel roughly where
    // the gameplay lens has it or the spiral itself becomes visible as speckle
    // inside the disc. 32 was measured as ringing on `post_dof_bokeh`'s
    // viewmodel (a small, high-contrast, near-black subject at 0.2 m is the
    // worst case in the roster for this); 96 is where it stops.
    //
    // THE COST IS REAL AND IT IS TAKEN ON PURPOSE: this branch only runs on
    // frames with no weapon in them, i.e. beauty passes and the deploy camera,
    // never on a gameplay frame, where the 12-tap path and its 5 px clamp are
    // untouched. `budgetMs` below is the gameplay number.
    const taps = establishing ? 96 : 12;

    graph.fullscreen(
      `post.dof.${taps}`,
      /* glsl */ `
        float focus = ironDofFocus(uDepth, uFocus, uAutoFocus);
        float nearScale = ironDofNearScale(focus, uCloseNearScale, uNearScale);
        float centreDepth = texture(uDepth, vUv).r;
        vec3 centre = texture(uColor, vUv).rgb;
        float centreCoc = ironCoc(centreDepth, focus, nearScale, uFarScale, uFarStart, uMaxNear, uMaxFar);

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
          gatherCoc = max(gatherCoc, ironCocNear(pd, focus, nearScale, uMaxNear));
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
          float sampleCoc = ironCoc(d, focus, nearScale, uFarScale, uFarStart, uMaxNear, uMaxFar) * 0.5;
          float dist = length(offset);
          // Scatter-as-gather: a sample only reaches this pixel if its own
          // circle of confusion is wide enough to cover the distance.
          float w = clamp((sampleCoc - dist + 1.0) * 0.6, 0.0, 1.0);
          // A SHARP foreground must not leak into a blurred background — but a
          // BLURRED one must, and the difference is the sample's own CoC.
          bool inFront = d > 0.0 && centreDepth > 0.0 && d < centreDepth;
          if (inFront && sampleCoc < 0.75) w *= 0.15;
          if (inFront) {
            float nearW = clamp(ironCocNear(d, focus, nearScale, uMaxNear) * 0.5 - dist + 0.5, 0.0, 1.0);
            nearCover = max(nearCover, nearW);
          }
          #ifdef APERTURE
            // Rim boost, 0.30 and not the 0.90 this shipped with. A real bokeh
            // disc IS brighter at its edge, but at 0.90 the outermost ring of
            // the spiral carries nearly twice the weight of everything inside
            // it, so at the 13 half-res-pixel radius the establishing lens now
            // reaches, the individual taps in that ring stop averaging and the
            // disc grows visible spokes. Measured on post_dof_bokeh's
            // viewmodel, which is the roster's worst case: a small, near-black,
            // high-contrast subject at 0.2 m.
            w *= 1.0 + 0.30 * pow(r, 6.0);
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
        uCloseNearScale: uf(dof.closeNearScale),
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
          uniform float uCloseNearScale;
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
