/**
 * WeaponService + the fire-control TickSystem. WEAPONS owns this file.
 *
 * THE SPLIT THAT MATTERS. `WeaponState.aimPunch` is SIM recoil: it is added to
 * the aim basis before a bullet direction is computed, so it actually deflects
 * rounds. `WeaponFeelState.cameraKick` (in `viewmodel/`) is VIEW recoil and is
 * purely cosmetic. Keeping them apart is the only way the crosshair and the
 * bullet can never disagree, and it is what lets a player learn a pattern.
 *
 * RECOIL IS DETERMINISTIC PER SHOT INDEX. The per-shot jitter is a HASH of
 * (entity, shotIndex), not a draw from an RNG stream: a stream would make the
 * seventh shot of a burst depend on how many rounds every other soldier on the
 * map had fired, which is exactly the property that makes a pattern
 * unlearnable. Same seventh shot, every time, for everyone.
 *
 * The fire-control system reads `Btn.Fire` from `PlayerService.intentOf` for
 * every controlled entity, human and bot alike (architecture §3.4 rule 4).
 * `setTrigger` is the harness/scripted override and nothing else uses it.
 */
import * as THREE from 'three';
import {
  Btn,
  DamageKind,
  FireMode,
  LAYER_SHOOTABLE,
  Sim,
  Stance,
  TickPhase,
  type AssetRegistry,
  type BootContext,
  type DamageInfo,
  type EntityId,
  type ImpactEvent,
  type QualitySettings,
  type QueryFilter,
  type RayHit,
  type ShotRequest,
  type TickCtx,
  type TickSystem,
  type Vec3,
  type WeaponDef,
  type WeaponId,
  type WeaponService,
  type WeaponState,
  type ThrowableState,
} from '@/engine/types';
import { clamp, DEG2RAD, hashInt } from '@/engine/math/curves';
import { integrateSpring3 } from '@/engine/math/spring';
import { declareWeaponAssets } from '@/weapons/models/assets';
import { buildWeaponTable, resolveId } from '@/weapons/defs/index';
import { makeHit } from '@/weapons/penetration';
import { MELEE_STRIKE_IMPACT_PHASE, MELEE_SWING_SECONDS } from '@/weapons/viewmodel/anim';
import { installThrowableProbe, installThrowables, resetThrowables, throwablesInstance } from '@/weapons/throwables';

/**
 * The melee strike: a rifle-butt swing, short-range and always lethal up
 * close, exactly like every AAA shooter's knife/buttstroke. THE NUMBERS:
 *
 *   RANGE / RADIUS   a swept sphere rather than a ray, because a swing has
 *                     reach in every direction across the arc, not along one
 *                     infinitely thin line — a ray would miss a target
 *                     standing slightly off-centre even though the stock
 *                     would clearly have connected.
 *   DAMAGE            deliberately ≥ full health: melee range means the
 *                     fight is already lost or won, and a "sometimes needs
 *                     two hits" buttstroke reads as broken rather than as
 *                     balance. `damage.ts` already treats `DamageKind.Melee`
 *                     as a decisive kill rather than a down, so this number
 *                     is the whole mechanic.
 *   SWING / COOLDOWN  the cooldown is longer than the swing so a mashed key
 *                     cannot chain hits faster than the animation plays.
 */
const MELEE_RANGE = 2.15;
const MELEE_RADIUS = 0.34;
const MELEE_DAMAGE = 100;
const MELEE_COOLDOWN_SECONDS = 0.68;
/** Nominal kinetic energy of a swung rifle butt, for the impact VFX/audio scale. */
const MELEE_IMPACT_ENERGY_J = 650;

/** Mutable mirror of the read-only contract struct. Only this file writes it. */
type MutableWeaponState = { -readonly [K in keyof WeaponState]: WeaponState[K] };

interface Slot {
  readonly entity: EntityId;
  readonly state: MutableWeaponState;
  /** Harness / scripted overrides. Null means "read the intent". */
  triggerOverride: boolean | null;
  adsOverride: boolean | null;
  /** Edge detection for semi and burst: a held trigger is not a new pull. */
  triggerWasDown: boolean;
  /** Fractional tick at which the next round may leave the barrel. */
  nextFireAt: number;
  reloadStartTick: number;
  reloadIsEmpty: boolean;
  magInPlayed: boolean;
  /** Tick after which the aimPunch spring is allowed to start recovering. */
  recoverAfterTick: number;
  /** Tick at which the NEXT swing may start — the cooldown gate. */
  nextMeleeAt: number;
  /** True between a swing starting and its hit-scan resolving. */
  meleePending: boolean;
  /** Tick the pending swing resolves its hit-scan on — see `MELEE_STRIKE_IMPACT_PHASE`. */
  meleeHitTick: number;
}

