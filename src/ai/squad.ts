/**
 * Squad orders — the layer that makes twelve bots read as a battle rather than
 * twelve independent state machines.
 *
 * OWNER: AI.
 *
 * Objective play is decided HERE, from `GameMode.state`, once every half
 * second, for a whole squad at a time:
 *   · a fight the squad can see, or one a street away, outranks every flag —
 *     see `Contact` below, which is what makes the two teams meet at all;
 *   · a point we hold and that is contested is defended, always — losing a held
 *     flag costs tickets immediately;
 *   · a point we hold that NOBODY is walking at scores at or below zero, which
 *     is what sends a squad that has just secured a flag on to the next one
 *     instead of garrisoning it for the rest of the round;
 *   · otherwise the squad attacks the WEAKEST enemy or neutral point, weighted
 *     by how far it has to walk, how many of its own team are already there and
 *     how many squads this same pass has already sent, so three squads do not
 *     all pile onto ALPHA;
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
  type Vec3,
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
  /** Mean last-known position of the enemies this squad can currently see. */
  contactPoint: THREE.Vector3;
  hasContactPoint: boolean;
}

/**
 * Somewhere a fight is happening, as far as one team is concerned.
 *
 * THIS IS THE THING THAT WAS MISSING. Objective scoring alone gives a squad one
 * reason to walk anywhere — a flag — so two teams with different nearest flags
 * walk apart and a match produces no contact at all. Measured before this
 * existed: after 60 s all nine Coalition bots sat at x = +63…+120 and all nine
 * Insurgents at x = −23…−174, 90–290 m apart, with zero overlap. Gunfire, a
 * squadmate taking a round and (when one lands) a spot all write here, and a
 * squad inside `CONTACT_COMMIT_M` of a fresh one goes to it instead of to its
 * flag, and every flag near one is worth more than it otherwise would be.
 */
interface Contact {
  readonly position: THREE.Vector3;
  team: Team;
  time: number;
  weight: number;
}

/**
 * Fixed-size ring. A ledger that grows with the firefight would allocate inside
 * the tick and, worse, would make the iteration order depend on how much
 * shooting had happened — and this is walked every half second to pick an
 * order, so that order has to be identical on two runs of the same seed.
 */
const CONTACT_SLOTS = 16;
/** A contact older than this is not news any more. */
const CONTACT_MEMORY_S = 6;
/** Two reports closer than this are the same firefight, not two of them. */
const CONTACT_MERGE_M = 18;
/**
 * How near a flag a contact has to be to make that flag the more attractive
 * one. This is the WEAK form of reacting to contact and it is the one that
 * should fire most of the time: the squad keeps advancing and capturing, it
 * just advances toward the flag people are dying on.
 */
const CONTACT_BIAS_M = 90;
/**
 * How near a squad a contact has to be before the squad abandons its flag and
 * goes to the fight instead — a street away, not a district away.
 *
 * MEASURED, because the obvious wider value is actively harmful: pulling a
 * squad to any contact within 90 m took a 60 s 9v9 from 5 kills to 1 and put
 * 17.5% of all bot-ticks into `Regroup`. Squads spent the match walking to
 * where shooting had been instead of to where the enemy was going to be, and
 * two teams that are both chasing each other's echoes never close.
 */
const CONTACT_COMMIT_M = 50;
/** …and only while it is this fresh. Older than this is an echo, not a fight. */
const CONTACT_COMMIT_AGE_S = 3;
/** Fraction of a squad in live contact that turns the whole squad to the fight. */
const ENGAGED_COMMIT = 0.34;

const CENTROID = new THREE.Vector3();
const CONTACT_TMP = new THREE.Vector3();
/** Dedicated: `noteContact` may be handed `CONTACT_TMP` itself by a caller. */
const MERGE_TMP = new THREE.Vector3();

export class SquadDirector {
  private readonly squads = new Map<number, SquadState>();
  private readonly roles = new Map<number, SquadRole>();
  private nextUpdate = 0;
  private readonly contacts: Contact[] = Array.from({ length: CONTACT_SLOTS }, () => ({
    position: new THREE.Vector3(),
    team: Team.Neutral,
    time: -1e9,
    weight: 0,
  }));

