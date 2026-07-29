/**
 * THE SIM SOAK. CORE owns this file.
 *
 * `tools/soak.mjs` drives this object and nothing else, the same way
 * `tools/capture.mjs` drives `window.__HARNESS__`. It boots the game through
 * the identical path — build, serve, headless Chromium, wait for
 * `__HARNESS__.ready` — then runs the FIXED-TIMESTEP simulation forward for N
 * seconds with rendering minimised and dumps a JSON report.
 *
 * WHY THIS EXISTS
 * ---------------
 * A human played the game and reported three behavioural bugs: "I get stuck
 * walking uphill", "my teammates do not move", "enemies do not move". Twelve
 * rounds of screenshot critics never saw any of them, because a still frame
 * cannot show that a bot has been standing in the same square metre for a
 * minute. Nothing in this repo could turn any of those sentences into a number,
 * and the project's standing failure mode is optimising what nobody measured.
 *
 * So: a bot that travelled < 1 m in 60 s is a NUMBER, and a fix either moves it
 * or does not. Every question this file answers is one somebody would otherwise
 * have to answer by squinting.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It does not decide what the answer should be. If the bots turn out to move
 * fine and something else is broken, the report says so — see `verdicts`, which
 * are derived from the measurements and never from expectation.
 *
 * DETERMINISM: same boot, same seed, same tick count, no wall-clock read
 * anywhere in this file (`tools/soak.mjs` owns the stopwatch). Two runs of the
 * same build produce the same report.
 */
import * as THREE from 'three';
import {
  BotBehaviour,
  Btn,
  CaptureState,
  MatchPhase,
  MoveMode,
  Sim,
  Team,
  TickPhase,
  type CharacterConfig,
  type EntityId,
  type NavService,
  type PlayerIntent,
  type TickCtx,
  type TickSystem,
  type Vec3,
} from '@/engine/types';
import type { IronEngine } from '@/engine/engine';

/* ============================================================== public shape */

export interface SoakOptions {
  /** Simulated seconds to run. The headline number is "distance in 60 s". */
  seconds?: number;
  /**
   * Render one frame every N simulated ticks; 0 renders none at all.
   *
   * Rendering is ~95% of `stepFrame`, and the simulation is not allowed to read
   * presentation state (architecture §3.3), so a soak can skip almost all of it.
   * Kept configurable rather than hardcoded to 0 precisely so that claim is
   * testable: run once at 0 and once at 1 and diff the report.
   */
  renderEvery?: number;
  seed?: number;
  /**
   * How the local player is driven.
   *   'uphill'  — GRADIENT ASCENT: re-steer up the local terrain gradient every
   *               tick while holding W, so the walk is uphill for its whole
   *               length rather than only at the instant it started. Bug #1's
   *               probe, and the reason it is not just "aim once and hold W":
   *               a one-shot heading wanders off the slope within a few metres
   *               and then reports that the bug does not reproduce.
   *   'sweep'   — hold W while yawing slowly, covering every heading and slope.
   *   'forward' — hold W from wherever the spawn left us facing.
   *   'none'    — no scripted input; the player stands still.
   */
  walk?: 'uphill' | 'sweep' | 'forward' | 'none';
  /** Hold Sprint as well as forward. */
  sprint?: boolean;
  /** Capture-ownership / population timeline resolution, samples per second. */
  timelineHz?: number;
  /** Cap on individually-reported stuck ticks, so the JSON stays readable. */
  maxStuckSamples?: number;
}

interface SoakApi {
  readonly available: true;
  run(options?: SoakOptions): Promise<SoakReport>;
  /**
   * THE LONG SOAK. A 10–30 minute run that answers a different question from
   * `run`: not "does anything move" but "does anything LEAK". It steps the same
   * fixed-timestep simulation, renders on a cadence so the renderer's own
   * allocations are exercised, and samples the JS heap, GPU-resource residency,
   * live entity count and per-frame CPU time on a wall-INDEPENDENT sim clock.
   * `tools/soak.sh --profile` drives it; see `runProfile`.
   */
  profile(options?: ProfileOptions): Promise<ProfileReport>;
}

declare global {
  // eslint-disable-next-line no-var
  var __SOAK__: SoakApi | undefined;
}

/* ------------------------------------------------------------- report shape */

export interface BotTrack {
  entity: number;
  team: string;
  name: string;
  /** True once this entity was seen in `PlayerService.controlled`. */
  attached: boolean;
  firstTick: number;
  lastTick: number;
  ticksObserved: number;
  start: [number, number, number];
  end: [number, number, number];
  /** Metres of path walked, teleports excluded. THE headline per-bot number. */
  distance: number;
  /** Straight-line start→end. Distance ≫ displacement means pacing in circles. */
  displacement: number;
  maxSpeed: number;
  meanSpeed: number;
  /** Position deltas too large to be locomotion — spawns, respawns, teleports. */
  teleports: number;
  /** Ticks whose position delta was under 1 mm. */
  frozenTicks: number;
  /**
   * Longest UNBROKEN run of frozen ticks, in ticks.
   *
   * `frozenTicks` alone cannot tell "shuffles constantly, nets nothing" apart
   * from "walked five metres then wedged against a crate for fifty seconds",
   * and those are different bugs with different fixes.
   */
  longestFreezeTicks: number;
  behaviours: Record<string, number>;
  ticksWithTarget: number;
  distinctTargets: number;
  navPathsRequested: number;
}

export interface StuckSample {
  tick: number;
  time: number;
  position: [number, number, number];
  /** Metres moved on this tick while input was full forward. */
  step: number;
  /** Degrees from horizontal of the TERRAIN under the player. */
  terrainSlopeDeg: number;
  /**
   * Degrees of the terrain over the next `PROBE_AHEAD_M` ALONG THE FACING.
   *
   * This, not `terrainSlopeDeg`, is the number bug #1 is about. A player halted
   * at the foot of a bank is standing on flat ground: slope-underfoot reads ~0
   * and slope-ahead reads the wall they cannot climb. Measuring the wrong one
   * produces a confident "stalls are unrelated to slope".
   */
  aheadSlopeDeg: number;
  /** Player y minus terrain height. Large ⇒ standing on level geometry, not terrain. */
  terrainClearance: number;
  grounded: boolean;
  moveMode: string;
  yawDeg: number;
}

export interface StallEpisode {
  startTick: number;
  startTime: number;
  ticks: number;
  seconds: number;
  position: [number, number, number];
  aheadSlopeDeg: number;
  terrainSlopeDeg: number;
  terrainClearance: number;
  /** False when the run ended still stalled — i.e. the player never got free. */
  recovered: boolean;
}

export interface SoakReport {
  ok: boolean;
  config: Record<string, unknown>;
  engine: Record<string, unknown>;
  schedule: Record<string, unknown>;
  bots: Record<string, unknown>;
  nav: Record<string, unknown>;
  combat: Record<string, unknown>;
  mode: Record<string, unknown>;
  player: Record<string, unknown>;
  verdicts: Array<{ id: string; level: 'ok' | 'warn' | 'fail'; message: string }>;
  errors: string[];
}

/* --------------------------------------------------------- profile shape */

export interface ProfileOptions {
  /** Simulated MINUTES to run. Clamped 1..30; the headline is a 30-min soak. */
  minutes?: number;
  seed?: number;
  /**
   * How the local player is driven for the whole run. 'sweep' is the default
   * here (not 'uphill'): a leak soak wants continuous, varied locomotion across
   * the map so movement, nav, VFX and audio all keep churning, not a probe of
   * one hill. See `SoakOptions.walk` for the mode semantics.
   */
  walk?: 'uphill' | 'sweep' | 'forward' | 'none';
  sprint?: boolean;
  /**
   * Render one frame per N simulated ticks. A leak soak must render SOME frames
   * — GPU-resource and renderer-side leaks are invisible to `stepSimOnly` — but
   * rendering every tick would make a 30-min soak an hour of wall time under the
   * software rasteriser, so the default is a cadence, not every frame.
   */
  renderEvery?: number;
  /** Heap / resource sample cadence, in SIMULATED seconds. Default 5. */
  sampleEverySec?: number;
  /**
   * Forced-GC retained-heap cadence, in simulated seconds. Default 30. Only
   * fires when `globalThis.gc` exists; otherwise the trough tracker carries the
   * leak signal on its own.
   */
  gcEverySec?: number;
  /** Ticks between host yields. Also the raw-heap / GC-drop sample stride. */
  batchTicks?: number;
}

/** One heap/resource/frame-time sample, taken every `sampleEverySec`. */
export interface ProfileSample {
  /** Simulated minutes since the run began. */
  tMin: number;
  tick: number;
  /** `performance.memory.usedJSHeapSize`, MiB. −1 when the API is unavailable. */
  heapUsedMB: number;
  heapTotalMB: number;
  /** three.js resident GPU resources — the GPU-leak counterpart of the heap. */
  geometries: number;
  textures: number;
  programs: number;
  /** Live engine entities. Should plateau at the match population, not climb. */
  entities: number;
  botsAlive: number;
  /** Rendered frames in THIS window and their CPU-time distribution (ms). */
  frames: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  /** Raw-heap drops seen this window (natural or forced GCs) and MiB reclaimed. */
  gcDrops: number;
  reclaimedMB: number;
}

/** A post-collection retained-heap reading — the clean leak-trend series. */
export interface RetainedSample {
  tMin: number;
  tick: number;
  retainedMB: number;
}

export interface ProfileReport {
  ok: boolean;
  config: Record<string, unknown>;
  engine: Record<string, unknown>;
  /** Which signal carried the leak verdict: 'retained' (forced GC) or 'trough'. */
  leakSignal: 'retained' | 'trough' | 'none';
  memory: Record<string, unknown>;
  frameTime: Record<string, unknown>;
  gc: Record<string, unknown>;
  resources: Record<string, unknown>;
  samples: ProfileSample[];
  retained: RetainedSample[];
  verdicts: Array<{ id: string; level: 'ok' | 'warn' | 'fail'; message: string }>;
  errors: string[];
}

