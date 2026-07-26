/**
 * BotDirector — the population controller that keeps a Conquest match feeling
 * like a battle rather than a set of idle spawn points.
 *
 * OWNER: GAME.
 *
 * AI owns how a bot *thinks*; this owns how many bots exist, which team they are
 * on, where they enter the map, and when they come back. The split is
 * deliberate: respawning costs a ticket and is therefore a mode decision, and
 * only the mode knows the ticket state. AI never decides its own population.
 *
 * `AiService.spawnBot` needs a `BotProfile` and a `SpawnPointDef`, neither of
 * which this file may construct — profiles live in `src/ai/profiles.ts` (another
 * lane) and spawn points come from LEVEL. Both arrive through the service
 * contract, which is why `AiService.profiles` exists at all.
 */
import {
  Team,
  type BotProfile,
  type CapturePointRuntime,
  type EntityId,
  type Rng,
  type Services,
  type SpawnPointDef,
  type TickCtx,
} from '@/engine/types';

/** Seconds between death and the earliest respawn attempt. */
const RESPAWN_MIN = 5;
const RESPAWN_JITTER = 3;
/** A denied spawn is normal under pressure; retry soon rather than giving up. */
const RETRY_DELAY = 1.5;
/** Keep a little headroom under the tier's ceiling for the human player + squad. */
const PLAYER_RESERVE = 1;

interface PendingSpawn {
  readonly team: Team;
  /** Simulation seconds remaining before this slot may attempt to spawn. */
  remaining: number;
}

export class BotDirector {
  private readonly live = new Map<number, Team>();
  private readonly pending: PendingSpawn[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly services: Services,
    private readonly rng: Rng,
  ) {
    // Deaths arrive on the sim bus rather than by polling: the damage model is
    // the only thing that knows a bot went down, and polling every entity every
    // tick to ask "still alive?" is both slower and a frame late.
    this.unsubscribe = this.services.events.on('entity.killed', (e) => this.onKilled(e.victim));
  }

  /**
   * Population target per team. Bot count is one of the few gameplay-visible
   * quality knobs — perception raycasts and path requests are a real cost on an
   * integrated GPU — so it scales with the tier rather than being fixed.
   */
  private get perTeam(): number {
    const max = this.services.quality.settings.ai.maxBots;
    return Math.max(2, Math.floor((max - PLAYER_RESERVE) / 2));
  }

  tick(ctx: TickCtx, points: readonly Readonly<CapturePointRuntime>[]): void {
    // Drain respawn timers first, so a slot freed this tick cannot also be
    // counted as a deficit below and spawn twice.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const slot = this.pending[i]!;
      slot.remaining -= ctx.dt;
      if (slot.remaining > 0) continue;
      this.pending.splice(i, 1);
      this.request(slot.team, points);
    }

    for (const team of [Team.Coalition, Team.Insurgent] as const) {
      let alive = 0;
      for (const t of this.live.values()) if (t === team) alive++;
      let queued = 0;
      for (const p of this.pending) if (p.team === team) queued++;
      const deficit = this.perTeam - alive - queued;
      // One per tick per team. A burst of eight simultaneous spawns reads as a
      // teleport; trickling them in reads as reinforcements arriving.
      if (deficit > 0) this.request(team, points);
    }
  }

  private onKilled(victim: EntityId): void {
    const team = this.live.get(victim as number);
    if (team === undefined) return; // the human, or an entity we do not own
    this.live.delete(victim as number);
    this.services.ai.despawn(victim);
    this.pending.push({ team, remaining: RESPAWN_MIN + this.rng.next() * RESPAWN_JITTER });
  }

  /**
   * Spawn one bot at a point that is both owned by its team and useful to it.
   * Failure is normal and silent — every candidate may legitimately be denied
   * while a team is being spawn-camped — and the slot simply retries.
   */
  private request(team: Team, points: readonly Readonly<CapturePointRuntime>[]): void {
    const ai = this.services.ai;
    const profile = this.pickProfile();
    const spawn = this.pickSpawn(team, points);
    if (!profile || !spawn) {
      this.pending.push({ team, remaining: RETRY_DELAY });
      return;
    }
    const entity = ai.spawnBot(team, profile, spawn);
    this.live.set(entity as number, team);
  }

  private pickProfile(): Readonly<BotProfile> | null {
    const profiles = this.services.ai.profiles;
    return profiles.length ? this.rng.pick(profiles) : null;
  }

  /**
   * Reinforce the friendly flag closest to flipping, so bots arrive where the
   * fight is instead of trickling in at the rear. With no flag held, fall back
   * to the team's base spawns.
   */
  private pickSpawn(
    team: Team,
    points: readonly Readonly<CapturePointRuntime>[],
  ): Readonly<SpawnPointDef> | null {
    const all = this.services.level.spawnPoints;
    if (all.length === 0) return null;

    const owned = points.filter((p) => p.owner === team);
    if (owned.length > 0) {
      const target = owned.reduce((worst, p) =>
        Math.abs(p.progress) < Math.abs(worst.progress) ? p : worst,
      );
      const atPoint = all.filter((s) => s.team === team && s.linkedPoint === target.id);
      if (atPoint.length > 0) return this.rng.pick(atPoint);
    }

    const base = all.filter((s) => s.team === team && s.linkedPoint === null);
    return base.length > 0 ? this.rng.pick(base) : null;
  }

  reset(): void {
    this.services.ai.despawnAll();
    this.live.clear();
    this.pending.length = 0;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