const DEFAULT_WEAPON: WeaponId = 'ar_service';

class IronWeapons implements WeaponService, TickSystem {
  readonly name = 'weapons.fireControl';
  readonly phase = TickPhase.Weapons;
  readonly order = 0;

  private table: Map<WeaponId, WeaponDef> | null = null;
  private readonly slots = new Map<EntityId, Slot>();
  /** Attach order — iterated instead of the Map, so ordering is explicit. */
  private readonly attachOrder: EntityId[] = [];

  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpMuzzle = new THREE.Vector3();
  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly zero = new THREE.Vector3();
  private readonly flashColour = new THREE.Color(1.0, 0.86, 0.62);

  private readonly meleeHit: RayHit = makeHit();
  /** Reused across every swing this tick; `excludeEntity` rewritten per swing
   *  so a soldier's own strike cannot hit the arm that threw it. */
  private readonly meleeFilter: { -readonly [K in keyof QueryFilter]: QueryFilter[K] } = {
    groups: LAYER_SHOOTABLE,
    solid: true,
  };

  constructor(private readonly ctx: BootContext) {}

  /* ------------------------------------------------------------- contract -- */

  private defs(): Map<WeaponId, WeaponDef> {
    // Built on first use rather than in the constructor: every def names a
    // baked MeshAsset key, and the bake has run by the time anything asks.
    if (!this.table) this.table = buildWeaponTable();
    return this.table;
  }

  def(id: WeaponId): Readonly<WeaponDef> {
    const d = this.defs().get(resolveId(id));
    if (!d) throw new Error(`weapons: no def for "${id}"`);
    return d;
  }

  get all(): readonly Readonly<WeaponDef>[] {
    return [...this.defs().values()];
  }

  stateOf(entity: EntityId): Readonly<WeaponState> | null {
    return this.slots.get(entity)?.state ?? null;
  }

  equip(entity: EntityId, weapon: WeaponId): void {
    const id = resolveId(weapon);
    const def = this.def(id);
    const existing = this.slots.get(entity);
    if (existing) {
      // A weapon swap keeps nothing: fresh magazine, fresh spread, fresh recoil
      // step. Carrying the step across a swap is how a player ends up with the
      // LMG's step 19 on their first pistol shot.
      resetSlotTo(existing.state, id, def);
      existing.nextFireAt = 0;
      existing.reloadIsEmpty = false;
      existing.magInPlayed = false;
      existing.triggerWasDown = false;
      // A weapon swap mid-swing cancels the buttstroke rather than resolving it
      // against a stock that is no longer in the shooter's hands.
      existing.nextMeleeAt = 0;
      existing.meleePending = false;
      existing.meleeHitTick = 0;
      return;
    }
    const slot: Slot = {
      entity,
      state: newState(id, def),
      triggerOverride: null,
      adsOverride: null,
      triggerWasDown: false,
      nextFireAt: 0,
      reloadStartTick: 0,
      reloadIsEmpty: false,
      magInPlayed: false,
      recoverAfterTick: 0,
      nextMeleeAt: 0,
      meleePending: false,
      meleeHitTick: 0,
    };
    this.slots.set(entity, slot);
    this.attachOrder.push(entity);
  }

  setTrigger(entity: EntityId, held: boolean): void {
    const slot = this.slots.get(entity);
    if (slot) slot.triggerOverride = held;
  }

  setAds(entity: EntityId, wants: boolean): void {
    const slot = this.slots.get(entity);
    if (slot) slot.adsOverride = wants;
  }

  requestReload(entity: EntityId): void {
    const slot = this.slots.get(entity);
    if (slot) this.beginReload(slot, null);
  }

  cycleFireMode(entity: EntityId): void {
    const slot = this.slots.get(entity);
    if (!slot) return;
    const modes = this.def(slot.state.def).fireModes;
    const i = modes.indexOf(slot.state.fireMode);
    slot.state.fireMode = modes[(i + 1) % modes.length]!;
    slot.state.burstRemaining = 0;
  }

  /**
   * Reserve resupply. See `WeaponService.resupply` for why this seam exists —
   * short version: nothing in the repo could put a round back, so a match had a
   * hard ammunition budget and ended with everyone dry.
   *
   * Reserve only, clamped to `def.reserve`, and it does NOT touch `ammo`: the
   * magazine in the weapon is the player's problem and a crate that also filled
   * it would be a free instant reload. The caller has the `TickCtx` and owns
   * announcing it — `src/level/ammo.ts` emits `ammoState` off the return value,
   * so the HUD counter moves the instant the crate is used.
   */
  resupply(entity: EntityId, fraction = 1): number {
    const slot = this.slots.get(entity);
    if (!slot) return 0;
    const def = this.def(slot.state.def);
    const want = Math.round(def.reserve * clamp(fraction, 0, 1));
    const added = Math.min(want, def.reserve - slot.state.reserve);
    if (added <= 0) return 0;
    slot.state.reserve += added;
    return added;
  }