/* =================================================================== install */

let installed: IronEngine | null = null;

/** Called once by `src/main.ts`, right after `attachDriver`. */
export function installSoak(engine: IronEngine): void {
  installed = engine;
  globalThis.__SOAK__ = {
    available: true,
    run: (options?: SoakOptions) => runSoak(engine, options ?? {}),
    profile: (options?: ProfileOptions) => runProfile(engine, options ?? {}),
  };
}

export function soakEngine(): IronEngine | null {
  return installed;
}

/* ================================================================== tunables */

/** A per-tick position delta above this is a spawn/teleport, not locomotion. */
const TELEPORT_STEP_M = 1.0;
/** Under this, the body did not meaningfully move on this tick. */
const FROZEN_STEP_M = 0.001;
/**
 * A tick counts as STUCK when input was full forward, the actor was grounded and
 * alive, and it advanced less than this. 0.3 m/s is a fifth of walk speed — slow
 * enough that nothing which is merely decelerating trips it.
 */
const STUCK_STEP_M = 0.3 / Sim.TICK_HZ;
/** The bar bug #2 and #3 are measured against. */
const MOVED_AT_ALL_M = 1.0;
/**
 * How far ahead the terrain is probed for the slope the player is walking INTO.
 * Roughly one stride: far enough to see the bank, near enough that it is the
 * obstacle actually being contacted this tick.
 */
const PROBE_AHEAD_M = 0.6;
/**
 * Ticks of settle before stall accounting starts. The very first tick after a
 * reset teleports the capsule onto the ground and reads as a stall that belongs
 * to the harness, not to the game.
 */
const SETTLE_TICKS = 15;
/** Radians per tick the gradient-ascent walk may turn. 90°/s. */
const TURN_RATE = (Math.PI / 2) / Sim.TICK_HZ;

/* ============================================================ nav call probe */

interface CallStat {
  calls: number;
  ok: number;
  fail: number;
}

const emptyStat = (): CallStat => ({ calls: 0, ok: 0, fail: 0 });

/**
 * Counts nav traffic by PATCHING THE LIVE NAV INSTANCE rather than swapping the
 * registry entry.
 *
 * A lane is free to cache `ctx.services.nav` in its constructor, and several do
 * — so replacing the registry entry would count nothing and report a confident
 * zero, which is worse than no instrument. Patching the object every caller
 * already holds cannot be bypassed. Restored in `restore()`; the patch never
 * survives a run.
 */
class NavProbe {
  readonly findPath = emptyStat();
  readonly sample = emptyStat();
  readonly raycastWalkable = emptyStat();
  readonly randomPointNear = emptyStat();
  readonly failReasons: Record<string, number> = {};
  /** entity → path requests, attributed by whoever was mid-tick. Best effort. */
  cornerHistogram: Record<string, number> = {};

  private restoreFns: Array<() => void> = [];
  private readonly probeA = new THREE.Vector3();

  constructor(private readonly nav: NavService) {}

  install(): void {
    const nav = this.nav as unknown as Record<string, unknown>;
    const patch = (key: string, make: (orig: (...a: never[]) => unknown) => unknown): void => {
      const orig = nav[key];
      if (typeof orig !== 'function') return;
      const bound = (orig as (...a: never[]) => unknown).bind(this.nav);
      nav[key] = make(bound as (...a: never[]) => unknown);
      this.restoreFns.push(() => {
        nav[key] = orig;
      });
    };

    patch('findPath', (orig) => (from: Vec3, to: Vec3, out: Vec3[]): number => {
      const n = orig(from as never, to as never, out as never) as number;
      this.findPath.calls++;
      if (n > 0) {
        this.findPath.ok++;
        const bucket = n >= 8 ? '8+' : String(n);
        this.cornerHistogram[bucket] = (this.cornerHistogram[bucket] ?? 0) + 1;
      } else {
        this.findPath.fail++;
        this.note(this.classify(from, to));
      }
      return n;
    });

    patch('sample', (orig) => (position: Vec3, radius: number, out: Vec3): boolean => {
      const hit = orig(position as never, radius as never, out as never) as boolean;
      this.sample.calls++;
      if (hit) this.sample.ok++;
      else this.sample.fail++;
      return hit;
    });

    patch('raycastWalkable', (orig) => (from: Vec3, to: Vec3, out: Vec3): boolean => {
      const hit = orig(from as never, to as never, out as never) as boolean;
      this.raycastWalkable.calls++;
      if (hit) this.raycastWalkable.ok++;
      else this.raycastWalkable.fail++;
      return hit;
    });

    patch('randomPointNear', (orig) => (position: Vec3, radius: number, rng: unknown, out: Vec3): boolean => {
      const hit = orig(position as never, radius as never, rng as never, out as never) as boolean;
      this.randomPointNear.calls++;
      if (hit) this.randomPointNear.ok++;
      else this.randomPointNear.fail++;
      return hit;
    });
  }

  /**
   * Why did that path fail? Re-queries `sample` for the endpoints, which is a
   * pure read with no RNG draw, so it cannot perturb the run — and only on the
   * failure branch, so the cost is bounded by the number of failures.
   */
  private classify(from: Vec3, to: Vec3): string {
    if (!this.nav.ready) return 'nav-not-ready';
    // Call through the ORIGINAL sample, not the patched one, or the sample
    // counters would double-count our own diagnosis as lane traffic.
    const before = { ...this.sample };
    const startOk = this.nav.sample(from, 4, this.probeA);
    const goalOk = this.nav.sample(to, 4, this.probeA);
    this.sample.calls = before.calls;
    this.sample.ok = before.ok;
    this.sample.fail = before.fail;
    if (!startOk && !goalOk) return 'both-endpoints-off-navmesh';
    if (!startOk) return 'start-off-navmesh';
    if (!goalOk) return 'goal-off-navmesh';
    return 'no-corridor-between-endpoints';
  }

  private note(reason: string): void {
    this.failReasons[reason] = (this.failReasons[reason] ?? 0) + 1;
  }

  restore(): void {
    for (const fn of this.restoreFns) fn();
    this.restoreFns = [];
  }
}

/* ===================================================================== run */

interface BotState {
  track: BotTrack;
  prev: THREE.Vector3;
  targets: Set<number>;
  speedSum: number;
  speedSamples: number;
  freezeRun: number;
}

