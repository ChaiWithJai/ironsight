/**
 * The seabed field — how deep the water is, everywhere.
 *
 * OWNER: WATER.
 *
 * WHY WATER BAKES ITS OWN COPY OF THE GROUND. Depth is not a decoration here;
 * it is the input to four separate things that all read wrong if it is missing:
 * the absorption gradient (turquoise over sand → blue over the channel), wave
 * shoaling and the damping that stops a 90 m swell poking through the beach,
 * the surf line, and the waterline itself — this surface is DISCARDED where the
 * seabed rises above the displaced water, which is what makes the shore a moving
 * run-up edge instead of a straight cut.
 *
 * `TerrainService` publishes a `heightMap`, but the contract does not say what
 * is in it — no format, no range, no decode. `shoreMask` IS specified, and this
 * lane reads it (see `system.ts`), but a signed distance cannot tell you how
 * much water is over the sand. So the depth field comes from `MACRO_TERRAIN`,
 * which is frozen, exactly evaluable on both sides, and which TERRAIN is
 * contractually bound to stay within a couple of metres of.
 *
 * TWO ZONES. Inside ±`FIELD_HALF_EXTENT` the field is baked to a texture, so it
 * carries the breakwater, the headland toe and the reef the freighter is aground
 * on. Outside it, the shader falls back to an analytic form of the macro
 * silhouette (`FAR_FIELD_GLSL` below) — the sea disc runs to 8 km and baking
 * that at a useful texel size would cost 60 MB to describe water that is either
 * 22 m deep or behind a hill.
 */
import * as THREE from 'three';
import { MACRO_TERRAIN } from '@/engine/macro';

/** Half-width of the baked rect, metres. The playable envelope is ±400 m. */
export const FIELD_HALF_EXTENT = 460;
/** 640² over ±460 m is 1.44 m per texel — finer than the surf band is wide. */
export const FIELD_RESOLUTION = 640;

export interface SeabedField {
  readonly texture: THREE.DataTexture;
  readonly halfExtent: number;
  readonly resolution: number;
  /** Deepest point in the baked rect. Used to size the absorption ramp. */
  readonly minHeight: number;
}

/**
 * R = seabed height in metres, G = |∇h| (the slope magnitude).
 *
 * The slope is baked rather than differenced in the shader because the fragment
 * would need four extra taps for it, and because it is what the breakwater and
 * the rocks under the headland use to grow their own foam — a steep seabed under
 * a running swell is where water breaks whether or not it is near the beach.
 */
export function bakeSeabedField(): SeabedField {
  const n = FIELD_RESOLUTION;
  const data = new Uint16Array(n * n * 2);
  const step = (FIELD_HALF_EXTENT * 2) / (n - 1);
  // One row of heights is reused as the previous row for the vertical
  // difference, so the whole field costs one macro evaluation per texel rather
  // than five.
  const rows = new Float32Array(n * 3);
  let minHeight = 0;

  const rowAt = (j: number, into: number): void => {
    const z = -FIELD_HALF_EXTENT + j * step;
    const base = into * n;
    for (let i = 0; i < n; i++) {
      rows[base + i] = MACRO_TERRAIN.height(-FIELD_HALF_EXTENT + i * step, z);
    }
  };

  rowAt(0, 0);
  rowAt(0, 1);
  for (let j = 0; j < n; j++) {
    const next = Math.min(j + 1, n - 1);
    rowAt(next, 2);
    for (let i = 0; i < n; i++) {
      const h = rows[n + i];
      const hx = rows[n + Math.min(i + 1, n - 1)] - rows[n + Math.max(i - 1, 0)];
      const hz = rows[2 * n + i] - rows[i];
      const denomX = (Math.min(i + 1, n - 1) - Math.max(i - 1, 0)) * step;
      const denomZ = (next - Math.max(j - 1, 0)) * step;
      const slope = Math.hypot(hx / Math.max(denomX, 1e-3), hz / Math.max(denomZ, 1e-3));
      const o = (j * n + i) * 2;
      data[o] = THREE.DataUtils.toHalfFloat(h);
      data[o + 1] = THREE.DataUtils.toHalfFloat(Math.min(slope, 8));
      if (h < minHeight) minHeight = h;
    }
    rows.copyWithin(0, n, 2 * n);
    rows.copyWithin(n, 2 * n, 3 * n);
  }

  const texture = new THREE.DataTexture(data, n, n, THREE.RGFormat, THREE.HalfFloatType);
  texture.name = 'water.seabed';
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, halfExtent: FIELD_HALF_EXTENT, resolution: n, minHeight };
}

/**
 * The far field, as GLSL. A LITERAL TRANSPOSITION of `macroHeight` minus the
 * headland bumps, the breakwater ridge, the corridor saddle and the capture
 * terraces — every one of which lives inside ±260 m and therefore inside the
 * baked rect. What is left is the coast profile itself, which is what the sea
 * beyond the rect is sitting on.
 *
 * The two zones are cross-faded over 60 m, so the join is invisible even where
 * the terms this drops are not quite zero yet.
 */
export const FAR_FIELD_GLSL = /* glsl */ `
float ironWaterFarSeabed(vec2 p) {
  // Three incommensurate periods — 838 m, 331 m, 203 m — so the coastline never
  // repeats. Identical constants to src/engine/macro.ts:shorelineZ.
  float shoreZ = -30.0 + 26.0 * sin(p.x * 0.0075) + 14.0 * sin(p.x * 0.019 + 1.7)
               - 8.0 * cos(p.x * 0.031 - 0.4);
  float d = p.y - shoreZ;
  float seabed = -min(22.0, 0.35 + pow(max(0.0, -d), 1.18) * 0.055);
  float berm = 2.4 * smoothstep(0.0, 16.0, d);
  float terrace = 7.6 * smoothstep(22.0, 135.0, d);
  float hills = 27.0 * smoothstep(150.0, 390.0, d);
  float roll = 2.1 * sin(p.x * 0.0125 + 0.6) * smoothstep(10.0, 90.0, d)
             + 1.3 * sin(p.y * 0.017 - 1.1);
  return mix(seabed, berm + terrace + hills + roll, smoothstep(-18.0, 18.0, d));
}

// Returns (seabed height, seabed slope magnitude).
vec2 ironWaterSeabed(vec2 p) {
  vec2 uv = (p - uWaterFieldOrigin) * uWaterFieldInvSize;
  // Fade over the last 60 m of the rect rather than at its edge: a hard switch
  // between two height fields is a visible crease in the waterline.
  vec2 edge = min(uv, 1.0 - uv) * uWaterFieldSize;
  float w = smoothstep(0.0, 60.0, min(edge.x, edge.y));
  vec2 tex = texture(uWaterSeabed, clamp(uv, 0.002, 0.998)).rg;
  // Most fragments of most frames are inside the baked rect, and the far field
  // costs eight transcendentals. Do not pay for it to be multiplied by zero.
  if (w >= 0.999) return tex;
  float far = ironWaterFarSeabed(p);
  return vec2(mix(far, tex.x, w), mix(0.03, tex.y, w));
}
`;
