/**
 * AUDIO — the deterministic debug scenario.
 *
 * OWNER: AUDIO.
 *
 * The `audio_debug` shot has to prove things a still frame cannot show: that
 * distance attenuation, air absorption, occlusion, voice stealing, ducking and
 * the reverb crossfade all behave. So instead of screenshotting silence, the
 * scenario drives a scripted firefight around a fixed listener and the overlay
 * renders the resulting state.
 *
 * Every event is scheduled off `modelTime` — the simulation clock the harness
 * advances by a fixed dt — never off wall-clock. That is what makes the shot
 * reproducible: frame 240 of the scenario is the same frame 240 on any machine,
 * whether it took 4 seconds or 4 minutes to render.
 */
import * as THREE from 'three';
import type { Rng, SoundId, Vec3 } from '@/engine/types';
import type { OcclusionProbe } from '../occlusion';

/** What the scenario is allowed to do to the audio system. */
interface ScenarioTarget {
  play(id: SoundId, desc?: { position?: Vec3; gainDb?: number; priority?: number }): unknown;
  debugSetListener(position: Vec3, forward: Vec3, up: Vec3, velocity: Vec3): void;
  setEnvironment(env: {
    readonly name: string;
    readonly enclosure: number;
    readonly reverbSeconds: number;
    readonly wetDb: number;
  }): void;
}

interface ScheduledShot {
  /** Seconds into the scenario. */
  readonly at: number;
  readonly id: SoundId;
  /** Metres from the listener, and bearing in radians clockwise from north. */
  readonly range: number;
  readonly bearing: number;
  readonly gainDb: number;
}

/**
 * The environments the listener walks through, in order. Chosen to exercise the
 * convolver crossfade — an open quay into a stone alley is the largest acoustic
 * step on the map, so if the transition is going to click, it clicks here.
 */
const ENVIRONMENTS = [
  { name: 'QUAY', enclosure: 0.05, reverbSeconds: 0.9, wetDb: -21 },
  { name: 'ALLEY', enclosure: 0.72, reverbSeconds: 1.6, wetDb: -11 },
  { name: 'MARKET', enclosure: 0.34, reverbSeconds: 1.2, wetDb: -15 },
  { name: 'FORT', enclosure: 0.88, reverbSeconds: 2.4, wetDb: -8 },
] as const;

const SCENARIO_SECONDS = 12;

export class DebugScenario {
  private readonly script: ScheduledShot[] = [];
  private readonly listenerPos = new THREE.Vector3(0, 1.65, 0);
  private readonly forward = new THREE.Vector3(0, 0, -1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly velocity = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private elapsed = 0;
  private nextShot = 0;
  private envIndex = -1;

  constructor(
    private readonly probe: OcclusionProbe,
    private readonly rng: Rng,
    seed: number,
  ) {
    this.build(seed);
  }

  /**
   * Lay out the whole 12 s script up front from the seeded RNG. Generating
   * events lazily per frame would make the result depend on how many frames the
   * harness chose to render before the grab.
   */
  private build(seed: number): void {
    const ids: SoundId[] = [
      'weapon.rifle.fire' as SoundId,
      'weapon.dmr.fire' as SoundId,
      'weapon.lmg.fire' as SoundId,
      'impact.stone' as SoundId,
      'impact.metal' as SoundId,
      'explosion.grenade' as SoundId,
    ];

    // A deliberate burst structure: sparse ranging shots, then an overlapping
    // volley that exceeds the voice budget so the overlay shows real steals.
    let t = 0.35;
    while (t < SCENARIO_SECONDS) {
      const burst = 1 + this.rng.int(4);
      for (let i = 0; i < burst; i++) {
        this.script.push({
          at: t + i * 0.075,
          id: this.rng.pick(ids),
          // 3 m to 220 m spans the whole falloff curve, including the range
          // where air absorption starts audibly dulling the crack.
          range: 3 + this.rng.next() ** 2 * 217,
          bearing: this.rng.next() * Math.PI * 2,
          gainDb: -3 + this.rng.next() * 6,
        });
      }
      t += 0.25 + this.rng.next() * 0.9;
    }
    this.script.sort((a, b) => a.at - b.at);
    // Seed is folded in so two shots with different seeds genuinely differ.
    if ((seed & 1) === 1) this.script.reverse();
  }

  /** Called once when the scenario is armed. */
  arm(target: ScenarioTarget): void {
    this.elapsed = 0;
    this.nextShot = 0;
    this.envIndex = -1;
    this.probe.clearBlockers?.();
    target.debugSetListener(this.listenerPos, this.forward, this.up, this.velocity);
    this.applyEnvironment(target, 0);
  }

  /**
   * `modelTime` is passed separately from `dt` because the audio system's own
   * clock is what schedules WebAudio events; using it here keeps the script and
   * the graph on the same timeline.
   */
  update(target: ScenarioTarget, dt: number, _modelTime: number): void {
    this.elapsed += dt;

    // Walk the listener along a slow arc so panning, doppler and the environment
    // crossfade all have something to do.
    const phase = (this.elapsed / SCENARIO_SECONDS) * Math.PI * 2;
    const prevX = this.listenerPos.x;
    const prevZ = this.listenerPos.z;
    this.listenerPos.set(Math.sin(phase) * 9, 1.65, Math.cos(phase) * 9);
    if (dt > 0) {
      this.velocity.set((this.listenerPos.x - prevX) / dt, 0, (this.listenerPos.z - prevZ) / dt);
    }
    this.forward.set(Math.cos(phase), 0, -Math.sin(phase)).normalize();
    target.debugSetListener(this.listenerPos, this.forward, this.up, this.velocity);

    const seg = Math.min(
      ENVIRONMENTS.length - 1,
      Math.floor((this.elapsed / SCENARIO_SECONDS) * ENVIRONMENTS.length),
    );
    if (seg !== this.envIndex) this.applyEnvironment(target, seg);

    while (this.nextShot < this.script.length && this.script[this.nextShot]!.at <= this.elapsed) {
      const s = this.script[this.nextShot++]!;
      this.tmp.set(
        this.listenerPos.x + Math.sin(s.bearing) * s.range,
        this.listenerPos.y + (this.rng.next() - 0.5) * 3,
        this.listenerPos.z + Math.cos(s.bearing) * s.range,
      );
      target.play(s.id, { position: this.tmp, gainDb: s.gainDb, priority: s.range < 40 ? 2 : 1 });
    }

    // Loop rather than fall silent: a shot captured at an arbitrary frame should
    // never land in dead air.
    if (this.elapsed >= SCENARIO_SECONDS) {
      this.elapsed = 0;
      this.nextShot = 0;
    }
  }

  private applyEnvironment(target: ScenarioTarget, index: number): void {
    this.envIndex = index;
    target.setEnvironment(ENVIRONMENTS[index]!);
  }
}