async function runSoak(engine: IronEngine, options: SoakOptions): Promise<SoakReport> {
  const seconds = clampNum(options.seconds ?? 60, 1, 3600);
  const dt = Sim.TICK_DT;
  const totalTicks = Math.max(1, Math.round(seconds * Sim.TICK_HZ));
  const renderEvery = Math.max(0, Math.floor(options.renderEvery ?? 30));
  const seed = options.seed ?? 0x1205;
  const walk = options.walk ?? 'uphill';
  const sprint = options.sprint ?? false;
  const timelineHz = clampNum(options.timelineHz ?? 1, 0.1, 10);
  const timelineEvery = Math.max(1, Math.round(Sim.TICK_HZ / timelineHz));
  const maxStuckSamples = Math.max(0, Math.floor(options.maxStuckSamples ?? 40));

  const errors: string[] = [];
  const s = engine.services;
  const driver = engine.driver;

  /* -- 1. take the world, exactly as a capture does ------------------------ */
  driver.setLoopSuspended(true);
  const tickAtStart = engine.clock.tick;
  const frameAtStart = engine.clock.frame;

  const navProbe = new NavProbe(s.nav);
  let sampler: (() => void) | null = null;
  const unsubs: Array<() => void> = [];

  try {
    driver.context.seed(seed);

    /* -- 2. instrument ---------------------------------------------------- */
    engine.loop.setCounting(true);
    navProbe.install();

    const combat = {
      weaponFired: 0,
      shotsByBots: 0,
      shotsByPlayer: 0,
      distinctShooters: new Set<number>(),
      damageApplied: 0,
      damageToPlayers: 0,
      kills: 0,
      headshots: 0,
      dryFires: 0,
      reloads: 0,
      noises: 0,
      spawnedEntities: 0,
    };
    const objectives = {
      progressEvents: 0,
      captured: [] as Array<{ tick: number; point: string; team: string }>,
      neutralised: [] as Array<{ tick: number; point: string; from: string }>,
      phaseChanges: [] as Array<{ tick: number; phase: string }>,
    };

    const localEntity = s.player.localEntity as number;
    unsubs.push(
      s.events.on('weapon.fired', (e) => {
        combat.weaponFired++;
        combat.distinctShooters.add(e.shooter as number);
        if ((e.shooter as number) === localEntity) combat.shotsByPlayer++;
        else combat.shotsByBots++;
      }),
      s.events.on('weapon.dryFire', () => combat.dryFires++),
      s.events.on('weapon.reloadStart', () => combat.reloads++),
      s.events.on('damage.applied', (e) => {
        combat.damageApplied++;
        if (e.target !== e.attacker) combat.damageToPlayers++;
      }),
      s.events.on('entity.killed', (e) => {
        combat.kills++;
        if (e.headshot) combat.headshots++;
      }),
      s.events.on('entity.spawned', () => combat.spawnedEntities++),
      s.events.on('noise.emitted', () => combat.noises++),
      s.events.on('objective.progress', () => objectives.progressEvents++),
      s.events.on('objective.captured', (e) =>
        objectives.captured.push({ tick: engine.clock.tick, point: String(e.point), team: Team[e.team] }),
      ),
      s.events.on('objective.neutralised', (e) =>
        objectives.neutralised.push({ tick: engine.clock.tick, point: String(e.point), from: Team[e.from] }),
      ),
      s.events.on('match.phase', (e) =>
        objectives.phaseChanges.push({ tick: engine.clock.tick, phase: MatchPhase[e.phase] }),
      ),
    );

    /* -- 3. arm the local player ------------------------------------------ */
    const player = s.player;
    const localStart = new THREE.Vector3().copy(player.state.position);
    let armedYawDeg: number | null = null;
    let uphillSlopeDeg: number | null = null;

    if (walk === 'uphill') {
      const yaw = uphillYaw(s.terrain, localStart.x, localStart.z);
      if (yaw !== null) {
        player.teleport(player.state.entity, localStart, yaw, 0);
        armedYawDeg = (yaw * 180) / Math.PI;
      } else {
        errors.push('walk=uphill: terrain gradient is zero at the spawn; heading left as-is');
      }
      uphillSlopeDeg = (s.terrain.slopeAt(localStart.x, localStart.z) * 180) / Math.PI;
    }

    const scripted: Partial<PlayerIntent> = {
      moveX: 0,
      moveZ: walk === 'none' ? 0 : 1,
      lookYaw: 0,
      lookPitch: 0,
      buttons: sprint && walk !== 'none' ? Btn.Sprint : 0,
      weaponSlot: -1,
      aimAt: null,
    };
    // 'sweep' yaws a full turn every 20 s, so the walk crosses every heading and
    // therefore every slope on the way out of the spawn bowl.
    const sweepPerTick = (2 * Math.PI) / (20 * Sim.TICK_HZ);
    s.input.setScripted(scripted);

    /* -- 4. the sampler --------------------------------------------------- */
    const bots = new Map<number, BotState>();
    const timeline: Array<Record<string, unknown>> = [];
    const stuckSamples: StuckSample[] = [];
    const episodes: StallEpisode[] = [];
    let openEpisode: StallEpisode | null = null;
    const slopeBuckets = new Map<number, { ticks: number; stuck: number; stepSum: number }>();
    const aheadVec = new THREE.Vector3();
    /**
     * The SAME ahead-slope histogram, for bots.
     *
     * Without it, "the player stalls on hills" and "bots freeze" are two
     * separate reports and someone fixes them twice. Bucketed identically so the
     * two tables can be read side by side, and restricted to bots actually
     * standing on terrain — a bot wedged on a staircase says nothing about a
     * slope limit, and lumping the two together would blur the very cliff the
     * player's table found.
     */
    const botSlopeBuckets = new Map<number, { ticks: number; frozen: number }>();
    let botTicksOnTerrain = 0;
    let botTicksOffTerrain = 0;

    const localPrev = new THREE.Vector3().copy(player.state.position);
    const localTrack = {
      distance: 0,
      displacement: 0,
      maxSpeed: 0,
      stuckTicks: 0,
      movingTicks: 0,
      airTicks: 0,
      groundedTicks: 0,
      deadTicks: 0,
      teleports: 0,
      forwardTicks: 0,
    };
    const moveModes: Record<string, number> = {};
    let controlledMax = 0;
    let ticksRun = 0;
    let framesRendered = 0;

    const tmp = new THREE.Vector3();

    const system: TickSystem = {
      name: 'core.soakSampler',
      // Cleanup is CORE's phase and this is CORE's system. order 999 puts it
      // after every gameplay phase and immediately before `core.cleanup`, so it
      // observes the tick's final state and nothing observes it.
      phase: TickPhase.Cleanup,
      order: 999,
      tick: (ctx: TickCtx): void => {
        ticksRun++;
        const settled = ticksRun > SETTLE_TICKS;

        /* ---- bots */
        const controlled = new Set<number>();
        for (const e of s.player.controlled) controlled.add(e as number);
        controlledMax = Math.max(controlledMax, controlled.size);

        for (const view of s.ai.bots) {
          const key = view.entity as number;
          let st = bots.get(key);
          if (!st) {
            st = {
              track: {
                entity: key,
                team: Team[view.team] ?? String(view.team),
                name: view.name,
                attached: false,
                firstTick: ctx.tick,
                lastTick: ctx.tick,
                ticksObserved: 0,
                start: vec(view.position),
                end: vec(view.position),
                distance: 0,
                displacement: 0,
                maxSpeed: 0,
                meanSpeed: 0,
                teleports: 0,
                frozenTicks: 0,
                longestFreezeTicks: 0,
                behaviours: {},
                ticksWithTarget: 0,
                distinctTargets: 0,
                navPathsRequested: 0,
              },
              prev: new THREE.Vector3().copy(view.position),
              targets: new Set<number>(),
              speedSum: 0,
              speedSamples: 0,
              freezeRun: 0,
            };
            bots.set(key, st);
          }
          const t = st.track;
          if (controlled.has(key)) t.attached = true;
          t.lastTick = ctx.tick;
          t.ticksObserved++;

          const step = tmp.copy(view.position).sub(st.prev).length();
          if (step > TELEPORT_STEP_M) {
            t.teleports++;
          } else {
            t.distance += step;
            const speed = step / ctx.dt;
            if (speed > t.maxSpeed) t.maxSpeed = speed;
            st.speedSum += speed;
            st.speedSamples++;
            if (step < FROZEN_STEP_M) {
              t.frozenTicks++;
              st.freezeRun++;
              if (st.freezeRun > t.longestFreezeTicks) t.longestFreezeTicks = st.freezeRun;
            } else {
              st.freezeRun = 0;
            }
          }
          st.prev.copy(view.position);
          t.end = vec(view.position);

          // Same probe as the player's, along the bot's own facing.
          if (settled && step <= TELEPORT_STEP_M) {
            const hereH = s.terrain.heightAt(view.position.x, view.position.z);
            if (Math.abs(view.position.y - hereH) < 0.5) {
              botTicksOnTerrain++;
              aheadVec.copy(view.forward).setY(0);
              if (aheadVec.lengthSq() > 1e-6) {
                aheadVec.normalize().multiplyScalar(PROBE_AHEAD_M).add(view.position);
                const aheadDeg =
                  (Math.atan2(s.terrain.heightAt(aheadVec.x, aheadVec.z) - hereH, PROBE_AHEAD_M) * 180) / Math.PI;
                const bkt = clampNum(Math.floor(aheadDeg / 5) * 5, -30, 60);
                const a = botSlopeBuckets.get(bkt) ?? { ticks: 0, frozen: 0 };
                a.ticks++;
                if (step < FROZEN_STEP_M) a.frozen++;
                botSlopeBuckets.set(bkt, a);
              }
            } else {
              botTicksOffTerrain++;
            }
          }

          const b = BotBehaviour[view.behaviour] ?? String(view.behaviour);
          t.behaviours[b] = (t.behaviours[b] ?? 0) + 1;
          if ((view.target as number) !== 0) {
            t.ticksWithTarget++;
            st.targets.add(view.target as number);
          }
        }

        /* ---- local player */
        const ps = s.player.state;
        const alive = ps.alive;
        const step = tmp.copy(ps.position).sub(localPrev).length();
        if (step > TELEPORT_STEP_M) {
          localTrack.teleports++;
        } else {
          localTrack.distance += step;
          const speed = step / ctx.dt;
          if (speed > localTrack.maxSpeed) localTrack.maxSpeed = speed;
        }
        localPrev.copy(ps.position);
        if (ps.grounded) localTrack.groundedTicks++;
        else localTrack.airTicks++;
        if (!alive) localTrack.deadTicks++;
        const mm = ps.move === undefined ? 'unknown' : (MoveMode[ps.move] ?? String(ps.move));
        moveModes[mm] = (moveModes[mm] ?? 0) + 1;

        /* ---- re-steer up the gradient. Done AFTER reading this tick's state so
         * the yaw we command is the one the NEXT tick walks with, which is the
         * same one-tick relationship a human's mouse has. */
        if (walk === 'sweep') {
          scripted.lookYaw = sweepPerTick;
        } else if (walk === 'uphill') {
          const want = uphillYaw(s.terrain, ps.position.x, ps.position.z);
          scripted.lookYaw = want === null ? 0 : clampNum(shortestAngle(want - ps.yaw), -TURN_RATE, TURN_RATE);
        }

        const commandingForward = walk !== 'none' && alive && settled;
        if (commandingForward) {
          localTrack.forwardTicks++;
          const terrainH = s.terrain.heightAt(ps.position.x, ps.position.z);
          const slopeDeg = (s.terrain.slopeAt(ps.position.x, ps.position.z) * 180) / Math.PI;
          // The slope being walked INTO, which is what "can't get up the hill"
          // is about — not the slope of the flat ground it is standing on.
          aheadVec.set(-Math.sin(ps.yaw), 0, -Math.cos(ps.yaw)).multiplyScalar(PROBE_AHEAD_M).add(ps.position);
          const aheadH = s.terrain.heightAt(aheadVec.x, aheadVec.z);
          const aheadSlopeDeg = (Math.atan2(aheadH - terrainH, PROBE_AHEAD_M) * 180) / Math.PI;

          const bucket = clampNum(Math.floor(aheadSlopeDeg / 5) * 5, -30, 60);
          const acc = slopeBuckets.get(bucket) ?? { ticks: 0, stuck: 0, stepSum: 0 };
          acc.ticks++;
          acc.stepSum += step;

          const isStuck = step < STUCK_STEP_M && ps.grounded && step <= TELEPORT_STEP_M;
          if (isStuck) {
            acc.stuck++;
            localTrack.stuckTicks++;
            if (!openEpisode) {
              openEpisode = {
                startTick: ctx.tick,
                startTime: round(ticksRun * ctx.dt, 3),
                ticks: 0,
                seconds: 0,
                position: vec(ps.position).map((v) => round(v, 2)) as [number, number, number],
                aheadSlopeDeg: round(aheadSlopeDeg, 2),
                terrainSlopeDeg: round(slopeDeg, 2),
                terrainClearance: round(ps.position.y - terrainH, 3),
                recovered: false,
              };
            }
            openEpisode.ticks++;
            if (stuckSamples.length < maxStuckSamples) {
              stuckSamples.push({
                tick: ctx.tick,
                time: round(ticksRun * ctx.dt, 3),
                position: vec(ps.position).map((v) => round(v, 2)) as [number, number, number],
                step: round(step, 5),
                terrainSlopeDeg: round(slopeDeg, 2),
                aheadSlopeDeg: round(aheadSlopeDeg, 2),
                terrainClearance: round(ps.position.y - terrainH, 3),
                grounded: ps.grounded,
                moveMode: mm,
                yawDeg: round((ps.yaw * 180) / Math.PI, 1),
              });
            }
          } else {
            localTrack.movingTicks++;
            if (openEpisode) {
              openEpisode.seconds = round(openEpisode.ticks * ctx.dt, 3);
              openEpisode.recovered = true;
              episodes.push(openEpisode);
              openEpisode = null;
            }
          }
          slopeBuckets.set(bucket, acc);
        }

        /* ---- objectives, sampled rather than every tick */
        if (ticksRun === 1 || ticksRun % timelineEvery === 0) {
          const ms = s.mode.state;
          timeline.push({
            t: round(ticksRun * ctx.dt, 2),
            phase: MatchPhase[ms.phase] ?? String(ms.phase),
            tickets: { Coalition: ms.tickets[Team.Coalition], Insurgent: ms.tickets[Team.Insurgent] },
            botsAlive: s.ai.count,
            controlled: controlled.size,
            points: ms.points.map((p) => ({
              id: String(p.id),
              owner: Team[p.owner] ?? String(p.owner),
              state: CaptureState[p.state] ?? String(p.state),
              progress: round(p.progress, 3),
              occ: [p.occupants[Team.Coalition], p.occupants[Team.Insurgent]],
            })),
          });
        }
      },
    };
    sampler = engine.addTick(system);

    /* -- 5. run ------------------------------------------------------------ */
    for (let i = 0; i < totalTicks; i++) {
      if (renderEvery > 0 && i % renderEvery === 0) {
        engine.stepFrame(dt);
        framesRendered++;
      } else {
        engine.stepSimOnly(dt);
      }
      // Yield to the event loop once a simulated second so the page stays
      // responsive and Playwright's own timers keep firing. Purely a host
      // courtesy: the simulation is fixed-dt and cannot notice.
      if (i % 60 === 59) await yieldToHost();
    }

    /* -- 6. compose -------------------------------------------------------- */
    // A stall still open when the clock ran out never recovered. That is the
    // worst case and it must not be dropped for being unterminated.
    if (openEpisode) {
      const ep: StallEpisode = openEpisode;
      ep.seconds = round(ep.ticks * dt, 3);
      ep.recovered = false;
      episodes.push(ep);
      openEpisode = null;
    }
    episodes.sort((a, b) => b.ticks - a.ticks);

    const schedule = engine.loop.describe();
    const counts = engine.loop.callCounts();
    const byPhase = new Map<number, Array<{ name: string; calls: number }>>();
    for (const t of schedule.ticks) {
      const list = byPhase.get(t.phase as number) ?? [];
      list.push({ name: t.name, calls: counts.ticks[t.name] ?? 0 });
      byPhase.set(t.phase as number, list);
    }
    const phaseReport: Record<string, unknown> = {};
    for (const [phase, list] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
      phaseReport[TickPhase[phase] ?? String(phase)] = { systems: list.length, detail: list };
    }
    const gameplayPhases = [TickPhase.Intent, TickPhase.Ai, TickPhase.Movement].map((p) => {
      const list = byPhase.get(p) ?? [];
      return {
        phase: TickPhase[p],
        systems: list.length,
        called: list.reduce((n, x) => n + x.calls, 0),
        expectedCallsPerSystem: ticksRun,
        detail: list,
      };
    });

    const botTracks: BotTrack[] = [];
    for (const st of bots.values()) {
      const t = st.track;
      t.meanSpeed = st.speedSamples > 0 ? round(st.speedSum / st.speedSamples, 4) : 0;
      t.distance = round(t.distance, 3);
      t.maxSpeed = round(t.maxSpeed, 3);
      t.distinctTargets = st.targets.size;
      t.displacement = round(
        Math.hypot(t.end[0] - t.start[0], t.end[1] - t.start[1], t.end[2] - t.start[2]),
        3,
      );
      t.start = t.start.map((v) => round(v, 2)) as [number, number, number];
      t.end = t.end.map((v) => round(v, 2)) as [number, number, number];
      botTracks.push(t);
    }
    botTracks.sort((a, b) => a.distance - b.distance);

    const aliveByTeam: Record<string, number> = { Coalition: 0, Insurgent: 0, Neutral: 0 };
    for (const view of s.ai.bots) aliveByTeam[Team[view.team] ?? 'Neutral']++;

    const stationary = botTracks.filter((t) => t.distance < MOVED_AT_ALL_M);
    const unattached = botTracks.filter((t) => !t.attached);
    const everTargeted = botTracks.filter((t) => t.ticksWithTarget > 0);

    const slopeHistogram = [...slopeBuckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucket, acc]) => ({
        aheadSlopeDeg: `${bucket}..${bucket + 5}`,
        ticks: acc.ticks,
        stuckTicks: acc.stuck,
        stuckFraction: round(acc.stuck / Math.max(1, acc.ticks), 3),
        meanStepM: round(acc.stepSum / Math.max(1, acc.ticks), 5),
        meanSpeedMs: round((acc.stepSum / Math.max(1, acc.ticks)) * Sim.TICK_HZ, 3),
      }));

    const ps = s.player.state;
    const report: SoakReport = {
      ok: true,
      config: {
        seconds,
        ticksRequested: totalTicks,
        dt,
        tickHz: Sim.TICK_HZ,
        renderEvery,
        framesRendered,
        seed,
        walk,
        sprint,
        timelineHz,
      },
      engine: {
        tickAtStart,
        tickAtEnd: engine.clock.tick,
        ticksRun,
        frameAtStart,
        frameAtEnd: engine.clock.frame,
        deterministic: engine.clock.deterministic,
        qualityTier: s.quality.settings.tier,
        maxBots: s.quality.settings.ai.maxBots,
        nullServices: engine.registry.nullKeys(),
        physicsReady: s.physics.ready,
        terrainReady: s.terrain.ready,
        navReady: s.nav.ready,
      },
      schedule: {
        tickSystems: schedule.ticks.length,
        renderSystems: schedule.renders.length,
        gameplayPhases,
        byPhase: phaseReport,
      },
      bots: {
        distinctEntitiesSeen: botTracks.length,
        aliveAtEnd: s.ai.count,
        aliveByTeam,
        controlledPeak: controlledMax,
        attached: botTracks.length - unattached.length,
        unattached: unattached.map((t) => t.entity),
        movedUnder1m: stationary.length,
        movedUnder1mEntities: stationary.map((t) => t.entity),
        everAcquiredTarget: everTargeted.length,
        totalDistance: round(botTracks.reduce((n, t) => n + t.distance, 0), 2),
        medianDistance: round(median(botTracks.map((t) => t.distance)), 3),
        maxDistance: round(Math.max(0, ...botTracks.map((t) => t.distance)), 3),
        // Aggregate freeze load. `frozenTickFraction` near 1 with a non-zero
        // median distance is the signature of bots that lurch and wedge rather
        // than bots that never received an intent — a different bug entirely.
        frozenTickFraction: round(
          botTracks.reduce((n, t) => n + t.frozenTicks, 0) /
            Math.max(1, botTracks.reduce((n, t) => n + t.ticksObserved, 0)),
          4,
        ),
        longestFreezeTicks: Math.max(0, ...botTracks.map((t) => t.longestFreezeTicks)),
        longestFreezeSeconds: round(Math.max(0, ...botTracks.map((t) => t.longestFreezeTicks)) * dt, 2),
        ticksOnTerrain: botTicksOnTerrain,
        ticksOffTerrain: botTicksOffTerrain,
        slopeHistogram: [...botSlopeBuckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([bucket, acc]) => ({
            aheadSlopeDeg: `${bucket}..${bucket + 5}`,
            ticks: acc.ticks,
            frozenTicks: acc.frozen,
            frozenFraction: round(acc.frozen / Math.max(1, acc.ticks), 3),
          })),
        perBot: botTracks,
      },
      nav: {
        ready: s.nav.ready,
        hasBuildHook: typeof s.nav.build === 'function',
        findPath: { ...navProbe.findPath, failReasons: navProbe.failReasons, cornerHistogram: navProbe.cornerHistogram },
        sample: navProbe.sample,
        raycastWalkable: navProbe.raycastWalkable,
        randomPointNear: navProbe.randomPointNear,
      },
      combat: {
        shotsFired: combat.weaponFired,
        shotsByBots: combat.shotsByBots,
        shotsByPlayer: combat.shotsByPlayer,
        distinctShooters: combat.distinctShooters.size,
        damageEvents: combat.damageApplied,
        kills: combat.kills,
        headshots: combat.headshots,
        reloads: combat.reloads,
        dryFires: combat.dryFires,
        noiseEvents: combat.noises,
        entitiesSpawned: combat.spawnedEntities,
      },
      mode: {
        phase: MatchPhase[s.mode.state.phase] ?? String(s.mode.state.phase),
        phaseChanges: objectives.phaseChanges,
        tickets: {
          Coalition: s.mode.state.tickets[Team.Coalition],
          Insurgent: s.mode.state.tickets[Team.Insurgent],
          max: s.mode.state.ticketsMax,
        },
        objectiveProgressEvents: objectives.progressEvents,
        captured: objectives.captured,
        neutralised: objectives.neutralised,
        ownershipChanges: countOwnershipChanges(timeline),
        timeline,
      },
      player: {
        entity: localEntity,
        walk,
        // The capsule's own limits, quoted next to the measured stall threshold.
        // If the histogram's cliff sits at `maxSlopeDeg`, the bug is the limit
        // (or the surface normal fed to it) and not the acceleration model —
        // and that is a one-line diagnosis instead of an afternoon.
        capsule: capsuleOf(s.player.configOf(s.player.state.entity)),
        armedYawDeg: armedYawDeg === null ? null : round(armedYawDeg, 1),
        spawnTerrainSlopeDeg: uphillSlopeDeg === null ? null : round(uphillSlopeDeg, 2),
        start: vec(localStart).map((v) => round(v, 2)),
        end: vec(ps.position).map((v) => round(v, 2)),
        distance: round(localTrack.distance, 3),
        displacement: round(localStart.distanceTo(ps.position), 3),
        maxSpeed: round(localTrack.maxSpeed, 3),
        meanSpeed: round((localTrack.distance / Math.max(1, ticksRun)) * Sim.TICK_HZ, 3),
        forwardTicks: localTrack.forwardTicks,
        stuckTicks: localTrack.stuckTicks,
        stuckFraction: round(localTrack.stuckTicks / Math.max(1, localTrack.forwardTicks), 4),
        movingTicks: localTrack.movingTicks,
        groundedTicks: localTrack.groundedTicks,
        airTicks: localTrack.airTicks,
        deadTicks: localTrack.deadTicks,
        teleports: localTrack.teleports,
        moveModes,
        slopeHistogram,
        stallEpisodes: episodes.length,
        longestStallTicks: episodes.length ? episodes[0].ticks : 0,
        longestStallSeconds: episodes.length ? episodes[0].seconds : 0,
        endedStalled: episodes.length > 0 && episodes.some((e) => !e.recovered),
        worstStalls: episodes.slice(0, 10),
        stuckSamples,
        stuckSamplesTruncated: localTrack.stuckTicks > stuckSamples.length,
      },
      verdicts: [],
      errors,
    };

    report.verdicts = deriveVerdicts(report);
    return report;
  } catch (error) {
    return {
      ok: false,
      config: { seconds, renderEvery, seed, walk },
      engine: {},
      schedule: {},
      bots: {},
      nav: {},
      combat: {},
      mode: {},
      player: {},
      verdicts: [{ id: 'soak.threw', level: 'fail', message: String(error) }],
      errors: [...errors, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)],
    };
  } finally {
    sampler?.();
    for (const off of unsubs) off();
    navProbe.restore();
    engine.loop.setCounting(false);
    s.input.setScripted(null);
    // Leave the world parked in the same HOLD a capture leaves behind, so a soak
    // and a shot cannot disagree about what state the page is in afterwards.
    driver.setLoopSuspended(false);
  }
}

