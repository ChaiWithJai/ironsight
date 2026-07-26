/**
 * GAME — damage resolution, the downed/bleedout state, regeneration, and the
 * respawn cycle.
 *
 * OWNER: GAME. Runs at `TickPhase.Damage`, which sits after ballistics (so a
 * shot fired this tick resolves this tick) and before the mode (so a kill is
 * already attributed when tickets are counted).
 *
 * WHERE THE NUMBERS COME FROM, AND WHY THAT MATTERS
 * -------------------------------------------------
 * WEAPONS owns the damage CURVES and the zone multipliers — they live in
 * `BallisticsDef`, one authored table per weapon. GAME owns the RESOLUTION: what
 * a hit means for a body. So for a bullet we read the shooter's weapon tables
 * back through `WeaponService.def()` and evaluate them ourselves rather than
 * trusting `DamageInfo.amount`, and the result is identical to whatever WEAPONS
 * computed BECAUSE IT IS THE SAME TABLE. That is the only arrangement where the
 * killfeed, the damage log and the hit indicator cannot disagree: one table, one
 * evaluator, no second opinion.
 *
 * For explosions, melee, fire and falls there is no per-weapon curve, so
 * `DamageInfo.amount` is authoritative and we apply only the game-mode
 * modifiers (friendly fire, downed rules).
 */
import * as THREE from 'three';
import {
  DamageKind,
  HitZone,
  MoveMode,
  Stance,
  TickPhase,
  Team,
  type DamageCurvePoint,
  type DamageInfo,
  type EntityId,
  type Services,
  type SimBus,
  type TickCtx,
  type TickSystem,
  type Vec3,
} from '@/engine/types';
import { clamp, clamp01, lerp } from '@/engine/math/curves';
import { Health } from '@/engine/components';
import type { ActorTable } from '@/game/registry';
import type { GameActor } from '@/game/locomotion';
import {
  BLEEDOUT_TIME,
  CONQUEST,
  DOWN_INSTANT_KILL_DAMAGE,
  FALL_DAMAGE_SPEED,
  FALL_LETHAL_SPEED,
  FALLBACK_ZONE_MULTIPLIER,
  FRIENDLY_FIRE_SCALE,
  PENETRATION_DAMAGE_SCALE,
  REGEN_CEILING,
  REGEN_DELAY,
  REGEN_RATE,
  REVIVE_HEALTH,
  REVIVE_RANGE,
  REVIVE_TIME,
  SUPPRESSION_PER_NEAR_MISS,
  SUPPRESSION_RADIUS,
} from '@/game/tuning';

/** Assist threshold: this much damage on a victim you did not kill. */
const ASSIST_DAMAGE = 20;

/** Piecewise-linear evaluation of a weapon's authored damage-vs-range curve. */
export function damageAtRange(curve: readonly DamageCurvePoint[], distance: number): number {
  if (curve.length === 0) return 0;
  if (distance <= curve[0].distance) return curve[0].damage;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (distance <= b.distance) {
      const t = (distance - a.distance) / Math.max(1e-4, b.distance - a.distance);
      return lerp(a.damage, b.damage, t);
    }
  }
  return curve[curve.length - 1].damage;
}

export class DamageSystem implements TickSystem {
  readonly name = 'game.damage';
  readonly phase = TickPhase.Damage;
  readonly order = 0;

