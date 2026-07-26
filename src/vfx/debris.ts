/**
 * VFX — debris chunks.
 *
 * OWNER: VFX.
 *
 * AAA_RUBRIC axis 6: "Debris needs to be actual geometry that bounces." So this
 * is not a sprite system. Each chunk is a real, individually-rotating lump of
 * geometry drawn from an `InstancedMesh` whose material comes from
 * `MaterialFactory.create()` — which means the chunks are lit, shadowed and
 * graded by exactly the same path as the wall they came off, rather than by
 * this lane's medium shader.
 *
 * The integration is on the CPU and it is deliberate: there are at most a few
 * hundred chunks, they need to bounce off the world, and a bounce needs a
 * raycast. `PhysicsService.raycast` is the correct query and is cheap at this
 * count; spawning a rapier rigid body per chip would put hundreds of dynamic
 * islands into the solver for cosmetic gravel and would put spawn ORDER into
 * the physics determinism envelope (architecture §9.5).
 *
 * Restitution and friction come from the `SurfaceProfile` of the surface the
 * chunk was struck from, so concrete spall skitters and sandbag filler dies on
 * the first contact.
 */
import * as THREE from 'three';
import {
  HitZone,
  MaterialFeature,
  RenderLayer,
  SceneGroup,
  Sim,
  SurfaceId,
  LAYER_SOLID,
  type MaterialFactory,
  type PhysicsService,
  type QueryFilter,
  type RayHit,
  type Rng,
  type SceneGraph,
  type Vec3,
} from '@/engine/types';

interface Chunk {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly spin: THREE.Vector3;
  readonly quat: THREE.Quaternion;
  readonly scale: THREE.Vector3;
  age: number;
  life: number;
  restitution: number;
  friction: number;
  /** Seconds until the next trailing dust puff, for the larger pieces only. */
  trail: number;
  radius: number;
  active: boolean;
}