/* ============================================================ profile: leak */

const MiB = 1024 * 1024;
/** A raw-heap fall larger than this between batches is treated as a collection. */
const GC_DROP_MIB = 1.0;
/** Warm-up skipped before leak regression: pools fill and caches warm early. */
const PROFILE_WARMUP_MIN = 1.0;

interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * `performance.memory` is a non-standard Chrome-only field and absent from the
 * DOM lib types, so it is read through a narrow cast. `tools/soak.mjs` launches
 * with `--enable-precise-memory-info`, without which the numbers are quantised
 * to 100 KB buckets and coarse enough to hide a slow leak.
 */
function readHeap(): PerfMemory | null {
  const pm = (performance as unknown as { memory?: PerfMemory }).memory;
  return pm && typeof pm.usedJSHeapSize === 'number' ? pm : null;
}

/**
 * Force a full collection when the collector was exposed; report whether it ran.
 *
 * `globalThis.gc` exists only when Chromium is launched with
 * `--js-flags=--expose-gc`, which `tools/soak.mjs` does in --profile mode. It is
 * read through a cast rather than the ambient `gc` global so this stays
 * dependency-free of `@types/node`'s `GCFunction` shape. When it is absent we
 * fall back to tracking the troughs of the raw-heap sawtooth: a POST-GC retained
 * sample is the clean leak signal (only survivors count), but the rising floor
 * of the sawtooth says the same thing without a forced collection.
 */