  private readonly tmp = new THREE.Vector3();
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    private readonly table: ActorTable,
    private readonly services: Services,
    private readonly onLocalDamage: (actor: GameActor, info: DamageInfo) => void,
  ) {}

  /**
   * Subscribed rather than polled: `SimEventMap` is drained INSIDE the tick in
   * insertion order, so a bullet fired and a bullet landing in the same tick
   * resolve in the order they happened, which a per-tick queue drain would not
   * preserve across two producers.
   */
  attach(sim: SimBus): void {
    this.unsubscribes.push(sim.on('damage.applied', (info) => this.resolve(info)));
    this.unsubscribes.push(
      sim.on('projectile.impact', (impact) => {
        // Suppression from near misses. Sim-side on purpose: the FxBus `whizby`
        // event is presentation-only and simulation may never read it.
        for (const actor of this.table.actors) {
          if (!actor.state.alive || actor.entity === impact.shooter) continue;
          if (actor.team === this.teamOf(impact.shooter)) continue;
          const d = this.tmp
            .set(actor.state.position.x, actor.state.position.y + actor.state.eyeHeight * 0.6, actor.state.position.z)
            .distanceTo(impact.point);
          if (d > SUPPRESSION_RADIUS) continue;
          const amount = SUPPRESSION_PER_NEAR_MISS * (1 - d / SUPPRESSION_RADIUS);
          actor.state.suppression = clamp01(actor.state.suppression + amount);
        }
      }),
    );
  }

  detach(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }

  private teamOf(entity: EntityId): Team {
    return this.table.get(entity)?.team ?? Team.Neutral;
  }

  /* ---------------------------------------------------------------- resolve */

  private resolve(info: DamageInfo): void {
    const victim = this.table.get(info.target);
    if (!victim || !victim.state.alive) return;
    const attacker = this.table.get(info.attacker);
    const ctx = this.ctx;
    if (!ctx) return;

    let amount = this.resolveAmount(info, victim, attacker);
    if (amount <= 0) return;

    const friendly = attacker !== undefined && attacker !== victim && attacker.team === victim.team;
    if (friendly) amount *= FRIENDLY_FIRE_SCALE;

    // A downed body takes double: finishing someone off must be quick, or
    // firefights turn into shooting the same soldier four times.
    if (victim.downed) amount *= 2;

    victim.state.health = Math.max(0, victim.state.health - amount);
    victim.lastDamageTick = ctx.tick;
    victim.state.suppression = clamp01(victim.state.suppression + Math.min(0.45, amount / 90));

    const health = ctx.entities.store(Health).get(victim.entity);
    if (health) {
      health.current = victim.state.health;
      health.lastDamageTick = ctx.tick;
    }

    if (attacker && attacker !== victim) {
      victim.damagers.set(attacker.entity as number, (victim.damagers.get(attacker.entity as number) ?? 0) + amount);
      victim.lastKiller = attacker.entity;
    }

    const headshot = info.zone === HitZone.Head;
    if (victim.entity === this.services.player.localEntity) {
      this.onLocalDamage(victim, info);
      ctx.fx.emit('damageTaken', { direction: info.direction.clone(), amount });
    }
    if (attacker && attacker.entity === this.services.player.localEntity && attacker !== victim) {
      ctx.fx.emit('hitmarker', {
        lethal: victim.state.health <= 0,
        headshot,
        armour: info.penetrated,
      });
    }

    if (victim.state.health <= 0) {
      // Downed rather than killed unless the blow was decisive. A rifle round to
      // the chest downs; a headshot, an explosion or a big single hit kills.
      const decisive =
        headshot ||
        amount >= DOWN_INSTANT_KILL_DAMAGE ||
        info.kind === DamageKind.Explosion ||
        info.kind === DamageKind.Fall ||
        info.kind === DamageKind.Melee ||
        victim.downed;
      if (decisive) {
        this.kill(victim, attacker?.entity ?? victim.entity, info, headshot, ctx);
      } else {
        this.down(victim, ctx);
      }
    }
  }

  /**
   * Final damage for one hit.
   *
   * Bullets are recomputed from the weapon's own curve + zone table so GAME and
   * WEAPONS cannot drift; everything else trusts the emitter's amount.
   */
  private resolveAmount(info: DamageInfo, victim: GameActor, attacker: GameActor | undefined): number {
    if (info.kind !== DamageKind.Bullet || info.weapon === null) return info.amount;

    let base = info.amount;
    let zoneMultiplier = FALLBACK_ZONE_MULTIPLIER[info.zone] ?? 1;
    const weapons = this.services.weapons;
    const def = weapons.def(info.weapon);
    if (def) {
      const origin = attacker
        ? this.tmp.set(
            attacker.state.position.x,
            attacker.state.position.y + attacker.state.eyeHeight,
            attacker.state.position.z,
          )
        : this.tmp.copy(info.point);
      const distance = origin.distanceTo(info.point);
      base = damageAtRange(def.ballistics.damage, distance);
      const table = def.ballistics.zoneMultipliers;
      const fromTable = table[info.zone];
      if (typeof fromTable === 'number' && fromTable > 0) zoneMultiplier = fromTable;
    }

    let amount = base * zoneMultiplier;
    // Penetration: a round that has already spent energy in a wall arrives with
    // less of it. Never free, or cover stops meaning anything.
    if (info.penetrated) amount *= PENETRATION_DAMAGE_SCALE;
    // A prone target presents less of itself; this is the mechanical half of
    // what makes going prone worth the mobility cost.
    if (victim.stance === Stance.Prone) amount *= 0.92;
    return amount;
  }

  /* ------------------------------------------------------------------ life */

  private down(victim: GameActor, ctx: TickCtx): void {
    victim.downed = true;
    victim.bleedout = 1;
    victim.reviveProgress = 0;
    victim.state.health = 0;
    victim.state.downed = true;
    victim.mode = MoveMode.Downed;
    victim.state.move = MoveMode.Downed;
    victim.velocity.set(0, 0, 0);
    victim.stanceFrom = victim.stance;
    victim.stanceTarget = Stance.Prone;
    victim.stanceBlend = 0;
    void ctx;
  }

  private kill(
    victim: GameActor,
    killer: EntityId,
    info: DamageInfo | null,
    headshot: boolean,
    ctx: TickCtx,
  ): void {
    victim.state.alive = false;
    victim.downed = false;
    victim.state.downed = false;
    victim.state.health = 0;
    victim.mode = MoveMode.Dead;
    victim.state.move = MoveMode.Dead;
    victim.velocity.set(0, 0, 0);
    victim.respawnAt = ctx.tick + Math.round(CONQUEST.respawnSeconds / ctx.dt);

    const health = ctx.entities.store(Health).get(victim.entity);
    if (health) {
      health.current = 0;
      health.dead = true;
    }

    const weapon = info?.weapon ?? null;
    ctx.sim.emit('entity.killed', { victim: victim.entity, killer, weapon, headshot });

    // Assists are computed HERE, where the damage ledger lives, and latched onto
    // the actor. The sim bus is deferred — it drains at `TickPhase.Cleanup` — so
    // the mode's `entity.killed` handler runs strictly after this function has
    // returned and cleared the ledger. Latching is what lets the mode award an
    // assist without ever seeing a damage ledger.
    victim.assistCredit.length = 0;
    for (const [attackerId, dealt] of victim.damagers) {
      if (attackerId === (killer as number) || dealt < ASSIST_DAMAGE) continue;
      victim.assistCredit.push(attackerId as EntityId);
    }
    // Sorted by the stable integer id, never by Map insertion order, so two runs
    // of the same shot award assists in the same sequence.
    victim.assistCredit.sort((a, b) => (a as number) - (b as number));

    ctx.fx.emit('killfeed', {
      killer: this.services.mode.nameOf(killer),
      victim: this.services.mode.nameOf(victim.entity),
      killerTeam: this.table.get(killer)?.team ?? Team.Neutral,
      victimTeam: victim.team,
      weapon,
      headshot,
    });
    ctx.sim.emit('noise.emitted', {
      position: victim.state.position.clone(),
      loudnessDb: 48,
      team: victim.team,
      source: victim.entity,
      kind: 'impact',
    });
    victim.damagers.clear();
  }

  /** Fall damage. Routed here so scoring, tickets and the killfeed stay in one place. */
  fallDamage(actor: GameActor, impactSpeed: number, ctx: TickCtx): void {
    if (impactSpeed < FALL_DAMAGE_SPEED) return;
    const t = clamp01((impactSpeed - FALL_DAMAGE_SPEED) / (FALL_LETHAL_SPEED - FALL_DAMAGE_SPEED));
    // Quadratic in the excess speed: kinetic energy is v², and a fall that is
    // twice as fast really is four times as bad.
    const amount = clamp(t * t * 130, 4, 200);
    ctx.sim.emit('damage.applied', {
      target: actor.entity,
      attacker: actor.entity,
      amount,
      kind: DamageKind.Fall,
      zone: HitZone.Leg,
      point: actor.state.position.clone(),
      normal: UP.clone(),
      direction: DOWN.clone(),
      surface: actor.groundSurface,
      weapon: null,
      energyJ: amount * 12,
      penetrated: false,
    });
  }

  /* ------------------------------------------------------------------ tick */

  private ctx: TickCtx | null = null;

  tick(ctx: TickCtx): void {
    this.ctx = ctx;
    const dt = ctx.dt;
    const regenDelayTicks = REGEN_DELAY / dt;

    for (const actor of this.table.actors) {
      if (actor.downed) {
        this.stepDowned(actor, ctx, dt);
        continue;
      }
      if (!actor.state.alive) {
        this.stepDead(actor, ctx);
        continue;
      }
      // Out-of-combat regeneration. The delay is what makes disengaging a real
      // decision rather than a formality.
      if (actor.state.health < REGEN_CEILING && ctx.tick - actor.lastDamageTick > regenDelayTicks) {
        actor.state.health = Math.min(REGEN_CEILING, actor.state.health + REGEN_RATE * dt);
        const health = ctx.entities.store(Health).get(actor.entity);
        if (health) health.current = actor.state.health;
        if (actor.state.health >= REGEN_CEILING) actor.damagers.clear();
      }
    }
  }

  private stepDowned(actor: GameActor, ctx: TickCtx, dt: number): void {
    // A friendly standing over you brings you back. Bots do not know to do this
    // yet; the code path is here so that when AI does, nothing else changes.
    let helper: GameActor | null = null;
    for (const other of this.table.actors) {
      if (other === actor || !other.state.alive || other.downed) continue;
      if (other.team !== actor.team) continue;
      if (other.state.position.distanceTo(actor.state.position) > REVIVE_RANGE) continue;
      helper = other;
      break;
    }
    if (helper) {
      actor.reviveProgress += dt;
      if (actor.reviveProgress >= REVIVE_TIME) {
        actor.downed = false;
        actor.state.downed = false;
        actor.state.health = REVIVE_HEALTH;
        actor.reviveProgress = 0;
        actor.bleedout = 1;
        actor.lastDamageTick = ctx.tick;
        actor.stanceFrom = Stance.Prone;
        actor.stanceTarget = Stance.Crouch;
        actor.stanceBlend = 0;
        const health = ctx.entities.store(Health).get(actor.entity);
        if (health) health.current = REVIVE_HEALTH;
        return;
      }
    } else {
      actor.reviveProgress = Math.max(0, actor.reviveProgress - dt * 0.5);
    }

    actor.bleedout -= dt / BLEEDOUT_TIME;
    actor.state.bleedout = clamp01(actor.bleedout);
    if (actor.bleedout <= 0) {
      this.kill(actor, actor.lastKiller || actor.entity, null, false, ctx);
    }
  }

  private stepDead(actor: GameActor, ctx: TickCtx): void {
    if (actor.respawnAt < 0 || ctx.tick < actor.respawnAt) return;
    // Ask the mode where to deploy. It owns spawn validation; if it says no
    // (every point contested, every squadmate under fire) we simply wait a
    // second and ask again, which is exactly the deploy-screen experience.
    const spawn = this.services.mode.requestSpawn(actor.entity, { kind: 'base' });
    if (!spawn) {
      actor.respawnAt = ctx.tick + Math.round(1 / ctx.dt);
      return;
    }
    actor.respawnAt = -1;
    this.services.player.teleport(actor.entity, spawn.position, spawn.yaw, 0);
    const health = ctx.entities.store(Health).get(actor.entity);
    if (health) {
      health.current = 100;
      health.dead = false;
    }
    ctx.sim.emit('entity.spawned', {
      entity: actor.entity,
      archetype: 'soldier',
      team: actor.team,
      position: spawn.position.clone(),
    });
  }
}

const UP: Vec3 = new THREE.Vector3(0, 1, 0);
const DOWN: Vec3 = new THREE.Vector3(0, -1, 0);
