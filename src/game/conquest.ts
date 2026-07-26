/**
 * GameMode — CONQUEST.
 *
 * OWNER: GAME. Runs at `TickPhase.Mode`, after damage has been attributed and
 * before cleanup, so a kill that happens on tick N costs a ticket on tick N.
 *
 * THE RULES, AS IMPLEMENTED
 * -------------------------
 * Three points. Standing inside one with no enemy present moves its progress
 * toward your team at a rate that grows with your numbers but with strong
 * diminishing returns (`CONQUEST.occupantGain`), so stacking a flag is worth
 * doing and not worth doing with the whole team. Any enemy inside FREEZES it —
 * contested, not a tug of war, because a frozen bar is legible at a glance from
 * across a street and a net-difference bar is not.
 *
 * Progress runs −1 … +1 through zero. Crossing zero NEUTRALISES the flag (the
 * old owner loses it before the new one gains it), which is what makes flipping
 * a flag twice as slow as taking a neutral one and is the entire pacing lever of
 * the mode.
 *
 * Tickets bleed against whoever holds fewer points, at a rate set by the MARGIN
 * rather than the count, plus one ticket per death. A team that holds two of
 * three wins slowly; a team that holds all three wins fast; an even split does
 * not bleed at all, which keeps the middle of a round tense instead of decided.
 */
import * as THREE from 'three';
import {
  CaptureState,
  MatchPhase,
  Team,
  TickPhase,
  type AssetRegistry,
  type BootContext,
  type CapturePointDef,
  type CapturePointId,
  type CapturePointRuntime,
  type EntityId,
  type GameMode,
  type MatchState,
  type PlayerScore,
  type QualitySettings,
  type Rng,
  type Services,
  type SimBus,
  type SpawnChoice,
  type SpawnPointDef,
  type TickCtx,
} from '@/engine/types';
import { clamp } from '@/engine/math/curves';
import { CONQUEST } from '@/game/tuning';
import { SpawnDirector } from '@/game/spawn';
import { BotDirector } from '@/game/director';
import { WorldProbe } from '@/game/probe';
import { laneActors } from '@/game/player';

type MutableRuntime = { -readonly [K in keyof CapturePointRuntime]: CapturePointRuntime[K] } & {
  occupants: Record<Team, number>;
};
type MutableMatch = { -readonly [K in keyof MatchState]: MatchState[K] } & {
  tickets: Record<Team, number>;
};
type MutableScore = { -readonly [K in keyof PlayerScore]: PlayerScore[K] };

function byTeam(coalition: number, insurgent: number): Record<Team, number> {
  return { [Team.Coalition]: coalition, [Team.Insurgent]: insurgent, [Team.Neutral]: 0 };
}

function emptyScore(): MutableScore {
  return { kills: 0, deaths: 0, assists: 0, captures: 0, score: 0 };
}

/** Sign convention: Coalition captures toward +1, Insurgents toward −1. */
function teamSign(team: Team): number {
  return team === Team.Coalition ? 1 : team === Team.Insurgent ? -1 : 0;
}

function teamFromSign(sign: number): Team {
  return sign > 0 ? Team.Coalition : sign < 0 ? Team.Insurgent : Team.Neutral;
}

export class IronConquest implements GameMode {
  readonly id = 'conquest';

  private readonly runtime: MutableRuntime[] = [];
  private readonly defs: CapturePointDef[] = [];
  private readonly scores = new Map<EntityId, MutableScore>();
  private readonly matchState: MutableMatch;
  private readonly spawns: SpawnDirector;
  private readonly bots: BotDirector;
  private readonly probe: WorldProbe;
  private readonly rng: Rng;
  private readonly tmp = new THREE.Vector3();
  private readonly unsubscribes: Array<() => void> = [];
  private forced: string | null = null;
  private overtimeArmed = false;
  private built = false;