function forceGc(): boolean {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g !== 'function') return false;
  g();
  return true;
}

/**
 * Streaming frame-time distribution. A 30-minute soak renders tens of thousands
 * of frames; storing each to sort for a percentile would itself be a leak, so
 * this bins into fixed 0.25 ms buckets (0..100 ms) and answers percentiles off
 * the cumulative histogram. Bounded memory, deterministic, no host clock read —
 * the frame CPU time is `EngineProfiler.frame.cpuMs`, measured by the ONE file
 * besides clock.ts allowed to call `performance.now()`.
 */
class FrameTimeStats {
  private readonly binMs = 0.25;
  private readonly bins = new Int32Array(400);
  count = 0;
  sum = 0;
  min = Infinity;
  max = 0;
  private overflow = 0;

  add(ms: number): void {
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
    const i = Math.floor(ms / this.binMs);
    if (i >= this.bins.length) this.overflow++;
    else this.bins[i]++;
  }

  percentile(p: number): number {
    if (this.count === 0) return 0;
    const target = p * this.count;
    let cum = 0;
    for (let i = 0; i < this.bins.length; i++) {
      cum += this.bins[i];
      if (cum >= target) return round((i + 0.5) * this.binMs, 3);
    }
    return round(this.max, 3);
  }

  mean(): number {
    return this.count > 0 ? this.sum / this.count : 0;
  }

  /** Frames at or above `ms` — the "hitch" tail that a still frame cannot show. */
  countOver(ms: number): number {
    const from = Math.min(this.bins.length, Math.ceil(ms / this.binMs));
    let n = this.overflow;
    for (let i = from; i < this.bins.length; i++) n += this.bins[i];
    return n;
  }
}

/**
 * Ordinary-least-squares slope of y against x. Used for the leak trend: y is
 * retained (or trough) MiB, x is simulated minutes, so `slope` is MiB gained per
 * minute and `r2` says how straight the climb is — a leak is a line, a warm-up
 * hump is not.
 */
function linreg(points: Array<{ x: number; y: number }>): { slope: number; intercept: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? points[0].y : 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx, r2 };
}

/**
 * THE LEAK SOAK. Steps the fixed-timestep simulation for `minutes` of sim time,
 * rendering on a cadence, and watches four things that a screenshot cannot:
 *
 *   1. JS heap over time, sampled raw AND (when `--expose-gc` is on) post-GC.
 *      A leak is a rising floor: the sawtooth troughs, or the post-GC retained
 *      series, climbing on a straight line across the run.
 *   2. GPU resources — three.js resident geometry/texture/program counts. These
 *      never touch the JS heap, so a mesh or render-target leak is invisible to
 *      (1) and needs its own eyes.
 *   3. Live entity count. Ragdolls, projectiles, decals and VFX that spawn and
 *      never free show up here before they show up as megabytes.
 *   4. Per-frame CPU time distribution, windowed, so frame-time DRIFT (the
 *      symptom that the map is filling with un-culled corpses) is separable from
 *      a constant cost.
 *
 * Determinism holds exactly as in `runSoak`: same boot, same seed, same tick
 * count, no wall-clock read in this file. `tools/soak.mjs` owns the stopwatch;
 * everything here is keyed to `tick * dt`.
 */
