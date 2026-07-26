/**
 * Sector → frustum → software occlusion raster, plus LOD hysteresis.
 * CORE owns this file.
 *
 * WHY A CPU RASTER AND NOT GPU Hi-Z READBACK
 * ------------------------------------------
 * Hi-Z occlusion readback is the fast, fashionable answer and it is REJECTED
 * here on purpose: the result is a frame late, and *how* late depends on GPU
 * timing, so the same shot culls differently on two runs and the PNGs stop
 * matching. Reproducibility is the review loop for this whole project. A
 * 256×144 depth buffer over at most 48 tagged occluders costs ~0.2 ms of JS and
 * gives an answer that is identical on every machine.
 *
 * The raster is deliberately CONSERVATIVE at both ends:
 *  - an occluder is written at the depth of its FURTHEST corner, so it never
 *    claims to occlude more than it does;
 *  - a candidate is tested at the depth of its NEAREST corner, so it is only
 *    rejected when it is unambiguously behind.
 * Both directions err toward drawing something that is hidden, which costs a few
 * microseconds. The opposite error pops geometry out of the frame.
 */
import * as THREE from 'three';
import { RenderStage, type FrameCtx, type RenderSystem } from '@/engine/types';
import type { EngineSceneGraph, StaticEntry } from '@/engine/scenegraph';
import { extractFrustumPlanes, frustumIntersectsAabb, frustumIntersectsSphere } from '@/engine/math/frustum';

const RASTER_W = 256;
const RASTER_H = 144;
const MAX_OCCLUDERS = 48;

/** Corner offsets of a unit AABB, as (dx, dy, dz) selectors. */
const CORNERS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

export class OcclusionRaster {
  /** View-space distance of the nearest known OCCLUDER at each texel. */
  private readonly depth = new Float32Array(RASTER_W * RASTER_H);
  private readonly viewProjection = new THREE.Matrix4();
  private readonly point = new THREE.Vector4();

  /** Screen rect + depth range of the last projected box. */
  private x0 = 0; private y0 = 0; private x1 = 0; private y1 = 0;
  private near = 0; private far = 0;
  private valid = false;

  begin(viewProjection: THREE.Matrix4): void {
    this.viewProjection.copy(viewProjection);
    this.depth.fill(Number.POSITIVE_INFINITY);
  }

  /**
   * Project an AABB to a conservative screen rect and a [near, far] depth range
   * in NDC-w (which is view-space distance for a standard perspective matrix).
   * Returns false when the box straddles or sits behind the near plane, where
   * the perspective divide is meaningless and any answer would be a guess.
   */
  private project(e: StaticEntry): boolean {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let near = Infinity, far = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c = CORNERS[i];
      const x = c[0] ? e.maxX : e.minX;
      const y = c[1] ? e.maxY : e.minY;
      const z = c[2] ? e.maxZ : e.minZ;
      this.point.set(x, y, z, 1).applyMatrix4(this.viewProjection);
      const w = this.point.w;
      if (w <= 1e-4) return false;
      const sx = (this.point.x / w) * 0.5 + 0.5;
      const sy = (this.point.y / w) * 0.5 + 0.5;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      if (w < near) near = w;
      if (w > far) far = w;
    }
    this.x0 = Math.max(0, Math.floor(minX * RASTER_W));
    this.y0 = Math.max(0, Math.floor(minY * RASTER_H));
    this.x1 = Math.min(RASTER_W - 1, Math.ceil(maxX * RASTER_W) - 1);
    this.y1 = Math.min(RASTER_H - 1, Math.ceil(maxY * RASTER_H) - 1);
    this.near = near;
    this.far = far;
    this.valid = this.x1 >= this.x0 && this.y1 >= this.y0;
    return this.valid;
  }

  /**
   * Write an occluder. The rect is SHRUNK by one texel on each side — the
   * screen AABB of a box is an over-estimate of its silhouette, and writing the
   * over-estimate is the one error that makes geometry vanish.
   */
  addOccluder(e: StaticEntry): void {
    if (!this.project(e)) return;
    const x0 = this.x0 + 1;
    const y0 = this.y0 + 1;
    const x1 = this.x1 - 1;
    const y1 = this.y1 - 1;
    if (x1 < x0 || y1 < y0) return;
    const d = this.far; // furthest corner ⇒ never claims more occlusion than it has
    for (let y = y0; y <= y1; y++) {
      const row = y * RASTER_W;
      for (let x = x0; x <= x1; x++) {
        if (d < this.depth[row + x]) this.depth[row + x] = d;
      }
    }
  }

  /** True when every texel the box covers is already owned by a nearer occluder. */
  isOccluded(e: StaticEntry): boolean {
    if (!this.project(e)) return false;
    const d = this.near; // nearest corner ⇒ only reject when unambiguously behind
    for (let y = this.y0; y <= this.y1; y++) {
      const row = y * RASTER_W;
      for (let x = this.x0; x <= this.x1; x++) {
        if (this.depth[row + x] > d) return false;
      }
    }
    return true;
  }
}

