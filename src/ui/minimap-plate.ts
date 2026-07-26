/**
 * The minimap surface, baked once on the CPU. OWNER: HUD.
 *
 * `docs/HUD_SPEC.md` §6.7 describes the plate as "an orthographic top-down
 * render of HARBOUR REACH, heavily desaturated". A real ortho render would need
 * a second camera, a render target and a pass ordering negotiation with RCORE
 * for something that never changes — the map is static. So it is rasterised once
 * into a `DataTexture` from two sources both already on the contract: the frozen
 * `MACRO_TERRAIN` silhouette (land/water/relief) and `LevelService.
 * collectColliders()` (building footprints). Nothing here reads another lane's
 * files.
 *
 * THE ADAPTATION THAT MATTERS. HARBOUR REACH is warm ochre and the plate is
 * deliberately NOT: §6.7 requires it to stay cool and desaturated, because that
 * desaturation is what makes the cyan/salmon team colours pop off it. Tinting
 * the map to "match the world" is the single change that would make the whole
 * bottom-left corner read as decoration rather than as an instrument.
 *
 * NO FRAME, NO BORDER, NO RADIUS, NO SHADOW — that is the widget's job (§6.7)
 * and it is the fastest way to make a HUD look like a mod menu.
 */
import * as THREE from 'three';
import { MACRO_TERRAIN } from '@/engine/macro';
import { CollisionGroup, type Rng, type StaticColliderDef, type Vec3 } from '@/engine/types';

/** Texels on a side. 0.73 m per texel gives ~1:1 against a 255 px widget. */
const SIZE = 768;
/** World square the plate covers, metres. Wide enough for all three points. */
export const PLATE_SPAN = 560;
export const PLATE_CENTRE_X = -40;
export const PLATE_CENTRE_Z = 20;
/** Height sampling grid; bilinearly upsampled. 192² keeps the bake under 40 ms. */
const HEIGHT_GRID = 192;

interface Rgb8 {
  r: number;
  g: number;
  b: number;
}

const SAND: Rgb8 = { r: 0x8a, g: 0x91, b: 0x96 };
const WATER: Rgb8 = { r: 0x4e, g: 0x60, b: 0x68 };
const DEEP: Rgb8 = { r: 0x3a, g: 0x4a, b: 0x54 };
const ROAD: Rgb8 = { r: 0xa2, g: 0xab, b: 0xaf };
const BUILDING: Rgb8 = { r: 0x58, g: 0x5e, b: 0x64 };
const BUILDING_EDGE: Rgb8 = { r: 0x7c, g: 0x85, b: 0x8a };

export interface MinimapPlate {
  readonly texture: THREE.DataTexture;
  /** World → plate uv. */
  uvOf(worldX: number, worldZ: number, out: { u: number; v: number }): void;
}

export function worldToPlateU(worldX: number): number {
  return (worldX - (PLATE_CENTRE_X - PLATE_SPAN * 0.5)) / PLATE_SPAN;
}
export function worldToPlateV(worldZ: number): number {
  return (worldZ - (PLATE_CENTRE_Z - PLATE_SPAN * 0.5)) / PLATE_SPAN;
}

/**
 * Bake the plate. `colliders` may be empty — the null level ships no geometry —
 * and the result is then terrain and roads only, which is still a legible map
 * rather than a blank square.
 */
