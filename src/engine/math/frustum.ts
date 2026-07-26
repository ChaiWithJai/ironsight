/**
 * Frustum extraction and AABB tests. CORE owns this file.
 *
 * `THREE.Frustum` exists, but culling runs over thousands of registered statics
 * every frame and we want a flat Float32Array of planes with no per-test object
 * allocation. Planes are stored as [nx, ny, nz, d] with the convention
 * `dot(n, p) + d >= 0` meaning "inside".
 */
import type * as THREE from 'three';

export const PLANE_COUNT = 6;

/**
 * Gribb/Hartmann extraction straight from a view-projection matrix. The planes
 * come out unnormalised, so we normalise: culling compares against object radii
 * in metres and an unnormalised plane silently scales that distance.
 */
export function extractFrustumPlanes(viewProjection: THREE.Matrix4, out: Float32Array): void {
  const m = viewProjection.elements;
  // three stores column-major: m[col * 4 + row].
  const m00 = m[0], m10 = m[1], m20 = m[2], m30 = m[3];
  const m01 = m[4], m11 = m[5], m21 = m[6], m31 = m[7];
  const m02 = m[8], m12 = m[9], m22 = m[10], m32 = m[11];
  const m03 = m[12], m13 = m[13], m23 = m[14], m33 = m[15];

  const set = (i: number, a: number, b: number, c: number, d: number): void => {
    const inv = 1 / (Math.hypot(a, b, c) || 1);
    out[i * 4 + 0] = a * inv;
    out[i * 4 + 1] = b * inv;
    out[i * 4 + 2] = c * inv;
    out[i * 4 + 3] = d * inv;
  };

  set(0, m30 + m00, m31 + m01, m32 + m02, m33 + m03); // left
  set(1, m30 - m00, m31 - m01, m32 - m02, m33 - m03); // right
  set(2, m30 + m10, m31 + m11, m32 + m12, m33 + m13); // bottom
  set(3, m30 - m10, m31 - m11, m32 - m12, m33 - m13); // top
  set(4, m30 + m20, m31 + m21, m32 + m22, m33 + m23); // near
  set(5, m30 - m20, m31 - m21, m32 - m22, m33 - m23); // far
}

/**
 * Conservative AABB test. Uses the "positive vertex" trick: only the box corner
 * furthest along each plane normal can keep the box inside, so one dot product
 * per plane decides it.
 */
export function frustumIntersectsAabb(
  planes: Float32Array,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): boolean {
  for (let i = 0; i < PLANE_COUNT; i++) {
    const nx = planes[i * 4 + 0];
    const ny = planes[i * 4 + 1];
    const nz = planes[i * 4 + 2];
    const d = planes[i * 4 + 3];
    const px = nx >= 0 ? maxX : minX;
    const py = ny >= 0 ? maxY : minY;
    const pz = nz >= 0 ? maxZ : minZ;
    if (nx * px + ny * py + nz * pz + d < 0) return false;
  }
  return true;
}

export function frustumIntersectsSphere(
  planes: Float32Array,
  x: number, y: number, z: number, radius: number,
): boolean {
  for (let i = 0; i < PLANE_COUNT; i++) {
    if (planes[i * 4 + 0] * x + planes[i * 4 + 1] * y + planes[i * 4 + 2] * z + planes[i * 4 + 3] < -radius) {
      return false;
    }
  }
  return true;
}