  constructor(
    private readonly services: Services,
    rng: Rng,
  ) {
    this.rng = rng.fork('game.mode');
    this.probe = new WorldProbe(services);
    this.spawns = new SpawnDirector(services, this.probe, this.rng.fork('spawn'));
    this.bots = new BotDirector(services, this.rng.fork('director'));
    this.matchState = {
      phase: MatchPhase.Warmup,
      timeRemaining: CONQUEST.roundSeconds,
      tickets: byTeam(CONQUEST.ticketsPerTeam, CONQUEST.ticketsPerTeam),
      ticketsMax: CONQUEST.ticketsPerTeam,
      points: this.runtime,
      winner: null,
      localTeam: Team.Coalition,
      localScore: emptyScore(),
      scores: this.scores,
    };
  }

  get state(): Readonly<MatchState> {
    return this.matchState;
  }

  attach(sim: SimBus): void {
    this.unsubscribes.push(sim.on('entity.killed', (e) => this.onKilled(e.victim, e.killer, e.headshot)));
  }

  detach(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }

  /**
   * Capture points come from LEVEL, which is constructed before `mode` but may
   * still be the null level on the first tick of a cold boot. Building lazily —
   * and idempotently — means the mode never holds a stale copy of the layout.
   */
  private build(): void {
    const points = this.services.level.capturePoints;
    if (points.length === 0) return;
    this.defs.length = 0;
    this.runtime.length = 0;
    for (const def of points) {
      this.defs.push(def);
      const sign = teamSign(def.initialOwner);
      this.runtime.push({
        id: def.id,
        state: def.initialOwner === Team.Neutral ? CaptureState.Neutral : ownedState(def.initialOwner),
        owner: def.initialOwner,
        progress: sign,
        contested: false,
        occupants: byTeam(0, 0),
      });
    }
    this.built = true;
  }

  /* ------------------------------------------------------------------ tick */

  tick(ctx: TickCtx): void {
    if (!this.built) this.build();
    if (!this.built) return;

    const dt = ctx.dt;
    this.matchState.localTeam = this.teamOf(this.services.player.localEntity);
    this.matchState.localScore = this.scoreFor(this.services.player.localEntity);

    switch (this.matchState.phase) {
      case MatchPhase.Warmup:
        this.matchState.timeRemaining -= dt;
        if (this.matchState.timeRemaining <= CONQUEST.roundSeconds - CONQUEST.warmupSeconds) {
          this.setPhase(MatchPhase.Live, ctx);
          this.matchState.timeRemaining = CONQUEST.roundSeconds;
        }
        break;
      case MatchPhase.Live:
      case MatchPhase.Overtime:
        this.matchState.timeRemaining = Math.max(0, this.matchState.timeRemaining - dt);
        this.stepCapture(ctx, dt);
        this.stepTickets(dt);
        this.checkEnd(ctx);
        break;
      case MatchPhase.Ended:
        break;
    }

    this.bots.tick(ctx, this.runtime);
  }

  /* --------------------------------------------------------------- capture */

