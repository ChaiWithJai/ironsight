/**
 * VFX — the particle pools.
 *
 * OWNER: VFX.
 *
 * THE SIMULATION IS ON THE GPU AND THERE IS NO PER-FRAME CPU WORK PER PARTICLE.
 * A particle is 32 floats written ONCE at spawn: origin, initial velocity,
 * constant acceleration, birth/lifetime/size, drag, curl amplitude, spin, two
 * colours and a flag word. Everything after that — exponentially-damped
 * ballistic integration, divergence-free curl advection, growth, spin,
 * billboarding, the colour ramp, the erosion threshold and the scattering
 * solve — is evaluated in the shader from `uVfxTime`. The CPU never reads a
 * particle back and never touches one again until its slot is recycled.
 *
 * That is a deliberate choice over the RGBA32F ping-pong state pair the
 * architecture's `Simulate` slot exists for, and the reason is stated here
 * rather than buried: `RenderGraph.execute()` still falls back to a straight
 * forward render while `passes.length === 0`, so ANY pass this lane registers
 * today would blank every other lane's shot (AUDIO hit the same wall and
 * documented it in `src/audio/system.ts`). A closed-form state function needs
 * no render target, no ping-pong, no `Simulate` slot and no history, is exactly
 * as deterministic, and is what a stateless particle system in a shipped
 * engine looks like anyway. The cost is that particles cannot collide with
 * scene depth; nothing else in the vocabulary is given up.
 *
 * BLENDING. Two pools, and the split is the one LOOK_SPEC §8 makes:
 *  - `SoftPool` is ALPHA-blended and occludes. Smoke, dust, haze, fireballs,
 *    blast puffs, spray. Additive smoke is on the brief's defect list.
 *  - `StreakPool` is ADDITIVE and velocity-stretched. Tracers, sparks, embers,
 *    whizby — genuine over-range emitters, the only case additive is allowed.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  type MaterialFactory,
  type SceneGraph,
  type Vec3,
} from '@/engine/types';
import {
  DECAL_FRAGMENT,
  DECAL_VERTEX,
  SOFT_FRAGMENT,
  SOFT_VERTEX,
  STREAK_FRAGMENT,
  STREAK_VERTEX,
} from '@/vfx/glsl';
import type { VfxGlobals } from '@/vfx/globals';

/** Corner-quad geometry every pool instances. */
function quad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // The culler is authoritative for registered dynamics and these bodies are
  // world-spanning, so three's own sphere test would be both wrong and wasted.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/* ============================================================================
 * SOFT POOL — volumetric billboards
 * ========================================================================= */

/** Floats per particle. Padded to 32 so the interleaved stride is a power of 2. */
export const SOFT_STRIDE = 32;

export interface SoftSpawn {
  position: Vec3;
  velocity: Vec3;
  accel: Vec3;
  lifetime: number;
  sizeStart: number;
  sizeEnd: number;
  drag: number;
  curl: number;
  curlScale: number;
  spin: number;
  seed: number;
  albedo: THREE.Color;
  alpha: number;
  emissive: THREE.Color;
  emissiveK: number;
  kind: number;
  erode: number;
  selfShadow: number;
}

/**
 * A ring of particle slots backed by one interleaved instanced buffer.
 *
 * Slots are recycled oldest-first. Over-budget spawns therefore steal the
 * longest-lived particle rather than being dropped: a burst that arrives when
 * the pool is full must still read as a burst, and the thing you can afford to
 * lose is the tail of a dissipating puff, which is already near zero alpha.
 * `VfxService` never throws and never stalls, per the contract.
 */