async function runProfile(engine: IronEngine, options: ProfileOptions): Promise<ProfileReport> {
  const minutes = clampNum(options.minutes ?? 15, 1, 30);
  const seconds = minutes * 60;
  const dt = Sim.TICK_DT;
  const totalTicks = Math.max(1, Math.round(seconds * Sim.TICK_HZ));
  const renderEvery = Math.max(1, Math.floor(options.renderEvery ?? 4));
  const seed = options.seed ?? 0x1205;
  const walk = options.walk ?? 'sweep';
  const sprint = options.sprint ?? false;
  const sampleEverySec = clampNum(options.sampleEverySec ?? 5, 1, 60);
  const gcEverySec = clampNum(options.gcEverySec ?? 30, 5, 300);
  const batchTicks = Math.max(1, Math.floor(options.batchTicks ?? 60));
  const sampleEveryTicks = Math.max(1, Math.round(sampleEverySec * Sim.TICK_HZ));
  const gcEveryTicks = Math.max(1, Math.round(gcEverySec * Sim.TICK_HZ));

  const errors: string[] = [];
  const s = engine.services;
  const driver = engine.driver;

  const heap0 = readHeap();
  const heapAvailable = heap0 !== null;
  if (!heapAvailable) {
    errors.push('performance.memory unavailable — heap columns report −1; launch Chromium with --enable-precise-memory-info.');
  }

  driver.setLoopSuspended(true);
  const tickAtStart = engine.clock.tick;
  const frameAtStart = engine.clock.frame;
  let sampler: (() => void) | null = null;

  /* -- resident-resource reader, defensive about three's info shape --------- */
  const info = engine.renderer.info as unknown as {
    memory?: { geometries?: number; textures?: number };
    programs?: { length?: number } | null;
  };
  const resources = (): { geometries: number; textures: number; programs: number } => ({
    geometries: info.memory?.geometries ?? 0,
    textures: info.memory?.textures ?? 0,
    programs: info.programs?.length ?? 0,
  });

  const samples: ProfileSample[] = [];
  const retained: RetainedSample[] = [];
  const overall = new FrameTimeStats();
  let windowStats = new FrameTimeStats();

  // Raw-heap sawtooth bookkeeping, updated once per batch.
  let lastRawHeapMB = heap0 ? heap0.usedJSHeapSize / MiB : -1;
  let windowGcDrops = 0;
  let windowReclaimedMB = 0;
  let totalGcDrops = 0;
  let totalReclaimedMB = 0;
  let peakHeapMB = lastRawHeapMB;
  let forcedGcs = 0;
  let gcExposed = false;

  const budgetCpuMs = s.quality.settings.budgets?.cpuMs ?? 16.6;
  // Hitch bar: anything past 1.5× the CPU budget is a stall a player would feel.
  const hitchMs = budgetCpuMs * 1.5;

  const r0 = resources();
  const start = {
    heapUsedMB: heap0 ? round(heap0.usedJSHeapSize / MiB, 2) : -1,
    heapLimitMB: heap0 ? round(heap0.jsHeapSizeLimit / MiB, 1) : -1,
    ...r0,
    entities: engine.entities.count,
  };

  try {
    driver.context.seed(seed);
    engine.loop.setCounting(true);

    /* -- drive the local player exactly as runSoak does ------------------- */
    const player = s.player;
    const localStart = new THREE.Vector3().copy(player.state.position);
    if (walk === 'uphill') {
      const yaw = uphillYaw(s.terrain, localStart.x, localStart.z);
      if (yaw !== null) player.teleport(player.state.entity, localStart, yaw, 0);
    }
    const scripted: Partial<PlayerIntent> = {
      moveX: 0,
      moveZ: walk === 'none' ? 0 : 1,
      lookYaw: 0,
      lookPitch: 0,
      buttons: sprint && walk !== 'none' ? Btn.Sprint : 0,
      weaponSlot: -1,
      aimAt: null,
    };
    const sweepPerTick = (2 * Math.PI) / (20 * Sim.TICK_HZ);
    s.input.setScripted(scripted);

    // Re-steer the walk from a Cleanup-phase system, same seam runSoak uses, so
    // the player keeps climbing/among the buildings for the whole soak instead
    // of walking into one wall and reporting a flat, unrepresentative heap.
    if (walk === 'sweep' || walk === 'uphill') {
      const steer: TickSystem = {
        name: 'core.profileSteer',
        phase: TickPhase.Cleanup,
        order: 998,
        tick: (): void => {
          const ps = player.state;
          if (walk === 'sweep') {
            scripted.lookYaw = sweepPerTick;
          } else {
            const want = uphillYaw(s.terrain, ps.position.x, ps.position.z);
            scripted.lookYaw = want === null ? 0 : clampNum(shortestAngle(want - ps.yaw), -TURN_RATE, TURN_RATE);
          }
        },
      };
      sampler = engine.addTick(steer);
    }

    /* -- run in batches, sampling on sim-time boundaries ------------------ */
    let ticksRun = 0;
    let framesRendered = 0;
    let nextSampleTick = sampleEveryTicks;
    let nextGcTick = gcEveryTicks;

    const takeSample = (): void => {
      const heap = readHeap();
      const res = resources();
      const usedMB = heap ? round(heap.usedJSHeapSize / MiB, 2) : -1;
      const totMB = heap ? round(heap.totalJSHeapSize / MiB, 2) : -1;
      samples.push({
        tMin: round((ticksRun * dt) / 60, 4),
        tick: engine.clock.tick,
        heapUsedMB: usedMB,
        heapTotalMB: totMB,
        geometries: res.geometries,
        textures: res.textures,
        programs: res.programs,
        entities: engine.entities.count,
        botsAlive: s.ai.count,
        frames: windowStats.count,
        frameP50: windowStats.percentile(0.5),
        frameP95: windowStats.percentile(0.95),
        frameMax: round(windowStats.max === 0 ? 0 : windowStats.max, 3),
        gcDrops: windowGcDrops,
        reclaimedMB: round(windowReclaimedMB, 2),
      });
      windowStats = new FrameTimeStats();
      windowGcDrops = 0;
      windowReclaimedMB = 0;
    };

    for (let i = 0; i < totalTicks; i++) {
      if (i % renderEvery === 0) {
        engine.stepFrame(dt);
        framesRendered++;
        const cpuMs = engine.profiler.frame.cpuMs;
        if (cpuMs > 0) {
          overall.add(cpuMs);
          windowStats.add(cpuMs);
        }
      } else {
        engine.stepSimOnly(dt);
      }
      ticksRun++;

      // Raw-heap sawtooth: read once per batch and record any collection dip.
      if (i % batchTicks === batchTicks - 1) {
        const heap = readHeap();
        if (heap) {
          const nowMB = heap.usedJSHeapSize / MiB;
          if (nowMB > peakHeapMB) peakHeapMB = nowMB;
          if (lastRawHeapMB >= 0 && lastRawHeapMB - nowMB > GC_DROP_MIB) {
            const reclaimed = lastRawHeapMB - nowMB;
            windowGcDrops++;
            windowReclaimedMB += reclaimed;
            totalGcDrops++;
            totalReclaimedMB += reclaimed;
          }
          lastRawHeapMB = nowMB;
        }
        await yieldToHost();
      }

      // Post-GC retained sample: collect, then read what survived.
      if (ticksRun >= nextGcTick) {
        nextGcTick += gcEveryTicks;
        if (forceGc()) {
          gcExposed = true;
          forcedGcs++;
          const heap = readHeap();
          if (heap) {
            const retMB = heap.usedJSHeapSize / MiB;
            retained.push({ tMin: round((ticksRun * dt) / 60, 4), tick: engine.clock.tick, retainedMB: round(retMB, 2) });
            lastRawHeapMB = retMB; // avoid counting the forced dip as a natural GC
          }
        }
      }

      if (ticksRun >= nextSampleTick) {
        nextSampleTick += sampleEveryTicks;
        takeSample();
      }
    }
    if (windowStats.count > 0 || samples.length === 0) takeSample();

    /* -- 6. compose ------------------------------------------------------- */
    const heapEnd = readHeap();
    const rEnd = resources();
    const end = {
      heapUsedMB: heapEnd ? round(heapEnd.usedJSHeapSize / MiB, 2) : -1,
      ...rEnd,
      entities: engine.entities.count,
    };

    // Leak trend: prefer the post-GC retained series; else the raw-heap troughs
    // (the minimum sample in each rolling window), which approximate what a
    // collection would have left behind without one being forced.
    let leakSignal: ProfileReport['leakSignal'] = 'none';
    let trendPoints: Array<{ x: number; y: number }> = [];
    if (retained.length >= 3) {
      leakSignal = 'retained';
      trendPoints = retained.filter((p) => p.tMin >= PROFILE_WARMUP_MIN).map((p) => ({ x: p.tMin, y: p.retainedMB }));
    } else if (heapAvailable && samples.length >= 3) {
      leakSignal = 'trough';
      trendPoints = troughSeries(samples).filter((p) => p.x >= PROFILE_WARMUP_MIN);
    }
    // If warm-up left too few points (a short run), fall back to using them all.
    if (trendPoints.length < 3) {
      if (leakSignal === 'retained') trendPoints = retained.map((p) => ({ x: p.tMin, y: p.retainedMB }));
      else if (leakSignal === 'trough') trendPoints = troughSeries(samples);
    }
    const fit = linreg(trendPoints);
    const spanMin = trendPoints.length >= 2 ? trendPoints[trendPoints.length - 1].x - trendPoints[0].x : 0;
    const growthMB = round(fit.slope * spanMin, 2);

    // Frame-time drift: first vs last fifth of the run, by rendered frame time.
    const withFrames = samples.filter((x) => x.frames > 0);
    const cut = Math.max(1, Math.floor(withFrames.length / 5));
    const firstP95 = median(withFrames.slice(0, cut).map((x) => x.frameP95));
    const lastP95 = median(withFrames.slice(-cut).map((x) => x.frameP95));

    const report: ProfileReport = {
      ok: true,
      config: {
        minutes,
        seconds,
        ticksRequested: totalTicks,
        ticksRun,
        dt,
        tickHz: Sim.TICK_HZ,
        renderEvery,
        framesRendered,
        seed,
        walk,
        sprint,
        sampleEverySec,
        gcEverySec,
        batchTicks,
      },
      engine: {
        tickAtStart,
        tickAtEnd: engine.clock.tick,
        frameAtStart,
        frameAtEnd: engine.clock.frame,
        deterministic: engine.clock.deterministic,
        qualityTier: s.quality.settings.tier,
        maxBots: s.quality.settings.ai.maxBots,
        nullServices: engine.registry.nullKeys(),
        heapPreciseApi: heapAvailable,
        gcExposed,
        budgetCpuMs,
      },
      leakSignal,
      memory: {
        heapAvailable,
        startMB: start.heapUsedMB,
        endMB: end.heapUsedMB,
        peakMB: round(peakHeapMB, 2),
        limitMB: start.heapLimitMB,
        deltaMB: heapAvailable ? round(end.heapUsedMB - start.heapUsedMB, 2) : -1,
        // The number the whole tool exists to produce.
        growthMBPerMin: round(fit.slope, 3),
        trendR2: round(fit.r2, 3),
        trendSpanMin: round(spanMin, 2),
        projectedGrowthMB: growthMB,
        trendPointCount: trendPoints.length,
      },
      frameTime: {
        framesTimed: overall.count,
        meanMs: round(overall.mean(), 3),
        p50Ms: overall.percentile(0.5),
        p95Ms: overall.percentile(0.95),
        p99Ms: overall.percentile(0.99),
        maxMs: round(overall.max === 0 ? 0 : overall.max, 3),
        hitchMs: round(hitchMs, 2),
        hitches: overall.countOver(hitchMs),
        firstFifthP95Ms: round(firstP95, 3),
        lastFifthP95Ms: round(lastP95, 3),
        p95DriftMs: round(lastP95 - firstP95, 3),
      },
      gc: {
        exposed: gcExposed,
        forcedCollections: forcedGcs,
        naturalDrops: totalGcDrops,
        totalReclaimedMB: round(totalReclaimedMB, 2),
        retainedSamples: retained.length,
      },
      resources: {
        geometriesStart: start.geometries,
        geometriesEnd: end.geometries,
        texturesStart: start.textures,
        texturesEnd: end.textures,
        programsStart: start.programs,
        programsEnd: end.programs,
        entitiesStart: start.entities,
        entitiesEnd: end.entities,
        entitiesPeak: Math.max(...samples.map((x) => x.entities), start.entities, end.entities),
      },
      samples,
      retained,
      verdicts: [],
      errors,
    };

    report.verdicts = deriveProfileVerdicts(report);
    return report;
  } catch (error) {
    return {
      ok: false,
      config: { minutes, renderEvery, seed, walk },
      engine: {},
      leakSignal: 'none',
      memory: {},
      frameTime: {},
      gc: {},
      resources: {},
      samples,
      retained,
      verdicts: [{ id: 'profile.threw', level: 'fail', message: String(error) }],
      errors: [...errors, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)],
    };
  } finally {
    sampler?.();
    engine.loop.setCounting(false);
    s.input.setScripted(null);
    driver.setLoopSuspended(false);
  }
}

