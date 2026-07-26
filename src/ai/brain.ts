/**
 * Behaviour selection, the combat rhythm, and fire control.
 *
 * OWNER: AI.
 *
 * Utility scoring rather than a state machine per bot: every behaviour is
 * scored from the same inputs (threat, health, ammunition, cover, the squad's
 * order, how many mates are already shooting at this man) and the best one
 * wins, with a dwell time so a bot cannot oscillate between two nearly-equal
 * options at 60 Hz. That is what lets "flank when a squadmate engages" be one
 * term in a score instead of a special case wired into six transitions.
 *
 * The peek rhythm is the visible half of this file. A bot in cover is NOT
 * permanently exposed: he holds behind the wall, comes out for 0.8–1.8 s
 * depending on aggression, fires a burst, and drops back for as long again —
 * reloading only while he is down. A bot that stands in the open trading shots
 * is the single loudest tell that a shooter's AI is a decade old.
 */
import * as THREE from 'three';
import {
  Btn,
  BotBehaviour,
  Stance,
  Team,
  type CapturePointDef,
  type CoverSlot,
  type EntityId,
  type WeaponDef,
} from '@/engine/types';
import type { Bot, ThreatMemory } from '@/ai/bot';
import type { AiWorld } from '@/ai/world';
import { selectTarget } from '@/ai/perception';
import { SquadDirector } from '@/ai/squad';

const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();
const COVER_INDEX = { value: -1 };

/** Minimum time in a behaviour before a rival score may take it. */
const DWELL = 0.55;

export class Brain {
  constructor(private readonly squads: SquadDirector) {}

  /**
   * One think for one bot. Called at the bot's LOD rate (every 2–8 ticks), NOT
   * every tick: aim and fire control run every tick, decisions do not.
   */
  think(bot: Bot, world: AiWorld, points: readonly CapturePointDef[]): void {
    const self = world.actorOf(bot.entity);
    if (!self) return;
    if (!bot.alive || !self.state.alive) {
      this.setBehaviour(bot, BotBehaviour.Dead, world);
      bot.trigger = false;
      return;
    }

    const memory = selectTarget(bot, world);
    bot.target = memory ? memory.entity : (0 as EntityId);
    const order = this.squads.orderFor(bot);
    const role = this.squads.roleFor(bot);
    const health = self.state.health;
    const ammoFraction = bot.magazine > 0 ? bot.ammo / bot.magazine : 0;
    const engagedMates = this.squads.matesEngaging(bot, world);

    // ---- scores ----------------------------------------------------------
    let bestScore = -Infinity;
    let best = BotBehaviour.Idle;
    const consider = (behaviour: BotBehaviour, score: number): void => {
      const sticky = behaviour === bot.behaviour ? 0.35 : 0;
      if (score + sticky > bestScore) {
        bestScore = score + sticky;
        best = behaviour;
      }
    };

    const hasContact = memory !== null && memory.confidence >= 0.55;
    const visible = memory !== null && memory.visible;
    const distance = memory?.distance ?? Infinity;

    consider(BotBehaviour.Idle, 0.05);

    if (order && (order.kind === 'attack' || order.kind === 'defend')) {
      const point = points.find((p) => p.id === order.point);
      if (point) {
        const dist = TMP_A.copy(self.state.position).distanceTo(point.centre);
        const inside = dist < point.radius;
        // Standing on the objective is worth more than walking to it, and both
        // are worth much less than dealing with a man shooting at you.
        consider(BotBehaviour.Capture, inside ? 1.5 : 0.2);
        consider(BotBehaviour.Advance, inside ? 0.3 : 1.35 - Math.min(0.6, dist / 400));
      }
    } else if (order?.kind === 'regroup' || order?.kind === 'hold') {
      consider(BotBehaviour.Regroup, 0.9);
    }

    if (hasContact && memory) {
      const closeness = 1 - Math.min(1, distance / bot.profile.visionRange);
      const aggression = bot.profile.aggression;
      // Engage: the default answer to a visible man in range.
      consider(BotBehaviour.Engage, visible ? 1.7 + closeness * 1.1 + aggression * 0.6 : 0.5);
      // Take cover: scaled by how exposed and how hurt he is.
      const hurt = 1 - health / 100;
      consider(
        BotBehaviour.TakeCover,
        (visible ? 1.35 : 0.5) + bot.profile.coverPreference * 1.2 + hurt * 1.6 - (bot.cover ? 0.4 : 0),
      );
      // Suppress: known position, no clean sight, and the discipline to keep
      // the enemy's head down rather than push into him.
      consider(
        BotBehaviour.Suppress,
        (!visible && world.time - memory.lastSeenTime < 4 ? 1.25 : 0.1) +
          bot.profile.burstDiscipline * 0.8 -
          (bot.ammo < 6 ? 1.5 : 0),
      );
      // Flank: only when someone else is already holding his attention.
      consider(
        BotBehaviour.Flank,
        (engagedMates > 0 ? 1.5 : 0.1) +
          (role === 'flankLeft' || role === 'flankRight' ? 0.9 : -0.4) +
          aggression * 0.5 -
          (distance < 12 ? 1.2 : 0),
      );
      // Retreat: badly hurt with a live contact.
      consider(BotBehaviour.Retreat, health < 34 ? 1.9 + (1 - health / 34) : -1);
    }

    // Reload wins outright when the magazine is empty, because nothing else
    // this bot can do matters until it is full.
    if (bot.ammo <= 0 && bot.reloadEndTime <= world.time) consider(BotBehaviour.Reload, 5);
    else if (ammoFraction < 0.32 && !visible) consider(BotBehaviour.Reload, 1.45);
    if (bot.reloadEndTime > world.time) consider(BotBehaviour.Reload, 6);

    this.setBehaviour(bot, best, world);
    this.chooseGoal(bot, world, memory, points, role);
  }