  /**
   * The aim basis AFTER `aimPunch`. Ballistics and the HUD reticle both read
   * this, so the crosshair can never lie about where the barrel is pointing.
   */
  aimBasis(entity: EntityId, outOrigin: Vec3, outDirection: Vec3): void {
    const player = this.ctx.services.player.stateOf(entity) ?? this.ctx.services.player.state;
    const slot = this.slots.get(entity);
    const punchPitch = slot ? slot.state.aimPunch.x : 0;
    const punchYaw = slot ? slot.state.aimPunch.y : 0;
    outOrigin.set(player.position.x, player.position.y + player.eyeHeight, player.position.z);
    this.tmpEuler.set(player.pitch + punchPitch, player.yaw + punchYaw, 0, 'YXZ');
    outDirection.set(0, 0, -1).applyEuler(this.tmpEuler);
  }

  spreadDegrees(entity: EntityId): number {
    return this.slots.get(entity)?.state.currentSpreadDeg ?? 0;
  }

  /**
   * Throwable inventory. Delegated to `weapons/throwables.ts`, which owns the
   * pouch and the state machine; this is the contract face of it, so the HUD's
   * throwable row and an ammo crate both talk to `services.weapons` and neither
   * needs to know a second system exists.
   */
  throwableOf(entity: EntityId): Readonly<ThrowableState> | null {
    return throwablesInstance()?.throwableOf(entity) ?? null;
  }

  restockThrowables(entity: EntityId): number {
    return throwablesInstance()?.restock(entity) ?? 0;
  }

  /* ------------------------------------------------------------------ tick -- */

  tick(ctx: TickCtx): void {
    // Anything under locomotion control carries a weapon. Auto-equipping here
    // rather than at construction is what lets this service be built before
    // `player` exists and still cover every bot AI spawns later.
    for (const entity of ctx.services.player.controlled) {
      if (!this.slots.has(entity)) this.equip(entity, DEFAULT_WEAPON);
    }
    for (const entity of this.attachOrder) {
      const slot = this.slots.get(entity);
      if (slot) this.tickSlot(slot, ctx);
    }
  }

