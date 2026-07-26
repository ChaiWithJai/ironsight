/**
 * AUDIO — the deterministic debug scenario.
 *
 * OWNER: AUDIO.
 *
 * The `audio` / `audio_debug` shots have to prove things a still frame cannot
 * show on its own: that distance attenuation, air absorption, propagation delay,
 * occlusion, voice stealing, ducking and the reverb crossfade all behave. So
 * instead of screenshotting silence, the scenario drives a scripted firefight
 * around a walking listener and the overlay renders the resulting state.
 *
 * Every event is scheduled off the scenario's own accumulated `dt` — the fixed
 * timestep the harness advances by — and never off wall-clock. That is what
 * makes the shot reproducible: second 5.00 of the scenario is the same state on
 * any machine, whether it took 4 seconds or 4 minutes to render.
 *
 * WHAT EACH BEAT EXISTS TO PROVE, because a scripted scene with no thesis is
 * just noise:
 *
 *   the near rifle at 5 m     the reference. Full transient, no air absorption,
 *                             hard pan, ~15 ms of delay.
 *   the carbine behind a wall the occlusion path. Same cue, same bus, ~20 dB
 *                             down on the direct path and low-passed to under a
 *                             kilohertz — audible, not muted.
 *   the LMG at 120 m          air absorption. The LPF column should read a few
 *                             kHz where the near rifle reads twenty.
 *   the DMR at 340 m          the long-range model. The near cue is replaced by
 *                             `w.distant` and a reflected `w.tail` follows it.
 *   the grenade at 16 m       the duck and the temporary threshold shift: every
 *                             other voice loses level AND treble for a second.
 *   the volley at 4.6 s/7.6 s more simultaneous cues than the voice budget, so
 *                             the STEALS counter has to move.
 */
import * as THREE from 'three';
import { SurfaceId, type AcousticEnvironment, type Rng, type SoundId, type Vec3 } from '@/engine/types';
import { ENVIRONMENTS } from '../library';
import type { OcclusionProbe } from '../occlusion';

/** What the scenario is allowed to do to the audio system. */
export interface ScenarioTarget {
  play(id: SoundId, desc?: { position?: Vec3; gainDb?: number; surface?: SurfaceId; pitch?: number }): unknown;
  debugSetListener(position: Vec3, forward: Vec3, up: Vec3, velocity: Vec3): void;
  setEnvironment(env: Readonly<AcousticEnvironment>): void;
  duck(seconds: number, amountDb: number): void;
}

interface ScheduledCue {
  /** Seconds into the scenario. */
  readonly at: number;
  readonly id: SoundId;
  /** Emitter position in the scenario's local frame, metres. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly gainDb: number;
  readonly surface?: SurfaceId;
  /** Footstep stance channel; see `IronAudio.pickVariation`. */
  readonly pitch?: number;
  /** Fired once, at the moment this cue plays. */
  readonly duck?: readonly [number, number];
  /**
   * Position is relative to the LISTENER rather than to the scenario's world
   * frame. The player's own foley, and the rounds that pass his head, travel
   * with him; the firing stations and the impacts do not.
   */
  readonly local?: true;
}

/**
 * The environments the listener walks through, in order, as real
 * `AcousticEnvironment` records — the mixer looks its impulse responses up by
 * `name`, so an invented name silently falls back to `open` and the whole
 * crossfade demonstration evaporates.
 *
 * Open quay → stone alley → market courtyard → fort. The quay-to-alley step is
 * the largest acoustic jump on the map, so if the convolver pair is going to
 * click, it clicks there.
 */
const WALK: readonly AcousticEnvironment[] = [
  ENVIRONMENTS.open,
  ENVIRONMENTS.street,
  ENVIRONMENTS.courtyard,
  ENVIRONMENTS.fort,
];

const SCENARIO_SECONDS = 12;

/** Weapons in the scripted exchange, with their firing station. */
const STATIONS: readonly { id: SoundId; x: number; z: number; y: number; gainDb: number }[] = [
  // Friendly rifleman at the listener's left shoulder.
  { id: 'w.rifle.fire', x: -4.2, z: -2.6, y: 1.5, gainDb: 0 },
  // Enemy carbine down the alley, directly behind the stone wall blocker.
  { id: 'w.carbine.fire', x: 3.0, z: -46, y: 1.5, gainDb: 1 },
  // Support gun on the quay.
  { id: 'w.lmg.fire', x: -86, z: 84, y: 2.0, gainDb: 2 },
  // Marksman on the headland — far enough to trip the `w.distant` swap.
  { id: 'w.dmr.fire', x: 210, z: -268, y: 26, gainDb: 3 },
];