  private setBehaviour(bot: Bot, next: BotBehaviour, world: AiWorld): void {
    if (next === bot.behaviour) return;
    const urgent = next === BotBehaviour.Dead || next === BotBehaviour.Reload || next === BotBehaviour.Retreat;
    if (!urgent && world.time - bot.behaviourSince < DWELL) return;
    bot.behaviour = next;
    bot.behaviourSince = world.time;
  }

  /** Where the bot wants to be, and the path request that gets him there. */
  private chooseGoal(
    bot: Bot,
    world: AiWorld,
    memory: ThreatMemory | null,
    points: readonly CapturePointDef[],
    role: string,
  ): void {
    const self = world.actorOf(bot.entity);
    if (!self) return;
    const order = this.squads.orderFor(bot);
    const previous = TMP_C.copy(bot.goal);
    let kind = bot.goalKind;

    switch (bot.behaviour) {
      case BotBehaviour.TakeCover:
      case BotBehaviour.Suppress:
      case BotBehaviour.Reload: {
        const threat = memory ? memory.lastKnown : self.state.position;
        const slot = this.claimCover(bot, world, threat);
        if (slot) {
          bot.goal.copy(slot.position);
          kind = 'cover';
          break;
        }
        // No cover anywhere: fall back to backing off from the threat rather
        // than standing still in the open, which is the worst of both.
        TMP_A.copy(self.state.position).sub(threat).setY(0);
        if (TMP_A.lengthSq() < 1e-4) TMP_A.set(1, 0, 0);
        TMP_A.normalize().multiplyScalar(9);
        TMP_B.copy(self.state.position).add(TMP_A);
        if (world.nav.sample(TMP_B, 6, TMP_A)) bot.goal.copy(TMP_A);
        kind = 'retreat';
        break;
      }
      case BotBehaviour.Retreat: {
        const threat = memory ? memory.lastKnown : self.state.position;
        TMP_A.copy(self.state.position).sub(threat).setY(0);
        if (TMP_A.lengthSq() < 1e-4) TMP_A.set(1, 0, 0);
        TMP_A.normalize().multiplyScalar(22);
        TMP_B.copy(self.state.position).add(TMP_A);
        if (world.nav.sample(TMP_B, 10, TMP_A)) bot.goal.copy(TMP_A);
        kind = 'retreat';
        break;
      }
      case BotBehaviour.Flank: {
        if (memory) {
          // Step off the axis of advance by 14 m, on the side this bot owns, so
          // two flankers do not walk into the same doorway.
          TMP_A.copy(memory.lastKnown).sub(self.state.position).setY(0);
          const len = TMP_A.length() || 1;
          TMP_A.multiplyScalar(1 / len);
          const side = role === 'flankRight' ? 1 : -1;
          // Perpendicular in XZ: (−z, x) is the left of the direction.
          TMP_B.set(-TMP_A.z * side, 0, TMP_A.x * side).multiplyScalar(14);
          TMP_B.addScaledVector(TMP_A, Math.min(len * 0.55, 18)).add(self.state.position);
          if (world.nav.sample(TMP_B, 12, TMP_A)) {
            bot.goal.copy(TMP_A);
            kind = 'flank';
          }
        }
        break;
      }
      case BotBehaviour.Engage: {
        if (memory) {
          const ideal = bot.profile.id === 'marksman' ? 55 : 22;
          const toward = TMP_A.copy(memory.lastKnown).sub(self.state.position).setY(0);
          const dist = toward.length() || 1;
          toward.multiplyScalar(1 / dist);
          // Close to the weapon's comfortable range, then stop pushing.
          const step = Math.max(-8, Math.min(14, dist - ideal));
          TMP_B.copy(self.state.position).addScaledVector(toward, step);
          if (world.nav.sample(TMP_B, 8, TMP_A)) {
            bot.goal.copy(TMP_A);
            kind = 'objective';
          }
        }
        break;
      }
      case BotBehaviour.Advance:
      case BotBehaviour.Capture: {
        const point = order && (order.kind === 'attack' || order.kind === 'defend')
          ? points.find((p) => p.id === order.point)
          : points[0];
        if (point) {
          // Spread the squad around the flag instead of stacking on its centre.
          const spread = point.radius * (bot.behaviour === BotBehaviour.Capture ? 0.55 : 0.8);
          const a = ((bot.slot * 2.39996323) % (Math.PI * 2)) + (bot.squad * 0.7);
          TMP_B.set(point.centre.x + Math.cos(a) * spread, point.centre.y, point.centre.z + Math.sin(a) * spread);
          if (world.nav.sample(TMP_B, 14, TMP_A)) {
            bot.goal.copy(TMP_A);
            kind = 'objective';
          }
        }
        break;
      }
      case BotBehaviour.Regroup: {
        if (order?.kind === 'hold') {
          if (world.nav.sample(order.position, 10, TMP_A)) bot.goal.copy(TMP_A);
        } else if (this.squads.centroidOf(bot, TMP_B) && world.nav.sample(TMP_B, 10, TMP_A)) {
          bot.goal.copy(TMP_A);
        }
        kind = 'regroup';
        break;
      }
      default: {
        // Idle: hold the ground, but investigate anything heard.
        const heard = bot.memories.find((m) => m.heardOnly && world.time - m.lastSeenTime < 8);
        if (heard && world.nav.sample(heard.lastKnown, 10, TMP_A)) {
          bot.goal.copy(TMP_A);
          kind = 'investigate';
        }
        break;
      }
    }

    bot.goalKind = kind as Bot['goalKind'];
    const moved = previous.distanceToSquared(bot.goal);
    const needsPath =
      bot.path.status === 'failed' ||
      bot.pathGeneration !== bot.path.generation ||
      moved > 9 ||
      world.time > bot.repathAt;
    if (needsPath && bot.goal.lengthSq() > 0) {
      // Re-path is rate limited per bot: a squad that all re-path on the same
      // tick is exactly the spike the queue budget exists to smear out.
      bot.repathAt = world.time + 1.4 + (bot.slot % 7) * 0.08;
      world.nav.submitPath(bot.path, self.state.position, bot.goal);
      bot.pathGeneration = bot.path.generation;
      bot.corridorIndex = 0;
    }
  }