  private tickSlot(slot: Slot, ctx: TickCtx): void {
    const s = slot.state;
    const def = this.def(s.def);
    const intent = ctx.services.player.intentOf(slot.entity);
    const player = ctx.services.player.stateOf(slot.entity);

    const buttons = intent?.buttons ?? 0;
    const pressed = intent?.pressed ?? 0;
    const trigger = slot.triggerOverride ?? (buttons & Btn.Fire) !== 0;
    const wantsAds = slot.adsOverride ?? (buttons & Btn.Ads) !== 0;

    // The rig's viewmodel clip is SHARED between reload and melee (see
    // `ViewmodelRig.stepClip`), on the strength of this mutual exclusion: a
    // reload cannot start while the swing animation is still playing, and (a
    // few lines down) a swing cannot start mid-reload. Exactly one of the two
    // is ever live, which is what lets a single "1 − clip.weight" suppression
    // cover both without the rig needing to know which one it is.
    const meleeAnimating = ctx.tick - s.lastMeleeTick < MELEE_SWING_SECONDS * Sim.TICK_HZ;
    if ((pressed & Btn.Reload) !== 0 && !meleeAnimating) this.beginReload(slot, ctx);
    if ((pressed & Btn.FireMode) !== 0) this.cycleFireMode(slot.entity);
    // Melee is gated off reloading exactly like fire is: a soldier with both
    // hands busy seating a magazine cannot also swing the weapon. It is NOT
    // gated by ammo or by the trigger's own state — it is an independent
    // action, on its own cooldown, same as a real shooter's knife/melee bind.
    if ((pressed & Btn.Melee) !== 0 && !s.reloading && ctx.tick >= slot.nextMeleeAt) {
      this.beginMelee(slot, ctx);
    }
    if (slot.meleePending && ctx.tick >= slot.meleeHitTick) this.resolveMelee(slot, ctx);

    /* ADS blend, at TICK rate. This is the value spread and recoil read; the
     * camera reads the RENDER-rate one from the viewmodel rig, and the two are
     * deliberately different numbers with the same shape. */
    s.adsWanted = wantsAds && !s.reloading && !meleeAnimating && !(player?.sprinting ?? false);
    const adsRate = ctx.dt / Math.max(0.02, def.ads.time);
    s.adsSim = clamp(s.adsSim + (s.adsWanted ? adsRate : -adsRate * 1.35), 0, 1);

    /* Reload progression. */
    if (s.reloading) {
      const duration = slot.reloadIsEmpty ? def.reloadEmpty : def.reloadTactical;
      const progress = (ctx.tick - slot.reloadStartTick) / Math.max(1, duration * Sim.TICK_HZ);
      if (!slot.magInPlayed && progress >= 0.58) {
        slot.magInPlayed = true;
        ctx.fx.emit('sound', { cue: def.sounds.magIn, position: null });
      }
      if (ctx.tick >= s.reloadEndTick) this.finishReload(slot, ctx, def);
    }

    /* Trigger. */
    if (!s.reloading) {
      const newPull = trigger && !slot.triggerWasDown;
      const mode = s.fireMode;
      let wantsShot = false;
      if (mode === FireMode.Auto) wantsShot = trigger;
      else if (mode === FireMode.Semi) wantsShot = newPull;
      else if (mode === FireMode.Burst) {
        if (newPull && s.burstRemaining === 0) s.burstRemaining = def.burstCount;
        wantsShot = s.burstRemaining > 0;
      }

      if (wantsShot && ctx.tick >= slot.nextFireAt) {
        if (s.ammo > 0) {
          this.fire(slot, ctx, def);
        } else if (newPull) {
          ctx.fx.emit('sound', { cue: def.sounds.dryFire, position: null });
          ctx.sim.emit('weapon.dryFire', { shooter: slot.entity, weapon: s.def });
        }
      }
      // Auto-reload the instant the magazine runs dry, so the empty-reload
      // animation is what the player sees rather than a click.
      if (s.ammo === 0 && s.reserve > 0 && !s.reloading && trigger) this.beginReload(slot, ctx);
    }
    slot.triggerWasDown = trigger;
    s.firing = trigger && !s.reloading && s.ammo > 0;

    /* Spread state machine. Decay is unconditional; the floor is whatever the
     * stance, the movement and the air time say it is right now. */
    const floor = this.spreadFloor(def, player, s.adsSim);
    const decayed = Math.max(floor, s.currentSpreadDeg - def.spread.decay * ctx.dt);
    s.currentSpreadDeg = Math.min(def.spread.max, decayed);

    /* Heat: 0..1, one magazine of sustained fire to reach the top. It cools
     * seven times slower than it builds, which is what makes it a pacing
     * signal rather than a second spread meter. */
    s.heat = clamp(s.heat - ctx.dt * 0.14, 0, 1);

    /* aimPunch recovery. The hang before recovery starts is what keeps a
     * sustained burst climbing instead of being flattened by the spring. */
    if (ctx.tick >= slot.recoverAfterTick) {
      integrateSpring3(s.aimPunch, s.aimPunchVelocity, this.zero, def.recoil.recovery, ctx.dt);
    }
  }

  /** Degrees of cone half-angle the weapon cannot get below right now. */
  private spreadFloor(
    def: Readonly<WeaponDef>,
    player: Readonly<{ stance: Stance; grounded: boolean; groundSpeed: number }> | null,
    adsSim: number,
  ): number {
    const sp = def.spread;
    let base = sp.baseHip + (sp.baseAds - sp.baseHip) * adsSim;
    if (player) {
      if (player.stance === Stance.Crouch) base *= sp.crouchMultiplier;
      else if (player.stance === Stance.Prone) base *= sp.proneMultiplier;
      base += player.groundSpeed * sp.movementFactor;
      if (!player.grounded) base *= sp.airborneMultiplier;
    }
    return base;
  }

  /* ------------------------------------------------------------------ fire -- */

