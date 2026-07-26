/**
 * GPU capability probe. CORE owns this file.
 *
 * Runs ONCE at boot, before anything is allocated, because the answers decide
 * the quality tier, the bake profile and whether the HDR path is even legal.
 *
 * THE ONE LINE THAT COSTS A DAY IF YOU DO NOT KNOW IT
 * --------------------------------------------------
 * `EXT_color_buffer_float` must be requested EXPLICITLY. three requests it for
 * its own R16F/RG16F/RGBA16F code paths but NOT for R11G11B10F, which is exactly
 * what the Low tier uses for scene colour — so without the call below every HDR
 * target on Low comes back framebuffer-incomplete and the screen is black with
 * no error. Requesting an extension is idempotent and free, so we ask for it
 * here, before the render graph allocates a single target.
 */
import type * as THREE from 'three';
import { QualityTier, type GpuCaps } from '@/engine/types';

/** Renderer strings that mean "we are on a software rasteriser" (i.e. the harness). */
const SOFTWARE_MARKERS = ['swiftshader', 'llvmpipe', 'softwarerasterizer', 'software rasterizer', 'microsoft basic render'];

/** Renderer substrings that reliably indicate integrated/mobile-class hardware. */
const WEAK_MARKERS = ['intel', 'uhd graphics', 'hd graphics', 'iris', 'mali', 'adreno', 'powervr', 'apple a'];

/** Renderer substrings for parts that comfortably hold Ultra at 1080p. */
const STRONG_MARKERS = ['rtx', 'radeon rx 6', 'radeon rx 7', 'radeon rx 9', 'apple m2', 'apple m3', 'apple m4', 'geforce gtx 16', 'arc a7'];

export function probeGpu(renderer: THREE.WebGLRenderer): GpuCaps {
  const gl = renderer.getContext() as WebGL2RenderingContext;

  // ↓↓↓ Do not remove. See the header comment. ↓↓↓
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  const floatBlend = gl.getExtension('EXT_float_blend') !== null;
  const timerQuery = gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null;
  gl.getExtension('OES_texture_float_linear');
  gl.getExtension('EXT_texture_filter_anisotropic');

  let vendor = safeParam(gl, gl.VENDOR);
  let rendererName = safeParam(gl, gl.RENDERER);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) {
    vendor = safeParam(gl, dbg.UNMASKED_VENDOR_WEBGL) || vendor;
    rendererName = safeParam(gl, dbg.UNMASKED_RENDERER_WEBGL) || rendererName;
  }

  const lower = `${vendor} ${rendererName}`.toLowerCase();
  const isSoftware = SOFTWARE_MARKERS.some((m) => lower.includes(m));

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
  const maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS) as number;
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

  // navigator.deviceMemory is Chromium-only and quantised to 0.25/0.5/1/2/4/8.
  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number };
  const deviceMemoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 8;

  return {
    vendor,
    renderer: rendererName,
    isSoftware,
    maxTextureSize,
    maxArrayLayers,
    maxDrawBuffers,
    colorBufferFloat,
    floatBlend,
    timerQuery,
    maxAnisotropy,
    deviceMemoryGb,
    estimatedTier: estimateTier({ isSoftware, lower, maxTextureSize, deviceMemoryGb, colorBufferFloat }),
  };
}

function safeParam(gl: WebGL2RenderingContext, pname: number): string {
  try {
    const v = gl.getParameter(pname);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * A quick static classification, not a benchmark. A benchmark at boot costs
 * seconds we do not have inside the 300 s harness ready timeout, and the dynamic
 * resolution governor corrects a wrong guess within a second of gameplay anyway.
 *
 * NOTE the deliberate asymmetry for software rendering: we keep the RENDER tier
 * at High even under SwiftShader, because shots must stay beautiful. It is the
 * BAKE profile that gets forced down (see quality.ts) — coarser textures, same
 * frame. Frame budget under the harness is counted in frames, never seconds.
 */
function estimateTier(info: {
  isSoftware: boolean;
  lower: string;
  maxTextureSize: number;
  deviceMemoryGb: number;
  colorBufferFloat: boolean;
}): QualityTier {
  if (!info.colorBufferFloat) return QualityTier.Low;
  if (info.isSoftware) return QualityTier.High;
  if (info.maxTextureSize < 8192 || info.deviceMemoryGb <= 2) return QualityTier.Low;
  if (STRONG_MARKERS.some((m) => info.lower.includes(m))) return QualityTier.Ultra;
  if (WEAK_MARKERS.some((m) => info.lower.includes(m))) return QualityTier.Medium;
  return QualityTier.High;
}

/** Worker pool size. One core is left for the main thread, which owns all GL. */
export function suggestedWorkerCount(): number {
  const n = navigator.hardwareConcurrency;
  if (!n || n < 2) return 0;
  return Math.min(n - 1, 4);
}
