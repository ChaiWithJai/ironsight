/**
 * Worker entry point. OWNER: BAKE.
 *
 * Deliberately trivial: it dispatches into the SAME `JOBS` table the inline
 * fallback uses, so a job cannot behave differently on a worker than on the main
 * thread. Anything clever belongs in `jobs.ts` where both paths see it.
 */
import { JOBS } from '@/bake/workers/jobs';
import type { WorkerRequest, WorkerResponse } from '@/bake/workers/protocol';

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const { id, job, payload } = event.data;
  const fn = JOBS[job];
  if (!fn) {
    const response: WorkerResponse = { id, ok: false, error: `unknown bake job "${job}"` };
    (self as unknown as Worker).postMessage(response);
    return;
  }
  try {
    const out = fn(payload as never);
    const response: WorkerResponse = { id, ok: true, result: out.value, transfer: out.transfer };
    (self as unknown as Worker).postMessage(response, out.transfer ?? []);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
