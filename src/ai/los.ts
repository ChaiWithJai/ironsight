/**
 * Line of sight for perception.
 *
 * OWNER: AI.
 *
 * `PhysicsService.visibility` is the authority and is used whenever PHYS is
 * live. The null physics service answers every ray with "clear", though, and a
 * bot that can see through a building never takes cover, never flanks and never
 * suppresses — i.e. every behaviour this lane exists to produce becomes
 * untestable. So AI keeps its own broadphase over the SAME obstacle boxes the
 * navmesh is stamped from and uses it while physics is null.
 *
 * The grid is a uniform 16 m bucket list walked with a DDA, so a 120 m sight
 * line touches ~8 buckets instead of the whole 4 000-box obstacle set.
 */
import type { Vec3 } from '@/engine/types';
import type { NavObstacle } from '@/ai/navgraph';

const BUCKET = 16;

export class LosGrid {
  private buckets = new Map<number, number[]>();
  private obstacles: readonly NavObstacle[] = [];
  private minX = 0;
  private minZ = 0;
  private nx = 0;
  private nz = 0;

  build(obstacles: readonly NavObstacle[]): void {
    this.obstacles = obstacles;
    this.buckets.clear();
    if (obstacles.length === 0) return;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const o of obstacles) {
      minX = Math.min(minX, o.minX);
      minZ = Math.min(minZ, o.minZ);
      maxX = Math.max(maxX, o.maxX);
      maxZ = Math.max(maxZ, o.maxZ);
    }
    this.minX = Math.floor(minX / BUCKET) * BUCKET;
    this.minZ = Math.floor(minZ / BUCKET) * BUCKET;
    this.nx = Math.max(1, Math.ceil((maxX - this.minX) / BUCKET) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - this.minZ) / BUCKET) + 1);
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const i0 = Math.max(0, Math.floor((o.minX - this.minX) / BUCKET));
      const i1 = Math.min(this.nx - 1, Math.floor((o.maxX - this.minX) / BUCKET));
      const j0 = Math.max(0, Math.floor((o.minZ - this.minZ) / BUCKET));
      const j1 = Math.min(this.nz - 1, Math.floor((o.maxZ - this.minZ) / BUCKET));
      for (let j = j0; j <= j1; j++) {
        for (let k = i0; k <= i1; k++) {
          const key = j * this.nx + k;
          let list = this.buckets.get(key);
          if (!list) {
            list = [];
            this.buckets.set(key, list);
          }
          list.push(i);
        }
      }
    }
  }

  get empty(): boolean {
    return this.obstacles.length === 0;
  }

  /**
   * 1 when the segment is clear, 0 when a box blocks it. Boxes are shrunk by
   * 6 cm so a bot standing hard against a wall can still see PAST its own
   * cover — the classic "AI blinded by the crate it is hiding behind" bug.
   */
  visibility(from: Vec3, to: Vec3): number {
    if (this.obstacles.length === 0) return 1;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / BUCKET) + 1);
    // Walk the segment in bucket-sized steps and test each bucket once.
    let lastKey = -1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = from.x + dx * t;
      const z = from.z + dz * t;
      const i = Math.floor((x - this.minX) / BUCKET);
      const j = Math.floor((z - this.minZ) / BUCKET);
      if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
      const key = j * this.nx + i;
      if (key === lastKey) continue;
      lastKey = key;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const list = this.buckets.get((j + dj) * this.nx + (i + di));
          if (!list) continue;
          for (const index of list) {
            if (segmentHitsBox(from, to, this.obstacles[index], 0.06)) return 0;
          }
        }
      }
    }
    return 1;
  }
}

/** Slab test. `shrink` pulls every face inward so contact cover does not blind. */
export function segmentHitsBox(from: Vec3, to: Vec3, box: NavObstacle, shrink: number): boolean {
  const minX = box.minX + shrink;
  const maxX = box.maxX - shrink;
  const minY = box.minY + shrink;
  const maxY = box.maxY - shrink;
  const minZ = box.minZ + shrink;
  const maxZ = box.maxZ - shrink;
  if (minX > maxX || minY > maxY || minZ > maxZ) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;

  const axis = (origin: number, delta: number, lo: number, hi: number): boolean => {
    if (Math.abs(delta) < 1e-8) return origin >= lo && origin <= hi;
    const inv = 1 / delta;
    let near = (lo - origin) * inv;
    let far = (hi - origin) * inv;
    if (near > far) {
      const tmp = near;
      near = far;
      far = tmp;
    }
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    return t0 <= t1;
  };

  if (!axis(from.x, dx, minX, maxX)) return false;
  if (!axis(from.y, dy, minY, maxY)) return false;
  if (!axis(from.z, dz, minZ, maxZ)) return false;
  return t0 <= t1;
}