/**
 * The culling system. Registered at `RenderStage.Scene`, ahead of submit.
 *
 * LOD HYSTERESIS: switching LOD on a bare distance threshold makes a mesh
 * flicker between levels when the player stands exactly on the boundary and
 * breathes. We keep the current level and require a 12% margin to change it,
 * which is enough that walking speed cannot oscillate it.
 */
export class CullingSystem implements RenderSystem {
  readonly name = 'core.culling';
  readonly stage = RenderStage.Scene;
  readonly order = 10;

  private readonly planes = new Float32Array(24);
  private readonly raster = new OcclusionRaster();
  private readonly occluders: StaticEntry[] = [];

  constructor(private readonly scene: EngineSceneGraph) {}

  update(ctx: FrameCtx): void {
    const cam = ctx.camera;
    const entries = this.scene.entries;
    const stats = this.scene.statsValue;
    stats.visible = 0;
    stats.culledFrustum = 0;
    stats.culledOcclusion = 0;
    stats.culledDistance = 0;

    extractFrustumPlanes(cam.viewProjection as THREE.Matrix4, this.planes);

    const camX = cam.position.x;
    const camY = cam.position.y;
    const camZ = cam.position.z;

    // Pass 1 — frustum + distance. Also collects occluder candidates.
    this.occluders.length = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const dist = Math.hypot(e.cx - camX, e.cy - camY, e.cz - camZ) - e.radius;
      if (dist > e.fadeDistance) {
        e.visible = false;
        stats.culledDistance++;
        continue;
      }
      if (!frustumIntersectsSphere(this.planes, e.cx, e.cy, e.cz, e.radius)) {
        e.visible = false;
        stats.culledFrustum++;
        continue;
      }
      if (!frustumIntersectsAabb(this.planes, e.minX, e.minY, e.minZ, e.maxX, e.maxY, e.maxZ)) {
        e.visible = false;
        stats.culledFrustum++;
        continue;
      }
      e.visible = true;
      if (e.occluder) this.occluders.push(e);
    }

    // Pass 2 — occlusion. Rasterise the nearest, largest occluders only: a
    // distant wall occludes almost nothing and still costs a full rect fill.
    if (this.occluders.length > 0) {
      this.occluders.sort((a, b) => {
        const da = Math.hypot(a.cx - camX, a.cy - camY, a.cz - camZ) / Math.max(a.radius, 0.01);
        const db = Math.hypot(b.cx - camX, b.cy - camY, b.cz - camZ) / Math.max(b.radius, 0.01);
        return da - db;
      });
      this.raster.begin(cam.viewProjection as THREE.Matrix4);
      const n = Math.min(this.occluders.length, MAX_OCCLUDERS);
      for (let i = 0; i < n; i++) this.raster.addOccluder(this.occluders[i]);

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.visible || e.occluder) continue;
        if (this.raster.isOccluded(e)) {
          e.visible = false;
          stats.culledOcclusion++;
        }
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.visible) stats.visible++;
      // three's own frustum culling is left on for unregistered objects, but for
      // registered statics OUR answer is authoritative.
      e.object.visible = e.visible;
    }

    // Pass 3 — dynamics. Frustum ONLY, against bounds read live this frame.
    // They are deliberately outside the sector grid and outside the occlusion
    // raster: both assume a fixed AABB, and a particle system or a ragdoll whose
    // box changed since registration would be culled against a stale one. A
    // dynamic with no bounds is never culled at all — that is the correct answer
    // for anything camera-attached (the viewmodel) or world-spanning.
    const dynamics = this.scene.dynamicEntries;
    for (let i = 0; i < dynamics.length; i++) {
      const d = dynamics[i];
      const b = d.bounds;
      if (b === null) {
        d.visible = true;
      } else {
        d.visible = frustumIntersectsAabb(this.planes, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
        if (!d.visible) stats.culledFrustum++;
      }
      if (d.visible) stats.visible++;
      d.object.visible = d.visible;
    }
  }
}

/** LOD selection with hysteresis. `current` is the caller's cached level. */
export function selectLod(
  screenErrors: readonly number[],
  projectedPixels: number,
  current: number,
): number {
  const HYSTERESIS = 1.12;
  let wanted = screenErrors.length - 1;
  for (let i = 0; i < screenErrors.length; i++) {
    if (projectedPixels >= screenErrors[i]) {
      wanted = i;
      break;
    }
  }
  if (wanted === current) return current;
  // Require a clear margin before moving, in whichever direction we are moving.
  const threshold = screenErrors[Math.min(current, screenErrors.length - 1)];
  if (wanted > current && projectedPixels > threshold / HYSTERESIS) return current;
  if (wanted < current && projectedPixels < threshold * HYSTERESIS) return current;
  return wanted;
}

/** Projected radius in pixels of a sphere at `distance`, for LOD selection. */
export function projectedPixelRadius(radius: number, distance: number, fovRad: number, viewportHeight: number): number {
  if (distance <= 1e-3) return viewportHeight;
  return (radius / distance) * (viewportHeight * 0.5) / Math.tan(fovRad * 0.5);
}