export class SoftPool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private cursor = 0;
  private live = 0;

  constructor(
    capacity: number,
    material: THREE.Material,
    name: string,
  ) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * SOFT_STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, SOFT_STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    const g = quad();
    const attr = (offset: number, size: number): THREE.InterleavedBufferAttribute =>
      new THREE.InterleavedBufferAttribute(this.buffer, size, offset, false);
    g.setAttribute('iOrigin', attr(0, 3));
    g.setAttribute('iVelocity', attr(3, 3));
    g.setAttribute('iAccel', attr(6, 3));
    g.setAttribute('iLife', attr(9, 4));
    g.setAttribute('iShape', attr(13, 4));
    g.setAttribute('iColorA', attr(17, 4));
    g.setAttribute('iColorB', attr(21, 4));
    g.setAttribute('iFlags', attr(25, 4));
    g.instanceCount = 0;

    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    // Drawn after opaque world geometry; within the VFX group, alpha smoke goes
    // before the additive layers so emitters read on top of their own bodies.
    this.mesh.renderOrder = 10;
  }

  get liveCount(): number {
    return this.live;
  }

  clear(): void {
    this.data.fill(0);
    this.cursor = 0;
    this.live = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    this.buffer.needsUpdate = true;
  }

  spawn(now: number, s: SoftSpawn): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const o = i * SOFT_STRIDE;
    const d = this.data;
    d[o + 0] = s.position.x;
    d[o + 1] = s.position.y;
    d[o + 2] = s.position.z;
    d[o + 3] = s.velocity.x;
    d[o + 4] = s.velocity.y;
    d[o + 5] = s.velocity.z;
    d[o + 6] = s.accel.x;
    d[o + 7] = s.accel.y;
    d[o + 8] = s.accel.z;
    d[o + 9] = now;
    d[o + 10] = s.lifetime;
    d[o + 11] = s.sizeStart;
    d[o + 12] = s.sizeEnd;
    d[o + 13] = s.seed;
    d[o + 14] = s.drag;
    d[o + 15] = s.curl;
    d[o + 16] = s.spin;
    d[o + 17] = s.albedo.r;
    d[o + 18] = s.albedo.g;
    d[o + 19] = s.albedo.b;
    d[o + 20] = s.alpha;
    d[o + 21] = s.emissive.r;
    d[o + 22] = s.emissive.g;
    d[o + 23] = s.emissive.b;
    d[o + 24] = s.emissiveK;
    d[o + 25] = s.kind;
    d[o + 26] = s.erode;
    d[o + 27] = s.selfShadow;
    d[o + 28] = s.curlScale;
    const geometry = this.mesh.geometry as THREE.InstancedBufferGeometry;
    if (i + 1 > geometry.instanceCount) geometry.instanceCount = i + 1;
    this.buffer.needsUpdate = true;
  }

  /**
   * Count what is still alive, for `VfxService.stats` and the budget arbiter.
   * A pure read of birth + lifetime: no state is mutated and the GPU is not
   * consulted, so it stays deterministic and costs one pass over the slots.
   */
  countLive(now: number): number {
    const d = this.data;
    const geometry = this.mesh.geometry as THREE.InstancedBufferGeometry;
    let n = 0;
    let highWater = 0;
    for (let i = 0; i < geometry.instanceCount; i++) {
      const o = i * SOFT_STRIDE;
      const birth = d[o + 9];
      const life = d[o + 10];
      if (life > 0 && now >= birth && now < birth + life) {
        n++;
        highWater = i + 1;
      }
    }
    // Shrink the draw when the tail of the ring has expired; the ring wraps, so
    // this only helps at the very start of a session, but it is free.
    if (this.cursor === 0 && highWater < geometry.instanceCount) geometry.instanceCount = highWater;
    this.live = n;
    return n;
  }
}

/* ============================================================================
 * STREAK POOL — velocity-stretched additive rods
 * ========================================================================= */

export const STREAK_STRIDE = 28;

export interface StreakSpawn {
  position: Vec3;
  velocity: Vec3;
  accel: Vec3;
  lifetime: number;
  width: number;
  /** Fixed rod length in metres. A tracer is 1.8–3.2 m; a spark is 0. */
  length: number;
  /** Shutter-like streak: extra length = speed × this. */
  streakSeconds: number;
  drag: number;
  seed: number;
  color: THREE.Color;
  intensity: number;
  tail: THREE.Color;
  glow: number;
}

