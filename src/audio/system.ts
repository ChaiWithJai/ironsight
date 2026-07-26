/**
 * AudioService — IRONSIGHT's mixer, voice pool and spatialiser.
 *
 * OWNER: AUDIO. Entry file: `createAudioService` / `registerAudioBakes` /
 * `resetAudio` keep their names, paths and signatures — `src/bootstrap/
 * subsystems.ts` imports them by name and is frozen.
 *
 * THE ONE RULE THAT BREAKS EVERY SHOT IN THE REPO IF IT IS WRONG: an
 * `AudioContext` cannot start without a user gesture and the capture page never
 * gets one. Every method here is a safe no-op on the WebAudio side while
 * `unlocked` is false, nothing awaits, and nothing throws. What still runs is
 * the JS mixing model in `spatial.ts` — voices, distance, occlusion, sends and
 * bus levels are all computed regardless, so the debug overlay has real numbers
 * to draw and gameplay code sees the same behaviour with or without sound.
 *
 * All synthesis happens at BAKE time (`bakes.ts`) into Float32Arrays. The live
 * context only ever plays those buffers.
 */
import * as THREE from 'three';
import {
  RenderStage,
  SurfaceId,
  type AcousticEnvironment,
  type AssetRegistry,
  type AudioAsset,
  type AudioService,
  type BootContext,
  type EntityId,
  type FrameCtx,
  type PhysicsService,
  type QualitySettings,
  type Rng,
  type Services,
  type SoundEmitDesc,
  type SoundHandle,
  type SoundId,
  type Vec3,
} from '@/engine/types';
import { MACRO_ANCHORS, MACRO_TERRAIN } from '@/engine/macro';
import { audioBakeKeys, declareAudioBakes, type CueBank, type IrBank } from './bakes';
import { AudioGraph } from './graph';
import {
  ENVIRONMENTS,
  LIBRARY,
  ALL_SOUND_IDS,
  footstepVariation,
  type BusName,
  type CueRecipe,
  type EnvName,
} from './library';
import { OcclusionProbe } from './occlusion';
import { audible, buildListener, emptyListener, solve, type ListenerState, type SolveInput } from './spatial';
import { STEAL_FADE, Voice, VoicePool } from './voices';
import { clamp, dbToGain, gainToDb } from './dsp/core';
import { emptySnapshot, type AudioSnapshot, type BusRow, type IrRow, type VoiceRow } from './snapshot';
import { AudioDebugPass, AUDIO_DEBUG_PASS_ID } from './debug/overlay';
import { DebugScenario } from './debug/scenario';

/**
 * The seed `src/shots/audio.ts` passes to `ShotContext.seed()` to arm the debug
 * overlay. ASCII "AUDI".
 *
 * WHY A SEED AND NOT AN IMPORT: boundary CI treats `src/shots/` as its own lane,
 * so a shot file may not import `@/audio/**` — and `ShotContext` exposes no
 * route to a service. `seed(n)` is the one channel that reaches a lane, because
 * the frozen descriptor table calls every `reset<Key>(seed)` with it. This is
 * called out in the lane report as a contract conflict between
 * `docs/ARCHITECTURE.md` §8.1.3 and `tools/check-boundaries.mjs`.
 */
export const AUDIO_DEBUG_SEED = 0x41554449;

/** Bus meter ballistics: 300 ms integration, 20 dB/s peak decay. */
const METER_TAU = 0.3;
const PEAK_DECAY_DB = 20;

interface CueSet {
  readonly assets: readonly AudioAsset[];
}

class IronAudio implements AudioService {
  private readonly ctx: BootContext;
  private readonly rng: Rng;
  private readonly pool: VoicePool;
  private readonly probe: OcclusionProbe;
  private readonly listener: ListenerState = emptyListener();
  private readonly listenerYaw = { deg: 0 };

  private graph: AudioGraph | null = null;
  private unlockedFlag = false;
  private unlockAttempted = false;
  private gestureCleanup: (() => void) | null = null;

  private cues = new Map<SoundId, CueSet>();
  private irs: IrBank | null = null;
  private bakedVariations = 0;

  private env: AcousticEnvironment = ENVIRONMENTS.open;
  private envTarget: AcousticEnvironment = ENVIRONMENTS.open;
  private envBlend = 1;
  private envPrevName: EnvName = 'open';

  private busGainDb: Record<BusName | 'master', number> = {
    master: -3,
    sfx: 0,
    weapons: 0,
    ambience: -4,
    ui: -2,
  };
  private readonly busLevel = new Map<string, { level: number; peak: number; voices: number }>();

  private duckGainDb = 0;
  private duckRemaining = 0;
  private duckDepthDb = 0;
  private deafness = 0;

  private modelTime = 0;
  private frameIndex = 0;
  private lastVariation = new Map<SoundId, number>();