/**
 * Rolling-window minima of the raw heap: the bottom of each stretch of the
 * sawtooth, which is where the live set actually sits once transient garbage is
 * collected. A rising floor here is a leak even with no forced GC available.
 */
function troughSeries(samples: ProfileSample[]): Array<{ x: number; y: number }> {
  const usable = samples.filter((sm) => sm.heapUsedMB >= 0);
  if (usable.length === 0) return [];
  const win = Math.max(1, Math.floor(usable.length / 12));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < usable.length; i += win) {
    let lo = Infinity;
    let at = usable[i].tMin;
    for (let j = i; j < Math.min(i + win, usable.length); j++) {
      if (usable[j].heapUsedMB < lo) {
        lo = usable[j].heapUsedMB;
        at = usable[j].tMin;
      }
    }
    out.push({ x: at, y: lo });
  }
  return out;
}

/**
 * Leak/frame-time verdicts, derived only from the measurements. Thresholds are
 * anchored to the budgets in issue #2: "post-ready JS heap ≤ 512 MiB and no
 * sustained growth in a 30-minute soak." Growth is normalised per minute so a
 * short shakedown run and a full 30-minute soak trip the same wire.
 */
function deriveProfileVerdicts(r: ProfileReport): ProfileReport['verdicts'] {
  const out: ProfileReport['verdicts'] = [];
  const add = (id: string, level: 'ok' | 'warn' | 'fail', message: string): void => {
    out.push({ id, level, message });
  };

  const mem = r.memory as Record<string, number & boolean>;
  const heapAvailable = Boolean(mem.heapAvailable);

  if (!heapAvailable) {
    add('profile.noHeapApi', 'warn', 'performance.memory was unavailable; heap-leak verdict skipped. GPU-resource and entity leak checks still ran.');
  } else {
    const slope = Number(mem.growthMBPerMin ?? 0);
    const r2 = Number(mem.trendR2 ?? 0);
    const span = Number(mem.trendSpanMin ?? 0);
    const projected = Number(mem.projectedGrowthMB ?? 0);
    const signalNote =
      r.leakSignal === 'retained' ? 'post-GC retained heap' : r.leakSignal === 'trough' ? 'raw-heap troughs (no --expose-gc)' : 'insufficient samples';
    // A leak is a straight, positive climb. Require BOTH a real slope and a
    // straight line (r² > 0.6), or a lurching sawtooth trips a false alarm.
    if (r.leakSignal === 'none') {
      add('profile.leakUndecided', 'warn', `not enough heap samples over ${span} min to fit a trend.`);
    } else if (slope > 4 && r2 > 0.6) {
      add(
        'profile.leak',
        'fail',
        `heap floor rises ${slope} MiB/min (${signalNote}, r²=${r2}) — ${projected} MiB across ${span} min. ` +
          'That is a sustained leak, not warm-up: extrapolated over 30 min it breaches the 512 MiB budget.',
      );
    } else if (slope > 1 && r2 > 0.6) {
      add('profile.leakSuspect', 'warn', `heap floor rises ${slope} MiB/min (${signalNote}, r²=${r2}), ${projected} MiB over ${span} min — watch it, but under the fail bar.`);
    } else {
      add('profile.stable', 'ok', `heap floor flat within noise: ${slope} MiB/min (${signalNote}, r²=${r2}) over ${span} min.`);
    }

    const peak = Number(mem.peakMB ?? 0);
    if (peak > 512) add('profile.heapPeak', 'fail', `peak heap ${peak} MiB exceeds the 512 MiB post-ready budget.`);
    else if (peak > 384) add('profile.heapPeakHigh', 'warn', `peak heap ${peak} MiB is within 75% of the 512 MiB budget.`);
    else add('profile.heapPeakOk', 'ok', `peak heap ${peak} MiB, under the 512 MiB budget.`);
  }

  const res = r.resources as Record<string, number>;
  // GPU resources and entities should PLATEAU. A steady end-vs-start climb with
  // a matching per-sample rise is a resource leak the JS heap may never show.
  const growers: Array<[string, number, number]> = [
    ['geometries', res.geometriesStart, res.geometriesEnd],
    ['textures', res.texturesStart, res.texturesEnd],
    ['entities', res.entitiesStart, res.entitiesEnd],
  ];
  for (const [name, a, b] of growers) {
    const trend = resourceTrend(r.samples, name as 'geometries' | 'textures' | 'entities');
    if (b > a * 1.5 && b - a > 8 && trend > 0.2) {
      add(`profile.${name}Leak`, 'fail', `${name} climbed ${a}→${b} (+${round(trend, 2)}/min sustained) — a GPU/entity leak, invisible to the JS heap.`);
    } else if (b > a + 4 && trend > 0.05) {
      add(`profile.${name}Grow`, 'warn', `${name} rose ${a}→${b} (+${round(trend, 2)}/min); may plateau, may not.`);
    } else {
      add(`profile.${name}Ok`, 'ok', `${name} stable ${a}→${b}.`);
    }
  }
  if (res.programsEnd > res.programsStart) {
    add('profile.programsGrew', 'warn', `shader programs rose ${res.programsStart}→${res.programsEnd} after boot — prewarm should have compiled every permutation up front.`);
  }

  const ft = r.frameTime as Record<string, number>;
  const drift = Number(ft.p95DriftMs ?? 0);
  const budget = Number((r.engine as Record<string, number>).budgetCpuMs ?? 16.6);
  if (Number(ft.framesTimed ?? 0) === 0) {
    add('profile.noFrames', 'warn', 'no frames were rendered — frame-time distribution is empty. Raise --render-every off 0.');
  } else {
    add('profile.frameTime', Number(ft.p95Ms) > budget ? 'warn' : 'ok', `frame CPU p50 ${ft.p50Ms} / p95 ${ft.p95Ms} / p99 ${ft.p99Ms} / max ${ft.maxMs} ms over ${ft.framesTimed} frames; ${ft.hitches} past ${ft.hitchMs} ms.`);
    if (drift > 2 && drift > 0.25 * Number(ft.firstFifthP95Ms || 1)) {
      add('profile.frameDrift', 'fail', `frame-time p95 DRIFTED ${ft.firstFifthP95Ms}→${ft.lastFifthP95Ms} ms (+${drift}) across the run — cost is accumulating, the classic symptom of an un-culled leak.`);
    } else {
      add('profile.frameSteady', 'ok', `frame-time p95 held ${ft.firstFifthP95Ms}→${ft.lastFifthP95Ms} ms across the run.`);
    }
  }

  return out;
}

/** Per-minute OLS slope of a resident-resource column across the sample rows. */
function resourceTrend(samples: ProfileSample[], key: 'geometries' | 'textures' | 'entities'): number {
  const pts = samples.filter((sm) => sm.tMin >= PROFILE_WARMUP_MIN).map((sm) => ({ x: sm.tMin, y: sm[key] }));
  return linreg(pts.length >= 2 ? pts : samples.map((sm) => ({ x: sm.tMin, y: sm[key] }))).slope;
}

/* ================================================================= verdicts */

/**
 * Derived from the measurements above and from nothing else. Every verdict
 * quotes the number it was computed from, so a reader can disagree with the
 * threshold without having to re-run anything.
 */