export function bakeMinimapPlate(colliders: readonly StaticColliderDef[], rng: Rng): MinimapPlate {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const mPerTexel = PLATE_SPAN / SIZE;
  const originX = PLATE_CENTRE_X - PLATE_SPAN * 0.5;
  const originZ = PLATE_CENTRE_Z - PLATE_SPAN * 0.5;

  /* ---- height grid, sampled coarse and interpolated ---------------------- */
  const heights = new Float32Array((HEIGHT_GRID + 1) * (HEIGHT_GRID + 1));
  for (let j = 0; j <= HEIGHT_GRID; j++) {
    for (let i = 0; i <= HEIGHT_GRID; i++) {
      const wx = originX + (i / HEIGHT_GRID) * PLATE_SPAN;
      const wz = originZ + (j / HEIGHT_GRID) * PLATE_SPAN;
      heights[j * (HEIGHT_GRID + 1) + i] = MACRO_TERRAIN.height(wx, wz);
    }
  }
  const heightAt = (fx: number, fy: number): number => {
    const gx = Math.min(HEIGHT_GRID - 1e-4, Math.max(0, fx * HEIGHT_GRID));
    const gy = Math.min(HEIGHT_GRID - 1e-4, Math.max(0, fy * HEIGHT_GRID));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const tx = gx - i;
    const ty = gy - j;
    const s = HEIGHT_GRID + 1;
    const h00 = heights[j * s + i];
    const h10 = heights[j * s + i + 1];
    const h01 = heights[(j + 1) * s + i];
    const h11 = heights[(j + 1) * s + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  };

  const put = (x: number, y: number, c: Rgb8, a = 1): void => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const o = (y * SIZE + x) * 4;
    data[o] = data[o] * (1 - a) + c.r * a;
    data[o + 1] = data[o + 1] * (1 - a) + c.g * a;
    data[o + 2] = data[o + 2] * (1 - a) + c.b * a;
    data[o + 3] = 255;
  };

  /* ---- base: land, water, relief shading -------------------------------- */
  const stream = rng.fork('hud.minimap');
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const fx = (x + 0.5) / SIZE;
      const fy = (y + 0.5) / SIZE;
      const h = heightAt(fx, fy);
      let c: Rgb8;
      if (h <= 0) {
        // Depth ramp: the harbour reads shallower than the open sea, which is
        // what makes the breakwater and the quay legible without a label.
        const t = Math.min(1, -h / 26);
        c = { r: WATER.r + (DEEP.r - WATER.r) * t, g: WATER.g + (DEEP.g - WATER.g) * t, b: WATER.b + (DEEP.b - WATER.b) * t };
      } else {
        // Relief: a north-west hillshade at low amplitude. Enough for the
        // headland and the terrace to separate, not enough to become scenery.
        const e = (heightAt(fx + 1 / SIZE, fy) - heightAt(fx - 1 / SIZE, fy)) / (2 * mPerTexel);
        const n = (heightAt(fx, fy + 1 / SIZE) - heightAt(fx, fy - 1 / SIZE)) / (2 * mPerTexel);
        const shade = Math.max(-0.5, Math.min(0.5, (-e - n) * 1.4));
        const k = 1 + shade * 0.22;
        c = { r: SAND.r * k, g: SAND.g * k, b: SAND.b * k };
      }
      const o = (y * SIZE + x) * 4;
      data[o] = c.r;
      data[o + 1] = c.g;
      data[o + 2] = c.b;
      data[o + 3] = 255;
    }
  }

  /* ---- roads and plazas -------------------------------------------------- */
  // Synthesised from the map's own anchors: the coast road links the market
  // terrace to the quay and on to the headland, with a plaza at each point.
  const A = { x: 78, z: 96 };
  const B = { x: -26, z: 6 };
  const Cp = { x: -212, z: -48 };
  const toTexX = (wx: number): number => (wx - originX) / mPerTexel;
  const toTexY = (wz: number): number => (wz - originZ) / mPerTexel;

  const road = (x0: number, z0: number, x1: number, z1: number, widthM: number): void => {
    const px0 = toTexX(x0);
    const py0 = toTexY(z0);
    const px1 = toTexX(x1);
    const py1 = toTexY(z1);
    const len = Math.hypot(px1 - px0, py1 - py0);
    const half = (widthM / mPerTexel) * 0.5;
    const steps = Math.ceil(len);
    for (let s = 0; s <= steps; s++) {
      const t = s / Math.max(1, steps);
      const cxp = px0 + (px1 - px0) * t;
      const cyp = py0 + (py1 - py0) * t;
      for (let dy = -Math.ceil(half); dy <= Math.ceil(half); dy++) {
        for (let dx = -Math.ceil(half); dx <= Math.ceil(half); dx++) {
          if (dx * dx + dy * dy > half * half) continue;
          const x = Math.round(cxp + dx);
          const y = Math.round(cyp + dy);
          if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
          if (heightAt((x + 0.5) / SIZE, (y + 0.5) / SIZE) <= 0.2) continue;
          put(x, y, ROAD, 0.85);
        }
      }
    }
  };
  road(A.x, A.z, B.x, B.z, 7);
  road(B.x, B.z, Cp.x, Cp.z, 7);
  road(A.x + 40, A.z - 40, A.x - 30, A.z + 50, 5);
  road(B.x + 60, B.z + 40, B.x - 50, B.z - 30, 5);

  const plaza = (wx: number, wz: number, radiusM: number): void => {
    const r = radiusM / mPerTexel;
    const cxp = toTexX(wx);
    const cyp = toTexY(wz);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = Math.round(cxp + dx);
        const y = Math.round(cyp + dy);
        if (heightAt((x + 0.5) / SIZE, (y + 0.5) / SIZE) <= 0.2) continue;
        put(x, y, ROAD, 0.5);
      }
    }
  };
  plaza(A.x, A.z, 26);
  plaza(B.x, B.z, 22);
  plaza(Cp.x, Cp.z, 18);

  /* ---- building footprints from the physics colliders -------------------- */
  const corner = new THREE.Vector3();
  let drawn = 0;
  for (const col of colliders) {
    if (drawn > 900) break;
    if ((col.group & CollisionGroup.StaticGeo) === 0 && (col.group & CollisionGroup.Prop) === 0) continue;
    const s = col.shape;
    if (s.kind === 'box') {
      const half = s.half as Vec3;
      // Footprints below knee height are kerbs and rubble, not buildings.
      if (half.y < 0.9) continue;
      const pts: { x: number; y: number }[] = [];
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        corner.set(half.x * sx, 0, half.z * sz);
        if (s.offset) corner.add(s.offset as THREE.Vector3);
        corner.applyMatrix4(col.matrix as THREE.Matrix4);
        pts.push({ x: toTexX(corner.x), y: toTexY(corner.z) });
      }
      fillPolygon(data, pts, BUILDING, 0.92);
      // A 1px lighter rule along the north edge fakes extrusion (§6.7).
      let top = pts[0];
      for (const p of pts) if (p.y < top.y) top = p;
      for (const p of pts) {
        if (p === top) continue;
        if (Math.abs(p.y - top.y) < Math.abs(p.x - top.x)) {
          strokeSegment(data, top.x, top.y, p.x, p.y, BUILDING_EDGE, 1);
        }
      }
      drawn++;
    } else if (s.kind === 'cylinder' || s.kind === 'sphere' || s.kind === 'capsule') {
      const radius = s.radius;
      if (radius < 0.8) continue;
      corner.set(0, 0, 0);
      if (s.offset) corner.add(s.offset as THREE.Vector3);
      corner.applyMatrix4(col.matrix as THREE.Matrix4);
      const cxp = toTexX(corner.x);
      const cyp = toTexY(corner.z);
      const r = radius / mPerTexel;
      for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
        for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          put(Math.round(cxp + dx), Math.round(cyp + dy), BUILDING, 0.9);
        }
      }
      drawn++;
    }
  }

  /* ---- out-of-bounds hatch and baked grain ------------------------------- */
  const boundsMinX = MACRO_TERRAIN.bounds.minX;
  const boundsMaxX = MACRO_TERRAIN.bounds.maxX;
  const boundsMinZ = MACRO_TERRAIN.bounds.minZ;
  const boundsMaxZ = MACRO_TERRAIN.bounds.maxZ;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const wx = originX + (x + 0.5) * mPerTexel;
      const wz = originZ + (y + 0.5) * mPerTexel;
      const outside = wx < boundsMinX || wx > boundsMaxX || wz < boundsMinZ || wz > boundsMaxZ;
      const o = (y * SIZE + x) * 4;
      if (outside && (x % 3 === 0 || y % 3 === 0) && (x + y) % 6 === 0) {
        data[o] *= 0.75;
        data[o + 1] *= 0.75;
        data[o + 2] *= 0.75;
      }
      // ±3 % luminance grain, 1 texel, static. Its absence is what makes a
      // procedural map plate read as vector art rather than as a render.
      const g = 1 + (stream.next() - 0.5) * 0.06;
      data[o] = Math.max(0, Math.min(255, data[o] * g));
      data[o + 1] = Math.max(0, Math.min(255, data[o + 1] * g));
      data[o + 2] = Math.max(0, Math.min(255, data[o + 2] * g));
      data[o + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'hud.minimap.plate';
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;

  return {
    texture,
    uvOf(worldX, worldZ, out) {
      out.u = worldToPlateU(worldX);
      out.v = worldToPlateV(worldZ);
    },
  };
}

