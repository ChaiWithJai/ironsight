/**
 * Pass 22 — auto-exposure. OWNER: RCORE.
 *
 * LOOK_SPEC §2.1: **exposure is derived, never dialled by eye.**
 *
 *     exposureScale = 0.18 / L_grey      L_grey = E_total · 0.18 / π
 *
 * i.e. "scale the scene so that an 18 % surface lands on scene-linear 0.18",
 * which is exactly where the AgX ramp puts display code 110. Metering a
 * centre-weighted LOG-AVERAGE luminance recovers `L_grey` from the frame itself,
 * so the same code is correct for GOLDEN, HAZE and COMBAT without a table.
 *
 * The result is clamped to ±0.75 EV around the GOLDEN anchor. Under
 * `FrameCtx.deterministic` the temporal smoothing is skipped and the CONVERGED
 * clamped meter is used directly — no history, no adaptation transient, no frame
 * count dependence, so two shots are still comparable, but a camera pointed at a
 * brighter scene still stops down. It used to freeze to the anchor outright and
 * that cost the roster a stop of median spread; the full measurement is in the
 * comment on the branch itself.
 *
 * THE ONE PIECE OF DEFENSIVE CODE IN THIS FILE. Freezing to the anchor is only
 * correct if the scene is actually in photometric units. Lighting and rendering
 * land in parallel on this project, and against a placeholder sun of intensity
 * 3.4 the anchor is thirteen stops too dark and every shot is black. So the
 * shader compares metered against anchor: within six stops it trusts the anchor
 * (real weather and time-of-day variation is a fraction of a stop), outside it
 * falls back to the instantaneous meter — still perfectly deterministic, just
 * unit-agnostic. When the sun becomes 48 000 lx the fallback stops firing on its
 * own, with nothing to remove.
 */
import {
  PassOrder,
  RTId,
  type FrameCtx,
  type RenderGraph,
  type RenderPass,
} from '@/engine/types';
import {
  EXPOSURE_ADAPT_SECONDS,
  EXPOSURE_CLAMP_EV,
  EXPOSURE_PRESET_EV,
  EXPOSURE_UNIT_SANITY_EV,
  GLSL_COLOR_COMMON,
} from '@/render/color';
import { ut, uf } from '@/render/fullscreen';
import { RT_LUMA_TILES } from '@/render/targets';
import type { IronCameraRig } from '@/render/camera-rig';
import type { IronRenderGraph } from '@/render/graph';
import type { PostChainState } from '@/render/passes/chain';

/** 64×36 tiles, matching RT_LUMA_TILES. */
const TILE_COLS = 64;
const TILE_ROWS = 36;

export class ExposurePass implements RenderPass {
  readonly id = 'post.exposure';
  readonly order = PassOrder.Exposure;
  readonly reads: readonly RTId[] = [RTId.ResolvedColor];
  readonly writes: readonly (RTId | string)[] = [RT_LUMA_TILES, RTId.Exposure];
  readonly budgetMs = 0.05;

  private readonly readback = new Float32Array(4);

  constructor(
    private readonly state: PostChainState,
    private readonly rig: IronCameraRig,
  ) {}

  enabled(): boolean {
    return true;
  }