  private fire(slot: Slot, ctx: TickCtx, def: Readonly<WeaponDef>): void {
    const s = slot.state;
    s.ammo -= 1;
    s.shotIndex += 1;
    s.lastFireTick = ctx.tick;
    if (s.fireMode === FireMode.Burst && s.burstRemaining > 0) s.burstRemaining -= 1;

    // Fractional tick interval, ACCUMULATED rather than rounded: rounding
    // 720 rpm to 5 ticks happens to be exact, but 900 rpm would become 900 and
    // 850 would quietly become 1029. The clamps stop a weapon that has been
    // idle from banking credit at either end.
    const interval = (Sim.TICK_HZ * 60) / def.rpm;
    // STALE schedule → resync to now. `nextFireAt` starts at 0 and is reset to 0
    // on every equip, so without this the accumulator is a whole match behind
    // the clock and `nextFireAt + interval` lands in the past: the first two
    // rounds of every magazine came out ONE TICK apart instead of at the
    // weapon's cyclic rate, which reads as a stutter on the opening shot of
    // every engagement. One interval of tolerance keeps the fractional
    // accumulation intact while the trigger is actually held.
    if (slot.nextFireAt < ctx.tick - interval) slot.nextFireAt = ctx.tick;
    slot.nextFireAt = Math.max(ctx.tick + 1, slot.nextFireAt + interval);
    // …and a schedule far in the FUTURE is a weapon that has banked credit.
    if (slot.nextFireAt > ctx.tick + interval + 1) slot.nextFireAt = ctx.tick + interval;
    s.nextFireTick = Math.ceil(slot.nextFireAt);

    /* --- recoil, sim side ------------------------------------------------ */
    const pattern = def.recoil;
    const step = Math.min(s.recoilStep, pattern.steps.length - 1);
    const kick = pattern.steps[step]!;
    const adsScale = 1 + (pattern.adsMultiplier - 1) * s.adsSim;
    const jitterP = hashSigned(slot.entity, s.shotIndex, 0x9e37) * pattern.randomPitch;
    const jitterY = hashSigned(slot.entity, s.shotIndex, 0x85eb) * pattern.randomYaw;
    const pitchDeg = (kick[0] + jitterP) * adsScale;
    const yawDeg = (kick[1] + jitterY) * adsScale;
    s.recoilStep = Math.min(s.recoilStep + 1, pattern.steps.length - 1);

    // The recovered fraction goes into the spring and comes back on its own;
    // the remainder is permanent view climb the player has to pull down. That
    // split IS the skill of controlling a weapon. The ×26 converts a degree of
    // kick into the velocity impulse that peaks the spring at that degree.
    const recovered = pattern.recoveredFraction;
    s.aimPunchVelocity.x += pitchDeg * DEG2RAD * recovered * 26;
    s.aimPunchVelocity.y += yawDeg * DEG2RAD * recovered * 26;
    slot.recoverAfterTick = ctx.tick + Math.round(pattern.recoveryDelay * Sim.TICK_HZ);
    ctx.services.player.applyAimPunch(slot.entity, pitchDeg * (1 - recovered), yawDeg * (1 - recovered));

    /* --- the shot -------------------------------------------------------- */
    this.aimBasis(slot.entity, this.tmpOrigin, this.tmpDir);
    this.muzzlePoint(slot, def, this.tmpMuzzle);
    const team = ctx.services.mode.teamOf(slot.entity);
    const tracer = def.ballistics.tracerEvery > 0 && s.shotIndex % def.ballistics.tracerEvery === 0;
    const request: ShotRequest = {
      shooter: slot.entity,
      team,
      weapon: s.def,
      origin: this.tmpOrigin,
      muzzle: this.tmpMuzzle,
      direction: this.tmpDir,
      spreadDeg: s.currentSpreadDeg,
      pellets: def.pelletsPerShot,
      // Derived from (shooter, shotIndex) so a shot is reproducible in
      // isolation — the same property the recoil jitter has, for the same reason.
      seed: hashInt((slot.entity as number) * 0x27d4eb2d + s.shotIndex * 0x165667b1),
      tracer,
    };
    ctx.services.ballistics.fire(request, ctx);

    /* --- spread, heat ---------------------------------------------------- */
    s.currentSpreadDeg = Math.min(def.spread.max, s.currentSpreadDeg + def.spread.perShot);
    s.heat = clamp(s.heat + 1 / Math.max(8, def.magazine * 0.8), 0, 1);

    /* --- presentation ---------------------------------------------------- */
    ctx.sim.emit('weapon.fired', {
      shooter: slot.entity,
      weapon: s.def,
      shotIndex: s.shotIndex,
      ammoLeft: s.ammo,
    });
    ctx.sim.emit('noise.emitted', {
      position: this.tmpMuzzle.clone(),
      // 158 dB SPL at 1 m is a real unsuppressed rifle, and AI hearing
      // thresholds are in the same unit — which is what makes a gunshot
      // audible across the map to a bot and a footstep audible across a room.
      loudnessDb: 158,
      team,
      source: slot.entity,
      kind: 'gunshot',
    });
    ctx.fx.emit('muzzleFlash', {
      entity: slot.entity,
      weapon: s.def,
      muzzle: this.tmpMuzzle.clone(),
      direction: this.tmpDir.clone(),
      intensity: 1,
    });
    ctx.fx.emit('shellEject', {
      position: this.tmpMuzzle.clone(),
      velocity: def.ejection.velocity.clone(),
      weapon: s.def,
    });
    ctx.fx.emit('sound', { cue: def.sounds.fire, position: null });
    ctx.fx.emit('cameraShake', { trauma: 0.05 * (def.ballistics.massKg / 0.004), frequencyHz: 26 });

    // The flash's effect on the WORLD is a punctual light, not a sprite: VFX
    // owns the card, LIGHT owns the illumination, and this is the seam.
    ctx.services.lighting.flash(
      this.tmpMuzzle,
      this.flashColour,
      def.muzzle.flashIntensityCd,
      def.muzzle.flashRadius,
      def.muzzle.flashDuration,
    );
  }

