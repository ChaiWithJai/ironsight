/**
 * WorkerPool — off-main-thread CPU bakes. OWNER: BAKE.
 *
 * THE RULE THAT SHAPES THIS FILE (architecture decision #10): `run()` MUST fall
 * back to inline main-thread execution when `BakeProfile.workerCount` is 0 or
 * worker construction fails. No lane may be BLOCKED on workers existing. Under
 * SwiftShader — i.e. inside the capture harness, i.e. the path that actually
 * sizes the project — `workerCount` is 0 and every job runs inline.
 *
 * Payloads are transferable `ArrayBuffer`s, never `SharedArrayBuffer`: the vite
 * dev server does not send COOP/COEP and the bake must not depend on headers
 * only the capture server happens to set.
 *
 * A four-second mesh bake on the main thread does not merely stutter — it stops
 * the loading screen from repainting, which from outside the tab is
 * indistinguishable from the hang the 300 s capture timeout is watching for.
 * That is what the pool is for.
 */
import { JOBS } from '@/bake/workers/jobs';
import type { WorkerRequest, WorkerResponse } from '@/bake/workers/protocol';
import type { WorkerPool } from '@/engine/types';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: boolean;
}

interface Queued {
  request: WorkerRequest;
  transfer: Transferable[];
  pending: Pending;
}

export class IronWorkerPool implements WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Queued[] = [];
  private nextId = 1;
  private inlineOnly: boolean;

  constructor(requested: number) {
    this.inlineOnly = requested <= 0;
    if (this.inlineOnly) return;
    for (let i = 0; i < requested; i++) {
      try {
        // `new URL(..., import.meta.url)` is the form vite statically analyses;
        // a string path would resolve at runtime and break in the built bundle.
        const worker = new Worker(new URL('./workers/entry.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<WorkerResponse>): void => this.onMessage(i, e.data);
        worker.onerror = (): void => {
          // One dead worker must not deadlock the bake. Retire the slot and let
          // the queue drain through the survivors (or inline, if none are left).
          const slot = this.slots[i];
          if (slot) slot.busy = false;
          this.pump();
        };
        this.slots.push({ worker, busy: false });
      } catch {
        break;
      }
    }
    if (this.slots.length === 0) this.inlineOnly = true;
  }

  get size(): number {
    return this.slots.length;
  }

  async run<TIn, TOut>(job: string, payload: TIn, transfer?: Transferable[]): Promise<TOut> {
    const fn = JOBS[job];
    if (!fn) throw new Error(`WorkerPool: no such bake job "${job}"`);
    if (this.inlineOnly || this.slots.length === 0) {
      const out = fn(payload as never);
      return out.value as TOut;
    }
    const request: WorkerRequest = { id: this.nextId++, job, payload };
    return new Promise<TOut>((resolve, reject) => {
      this.queue.push({
        request,
        transfer: transfer ?? [],
        pending: { resolve: resolve as (v: unknown) => void, reject },
      });
      this.pump();
    });
  }

  /**
   * Saturate the pool with `payloads`. Results come back in INPUT ORDER, not
   * completion order — a bake whose output depends on which worker finished
   * first is a bake that produces a different game on a different machine.
   */
  async map<TIn, TOut>(job: string, payloads: readonly TIn[]): Promise<TOut[]> {
    const results = await Promise.all(payloads.map((p) => this.run<TIn, TOut>(job, p)));
    return results;
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy || this.queue.length === 0) continue;
      const next = this.queue.shift();
      if (!next) return;
      slot.busy = true;
      this.pending.set(next.request.id, next.pending);
      slot.worker.postMessage(next.request, next.transfer);
    }
  }

  private onMessage(slotIndex: number, data: WorkerResponse): void {
    const slot = this.slots[slotIndex];
    if (slot) slot.busy = false;
    const pending = this.pending.get(data.id);
    this.pending.delete(data.id);
    if (pending) {
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error ?? 'bake job failed'));
    }
    this.pump();
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
    this.queue.length = 0;
    this.pending.clear();
  }
}
