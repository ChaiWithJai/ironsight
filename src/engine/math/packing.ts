/**
 * Bit packing shared by the CPU and the GLSL chunks. CORE owns this file.
 *
 * The prepass writes an octahedral normal into RG10 and roughness into B10, and
 * several lanes need the matching CPU encode/decode (impostor bakes, debug
 * readback, occlusion raster). Keeping both halves in one file is the only way
 * they stay in sync.
 */

/** Octahedral encode of a unit vector into [0,1]². Standard Cigolle et al. mapping. */
export function octEncode(x: number, y: number, z: number, out: { x: number; y: number }): void {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let px = x / l1;
  let py = y / l1;
  if (z < 0) {
    const ax = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
    const ay = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1);
    px = ax;
    py = ay;
  }
  out.x = px * 0.5 + 0.5;
  out.y = py * 0.5 + 0.5;
}

/** Inverse of `octEncode`. Writes a normalised vector. */
export function octDecode(u: number, v: number, out: { x: number; y: number; z: number }): void {
  const px = u * 2 - 1;
  const py = v * 2 - 1;
  let x = px;
  let y = py;
  let z = 1 - Math.abs(px) - Math.abs(py);
  if (z < 0) {
    const ax = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const ay = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = ax;
    y = ay;
  }
  const len = Math.hypot(x, y, z) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
}

/** Quantise 0..1 into `bits` levels, matching what the GPU unorm target stores. */
export function quantiseUnorm(v: number, bits: number): number {
  const max = (1 << bits) - 1;
  return Math.round(Math.min(1, Math.max(0, v)) * max) / max;
}

/** Pack four 0..1 channels into one uint32 as RGBA8, little-endian byte order. */
export function packRgba8(r: number, g: number, b: number, a: number): number {
  const ri = Math.round(Math.min(1, Math.max(0, r)) * 255);
  const gi = Math.round(Math.min(1, Math.max(0, g)) * 255);
  const bi = Math.round(Math.min(1, Math.max(0, b)) * 255);
  const ai = Math.round(Math.min(1, Math.max(0, a)) * 255);
  return ((ai << 24) | (bi << 16) | (gi << 8) | ri) >>> 0;
}

/** sRGB electro-optical transfer function. Colour arriving from art tools is sRGB. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Rec.709 relative luminance of a linear colour. */
export function luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