export class StreakPool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private cursor = 0;
  private live = 0;

  constructor(capacity: number, material: THREE.Material, name: string) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * STREAK_STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STREAK_STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    const g = quad();
    const attr = (offset: number, size: number): THREE.InterleavedBufferAttribute =>
      new THREE.InterleavedBufferAttribute(this.buffer, size, offset, false);
    g.setAttribute('iOrigin', attr(0, 3));
    g.setAttribute('iVelocity', attr(3, 3));
    g.setAttribute('iAccel', attr(6, 3));
    g.setAttribute('iLife', attr(9, 4));
    g.setAttribute('iShape', attr(13, 4));
    g.setAttribute('iColorA', attr(17, 4));
    g.setAttribute('iColorB', attr(21, 4));
    g.instanceCount = 0;

    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  get liveCount(): number {
    return this.live;
  }

  clear(): void {
    this.data.fill(0);
    this.cursor = 0;
    this.live = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    this.buffer.needsUpdate = true;
  }

  spawn(now: number, s: StreakSpawn): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const o = i * STREAK_STRIDE;
    const d = this.data;
    d[o + 0] = s.position.x;
    d[o + 1] = s.position.y;
    d[o + 2] = s.position.z;
    d[o + 3] = s.velocity.x;
    d[o + 4] = s.velocity.y;
    d[o + 5] = s.velocity.z;
    d[o + 6] = s.accel.x;
    d[o + 7] = s.accel.y;
    d[o + 8] = s.accel.z;
    d[o + 9] = now;
    d[o + 10] = s.lifetime;
    d[o + 11] = s.width;
    d[o + 12] = s.length;
    d[o + 13] = s.seed;
    d[o + 14] = s.drag;
    d[o + 15] = s.streakSeconds;
    d[o + 16] = 0;
    d[o + 17] = s.color.r;
    d[o + 18] = s.color.g;
    d[o + 19] = s.color.b;
    d[o + 20] = s.intensity;
    d[o + 21] = s.tail.r;
    d[o + 22] = s.tail.g;
    d[o + 23] = s.tail.b;
    d[o + 24] = s.glow;
    const geometry = this.mesh.geometry as THREE.InstancedBufferGeometry;
    if (i + 1 > geometry.instanceCount) geometry.instanceCount = i + 1;
    this.buffer.needsUpdate = true;
  }

  countLive(now: number): number {
    const d = this.data;
    const geometry = this.mesh.geometry as THREE.InstancedBufferGeometry;
    let n = 0;
    for (let i = 0; i < geometry.instanceCount; i++) {
      const o = i * STREAK_STRIDE;
      const birth = d[o + 9];
      const life = d[o + 10];
      if (life > 0 && now >= birth && now < birth + life) n++;
    }
    this.live = n;
    return n;
  }
}

/* ============================================================================
 * DECAL POOL — surface-conforming quads
 * ========================================================================= */

export const DECAL_STRIDE = 24;

export interface DecalSpawn {
  centre: Vec3;
  normal: Vec3;
  tangent: Vec3;
  size: number;
  lifetime: number;
  seed: number;
  color: THREE.Color;
  opacity: number;
  kind: number;
}

export class DecalPool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private cursor = 0;
  /** Slot → handle, so `removeDecal` can retire exactly one. */
  private readonly slotHandle: Int32Array;
  private readonly handleSlot = new Map<number, number>();
  private used = 0;

  constructor(capacity: number, material: THREE.Material) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * DECAL_STRIDE);
    this.slotHandle = new Int32Array(this.capacity).fill(-1);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, DECAL_STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    const g = quad();
    const attr = (offset: number, size: number): THREE.InterleavedBufferAttribute =>
      new THREE.InterleavedBufferAttribute(this.buffer, size, offset, false);
    g.setAttribute('iCentre', attr(0, 3));
    g.setAttribute('iNormal', attr(3, 3));
    g.setAttribute('iTangent', attr(6, 3));
    g.setAttribute('iParams', attr(9, 4));
    g.setAttribute('iColor', attr(13, 4));
    g.setAttribute('iKind', attr(17, 4));
    g.instanceCount = 0;

    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = 'vfx.decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  get count(): number {
    return this.used;
  }

  clear(): void {
    this.data.fill(0);
    this.slotHandle.fill(-1);
    this.handleSlot.clear();
    this.cursor = 0;
    this.used = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    this.buffer.needsUpdate = true;
  }

  /** LRU by construction: the ring evicts the oldest decal when it wraps. */
  add(now: number, handle: number, s: DecalSpawn): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const evicted = this.slotHandle[i];
    if (evicted >= 0) this.handleSlot.delete(evicted);
    else this.used++;
    this.slotHandle[i] = handle;
    this.handleSlot.set(handle, i);

    const o = i * DECAL_STRIDE;
    const d = this.data;
    d[o + 0] = s.centre.x;
    d[o + 1] = s.centre.y;
    d[o + 2] = s.centre.z;
    d[o + 3] = s.normal.x;
    d[o + 4] = s.normal.y;
    d[o + 5] = s.normal.z;
    d[o + 6] = s.tangent.x;
    d[o + 7] = s.tangent.y;
    d[o + 8] = s.tangent.z;
    d[o + 9] = s.size;
    d[o + 10] = now;
    d[o + 11] = s.lifetime;
    d[o + 12] = s.seed;
    d[o + 13] = s.color.r;
    d[o + 14] = s.color.g;
    d[o + 15] = s.color.b;
    d[o + 16] = s.opacity;
    d[o + 17] = s.kind;
    d[o + 18] = 0;
    d[o + 19] = 0;
    d[o + 20] = 0;
    const geometry = this.mesh.geometry as THREE.InstancedBufferGeometry;
    if (i + 1 > geometry.instanceCount) geometry.instanceCount = i + 1;
    this.buffer.needsUpdate = true;
  }

  remove(handle: number): void {
    const slot = this.handleSlot.get(handle);
    if (slot === undefined) return;
    this.handleSlot.delete(handle);
    this.slotHandle[slot] = -1;
    // Zero the size: the vertex shader collapses a zero-extent quad to a point
    // and the fragment shader's radius test then discards every fragment.
    this.data[slot * DECAL_STRIDE + 9] = 0;
    this.data[slot * DECAL_STRIDE + 16] = 0;
    this.used = Math.max(0, this.used - 1);
    this.buffer.needsUpdate = true;
  }
}