  private stepCapture(ctx: TickCtx, dt: number): void {
    const player = this.services.player;

    for (let i = 0; i < this.runtime.length; i++) {
      const def = this.defs[i];
      const point = this.runtime[i];
      point.occupants[Team.Coalition] = 0;
      point.occupants[Team.Insurgent] = 0;

      // Occupancy. `controlled` is dense and in attach order, so this walk is
      // the same on every run — which is the whole reason the contract promises
      // that ordering.
      for (const entity of player.controlled) {
        const s = player.stateOf(entity);
        if (!s || !s.alive || s.downed === true) continue;
        const dx = s.position.x - def.centre.x;
        const dz = s.position.z - def.centre.z;
        if (dx * dx + dz * dz > def.radius * def.radius) continue;
        // The cylinder has a real height: a soldier on a roof three storeys up
        // is not capturing the square below.
        const dy = s.position.y - def.centre.y;
        if (dy < -def.height * 0.5 || dy > def.height) continue;
        if (s.team === Team.Coalition) point.occupants[Team.Coalition]++;
        else if (s.team === Team.Insurgent) point.occupants[Team.Insurgent]++;
      }

      const coalition = point.occupants[Team.Coalition];
      const insurgent = point.occupants[Team.Insurgent];
      point.contested = coalition > 0 && insurgent > 0;

      if (point.contested) {
        point.state = CaptureState.Contested;
        ctx.sim.emit('objective.progress', {
          point: point.id,
          team: point.owner,
          progress: point.progress,
          contested: true,
        });
        continue;
      }

      const attackerTeam = coalition > 0 ? Team.Coalition : insurgent > 0 ? Team.Insurgent : Team.Neutral;
      const count = Math.max(coalition, insurgent);
      const before = point.progress;

      if (attackerTeam !== Team.Neutral) {
        const rate = CONQUEST.baseCaptureRate * occupantMultiplier(count);
        point.progress = clamp(point.progress + teamSign(attackerTeam) * rate * dt, -1, 1);
      } else if (Math.abs(point.progress) < 1 && point.owner === Team.Neutral) {
        // An abandoned partial capture bleeds back to neutral. A FULLY owned
        // flag does not decay: ownership is only ever lost to a body on it.
        const decay = CONQUEST.decayRate * dt;
        point.progress =
          point.progress > 0 ? Math.max(0, point.progress - decay) : Math.min(0, point.progress + decay);
      }

      // Crossing zero neutralises before the new owner starts to gain.
      if (before !== 0 && Math.sign(before) !== Math.sign(point.progress) && point.owner !== Team.Neutral) {
        const from = point.owner;
        point.owner = Team.Neutral;
        ctx.sim.emit('objective.neutralised', { point: point.id, from });
        this.awardOccupants(point, attackerTeam, CONQUEST.scoreNeutralise);
        ctx.fx.emit('banner', {
          text: `${point.id} NEUTRALISED`,
          sub: this.matchState.localTeam === from ? 'HOLD THE LINE' : 'PUSH IN',
          tone: this.matchState.localTeam === from ? 'hostile' : 'friendly',
        });
      }

      if (Math.abs(point.progress) >= 1) {
        const owner = teamFromSign(point.progress);
        if (point.owner !== owner) {
          point.owner = owner;
          ctx.sim.emit('objective.captured', { point: point.id, team: owner });
          this.awardOccupants(point, owner, CONQUEST.scoreCapture);
          ctx.fx.emit('banner', {
            text: `${point.id} CAPTURED`,
            sub: owner === this.matchState.localTeam ? 'OBJECTIVE SECURED' : 'OBJECTIVE LOST',
            tone: owner === this.matchState.localTeam ? 'friendly' : 'hostile',
          });
        }
      }

      point.state = deriveState(point);
      if (point.progress !== before) {
        ctx.sim.emit('objective.progress', {
          point: point.id,
          team: attackerTeam,
          progress: point.progress,
          contested: false,
        });
      }
    }
  }

  private awardOccupants(point: MutableRuntime, team: Team, score: number): void {
    if (team === Team.Neutral) return;
    const player = this.services.player;
    const def = this.defs.find((d) => d.id === point.id);
    if (!def) return;
    for (const entity of player.controlled) {
      const s = player.stateOf(entity);
      if (!s || !s.alive || s.team !== team) continue;
      const d = this.tmp.set(s.position.x - def.centre.x, 0, s.position.z - def.centre.z).length();
      if (d > def.radius) continue;
      const record = this.scoreFor(entity);
      if (score >= CONQUEST.scoreCapture) record.captures += 1;
      record.score += score;
    }
  }

  /* --------------------------------------------------------------- tickets */

  private stepTickets(dt: number): void {
    let coalition = 0;
    let insurgent = 0;
    for (const p of this.runtime) {
      if (p.owner === Team.Coalition) coalition++;
      else if (p.owner === Team.Insurgent) insurgent++;
    }
    const margin = Math.abs(coalition - insurgent);
    if (margin === 0) return;
    const bleed = CONQUEST.bleedByMargin[Math.min(margin, CONQUEST.bleedByMargin.length - 1)];
    if (bleed <= 0) return;
    const losing = coalition > insurgent ? Team.Insurgent : Team.Coalition;
    this.matchState.tickets[losing] = Math.max(0, this.matchState.tickets[losing] - bleed * dt);
  }

