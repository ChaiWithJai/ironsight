/**
 * Generational entity ids and dense component storage. CORE owns this file.
 *
 * Deliberately minimal: only GAME, AI, WEAPONS and PHYS use it. Renderers and
 * bakers never touch an entity, so the concept cost is paid by the four lanes
 * that actually benefit from shared per-entity state.
 *
 * ID LAYOUT: index in the low 20 bits (1 048 575 live entities), generation in
 * the high 12. Index 0 is reserved so that `NULL_ENTITY === 0` can never alias a
 * real entity, and a stale handle fails `alive()` rather than silently pointing
 * at whoever recycled the slot.
 *
 * ITERATION ORDER IS STABLE CREATION ORDER. Removal splices rather than
 * swap-popping: swap-remove is O(1) but reorders the dense array, and gameplay
 * that iterates in a different order on the second run of a shot produces a
 * different PNG. Component counts here are in the hundreds, so the splice is
 * free and the determinism is not negotiable.
 */
import {
  NULL_ENTITY,
  type ComponentDef,
  type ComponentStore,
  type EntityId,
  type EntityStore,
} from '@/engine/types';

const INDEX_BITS = 20;
const INDEX_MASK = (1 << INDEX_BITS) - 1;
const GENERATION_MASK = 0xfff;

export function entityIndex(e: EntityId): number {
  return (e as number) & INDEX_MASK;
}

export function entityGeneration(e: EntityId): number {
  return ((e as number) >>> INDEX_BITS) & GENERATION_MASK;
}

function makeId(index: number, generation: number): EntityId {
  return (((generation & GENERATION_MASK) << INDEX_BITS) | (index & INDEX_MASK)) as EntityId;
}

class DenseStore<T> implements ComponentStore<T> {
  readonly dense: T[] = [];
  readonly entities: EntityId[] = [];
  /** entity index → position in `dense`, or -1. Grows with the entity table. */
  private readonly slot: number[] = [];

  constructor(readonly def: ComponentDef<T>) {}

  get size(): number {
    return this.dense.length;
  }

  private at(e: EntityId): number {
    const i = entityIndex(e);
    return i < this.slot.length ? this.slot[i] : -1;
  }

  has(e: EntityId): boolean {
    return this.at(e) >= 0;
  }

  get(e: EntityId): T | undefined {
    const p = this.at(e);
    return p >= 0 ? this.dense[p] : undefined;
  }

  req(e: EntityId): T {
    const p = this.at(e);
    if (p < 0) throw new Error(`component "${this.def.name}" missing on entity ${e as number}`);
    return this.dense[p];
  }

  add(e: EntityId, init?: Partial<T>): T {
    const existing = this.at(e);
    if (existing >= 0) {
      const v = this.dense[existing];
      if (init) Object.assign(v as object, init);
      return v;
    }
    const value = this.def.create();
    if (init) Object.assign(value as object, init);
    const idx = entityIndex(e);
    while (this.slot.length <= idx) this.slot.push(-1);
    this.slot[idx] = this.dense.length;
    this.dense.push(value);
    this.entities.push(e);
    return value;
  }

  remove(e: EntityId): void {
    const p = this.at(e);
    if (p < 0) return;
    this.dense.splice(p, 1);
    this.entities.splice(p, 1);
    this.slot[entityIndex(e)] = -1;
    for (let i = p; i < this.entities.length; i++) {
      this.slot[entityIndex(this.entities[i])] = i;
    }
  }

  /**
   * Safe to mutate components during iteration; unsafe to create or destroy
   * entities. The length is re-read each step so a component added by the
   * callback is visited, which is what callers expect from "creation order".
   */
  each(fn: (value: T, e: EntityId) => void): void {
    for (let i = 0; i < this.dense.length; i++) {
      fn(this.dense[i], this.entities[i]);
    }
  }

  clear(): void {
    this.dense.length = 0;
    this.entities.length = 0;
    this.slot.length = 0;
  }
}

export class EngineEntityStore implements EntityStore {
  localPlayer: EntityId = NULL_ENTITY;

