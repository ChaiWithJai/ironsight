/**
 * Squad orders — the layer that makes twelve bots read as a battle rather than
 * twelve independent state machines.
 *
 * OWNER: AI.
 *
 * Objective play is decided HERE, from `GameMode.state`, once every half
 * second, for a whole squad at a time:
 *   · a point we hold and that is contested is defended, always — losing a held
 *     flag costs tickets immediately;
 *   · otherwise the squad attacks the WEAKEST enemy or neutral point, weighted
 *     by how far it has to walk and how many of its own team are already there,
 *     so three squads do not all pile onto ALPHA;
 *   · when our tickets are bleeding badly the whole team turns defensive,
 *     because at 15% tickets a failed attack ends the round.
 *
 * Roles inside the squad make the difference visible: one point man pushes, the
 * support gun holds an angle and suppresses, and the remaining two take
 * alternating flanks so the squad envelops instead of queueing.
 */
import * as THREE from 'three';
import {
  CaptureState,
  Team,
  type CapturePointDef,
  type CapturePointId,
  type SquadOrder,
} from '@/engine/types';
import type { Bot } from '@/ai/bot';
import type { AiWorld } from '@/ai/world';

export type SquadRole = 'point' | 'support' | 'flankLeft' | 'flankRight';

interface SquadState {
  readonly key: number;
  readonly team: Team;
  readonly members: Bot[];
  order: SquadOrder;
  orderSince: number;
  centroid: THREE.Vector3;
  engaged: number;
}

const CENTROID = new THREE.Vector3();

export class SquadDirector {
  private readonly squads = new Map<number, SquadState>();
  private readonly roles = new Map<number, SquadRole>();
  private nextUpdate = 0;

  clear(): void {
    this.squads.clear();
    this.roles.clear();
    this.nextUpdate = 0;
  }

  orderFor(bot: Bot): SquadOrder | null {
    return this.squads.get(squadKey(bot))?.order ?? null;
  }

  roleFor(bot: Bot): SquadRole {
    return this.roles.get(bot.slot) ?? 'point';
  }

  /** Cheap every tick, real work twice a second. */
  update(world: AiWorld, points: readonly CapturePointDef[]): void {
    this.regroupMembers(world);
    if (world.time < this.nextUpdate) return;
    this.nextUpdate = world.time + 0.5;

    const match = world.services.mode.state;
    const keys = [...this.squads.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const squad = this.squads.get(key) as SquadState;
      if (squad.members.length === 0) continue;

      const tickets = match.tickets[squad.team] ?? 0;
      const desperate = match.ticketsMax > 0 && tickets / match.ticketsMax < 0.18;

      let best: CapturePointDef | null = null;
      let bestScore = -Infinity;
      let bestKind: 'attack' | 'defend' = 'attack';
      for (const point of points) {
        const runtime = match.points.find((p) => p.id === point.id);
        const owner = runtime?.owner ?? Team.Neutral;
        const contested = runtime?.contested ?? false;
        const friends = runtime?.occupants[squad.team] ?? 0;
        const enemies = runtime?.occupants[squad.team === Team.Coalition ? Team.Insurgent : Team.Coalition] ?? 0;
        const distance = squad.centroid.distanceTo(point.centre);
        const walk = distance / 90;

        if (owner === squad.team) {
          // Defending is only interesting when someone is actually coming.
          const threat = (contested ? 3.2 : 0) + enemies * 1.4 + (desperate ? 1.6 : 0);
          const score = threat - walk - friends * 0.5;
          if (score > bestScore) {
            bestScore = score;
            best = point;
            bestKind = 'defend';
          }
        } else {
          const weakness = 2.4 - Math.min(2.4, enemies * 0.8);
          const neutralBonus =
            runtime?.state === CaptureState.Neutral || runtime?.state === CaptureState.Contested ? 1.1 : 0;
          const crowding = friends * 0.6;
          const score = 1.6 + weakness + neutralBonus - walk - crowding - (desperate ? 1.8 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = point;
            bestKind = 'attack';
          }
        }
      }

      const engagedFraction = squad.members.length > 0 ? squad.engaged / squad.members.length : 0;
      if (engagedFraction >= 0.5 && bestKind === 'attack') {
        // Half the squad is in contact: finish the fight where you stand rather
        // than walking men one at a time into the gun that is already firing.
        squad.order = { kind: 'hold', position: squad.centroid.clone() };
      } else if (best) {
        const id: CapturePointId = best.id;
        squad.order = bestKind === 'defend' ? { kind: 'defend', point: id } : { kind: 'attack', point: id };
      } else {
        squad.order = { kind: 'regroup', position: squad.centroid.clone() };
      }
      squad.orderSince = world.time;

      // Roles are stable per squad and assigned in slot order, so a squad does
      // not swap its point man every half second.
      const sorted = [...squad.members].sort((a, b) => a.slot - b.slot);
      for (let i = 0; i < sorted.length; i++) {
        const bot = sorted[i];
        const role: SquadRole =
          bot.profile.id === 'support' ? 'support' : i === 0 ? 'point' : i % 2 === 1 ? 'flankLeft' : 'flankRight';
        this.roles.set(bot.slot, role);
      }
    }
  }

  private regroupMembers(world: AiWorld): void {
    for (const squad of this.squads.values()) {
      squad.members.length = 0;
      squad.engaged = 0;
    }
    for (const bot of world.bots) {
      if (!bot.alive) continue;
      const key = squadKey(bot);
      let squad = this.squads.get(key);
      if (!squad) {
        squad = {
          key,
          team: bot.team,
          members: [],
          order: { kind: 'regroup', position: new THREE.Vector3() },
          orderSince: world.time,
          centroid: new THREE.Vector3(),
          engaged: 0,
        };
        this.squads.set(key, squad);
      }
      squad.members.push(bot);
      if (bot.target !== 0 && bot.memoryOf(bot.target)?.visible) squad.engaged++;
    }
    for (const squad of this.squads.values()) {
      if (squad.members.length === 0) continue;
      CENTROID.set(0, 0, 0);
      for (const bot of squad.members) {
        const actor = world.actorOf(bot.entity);
        if (actor) CENTROID.add(actor.state.position);
      }
      squad.centroid.copy(CENTROID).multiplyScalar(1 / squad.members.length);
    }
  }

  /** Squadmates of `bot` that are currently shooting at `target`. */
  matesEngaging(bot: Bot, world: AiWorld): number {
    const squad = this.squads.get(squadKey(bot));
    if (!squad) return 0;
    let n = 0;
    for (const mate of squad.members) {
      if (mate === bot || !mate.alive) continue;
      if (mate.target === bot.target && mate.target !== 0) n++;
    }
    void world;
    return n;
  }

  centroidOf(bot: Bot, out: THREE.Vector3): boolean {
    const squad = this.squads.get(squadKey(bot));
    if (!squad || squad.members.length === 0) return false;
    out.copy(squad.centroid);
    return true;
  }
}

function squadKey(bot: Bot): number {
  return (bot.team as number) * 1000 + bot.squad;
}