  private ambienceStarted = false;
  private readonly ambienceHandles = new Map<SoundId, SoundHandle>();
  private readonly shorePoint = new THREE.Vector3();
  private gullTimer = 4.7;

  private lastGunWaveform = new Float32Array(192);
  private lastGunLabel = '—';

  private debug: DebugScenario | null = null;
  private overlay: AudioDebugPass | null = null;
  private overlayAdded = false;
  private snapshotCache: AudioSnapshot = emptySnapshot();

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly solveInput: {
    -readonly [K in keyof SolveInput]: SolveInput[K];
  } = {
    listener: this.listener,
    position: null,
    velocity: null,
    recipe: LIBRARY['ui.select'],
    env: ENVIRONMENTS.open,
    gainDb: 0,
    occlusion: 0,
    maxDistance: 0,
    model: 'default',
    deafness: 0,
  };

  constructor(ctx: BootContext) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork('audio');
    this.pool = new VoicePool(ctx.quality.settings.audio.maxVoices);
    this.probe = new OcclusionProbe(() => ctx.services.physics as PhysicsService);

    for (const name of ['sfx', 'weapons', 'ambience', 'ui', 'master'] as const) {
      this.busLevel.set(name, { level: 0, peak: 0, voices: 0 });
    }

    ctx.addRender({
      name: 'audio.update',
      // Sample, AFTER CORE's `core.fxDrain` at order 0 — so a shot fired this
      // tick becomes a voice on the same frame rather than one frame late.
      stage: RenderStage.Sample,
      order: 100,
      update: (frame) => this.update(frame),
    });

    ctx.quality.onChange((settings) => {
      this.pool.resize(settings.audio.maxVoices, (v) => this.retire(v, 0));
    });

    this.subscribeFx();

    ctx.afterBoot((services) => {
      this.collectBakedCues();
      this.overlay = new AudioDebugPass(services, () => this.snapshot());
      // The pass is NOT added here. It is added by `resetAudio` only when the
      // debug seed arms it, because `RenderGraph.execute()` falls back to a
      // straight forward render while `passes.length === 0` — registering an
      // always-on pass would blank every other lane's shot.
    });