/** Surfaces the listener's footfalls cycle through, with the matching stance. */
const FOOTING: readonly { surface: SurfaceId; stance: number }[] = [
  { surface: SurfaceId.Cobble, stance: 1 },
  { surface: SurfaceId.Cobble, stance: 1 },
  { surface: SurfaceId.Sand, stance: 2 },
  { surface: SurfaceId.Gravel, stance: 2 },
  { surface: SurfaceId.Grating, stance: 1 },
  { surface: SurfaceId.WetSand, stance: 0 },
];

export class DebugScenario {
  private readonly script: ScheduledCue[] = [];
  private readonly listenerPos = new THREE.Vector3(0, 1.62, 0);
  private readonly forward = new THREE.Vector3(0, 0, -1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly velocity = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private elapsed = 0;
  private nextCue = 0;
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
   * harness chose to render before the grab, which is exactly the class of bug
   * the fixed-dt harness exists to rule out.
   */
  private build(seed: number): void {
    const cues = this.script;
    // The seed perturbs the burst rhythm without changing the beats, so two
    // seeds give genuinely different frames that still prove the same things.
    const skew = ((seed >>> 3) & 0xff) / 255;

    /* ---- the weapon exchange ------------------------------------------- */
    // Four stations firing in overlapping bursts. Rates are the real cyclic
    // rates: 800 rpm rifle, 850 carbine, 650 LMG, semi-auto DMR.
    const burst = (station: number, at: number, rounds: number, rpm: number): void => {
      const s = STATIONS[station]!;
      const gap = 60 / rpm;
      for (let i = 0; i < rounds; i++) {
        cues.push({ at: at + i * gap, id: s.id, x: s.x, y: s.y, z: s.z, gainDb: s.gainDb });
      }
    };

    burst(0, 0.45 + skew * 0.1, 4, 800);
    burst(1, 0.9, 6, 850);
    burst(2, 1.6, 9, 650);
    burst(0, 2.3 + skew * 0.15, 3, 800);
    cues.push({ at: 2.75, id: 'w.dmr.fire', x: STATIONS[3]!.x, y: STATIONS[3]!.y, z: STATIONS[3]!.z, gainDb: 3 });
    burst(1, 3.1, 5, 850);
    burst(2, 3.6, 12, 650);
    burst(0, 4.15, 6, 800);
    // The over-subscription volley: every station at once, plus impacts, so the
    // pool has to steal. This is the state the `audio` shot is grabbed in.
    burst(0, 4.6, 8, 800);
    burst(1, 4.62, 8, 850);
    burst(2, 4.58, 10, 650);
    cues.push({ at: 4.7, id: 'w.dmr.fire', x: STATIONS[3]!.x, y: STATIONS[3]!.y, z: STATIONS[3]!.z, gainDb: 3 });

    burst(2, 6.4, 8, 650);
    burst(1, 6.9, 6, 850);
    // The second over-subscription volley, immediately before the grenade, so
    // the `audio_debug` grab catches steals AND the duck in the same frame.
    burst(0, 7.4, 9, 800);
    burst(1, 7.45, 7, 850);
    burst(2, 7.42, 9, 650);
    burst(0, 8.9, 5, 800);
    burst(2, 9.6, 7, 650);
    cues.push({ at: 10.6, id: 'w.dmr.fire', x: STATIONS[3]!.x, y: STATIONS[3]!.y, z: STATIONS[3]!.z, gainDb: 3 });

    /* ---- rounds arriving at the listener -------------------------------- */
    // Supersonic pass: the crack is generated at the point of closest approach
    // and therefore arrives BEFORE the muzzle report of the shot that made it —
    // the delay column shows both, and they disagree, which is the point.
    for (const t of [1.05, 3.25, 4.68, 4.95, 7.5, 7.62, 9.7]) {
      const off = this.rng.range(-1.4, 1.4);
      cues.push({ at: t, id: 'b.crack', x: off, y: 0.3, z: -1.6, gainDb: -1, local: true });
      cues.push({ at: t + 0.012, id: 'b.whizby', x: off * 1.6, y: 0.3, z: 1.2, gainDb: -4, local: true });
    }

    /* ---- impacts, keyed by surface -------------------------------------- */
    const impactSurfaces: readonly [SoundId, SurfaceId][] = [
      ['i.stone', SurfaceId.Sandstone],
      ['i.metal', SurfaceId.RustedMetal],
      ['i.wood', SurfaceId.Wood],
      ['i.sand', SurfaceId.Sand],
      ['i.glass', SurfaceId.Glass],
      ['i.fabric', SurfaceId.Sandbag],
    ];
    for (let i = 0; i < 26; i++) {
      const [id, surface] = impactSurfaces[i % impactSurfaces.length]!;
      cues.push({
        at: 0.7 + i * 0.42 + this.rng.range(-0.06, 0.06),
        id,
        x: this.rng.range(-14, 14),
        y: this.rng.range(0.2, 3.4),
        z: this.rng.range(-22, 8),
        gainDb: this.rng.range(-6, 2),
        surface,
      });
    }

    /* ---- the listener's own foley --------------------------------------- */
    // A footfall every 0.42 s, cycling surface and stance so the overlay shows
    // the surface-keyed variation index moving rather than a constant.
    for (let i = 0; i * 0.42 < SCENARIO_SECONDS; i++) {
      const f = FOOTING[i % FOOTING.length]!;
      cues.push({
        at: 0.2 + i * 0.42,
        id: 'p.footstep',
        x: 0,
        y: -1.57,
        z: 0,
        gainDb: f.stance === 2 ? 3 : 0,
        surface: f.surface,
        pitch: f.stance,
        local: true,
      });
      if (i % 3 === 1) {
        cues.push({ at: 0.26 + i * 0.42, id: 'p.gear', x: 0, y: -0.5, z: 0, gainDb: -2, local: true });
      }
    }
    cues.push({ at: 5.4, id: 'p.jump', x: 0, y: -0.6, z: 0, gainDb: 0, local: true });
    cues.push({ at: 5.92, id: 'p.land', x: 0, y: -1.5, z: 0, gainDb: 1, local: true });
    cues.push({ at: 6.05, id: 'p.breath', x: 0, y: 0, z: 0, gainDb: 0, local: true });

    /* ---- the reload ------------------------------------------------------ */
    const foley = (at: number, id: SoundId): void => {
      cues.push({ at, id, x: -0.3, y: -0.25, z: -0.4, gainDb: 0, local: true });
    };
    foley(5.55, 'w.dry');
    foley(5.75, 'w.magout');
    foley(6.25, 'w.magin');
    foley(6.62, 'w.bolt');
    foley(6.95, 'w.ads');
    for (let i = 0; i < 6; i++) {
      cues.push({ at: 4.68 + i * 0.11, id: 'w.shell', x: 0.6, y: -1.5, z: -0.2, gainDb: -3, local: true });
    }

    /* ---- the grenade, the collapse, and the objective -------------------- */
    // 16 m: inside the ducking radius, so DUCK and DEAF both move and every
    // other row in the table loses treble on the same frame.
    cues.push({ at: 7.72, id: 'x.near', x: 11, y: 0.9, z: -11, gainDb: 6, duck: [0.4, -15] });
    cues.push({ at: 7.74, id: 'x.debris', x: 11, y: 0.9, z: -11, gainDb: -2 });
    cues.push({ at: 8.15, id: 'x.far', x: -230, y: 6, z: 340, gainDb: 2 });
    cues.push({ at: 8.4, id: 'x.collapse', x: 24, y: 3, z: -18, gainDb: 2 });
    cues.push({ at: 8.55, id: 'x.debris', x: 24, y: 1, z: -18, gainDb: -1 });
    cues.push({ at: 9.05, id: 'p.hurt', x: 0, y: 0, z: 0, gainDb: -1, local: true });
    cues.push({ at: 10.2, id: 'ui.hit', x: 0, y: 0, z: 0, gainDb: 0 });
    cues.push({ at: 10.35, id: 'ui.hit', x: 0, y: 0, z: 0, gainDb: 2 });
    cues.push({ at: 11.0, id: 'ui.capture', x: 0, y: 0, z: 0, gainDb: 0 });
    cues.push({ at: 11.4, id: 'ui.ticket', x: 0, y: 0, z: 0, gainDb: 0 });

    cues.sort((a, b) => a.at - b.at);
  }

  /**
   * Register the analytic occlusion blockers. `PhysicsService.visibility()`
   * always returns 1 until PHYS lands, and a debug view that shows an occlusion
   * column of solid zeroes proves nothing — so the probe falls through to these
   * boxes, and the overlay LABELS which source it used so it cannot quietly lie
   * about where the numbers came from.
   */
  private installBlockers(): void {
    this.probe.clearBlockers();
    const box = (
      label: string,
      cx: number,
      cy: number,
      cz: number,
      sx: number,
      sy: number,
      sz: number,
      opacity: number,
    ): void => {
      this.probe.blockers.push({
        min: new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
        max: new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
        opacity,
        label,
      });
    };
    // GEOMETRY IS CHOSEN AGAINST THE LISTENER'S ARC, not by eye. The walk stays
    // inside x ∈ [-9, 9], z ∈ [-18, 0] (see `update`), so a barrier only proves
    // anything if it lies across that whole envelope's sightline to its station.
    //
    // 400 mm sandstone across the alley, north of the entire arc and south of the
    // enemy carbine at z = -46 — so the carbine is occluded at EVERY frame of the
    // scenario rather than at whichever one happened to be grabbed.
    box('SANDSTONE WALL', 0, 2.2, -26, 80, 4.4, 0.4, 0.94);
    // The quay's container line, running north along x = -30. Every ray from the
    // arc to the LMG station at (-86, 84) crosses it between z = 14 and z = 22.
    box('CONTAINER LINE', -30, 1.6, 30, 0.6, 3.2, 60, 0.86);
    // A sandbag berm just north of the arc. Low, so it clips the rays to
    // ground-level impacts and passes cleanly under the elevated ones — which is
    // why it has a partial opacity and the wall does not.
    box('SANDBAG BERM', 0, 0.7, -8, 36, 1.4, 1.2, 0.55);
    // The market awning: cloth stretched overhead. Takes the top off anything
    // heard through it and does nothing else, which is what cloth does.
    box('CANVAS AWNING', 6, 3.1, 6, 14, 0.2, 14, 0.28);
  }

  /** Called once when the scenario is armed. */
  arm(target: ScenarioTarget): void {
    this.elapsed = 0;
    this.nextCue = 0;
    this.envIndex = -1;
    this.installBlockers();
    this.listenerPos.set(0, 1.62, 0);
    this.forward.set(0, 0, -1);
    this.velocity.set(0, 0, 0);
    target.debugSetListener(this.listenerPos, this.forward, this.up, this.velocity);
    this.applyEnvironment(target, 0);
  }

  update(target: ScenarioTarget, dt: number, _modelTime: number): void {
    this.elapsed += dt;

    /* ---- walk the listener ---------------------------------------------- */
    // A slow arc rather than a straight line, so panning, doppler and the
    // occlusion probe all have something to track. 9 m radius over 12 s is about
    // 4.7 m/s — a sprint, which is the hardest case for the occlusion smoother.
    const phase = (this.elapsed / SCENARIO_SECONDS) * Math.PI * 2;
    const prevX = this.listenerPos.x;
    const prevZ = this.listenerPos.z;
    this.listenerPos.set(Math.sin(phase) * 9, 1.62, Math.cos(phase) * 9 - 9);
    if (dt > 0) {
      this.velocity.set((this.listenerPos.x - prevX) / dt, 0, (this.listenerPos.z - prevZ) / dt);
    }
    // Face along the walk, so the near rifle sweeps from one ear to the other.
    this.forward.set(Math.cos(phase), -0.06, -Math.sin(phase)).normalize();
    target.debugSetListener(this.listenerPos, this.forward, this.up, this.velocity);

    /* ---- environment crossfade ------------------------------------------ */
    const seg = Math.min(WALK.length - 1, Math.floor((this.elapsed / SCENARIO_SECONDS) * WALK.length));
    if (seg !== this.envIndex) this.applyEnvironment(target, seg);

    /* ---- fire the script ------------------------------------------------- */
    while (this.nextCue < this.script.length && this.script[this.nextCue]!.at <= this.elapsed) {
      const c = this.script[this.nextCue++]!;
      // Stations and impacts are in the scenario's world frame; the listener
      // moves through it, so a station really does change range and bearing.
      if (c.local) this.tmp.set(c.x, c.y, c.z).add(this.listenerPos);
      else this.tmp.set(c.x, c.y, c.z);
      target.play(c.id, {
        position: this.tmp,
        gainDb: c.gainDb,
        ...(c.surface !== undefined ? { surface: c.surface } : {}),
        ...(c.pitch !== undefined ? { pitch: c.pitch } : {}),
      });
      if (c.duck) target.duck(c.duck[0], c.duck[1]);
    }

    // Loop rather than fall silent: a shot captured at an arbitrary frame should
    // never land in dead air.
    if (this.elapsed >= SCENARIO_SECONDS) {
      this.elapsed -= SCENARIO_SECONDS;
      this.nextCue = 0;
    }
  }

  private applyEnvironment(target: ScenarioTarget, index: number): void {
    this.envIndex = index;
    target.setEnvironment(WALK[index]!);
  }
}