  private onKilled(victim: EntityId, killer: EntityId, headshot: boolean): void {
    const victimTeam = this.teamOf(victim);
    if (victimTeam !== Team.Neutral) {
      this.matchState.tickets[victimTeam] = Math.max(
        0,
        this.matchState.tickets[victimTeam] - CONQUEST.ticketsPerDeath,
      );
    }
    this.scoreFor(victim).deaths += 1;

    if (killer !== victim) {
      const killerTeam = this.teamOf(killer);
      const record = this.scoreFor(killer);
      if (killerTeam === victimTeam) {
        // Team kill: no reward, and it costs what it would have paid.
        record.score -= CONQUEST.scoreKill;
      } else {
        record.kills += 1;
        record.score += CONQUEST.scoreKill + (headshot ? CONQUEST.scoreHeadshot : 0);
      }
    }

    // Assists were latched onto the actor at the moment of the kill; the sim bus
    // is deferred, so the ledger they came from is already cleared by now.
    const actor = laneActors()?.get(victim);
    if (actor) {
      for (const helper of actor.assistCredit) {
        if (helper === killer) continue;
        const record = this.scoreFor(helper);
        record.assists += 1;
        record.score += CONQUEST.scoreAssist;
      }
    }
  }

  private checkEnd(ctx: TickCtx): void {
    const c = this.matchState.tickets[Team.Coalition];
    const i = this.matchState.tickets[Team.Insurgent];
    if (c <= 0 || i <= 0) {
      this.end(c <= 0 ? Team.Insurgent : Team.Coalition, ctx);
      return;
    }
    if (this.matchState.timeRemaining > 0) return;

    // Time out. A near-tie goes to overtime rather than being decided by a
    // rounding error on the ticket counter.
    if (!this.overtimeArmed && Math.abs(c - i) <= CONQUEST.overtimeTickets) {
      this.overtimeArmed = true;
      this.matchState.timeRemaining = 120;
      this.setPhase(MatchPhase.Overtime, ctx);
      return;
    }
    this.end(c === i ? Team.Neutral : c > i ? Team.Coalition : Team.Insurgent, ctx);
  }

  private end(winner: Team, ctx: TickCtx): void {
    this.matchState.winner = winner === Team.Neutral ? null : winner;
    this.setPhase(MatchPhase.Ended, ctx);
    ctx.sim.emit('match.end', { winner: this.matchState.winner, tickets: this.matchState.tickets });
  }

  private setPhase(phase: MatchPhase, ctx: TickCtx): void {
    if (this.matchState.phase === phase) return;
    this.matchState.phase = phase;
    ctx.sim.emit('match.phase', { phase });
  }

  /* ---------------------------------------------------------------- public */

  requestSpawn(entity: EntityId, choice: SpawnChoice): Readonly<SpawnPointDef> | null {
    if (!this.built) this.build();
    return this.spawns.choose(entity, this.teamOf(entity), choice, this.runtime);
  }

  teamOf(entity: EntityId): Team {
    const s = this.services.player.stateOf(entity);
    if (s) return s.team;
    // An entity nobody controls still needs a stable team — the killfeed asks
    // about corpses. Even ids are Coalition; arbitrary, but reproducible.
    return (entity as number) % 2 === 0 ? Team.Coalition : Team.Insurgent;
  }

  /**
   * Callsigns, derived from the entity id so they are stable across a session
   * and identical between two runs of the same shot.
   */
  nameOf(entity: EntityId): string {
    if (entity === this.services.player.localEntity) return 'YOU';
    const n = entity as number;
    const squad = SQUAD_NAMES[n % SQUAD_NAMES.length];
    return `${squad}-${((n >> 3) % 9) + 1}`;
  }

  scoreFor(entity: EntityId): MutableScore {
    let record = this.scores.get(entity);
    if (!record) {
      record = emptyScore();
      this.scores.set(entity, record);
    }
    return record;
  }

