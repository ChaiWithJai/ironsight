/**
 * AMMO CRATES — resupply at the objectives. LEVEL owns this file.
 *
 * THE PROBLEM THIS EXISTS FOR. Every weapon in the game deployed with
 * `magazine + reserve` rounds and there was no way, anywhere in the repo, to put
 * one back. The service rifle carried 210 for an entire match. A human playing
 * hit the wall in a few minutes and reported it as *"need more ammo, gun runs
 * out too fast"*, which reads like a tuning note and is not one: a Conquest
 * match with a hard round budget stops being a game partway through.
 *
 * Raising the numbers alone would only have moved the moment it happens
 * (`defs/shared.ts` raises them anyway, because the loads were also just low).
 * The mechanic is the fix, and putting it ON THE OBJECTIVES is what makes it
 * part of the game mode rather than a vending machine: the ammunition is where
 * the fight is, so holding a point feeds you and being pushed off it starves
 * you. That is the same currency the ticket bleed already trades in.
 *
 * HOW IT IS DRIVEN, and why there are two paths into it:
 *
 *   `Btn.Use` (F)   the deliberate one. Already bound, already in `PlayerIntent`
 *                   and — before this — consumed by nothing at all. A press
 *                   inside the radius tops the pouch straight up.
 *   proximity dwell  the automatic one. `DWELL` seconds of standing on the crate
 *                   does the same thing. It is not a convenience: BOTS DO NOT
 *                   PRESS F. Their intent comes from `AiService`, which has no
 *                   reason to know this prop exists, so without the dwell path
 *                   the bots would be the only soldiers on the map who can run
 *                   out of ammunition permanently — and the player would
 *                   eventually notice that nine enemies had stopped shooting.
 *
 * `COOLDOWN` is per entity, not per crate: it is what stops a player parked on a
 * crate from having an infinite magazine while still letting them come back to
 * it between pushes. Together with the clamp inside `WeaponService.resupply`
 * (the total can never exceed `WeaponDef.reserve`) a crate cannot do anything a
 * soldier could not have carried in the first place.
 *
 * THE ONE PIECE STILL MISSING, and it belongs to HUD, not here. `src/ui/` has an
 * `'ammo'` gadget-marker kind and draws it correctly, but `HudService` exposes
 * no way to push a world-space marker — `src/ui/system.ts` only ever pushes one
 * from its own demo timeline. So the crates announce themselves by silhouette
 * and by `pushNotice` on use, and not yet by a marker on the compass. The seam
 * HUD would need is one additive optional method, e.g.
 *
 *     addWorldMarker?(world: Vec3, kind: 'ammo' | 'med' | 'sensor'): () => void;
 *
 * and this file already holds exactly the three positions to feed it.
 */
import * as THREE from 'three';
import {
  Btn,
  Sim,
  TickPhase,
  type EntityId,
  type Services,
  type TickCtx,
  type TickSystem,
  type Vec3,
} from '@/engine/types';

export interface AmmoCrate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly label: string;
}

/** How close a soldier has to be, in metres, measured on the ground plane. */
const RADIUS = 3.2;
/** Vertical tolerance: a floor above or below the crate is not the crate. */
const RADIUS_Y = 2.6;
/** Seconds of standing on a crate before it resupplies without a button press. */
const DWELL = 1.6;
/** Seconds before the same soldier may draw from a crate again. */
const COOLDOWN = 8;
/** Fraction of `WeaponDef.reserve` handed over per draw. */
const PER_DRAW = 0.5;

interface Slot {
  /** Ticks spent inside a radius since last leaving one. */
  dwell: number;
  nextDrawTick: number;
}

export class AmmoCrateSystem implements TickSystem {
  readonly name = 'level.ammoCrates';
  // Mode, not Weapons: this reads a fully-integrated position and a settled
  // weapon state, and nothing later in the tick depends on the reserve count.
  readonly phase = TickPhase.Mode;
  readonly order = 10;

  private readonly slots = new Map<EntityId, Slot>();
  /** Measurement, not bookkeeping. See `installAmmoProbe`. */
  readonly counters = { grants: 0, rounds: 0, grenades: 0, localGrants: 0 };

  constructor(private readonly crates: readonly AmmoCrate[]) {}

  /** Harness reset: a re-seeded capture must not inherit a half-served dwell. */
  reset(): void {
    this.slots.clear();
    this.counters.grants = 0;
    this.counters.rounds = 0;
    this.counters.grenades = 0;
    this.counters.localGrants = 0;
  }

  get sites(): readonly AmmoCrate[] {
    return this.crates;
  }