/** Scanline fill of a convex quad in texel space. */
function fillPolygon(data: Uint8Array, pts: readonly { x: number; y: number }[], c: Rgb8, a: number): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(SIZE - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      if (p.y === q.y) continue;
      const tmin = Math.min(p.y, q.y);
      const tmax = Math.max(p.y, q.y);
      if (sy < tmin || sy >= tmax) continue;
      const t = (sy - p.y) / (q.y - p.y);
      const x = p.x + (q.x - p.x) * t;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (lo > hi) continue;
    const x0 = Math.max(0, Math.floor(lo));
    const x1 = Math.min(SIZE - 1, Math.ceil(hi));
    for (let x = x0; x <= x1; x++) {
      const o = (y * SIZE + x) * 4;
      data[o] = data[o] * (1 - a) + c.r * a;
      data[o + 1] = data[o + 1] * (1 - a) + c.g * a;
      data[o + 2] = data[o + 2] * (1 - a) + c.b * a;
    }
  }
}

function strokeSegment(data: Uint8Array, x0: number, y0: number, x1: number, y1: number, c: Rgb8, a: number): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = i / Math.max(1, steps);
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
    const o = (y * SIZE + x) * 4;
    data[o] = data[o] * (1 - a) + c.r * a;
    data[o + 1] = data[o + 1] * (1 - a) + c.g * a;
    data[o + 2] = data[o + 2] * (1 - a) + c.b * a;
  }
}