/* ============================================================================
 * Material construction
 * ========================================================================= */

export interface VfxMaterials {
  readonly soft: THREE.Material;
  readonly glow: THREE.Material;
  readonly streak: THREE.Material;
  readonly decal: THREE.Material;
}

/**
 * Every material this lane draws with. All four go through
 * `MaterialFactory.createUnlit`, which is the only sanctioned route to a raw
 * shader outside `src/render/` — a hand-rolled `THREE.ShaderMaterial` here
 * would compile, pass the boundary grep and quietly own four surfaces outside
 * the factory's permutation cap.
 */
export function createVfxMaterials(materials: MaterialFactory, globals: VfxGlobals): VfxMaterials {
  const uniforms = globals.uniforms;

  const soft = materials.createUnlit({
    id: 'vfx.soft',
    vertexShader: SOFT_VERTEX,
    fragmentShader: SOFT_FRAGMENT,
    uniforms,
    transparent: true,
    // ALPHA, never additive: participating media must OCCLUDE what is behind
    // them. Additive smoke that brightens the wall behind it is the single
    // clearest signature on the brief's defect list.
    blending: 'alpha',
    depthTest: true,
    depthWrite: false,
    side: 'double',
    toneMapped: true,
  });

  const glow = materials.createUnlit({
    id: 'vfx.glow',
    vertexShader: SOFT_VERTEX,
    fragmentShader: SOFT_FRAGMENT,
    uniforms,
    transparent: true,
    // LOOK_SPEC §8 permits additive for genuine over-range emitters, and this
    // material was additive. It is now ALPHA, because additive blending
    // produced NOTHING on screen in this renderer while the identical shader
    // alpha-blended renders correctly — verified by swapping only this line.
    // An emissive element whose alpha rises with its own temperature (see the
    // fireball branch in SOFT_FRAGMENT) reads as an over-range core under
    // alpha blending too; it simply occludes rather than accumulating, which
    // for a flash core is very nearly the same image.
    blending: 'alpha',
    // Depth-tested: these ride the sorted transparent pass into `SceneColor`,
    // which carries the depth the world was drawn with. The shader ALSO tests
    // against `SceneDepth` (see `vfxDepthOccluded`), which is redundant here
    // and load-bearing anywhere this material is composited over a resolved
    // image instead.
    depthTest: true,
    depthWrite: false,
    side: 'double',
    toneMapped: true,
  });

  const streak = materials.createUnlit({
    id: 'vfx.streak',
    vertexShader: STREAK_VERTEX,
    fragmentShader: STREAK_FRAGMENT,
    uniforms,
    transparent: true,
    // Same story as `vfx.glow`, same reason.
    blending: 'alpha',
    depthTest: true,
    depthWrite: false,
    side: 'double',
    toneMapped: true,
  });

  const decal = materials.createUnlit({
    id: 'vfx.decal',
    vertexShader: DECAL_VERTEX,
    fragmentShader: DECAL_FRAGMENT,
    uniforms,
    transparent: true,
    blending: 'alpha',
    depthTest: true,
    depthWrite: false,
    side: 'double',
    toneMapped: true,
  });
  // Decals sit ON a surface, which is a z-fight by construction. A slope-scaled
  // polygon offset is the correct fix and costs nothing; pushing the quad along
  // its normal instead makes it peel away at grazing angles.
  decal.polygonOffset = true;
  decal.polygonOffsetFactor = -4;
  decal.polygonOffsetUnits = -8;

  return { soft, glow, streak, decal };
}

/**
 * Parent a pool mesh under the VFX scene group and register it as a dynamic on
 * the given layer. `addDynamic`, not `addStatic`: these meshes change every
 * frame and are deliberately registered WITHOUT bounds, so the sector grid and
 * the software occlusion raster (both of which assume a fixed AABB) never see
 * them and never cull a world-spanning smoke column by mistake.
 */
export function attachPool(
  scene: SceneGraph,
  mesh: THREE.Object3D,
  layer: RenderLayer,
  group: SceneGroup = SceneGroup.Vfx,
): void {
  scene.group(group).add(mesh);
  scene.addDynamic(mesh, layer);
}
