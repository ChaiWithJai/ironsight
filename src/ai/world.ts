/**
 * The read-only view of the world every bot subsystem is handed.
 *
 * OWNER: AI.
 *
 * One struct, rebuilt once per tick, so perception, squad scoring, the brain,
 * the aim solver and the intent writer all read the SAME snapshot. Without it
 * each of them would reach into `ctx.services` on its own and the five of them
 * would disagree about who was alive by the end of the tick.
 */
import type {
  EntityId,
  FxEmitter,
  PlayerState,
  QualitySettings,
  Rng,
  Services,
  SimBus,
  Team,
  Vec3,
} from '@/engine/types';
import type { Bot } from '@/ai/bot';
import type { NavRuntime } from '@/ai/nav';

export interface ActorView {
  readonly entity: EntityId;
  readonly state: Readonly<PlayerState>;
  readonly team: Team;
  /** True for the local human. Bots treat him no differently; the HUD does. */
  readonly human: boolean;
}

export interface AiWorld {
  time: number;
  dt: number;
  tick: number;
  /** Every intent-driven entity this tick, in `PlayerService.controlled` order. */
  actors: ActorView[];
  bots: Bot[];
  /** 0..1. Scales reaction time, the aim error cone and lead accuracy. */
  difficulty: number;
  nav: NavRuntime;
  services: Services;
  quality: Readonly<QualitySettings>;
  rng: Rng;
  fx: FxEmitter;
  sim: SimBus;
  /**
   * True once WEAPONS has landed. While it is false AI runs a shadow fire
   * model (ammunition, cadence, reload, gunshot noise) so the behaviour above
   * it is exercised; when it is true WEAPONS owns every one of those and AI
   * does nothing but set `Btn.Fire`, or the same shot is counted twice.
   */
  weaponsLive: boolean;
  /** 0..1 line of sight, physics when it is live and AI's own boxes when it is not. */
  visibility(from: Vec3, to: Vec3): number;
  /** Is this cover slot already taken by another bot? */
  coverClaimed(index: number, by: Bot): boolean;
  actorOf(entity: EntityId): ActorView | undefined;
}
