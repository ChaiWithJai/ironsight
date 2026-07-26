/**
 * THE PUBLISHED MAPS. Owned by TERRAIN.
 *
 *   heightMap    R32F   the field, for anyone who wants it on the GPU
 *   splatMap     RGBA8  r sand · g dry scrub/soil · b rock · a built-ground transition
 *   shoreMask    R8     signed distance to the waterline, WATER's foam and
 *                       shoaling input and VEG's beach exclusion
 *   groundAlbedo RGBA8  64², the coarse ground colour LIGHT integrates into the
 *                       lower (bounce) SH lobe — LOOK_SPEC §2.4 asks the terrain
 *                       lane for exactly this, and without it every downward
 *                       facing surface in the map is lit by a grey constant
 *
 * All four share ONE world rect and ONE mapping, published as
 * `TerrainService.mapRect`, because four lanes sample them and each inventing
 * its own constant is how the foam band and the wave damping end up in
 * different places.
 *
 * The splat is CLASSIFIED, not painted: slope, altitude, curvature and shore
 * distance decide the material, broken up by two octaves of noise so no
 * boundary is a contour line. That is why the beach follows the actual beach and
 * the rock follows the actual cliff, at any resolution, with no authored mask.
 */
import * as THREE from 'three';
import type { NoiseLib, StaticColliderDef } from '@/engine/types';
import { clamp01, smoothstep } from '@/engine/math/curves';
import { linearToSrgb } from '@/engine/math/packing';
import { FIELD_HALF, type TerrainField } from '@/world/terrain/field';

/** ±metres encoded into the R8 shore mask. Beyond this it clamps. */
export const SHORE_RANGE_METRES = 48;

/**
 * Linear albedo of each splat layer. Straight off LOOK_SPEC §4.3: dry sand
 * 0.45–0.58, dry soil 0.18–0.30 at hue 30–40°, sandstone 0.32–0.48 at hue
 * 27–35°. These are the numbers the shader tints with and the numbers LIGHT
 * bounces; they are not a look, they are the material.
 */
export const LAYER_ALBEDO = {
  sand: [0.465, 0.394, 0.287] as const,
  scrub: [0.238, 0.197, 0.119] as const,
  rock: [0.356, 0.299, 0.230] as const,
  sea: [0.030, 0.052, 0.058] as const,
};

export interface SplatWeights {
  sand: number;
  scrub: number;
  rock: number;
}

export interface TerrainMaps {
  readonly size: number;
  readonly heightMap: THREE.DataTexture;
  readonly splatMap: THREE.DataTexture;
  readonly shoreMask: THREE.DataTexture;
  readonly groundAlbedo: THREE.DataTexture;
  readonly splatData: Uint8Array;
  readonly rect: Readonly<{ minX: number; minZ: number; sizeX: number; sizeZ: number }>;
}

/**
 * The one classifier. Height, slope (|∇h|), curvature (∇²h, positive concave)
 * and shore distance in, material weights out.
 */
export function classify(
  noise: NoiseLib,
  x: number,
  z: number,
  h: number,
  slope: number,
  curvature: number,
  shore: number,
  out: SplatWeights,
): void {
  // Two octaves at incommensurate scales (18 m and 4.7 m) so every boundary is
  // ragged at two scales at once and none of them reads as a contour.
  const jitter =
    noise.fbm2(x * 0.055, z * 0.055, 3, 2, 0.5, 0x0a13) * 0.55 + noise.fbm2(x * 0.212, z * 0.212, 2, 2, 0.5, 0x0b77) * 0.24;

  // MEASURED AGAINST THE ACTUAL SILHOUETTE, not against a mental image of a
  // cliff. The headland is two overlapping gaussians of σ 96 m and 62 m, whose
  // steepest point is |∇h| ≈ 0.25 — 14°. Thresholds authored for a 40° cliff
  // face never fire anywhere on this map, and the whole promontory comes out
  // sand-coloured. Rock therefore starts at a 9° slope and, more importantly,
  // is driven by ALTITUDE: the headland is rock because it is the headland.
  const rockSlope = smoothstep(0.16 + jitter * 0.08, 0.38 + jitter * 0.08, slope);
  const rockAlt = smoothstep(11, 23, h) * 0.9;
  // Scree and gravel collect on channel floors: concave curvature at any slope
  // exposes coarse material, which is what makes an erosion gully READ as one.
  const gravel = smoothstep(0.015, 0.12, curvature) * 0.42;
  let rock = clamp01(Math.max(rockSlope, rockAlt) + gravel);

  const sandShore = 1 - smoothstep(5 + jitter * 6, 20 + jitter * 9, shore);
  const sandLow = 1 - smoothstep(1.8, 5.6, h);
  const sand = clamp01(Math.max(sandShore, sandLow)) * (1 - rock * 0.82);
  rock *= 1 - sand * 0.35;
  const scrub = clamp01(1 - sand - rock);

  const sum = sand + scrub + rock || 1;
  out.sand = sand / sum;
  out.scrub = scrub / sum;
  out.rock = rock / sum;
}