  /** World-space muzzle for the SIM. The rig's cosmetic muzzle is separate. */
  private muzzlePoint(slot: Slot, def: Readonly<WeaponDef>, out: Vec3): Vec3 {
    const player = this.ctx.services.player.stateOf(slot.entity) ?? this.ctx.services.player.state;
    this.tmpEuler.set(player.pitch + slot.state.aimPunch.x, player.yaw + slot.state.aimPunch.y, 0, 'YXZ');
    out.copy(def.muzzle.offset).applyEuler(this.tmpEuler);
    out.x += player.position.x;
    out.y += player.position.y + player.eyeHeight;
    out.z += player.position.z;
    return out;
  }

  /* ----------------------------------------------------------------- melee -- */

  /**
   * Start a swing. This tick only schedules it — `resolveMelee` does the
   * actual hit-scan, at the tick the animation's strike keyframe lands on, so
   * a lunge always connects (or doesn't) at the moment it visually should.
   */
  private beginMelee(slot: Slot, ctx: TickCtx): void {
    const s = slot.state;
    s.meleeIndex += 1;
    s.lastMeleeTick = ctx.tick;
    slot.meleePending = true;
    slot.meleeHitTick = ctx.tick + Math.round(MELEE_SWING_SECONDS * MELEE_STRIKE_IMPACT_PHASE * Sim.TICK_HZ);
    slot.nextMeleeAt = ctx.tick + Math.round(MELEE_COOLDOWN_SECONDS * Sim.TICK_HZ);
    // The swing plays every time, whether or not it will connect — a knife
    // that only whooshes on a hit is a dead giveaway that the animation is
    // reacting to the sim rather than the other way around.
    ctx.fx.emit('sound', { cue: 'w.melee', position: null });
  }

  /**
   * The hit-scan itself: a swept sphere rather than a ray (see the constants'
   * header comment), against the same `LAYER_SHOOTABLE` group ballistics uses
   * so a swing and a bullet agree on what counts as a target.
   */
  private resolveMelee(slot: Slot, ctx: TickCtx): void {
    slot.meleePending = false;
    this.aimBasis(slot.entity, this.tmpOrigin, this.tmpDir);
    this.meleeFilter.excludeEntity = slot.entity;
    const connected = ctx.services.physics.sphereCast(
      this.tmpOrigin,
      this.tmpDir,
      MELEE_RADIUS,
      MELEE_RANGE,
      this.meleeFilter,
      this.meleeHit,
    );
    if (!connected) return;

    const hit = this.meleeHit;
    // The same landmark decal/particle/sound path a bullet's impact drives —
    // reusing it is what makes a buttstroke into stone throw the same chip
    // burst a round would, and a buttstroke into a soldier throw the same
    // blood the flesh-surface impact already knows how to draw.
    const impact: ImpactEvent = {
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      incoming: this.tmpDir.clone(),
      surface: hit.surface,
      energyJ: MELEE_IMPACT_ENERGY_J,
      shooter: slot.entity,
      target: hit.entity,
      zone: hit.zone,
      weapon: slot.state.def,
      distanceM: hit.distance,
      penetrated: false,
      ricochet: false,
    };
    ctx.fx.emit('impact', impact);
    ctx.fx.emit('cameraShake', { trauma: 0.08, frequencyHz: 15 });

    if (hit.entity === (0 as EntityId)) return;
    const info: DamageInfo = {
      target: hit.entity,
      attacker: slot.entity,
      amount: MELEE_DAMAGE,
      kind: DamageKind.Melee,
      zone: hit.zone,
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      direction: this.tmpDir.clone(),
      surface: hit.surface,
      // No per-weapon curve applies to melee (`game/damage.ts`'s
      // `resolveAmount` trusts `amount` outright for every non-bullet kind),
      // so there is no `WeaponId` to name here — same as an explosion or a fall.
      weapon: null,
      energyJ: MELEE_IMPACT_ENERGY_J,
      penetrated: false,
    };
    ctx.sim.emit('damage.applied', info);
  }

  /* ---------------------------------------------------------------- reload -- */

