/**
 * Punctual light pool + per-frame culling into the forward shader's light block.
 *
 * OWNER: LIGHT.
 *
 * These are NOT `THREE.PointLight`s. Adding a real three light changes
 * `NUM_POINT_LIGHTS`, which invalidates every program in the scene — a
 * guaranteed compile hitch every single time a bot pulls a trigger. They live in
 * the shared uniform block instead (`shading.ts`), so a muzzle flash costs a
 * float write and nothing else.
 *
 * DEVIATION, STATED PLAINLY: `docs/ARCHITECTURE.md` pass 8 specifies a 16×8×24
 * cluster grid written to an index/data texture pair. What is implemented is the
 * CPU half of that — frustum + radius culling and a relevance sort down to the
 * 16 lights the forward loop iterates — without the froxel index texture. At 16
 * lights the per-fragment loop with its squared-distance early-out is cheaper
 * than the cluster fetch that would replace it, and the visible result is
 * identical. The grid becomes worth building when the light count goes past
 * roughly 64, which is a VFX-density decision, not a lighting one.
 */
import * as THREE from 'three';
import type { Color, FrameCtx, LightHandle, LocalLight, Vec3 } from '@/engine/types';
import { LightType } from '@/engine/types';
import { IRON_MAX_LOCAL_LIGHTS, V_LIGHT_BASE, V_MISC, shadingUniforms } from '@/render/lighting/shading';

interface PoolEntry {
  light: LocalLight;
  /** Seconds left for a `flash()`; Infinity for a persistent light. */
  life: number;
  /** Sort key: how much this light can possibly matter this frame. */
  score: number;
}

/** Flashes we are willing to hold at once before the dimmest is dropped. */
const FLASH_POOL = 24;

export class LocalLightPool {
  private readonly entries = new Map<number, PoolEntry>();
  private readonly order: PoolEntry[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private nextHandle = 1;
  private flashes = 0;

  activeCount = 0;

  get maxLights(): number {
    return IRON_MAX_LOCAL_LIGHTS;
  }

  add(light: LocalLight): LightHandle {
    const handle = this.nextHandle++;
    this.entries.set(handle, { light: { ...light, position: light.position.clone() }, life: Infinity, score: 0 });
    return handle as LightHandle;
  }

  update(handle: LightHandle, patch: Partial<LocalLight>): void {
    const entry = this.entries.get(handle as number);
    if (!entry) return;
    if (patch.position) entry.light.position.copy(patch.position);
    if (patch.color) entry.light.color.copy(patch.color);
    if (patch.direction) entry.light.direction = patch.direction.clone();
    if (patch.intensityCd !== undefined) entry.light.intensityCd = patch.intensityCd;
    if (patch.radius !== undefined) entry.light.radius = patch.radius;
    if (patch.innerConeCos !== undefined) entry.light.innerConeCos = patch.innerConeCos;
    if (patch.outerConeCos !== undefined) entry.light.outerConeCos = patch.outerConeCos;
    if (patch.volumetric !== undefined) entry.light.volumetric = patch.volumetric;
  }

  remove(handle: LightHandle): void {
    const entry = this.entries.get(handle as number);
    if (entry && entry.life !== Infinity) this.flashes--;
    this.entries.delete(handle as number);
  }

  /**
   * Pooled, auto-expiring world flash. Safe to call from every shot of every
   * bot: when the pool saturates the dimmest resident is evicted rather than the
   * newest being dropped, so the flash you just fired is always the one that
   * survives.
   */
  flash(position: Readonly<Vec3>, colour: Readonly<Color>, intensityCd: number, radius: number, seconds: number): void {
    if (this.flashes >= FLASH_POOL) {
      let weakest: number | null = null;
      let weakestScore = Infinity;
      for (const [handle, entry] of this.entries) {
        if (entry.life === Infinity) continue;
        const s = entry.light.intensityCd * entry.life;
        if (s < weakestScore) {
          weakestScore = s;
          weakest = handle;
        }
      }
      if (weakest !== null) {
        this.entries.delete(weakest);
        this.flashes--;
      }
    }
    const handle = this.nextHandle++;
    this.entries.set(handle, {
      light: {
        type: LightType.Point,
        position: position.clone(),
        color: colour.clone(),
        intensityCd,
        radius,
        volumetric: true,
      },
      life: seconds,
      score: 0,
    });
    this.flashes++;
  }

  clear(): void {
    this.entries.clear();
    this.order.length = 0;
    this.flashes = 0;
    this.activeCount = 0;
    shadingUniforms().vectors[V_MISC * 4] = 0;
  }

  /**
   * Age the pool, cull to the view frustum, sort by relevance and publish the
   * survivors. Everything here is deterministic: the sort key is derived from
   * geometry and intensity only, never from insertion order or wall clock.
   */
  tick(ctx: FrameCtx): void {
    const u = shadingUniforms();
    const dt = ctx.dt;
    for (const [handle, entry] of this.entries) {
      if (entry.life === Infinity) continue;
      entry.life -= dt;
      if (entry.life <= 0) {
        this.entries.delete(handle);
        this.flashes--;
      }
    }

    const camera = ctx.camera.world;
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    const eye = camera.position;

    this.order.length = 0;
    for (const entry of this.entries.values()) {
      const light = entry.light;
      if (light.intensityCd <= 0 || light.radius <= 0) continue;
      this.sphere.center.copy(light.position);
      this.sphere.radius = light.radius;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      // Relevance: the illuminance this light can deliver at the eye. A distant
      // fire loses to a near muzzle flash, which is the ordering a player reads.
      const d2 = Math.max(this.sphere.center.distanceToSquared(eye), 0.25);
      entry.score = light.intensityCd / d2;
      this.order.push(entry);
    }
    this.order.sort((a, b) => b.score - a.score);

    const count = Math.min(this.order.length, IRON_MAX_LOCAL_LIGHTS);
    this.activeCount = count;
    for (let i = 0; i < count; i++) {
      const light = this.order[i].light;
      const base = (V_LIGHT_BASE + i * 3) * 4;
      u.vectors[base] = light.position.x;
      u.vectors[base + 1] = light.position.y;
      u.vectors[base + 2] = light.position.z;
      u.vectors[base + 3] = light.radius;
      // Candela straight into the shader: the sun is in lux, `I/d²` is lux, so
      // the two are on one photometric scale and a flash can be checked against
      // LOOK_SPEC §2.7's table by reading a pixel.
      u.vectors[base + 4] = light.color.r * light.intensityCd;
      u.vectors[base + 5] = light.color.g * light.intensityCd;
      u.vectors[base + 6] = light.color.b * light.intensityCd;
      if (light.type === LightType.Spot && light.direction) {
        const outer = light.outerConeCos ?? 0.7;
        const inner = light.innerConeCos ?? Math.min(outer + 0.08, 0.999);
        u.vectors[base + 7] = 1 / Math.max(inner - outer, 1e-3);
        u.vectors[base + 8] = light.direction.x;
        u.vectors[base + 9] = light.direction.y;
        u.vectors[base + 10] = light.direction.z;
        u.vectors[base + 11] = outer;
      } else {
        // Negative invRange is the "this is a point light" flag; it saves a
        // fourth vec4 per light and therefore a quarter of the uniform block.
        u.vectors[base + 7] = -1;
        u.vectors[base + 8] = 0;
        u.vectors[base + 9] = 1;
        u.vectors[base + 10] = 0;
        u.vectors[base + 11] = -1;
      }
    }
    u.vectors[V_MISC * 4] = count;
  }
}