  execute(ctx: FrameCtx, graph: RenderGraph): void {
    // Read the PREVIOUS frame's result rather than stalling on the one about to
    // be written. One frame of latency on a value with a 0.8 s time constant is
    // not observable; a synchronous readback of a just-written target is.
    if ((graph as IronRenderGraph).readPixel(RTId.Exposure, this.readback)) {
      const ev = this.readback[1];
      if (Number.isFinite(ev) && Math.abs(ev) < 60) this.rig.setExposureEv(ev);
    }

    // ---- stage 1: centre-weighted log-luma tiles --------------------------
    graph.fullscreen(
      'post.exposure.tiles',
      /* glsl */ `
        vec2 tileSize = 1.0 / vec2(float(COLS), float(ROWS));
        vec2 origin = floor(vUv * vec2(float(COLS), float(ROWS))) * tileSize;
        float logSum = 0.0;
        float weightSum = 0.0;
        for (int y = 0; y < GRID; y++) {
          for (int x = 0; x < GRID; x++) {
            vec2 uv = origin + (vec2(float(x), float(y)) + 0.5) / float(GRID) * tileSize;
            float l = ironLuma(texture(uColor, uv).rgb);
            // Centre weighting: the corners of a first-person frame are HUD,
            // sky and the player's own weapon, none of which should decide the
            // exposure of what he is aiming at.
            vec2 d = (uv - 0.5) * vec2(1.0, 0.85);
            float w = exp(-dot(d, d) * 3.2);
            // A LOG average is unbounded below, so a region at literal zero —
            // an unlit background, a subsystem that has not landed yet, a
            // shadow with no ambient — drags the mean toward minus infinity and
            // the auto-exposure opens up until the rest of the frame is white.
            // Samples below a ten-thousandth of a candela are not scene content
            // and get no vote.
            //
            // The upper bound is the NaN gate, and it is spelled as a negated
            // comparison because every comparison against NaN is false: without
            // it ONE bad texel anywhere in the frame reaches the log sum, the
            // reduction below returns NaN, and the entire image tonemaps to
            // uniform white (see ironSanitize in color.ts). step() cannot do
            // this job — its result for a NaN argument is undefined.
            if (!(l > 1.0e-4) || !(l < 1.0e12)) w = 0.0;
            logSum += log2(max(l, 1.0e-4)) * w;
            weightSum += w;
          }
        }
        outColor = vec4(logSum, weightSum, 0.0, 1.0);
      `,
      { uColor: ut(graph.texture(this.state.source)) },
      graph.target(RT_LUMA_TILES),
      {
        prelude: `${GLSL_COLOR_COMMON}\nuniform sampler2D uColor;`,
        defines: { COLS: TILE_COLS, ROWS: TILE_ROWS, GRID: 5 },
      },
    );

    // ---- stage 2: reduce to 1×1 and decide the EV -------------------------
    const history = graph.history(RTId.Exposure);
    graph.fullscreen(
      'post.exposure.resolve',
      /* glsl */ `
        float logSum = 0.0;
        float weightSum = 0.0;
        for (int y = 0; y < ROWS; y++) {
          for (int x = 0; x < COLS; x++) {
            vec4 t = texelFetch(uTiles, ivec2(x, y), 0);
            logSum += t.x;
            weightSum += t.y;
          }
        }
        // Nothing in frame passed the floor: keep the anchor rather than
        // inventing an exposure from an empty average.
        bool metered = weightSum > 1e-4 && logSum == logSum;
        float greyLuminance = exp2(logSum / max(weightSum, 1e-5));
        if (!(greyLuminance > 0.0) || !(greyLuminance < 1.0e12)) metered = false;
        // EV is defined here as log2(L_grey / 0.18): exposureScale = 2^-EV puts
        // an 18 % surface on scene-linear 0.18, which AgX puts on display 110.
        float meteredEv = metered ? clamp(log2(max(greyLuminance, 1e-9) / 0.18), -8.0, 24.0) : uPresetEv;

        bool photometric = abs(meteredEv - uPresetEv) <= uUnitSanity;
        float targetEv = photometric
          ? clamp(meteredEv, uPresetEv - uClampEv, uPresetEv + uClampEv)
          : meteredEv;

        float ev;
        if (uDeterministic > 0.5) {
          // THE CONVERGED METER, NOT THE ANCHOR. This used to be
          // "photometric ? uPresetEv : meteredEv", i.e. a deterministic capture
          // threw the meter away and shot every frame at the GOLDEN anchor.
          //
          // What that costs, measured: the anchor is derived from E_total =
          // 16 700 lx, which is the illuminance on a surface facing the sun at
          // 17.4 h. A camera aimed down a hazy harbour is not looking at that
          // surface — it is looking at 40 % sky plus an in-scattered veil over
          // everything else — and level_bravo duly came back with a median of
          // 139 against §5.2's 70–115 while light_cascades, which is half
          // shadowed alley, sat at 97. One anchor, two frames, opposite sides of
          // the band, and no tone curve can move them both: an S-curve pivots,
          // so it pushes one further out for every code it pulls the other in.
          //
          // targetEv is the metered EV clamped to the anchor ±0.75 EV (§2.1's
          // own window), which is EXACTLY the value the interactive path below
          // converges to after ~2 s. Using it here is not "auto-exposure in a
          // shot" — there is no adaptation transient, no history, no frame
          // count dependence, and the meter is a pure function of a frame that
          // is itself deterministic. It is the converged answer, evaluated in
          // closed form. And it is what a real camera does: pointing it at a
          // brighter scene stops it down.
          ev = targetEv;
        } else {
          float prevEv = texelFetch(uPrevious, ivec2(0, 0), 0).y;
          bool usable = uHistoryValid > 0.5 && abs(prevEv) < 60.0 && prevEv != 0.0;
          float k = 1.0 - exp2(-uDt / max(uHalfLife, 1e-3));
          ev = usable ? mix(prevEv, targetEv, k) : targetEv;
        }
        // Last gate before the value becomes a multiplier on every pixel in the
        // frame AND is fed back into the next frame's history. An EV that has
        // gone non-finite is unrecoverable once it is in the history, so it is
        // replaced by the anchor rather than propagated.
        if (!(ev > -60.0) || !(ev < 60.0)) ev = uPresetEv;
        outColor = vec4(exp2(-ev), ev, meteredEv, 1.0);
      `,
      {
        uTiles: ut(graph.texture(RT_LUMA_TILES)),
        uPrevious: ut(history.previous.texture),
        uPresetEv: uf(EXPOSURE_PRESET_EV),
        uClampEv: uf(EXPOSURE_CLAMP_EV),
        uUnitSanity: uf(EXPOSURE_UNIT_SANITY_EV),
        uHalfLife: uf(EXPOSURE_ADAPT_SECONDS),
        uDt: uf(Math.min(ctx.dt, 0.1)),
        uDeterministic: uf(ctx.deterministic ? 1 : 0),
        uHistoryValid: uf(history.valid ? 1 : 0),
      },
      history.current,
      {
        prelude: `
          uniform sampler2D uTiles;
          uniform sampler2D uPrevious;
          uniform float uPresetEv;
          uniform float uClampEv;
          uniform float uUnitSanity;
          uniform float uHalfLife;
          uniform float uDt;
          uniform float uDeterministic;
          uniform float uHistoryValid;
        `,
        defines: { COLS: TILE_COLS, ROWS: TILE_ROWS },
      },
    );
  }
}