    // Opportunistic unlock. Never awaited, never allowed to reject: the capture
    // browser runs with `--autoplay-policy=no-user-gesture-required`, so this
    // usually succeeds there, and where it does not the model runs on anyway.
    this.installGestureUnlock();
    void this.unlock();
  }

  /* ==================================================================== */
  /* Contract surface                                                      */
  /* ==================================================================== */

  get unlocked(): boolean {
    return this.unlockedFlag;
  }

  async unlock(): Promise<void> {
    if (this.unlockedFlag) return;
    try {
      if (!this.graph) {
        const Ctor: typeof AudioContext | undefined =
          typeof AudioContext !== 'undefined' ? AudioContext : undefined;
        if (!Ctor) return;
        // 48 kHz to match the bake; a mismatch would resample every buffer.
        const ac = new Ctor({ latencyHint: 'interactive', sampleRate: 48000 });
        this.graph = new AudioGraph(ac);
        for (const [name, db] of Object.entries(this.busGainDb)) {
          this.graph.setBusGainDb(name as BusName | 'master', db);
        }
        this.applyEnvironmentToGraph(0);
      }
      const ac = this.graph.ctx;
      if (ac.state === 'suspended') await ac.resume();
      this.unlockedFlag = ac.state === 'running';
      if (this.unlockedFlag && this.gestureCleanup) {
        this.gestureCleanup();
        this.gestureCleanup = null;
      }
    } catch {
      // No context, blocked resume, or an engine without WebAudio. The service
      // stays silent and the model keeps running. This must never propagate:
      // an unhandled rejection during boot means `markReady()` never fires.
      this.unlockedFlag = false;
    }
    this.unlockAttempted = true;
  }

  play(id: SoundId, desc?: SoundEmitDesc): SoundHandle {
    const recipe = LIBRARY[id];
    if (!recipe) return 0 as SoundHandle;

    const model = desc?.model ?? (recipe.gunshot ? 'gunshot' : recipe.bus === 'ui' ? 'ui' : 'default');
    const gainDb = desc?.gainDb ?? 0;
    const position = desc?.position ?? null;

    if (position && model !== 'ui') {
      const d = this.tmpA.subVectors(position, this.listener.position).length();
      const max = desc?.maxDistance ?? recipe.maxDistance;
      if (max > 0 && !audible(d, { ...recipe, maxDistance: max }, gainDb)) return 0 as SoundHandle;
    }

    const voice = this.pool.acquire(id, recipe, (victim) => this.retire(victim, STEAL_FADE));
    if (!voice) return 0 as SoundHandle;

    voice.model = model;
    voice.gainDb = gainDb;
    voice.loop = desc?.loop ?? recipe.loop ?? false;
    voice.surface = desc?.surface ?? null;
    voice.follow = desc?.follow ?? null;
    voice.spatial = position !== null && model !== 'ui';
    voice.occlusionOverride = desc?.occlusion ?? Number.NaN;
    voice.occlusion = Number.isNaN(voice.occlusionOverride) ? 0 : voice.occlusionOverride;
    voice.occlusionCountdown = 0;
    if (position) voice.position.copy(position);
    if (desc?.velocity) voice.velocity.copy(desc.velocity);
    else voice.velocity.set(0, 0, 0);

    voice.variation = this.pickVariation(id, recipe, desc);
    const asset = this.assetFor(id, voice.variation);
    voice.duration = asset ? asset.channels[0].length / asset.sampleRate : 0.25;

    // Solve once immediately so the very first frame has correct gains and the
    // propagation delay is known before the buffer is scheduled.
    this.solveVoice(voice);
    voice.pending = voice.solution.delay;
    voice.age = 0;

    if (recipe.gunshot) this.captureGunWaveform(id, asset);
    this.startChannel(voice, asset);
    return voice.handle;
  }

  stop(handle: SoundHandle, fadeSeconds = 0.05): void {
    const v = this.pool.find(handle);
    if (!v) return;
    this.retire(v, Math.max(fadeSeconds, 0));
  }

  setListener(position: Vec3, forward: Vec3, up: Vec3, velocity: Vec3): void {
    buildListener(position, forward, up, velocity, this.listener);
    this.listenerYaw.deg = (Math.atan2(forward.x, -forward.z) * 180) / Math.PI;
  }

  setEnvironment(env: Readonly<AcousticEnvironment>): void {
    if (env.name === this.envTarget.name) return;
    this.envPrevName = this.envTarget.name;
    this.envTarget = env;
    this.envBlend = 0;
    this.applyEnvironmentToGraph(0.7);
  }

  setBusGainDb(bus: 'master' | 'sfx' | 'weapons' | 'ambience' | 'ui', db: number): void {
    this.busGainDb[bus] = db;
    this.graph?.setBusGainDb(bus, db);
  }

  duck(seconds: number, amountDb: number): void {
    this.duckRemaining = Math.max(this.duckRemaining, seconds);
    this.duckDepthDb = Math.min(this.duckDepthDb === 0 ? amountDb : this.duckDepthDb, amountDb);
    // Temporary threshold shift: the world goes dull as well as quiet, and it
    // comes back over about twice the duck length.
    this.deafness = clamp(this.deafness + Math.min(1, -amountDb / 26), 0, 1);
    this.graph?.duckFor(seconds, amountDb);
  }

  get stats(): Readonly<{ voices: number; bufferBytes: number }> {
    return { voices: this.pool.liveCount, bufferBytes: this.graph?.bufferBytes ?? this.pcmBytes() };
  }

  /* ==================================================================== */
  /* Per-frame model                                                       */
  /* ==================================================================== */

  private update(frame: FrameCtx): void {
    const dt = Math.min(frame.dt, 0.1);
    this.modelTime += dt;
    this.frameIndex++;

    if (this.debug) this.debug.update(this, dt, this.modelTime);
    else this.updateAmbience(dt);

    // Environment crossfade, matched to the graph's 0.7 s convolver ramp.
    if (this.envBlend < 1) {
      this.envBlend = Math.min(1, this.envBlend + dt / 0.7);
      this.env = blendEnv(ENVIRONMENTS[this.envPrevName], this.envTarget, this.envBlend);
      if (this.envBlend >= 1) this.env = this.envTarget;
    }

    if (this.duckRemaining > 0) {
      this.duckRemaining -= dt;
      this.duckGainDb = this.duckDepthDb;
      if (this.duckRemaining <= 0) this.duckDepthDb = 0;
    } else if (this.duckGainDb < 0) {
      this.duckGainDb = Math.min(0, this.duckGainDb + (dt / 1.4) * 24);
    }
    if (this.deafness > 0) this.deafness = Math.max(0, this.deafness - dt / 3.5);

    for (const meter of this.busLevel.values()) meter.voices = 0;
    const accum = new Map<string, number>();

    for (const v of this.pool.all) {
      if (!v.active) continue;
      v.age += dt;

      if (v.pending > 0) {
        v.pending = Math.max(0, v.pending - dt);
      }

      if (v.follow !== null) this.trackEntity(v);
      this.updateOcclusion(v, dt);
      this.solveVoice(v);
      this.pushToNodes(v, dt);

      const recipe = v.recipe;
      if (recipe) {
        const meter = this.busLevel.get(recipe.bus);
        if (meter) meter.voices++;
        const power = Math.pow(10, v.solution.levelDb / 10);
        accum.set(recipe.bus, (accum.get(recipe.bus) ?? 0) + power);
        accum.set('master', (accum.get('master') ?? 0) + power);
      }

      if (v.fadeRemaining > 0) {
        v.fadeRemaining -= dt;
        if (v.fadeRemaining <= 0) this.finish(v);
        continue;
      }
      // A one-shot retires when its buffer has played out; the propagation
      // delay counts as part of its life so a 200 m report is not culled
      // before it has been heard.
      if (!v.loop && v.age >= v.solution.delay + v.duration) this.finish(v);
    }

    const k = 1 - Math.exp(-dt / METER_TAU);
    for (const [name, meter] of this.busLevel) {
      const busGain = Math.pow(10, (this.busGainDb[name as BusName | 'master'] ?? 0) / 10);
      const target = (accum.get(name) ?? 0) * busGain;
      meter.level += (target - meter.level) * k;
      const db = 10 * Math.log10(meter.level + 1e-9);
      meter.peak = Math.max(db, meter.peak - PEAK_DECAY_DB * dt);
    }
  }

  private solveVoice(v: Voice): void {
    const recipe = v.recipe;
    if (!recipe) return;
    const input = this.solveInput;
    input.listener = this.listener;
    input.position = v.spatial ? v.position : null;
    input.velocity = v.spatial ? v.velocity : null;
    input.recipe = recipe;
    input.env = this.env;
    input.gainDb = v.gainDb;
    input.occlusion = v.occlusion;
    input.maxDistance = recipe.maxDistance;
    input.model = v.model;
    input.deafness = this.deafness;
    solve(input, v.solution);
  }

  private updateOcclusion(v: Voice, dt: number): void {
    if (!v.spatial || !Number.isNaN(v.occlusionOverride)) return;
    v.occlusionCountdown -= 1;
    if (v.occlusionCountdown <= 0) {
      // 6-frame round robin, phase-offset by the voice serial so the casts are
      // spread evenly across frames instead of spiking on one.
      v.occlusionCountdown = 6;
      const raw = this.probe.probe(this.listener.position, v.position);
      v.occlusion = OcclusionProbe.smooth(v.occlusion, raw, dt * 6);
    } else {
      v.occlusion = OcclusionProbe.smooth(v.occlusion, v.occlusion, dt);
    }
  }

  private trackEntity(v: Voice): void {
    const entity = v.follow;
    if (entity === null) return;
    const player = this.ctx.services.player;
    const state = player.stateOf(entity as EntityId);
    if (state) {
      v.velocity.copy(state.velocity);
      v.position.copy(state.position);
      v.position.y += state.eyeHeight * 0.55;
    }
  }

  /* ==================================================================== */
  /* WebAudio side (no-ops while locked)                                   */
  /* ==================================================================== */

  private startChannel(v: Voice, asset: AudioAsset | null): void {
    const graph = this.graph;
    if (!graph || !this.unlockedFlag || !asset || !v.recipe) return;
    try {
      const buffer = graph.buffer(`${v.id}#${v.variation}`, asset);
      const ch = graph.createChannel(buffer, v.recipe.bus, v.loop);
      v.channel = ch;
      const sol = v.solution;
      const now = graph.ctx.currentTime;
      ch.gain.gain.setValueAtTime(1, now);
      ch.dry.gain.setValueAtTime(sol.dryGain, now);
      ch.er.gain.setValueAtTime(sol.erGain, now);
      ch.tail.gain.setValueAtTime(sol.tailGain, now);
      ch.sub.gain.setValueAtTime(sol.subGain, now);
      ch.lpf.frequency.setValueAtTime(sol.lowpassHz, now);
      ch.shelf.gain.setValueAtTime(sol.shelfDb, now);
      ch.pan.pan.setValueAtTime(sol.pan, now);
      ch.src.playbackRate.setValueAtTime(sol.doppler, now);
      // The propagation delay is scheduled on the source, not simulated by the
      // model, so a 200 m report arrives sample-accurately late.
      ch.src.start(now + sol.delay);
    } catch {
      v.channel = null;
    }
  }

  private pushToNodes(v: Voice, dt: number): void {
    const ch = v.channel;
    const graph = this.graph;
    if (!ch || !graph) return;
    const sol = v.solution;
    const now = graph.ctx.currentTime;
    // One frame of ramp, so a moving source glides instead of zippering.
    const t = now + Math.max(dt, 1 / 120);
    ch.dry.gain.linearRampToValueAtTime(sol.dryGain, t);
    ch.er.gain.linearRampToValueAtTime(sol.erGain, t);
    ch.tail.gain.linearRampToValueAtTime(sol.tailGain, t);
    ch.sub.gain.linearRampToValueAtTime(sol.subGain, t);
    ch.lpf.frequency.linearRampToValueAtTime(sol.lowpassHz, t);
    ch.shelf.gain.linearRampToValueAtTime(sol.shelfDb, t);
    ch.pan.pan.linearRampToValueAtTime(sol.pan, t);
  }

  /** Fade a voice out; `finish` frees the slot once the fade has elapsed. */
  private retire(v: Voice, fade: number): void {
    if (!v.active) return;
    if (fade <= 0) {
      this.finish(v);
      return;
    }
    v.fadeOut = fade;
    v.fadeRemaining = fade;
    const ch = v.channel;
    if (ch && this.graph) {
      const now = this.graph.ctx.currentTime;
      ch.gain.gain.cancelScheduledValues(now);
      ch.gain.gain.setValueAtTime(ch.gain.gain.value, now);
      ch.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
      try {
        ch.src.stop(now + fade + 0.005);
      } catch {
        // Already stopped.
      }
    }
  }

  private finish(v: Voice): void {
    const ch = v.channel;
    if (ch && this.graph) {
      try {
        ch.src.stop();
      } catch {
        // A source that already ended throws; that is the normal path.
      }
      this.graph.disposeChannel(ch);
    }
    for (const [id, handle] of this.ambienceHandles) {
      if (handle === v.handle) this.ambienceHandles.delete(id);
    }
    this.pool.release(v);
  }

  private applyEnvironmentToGraph(seconds: number): void {
    const graph = this.graph;
    const irs = this.irs;
    if (!graph || !irs) return;
    const name = this.envTarget.name;
    const tail = irs.responses[name] ?? irs.responses.open;
    const early = irs.early[name] ?? irs.early.open;
    if (tail && early) graph.setImpulse(early, tail, seconds);
  }

  /* ==================================================================== */
  /* Assets                                                                */
  /* ==================================================================== */

  private collectBakedCues(): void {
    const keys = audioBakeKeys();
    const assets = this.ctx.services.assets;
    this.cues.clear();
    this.bakedVariations = 0;
    for (const key of [keys.weapons, keys.world, keys.ambience, keys.ui]) {
      if (!key) continue;
      const bank = assets.tryGet<CueBank>(key);
      if (!bank) continue;
      for (const id of Object.keys(bank) as SoundId[]) {
        const list = bank[id];
        if (!list || list.length === 0) continue;
        this.cues.set(id, { assets: list });
        this.bakedVariations += list.length;
      }
    }
    if (keys.ir) this.irs = this.ctx.services.assets.tryGet<IrBank>(keys.ir) ?? null;
    this.applyEnvironmentToGraph(0);
  }

  private assetFor(id: SoundId, variation: number): AudioAsset | null {
    const set = this.cues.get(id);
    if (!set || set.assets.length === 0) return null;
    return set.assets[variation % set.assets.length];
  }

  private pickVariation(id: SoundId, recipe: CueRecipe, desc?: SoundEmitDesc): number {
    const set = this.cues.get(id);
    const count = set ? set.assets.length : 1;
    if (count <= 1) return 0;

    if (recipe.surfaceKeyed) {
      const surface = desc?.surface ?? SurfaceId.Sand;
      // `pitch` doubles as the stance channel for footsteps: 0 crouch, 1 walk,
      // 2 run. Documented here because `SoundEmitDesc` has no stance field and
      // adding one would be a contract change for a single cue.
      const stance = clamp(Math.round(desc?.pitch ?? 1), 0, 2) as 0 | 1 | 2;
      const take = this.rng.int(4096);
      return footstepVariation(surface, stance, take) % count;
    }

    if (desc?.seed !== undefined) return Math.abs(desc.seed) % count;

    // Never the same take twice running: the whole point of baking variations.
    const previous = this.lastVariation.get(id) ?? -1;
    let v = this.rng.int(count);
    if (v === previous) v = (v + 1 + this.rng.int(count - 1)) % count;
    this.lastVariation.set(id, v);
    return v;
  }

  private pcmBytes(): number {
    let total = 0;
    for (const set of this.cues.values()) {
      for (const a of set.assets) for (const c of a.channels) total += c.length * 4;
    }
    if (this.irs) {
      for (const name of Object.keys(this.irs.responses) as EnvName[]) {
        total += this.irs.responses[name].left.length * 8;
        total += this.irs.early[name].left.length * 8;
      }
    }
    return total;
  }

  /** Peak envelope of the cue just triggered, for the overlay's waveform panel. */
  private captureGunWaveform(id: SoundId, asset: AudioAsset | null): void {
    if (!asset) return;
    const pcm = asset.channels[0];
    const bins = this.lastGunWaveform.length;
    const per = Math.max(1, Math.floor(pcm.length / bins));
    for (let b = 0; b < bins; b++) {
      let p = 0;
      const start = b * per;
      const end = Math.min(pcm.length, start + per);
      for (let i = start; i < end; i++) {
        const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
        if (a > p) p = a;
      }
      this.lastGunWaveform[b] = p;
    }
    this.lastGunLabel = `${id} · ${(pcm.length / asset.sampleRate).toFixed(3)} s`;
  }

  /* ==================================================================== */
  /* FX bus → cues                                                         */
  /* ==================================================================== */

  private subscribeFx(): void {
    const fx = this.ctx.services.fx;

    fx.on('sound', (e) => {
      const desc: SoundEmitDesc = e.desc ?? {};
      this.play(e.cue, e.position ? { ...desc, position: e.position } : desc);
    });

    fx.on('impact', (e) => {
      this.play(impactCueFor(e.surface), {
        position: e.point,
        // Energy above a nominal 1.2 kJ rifle round reads as louder, below as
        // quieter, at 6 dB per doubling.
        gainDb: clamp(6 * Math.log2(Math.max(e.energyJ, 40) / 1200), -14, 8),
        surface: e.surface,
      });
    });

    fx.on('footstep', (e) => {
      const state = this.ctx.services.player.stateOf(e.entity);
      const stance = state ? (state.stance as 0 | 1 | 2) : 1;
      this.play('p.footstep', {
        position: e.position,
        surface: e.surface,
        // Stance rides in on `pitch`; see `pickVariation`.
        pitch: e.running ? 2 : stance === 1 ? 0 : 1,
        gainDb: e.running ? 3 : 0,
        follow: e.entity,
      });
    });

    fx.on('explosion', (e) => {
      const d = this.tmpB.subVectors(e.point, this.listener.position).length();
      // Close explosions get the full-bodied near cue AND a duck; distant ones
      // only ever produce the far variant, which has no transient to lose.
      if (d < 140) {
        this.play('x.near', { position: e.point, gainDb: clamp(6 * Math.log2(e.radius / 8), -6, 8) });
        if (d < 26) this.duck(0.35, -14 + (d / 26) * 10);
      } else {
        this.play('x.far', { position: e.point });
      }
      this.play('x.debris', { position: e.point, gainDb: -3 });
    });

    fx.on('whizby', (e) => {
      if (e.supersonic) this.play('b.crack', { position: e.point, gainDb: clamp(-e.missDistance * 0.35, -12, 0) });
      this.play('b.whizby', { position: e.point, gainDb: clamp(-e.missDistance * 0.6, -18, 0) });
    });

    fx.on('shellEject', (e) => {
      this.play('w.shell', { position: e.position, velocity: e.velocity });
    });

    fx.on('muzzleFlash', (e) => {
      // WEAPONS may emit an explicit `sound` cue; when it does not, the flash
      // is enough to know a shot happened and which direction it came from.
      void e;
    });

    fx.on('damageTaken', () => {
      this.play('p.hurt', { position: this.listener.position, gainDb: -2 });
    });

    fx.on('hitmarker', (e) => {
      this.play('ui.hit', { gainDb: e.headshot ? 2 : e.lethal ? 1 : 0, model: 'ui' });
    });
  }

  /* ==================================================================== */
  /* Ambience                                                              */
  /* ==================================================================== */

  /**
   * The beds are positioned against `MACRO_TERRAIN`, which every lane shares, so
   * surf comes from the waterline and the halyards come from the quay even
   * before LEVEL exists. They pan and attenuate as the listener moves, which is
   * the "responds to position" half of the requirement; the other half is that
   * the surf emitter tracks the nearest point on a curved shoreline rather than
   * sitting at a fixed anchor.
   */
  private updateAmbience(dt: number): void {
    if (!this.ambienceStarted) {
      this.ambienceStarted = true;
      this.startBed('amb.wind', new THREE.Vector3(0, 40, 0));
      this.startBed('amb.surf', this.nearestShore());
      this.startBed('amb.palms', new THREE.Vector3(MACRO_ANCHORS.alpha.x, MACRO_ANCHORS.alpha.height + 6, MACRO_ANCHORS.alpha.z));
      this.startBed('amb.halyard', new THREE.Vector3(MACRO_ANCHORS.bravo.x, MACRO_ANCHORS.bravo.height + 8, MACRO_ANCHORS.bravo.z));
      this.startBed('amb.distant', new THREE.Vector3(MACRO_ANCHORS.charlie.x * 1.6, 60, MACRO_ANCHORS.charlie.z * 1.6));
    }

    // The wind bed is head-locked; everything else is a world emitter.
    const wind = this.ambienceHandles.get('amb.wind');
    if (wind !== undefined) {
      const v = this.pool.find(wind);
      if (v) v.position.copy(this.listener.position).addScaledVector(this.listener.up, 12);
    }
    const surf = this.ambienceHandles.get('amb.surf');
    if (surf !== undefined) {
      const v = this.pool.find(surf);
      if (v) v.position.lerp(this.nearestShore(), Math.min(1, dt * 0.7));
    }

    this.gullTimer -= dt;
    if (this.gullTimer <= 0) {
      this.gullTimer = 7 + this.rng.range(0, 11);
      const shore = this.nearestShore();
      this.play('amb.gull', {
        position: new THREE.Vector3(
          shore.x + this.rng.range(-70, 70),
          18 + this.rng.range(0, 22),
          shore.z + this.rng.range(-40, 30),
        ),
        gainDb: this.rng.range(-6, 0),
      });
    }
  }

  private startBed(id: SoundId, position: Vec3): void {
    const handle = this.play(id, { position: position.clone(), loop: true, model: 'ambience' });
    if (handle) this.ambienceHandles.set(id, handle);
  }

  /**
   * March north from the listener until `shoreDistance` changes sign. The macro
   * coast is monotonic in Z over the playable envelope, so a 12-step bisection
   * is exact enough for an emitter position and costs nothing.
   */
  private nearestShore(): THREE.Vector3 {
    const x = clamp(this.listener.position.x, MACRO_TERRAIN.bounds.minX, MACRO_TERRAIN.bounds.maxX);
    let lo = -400;
    let hi = 400;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      if (MACRO_TERRAIN.shoreDistance(x, mid) > 0) hi = mid;
      else lo = mid;
    }
    const z = (lo + hi) * 0.5;
    this.shorePoint.set(x, MACRO_TERRAIN.seaLevel + 1.2, z);
    return this.shorePoint;
  }

  /* ==================================================================== */
  /* Harness reset + debug                                                 */
  /* ==================================================================== */

  resetTransient(seed: number): void {
    this.pool.releaseAll((v) => this.finish(v));
    this.ambienceStarted = false;
    this.ambienceHandles.clear();
    this.lastVariation.clear();
    this.modelTime = 0;
    this.frameIndex = 0;
    this.gullTimer = 4.7;
    this.duckGainDb = 0;
    this.duckRemaining = 0;
    this.duckDepthDb = 0;
    this.deafness = 0;
    this.env = ENVIRONMENTS.open;
    this.envTarget = ENVIRONMENTS.open;
    this.envPrevName = 'open';
    this.envBlend = 1;
    for (const meter of this.busLevel.values()) {
      meter.level = 0;
      meter.peak = -90;
      meter.voices = 0;
    }
    this.lastGunWaveform.fill(0);
    this.lastGunLabel = '—';
    this.probe.clearBlockers();
    this.setDebugScene(seed === AUDIO_DEBUG_SEED, seed);
  }

  /**
   * Arm or disarm the debug overlay. Adding the pass here rather than at boot is
   * deliberate — see the note in the constructor's `afterBoot`.
   */
  private setDebugScene(on: boolean, seed: number): void {
    const graph = this.ctx.services.graph;
    if (on) {
      this.debug = new DebugScenario(this.probe, this.rng.fork('audio:debug'), seed);
      this.debug.arm(this);
      if (this.overlay && !this.overlayAdded) {
        graph.addPass(this.overlay);
        this.overlayAdded = true;
      }
    } else {
      this.debug = null;
      if (this.overlayAdded) {
        graph.removePass(AUDIO_DEBUG_PASS_ID);
        this.overlayAdded = false;
      }
    }
  }

  /** Built once per frame the overlay asks for it; never allocated per voice. */
  snapshot(): AudioSnapshot {
    const rows: VoiceRow[] = [];
    for (const v of this.pool.all) {
      if (!v.active || !v.recipe) continue;
      rows.push({
        id: v.id,
        variation: v.variation,
        bus: v.recipe.bus,
        priority: v.priority,
        distance: v.solution.distance,
        levelDb: v.solution.levelDb,
        lowpassHz: v.solution.lowpassHz,
        occlusion: v.occlusion,
        pan: v.solution.pan,
        delay: v.solution.delay,
        pending: v.pending,
        loop: v.loop,
        progress: v.duration > 0 ? clamp((v.age - v.solution.delay) / v.duration, 0, 1) : 0,
        x: v.position.x,
        y: v.position.y,
        z: v.position.z,
      });
    }
    rows.sort((a, b) => b.levelDb - a.levelDb);

    const buses: BusRow[] = [];
    for (const name of ['master', 'weapons', 'sfx', 'ambience', 'ui'] as const) {
      const meter = this.busLevel.get(name);
      buses.push({
        name,
        levelDb: meter ? 10 * Math.log10(meter.level + 1e-9) : -90,
        peakDb: meter ? meter.peak : -90,
        gainDb: this.busGainDb[name],
        voices: meter ? meter.voices : 0,
      });
    }

    const irs: IrRow[] = [];
    if (this.irs) {
      for (const name of Object.keys(this.irs.responses) as EnvName[]) {
        irs.push({
          name,
          rt60: this.irs.responses[name].rt60,
          envelope: this.irs.responses[name].envelope,
          active: name === this.envTarget.name,
        });
      }
    }

    this.snapshotCache = {
      contextState: this.graph ? this.graph.ctx.state : this.unlockAttempted ? 'unavailable' : 'pending',
      unlocked: this.unlockedFlag,
      sampleRate: this.graph ? this.graph.ctx.sampleRate : 48000,
      bufferBytes: this.graph?.bufferBytes ?? this.pcmBytes(),
      bakedCues: this.cues.size,
      bakedVariations: this.bakedVariations,
      voicesLive: this.pool.liveCount,
      voicesMax: this.pool.max,
      steals: this.pool.steals,
      rejections: this.pool.rejections,
      duckDb: this.duckGainDb,
      deafness: this.deafness,
      envName: this.envTarget.name,
      envEnclosure: this.envTarget.enclosure,
      envReverbSeconds: this.envTarget.reverbSeconds,
      envWetDb: this.envTarget.wetDb,
      envBlend: this.envBlend,
      listener: {
        x: this.listener.position.x,
        y: this.listener.position.y,
        z: this.listener.position.z,
        yawDeg: this.listenerYaw.deg,
      },
      occlusionSource: this.probe.usedPhysics
        ? 'PHYS.visibility(LAYER_SOLID)'
        : this.probe.blockers.length > 0
          ? 'DEBUG BLOCKERS (phys null)'
          : 'none (phys null, no blockers)',
      rows,
      buses,
      irs,
      blockers: this.probe.blockers,
      lastGunWaveform: this.lastGunWaveform,
      lastGunLabel: this.lastGunLabel,
      modelTime: this.modelTime,
    };
    return this.snapshotCache;
  }

  /** The debug scenario drives the listener directly. */
  debugSetListener(position: Vec3, forward: Vec3, up: Vec3, velocity: Vec3): void {
    this.setListener(position, forward, up, velocity);
  }

  private installGestureUnlock(): void {
    if (typeof window === 'undefined') return;
    const handler = (): void => {
      void this.unlock();
    };
    const events: readonly string[] = ['pointerdown', 'keydown', 'touchstart'];
    for (const e of events) window.addEventListener(e, handler, { passive: true });
    this.gestureCleanup = (): void => {
      for (const e of events) window.removeEventListener(e, handler);
    };
  }
}