export function buildMaps(field: TerrainField, noise: NoiseLib, splatSize: number): TerrainMaps {
  const size = Math.min(2048, Math.max(512, splatSize));
  const rect = { minX: -FIELD_HALF, minZ: -FIELD_HALF, sizeX: FIELD_HALF * 2, sizeZ: FIELD_HALF * 2 };
  const texel = rect.sizeX / size;

  // Working copy of the field at texel centres. Every derived quantity below is
  // a finite difference of THIS array, so the whole bake costs one pass over the
  // field rather than five Catmull-Rom evaluations per texel.
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = rect.minZ + (j + 0.5) * texel;
    for (let i = 0; i < size; i++) {
      h[j * size + i] = field.height(rect.minX + (i + 0.5) * texel, z);
    }
  }

  const splat = new Uint8Array(size * size * 4);
  const shore = new Uint8Array(size * size);
  const w: SplatWeights = { sand: 0, scrub: 0, rock: 0 };
  const sea = field.seaLevel;

  for (let j = 0; j < size; j++) {
    const j0 = Math.max(0, j - 1) * size;
    const j1 = Math.min(size - 1, j + 1) * size;
    const jc = j * size;
    for (let i = 0; i < size; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(size - 1, i + 1);
      const t = jc + i;
      const hc = h[t];
      const gx = (h[jc + i1] - h[jc + i0]) / ((i1 - i0) * texel);
      const gz = (h[j1 + i] - h[j0 + i]) / ((j1 - j0) * texel);
      const slope = Math.hypot(gx, gz);
      const curvature = (h[jc + i1] + h[jc + i0] + h[j1 + i] + h[j0 + i] - 4 * hc) / (texel * texel);
      const shoreDist = (hc - sea) / Math.max(slope, 0.012);

      const x = rect.minX + (i + 0.5) * texel;
      const z = rect.minZ + (j + 0.5) * texel;
      classify(noise, x, z, hc, slope, curvature, shoreDist, w);
      splat[t * 4] = Math.round(w.sand * 255);
      splat[t * 4 + 1] = Math.round(w.scrub * 255);
      splat[t * 4 + 2] = Math.round(w.rock * 255);
      splat[t * 4 + 3] = 0;

      // Signed, negative offshore — the same convention MacroTerrain uses, so
      // the CPU and GPU answers cannot disagree about which side is wet.
      const clamped = Math.max(-1, Math.min(1, shoreDist / SHORE_RANGE_METRES));
      shore[t] = Math.round((clamped * 0.5 + 0.5) * 255);
    }
  }

  const heightRes = Math.min(1024, size);
  const heights = new Float32Array(heightRes * heightRes);
  const hTexel = rect.sizeX / heightRes;
  for (let j = 0; j < heightRes; j++) {
    const z = rect.minZ + (j + 0.5) * hTexel;
    for (let i = 0; i < heightRes; i++) {
      heights[j * heightRes + i] = field.height(rect.minX + (i + 0.5) * hTexel, z);
    }
  }

  const heightMap = new THREE.DataTexture(heights, heightRes, heightRes, THREE.RedFormat, THREE.FloatType);
  heightMap.name = 'terrain.height';
  const splatMap = new THREE.DataTexture(splat, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  splatMap.name = 'terrain.splat';
  const shoreMask = new THREE.DataTexture(shore, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  shoreMask.name = 'terrain.shore';
  for (const tex of [heightMap, splatMap, shoreMask]) {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
  }

  const groundAlbedo = buildGroundAlbedo(field, splat, size, rect);

  return { size, heightMap, splatMap, shoreMask, groundAlbedo, splatData: splat, rect };
}

/**
 * 64² ground colour for LIGHT's bounce lobe. Sea cells carry the sea's albedo,
 * which is the whole reason the seaward side of a wall goes cool and the
 * landward side goes warm — LOOK_SPEC §1.1 calls that split the most valuable
 * composition on the map, and it only falls out for free if the bounce lobe
 * knows the ground is water over there.
 */
function buildGroundAlbedo(
  field: TerrainField,
  splat: Uint8Array,
  splatSize: number,
  rect: { minX: number; minZ: number; sizeX: number; sizeZ: number },
): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const ratio = splatSize / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Box-average the splat over this cell rather than point sampling, so a
      // 16 m bounce sample is the average of what is actually down there.
      let sand = 0;
      let scrub = 0;
      let rock = 0;
      let n = 0;
      const si0 = Math.floor(i * ratio);
      const sj0 = Math.floor(j * ratio);
      for (let sj = sj0; sj < sj0 + ratio; sj += 4) {
        for (let si = si0; si < si0 + ratio; si += 4) {
          const t = (sj * splatSize + si) * 4;
          sand += splat[t];
          scrub += splat[t + 1];
          rock += splat[t + 2];
          n++;
        }
      }
      const inv = 1 / (255 * Math.max(1, n));
      sand *= inv;
      scrub *= inv;
      rock *= inv;
      const x = rect.minX + ((i + 0.5) / size) * rect.sizeX;
      const z = rect.minZ + ((j + 0.5) / size) * rect.sizeZ;
      const submerged = 1 - clamp01((field.height(x, z) - field.seaLevel + 0.5) / 1.5);
      const t = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) {
        const land = LAYER_ALBEDO.sand[c] * sand + LAYER_ALBEDO.scrub[c] * scrub + LAYER_ALBEDO.rock[c] * rock;
        const mixed = land * (1 - submerged) + LAYER_ALBEDO.sea[c] * submerged;
        data[t + c] = Math.round(linearToSrgb(mixed) * 255);
      }
      data[t + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'terrain.groundAlbedo';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * GROUND TRANSITIONS. "Nothing in 183 reference frames meets the ground with a
 * clean seam" — LOOK_SPEC §4.4. LEVEL's colliders tell us where its buildings,
 * walls, barriers and crates actually stand; around each one we raise a
 * transition weight in `splat.a`, which the shader turns into drifted grit,
 * spalled material and a contact darkening that widens the junction from a line
 * into a band.
 *
 * Read through `LevelService.collectColliders()` in `afterBoot`, which is the
 * only point at which LEVEL is guaranteed built.
 */
export function paintGroundTransitions(maps: TerrainMaps, colliders: readonly StaticColliderDef[], field: TerrainField): void {
  const { size, rect, splatData } = maps;
  const texel = rect.sizeX / size;
  const pos = new THREE.Vector3();
  let painted = 0;

  for (const def of colliders) {
    pos.setFromMatrixPosition(def.matrix);
    const shape = def.shape;
    let radius: number;
    let halfHeight: number;
    if (shape.kind === 'box') {
      radius = Math.hypot(shape.half.x, shape.half.z);
      halfHeight = shape.half.y;
    } else if (shape.kind === 'sphere') {
      radius = shape.radius;
      halfHeight = shape.radius;
    } else if (shape.kind === 'capsule' || shape.kind === 'cylinder') {
      radius = shape.radius;
      halfHeight = shape.halfHeight + (shape.kind === 'capsule' ? shape.radius : 0);
    } else {
      continue;
    }
    if (radius > 40 || radius < 0.25) continue;
    const ground = field.height(pos.x, pos.z);
    // Only things that actually SIT on the ground get a transition. A parapet
    // four storeys up gets one from the roof it stands on, not from the terrain.
    if (pos.y - halfHeight > ground + 1.6 || pos.y + halfHeight < ground - 1.0) continue;

    const band = Math.min(1.6, 0.45 + radius * 0.28);
    const outer = radius + band;
    const i0 = Math.max(0, Math.floor((pos.x - outer - rect.minX) / texel));
    const i1 = Math.min(size - 1, Math.ceil((pos.x + outer - rect.minX) / texel));
    const j0 = Math.max(0, Math.floor((pos.z - outer - rect.minZ) / texel));
    const j1 = Math.min(size - 1, Math.ceil((pos.z + outer - rect.minZ) / texel));
    for (let j = j0; j <= j1; j++) {
      const z = rect.minZ + (j + 0.5) * texel;
      for (let i = i0; i <= i1; i++) {
        const x = rect.minX + (i + 0.5) * texel;
        const d = Math.hypot(x - pos.x, z - pos.z);
        if (d > outer) continue;
        // Peaks just outside the footprint and dies over the band — material
        // drifts against a wall, it does not pile up underneath it.
        const v = Math.round(255 * (1 - smoothstep(radius * 0.55, outer, d)));
        const t = (j * size + i) * 4 + 3;
        if (v > splatData[t]) splatData[t] = v;
        painted++;
      }
    }
  }

  if (painted > 0) maps.splatMap.needsUpdate = true;
}
