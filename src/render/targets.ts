/**
 * Every render target RCORE owns, declared in one place. OWNER: RCORE.
 *
 * `RenderGraph.declare` is idempotent for an identical desc, so a lane may
 * re-declare anything here without negotiating — but it declares DIFFERENTLY at
 * its peril, because that throws at boot for everyone. The formats below are the
 * ones `docs/ARCHITECTURE.md` §4 specifies, with the deviations called out
 * inline.
 */
import {
  RTFormat,
  RTId,
  type QualitySettings,
  type RenderGraph,
} from '@/engine/types';

/**
 * The tonemapped frame at INTERNAL resolution, before lens character and before
 * the renderScale → native resolve. Splitting this off `LdrColor` is what lets
 * pass 26 do the upscale in the same fetch as the vignette instead of paying for
 * a separate resolve blit.
 */
export const RT_GRADED = 'post.graded';

/** 64×36 log-luma tile map, then an 8×8 reduction of it. Auto-exposure, P22. */
export const RT_LUMA_TILES = 'post.exposure.tiles';
export const RT_LUMA_REDUCE = 'post.exposure.reduce';

export const bloomMipId = (level: number): string => `post.bloom.mip${level}`;
export const bloomUpId = (level: number): string => `post.bloom.up${level}`;

/**
 * LOOK_SPEC §6.1 mip weights, renormalised to whatever level count the tier
 * gives us. The geometric fall-off is the whole point: it is what produces a
 * tight core AND a frame-wide veil from one pyramid, which a single-radius
 * gaussian mathematically cannot.
 */
export const BLOOM_MIP_WEIGHTS = [0.34, 0.24, 0.17, 0.12, 0.08, 0.035, 0.015];

/** Deepest pyramid we will build: 0.5 → 1/64 of the frame, LOOK_SPEC §6.1. */
export const BLOOM_MAX_LEVELS = 6;

export function bloomLevels(quality: Readonly<QualitySettings>): number {
  return Math.max(2, Math.min(BLOOM_MAX_LEVELS, quality.bloom.levels));
}

/**
 * Declare the whole RCORE resource set. Called once, from `afterBoot`, before
 * any pass is added — passes may then assume every id here exists.
 */
export function declareCoreTargets(graph: RenderGraph, quality: Readonly<QualitySettings>): void {
  const hdr = quality.hdrFormat;

  // ---- G-buffer (pass 5). See `fullscreen.ts` for the encoding contract.
  //
  // SceneDepth leads the MRT set, so the prepass framebuffer inherits ITS depth
  // attachment; that is also why it is the only one of the three that asks for a
  // depth buffer.
  graph.declare({
    id: RTId.SceneDepth,
    format: RTFormat.R32F,
    scale: 1,
    filter: 'nearest',
    depthBuffer: 'buffer',
  });
  graph.declare({ id: RTId.GNormalRough, format: RTFormat.RGB10A2, scale: 1, filter: 'nearest', depthBuffer: false });
  graph.declare({ id: RTId.GVelocity, format: RTFormat.RG16F, scale: 1, filter: 'linear', depthBuffer: false });

  // ---- scene colour (passes 10–17)
  graph.declare({ id: RTId.SceneColor, format: hdr, scale: 1, depthBuffer: 'buffer' });
  // Declared here and BLITTED BY WATER (architecture §4, pass 14). Declaring it
  // costs nothing until someone calls `target()` — the pool allocates lazily —
  // and not declaring it would leave water reading an id nobody created.
  graph.declare({ id: RTId.SceneColorCopy, format: hdr, scale: 1, depthBuffer: false });

  // ---- temporal (passes 18–19)
  graph.declare({ id: RTId.VelocityTiles, format: RTFormat.RG16F, scale: 1 / 20, filter: 'nearest', depthBuffer: false });
  // RGBA16F even when hdrFormat is R11G11B10F: the feedback loop accumulates the
  // 10-bit blue channel's quantisation into a visible cast over ~30 frames.
  graph.declare({ id: RTId.TaaHistory, format: RTFormat.RGBA16F, scale: 1, history: true, depthBuffer: false });
  graph.declare({ id: RTId.ResolvedColor, format: hdr, scale: 1, depthBuffer: false });

  // ---- post (passes 21–26)
  graph.declare({ id: RT_LUMA_TILES, format: RTFormat.RGBA16F, size: [64, 36], filter: 'linear', depthBuffer: false });
  graph.declare({ id: RT_LUMA_REDUCE, format: RTFormat.RGBA16F, size: [8, 8], filter: 'nearest', depthBuffer: false });
  // RGBA32F rather than the table's R32F for one reason: a 1×1 RGBA/FLOAT
  // framebuffer is the only combination WebGL2 guarantees `readPixels` accepts,
  // and the CPU needs the value to publish `CameraState.exposureEv`. 16 bytes.
  graph.declare({
    id: RTId.Exposure,
    format: RTFormat.RGBA32F,
    size: [1, 1],
    filter: 'nearest',
    history: true,
    depthBuffer: false,
  });

  const levels = bloomLevels(quality);
  for (let i = 0; i < levels; i++) {
    const scale = 0.5 / Math.pow(2, i);
    graph.declare({ id: bloomMipId(i), format: hdr, scale, filter: 'linear', depthBuffer: false });
    // Level 0's upsample accumulator IS BloomPyramid, so it is not allocated twice.
    if (i > 0) graph.declare({ id: bloomUpId(i), format: hdr, scale, filter: 'linear', depthBuffer: false });
  }
  graph.declare({ id: RTId.BloomPyramid, format: hdr, scale: 0.5, filter: 'linear', depthBuffer: false });

  // Half res, and composited back up by CoC in the tonemap. LOOK_SPEC §6.2's
  // gameplay CoC never exceeds 3 px, so half res costs nothing there; the
  // cinematic 20–40 px bokeh is where the resolution would otherwise hurt, and
  // a 20 px disc has no half-res detail to lose.
  graph.declare({ id: RTId.DofResult, format: RTFormat.RGBA16F, scale: 0.5, filter: 'linear', depthBuffer: false });

  graph.declare({ id: RT_GRADED, format: RTFormat.RGBA8_SRGB, scale: 1, filter: 'linear', depthBuffer: false });
  // NATIVE, never renderScale: the HUD composites onto this at pass 27 and a HUD
  // upscaled from 0.7× is the exact tell the rule exists to prevent.
  graph.declare({ id: RTId.LdrColor, format: RTFormat.RGBA8_SRGB, native: true, filter: 'linear', depthBuffer: false });
}