  private claimCover(bot: Bot, world: AiWorld, threat: THREE.Vector3): CoverSlot | null {
    const self = world.actorOf(bot.entity);
    if (!self) return null;
    // Keep the slot we already hold unless it stopped facing the threat.
    if (bot.cover) {
      TMP_A.copy(threat).sub(bot.cover.position).setY(0);
      const len = TMP_A.length() || 1;
      const align = (TMP_A.x / len) * bot.cover.facing.x + (TMP_A.z / len) * bot.cover.facing.z;
      if (align > 0.1) return bot.cover;
    }
    const slot = world.nav.cover.find(
      self.state.position,
      threat,
      26,
      (index) => world.coverClaimed(index, bot),
      COVER_INDEX,
    );
    if (slot) {
      bot.cover = slot;
      bot.coverIndex = COVER_INDEX.value;
    }
    return slot;
  }

  /**
   * Every tick, for every bot: the peek/shoot/retreat rhythm, the trigger, the
   * reload and the grenade. Split from `think` because a 4 Hz trigger is a bot
   * that fires in visible clumps.
   */
  fireControl(bot: Bot, world: AiWorld, memory: ThreatMemory | null, aimError: number, weapon: Readonly<WeaponDef> | null): void {
    const self = world.actorOf(bot.entity);
    if (!self || !bot.alive) {
      bot.trigger = false;
      return;
    }
    const rpm = weapon?.rpm ?? 720;
    const magazine = weapon?.magazine ?? 30;
    if (magazine !== bot.magazine) bot.magazine = magazine;
    const inCover = bot.cover !== null && bot.goalKind === 'cover';

    // ---- peek rhythm -------------------------------------------------------
    let wantExposed = true;
    if (inCover && bot.cover) {
      const atCover = TMP_A.copy(self.state.position).distanceTo(bot.cover.position) < 1.4;
      if (atCover) {
        if (world.time >= bot.hideUntil && world.time >= bot.peekUntil) {
          // Start a peek, or stay down if we are reloading or have no contact.
          const wantsToShoot = memory !== null && bot.ammo > 0 && bot.reloadEndTime <= world.time;
          if (wantsToShoot) {
            const peek = 0.75 + bot.profile.aggression * 1.1;
            bot.peekUntil = world.time + peek;
          } else {
            bot.hideUntil = world.time + 0.6;
          }
        }
        if (world.time < bot.peekUntil) {
          wantExposed = true;
          if (bot.ammo <= 0) {
            bot.peekUntil = 0;
            bot.hideUntil = world.time + Math.max(1.2, (weapon?.reloadEmpty ?? 2.6));
          }
        } else if (world.time < bot.hideUntil) {
          wantExposed = false;
        } else {
          wantExposed = false;
          const hide = 0.7 + (1 - bot.profile.aggression) * 1.5;
          bot.hideUntil = world.time + hide;
        }
      }
    }
    const exposureTarget = wantExposed ? 1 : 0;
    bot.exposure += (exposureTarget - bot.exposure) * Math.min(1, world.dt * 4.5);

    // ---- reload ------------------------------------------------------------
    if (bot.reloadEndTime > 0 && world.time >= bot.reloadEndTime) {
      const want = Math.min(bot.magazine, bot.reserve + bot.ammo);
      bot.reserve = Math.max(0, bot.reserve - (want - bot.ammo));
      bot.ammo = want;
      bot.reloadEndTime = -1;
    }
    const needsReload = bot.ammo <= 0 || (bot.behaviour === BotBehaviour.Reload && bot.ammo < bot.magazine);
    const safeToReload = !memory?.visible || bot.exposure < 0.35 || bot.ammo <= 0;
    if (needsReload && safeToReload && bot.reloadEndTime < 0 && bot.reserve > 0) {
      bot.reloadEndTime = world.time + (bot.ammo <= 0 ? weapon?.reloadEmpty ?? 2.7 : weapon?.reloadTactical ?? 2.1);
      bot.reloadPressUntil = world.time + 0.12;
    }

    // ---- grenade -----------------------------------------------------------
    if (
      memory &&
      !memory.heardOnly &&
      world.time > bot.grenadeCooldownUntil &&
      memory.distance > 9 &&
      memory.distance < 34 &&
      world.time - memory.staticSince > 2.6 &&
      bot.reloadEndTime < 0
    ) {
      bot.throwingUntil = world.time + 0.85;
      bot.grenadeCooldownUntil = world.time + 26;
    }

    // ---- trigger -----------------------------------------------------------
    let fire = false;
    const suppressing = bot.behaviour === BotBehaviour.Suppress && memory !== null && !memory.heardOnly;
    const gateOpen =
      memory !== null &&
      bot.reloadEndTime < 0 &&
      bot.ammo > 0 &&
      world.time >= memory.reactionAt &&
      (bot.exposure > 0.55 || !inCover) &&
      world.time > bot.throwingUntil;

    if (gateOpen && memory) {
      const settled = aimError < (suppressing ? 6 * (Math.PI / 180) : 2.2 * (Math.PI / 180)) && bot.settle > 0.3;
      if (settled || suppressing) {
        if (bot.burstLeft <= 0 && world.time >= bot.burstPauseUntil) {
          // Burst length falls with discipline and rises with how close he is.
          const base = suppressing ? 9 : 3 + Math.round((1 - bot.profile.burstDiscipline) * 5);
          const closeBonus = memory.distance < 15 ? 2 : 0;
          bot.burstLeft = Math.max(1, base + closeBonus);
        }
        fire = bot.burstLeft > 0;
      }
    }

    if (fire && world.time >= bot.nextShotTime) {
      bot.nextShotTime = world.time + 60 / Math.max(120, rpm);
      bot.burstLeft--;
      bot.lastShotTime = world.time;
      bot.recoil = Math.min(3.2, bot.recoil + 0.55);
      if (!world.weaponsLive) {
        // Shadow fire control. WEAPONS owns this the moment it lands; until
        // then the bots must still run dry, reload and make a noise other bots
        // can hear, or none of the behaviour above is exercised at all.
        bot.ammo--;
        world.sim.emit('noise.emitted', {
          position: self.state.position.clone(),
          loudnessDb: 141,
          team: bot.team,
          source: bot.entity,
          kind: 'gunshot',
        });
        world.fx.emit('muzzleFlash', {
          entity: bot.entity,
          weapon: bot.weapon,
          muzzle: TMP_A.copy(self.state.position).setY(self.state.position.y + self.state.eyeHeight - 0.1).clone(),
          direction: TMP_B.copy(bot.aimAt).sub(self.state.position).normalize().clone(),
          intensity: 1,
        });
      }
      if (bot.burstLeft <= 0) {
        const pause = 0.16 + bot.profile.burstDiscipline * 0.5;
        bot.burstPauseUntil = world.time + pause;
      }
    }
    bot.recoil = Math.max(0, bot.recoil - world.dt * 4.2);
    bot.trigger = fire;

    // ---- suppression felt ---------------------------------------------------
    bot.suppression = Math.max(0, bot.suppression - world.dt * 0.45);

    // ---- stance -------------------------------------------------------------
    const wantsCrouch =
      (inCover && bot.exposure < 0.5) ||
      (bot.cover?.stance === 'crouch' && bot.exposure < 0.9) ||
      (bot.behaviour === BotBehaviour.Suppress && bot.profile.id === 'support');
    bot.stance = wantsCrouch ? Stance.Crouch : Stance.Stand;
    bot.wantsAds = memory !== null && !memory.heardOnly && memory.distance > 8 && bot.exposure > 0.5;
  }
}

/** Two bots on the same team never shoot each other; used by the target filter. */
export function hostile(a: Team, b: Team): boolean {
  return a !== b && a !== Team.Neutral && b !== Team.Neutral;
}
