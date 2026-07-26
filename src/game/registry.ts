/**
 * GAME — the controlled-actor table.
 *
 * OWNER: GAME.
 *
 * Dense array + index map, and iteration is ALWAYS over the array. Iterating a
 * `Map` keyed by object identity is banned in gameplay code (architecture §9.2)
 * and this is the file where that rule would otherwise get broken twice a day:
 * intent dispatch, movement, damage, capture occupancy and the telemetry pass
 * all walk this list, and every one of them must see the same order on every
 * run or the PNGs stop being comparable.
 *
 * Removal splices rather than swap-pops, for the same reason `ComponentStore`
 * does: a bot dying must not reorder the bots behind it.
 */
import type { EntityId } from '@/engine/types';
import type { GameActor } from '@/game/locomotion';

export class ActorTable {
  private readonly list: GameActor[] = [];
  private readonly index = new Map<number, GameActor>();
  private readonly ids: EntityId[] = [];
  /** Monotonic, never reused: the stable integer key attach order is drawn from. */
  private nextSlot = 0;

  get actors(): readonly GameActor[] {
    return this.list;
  }

  /** Attach order, which is exactly `PlayerService.controlled`. */
  get entities(): readonly EntityId[] {
    return this.ids;
  }

  get size(): number {
    return this.list.length;
  }

  get(entity: EntityId): GameActor | undefined {
    return this.index.get(entity as number);
  }

  claimSlot(): number {
    return this.nextSlot++;
  }

  add(actor: GameActor): void {
    if (this.index.has(actor.entity as number)) return;
    this.index.set(actor.entity as number, actor);
    this.list.push(actor);
    this.ids.push(actor.entity);
  }

  remove(entity: EntityId): GameActor | undefined {
    const actor = this.index.get(entity as number);
    if (!actor) return undefined;
    this.index.delete(entity as number);
    const i = this.list.indexOf(actor);
    if (i >= 0) {
      this.list.splice(i, 1);
      this.ids.splice(i, 1);
    }
    return actor;
  }

  clear(): void {
    this.list.length = 0;
    this.ids.length = 0;
    this.index.clear();
    this.nextSlot = 0;
  }
}
