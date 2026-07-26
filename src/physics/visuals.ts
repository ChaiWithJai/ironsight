/**
 * The render side of everything PHYS owns: debris chunks, ragdoll segments,
 * character capsules and the proving-ground props. OWNER: PHYS.
 *
 * WHY PHYSICS OWNS ANY MESHES AT ALL. Almost every body in the world is
 * somebody else's mesh — LEVEL's walls, AI's soldiers, VEG's palms — and PHYS
 * only moves them. But three things have no other owner: the debris a wall
 * fractures into (LEVEL authored one wall, not forty shards), the ragdoll
 * segments (AI owns the skinned soldier, not the eleven capsules it becomes),
 * and the proving-ground geometry the physics shots are posed against. Those get
 * their meshes here.
 *
 * EVERY MATERIAL COMES FROM `MaterialFactory.create`. Not one `new
 * THREE.Mesh*Material` — a chunk of sandstone that skipped the uber material
 * would be the one object in the frame with no CSM sampling, no GTAO and no
 * aerial perspective, and it would read as a bug in the lighting rather than as
 * a bug here.
 *
 * REGISTRATION: the whole set is ONE `addDynamic` group with no bounds, i.e.
 * never culled. That is deliberate — debris is created and destroyed constantly
 * and a per-chunk static registration would thrash the sector grid — but it does
 * mean the group must be emptied when it is not in use, which `clear()` does and
 * `resetPhysics` calls.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  RenderLayer,
  SceneGroup,
  SurfaceId,
  type MaterialFactory,
  type SceneGraph,
  type Vec3,
} from '@/engine/types';
import type { BodyRecord } from '@/physics/bodies';

interface Tracked {
  readonly mesh: THREE.Mesh;
  readonly record: BodyRecord;
  /** Offset from the body origin to the mesh centre, in body local space. */
  readonly offset: THREE.Vector3;
}

/**
 * FOUR MATERIALS, AND NOT ONE MORE.
 *
 * `MaterialFactory.permutationCap` is a HARD, SHARED budget — 40 programs at
 * this tier, across sixteen lanes — and `create()` throws past it. A material
 * per `SurfaceId` looked harmless and was not: PHYS alone would have claimed
 * eight of the forty, and the lane that happened to boot last would take the
 * exception. Worse, the throw lands wherever the LAST caller happens to be,
 * which makes it read as that lane's bug.
 *
 * So the render side collapses every surface it draws onto one of four
 * families. PHYSICS still knows the real surface — friction, density, ray hits
 * and footstep cues all use `SurfaceId` unchanged — this is a shading decision
 * only, and four families is the minimum that keeps structure, ground, people
 * and props apart in a frame.
 */
function paletteOf(surface: SurfaceId): SurfaceId {
  switch (surface) {
    case SurfaceId.PaintedMetal:
    case SurfaceId.RustedMetal:
    case SurfaceId.BareMetal:
    case SurfaceId.Grating:
      return SurfaceId.PaintedMetal;
    case SurfaceId.Kevlar:
    case SurfaceId.Flesh:
    case SurfaceId.Fabric:
    case SurfaceId.Tarp:
      return SurfaceId.Kevlar;
    case SurfaceId.Concrete:
    case SurfaceId.Tile:
    case SurfaceId.Cobble:
    case SurfaceId.Gravel:
      return SurfaceId.Concrete;
    default:
      // Masonry and everything that reads like it: sandstone, stucco, plaster,
      // rubble, sandbags, timber at arm's length.
      return SurfaceId.Sandstone;
  }
}

/**
 * The two SHADING numbers `SurfaceProfile` does not carry, plus a base colour,
 * for each of the four families above. Without them a collapse of masonry,
 * timber and steel all reads as the same grey plastic.
 */
function shadingOf(surface: SurfaceId): { roughness: number; metalness: number; color: number } {
  switch (surface) {
    case SurfaceId.Concrete:
      return { roughness: 0.88, metalness: 0, color: 0x8b8478 };
    case SurfaceId.PaintedMetal:
      return { roughness: 0.55, metalness: 0.75, color: 0x9c4a26 };
    case SurfaceId.Kevlar:
      return { roughness: 0.72, metalness: 0.05, color: 0x5b6248 };
    default:
      return { roughness: 0.92, metalness: 0, color: 0x8f7a58 };
  }
}