  /**
   * Harness hook. Called from GAME's own lane, never by the harness:
   * `ShotContext` has no route to a service, by design.
   */
  forceState(state: string): void {
    this.forced = state;
    if (!this.built) this.build();
    switch (state) {
      case 'preround':
        this.matchState.phase = MatchPhase.Warmup;
        this.matchState.timeRemaining = CONQUEST.roundSeconds;
        break;
      case 'alpha_contested':
        this.matchState.phase = MatchPhase.Live;
        this.matchState.timeRemaining = 742;
        this.matchState.tickets = byTeam(318, 271);
        this.setPoint('ALPHA', Team.Neutral, 0.42, true, 3, 2);
        this.setPoint('BRAVO', Team.Coalition, 1, false, 1, 0);
        this.setPoint('CHARLIE', Team.Insurgent, -1, false, 0, 2);
        break;
      case 'endgame':
        this.matchState.phase = MatchPhase.Ended;
        this.matchState.winner = Team.Coalition;
        this.matchState.tickets = byTeam(126, 0);
        break;
      case 'live':
      default:
        this.matchState.phase = MatchPhase.Live;
        break;
    }
  }

  get forcedState(): string | null {
    return this.forced;
  }

  /** Force the round Live without waiting out warm-up. Used by the demo shots. */
  goLive(): void {
    if (!this.built) this.build();
    this.matchState.phase = MatchPhase.Live;
  }

  private setPoint(
    id: CapturePointId,
    owner: Team,
    progress: number,
    contested: boolean,
    coalition: number,
    insurgent: number,
  ): void {
    const point = this.runtime.find((p) => p.id === id);
    if (!point) return;
    point.owner = owner;
    point.progress = progress;
    point.contested = contested;
    point.occupants[Team.Coalition] = coalition;
    point.occupants[Team.Insurgent] = insurgent;
    point.state = contested ? CaptureState.Contested : deriveState(point);
  }

  reset(seed: number): void {
    this.forced = null;
    this.overtimeArmed = false;
    this.scores.clear();
    this.matchState.phase = MatchPhase.Warmup;
    this.matchState.timeRemaining = CONQUEST.roundSeconds;
    this.matchState.tickets = byTeam(CONQUEST.ticketsPerTeam, CONQUEST.ticketsPerTeam);
    this.matchState.winner = null;
    this.matchState.localScore = emptyScore();
    this.built = false;
    this.build();
    this.bots.reset();
    void seed;
  }
}

function ownedState(team: Team): CaptureState {
  return team === Team.Coalition ? CaptureState.OwnedCoalition : CaptureState.OwnedInsurgent;
}

function deriveState(point: MutableRuntime): CaptureState {
  if (point.contested) return CaptureState.Contested;
  if (point.progress >= 1) return CaptureState.OwnedCoalition;
  if (point.progress <= -1) return CaptureState.OwnedInsurgent;
  if (point.progress > 0) return CaptureState.CapturingCoalition;
  if (point.progress < 0) return CaptureState.CapturingInsurgent;
  return CaptureState.Neutral;
}

/**
 * Capture rate against occupant count, with diminishing returns:
 * `1 + gain·(n−1)^exp`, capped. Four attackers are ~2.5× a lone one, not 4×.
 */
function occupantMultiplier(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  const raw = 1 + CONQUEST.occupantGain * Math.pow(count - 1, CONQUEST.occupantExponent);
  return Math.min(raw, CONQUEST.maxOccupantMultiplier);
}

const SQUAD_NAMES = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL'] as const;

/* ========================================================================== *
 * The three named exports. `src/bootstrap/subsystems.ts` imports them BY NAME
 * and BY PATH, and it is frozen.
 * ========================================================================== */

let instance: IronConquest | null = null;

export function createGameMode(ctx: BootContext): GameMode {
  const mode = new IronConquest(ctx.services, ctx.rng);
  instance = mode;
  mode.attach(ctx.services.events);
  ctx.addTick({
    name: 'game.mode',
    phase: TickPhase.Mode,
    order: 0,
    tick: (tick) => mode.tick(tick),
  });
  return mode;
}

/** Conquest is pure logic over the interfaces: nothing to bake. */
export function registerModeBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Nothing.
}

/**
 * Harness reset chain, at the top of EVERY capture. Tickets, capture progress,
 * scores and round phase all leak across captures otherwise, and shot results
 * start depending on the ORDER shots were taken in.
 */
export function resetMode(seed: number): void {
  instance?.reset(seed);
}

/** Lane-private handle, for GAME's own demo scenarios. */
export function laneMode(): IronConquest | null {
  return instance;
}