  private beginReload(slot: Slot, ctx: TickCtx | null): void {
    const s = slot.state;
    const def = this.def(s.def);
    if (s.reloading || s.reserve <= 0 || s.ammo >= def.magazine) return;
    const empty = s.ammo === 0;
    const tick = ctx?.tick ?? 0;
    s.reloading = true;
    s.firing = false;
    s.burstRemaining = 0;
    slot.reloadIsEmpty = empty;
    slot.reloadStartTick = tick;
    slot.magInPlayed = false;
    s.reloadEndTick = tick + Math.round((empty ? def.reloadEmpty : def.reloadTactical) * Sim.TICK_HZ);
    // A reload resets the pattern, so the player gets the learnable first shot
    // back — and so the cost of a mid-fight reload is not also a random burst.
    s.recoilStep = 0;
    if (ctx) {
      ctx.sim.emit('weapon.reloadStart', { shooter: slot.entity, weapon: s.def, empty });
      ctx.fx.emit('sound', { cue: def.sounds.magOut, position: null });
      ctx.sim.emit('noise.emitted', {
        position: (ctx.services.player.stateOf(slot.entity)?.position ?? this.zero).clone(),
        loudnessDb: 62,
        team: ctx.services.mode.teamOf(slot.entity),
        source: slot.entity,
        kind: 'reload',
      });
    }
  }

  private finishReload(slot: Slot, ctx: TickCtx, def: Readonly<WeaponDef>): void {
    const s = slot.state;
    // A tactical reload keeps the chambered round: +1 over the magazine size.
    const chambered = slot.reloadIsEmpty ? 0 : Math.min(1, s.ammo);
    const want = def.magazine + chambered - s.ammo;
    const taken = Math.min(want, s.reserve);
    s.ammo += taken;
    s.reserve -= taken;
    s.reloading = false;
    if (slot.reloadIsEmpty) ctx.fx.emit('sound', { cue: def.sounds.bolt, position: null });
    ctx.sim.emit('weapon.reloadEnd', { shooter: slot.entity, weapon: s.def });
    ctx.fx.emit('ammoState', { weapon: s.def, ammo: s.ammo, reserve: s.reserve, mode: s.fireMode });
  }

  /* ----------------------------------------------------------------- reset -- */

  reset(): void {
    for (const entity of this.attachOrder) {
      const slot = this.slots.get(entity);
      if (!slot) continue;
      resetSlotTo(slot.state, slot.state.def, this.def(slot.state.def));
      slot.triggerOverride = null;
      slot.adsOverride = null;
      slot.triggerWasDown = false;
      slot.nextFireAt = 0;
      slot.reloadStartTick = 0;
      slot.reloadIsEmpty = false;
      slot.magInPlayed = false;
      slot.recoverAfterTick = 0;
      slot.nextMeleeAt = 0;
      slot.meleePending = false;
      slot.meleeHitTick = 0;
    }
  }

  /* ------------------------------------------------- lane-private harness -- */

  /** Backing implementation of `forceWeaponState`. Not part of the contract. */
  force(spec: ForceSpec): void {
    const entity = spec.entity ?? this.ctx.services.player.localEntity;
    if (spec.weapon || !this.slots.has(entity)) this.equip(entity, spec.weapon ?? DEFAULT_WEAPON);
    const slot = this.slots.get(entity)!;
    const s = slot.state;
    const def = this.def(s.def);
    if (spec.fireMode !== undefined) s.fireMode = spec.fireMode;
    if (spec.ammo !== undefined) s.ammo = clamp(spec.ammo, 0, def.magazine);
    slot.triggerOverride = spec.trigger ?? null;
    slot.adsOverride = spec.ads ?? null;
    if (spec.adsSettled) s.adsSim = spec.ads ? 1 : 0;
    if (spec.reloadPhase !== undefined) {
      const tick = this.ctx.services.clock.tick;
      const empty = spec.reloadEmpty ?? false;
      const duration = Math.round((empty ? def.reloadEmpty : def.reloadTactical) * Sim.TICK_HZ);
      // Land phase `p` of the reload exactly `framesAhead` frames from now,
      // which is the frame the harness grabs the framebuffer on.
      const capture = tick + (spec.framesAhead ?? 0);
      s.reloading = true;
      s.firing = false;
      slot.reloadIsEmpty = empty;
      slot.reloadStartTick = capture - spec.reloadPhase * duration;
      slot.magInPlayed = spec.reloadPhase >= 0.58;
      s.reloadEndTick = slot.reloadStartTick + duration;
      s.ammo = empty ? 0 : Math.max(1, Math.round(def.magazine * 0.25));
      s.recoilStep = 0;
    }
    if (spec.meleePhase !== undefined) {
      const tick = this.ctx.services.clock.tick;
      const swingTicks = Math.round(MELEE_SWING_SECONDS * Sim.TICK_HZ);
      const capture = tick + (spec.framesAhead ?? 0);
      s.meleeIndex += 1;
      s.lastMeleeTick = capture - spec.meleePhase * swingTicks;
      slot.meleePending = false;
    }
  }
}

/* ---------------------------------------------------------------- helpers -- */

