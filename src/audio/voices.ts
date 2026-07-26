/**
 * AUDIO — the voice pool.
 *
 * OWNER: AUDIO. A 24-bot Conquest firefight asks for far more simultaneous
 * sound events than any graph can carry: seven rifles at 800 rpm is 93 events a
 * second before impacts, shells, footsteps and tails. Something has to decide
 * what is not heard, and doing it by "whatever ran out of slots last" produces
 * the failure everyone recognises — the gun you are firing goes silent because
 * a bot 90 m away started a reload.
 *
 * THE RULE, in order:
 *   1. never steal from a HIGHER priority class than the incoming cue
 *   2. within the lowest available class, steal the QUIETEST voice as heard,
 *      not the oldest — a nearly-inaudible tail is free to lose, a 2 m impact
 *      is not
 *   3. ties break on age, oldest first, for determinism
 *   4. a per-cue `maxInstances` cap runs first, so thirty shell bounces can
 *      never crowd out anything at all
 *
 * A stolen voice is FADED, never cut: 12 ms is inaudible as a fade and very
 * audible as a click.
 */
import * as THREE from 'three';
import type { EntityId, SoundHandle, SoundId, SurfaceId } from '@/engine/types';
import type { CueRecipe } from './library';
import { makeSolution, type VoiceSolution } from './spatial';
import type { VoiceChannel } from './graph';

export const STEAL_FADE = 0.012;

export class Voice {
  handle = 0 as SoundHandle;
  id: SoundId = 'ui.select';
  recipe: CueRecipe | null = null;
  variation = 0;
  active = false;
  loop = false;
  /** Model seconds since the cue was triggered, INCLUDING propagation delay. */
  age = 0;
  /** Seconds of propagation delay still to elapse before the cue is audible. */
  pending = 0;
  duration = 0;
  gainDb = 0;
  priority = 0;
  spatial = false;
  model: 'default' | 'gunshot' | 'ui' | 'ambience' = 'default';
  surface: SurfaceId | null = null;
  follow: EntityId | null = null;
  /** Author-supplied occlusion override; NaN means "probe physics". */
  occlusionOverride = Number.NaN;
  /** Latched occlusion, updated on a round robin rather than every frame. */
  occlusion = 0;
  /** Frames until this voice's occlusion is re-probed. */
  occlusionCountdown = 0;
  fadeOut = 0;
  fadeRemaining = 0;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly solution: VoiceSolution = makeSolution();
  channel: VoiceChannel | null = null;
  /** Insertion order; the deterministic tie-break for stealing. */
  serial = 0;

  reset(): void {
    this.active = false;
    this.recipe = null;
    this.channel = null;
    this.follow = null;
    this.surface = null;
    this.loop = false;
    this.age = 0;
    this.pending = 0;
    this.fadeOut = 0;
    this.fadeRemaining = 0;
    this.occlusion = 0;
    this.occlusionOverride = Number.NaN;
  }
}

export class VoicePool {
  private readonly voices: Voice[] = [];
  private capacity: number;
  private nextHandle = 1;
  private nextSerial = 1;
  /** Live count per cue, for the `maxInstances` cap. */
  private readonly perCue = new Map<SoundId, number>();
  steals = 0;
  rejections = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) this.voices.push(new Voice());
  }

  get all(): readonly Voice[] {
    return this.voices;
  }

  get liveCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  get max(): number {
    return this.capacity;
  }

  /** Tier changes resize the pool. Growing is free; shrinking retires the tail. */
  resize(capacity: number, onRetire: (v: Voice) => void): void {
    if (capacity === this.capacity) return;
    while (this.voices.length < capacity) this.voices.push(new Voice());
    while (this.voices.length > capacity) {
      const v = this.voices.pop();
      if (v && v.active) {
        onRetire(v);
        this.release(v);
      }
    }
    this.capacity = capacity;
  }

  find(handle: SoundHandle): Voice | null {
    for (const v of this.voices) if (v.active && v.handle === handle) return v;
    return null;
  }

  /**
   * Claim a slot for `recipe`. Returns null when the cue loses outright — which
   * is a legitimate outcome and must NOT be treated as an error by callers.
   */
  acquire(id: SoundId, recipe: CueRecipe, onSteal: (v: Voice) => void): Voice | null {
    const live = this.perCue.get(id) ?? 0;
    if (live >= recipe.maxInstances) {
      // The cap is per cue, so steal from OUR OWN quietest instance rather than
      // rejecting: the newest shot is the one the player just caused.
      const mine = this.quietestOf((v) => v.id === id);
      if (!mine) {
        this.rejections++;
        return null;
      }
      onSteal(mine);
      this.steals++;
      this.release(mine);
      return this.take(id, recipe);
    }

    for (const v of this.voices) if (!v.active) return this.take(id, recipe);

    // Full. Look for a victim at a strictly lower priority class.
    const victim = this.quietestOf((v) => v.priority < recipe.priority);
    if (!victim) {
      this.rejections++;
      return null;
    }
    onSteal(victim);
    this.steals++;
    this.release(victim);
    return this.take(id, recipe);
  }

  private quietestOf(pred: (v: Voice) => boolean): Voice | null {
    let best: Voice | null = null;
    for (const v of this.voices) {
      if (!v.active || !pred(v)) continue;
      // Loops are the last thing to steal: an ambience bed cutting out is far
      // more noticeable than one more impact going missing.
      const score = v.solution.levelDb - v.priority * 6 + (v.loop ? 40 : 0);
      const bestScore = best ? best.solution.levelDb - best.priority * 6 + (best.loop ? 40 : 0) : Infinity;
      if (best === null || score < bestScore || (score === bestScore && v.serial < best.serial)) best = v;
    }
    return best;
  }

  private take(id: SoundId, recipe: CueRecipe): Voice {
    for (const v of this.voices) {
      if (v.active) continue;
      v.reset();
      v.active = true;
      v.id = id;
      v.recipe = recipe;
      v.priority = recipe.priority;
      v.handle = this.nextHandle++ as SoundHandle;
      v.serial = this.nextSerial++;
      this.perCue.set(id, (this.perCue.get(id) ?? 0) + 1);
      return v;
    }
    // Unreachable: every path into take() has already guaranteed a free slot.
    const v = this.voices[0];
    v.reset();
    v.active = true;
    v.id = id;
    v.recipe = recipe;
    v.handle = this.nextHandle++ as SoundHandle;
    return v;
  }

  release(v: Voice): void {
    if (!v.active) return;
    const n = (this.perCue.get(v.id) ?? 1) - 1;
    if (n <= 0) this.perCue.delete(v.id);
    else this.perCue.set(v.id, n);
    v.reset();
  }

  releaseAll(onRetire: (v: Voice) => void): void {
    for (const v of this.voices) {
      if (!v.active) continue;
      onRetire(v);
      v.reset();
    }
    this.perCue.clear();
    this.steals = 0;
    this.rejections = 0;
    // Handles are NOT rewound: a stale SoundHandle from before a harness reset
    // must fail to resolve rather than alias a fresh voice.
    this.nextSerial = 1;
  }
}