/** Linear blend of two environments while the convolver pair crossfades. */
function blendEnv(a: AcousticEnvironment, b: AcousticEnvironment, t: number): AcousticEnvironment {
  return {
    name: b.name,
    enclosure: a.enclosure + (b.enclosure - a.enclosure) * t,
    reverbSeconds: a.reverbSeconds + (b.reverbSeconds - a.reverbSeconds) * t,
    wetDb: a.wetDb + (b.wetDb - a.wetDb) * t,
    dampingHz: a.dampingHz + (b.dampingHz - a.dampingHz) * t,
  };
}

/** `SurfaceProfile.impactCue` is authoritative once RCORE's table is live; this
 *  is the fallback while `materials` is still the null service. */
function impactCueFor(surface: SurfaceId): SoundId {
  switch (surface) {
    case SurfaceId.Sandstone:
    case SurfaceId.Stucco:
    case SurfaceId.Concrete:
    case SurfaceId.Plaster:
    case SurfaceId.Tile:
    case SurfaceId.Cobble:
    case SurfaceId.Rubble:
      return 'i.stone';
    case SurfaceId.PaintedMetal:
    case SurfaceId.RustedMetal:
    case SurfaceId.BareMetal:
    case SurfaceId.Grating:
      return 'i.metal';
    case SurfaceId.Wood:
    case SurfaceId.PaintedWood:
    case SurfaceId.Bark:
      return 'i.wood';
    case SurfaceId.Glass:
      return 'i.glass';
    case SurfaceId.Sand:
    case SurfaceId.Dirt:
    case SurfaceId.Gravel:
      return 'i.sand';
    case SurfaceId.Water:
    case SurfaceId.WetSand:
      return 'i.water';
    case SurfaceId.Flesh:
      return 'i.flesh';
    case SurfaceId.Fabric:
    case SurfaceId.Tarp:
    case SurfaceId.Sandbag:
    case SurfaceId.Rope:
    case SurfaceId.Kevlar:
    case SurfaceId.Rubber:
      return 'i.fabric';
    case SurfaceId.Foliage:
      return 'i.foliage';
    default:
      return 'i.stone';
  }
}

/* ========================================================================== */
/* The three named exports the frozen descriptor table imports                 */
/* ========================================================================== */

let instance: IronAudio | null = null;

export function createAudioService(ctx: BootContext): AudioService {
  instance = new IronAudio(ctx);
  return instance;
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 * ~60 cues plus 7 impulse responses; see `src/audio/bakes.ts`.
 */
export function registerAudioBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  declareAudioBakes(assets, quality);
}

/**
 * Harness reset chain, at the top of EVERY capture. Voices, tails, the reverb
 * send, the duck state and the ambience beds all have to go, or a shot's result
 * depends on the ORDER shots were captured in.
 *
 * It is also the ONLY channel a shot file has into this lane (see
 * `AUDIO_DEBUG_SEED`), so the debug overlay is armed and disarmed from here.
 */
export function resetAudio(seed: number): void {
  instance?.resetTransient(seed);
}

export type { IronAudio };
export { ALL_SOUND_IDS, dbToGain, gainToDb };