function deriveVerdicts(r: SoakReport): SoakReport['verdicts'] {
  const out: SoakReport['verdicts'] = [];
  const add = (id: string, level: 'ok' | 'warn' | 'fail', message: string): void => {
    out.push({ id, level, message });
  };

  const bots = r.bots as Record<string, number & unknown[]>;
  const seen = Number(bots.distinctEntitiesSeen ?? 0);
  const stationary = Number(bots.movedUnder1m ?? 0);
  const unattached = (bots.unattached as unknown as number[]) ?? [];

  if (seen === 0) {
    add('bots.none', 'fail', 'No bots existed at any point in the run — spawnBot never produced one.');
  } else {
    add(
      'bots.population',
      'ok',
      `${seen} distinct bot entit${seen === 1 ? 'y' : 'ies'} observed; ${bots.aliveAtEnd} alive at the end.`,
    );
    if (unattached.length > 0) {
      add(
        'bots.unattached',
        'fail',
        `${unattached.length}/${seen} bots were never in PlayerService.controlled — attachController was not called, so they are never sampled and can never move.`,
      );
    } else {
      add('bots.attached', 'ok', `all ${seen} bots were attached to the locomotion controller.`);
    }
    if (stationary === seen) {
      add('bots.frozen', 'fail', `EVERY bot (${seen}/${seen}) travelled < 1 m. Bugs #2 and #3 reproduce as stated.`);
    } else if (stationary > 0) {
      add('bots.someFrozen', 'warn', `${stationary}/${seen} bots travelled < 1 m; median ${bots.medianDistance} m.`);
    } else {
      add(
        'bots.moving',
        'ok',
        `no bot is fully stationary; median ${bots.medianDistance} m, max ${bots.maxDistance} m — ` +
          `so "bots never move" is NOT literally true. See bots.wedged for the shape of what is.`,
      );
    }
    // The distinction that matters for the fix: a bot that gets no intent looks
    // nothing like a bot that gets one every tick and cannot act on it.
    const frozenFraction = Number(bots.frozenTickFraction ?? 0);
    if (frozenFraction > 0.5) {
      add(
        'bots.wedged',
        'fail',
        `bots spent ${(frozenFraction * 100).toFixed(1)}% of all observed ticks with zero position change ` +
          `(longest unbroken freeze ${bots.longestFreezeSeconds} s). They are being intent-driven and blocked, ` +
          `not left unsampled — the same signature as the player's uphill stall.`,
      );
    } else if (frozenFraction > 0.2) {
      add('bots.someWedge', 'warn', `bots froze on ${(frozenFraction * 100).toFixed(1)}% of observed ticks.`);
    }
    const targeted = Number(bots.everAcquiredTarget ?? 0);
    add(
      targeted === 0 ? 'bots.blind' : 'bots.targeting',
      targeted === 0 ? 'warn' : 'ok',
      `${targeted}/${seen} bots ever acquired a target.`,
    );
  }

  for (const phase of (r.schedule.gameplayPhases as Array<Record<string, number>>) ?? []) {
    const name = String(phase.phase);
    if (Number(phase.systems) === 0) {
      add(`phase.${name}.empty`, 'fail', `Nothing is registered at TickPhase.${name}.`);
    } else if (Number(phase.called) === 0) {
      add(`phase.${name}.silent`, 'fail', `TickPhase.${name} has ${phase.systems} system(s) but none were called.`);
    } else {
      add(
        `phase.${name}`,
        'ok',
        `TickPhase.${name}: ${phase.systems} system(s), ${phase.called} call(s) over ${phase.expectedCallsPerSystem} ticks.`,
      );
    }
  }

  const nav = r.nav as Record<string, Record<string, number>>;
  const fp = nav.findPath ?? { calls: 0, ok: 0, fail: 0 };
  if (!r.nav.ready) add('nav.notReady', 'fail', 'NavService.ready is false for the whole run.');
  if (Number(fp.calls) === 0) {
    add(
      'nav.noPathsRequested',
      'fail',
      'Zero findPath calls in the whole run. Nothing asked the navmesh for a route, so every bot is ' +
        'steering locally with no route to steer along — which is exactly what "they never come at me" looks like.',
    );
  } else {
    const rate = Number(fp.ok) / Number(fp.calls);
    add(
      rate < 0.5 ? 'nav.failing' : 'nav.ok',
      rate < 0.5 ? 'fail' : 'ok',
      `findPath ${fp.ok}/${fp.calls} succeeded (${(rate * 100).toFixed(1)}%).`,
    );
  }
  const rw = nav.raycastWalkable ?? { calls: 0, ok: 0, fail: 0 };
  if (Number(rw.calls) > 0) {
    const rate = Number(rw.ok) / Number(rw.calls);
    add(
      rate < 0.02 ? 'nav.raycastAlwaysFails' : 'nav.raycast',
      rate < 0.02 ? 'fail' : 'ok',
      `raycastWalkable ${rw.ok}/${rw.calls} succeeded (${(rate * 100).toFixed(2)}%)` +
        (rate < 0.02
          ? ' — the local steering primitive reports NOTHING is walkable, so every steer is rejected.'
          : '.'),
    );
  }

  const p = r.player as Record<string, number & unknown>;
  if (String(r.player.walk) !== 'none') {
    const stuckFraction = Number(p.stuckFraction ?? 0);
    add(
      stuckFraction > 0.25 ? 'player.stuck' : stuckFraction > 0.05 ? 'player.someStuck' : 'player.moves',
      stuckFraction > 0.25 ? 'fail' : stuckFraction > 0.05 ? 'warn' : 'ok',
      `local player: ${p.distance} m walked, ${p.stuckTicks}/${p.forwardTicks} ticks stalled ` +
        `(${(stuckFraction * 100).toFixed(1)}%) while holding full forward.`,
    );
    const hist = (r.player.slopeHistogram as Array<Record<string, number & string>>) ?? [];
    const scored = hist.filter((h) => Number(h.ticks) >= 30);
    const worst = scored.slice().sort((a, b) => Number(b.stuckFraction) - Number(a.stuckFraction))[0];
    const flattest = scored.slice().sort((a, b) => Number(a.stuckFraction) - Number(b.stuckFraction))[0];
    if (worst && Number(worst.stuckFraction) > 0.25) {
      // Quote the CONTRAST, not just the worst bucket: "35% of ticks stall" is
      // only evidence about slope if the shallow buckets stall less.
      const contrast =
        flattest && flattest !== worst
          ? ` (vs ${(Number(flattest.stuckFraction) * 100).toFixed(1)}% in the ${flattest.aheadSlopeDeg}° bucket)`
          : '';
      add(
        'player.slopeStall',
        'fail',
        `stalls concentrate where the ground AHEAD rises ${worst.aheadSlopeDeg}°: ` +
          `${(Number(worst.stuckFraction) * 100).toFixed(1)}% of ${worst.ticks} ticks there advanced under ` +
          `${(STUCK_STEP_M * Sim.TICK_HZ).toFixed(2)} m/s${contrast}. Bug #1 reproduces.`,
      );
    }
    // Where does walking stop working? The lowest ahead-slope bucket that
    // stalls more than half its ticks, given a bucket below it that does not.
    const clean = scored.filter((h) => Number(h.stuckFraction) < 0.1);
    const broken = scored.filter((h) => Number(h.stuckFraction) > 0.5);
    const capsule = r.player.capsule as Record<string, number> | null;
    if (clean.length > 0 && broken.length > 0) {
      const lastGood = clean[clean.length - 1];
      const firstBad = broken[0];
      const limit = capsule ? capsule.maxSlopeDeg : null;
      add(
        'player.slopeCliff',
        'fail',
        `walking works up to ${lastGood.aheadSlopeDeg}° ahead-slope and stops dead by ${firstBad.aheadSlopeDeg}°` +
          (limit === null
            ? '.'
            : ` — while CharacterConfig.maxSlopeDeg is ${limit}° and stepHeight is ${capsule?.stepHeight} m. ` +
              `The cliff is ${Number(String(firstBad.aheadSlopeDeg).split('..')[0]) < limit ? 'BELOW' : 'at or above'} ` +
              `the declared limit, so start with the slope test and the ground normal it reads, not with acceleration.`),
      );
    }
    const longest = Number(p.longestStallSeconds ?? 0);
    if (longest >= 1) {
      add(
        'player.wedged',
        'fail',
        `longest single stall ${longest} s over ${p.stallEpisodes} episode(s)` +
          (p.endedStalled ? ', and the run ENDED still stalled' : '') +
          '. Holding forward does not free it.',
      );
    }
  }

  const mode = r.mode as Record<string, number & unknown[]>;
  const changes = Number(mode.ownershipChanges ?? 0);
  const progress = Number(mode.objectiveProgressEvents ?? 0);
  add(
    changes === 0 && progress === 0 ? 'mode.static' : 'mode.progressing',
    changes === 0 && progress === 0 ? 'warn' : 'ok',
    `capture points: ${changes} ownership change(s), ${progress} progress event(s), phase ${String(mode.phase)}.`,
  );

  const combat = r.combat as Record<string, number>;
  add(
    Number(combat.shotsFired) === 0 ? 'combat.silent' : 'combat.live',
    Number(combat.shotsFired) === 0 ? 'warn' : 'ok',
    `${combat.shotsFired} shot(s) from ${combat.distinctShooters} shooter(s), ${combat.damageEvents} damage event(s), ${combat.kills} kill(s).`,
  );

  return out;
}

/* ================================================================== helpers */

function countOwnershipChanges(timeline: Array<Record<string, unknown>>): number {
  let changes = 0;
  let prev: string[] | null = null;
  for (const frame of timeline) {
    const owners = (frame.points as Array<{ owner: string }>).map((p) => p.owner);
    if (prev) {
      for (let i = 0; i < owners.length; i++) if (owners[i] !== prev[i]) changes++;
    }
    prev = owners;
  }
  return changes;
}

function vec(v: Readonly<Vec3>): [number, number, number] {
  return [v.x, v.y, v.z];
}

const UPHILL_N = new THREE.Vector3();

/**
 * Yaw that faces the steepest local ASCENT, or null where the ground is flat
 * enough that "uphill" is meaningless.
 *
 * `TerrainService.normalAt` returns (-gx, 1, -gz) normalised over the height
 * gradient g, so uphill in XZ is (-n.x, -n.z). GAME's `forwardFromYaw` is
 * (-sin yaw, 0, -cos yaw), which inverts into `atan2(-ux, -uz)`. Both signs
 * matter: get either backwards and the probe walks DOWNHILL and reports, with
 * complete confidence, that bug #1 does not reproduce.
 */
function uphillYaw(terrain: { normalAt(x: number, z: number, out: Vec3): Vec3 }, x: number, z: number): number | null {
  terrain.normalAt(x, z, UPHILL_N);
  const ux = -UPHILL_N.x;
  const uz = -UPHILL_N.z;
  if (Math.hypot(ux, uz) < 1e-4) return null;
  return Math.atan2(-ux, -uz);
}

function capsuleOf(config: Readonly<CharacterConfig> | null): Record<string, unknown> | null {
  if (!config) return null;
  return {
    radius: config.radius,
    standHeight: config.standHeight,
    crouchHeight: config.crouchHeight,
    skinWidth: config.skinWidth,
    maxSlopeDeg: config.maxSlopeDeg,
    stepHeight: config.stepHeight,
    snapToGroundDistance: config.snapToGroundDistance,
  };
}

/** Wrap to (-π, π] so a turn never takes the long way round. */
function shortestAngle(radians: number): number {
  let a = (radians + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Unused re-export guard: keeps `EntityId` in the import list meaningful. */
export type SoakEntity = EntityId;
