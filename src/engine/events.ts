/**
 * The typed, deferred, insertion-ordered event buses. CORE owns this file.
 *
 * `emit` queues; `flush` dispatches in emit order. Re-entrant emits made from
 * inside a handler are appended to the SAME queue and drained in the SAME flush,
 * so global ordering is preserved and a handler can safely cascade (an impact
 * emitting a decal emitting a sound) without a second frame of latency.
 *
 * The topic→payload mapping is compile-time checked: `emit('weapon.fired', x)`
 * only accepts the `weapon.fired` payload shape, and `on()` infers its argument.
 * A typo in a topic name is a type error, not a silently-dropped event.
 *
 * DETERMINISM: handler order is registration order, and the queue is a plain
 * array. Nothing here iterates a Map keyed by object identity.
 */
import type { EventBus, FxBus, FxEmitter, FxEventMap, SimBus, SimEventMap } from '@/engine/types';

interface QueuedEvent {
  type: PropertyKey;
  payload: unknown;
}

type Handler = (payload: never) => void;

export class TypedEventBus<M> implements EventBus<M> {
  private readonly handlers = new Map<PropertyKey, Handler[]>();
  private queue: QueuedEvent[] = [];
  /** Guards against a handler re-entering flush() and shuffling the drain order. */
  private flushing = false;

  constructor(readonly name: string) {}

  get pending(): number {
    return this.queue.length;
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    this.queue.push({ type: type as PropertyKey, payload });
  }

  on<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void {
    const key = type as PropertyKey;
    let list = this.handlers.get(key);
    if (!list) {
      list = [];
      this.handlers.set(key, list);
    }
    list.push(fn as Handler);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.handlers.get(key);
      if (!current) return;
      const i = current.indexOf(fn as Handler);
      if (i >= 0) current.splice(i, 1);
    };
  }

  once<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  /**
   * Drain by cursor rather than by swapping the array, so events emitted during
   * dispatch land after everything already queued and still run this flush.
   */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (let i = 0; i < this.queue.length; i++) {
        const evt = this.queue[i];
        const list = this.handlers.get(evt.type);
        if (!list || list.length === 0) continue;
        // Snapshot: a handler that unsubscribes mid-dispatch must not shift the
        // list under the loop, but a handler subscribed mid-dispatch must not
        // receive the event that caused it either.
        const snapshot = list.slice();
        for (let h = 0; h < snapshot.length; h++) {
          (snapshot[h] as (p: unknown) => void)(evt.payload);
        }
      }
    } finally {
      this.queue.length = 0;
      this.flushing = false;
    }
  }

  clear(): void {
    this.queue.length = 0;
  }

  /** Drop every subscription. Used only when tearing the engine down. */
  clearHandlers(): void {
    this.handlers.clear();
    this.queue.length = 0;
  }
}

export function createSimBus(): SimBus {
  return new TypedEventBus<SimEventMap>('sim');
}

export function createFxBus(): FxBus {
  return new TypedEventBus<FxEventMap>('fx');
}

/**
 * The write-only view handed to simulation code. Presentation events travel one
 * way — simulation emits, VFX/AUDIO/HUD consume — and handing the tick a bus it
 * could subscribe to is exactly how a rendering decision ends up feeding back
 * into gameplay and breaking captures.
 */
export function fxEmitterOf(bus: FxBus): FxEmitter {
  return {
    emit(type, payload) {
      bus.emit(type, payload);
    },
  };
}
