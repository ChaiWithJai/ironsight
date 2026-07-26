/**
 * The cover graph AI fights out of.
 *
 * OWNER: AI.
 *
 * LEVEL owns `cover-bake.ts` and publishes `LevelService.coverSlots` +
 * `findCover`. WHEN THAT EXISTS IT WINS — this file is the fallback that keeps
 * combat behaviour honest before it does, derived from the same obstacle boxes
 * the navmesh is stamped from. Nothing here is a stand-in for missing
 * behaviour: it is a second SOURCE of the same data type, chosen at runtime by
 * whether LEVEL published any, and the switchover is one branch in `CoverBook`.
 *
 * A slot is a standing or crouching position hard against a face, offset by the
 * agent radius, on walkable ground, facing the direction it protects AGAINST.
 * Corner slots score higher than mid-face slots because a corner lets a bot
 * lean out, shoot and come back without crossing the open ground behind it.
 */
import * as THREE from 'three';
import { NULL_ENTITY, type CoverSlot, type LevelService, type Vec3 } from '@/engine/types';
import type { NavAgent, NavGraph, NavObstacle } from '@/ai/navgraph';

const SLOT_SPACING = 1.7;
const MAX_DERIVED_SLOTS = 1400;
/** Anything shorter than this is a kerb, anything taller is a building face. */
const MIN_COVER_HEIGHT = 0.55;

interface Bucket {
  readonly slots: number[];
}

export class CoverBook {
  private slots: CoverSlot[] = [];
  private buckets = new Map<number, Bucket>();
  private bucketSize = 12;
  private level: LevelService | null = null;
  /** True while we are serving slots we derived ourselves. */
  derived = false;

  get all(): readonly CoverSlot[] {
    return this.level && this.level.coverSlots.length > 0 ? this.level.coverSlots : this.slots;
  }

  get count(): number {
    return this.all.length;
  }

  /**
   * Rebuild from whatever is available. Called at boot and again whenever
   * destruction invalidates a region — a wall that fell is cover that lied.
   */
  rebuild(level: LevelService, obstacles: readonly NavObstacle[], graph: NavGraph, agent: NavAgent): void {
    this.level = level;
    this.slots = [];
    this.buckets.clear();
    this.derived = level.coverSlots.length === 0;
    if (!this.derived) {
      this.index(level.coverSlots);
      return;
    }

    const probe = new THREE.Vector3();
    const landed = new THREE.Vector3();
    for (const o of obstacles) {
      if (this.slots.length >= MAX_DERIVED_SLOTS) break;
      const spanX = o.maxX - o.minX;
      const spanZ = o.maxZ - o.minZ;
      // Ignore both pebbles and whole districts: a 60 m box is a massing block
      // whose interior faces are useless, and a 0.3 m box is not cover.
      if (spanX < 0.6 || spanZ < 0.6 || spanX > 40 || spanZ > 40) continue;
      const cx = (o.minX + o.maxX) * 0.5;
      const cz = (o.minZ + o.maxZ) * 0.5;
      const off = agent.radius + 0.22;

      for (let side = 0; side < 4; side++) {
        const alongX = side === 0 || side === 2;
        const length = alongX ? spanX : spanZ;
        const steps = Math.max(1, Math.floor(length / SLOT_SPACING));
        for (let s = 0; s < steps; s++) {
          const t = (s + 0.5) / steps;
          let x: number;
          let z: number;
          if (alongX) {
            x = o.minX + spanX * t;
            z = side === 0 ? o.minZ - off : o.maxZ + off;
          } else {
            z = o.minZ + spanZ * t;
            x = side === 1 ? o.minX - off : o.maxX + off;
          }
          probe.set(x, 0, z);
          if (!graph.sample(probe, 1.2, landed)) continue;
          const ground = landed.y;
          const exposed = o.maxY - ground;
          if (exposed < MIN_COVER_HEIGHT) continue;
          // How close to a corner, 0 at mid-face and 1 at the very end.
          const corner = Math.abs(t - 0.5) * 2;
          const stance = exposed >= 1.45 ? 'stand' : 'crouch';
          const facing = new THREE.Vector3(cx - landed.x, 0, cz - landed.z);
          if (facing.lengthSq() < 1e-6) continue;
          facing.normalize();
          this.slots.push({
            position: landed.clone(),
            facing,
            stance,
            // Tall cover you can stand behind and shoot around a corner of is
            // the best thing on the map; a low mid-face slot is the worst.
            quality: Math.min(1, 0.34 + Math.min(exposed, 2.2) * 0.2 + corner * 0.28),
            owner: NULL_ENTITY,
          });
          if (this.slots.length >= MAX_DERIVED_SLOTS) break;
        }
      }
    }
    this.index(this.slots);
  }

  private index(slots: readonly CoverSlot[]): void {
    this.buckets.clear();
    for (let i = 0; i < slots.length; i++) {
      const key = this.key(slots[i].position.x, slots[i].position.z);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = { slots: [] };
        this.buckets.set(key, bucket);
      }
      bucket.slots.push(i);
    }
  }

  private key(x: number, z: number): number {
    const i = Math.floor(x / this.bucketSize);
    const j = Math.floor(z / this.bucketSize);
    // Interleave-free hash with a wide stride: the map is 800 m, the bucket
    // 12 m, so j never collides with i inside the playable envelope.
    return (j + 4096) * 8192 + (i + 4096);
  }

  /**
   * Best slot near `position` that protects from `threat`, ignoring anything
   * already claimed. Deterministic: ties break on slot index, and the bucket
   * scan order is derived from integers, never from Map insertion order.
   */
  find(
    position: Vec3,
    threat: Vec3,
    maxRange: number,
    claimed: (slot: number) => boolean,
    outIndex: { value: number },
  ): CoverSlot | null {
    const source = this.all;
    if (source.length === 0) return null;
    if (this.level && !this.derived) {
      // LEVEL owns the query as well as the data once it has published slots.
      const slot = this.level.findCover(position, threat, maxRange);
      outIndex.value = -1;
      return slot;
    }
    const tx = threat.x - position.x;
    const tz = threat.z - position.z;
    const tlen = Math.hypot(tx, tz) || 1;
    const dirX = tx / tlen;
    const dirZ = tz / tlen;

    let best: CoverSlot | null = null;
    let bestScore = -Infinity;
    let bestIndex = -1;
    const range = Math.ceil(maxRange / this.bucketSize);
    const bi = Math.floor(position.x / this.bucketSize);
    const bj = Math.floor(position.z / this.bucketSize);
    for (let j = bj - range; j <= bj + range; j++) {
      for (let i = bi - range; i <= bi + range; i++) {
        const bucket = this.buckets.get((j + 4096) * 8192 + (i + 4096));
        if (!bucket) continue;
        for (const index of bucket.slots) {
          if (claimed(index)) continue;
          const slot = source[index];
          const dx = slot.position.x - position.x;
          const dz = slot.position.z - position.z;
          const dist = Math.hypot(dx, dz);
          if (dist > maxRange) continue;
          // The slot must face the threat: `facing` is the direction it
          // protects against, so a dot product near 1 is cover between the bot
          // and the shooter, and a negative one is cover behind his back.
          const align = slot.facing.x * dirX + slot.facing.z * dirZ;
          if (align < 0.15) continue;
          const score = align * 2.2 + slot.quality * 1.6 - dist / Math.max(4, maxRange) * 2.4;
          if (score > bestScore) {
            bestScore = score;
            best = slot;
            bestIndex = index;
          }
        }
      }
    }
    outIndex.value = bestIndex;
    return best;
  }
}