function newState(id: WeaponId, def: Readonly<WeaponDef>): MutableWeaponState {
  return {
    def: id,
    ammo: def.magazine,
    reserve: def.reserve,
    fireMode: def.fireModes[def.fireModes.length - 1]!,
    nextFireTick: 0,
    reloadEndTick: 0,
    lastFireTick: -999,
    shotIndex: 0,
    burstRemaining: 0,
    recoilStep: 0,
    reloading: false,
    firing: false,
    adsSim: 0,
    adsWanted: false,
    aimPunch: new THREE.Vector3(),
    aimPunchVelocity: new THREE.Vector3(),
    currentSpreadDeg: def.spread.baseHip,
    heat: 0,
    meleeIndex: 0,
    lastMeleeTick: -999,
  };
}

function resetSlotTo(s: MutableWeaponState, id: WeaponId, def: Readonly<WeaponDef>): void {
  s.def = id;
  s.ammo = def.magazine;
  s.reserve = def.reserve;
  s.fireMode = def.fireModes[def.fireModes.length - 1]!;
  s.nextFireTick = 0;
  s.reloadEndTick = 0;
  s.lastFireTick = -999;
  s.shotIndex = 0;
  s.burstRemaining = 0;
  s.recoilStep = 0;
  s.reloading = false;
  s.firing = false;
  s.adsSim = 0;
  s.adsWanted = false;
  s.aimPunch.set(0, 0, 0);
  s.aimPunchVelocity.set(0, 0, 0);
  s.currentSpreadDeg = def.spread.baseHip;
  s.heat = 0;
  s.meleeIndex = 0;
  s.lastMeleeTick = -999;
}

/**
 * A signed value in [-1, 1] that depends only on (entity, shotIndex, salt).
 *
 * Not an RNG draw, on purpose: a stream would couple this player's seventh shot
 * to how many rounds every other soldier had fired, and the pattern would stop
 * being learnable. See the file header.
 */
function hashSigned(entity: EntityId, shotIndex: number, salt: number): number {
  const h = hashInt(((entity as number) * 0x9e3779b1) ^ (shotIndex * 0x7feb352d) ^ salt);
  return (h / 0xffffffff) * 2 - 1;
}

/* ============================================================ lane exports == */

/** Shape of the harness override. Lane-private; see `forceWeaponState`. */
export interface ForceSpec {
  entity?: EntityId;
  weapon?: WeaponId;
  fireMode?: FireMode;
  ammo?: number;
  trigger?: boolean;
  ads?: boolean;
  /** Skip the ADS transition and start the shot already settled. */
  adsSettled?: boolean;
  /** 0..1 through the reload at capture time. */
  reloadPhase?: number;
  reloadEmpty?: boolean;
  /** 0..1 through the melee swing at capture time — poses the rig directly,
   *  same idea as `reloadPhase`, without waiting for the hit-scan tick. */
  meleePhase?: number;
  /** Frames the harness will render after setup — `ShotSpec.frames`. */
  framesAhead?: number;
}

let instance: IronWeapons | null = null;

export function createWeaponService(ctx: BootContext): WeaponService {
  const weapons = new IronWeapons(ctx);
  ctx.addTick(weapons);
  instance = weapons;
  // The throwable pouch and the frag grenade. Registered from here rather than
  // from a descriptor of its own because `src/bootstrap/subsystems.ts` is frozen
  // and cannot grow a 24th entry; `installThrowables` does exactly what that
  // descriptor would have done — one `addTick`, one `addRender`.
  const throwables = installThrowables(ctx);
  installThrowableProbe(throwables, () => ctx.services);
  return weapons;
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 *
 * Receiver, barrel, optic, magazine and furniture meshes — architecture §6.1
 * step 9. See `models/assets.ts` for why they are main-thread steps.
 */
export function registerWeaponsBakes(assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  declareWeaponAssets(assets);
}

/**
 * Harness reset chain, at the top of EVERY capture. A magazine half-empty from
 * the previous capture is an order-dependent HUD screenshot, and a recoil step
 * left at 14 is a mid-burst pose in a shot that asked for idle.
 */
export function resetWeapons(_seed: number): void {
  instance?.reset();
  // A grenade still in the air from the previous capture is an order-dependent
  // screenshot, and a pouch left at zero is an order-dependent HUD readout.
  resetThrowables();
}

/**
 * LANE-PRIVATE HARNESS HOOK, for `src/shots/weapons.ts` and
 * `src/shots/ballistics.ts` only.
 *
 * `ShotContext` cannot reach a service (architecture §8.1 note 3), so a lane
 * that needs to pose its own simulation exports a function its own shot file
 * imports. This is that function for WEAPONS: it drives the REAL state machine
 * — trigger, ADS, reload timing — rather than painting a pose, so what a shot
 * captures is what the game actually does.
 */
export function forceWeaponState(spec: ForceSpec): void {
  instance?.force(spec);
}
