/**
 * Worker protocol. OWNER: BAKE.
 *
 * Payloads travel as TRANSFERABLE ArrayBuffers, never `SharedArrayBuffer`: the
 * vite dev server does not set COOP/COEP by default, and the bake must not
 * depend on headers that only the capture server happens to send. A structured
 * clone of a 4 MB typed array costs more than the job saves; a transfer costs
 * nothing and neuters the sender's view, which is exactly the ownership
 * semantics a bake job wants.
 *
 * Every job is a PURE function of its payload. That is what makes the inline
 * fallback (§10 of the architecture: `run()` must execute on the main thread
 * when `workerCount` is 0) a real fallback rather than a second implementation
 * that can drift.
 */

export interface WorkerRequest {
  readonly id: number;
  readonly job: string;
  readonly payload: unknown;
}

export interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  /** Buffers the worker wants transferred back rather than cloned. */
  readonly transfer?: ArrayBuffer[];
}

/** A job returns its value plus any buffers that should move rather than copy. */
export interface JobResult<T> {
  readonly value: T;
  readonly transfer?: ArrayBuffer[];
}

export type JobFn = (payload: never) => JobResult<unknown>;

/* ------------------------------------------------------------------ jobs -- */

export interface Sdf2dRequest {
  /** Coverage, one byte per texel: 0 outside, 255 inside. */
  readonly coverage: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  /** Texels of distance mapped to the full 0..255 output range. */
  readonly spread: number;
}

export interface Sdf2dResponse {
  /** Signed distance, 128 = on the edge, > 128 inside. */
  readonly sdf: ArrayBuffer;
}

export interface BlueNoiseRequest {
  readonly size: number;
  readonly slices: number;
  readonly seed: number;
}

export interface BlueNoiseResponse {
  readonly data: ArrayBuffer;
}

export interface ImpulseRequest {
  readonly sampleRate: number;
  readonly seconds: number;
  /** RT60 per octave band, 125 Hz … 8 kHz. Governs the decay envelope. */
  readonly rt60: readonly number[];
  /** Seconds before the first reflection arrives. Reads as room size. */
  readonly predelay: number;
  /** 0 = anechoic outdoors, 1 = a hard-walled stone room. */
  readonly diffusion: number;
  readonly seed: number;
}

export interface ImpulseResponse {
  readonly left: ArrayBuffer;
  readonly right: ArrayBuffer;
  readonly sampleRate: number;
}

export interface NoiseFieldRequest {
  readonly width: number;
  readonly height: number;
  /** World metres covered by the whole field, for frequency scaling. */
  readonly extent: number;
  readonly octaves: number;
  readonly warp: number;
  readonly seed: number;
}

export interface NoiseFieldResponse {
  readonly data: ArrayBuffer;
}
