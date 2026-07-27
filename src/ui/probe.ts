/**
 * HUD BEHAVIOURAL PROBE. OWNER: HUD.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `hud_combat.png` is a beautiful frame of a HUD that, until this change, was
 * driven entirely by a scripted timeline. Twelve rounds of visual critics scored
 * a killfeed no kill produced, because a screenshot cannot tell a HUD that
 * REACTED from a HUD that was POSED. The soak harness exists for exactly that
 * class of question (`tools/soak.mjs`), but its report is CORE's and knows
 * nothing about presentation.
 *
 * So this file publishes the one thing an outside observer needs: a count of how
 * many times each piece of HUD feedback was raised BY A REAL EVENT ON THE FxBus,
 * separate from the demo timeline. "Killing a bot shows a kill hitmarker" stops
 * being an assertion and becomes `hitmarkerKill: 3`.
 *
 * WHAT IT IS NOT. It is not a gameplay path and nothing in `src/ui/` reads it
 * back. It mutates no HUD state; the counters are written by `HudState` as a
 * side effect of handling events it would handle anyway. Deleting this file
 * would change nothing a player sees.
 *
 * THE AIM HOOK. `aimAtNearestEnemy()` is a TEST hook, and the only thing in the
 * HUD lane that writes anything. It pushes exactly the `PlayerIntent` a human
 * holding the left mouse button while looking at a soldier produces — the same
 * struct bots produce, through the same `InputService.setScripted` seam
 * `src/engine/soak.ts` already uses to walk the player uphill. It is what lets a
 * headless run answer "can a human sitting at the keyboard make this happen"
 * instead of "does this render".
 */
import { Btn, Team, type PlayerIntent, type Services, type Vec3 } from '@/engine/types';

/**
 * Every counter is incremented ONLY on the event-driven path. The scenario
 * timeline that stages `hud_combat` increments `scripted*` instead, so a soak
 * can never mistake the demo for gameplay.
 */
export interface HudCounters {
  /** `FxEventMap.impact` seen, and how many were the local player's rounds. */
  impacts: number;
  impactsByLocal: number;
  /** Hitmarkers actually raised, by kind. */
  hitmarkerBody: number;
  hitmarkerHead: number;
  hitmarkerArmour: number;
  hitmarkerKill: number;
  /**
   * Hitmarkers dropped because the correlated round was fired by somebody else.
   * A non-zero value here with a zero above means the gate is doing its job;
   * a large value alongside zero raised marks means it is too aggressive.
   */
  hitmarkersSuppressed: number;
  /** Killfeed rows pushed from `FxEventMap.killfeed`. */
  killfeedRows: number;
  killfeedLocalKills: number;
  killfeedLocalDeaths: number;
  /** §6.25 kill-confirmation clusters raised for a kill the local player made. */
  killClusters: number;
  /** Directional damage arcs and world-anchored damage chips. */
  damageDirections: number;
  damageChips: number;
  /** Notices raised from `FxEventMap.banner` (captures, objectives). */
  notices: number;
  /** Anything raised by the shot scenario timeline instead of by an event. */
  scriptedHitmarkers: number;
  scriptedKillfeedRows: number;
}

export function createHudCounters(): HudCounters {
  return {
    impacts: 0,
    impactsByLocal: 0,
    hitmarkerBody: 0,
    hitmarkerHead: 0,
    hitmarkerArmour: 0,
    hitmarkerKill: 0,
    hitmarkersSuppressed: 0,
    killfeedRows: 0,
    killfeedLocalKills: 0,
    killfeedLocalDeaths: 0,
    killClusters: 0,
    damageDirections: 0,
    damageChips: 0,
    notices: 0,
    scriptedHitmarkers: 0,
    scriptedKillfeedRows: 0,
  };
}

export function resetHudCounters(c: HudCounters): void {
  for (const key of Object.keys(c) as Array<keyof HudCounters>) c[key] = 0;
}

/** What the HUD is showing right now, as plain data a headless tool can read. */
export interface HudSnapshot {
  root: string;
  time: number;
  hitmarker: string | null;
  killfeed: Array<{ killer: string; victim: string; headshot: boolean; local: boolean }>;
  clusters: Array<{ victim: string; tags: string[]; points: number }>;
  activeDamageSectors: number;
  damageChips: number;
  localName: string;
}

/** Result of one `aimAtNearestEnemy` call — enough to debug a drill that misses. */
export interface AimResult {
  found: boolean;
  target: number;
  distance: number;
  firing: boolean;
  aliveEnemies: number;
  /** True when the call repositioned the player to `engageRange`. */
  closed: boolean;
}