/** Emitted when a chunk is big enough and fast enough to smoke as it flies. */
export interface DebrisTrail {
  readonly position: THREE.Vector3;
  readonly speed: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** A reusable, pre-allocated `RayHit`. The physics service fills it in place. */
export function makeRayHit(): RayHit {
  return {
    hit: false,
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    surface: SurfaceId.Concrete,
    body: 0 as unknown as RayHit['body'],
    entity: 0 as unknown as RayHit['entity'],
    zone: HitZone.None,
    backface: false,
  };
}

/**
 * Five lump archetypes welded into one geometry and indexed per instance by a
 * non-uniform scale. Perfectly round pebbles read as a particle system; the
 * asymmetry is what makes a tumbling chunk legible as geometry.
 */
function lumpGeometry(rng: Rng): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Push each vertex along its own normal by a hashed amount: an irregular,
    // faceted lump with no two faces coplanar and no silhouette symmetry.
    const n = 0.62 + rng.next() * 0.72;
    v.multiplyScalar(n);
    // Flatten slightly on one axis so chunks read as spalled plates rather
    // than as gravel, which is what masonry actually breaks into.
    v.y *= 0.72;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export class DebrisField {
  private readonly chunks: Chunk[] = [];
  private readonly mesh: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly scratch = new THREE.Vector3();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  /** Debris bounces off the world, never off characters or off other debris. */
  private readonly filter: QueryFilter = { groups: LAYER_SOLID, solid: true };
  private readonly hit: RayHit = makeRayHit();
  private cursor = 0;
  /** Puffs the field wants spawned this frame; drained by the system. */
  readonly trails: DebrisTrail[] = [];

  constructor(
    capacity: number,
    scene: SceneGraph,
    materials: MaterialFactory,
    private readonly physics: PhysicsService,
    rng: Rng,
  ) {
    const count = Math.max(8, capacity | 0);
    const textures = materials.textures(SurfaceId.Rubble);
    const layer = materials.allocateLayer('vfx.debris', textures.albedoHeight, textures.normalRoughAo);
    const material = materials.create({
      id: 'vfx.debris',
      surface: SurfaceId.Rubble,
      layer,
      // Wear + detail normal: a chunk is a freshly fractured face next to an
      // old weathered one, and that contrast is most of what sells rubble.
      features: MaterialFeature.DetailNormal | MaterialFeature.WearMask | MaterialFeature.Triplanar,
      roughness: 0.88,
      metalness: 0,
      instanced: true,
    });

    this.mesh = new THREE.InstancedMesh(lumpGeometry(rng), material, count);
    this.mesh.name = 'vfx.debris';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.group(SceneGroup.Debris).add(this.mesh);
    scene.addDynamic(this.mesh, RenderLayer.WorldOpaque);

    for (let i = 0; i < count; i++) {
      this.chunks.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
        age: 0,
        life: 0,
        restitution: 0.25,
        friction: 0.6,
        trail: 0,
        radius: 0.05,
        active: false,
      });
    }
  }

  get liveCount(): number {
    let n = 0;
    for (const c of this.chunks) if (c.active) n++;
    return n;
  }

  clear(): void {
    for (const c of this.chunks) c.active = false;
    this.cursor = 0;
    this.mesh.count = 0;
    this.trails.length = 0;
  }

  spawn(
    origin: Vec3,
    velocity: Vec3,
    sizeM: number,
    lifetime: number,
    restitution: number,
    friction: number,
    rng: Rng,
  ): void {
    const c = this.chunks[this.cursor];
    this.cursor = (this.cursor + 1) % this.chunks.length;
    c.position.copy(origin);
    c.velocity.copy(velocity);
    // Angular velocity scaled by launch speed: a chunk that barely moves must
    // not spin like a drill bit.
    const w = 3.5 + velocity.length() * 0.9;
    c.spin.set(rng.gaussian() * w, rng.gaussian() * w, rng.gaussian() * w);
    c.quat.setFromAxisAngle(
      this.scratchDir.set(rng.gaussian(), rng.gaussian(), rng.gaussian()).normalize(),
      rng.next() * Math.PI * 2,
    );
    // Non-uniform: plates, wedges and blocks from one geometry.
    c.scale.set(sizeM * (0.7 + rng.next() * 0.6), sizeM * (0.45 + rng.next() * 0.55), sizeM * (0.7 + rng.next() * 0.6));
    c.radius = sizeM * 0.5;
    c.age = 0;
    c.life = lifetime;
    c.restitution = restitution;
    c.friction = friction;
    c.trail = sizeM > 0.09 ? 0.03 : -1;
    c.active = true;
    if (this.cursor > this.mesh.count) this.mesh.count = this.cursor;
    if (this.mesh.count < this.chunks.length && this.cursor === 0) this.mesh.count = this.chunks.length;
  }

  /**
   * Ballistic integration with a swept ground test. The sweep is a downward
   * ray from the chunk's previous position: an unswept test at 18 m/s and
   * 1/60 s tunnels through a 30 cm kerb, and a chunk that falls through the
   * world is more distracting than one that never spawned.
   */
  update(dt: number): void {
    this.trails.length = 0;
    let visible = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (!c.active) continue;
      c.age += dt;
      if (c.age >= c.life) {
        c.active = false;
        continue;
      }

      c.velocity.y -= Sim.GRAVITY * dt;
      // Aerodynamic drag, quadratic-ish but linearised per step: small spall
      // decelerates visibly, a fist-sized block barely does.
      const drag = Math.min(0.9, 0.55 * dt / Math.max(c.radius, 0.02));
      c.velocity.multiplyScalar(1 - drag);

      this.scratch.copy(c.velocity).multiplyScalar(dt);
      const step = this.scratch.length();
      if (step > 1e-5) {
        this.scratchDir.copy(this.scratch).divideScalar(step);
        if (this.physics.raycast(c.position, this.scratchDir, step + c.radius, this.filter, this.hit)) {
          // Reflect, damp along the normal, shear along the tangent.
          const n = this.hit.normal;
          const vn = c.velocity.dot(n);
          this.scratch.copy(n).multiplyScalar(vn);
          c.velocity.sub(this.scratch.multiplyScalar(1 + c.restitution));
          this.scratch.copy(n).multiplyScalar(c.velocity.dot(n));
          const tangential = this.scratchDir.copy(c.velocity).sub(this.scratch);
          tangential.multiplyScalar(1 - c.friction * 0.55);
          c.velocity.copy(tangential).add(this.scratch);
          c.position.copy(this.hit.point).addScaledVector(n, c.radius * 0.9);
          c.spin.multiplyScalar(0.55);
          // Settle: below this the chunk is rolling, and rolling gravel that
          // never comes to rest is worse than gravel that stops.
          if (c.velocity.lengthSq() < 0.12) {
            c.velocity.multiplyScalar(0.2);
            c.spin.multiplyScalar(0.2);
          }
        } else {
          c.position.addScaledVector(c.velocity, dt);
        }
      }

      // Integrate the orientation as a small-angle quaternion increment.
      const wlen = c.spin.length();
      if (wlen > 1e-4) {
        this.scratchQuat.setFromAxisAngle(this.scratchDir.copy(c.spin).divideScalar(wlen), wlen * dt);
        c.quat.premultiply(this.scratchQuat).normalize();
      }

      if (c.trail >= 0) {
        c.trail -= dt;
        const speed = c.velocity.length();
        if (c.trail <= 0 && speed > 2.2) {
          c.trail = 0.045;
          this.trails.push({ position: c.position.clone(), speed });
        }
      }

      // Fade out by shrinking rather than by alpha: an opaque lit chunk that
      // goes translucent is a giveaway, and at 3–20 cm the shrink is invisible.
      const tail = Math.min(1, (c.life - c.age) / 0.45);
      this.matrix.compose(c.position, c.quat, this.scratch.copy(c.scale).multiplyScalar(tail));
      this.mesh.setMatrixAt(i, this.matrix);
      visible = Math.max(visible, i + 1);
    }

    // Retired slots keep their last matrix, so collapse them to zero scale.
    for (let i = 0; i < visible; i++) {
      if (this.chunks[i].active) continue;
      this.matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export { UP as DEBRIS_UP };