  clear(): void {
    this.squads.clear();
    this.roles.clear();
    this.nextUpdate = 0;
    for (const contact of this.contacts) {
      contact.team = Team.Neutral;
      contact.time = -1e9;
      contact.weight = 0;
      contact.position.set(0, 0, 0);
    }
  }

  /**
   * Report that `team` has reason to believe there is a fight at `position`.
   *
   * Called from `system.ts` for enemy gunfire, for a friendly taking damage and
   * for a player spot. Merging by distance rather than appending is what stops
   * one four-second firefight from filling the whole ring and evicting the
   * report from the other side of the map.
   */
  noteContact(team: Team, position: Vec3, time: number, weight: number): void {
    if (team === Team.Neutral) return;
    let oldest = 0;
    for (let i = 0; i < this.contacts.length; i++) {
      const contact = this.contacts[i];
      if (
        contact.team === team &&
        time - contact.time < CONTACT_MEMORY_S &&
        MERGE_TMP.copy(contact.position).distanceToSquared(position) < CONTACT_MERGE_M * CONTACT_MERGE_M
      ) {
        // Same fight: drift the report toward the new sighting rather than
        // replacing it, so a running battle reads as one moving contact.
        contact.position.lerp(MERGE_TMP.copy(position), 0.35);
        contact.time = time;
        contact.weight = Math.min(4, contact.weight + weight);
        return;
      }
      if (contact.time < this.contacts[oldest].time) oldest = i;
    }
    const slot = this.contacts[oldest];
    slot.position.copy(position);
    slot.team = team;
    slot.time = time;
    slot.weight = weight;
  }

  /**
   * The fight this squad should care about most, or null. Deterministic ring
   * walk — never a Map, never a sort by anything but a number.
   */
  private pullFor(squad: SquadState, time: number): Contact | null {
    let best: Contact | null = null;
    let bestScore = -Infinity;
    for (const contact of this.contacts) {
      if (contact.team !== squad.team) continue;
      const age = time - contact.time;
      if (age > CONTACT_MEMORY_S) continue;
      const distance = squad.centroid.distanceTo(contact.position);
      if (distance > CONTACT_BIAS_M) continue;
      // Near and recent and loud beats far and stale and quiet.
      const score = contact.weight * 2 - age * 0.9 - distance / 30;
      if (score > bestScore) {
        bestScore = score;
        best = contact;
      }
    }
    return best;
  }