  tick(ctx: TickCtx): void {
    if (this.crates.length === 0) return;
    const { player, weapons } = ctx.services;
    // The service is optional on the contract so the frozen null service stays
    // valid; without it there is nothing to hand out and no work to do.
    if (!weapons.resupply) return;
    for (const entity of player.controlled) {
      const state = player.stateOf(entity);
      if (!state || !state.alive) {
        this.slots.delete(entity);
        continue;
      }
      const crate = this.nearest(state.position);
      let slot = this.slots.get(entity);
      if (!crate) {
        if (slot) slot.dwell = 0;
        continue;
      }
      if (!slot) {
        slot = { dwell: 0, nextDrawTick: 0 };
        this.slots.set(entity, slot);
      }
      slot.dwell += ctx.dt;
      const intent = player.intentOf(entity);
      const pressedUse = intent ? (intent.pressed & Btn.Use) !== 0 : false;
      if (ctx.tick < slot.nextDrawTick) continue;
      if (!pressedUse && slot.dwell < DWELL) continue;

      const added = weapons.resupply(entity, PER_DRAW);
      // A crate is a crate. `WeaponService.restockThrowables` names an ammo
      // crate as its intended source in the contract, so this is where it goes:
      // one prop, one interaction, everything a soldier carries.
      const grenades = weapons.restockThrowables?.(entity) ?? 0;
      if (added <= 0 && grenades <= 0) {
        // Full pouch: hold the cooldown anyway so a player standing on a crate
        // is not re-tested every tick for the rest of the match.
        slot.nextDrawTick = ctx.tick + Math.round(COOLDOWN / Sim.TICK_DT);
        continue;
      }
      slot.dwell = 0;
      slot.nextDrawTick = ctx.tick + Math.round(COOLDOWN / Sim.TICK_DT);
      this.counters.grants += 1;
      this.counters.rounds += added;
      this.counters.grenades += grenades;
      if (entity === ctx.services.player.localEntity) this.counters.localGrants += 1;
      this.announce(ctx, entity, crate, added);
    }
  }

  /**
   * Tell the player it happened. A mechanic with no feedback is a mechanic the
   * player does not know they have — the exact defect this pass exists to fix
   * elsewhere in the HUD — so the ammo counter, a cue and, for the local
   * soldier, a line of text all move on the same tick.
   */
  private announce(ctx: TickCtx, entity: EntityId, crate: AmmoCrate, added: number): void {
    const s = ctx.services.weapons.stateOf(entity);
    if (s) {
      ctx.fx.emit('ammoState', { weapon: s.def, ammo: s.ammo, reserve: s.reserve, mode: s.fireMode });
    }
    ctx.fx.emit('sound', {
      cue: 'w.magin',
      position: new THREE.Vector3(crate.x, crate.y + 0.6, crate.z) as unknown as Vec3,
    });
    if (entity === ctx.services.player.localEntity) {
      ctx.services.hud.pushNotice(added > 0 ? `RESUPPLIED · +${added}` : 'RESUPPLIED', 'system', 1.8);
    }
  }

  private nearest(position: Vec3): AmmoCrate | null {
    const p = position as unknown as THREE.Vector3;
    let best: AmmoCrate | null = null;
    let bestD = RADIUS * RADIUS;
    for (const c of this.crates) {
      if (Math.abs(p.y - c.y) > RADIUS_Y) continue;
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
}

/* ==========================================================================
 * PROBE
 * ======================================================================= */

/**
 * `globalThis.__AMMO__` — the headless proof that this mechanic is REACHABLE.
 *
 * Same shape and same rationale as CORE's `globalThis.__SOAK__`: this project's
 * standing failure mode is a system that renders beautifully and that no player
 * can trigger, and the only cure that has ever worked here is turning "can a
 * human at the keyboard make this happen" into a number. A screenshot of an
 * ammo crate proves nothing at all.
 *
 * `stand` puts the local soldier on a named crate; `ammo` reads the pouch;
 * `counters` reports grants since boot. A driver script therefore runs the REAL
 * mechanic — hold the trigger until the pouch is low, walk onto the crate, press
 * F — through the same code path a player uses, and reads the answer out.
 */
export interface AmmoProbe {
  readonly available: true;
  crates(): AmmoCrate[];
  counters(): { grants: number; rounds: number; grenades: number; localGrants: number };
  ammo(): { weapon: string; ammo: number; reserve: number; capacity: number } | null;
  /** Teleport the local soldier onto `label`'s crate. False if there is none. */
  stand(label: string): boolean;
  /** Hold or release the local trigger, through the harness override. */
  trigger(held: boolean): void;
  /** Hold `Btn.Use`, or clear the scripted intent entirely. */
  use(held: boolean): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __AMMO__: AmmoProbe | undefined;
}

export function installAmmoProbe(services: Services, system: AmmoCrateSystem): void {
  const probe: AmmoProbe = {
    available: true,
    crates: () => system.sites.map((c) => ({ ...c })),
    counters: () => ({ ...system.counters }),
    ammo: () => {
      const e = services.player.localEntity;
      const s = services.weapons.stateOf(e);
      if (!s) return null;
      return {
        weapon: s.def,
        ammo: s.ammo,
        reserve: s.reserve,
        capacity: services.weapons.def(s.def).reserve,
      };
    },
    stand: (label) => {
      const crate = system.sites.find((c) => c.label === label);
      if (!crate) return false;
      const e = services.player.localEntity;
      services.player.teleport(
        e,
        new THREE.Vector3(crate.x + 1.2, crate.y + 0.2, crate.z + 1.2) as unknown as Vec3,
        0, 0,
      );
      return true;
    },
    trigger: (held) => services.weapons.setTrigger(services.player.localEntity, held),
    use: (held) => services.input.setScripted(held ? { buttons: Btn.Use, pressed: Btn.Use } : null),
  };
  globalThis.__AMMO__ = probe;
}

/**
 * Debug read-out, for the soak harness and for anyone asking "is this actually
 * reachable" — which, on this project, is the only question that has ever
 * mattered. Returns where the crates are so a scripted walk can be aimed at one.
 */
export function describeCrates(crates: readonly AmmoCrate[]): string {
  return crates
    .map((c) => `${c.label}@(${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)})`)
    .join(' ');
}