export class PhysicsVisuals {
  private readonly root = new THREE.Group();
  private readonly materials = new Map<SurfaceId, THREE.Material>();
  private readonly tracked: Tracked[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private registered = false;

  constructor(
    private readonly scene: SceneGraph,
    private readonly factory: MaterialFactory,
  ) {
    this.root.name = 'physics.visuals';
    this.root.matrixAutoUpdate = true;
  }

  /** Parent the group into the scene the first time anything is added. */
  private ensureRegistered(): void {
    if (this.registered) return;
    this.registered = true;
    this.scene.group(SceneGroup.Debris).add(this.root);
    // No bounds: this set is world-spanning and changes every tick, so a fixed
    // AABB would be a lie. See the SceneGraph.addDynamic contract.
    this.scene.addDynamic(this.root, RenderLayer.WorldOpaque);
  }

  materialFor(requested: SurfaceId): THREE.Material {
    const surface = paletteOf(requested);
    const cached = this.materials.get(surface);
    if (cached) return cached;
    const s = shadingOf(surface);
    const material = this.factory.create({
      id: `phys.surface.${surface}`,
      surface,
      layer: 0,
      // DetailNormal + WearMask are inert against a factory that has not baked
      // its detail set yet and become mesoscale break-up the moment it has.
      features: MaterialFeature.DetailNormal | MaterialFeature.WearMask,
      baseColor: s.color,
      roughness: s.roughness,
      metalness: s.metalness,
      detailScale: 3.5,
      wearBias: 0.6,
    });
    this.materials.set(surface, material);
    return material;
  }

  /**
   * Add a mesh whose transform is written by the caller (arena props). The
   * layer mask and frustum flag are set here rather than inherited: three does
   * not propagate layer masks down a tree, and `addDynamic` only traverses at
   * registration time, so anything parented afterwards has to opt in itself.
   */
  addStaticMesh(geometry: THREE.BufferGeometry, surface: SurfaceId, matrix: THREE.Matrix4): THREE.Mesh {
    this.ensureRegistered();
    const mesh = new THREE.Mesh(geometry, this.materialFor(surface));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(RenderLayer.WorldOpaque as number);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.updateMatrixWorld(true);
    this.root.add(mesh);
    this.geometries.push(geometry);
    return mesh;
  }

  /** Add a mesh that follows a rigid body every frame. */
  addBodyMesh(
    record: BodyRecord,
    geometry: THREE.BufferGeometry,
    surface: SurfaceId,
    offset?: Vec3,
  ): THREE.Mesh {
    this.ensureRegistered();
    const mesh = new THREE.Mesh(geometry, this.materialFor(surface));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(RenderLayer.WorldOpaque as number);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    this.geometries.push(geometry);
    this.tracked.push({
      mesh,
      record,
      offset: offset ? new THREE.Vector3(offset.x, offset.y, offset.z) : new THREE.Vector3(),
    });
    this.syncOne(this.tracked[this.tracked.length - 1]);
    return mesh;
  }

  private syncOne(t: Tracked): void {
    if (!t.record.alive) {
      t.mesh.visible = false;
      return;
    }
    const tr = t.record.body.translation();
    const rot = t.record.body.rotation();
    this.tmpQuat.set(rot.x, rot.y, rot.z, rot.w);
    this.tmpPos.copy(t.offset).applyQuaternion(this.tmpQuat);
    this.tmpPos.x += tr.x;
    this.tmpPos.y += tr.y;
    this.tmpPos.z += tr.z;
    t.mesh.visible = true;
    t.mesh.position.copy(this.tmpPos);
    t.mesh.quaternion.copy(this.tmpQuat);
    t.mesh.updateMatrix();
    t.mesh.updateMatrixWorld(true);
  }

  /** Pull every tracked mesh onto its body. Called once per rendered frame. */
  sync(): void {
    for (let i = 0; i < this.tracked.length; i++) this.syncOne(this.tracked[i]);
  }

  /** Drop a single tracked mesh (a chunk that expired). */
  removeBodyMesh(mesh: THREE.Mesh): void {
    const i = this.tracked.findIndex((t) => t.mesh === mesh);
    if (i >= 0) this.tracked.splice(i, 1);
    this.root.remove(mesh);
    mesh.geometry.dispose();
    const g = this.geometries.indexOf(mesh.geometry);
    if (g >= 0) this.geometries.splice(g, 1);
  }

  /**
   * Empty the group. Materials are KEPT: they are deduped by the factory and
   * re-creating them per capture would walk the permutation cap up until
   * `create()` throws.
   */
  clear(): void {
    this.tracked.length = 0;
    for (const child of [...this.root.children]) this.root.remove(child);
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
  }
}