  /** generation[i] is the live generation of slot i; 0 means "never used". */
  private readonly generation: number[] = [0];
  private readonly aliveFlag: boolean[] = [false];
  private readonly archetypes: string[] = [''];
  private readonly freeList: number[] = [];
  private readonly stores = new Map<string, DenseStore<unknown>>();
  private readonly pendingDestroy: EntityId[] = [];
  private liveCount = 0;

  get count(): number {
    return this.liveCount;
  }

  create(archetype = ''): EntityId {
    let index: number;
    if (this.freeList.length > 0) {
      // Shift, not pop: FIFO recycling keeps ids monotonic for longer, which
      // makes rapier's body-insertion order stable across a respawn cycle.
      index = this.freeList.shift() as number;
      this.generation[index] = (this.generation[index] + 1) & GENERATION_MASK;
      if (this.generation[index] === 0) this.generation[index] = 1;
    } else {
      index = this.generation.length;
      this.generation.push(1);
      this.aliveFlag.push(false);
      this.archetypes.push('');
    }
    this.aliveFlag[index] = true;
    this.archetypes[index] = archetype;
    this.liveCount++;
    return makeId(index, this.generation[index]);
  }

  /** Deferred: the entity survives until TickPhase.Cleanup of the current tick. */
  destroy(e: EntityId): void {
    if (!this.alive(e)) return;
    if (this.pendingDestroy.indexOf(e) < 0) this.pendingDestroy.push(e);
  }

  alive(e: EntityId): boolean {
    const i = entityIndex(e);
    if (i <= 0 || i >= this.generation.length) return false;
    return this.aliveFlag[i] && this.generation[i] === entityGeneration(e);
  }

  archetypeOf(e: EntityId): string {
    return this.alive(e) ? this.archetypes[entityIndex(e)] : '';
  }

  store<T>(def: ComponentDef<T>): ComponentStore<T> {
    let s = this.stores.get(def.name);
    if (!s) {
      s = new DenseStore(def) as unknown as DenseStore<unknown>;
      this.stores.set(def.name, s);
    }
    return s as unknown as ComponentStore<T>;
  }

  /**
   * Entities holding every listed component, in creation order. Driven off the
   * SMALLEST store so the scan is proportional to the rarest component, not to
   * the entity count.
   */
  query(defs: readonly ComponentDef<unknown>[], fn: (e: EntityId) => void): void {
    if (defs.length === 0) return;
    let smallest = this.store(defs[0]);
    for (let i = 1; i < defs.length; i++) {
      const s = this.store(defs[i]);
      if (s.size < smallest.size) smallest = s;
    }
    const candidates = smallest.entities;
    outer: for (let i = 0; i < candidates.length; i++) {
      const e = candidates[i];
      for (let d = 0; d < defs.length; d++) {
        if (!this.store(defs[d]).has(e)) continue outer;
      }
      fn(e);
    }
  }

  /** Called from TickPhase.Cleanup. Returns the ids actually reaped this tick. */
  flushDestroyed(): readonly EntityId[] {
    if (this.pendingDestroy.length === 0) return EMPTY_IDS;
    const reaped = this.pendingDestroy.slice();
    for (const e of reaped) {
      if (!this.alive(e)) continue;
      const i = entityIndex(e);
      for (const store of this.stores.values()) store.remove(e);
      this.aliveFlag[i] = false;
      this.archetypes[i] = '';
      this.freeList.push(i);
      this.liveCount--;
      if (this.localPlayer === e) this.localPlayer = NULL_ENTITY;
    }
    this.pendingDestroy.length = 0;
    return reaped;
  }

  /** Harness reset: drop every entity and every component in one go. */
  clear(): void {
    for (const store of this.stores.values()) store.clear();
    this.generation.length = 1;
    this.aliveFlag.length = 1;
    this.archetypes.length = 1;
    this.freeList.length = 0;
    this.pendingDestroy.length = 0;
    this.liveCount = 0;
    this.localPlayer = NULL_ENTITY;
  }
}

const EMPTY_IDS: readonly EntityId[] = [];

export function createEntityStore(): EngineEntityStore {
  return new EngineEntityStore();
}
