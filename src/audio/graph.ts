/**
 * AUDIO — the live WebAudio bus topology.
 *
 * OWNER: AUDIO. Built lazily, exactly once, on the first successful unlock. The
 * whole graph is a no-op path until then: `IronAudio` keeps running its JS model
 * regardless, so nothing upstream has to care whether the context exists.
 *
 *   source ─ srcGain ─ airLpf ─ occShelf ─┬─ panner ─ dryGain ──┐
 *                                         ├─ erSend ────────────┼─→ erBus  ─ convolver(A/B) ─┐
 *                                         ├─ tailSend ──────────┼─→ tailBus ─ convolver(A/B) ┤
 *                                         └─ subSend ───────────┼─→ subBus ─ lowpass 110 Hz ─┤
 *                                                               │                            │
 *                             sfx / weapons / ambience ─────────┴────────────────────────────┴─→ duck ─┐
 *                                                                                                      ├─ comp ─ master ─ out
 *                             ui ──────────────────────────────────────────────────────────────────────┘
 *
 * WHY THE SPLIT BUSES:
 *  - dry / ER / tail as separate sends is the only way a source can move closer
 *    without the room changing. One wet knob cannot express that.
 *  - the SUB bus exists because low frequencies neither absorb nor occlude the
 *    way the rest of the spectrum does; routing them separately is what makes an
 *    explosion behind a wall still hit you in the chest.
 *  - the DUCK bus carries everything except `ui`, so a capture confirmation or a
 *    hitmarker still lands through an explosion. That is the entire point of it.
 *  - the compressor sits AFTER the duck and BEFORE the master fader, so ducking
 *    is a mix decision the compressor then rides, rather than the compressor
 *    fighting the duck for the same 6 dB.
 */
import type { AudioAsset } from '@/engine/types';
import { dbToGain } from './dsp/core';
import type { BusName } from './library';
import type { ImpulseResponse } from './dsp/impulse';

export interface VoiceChannel {
  readonly src: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly lpf: BiquadFilterNode;
  readonly shelf: BiquadFilterNode;
  readonly pan: StereoPannerNode;
  readonly dry: GainNode;
  readonly er: GainNode;
  readonly tail: GainNode;
  readonly sub: GainNode;
}

/** Crossfading convolution pair. Only one is "current"; the other fades out. */
interface ConvPair {
  readonly a: ConvolverNode;
  readonly b: ConvolverNode;
  readonly ga: GainNode;
  readonly gb: GainNode;
  current: 'a' | 'b';
}

export class AudioGraph {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly comp: DynamicsCompressorNode;
  readonly duck: GainNode;
  readonly buses: Record<BusName, GainNode>;

  private readonly erBus: GainNode;
  private readonly tailBus: GainNode;
  private readonly subBus: GainNode;
  private readonly erConv: ConvPair;
  private readonly tailConv: ConvPair;
  private readonly buffers = new Map<string, AudioBuffer>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = dbToGain(-3);
    this.master.connect(ctx.destination);