  /** How much a flag is worth extra because a fight is happening at it. */
  private contactBiasAt(team: Team, time: number, centre: Vec3): number {
    let bias = 0;
    for (const contact of this.contacts) {
      if (contact.team !== team) continue;
      const age = time - contact.time;
      if (age > CONTACT_MEMORY_S) continue;
      const distance = MERGE_TMP.copy(contact.position).distanceTo(centre);
      if (distance > CONTACT_BIAS_M) continue;
      bias = Math.max(bias, (1 - distance / CONTACT_BIAS_M) * (1 - age / CONTACT_MEMORY_S) * 1.6);
    }
    return bias;
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
    // How many squads of each team this pass has already sent to each point, so
    // three squads do not all queue up on ALPHA while BRAVO is being taken off
    // them. Keyed by `team:point`; the key order is never iterated.
    const claims = new Map<string, number>();
    for (const key of keys) {
      const squad = this.squads.get(key) as SquadState;
      if (squad.members.length === 0) continue;

      const tickets = match.tickets[squad.team] ?? 0;
      const desperate = match.ticketsMax > 0 && tickets / match.ticketsMax < 0.18;
      const contact = this.pullFor(squad, world.time);

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
        const queued = claims.get(`${squad.team}:${point.id}`) ?? 0;

        if (owner === squad.team) {
          // Defending is only interesting when someone is actually coming. A
          // flag nobody is walking at scores at or below zero, which is what
          // sends a squad that has just SECURED a point on to the next one
          // instead of garrisoning it for the rest of the round.
          const threat = (contested ? 3.2 : 0) + enemies * 1.4 + (desperate ? 1.6 : 0);
          const score = threat - walk - friends * 0.5 - queued * 0.6;
          if (score > bestScore) {
            bestScore = score;
            best = point;
            bestKind = 'defend';
          }
        } else {
          const weakness = 2.4 - Math.min(2.4, enemies * 0.8);
          // A flag that is CHANGING HANDS is where the enemy is standing, and
          // is therefore worth more than one that merely belongs to him. The
          // old form scored `Neutral` and `Contested` only, which silently
          // excluded both `Capturing*` states — i.e. every flag actually being
          // taken at the moment the decision is made.
          const inPlay =
            runtime === undefined ||
            runtime.state === CaptureState.Neutral ||
            runtime.state === CaptureState.Contested ||
            runtime.state === CaptureState.CapturingCoalition ||
            runtime.state === CaptureState.CapturingInsurgent;
          const contestBonus =
            (inPlay ? 1.1 : 0) +
            (contested ? 1.0 : 0) +
            (enemies > 0 ? 0.8 : 0) +
            this.contactBiasAt(squad.team, world.time, point.centre);
          const crowding = friends * 0.5 + queued * 0.6;
          const score = 1.6 + weakness + contestBonus - walk - crowding - (desperate ? 1.8 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = point;
            bestKind = 'attack';
          }
        }
      }

      // ---- contact outranks the objective ----------------------------------
      // A squad that can see the enemy, or that is standing next to a fight,
      // goes to the fight. Ordered before the flag so that a firefight fifty
      // metres away is not lost to a flag two hundred metres away that scores
      // 0.4 higher.
      const engagedFraction = squad.members.length > 0 ? squad.engaged / squad.members.length : 0;
      const commit =
        contact !== null &&
        world.time - contact.time <= CONTACT_COMMIT_AGE_S &&
        squad.centroid.distanceTo(contact.position) <= CONTACT_COMMIT_M;
      if (engagedFraction >= ENGAGED_COMMIT && squad.hasContactPoint) {
        // Men are already shooting. Bring the rest of the squad ONTO the enemy
        // they can see — not onto the squad's own centre of mass, which is
        // where the men who are not shooting already are.
        squad.order = { kind: 'hold', position: squad.contactPoint.clone() };
      } else if (commit && contact) {
        // A fight one street away, right now. The flag can wait ninety seconds;
        // the man shooting at your squad cannot.
        squad.order = { kind: 'hold', position: contact.position.clone() };
      } else if (best) {
        const id: CapturePointId = best.id;
        squad.order = bestKind === 'defend' ? { kind: 'defend', point: id } : { kind: 'attack', point: id };
        claims.set(`${squad.team}:${id}`, (claims.get(`${squad.team}:${id}`) ?? 0) + 1);
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
      squad.contactPoint.set(0, 0, 0);
      squad.hasContactPoint = false;
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
          contactPoint: new THREE.Vector3(),
          hasContactPoint: false,
        };
        this.squads.set(key, squad);
      }
      squad.members.push(bot);
      const memory = bot.target !== 0 ? bot.memoryOf(bot.target) : undefined;
      if (memory?.visible) {
        squad.engaged++;
        squad.contactPoint.add(memory.lastKnown);
        squad.hasContactPoint = true;
      }
    }
    for (const squad of this.squads.values()) {
      if (squad.engaged > 0) squad.contactPoint.multiplyScalar(1 / squad.engaged);
      if (squad.members.length === 0) continue;
      CENTROID.set(0, 0, 0);
      for (const bot of squad.members) {
        const actor = world.actorOf(bot.entity);
        if (actor) CENTROID.add(actor.state.position);
      }
      squad.centroid.copy(CENTROID).multiplyScalar(1 / squad.members.length);
      // A squad that can see the enemy is itself a contact report, so the
      // squads either side of it come to help without needing to hear a shot.
      if (squad.hasContactPoint) {
        this.noteContact(squad.team, squad.contactPoint, world.time, 2);
      }
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
