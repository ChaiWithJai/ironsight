/**
 * The ocean grid.
 *
 * OWNER: WATER.
 *
 * A camera-centred RADIAL grid, not a uniform plane. The reason is the only
 * thing that matters about ocean tessellation: a uniform grid dense enough to
 * carry a 7 m chop at 3 m from the eye has 700 000 vertices by the time it
 * reaches the horizon, and a uniform grid coarse enough to reach the horizon
 * cannot carry a wave at all. Radii spaced geometrically hold the projected
 * triangle size roughly constant from 0.4 m to 32 km — 40 cm edges under the
 * camera, kilometre edges at the horizon, 35 000 vertices for the whole sea.
 *
 * The grid is translated to the camera each frame (`system.ts`) and the wave
 * phase is evaluated from WORLD position, so the water stays put while the
 * tessellation follows the eye. The seam at the outer rim is at 32 km, which is far
 * enough past the vanishing line that its polygonal edge lands inside a pixel of
 * it — at 8 km the rim was a visible sawtooth along the horizon.
 *
 * THE CENTRE IS A FAN, NOT A HOLE. A radial grid with an inner radius leaves a
 * disc directly under the camera unfilled; from a boat that disc is exactly
 * where you are looking.
 */
import * as THREE from 'three';

export interface OceanGridSpec {
  readonly rings: number;
  readonly segments: number;
  readonly innerRadius: number;
  readonly outerRadius: number;
}

export const OCEAN_GRID: Readonly<Record<'low' | 'high', OceanGridSpec>> = Object.freeze({
  low: { rings: 96, segments: 128, innerRadius: 0.5, outerRadius: 32000 },
  high: { rings: 168, segments: 224, innerRadius: 0.35, outerRadius: 32000 },
});

/**
 * `position` is the LOCAL radial offset with **y = 0**, and the ring radius rides
 * in `uv.x`.
 *
 * The y = 0 is not cosmetic. This mesh's world position comes from a uniform, not
 * from its model matrix, so any pass that draws it with a material OTHER than
 * ours — RCORE's depth prepass draws `RenderLayer.Water` for depth — sees only
 * the raw attribute. With the radius in `position.y` that pass writes a 32 km
 * CONE into the depth buffer; with y = 0 it writes the still-water plane, which
 * is within a wave height of the truth and harmless.
 */
export function buildOceanGrid(spec: OceanGridSpec): THREE.BufferGeometry {
  const { rings, segments, innerRadius, outerRadius } = spec;
  const vertexCount = 1 + rings * segments;
  const position = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);

  const growth = Math.pow(outerRadius / innerRadius, 1 / (rings - 1));
  const radii = new Float32Array(rings);
  for (let r = 0; r < rings; r++) radii[r] = innerRadius * Math.pow(growth, r);

  // Vertex 0 is the centre of the fan.
  let p = 3;
  let q = 2;
  for (let r = 0; r < rings; r++) {
    const radius = radii[r];
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      position[p] = Math.cos(theta) * radius;
      position[p + 1] = 0;
      position[p + 2] = Math.sin(theta) * radius;
      uv[q] = radius;
      p += 3;
      q += 2;
    }
  }

  const triangles = segments + (rings - 1) * segments * 2;
  const index = new Uint32Array(triangles * 3);
  let t = 0;
  for (let s = 0; s < segments; s++) {
    index[t] = 0;
    index[t + 1] = 1 + s;
    index[t + 2] = 1 + ((s + 1) % segments);
    t += 3;
  }
  for (let r = 0; r < rings - 1; r++) {
    const a = 1 + r * segments;
    const b = 1 + (r + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      index[t] = a + s;
      index[t + 1] = b + s;
      index[t + 2] = b + s1;
      index[t + 3] = a + s;
      index[t + 4] = b + s1;
      index[t + 5] = a + s1;
      t += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // The mesh follows the camera and is displaced in the shader, so any bounding
  // volume three computes here is a lie. Culling is off; this only stops the
  // renderer from computing one.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius * 1.2);
  geometry.name = 'water.oceanGrid';
  return geometry;
}