export interface AimOptions {
  /** Hold the trigger. */
  fire?: boolean;
  /**
   * Metres. When set, teleport the local player to this distance from the
   * target first, facing it. The bots spawn 90–170 m away across a headland, so
   * a drill that only aims measures the ballistics table, not the HUD. Same
   * `PlayerService.teleport` seam `src/engine/soak.ts` uses to arm its walk.
   */
  engageRange?: number;
  /**
   * Metres above the target's feet to aim at. 1.2 is the chest; 1.62 is the
   * head, which is what proves the `head` hitmarker variant and the decisive-kill
   * branch of the damage model rather than the down-then-bleed-out one.
   */
  aimHeight?: number;
}

export interface HudProbe {
  readonly available: true;
  readonly counters: HudCounters;
  reset(): void;
  snapshot(): HudSnapshot;
  aimAtNearestEnemy(options?: AimOptions | boolean): AimResult;
  releaseAim(): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __HUD__: HudProbe | undefined;
}

interface ProbeSources {
  counters: HudCounters;
  services: () => Services;
  snapshot: () => HudSnapshot;
}

export function installHudProbe(sources: ProbeSources): void {
  const aimPoint = { x: 0, y: 0, z: 0 };
  const STAND = { x: 0, y: 0, z: 0 };

  const intent: Partial<PlayerIntent> = {
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    weaponSlot: -1,
    aimAt: null,
  };

  globalThis.__HUD__ = {
    available: true,
    counters: sources.counters,
    reset: () => resetHudCounters(sources.counters),
    snapshot: () => sources.snapshot(),

    aimAtNearestEnemy(options?: AimOptions | boolean): AimResult {
      const opts: AimOptions = typeof options === 'boolean' ? { fire: options } : (options ?? {});
      const fire = opts.fire ?? true;
      const engageRange = opts.engageRange ?? 0;
      const s = sources.services();
      const localTeam = s.mode.state.localTeam;
      const eye = s.player.state;
      let best: { entity: number; d2: number; x: number; y: number; z: number } | null = null;
      let alive = 0;
      for (const bot of s.ai.bots) {
        if (bot.team === localTeam || bot.team === Team.Neutral) continue;
        if (bot.health <= 0) continue;
        alive++;
        const dx = bot.position.x - eye.position.x;
        const dy = bot.position.y - eye.position.y;
        const dz = bot.position.z - eye.position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (!best || d2 < best.d2) {
          best = { entity: bot.entity as unknown as number, d2, x: bot.position.x, y: bot.position.y, z: bot.position.z };
        }
      }
      if (!best) {
        intent.aimAt = null;
        intent.buttons = 0;
        s.input.setScripted(intent);
        return { found: false, target: 0, distance: 0, firing: false, aliveEnemies: alive, closed: false };
      }

      let closed = false;
      if (engageRange > 0 && Math.sqrt(best.d2) > engageRange * 1.5) {
        // Approach along the bearing we are already on, so the drill walks in
        // rather than jumping to an arbitrary side of the target.
        let bx = eye.position.x - best.x;
        let bz = eye.position.z - best.z;
        const flat = Math.hypot(bx, bz);
        if (flat < 1e-3) {
          bx = 0;
          bz = 1;
        } else {
          bx /= flat;
          bz /= flat;
        }
        const px = best.x + bx * engageRange;
        const pz = best.z + bz * engageRange;
        STAND.x = px;
        STAND.y = best.y + 0.05;
        STAND.z = pz;
        // `forwardFromYaw` is (-sin y, 0, -cos y), so facing the target is
        // atan2 of the NEGATED delta. Getting this backwards spawns the drill
        // with its back to the enemy and reports a HUD that never reacts.
        s.player.teleport(s.player.localEntity, STAND as unknown as Vec3, Math.atan2(-(best.x - px), -(best.z - pz)), 0);
        closed = true;
      }

      // Chest height, not the origin: `BotView.position` is the capsule's feet,
      // and aiming at the feet is how a drill reports "the weapon never hits".
      aimPoint.x = best.x;
      aimPoint.y = best.y + (opts.aimHeight ?? 1.2);
      aimPoint.z = best.z;
      intent.aimAt = aimPoint as unknown as Vec3;
      intent.buttons = fire ? Btn.Fire : 0;
      s.input.setScripted(intent);
      return {
        found: true,
        target: best.entity,
        distance: Math.sqrt(best.d2),
        firing: fire,
        aliveEnemies: alive,
        closed,
      };
    },

    releaseAim(): void {
      intent.aimAt = null;
      intent.buttons = 0;
      sources.services().input.setScripted(null);
    },
  };
}
