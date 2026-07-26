/**
 * GeometrySpec → BufferGeometry, and the BatchedMesh cluster builder.
 * CORE owns this file.
 *
 * `THREE.BatchedMesh` cannot merge geometries with differing vertex layouts,
 * which is exactly why `GeometrySpec` is frozen in the contract: position,
 * normal, tangent, uv, uv1 and an unorm8 colour carrying wear/dirt/AO/variant.
 * Every lane that emits world geometry emits that layout, so LEVEL's walls and
 * VEG's shrubs can share one draw call.
 */
import * as THREE from 'three';
import type { GeometrySpec, Mat4 } from '@/engine/types';

/**
 * Build a BufferGeometry from a spec. Index ranges become draw groups so a
 * single geometry can carry its own LOD chain without a second upload.
 */
export function geometryFromSpec(spec: GeometrySpec): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(spec.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(spec.normal, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(spec.tangent, 4));
  g.setAttribute('uv', new THREE.BufferAttribute(spec.uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(spec.uv1, 2));
  // normalized:true so the shader sees 0..1 floats from unorm8 storage — four
  // bytes per vertex instead of sixteen for wear/dirt/AO/variant.
  g.setAttribute('color', new THREE.BufferAttribute(spec.color, 4, true));
  g.setIndex(new THREE.BufferAttribute(spec.index, 1));

  if (spec.lods.length > 0) {
    for (const lod of spec.lods) g.addGroup(lod.start, lod.count, 0);
  }
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(spec.boundsMin[0], spec.boundsMin[1], spec.boundsMin[2]),
    new THREE.Vector3(spec.boundsMax[0], spec.boundsMax[1], spec.boundsMax[2]),
  );
  g.boundingSphere = new THREE.Sphere();
  g.boundingBox.getBoundingSphere(g.boundingSphere);
  return g;
}

interface Cluster {
  material: THREE.Material;
  items: { geometry: GeometrySpec; matrix: Mat4 }[];
  vertexCount: number;
  indexCount: number;
}

/**
 * Group by material identity and emit one BatchedMesh per cluster.
 *
 * Material identity, not material *id*: two MaterialSpecs that dedupe to the
 * same THREE.Material inside MaterialFactory arrive here as the same object, so
 * the factory's dedupe is what determines the batch count. That is deliberate —
 * batching policy is a consequence of the material permutation cap, not a
 * separate knob for a lane to turn.
 */
export function buildBatches(
  specs: readonly { geometry: GeometrySpec; matrix: Mat4; material: THREE.Material }[],
): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'batch';
  if (specs.length === 0) return root;

  const clusters: Cluster[] = [];
  const index = new Map<THREE.Material, Cluster>();
  for (const s of specs) {
    let c = index.get(s.material);
    if (!c) {
      c = { material: s.material, items: [], vertexCount: 0, indexCount: 0 };
      index.set(s.material, c);
      clusters.push(c);
    }
    c.items.push({ geometry: s.geometry, matrix: s.matrix });
    c.vertexCount += s.geometry.position.length / 3;
    c.indexCount += s.geometry.index.length;
  }

  for (const cluster of clusters) {
    const mesh = new THREE.BatchedMesh(
      cluster.items.length,
      cluster.vertexCount,
      cluster.indexCount,
      cluster.material,
    );
    // Reuse one geometry upload per DISTINCT spec: a street of forty identical
    // window frames should cost one geometry and forty instance matrices.
    const geometryIds = new Map<GeometrySpec, number>();
    for (const item of cluster.items) {
      let geometryId = geometryIds.get(item.geometry);
      if (geometryId === undefined) {
        geometryId = mesh.addGeometry(geometryFromSpec(item.geometry));
        geometryIds.set(item.geometry, geometryId);
      }
      const instanceId = mesh.addInstance(geometryId);
      mesh.setMatrixAt(instanceId, item.matrix);
    }
    mesh.frustumCulled = false; // culling.ts owns visibility for registered statics.
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    root.add(mesh);
  }
  return root;
}

/**
 * Merge a set of specs into ONE geometry with baked-in transforms. Use for
 * static dressing that will never move or be destroyed individually — it beats
 * BatchedMesh because there is no per-instance indirection at all.
 */
export function mergeSpecs(items: readonly { geometry: GeometrySpec; matrix: Mat4 }[]): THREE.BufferGeometry {
  let vtx = 0;
  let idx = 0;
  for (const i of items) {
    vtx += i.geometry.position.length / 3;
    idx += i.geometry.index.length;
  }
  const position = new Float32Array(vtx * 3);
  const normal = new Float32Array(vtx * 3);
  const tangent = new Float32Array(vtx * 4);
  const uv = new Float32Array(vtx * 2);
  const uv1 = new Float32Array(vtx * 2);
  const color = new Uint8Array(vtx * 4);
  const index = new Uint32Array(idx);

  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let vo = 0;
  let io = 0;
  for (const item of items) {
    const g = item.geometry;
    const count = g.position.length / 3;
    normalMatrix.getNormalMatrix(item.matrix);
    for (let v = 0; v < count; v++) {
      p.set(g.position[v * 3], g.position[v * 3 + 1], g.position[v * 3 + 2]).applyMatrix4(item.matrix);
      position[(vo + v) * 3] = p.x;
      position[(vo + v) * 3 + 1] = p.y;
      position[(vo + v) * 3 + 2] = p.z;
      n.set(g.normal[v * 3], g.normal[v * 3 + 1], g.normal[v * 3 + 2]).applyMatrix3(normalMatrix).normalize();
      normal[(vo + v) * 3] = n.x;
      normal[(vo + v) * 3 + 1] = n.y;
      normal[(vo + v) * 3 + 2] = n.z;
      n.set(g.tangent[v * 4], g.tangent[v * 4 + 1], g.tangent[v * 4 + 2]).applyMatrix3(normalMatrix).normalize();
      tangent[(vo + v) * 4] = n.x;
      tangent[(vo + v) * 4 + 1] = n.y;
      tangent[(vo + v) * 4 + 2] = n.z;
      // Handedness is a sign, not a direction: it must survive the transform
      // untouched or every normal map on the merged mesh flips its green channel.
      tangent[(vo + v) * 4 + 3] = g.tangent[v * 4 + 3];
      uv[(vo + v) * 2] = g.uv[v * 2];
      uv[(vo + v) * 2 + 1] = g.uv[v * 2 + 1];
      uv1[(vo + v) * 2] = g.uv1[v * 2];
      uv1[(vo + v) * 2 + 1] = g.uv1[v * 2 + 1];
      color[(vo + v) * 4] = g.color[v * 4];
      color[(vo + v) * 4 + 1] = g.color[v * 4 + 1];
      color[(vo + v) * 4 + 2] = g.color[v * 4 + 2];
      color[(vo + v) * 4 + 3] = g.color[v * 4 + 3];
    }
    for (let i = 0; i < g.index.length; i++) index[io + i] = g.index[i] + vo;
    vo += count;
    io += g.index.length;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('tangent', new THREE.BufferAttribute(tangent, 4));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  out.setAttribute('color', new THREE.BufferAttribute(color, 4, true));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