    // A slow, gentle bus compressor. Not a limiter: the point is to keep a
    // 24-voice firefight from burying a reload, not to flatten the dynamics
    // that make a gunshot feel like a gunshot.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.28;
    this.comp.connect(this.master);

    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.comp);

    const bus = (db: number, toDuck: boolean): GainNode => {
      const g = ctx.createGain();
      g.gain.value = dbToGain(db);
      g.connect(toDuck ? this.duck : this.comp);
      return g;
    };
    this.buses = {
      sfx: bus(0, true),
      weapons: bus(0, true),
      ambience: bus(-4, true),
      // UI bypasses the duck by design.
      ui: bus(-2, false),
    };

    this.erBus = ctx.createGain();
    this.tailBus = ctx.createGain();
    this.subBus = ctx.createGain();

    this.erConv = this.makeConvPair(this.erBus, this.duck, dbToGain(0));
    this.tailConv = this.makeConvPair(this.tailBus, this.duck, dbToGain(0));

    // The sub bus is band-limited on the way out so it cannot muddy the mids.
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass';
    subLp.frequency.value = 110;
    subLp.Q.value = 0.6;
    const subHp = ctx.createBiquadFilter();
    subHp.type = 'highpass';
    subHp.frequency.value = 26;
    subHp.Q.value = 0.7;
    this.subBus.connect(subHp);
    subHp.connect(subLp);
    subLp.connect(this.duck);
  }

  private makeConvPair(input: GainNode, output: AudioNode, gain: number): ConvPair {
    const ctx = this.ctx;
    const a = ctx.createConvolver();
    const b = ctx.createConvolver();
    a.normalize = false;
    b.normalize = false;
    const ga = ctx.createGain();
    const gb = ctx.createGain();
    ga.gain.value = gain;
    gb.gain.value = 0;
    input.connect(ga);
    input.connect(gb);
    ga.connect(a);
    gb.connect(b);
    a.connect(output);
    b.connect(output);
    return { a, b, ga, gb, current: 'a' };
  }

  /** Cached PCM → AudioBuffer. Cues are converted on first use, never at boot. */
  buffer(key: string, asset: AudioAsset): AudioBuffer {
    let buf = this.buffers.get(key);
    if (buf) return buf;
    const channels = Math.max(1, asset.channels.length);
    const frames = asset.channels[0]?.length ?? 1;
    buf = this.ctx.createBuffer(channels, frames, asset.sampleRate);
    for (let c = 0; c < channels; c++) buf.copyToChannel(asset.channels[c], c, 0);
    this.buffers.set(key, buf);
    return buf;
  }

  get bufferBytes(): number {
    let total = 0;
    for (const b of this.buffers.values()) total += b.length * b.numberOfChannels * 4;
    return total;
  }

  /**
   * Cross-fade both convolvers to a new environment. The pair swap is what makes
   * walking from an alley into a courtyard a transition rather than a cut; 0.7 s
   * is long enough to be inaudible and short enough to track a sprint.
   */
  setImpulse(early: ImpulseResponse, tail: ImpulseResponse, seconds: number): void {
    this.crossfade(this.erConv, early, seconds);
    this.crossfade(this.tailConv, tail, seconds);
  }

  private crossfade(pair: ConvPair, ir: ImpulseResponse, seconds: number): void {
    const next = pair.current === 'a' ? 'b' : 'a';
    const node = next === 'a' ? pair.a : pair.b;
    const rising = next === 'a' ? pair.ga : pair.gb;
    const falling = next === 'a' ? pair.gb : pair.ga;
    const buf = this.ctx.createBuffer(2, ir.left.length, ir.sampleRate);
    buf.copyToChannel(ir.left, 0, 0);
    buf.copyToChannel(ir.right, 1, 0);
    node.buffer = buf;
    const t = this.ctx.currentTime;
    // Equal-power would be ideal but the two IRs are correlated only in the
    // late field; a linear ramp is what keeps the level steady in practice.
    rising.gain.cancelScheduledValues(t);
    falling.gain.cancelScheduledValues(t);
    rising.gain.setValueAtTime(rising.gain.value, t);
    falling.gain.setValueAtTime(falling.gain.value, t);
    rising.gain.linearRampToValueAtTime(1, t + seconds);
    falling.gain.linearRampToValueAtTime(0, t + seconds);
    pair.current = next;
  }

  /** Build one voice's node chain. Cheap: WebAudio node construction is ~2 µs. */
  createChannel(buffer: AudioBuffer, bus: BusName, loop: boolean): VoiceChannel {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 20000;
    lpf.Q.value = 0.55;

    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1800;
    shelf.gain.value = 0;

    const pan = ctx.createStereoPanner();
    const dry = ctx.createGain();
    const er = ctx.createGain();
    const tail = ctx.createGain();
    const sub = ctx.createGain();
    dry.gain.value = 1;
    er.gain.value = 0;
    tail.gain.value = 0;
    sub.gain.value = 0;

    src.connect(gain);
    gain.connect(lpf);
    lpf.connect(shelf);
    shelf.connect(pan);
    pan.connect(dry);
    dry.connect(this.buses[bus]);
    // Sends are taken PRE-pan: a convolver's stereo image comes from the IR, and
    // feeding it an already-panned signal collapses the room onto one side.
    shelf.connect(er);
    shelf.connect(tail);
    gain.connect(sub);
    er.connect(this.erBus);
    tail.connect(this.tailBus);
    sub.connect(this.subBus);

    return { src, gain, lpf, shelf, pan, dry, er, tail, sub };
  }

  disposeChannel(ch: VoiceChannel): void {
    try {
      ch.src.disconnect();
      ch.gain.disconnect();
      ch.lpf.disconnect();
      ch.shelf.disconnect();
      ch.pan.disconnect();
      ch.dry.disconnect();
      ch.er.disconnect();
      ch.tail.disconnect();
      ch.sub.disconnect();
    } catch {
      // A node already torn down by a context state change is not an error.
    }
  }

  setBusGainDb(name: BusName | 'master', db: number): void {
    const t = this.ctx.currentTime;
    const node = name === 'master' ? this.master : this.buses[name];
    node.gain.cancelScheduledValues(t);
    node.gain.setValueAtTime(node.gain.value, t);
    node.gain.linearRampToValueAtTime(dbToGain(db), t + 0.05);
  }

  /**
   * Duck everything except `ui`, then recover. The recovery is deliberately
   * slower than the dip: hearing coming back suddenly reads as a bug, hearing
   * coming back over a second and a half reads as an explosion.
   */
  duckFor(seconds: number, amountDb: number): void {
    const t = this.ctx.currentTime;
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(dbToGain(amountDb), t + 0.03);
    g.setValueAtTime(dbToGain(amountDb), t + Math.max(seconds, 0.05));
    g.linearRampToValueAtTime(1, t + Math.max(seconds, 0.05) + 1.4);
  }

  dispose(): void {
    try {
      this.master.disconnect();
    } catch {
      // Ignore: disconnecting a closed context throws in some engines.
    }
    this.buffers.clear();
  }
}
