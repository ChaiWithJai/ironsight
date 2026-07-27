/**
 * HUD transient state and its state machines. OWNER: HUD.
 *
 * `docs/HUD_SPEC.md` §10 specifies every dynamic element as an explicit state
 * table with explicit durations, and §8 gives the curve for each transition.
 * That lives here rather than inside the widgets so that the widgets stay pure
 * draw code: a widget asks "what does the killfeed look like right now" and gets
 * an answer, and the only place a timer exists is this file.
 *
 * TIME. Accumulated from `FrameCtx.dt`, never from the wall clock. Under the
 * capture harness `dt` is a fixed 1/60 (or the shot's own `dt`), so every
 * animation lands on exactly the same phase on every machine — which is what
 * makes a HUD with fourteen simultaneous tweens screenshot-comparable at all.
 *
 * INPUTS. Everything arrives on the `FxBus` (`FxEventMap`), drained once per
 * frame by CORE at `RenderStage.Sample`. Presentation code must never subscribe
 * to the `SimBus`; live match numbers are READ from `GameMode.state` instead.
 */
import * as THREE from 'three';
import {
  Team,
  type FxBus,
  type ImpactEvent,
  type KillFeedEntry,
  type Rng,
  type Vec3,
  type WeaponId,
} from '@/engine/types';
import { clamp01, EASE } from './theme';
import { createHudCounters, type HudCounters } from './probe';

export type NoticeKind = 'capture' | 'lost' | 'objective' | 'system';
export type HitmarkerKind = 'body' | 'head' | 'armour' | 'kill';
export type RootState = 'default' | 'capturing' | 'dead' | 'spawnmenu' | 'scoreboard';

/* --------------------------------------------------------------- records -- */

export interface KillRow {
  readonly entry: KillFeedEntry;
  readonly local: boolean;
  born: number;
  /** Set when the row is evicted early by a sixth arrival (§10.4). */
  evictedAt: number;
  /** Reflow origin, so rows below a departing row slide rather than jump. */
  slotFrom: number;
  slotTo: number;
  slotAt: number;
}

export interface Hitmarker {
  kind: HitmarkerKind;
  born: number;
  /** World anchor — §6.23 puts the mark on the VICTIM, not on the crosshair. */
  world: THREE.Vector3;
  hasWorld: boolean;
  /** Last projected position, held if the victim despawns mid-animation. */
  screenX: number;
  screenY: number;
  screenValid: boolean;
}

export interface DamageChip {
  world: THREE.Vector3;
  total: number;
  born: number;
  lastHit: number;
  popAt: number;
  key: number;
}

export interface DamageSector {
  alpha: number;
  born: number;
  active: boolean;
}

export interface Notice {
  text: string;
  kind: NoticeKind;
  born: number;
  duration: number;
}

export interface XpToast {
  value: number;
  progress: number;
  total: number;
  born: number;
}

export interface KillCluster {
  victim: string;
  victimTeam: Team;
  tags: string[];
  points: number;
  born: number;
}

export interface ScorePopup {
  label: string;
  value: number;
  born: number;
}

export interface BloodBlob {
  x: number;
  y: number;
  r: number;
  rot: number;
  born: number;
  strength: number;
}

export interface SpotPin {
  world: THREE.Vector3;
  born: number;
}

/**
 * §6.31. No lane publishes deployed gadgets on the contract, so this list is
 * empty during normal play and is populated only by the HUD shot scenarios —
 * flagged in the lane report rather than faked into live gameplay.
 */
export interface GadgetMarker {
  world: THREE.Vector3;
  kind: 'ammo' | 'med' | 'sensor';
}

/* ------------------------------------------------------------- constants -- */

const KILLFEED_MAX = 5;
const KILLFEED_IN = 0.18;
const KILLFEED_HOLD = 6.0;
const KILLFEED_HOLD_LOCAL = 8.0;
const KILLFEED_OUT = 0.35;
const KILLFEED_REFLOW = 0.16;

const HIT_POP = 0.07;
const HIT_HOLD = 0.11;
const HIT_OUT = 0.18;
const HIT_OUT_KILL = 0.32;

const DAMAGE_LIFE = 0.85;
const DAMAGE_MERGE = 0.6;

const DMG_DIR_RISE = 0.09;
const DMG_DIR_HOLD = 0.9;
const DMG_DIR_FADE = 0.5;

const NOTICE_IN = 0.18;
const NOTICE_OUT = 0.4;

const XP_LIFE = 2.1;
const CLUSTER_LIFE = 2.0;
const POPUP_LIFE = 1.5;
const SPOT_LIFE = 4.0;
const BLOOD_LIFE = 4.0;

/** §8.2: ticket fill lerps over 450 ms and never snaps. */
const TICKET_LERP = 0.45;

export class HudState {
  /** Seconds since boot, accumulated from frame dt. Deterministic under capture. */
  time = 0;

  root: RootState = 'default';

  readonly killfeed: KillRow[] = [];
  hitmarker: Hitmarker | null = null;
  readonly damageChips: DamageChip[] = [];
  readonly damageSectors: DamageSector[] = Array.from({ length: 8 }, () => ({ alpha: 0, born: -99, active: false }));
  readonly notices: Notice[] = [];
  readonly xpToasts: XpToast[] = [];
  readonly clusters: KillCluster[] = [];
  readonly popups: ScorePopup[] = [];
  readonly blood: BloodBlob[] = [];
  readonly spots: SpotPin[] = [];
  readonly gadgetMarkers: GadgetMarker[] = [];

  /** Ticket bar (§10.1). */
  ticketShown: number[] = [0, 0, 0];
  ticketTarget: number[] = [0, 0, 0];
  ticketChangedAt: number[] = [-99, -99, -99];
  ticketInitialised = false;

  /** Crosshair bloom is deliberately asymmetric (§8.2): fast out, eased back. */
  spreadShown = 0;

  /** Squad bars heal over 250 ms and drop INSTANTLY (§8.2) — a lerped hit hides itself. */
  readonly healthShown = new Map<number, number>();

  /** Capture-chip crossfade, keyed by point index. */
  readonly chipState: number[] = [];
  readonly chipChangedAt: number[] = [];

  /** Local player marked by an enemy (§10.9b). */
  spottedSince = -99;
  spotted = false;

  /** Interaction prompt (§6.17). */
  prompt: { key: string; label: string; hold: number; since: number } | null = null;

  /** Chip press flash (§6.16). */
  readonly chipPress = new Map<string, number>();

  /** Last impact from the local player this frame, for hitmarker world anchoring. */
  private pendingImpact: THREE.Vector3 | null = null;
  private pendingImpactDamage = 0;
  private pendingImpactKey = 0;
  /**
   * Who fired the round behind the most recent `impact` in this drain, or null
   * when no ballistic impact has been seen since the last `advance()`. Tri-state
   * on purpose — see the hitmarker gate in `attach()`.
   */
  private lastImpactShooter: number | null = null;

  /**
   * The kill cluster raised for the local player's most recent kill, still
   * waiting for `MatchState.localScore` to catch up with the points it earned.
   * GAME scores a kill on the sim bus at `TickPhase.Cleanup` and republishes
   * `localScore` at the TOP of the next `TickPhase.Mode`, so the score is always
   * at least one tick behind the killfeed event that announced the kill.
   */
  private unscoredCluster: KillCluster | null = null;
  private lastScore = -1;

  /** Behavioural counters. See `probe.ts` — nothing in the HUD reads these. */
  readonly counters: HudCounters = createHudCounters();

  private detach: (() => void)[] = [];
  private rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng.fork('hud.state');
  }

  /* ------------------------------------------------------------- wiring -- */

  /**
   * Subscribe to the presentation bus. GAME emits `killfeed`, `hitmarker`,
   * `damageTaken` and `banner`; WEAPONS emits `hitmarker` and `impact`. Nothing
   * had to be added to the contract for the HUD to come alive.
   *
   * THIS IS THE ONLY WAY REAL GAMEPLAY REACHES THE HUD, and it is deliberately
   * one-way: presentation subscribes to the `FxBus` and never to the `SimBus`
   * (§4 of the contract), so nothing drawn here can perturb the simulation and
   * a capture stays reproducible.
   */
  attach(
    fx: FxBus,
    hooks: {
      localName: () => string;
      localEntity: () => number;
      viewYaw: () => number;
      damageOf: (impact: ImpactEvent) => number;
    },
  ): void {
    this.release();
    this.detach.push(
      fx.on('impact', (e) => {
        this.counters.impacts++;
        // §6.23 anchors the marker on the victim, but `FxEventMap.hitmarker`
        // carries no position. `impact` is emitted immediately before it, in the
        // same drain, and does — so the pair is correlated here rather than
        // widening a frozen event map.
        //
        // It also carries the SHOOTER, which is the other half of the pairing:
        // WEAPONS emits a `hitmarker` for every soldier hit by anybody, so
        // without this the reticle marks every round two bots trade across the
        // map. Correlating instead of filtering upstream keeps the fix inside
        // the lane that owns the symptom.
        const shooter = e.shooter as unknown as number;
        this.lastImpactShooter = shooter;
        if (shooter !== hooks.localEntity() || (e.target as unknown as number) === 0) {
          this.pendingImpact = null;
          this.pendingImpactDamage = 0;
          return;
        }
        this.counters.impactsByLocal++;
        this.pendingImpact = (e.point as THREE.Vector3).clone();
        this.pendingImpactKey = e.target as unknown as number;
        this.pendingImpactDamage = hooks.damageOf(e);
      }),
    );
    this.detach.push(
      fx.on('hitmarker', (e) => {
        // `lethal` is only ever set by GAME, which already established that the
        // attacker was the local player, so a lethal mark is trusted outright.
        // A non-lethal one is suppressed ONLY on positive evidence that the
        // round belonged to somebody else — a null `lastImpactShooter` means no
        // ballistic impact preceded it (an explosion, a melee, a fall) and is
        // let through rather than silently swallowed.
        if (!e.lethal && this.lastImpactShooter !== null && this.lastImpactShooter !== hooks.localEntity()) {
          this.counters.hitmarkersSuppressed++;
          return;
        }
        const kind: HitmarkerKind = e.lethal ? 'kill' : e.headshot ? 'head' : e.armour ? 'armour' : 'body';
        this.showHitmarker(kind, this.pendingImpact, 'event');
        if (this.pendingImpact && this.pendingImpactDamage > 0) {
          this.addDamage(this.pendingImpactKey, this.pendingImpact, this.pendingImpactDamage);
          this.counters.damageChips++;
          // ONE chip per impact. A single round on a soldier raises TWO
          // hitmarkers — WEAPONS emits one the moment the round lands, GAME
          // emits another when it resolves the damage — and the mark is
          // idempotent but the chip is not: consecutive hits inside 0.6 s
          // ACCUMULATE (§6.24), so leaving the estimate armed made every damage
          // number in the game read exactly double.
          this.pendingImpactDamage = 0;
        }
      }),
    );
    this.detach.push(
      fx.on('damageTaken', (e) => {
        // TWO conversions, and the arc points at nothing without both.
        // `DamageInfo.direction` runs ATTACKER → TARGET, and §10.6's sector 0 is
        // straight ahead, so the indicator wants the vector back TOWARDS the
        // attacker; and the sectors are screen-relative, so it wants the view
        // yaw as well. Without them a shot from the front lit the rear arc.
        TOWARDS_THREAT.copy(e.direction as THREE.Vector3).negate();
        this.addDamageDirection(TOWARDS_THREAT, e.amount, hooks.viewYaw());
        this.addBlood(e.amount);
        this.counters.damageDirections++;
      }),
    );
    this.detach.push(
      fx.on('killfeed', (e) => {
        const localName = hooks.localName();
        this.pushKillFeed(e, localName, 'event');
        if (e.victim === localName) this.counters.killfeedLocalDeaths++;
        if (e.killer !== localName || e.victim === localName) return;
        // Killing your own side still earns a killfeed row — it happened, and
        // hiding it is how a player never learns they are shooting through a
        // squadmate — but never a congratulatory cluster.
        if (e.killerTeam === e.victimTeam) return;
        // §6.25. The killfeed row says a kill happened; the cluster is the part
        // that says YOU made it. Points are patched in by `syncScore` once GAME
        // publishes the score it earned.
        this.counters.killfeedLocalKills++;
        this.counters.killClusters++;
        this.pushCluster(e.victim, e.victimTeam, e.headshot ? ['HEADSHOT'] : [], 0);
        this.unscoredCluster = this.clusters[this.clusters.length - 1] ?? null;
      }),
    );
    this.detach.push(
      fx.on('banner', (e) => {
        this.pushNotice(e.text, e.tone === 'friendly' ? 'capture' : e.tone === 'hostile' ? 'lost' : 'system');
        if (e.sub.length > 0) this.pushNotice(e.sub, 'objective', 2.0);
        this.counters.notices++;
      }),
    );
  }

  /**
   * Fill in the pending kill cluster's points from the local player's score,
   * once GAME has published it. Called once per frame from the HUD build.
   * `PlayerScore.score` is the only score number on the contract, so the award
   * value is a real delta rather than a HUD-invented constant.
   */
  syncScore(score: number): void {
    if (this.lastScore < 0) {
      this.lastScore = score;
      return;
    }
    if (score <= this.lastScore) return;
    const delta = score - this.lastScore;
    this.lastScore = score;
    if (this.unscoredCluster && this.clusters.includes(this.unscoredCluster)) {
      this.unscoredCluster.points = delta;
      this.unscoredCluster = null;
    }
  }

  release(): void {
    for (const off of this.detach) off();
    this.detach = [];
  }

  /**
   * The damage value the chip shows. `FxEventMap.hitmarker` carries no amount,
   * so it is recomputed from the weapon's PUBLIC damage curve and zone
   * multipliers (`WeaponDef.ballistics`) at the impact's own distance. It is an
   * approximation in exactly one respect — the penetration energy fraction is
   * not on the contract — and is flagged as such in the lane report.
   */
  noteDamageEstimate(amount: number): void {
    this.pendingImpactDamage = amount;
  }

  /* ------------------------------------------------------------ mutators -- */

  /**
   * `source` exists only so the behavioural counters can tell a HUD that
   * REACTED from a HUD that was POSED — the exact distinction a screenshot
   * cannot make, and the one that let a scripted killfeed pass twelve rounds of
   * visual review. It changes nothing about what is drawn.
   */
  showHitmarker(kind: HitmarkerKind, world: Vec3 | null, source: 'event' | 'scripted' = 'scripted'): void {
    if (source === 'event') {
      if (kind === 'kill') this.counters.hitmarkerKill++;
      else if (kind === 'head') this.counters.hitmarkerHead++;
      else if (kind === 'armour') this.counters.hitmarkerArmour++;
      else this.counters.hitmarkerBody++;
    } else {
      this.counters.scriptedHitmarkers++;
    }
    const rank: Record<HitmarkerKind, number> = { body: 0, armour: 1, head: 2, kill: 3 };
    // §10.5 precedence: two arriving in the same frame keep the louder one.
    if (this.hitmarker && this.hitmarker.born === this.time && rank[this.hitmarker.kind] > rank[kind]) return;
    const anchor = this.hitmarker?.world ?? new THREE.Vector3();
    if (world) anchor.copy(world as THREE.Vector3);
    this.hitmarker = {
      kind,
      born: this.time,
      world: anchor,
      hasWorld: world !== null,
      screenX: 0,
      screenY: 0,
      screenValid: false,
    };
  }

  addDamage(key: number, world: Vec3, amount: number): void {
    for (const chip of this.damageChips) {
      if (chip.key === key && this.time - chip.lastHit < DAMAGE_MERGE) {
        chip.total += amount;
        chip.lastHit = this.time;
        chip.popAt = this.time;
        return;
      }
    }
    this.damageChips.push({
      world: (world as THREE.Vector3).clone(),
      total: amount,
      born: this.time,
      lastHit: this.time,
      popAt: this.time,
      key,
    });
  }

  /**
   * §10.6: eight fixed 45° sectors, each with one accumulator. `direction`
   * points FROM the player TOWARDS the threat, in world space.
   *
   * The yaw term ADDS. `forwardFromYaw` is `(-sin y, 0, -cos y)`, so a threat
   * dead ahead gives `atan2(d.x, -d.z) = -y`, and only `+ y` cancels it to
   * sector 0. Subtracting doubled the yaw instead, which reads as correct while
   * standing at yaw 0 — the pose every HUD screenshot in this repo is taken in.
   */
  addDamageDirection(direction: Vec3, amount: number, cameraYaw = 0): void {
    const d = direction as THREE.Vector3;
    const bearing = Math.atan2(d.x, -d.z) + cameraYaw;
    const idx = ((Math.floor((bearing + Math.PI / 8) / (Math.PI / 4)) % 8) + 8) % 8;
    const sector = this.damageSectors[idx];
    const alpha = 0.45 + 0.5 * clamp01(amount / 40);
    sector.alpha = Math.max(sector.active ? sector.alpha : 0, alpha);
    sector.born = this.time;
    sector.active = true;
  }

  addBlood(amount: number): void {
    const n = Math.min(4, 1 + Math.floor(amount / 18));
    for (let i = 0; i < n; i++) {
      // Periphery only, densest in the two bottom corners (§6.22).
      const bottomBias = this.rng.next() < 0.62;
      const x = this.rng.next() < 0.5 ? this.rng.range(0.02, 0.24) : this.rng.range(0.76, 0.98);
      const y = bottomBias ? this.rng.range(0.62, 0.98) : this.rng.range(0.02, 0.5);
      this.blood.push({
        x,
        y,
        r: this.rng.range(1.4, 8.3),
        rot: this.rng.range(0, Math.PI * 2),
        born: this.time,
        strength: clamp01(amount / 45),
      });
    }
    while (this.blood.length > 26) this.blood.shift();
  }

  pushKillFeed(entry: KillFeedEntry, localName: string, source: 'event' | 'scripted' = 'scripted'): void {
    if (source === 'event') this.counters.killfeedRows++;
    else this.counters.scriptedKillfeedRows++;
    // A row involving the local player is recoloured white and holds 2 s longer
    // (§6.6). The name comes from `GameMode.nameOf(localEntity)` rather than
    // from a hardcoded literal.
    const local = entry.killer === localName || entry.victim === localName;
    if (this.killfeed.length >= KILLFEED_MAX) {
      const oldest = this.killfeed[0];
      if (oldest.evictedAt < 0) oldest.evictedAt = this.time;
    }
    const slot = this.killfeed.filter((r) => r.evictedAt < 0).length;
    this.killfeed.push({ entry, local, born: this.time, evictedAt: -1, slotFrom: slot, slotTo: slot, slotAt: this.time });
    this.reflowKillfeed();
  }

  private reflowKillfeed(): void {
    let slot = 0;
    for (const row of this.killfeed) {
      if (row.evictedAt >= 0) continue;
      if (row.slotTo !== slot) {
        row.slotFrom = this.killRowSlot(row);
        row.slotTo = slot;
        row.slotAt = this.time;
      }
      slot++;
    }
  }

  killRowSlot(row: KillRow): number {
    const t = clamp01((this.time - row.slotAt) / KILLFEED_REFLOW);
    return row.slotFrom + (row.slotTo - row.slotFrom) * EASE.out(t);
  }

  /** 0 = gone, 1 = fully present. Also gives the slide-in offset. */
  killRowAlpha(row: KillRow): number {
    const age = this.time - row.born;
    const inA = clamp01(age / KILLFEED_IN);
    if (row.evictedAt >= 0) return EASE.out(inA) * clamp01(1 - (this.time - row.evictedAt) / KILLFEED_OUT);
    const hold = row.local ? KILLFEED_HOLD_LOCAL : KILLFEED_HOLD;
    const out = clamp01(1 - (age - KILLFEED_IN - hold) / KILLFEED_OUT);
    return EASE.out(inA) * out;
  }

  killRowSlideUnits(row: KillRow): number {
    return 2.5 * (1 - EASE.out(clamp01((this.time - row.born) / KILLFEED_IN)));
  }

  pushNotice(text: string, kind: NoticeKind, duration = 2.5): void {
    this.notices.push({ text, kind, born: this.time, duration });
    while (this.notices.length > 3) this.notices.shift();
  }

  pushXp(value: number, progress: number, total: number): void {
    this.xpToasts.push({ value, progress, total, born: this.time });
    while (this.xpToasts.length > 3) this.xpToasts.shift();
  }

  pushCluster(victim: string, victimTeam: Team, tags: string[], points: number): void {
    this.clusters.push({ victim, victimTeam, tags, points, born: this.time });
    while (this.clusters.length > 3) this.clusters.shift();
  }

  pushPopup(label: string, value: number): void {
    this.popups.push({ label, value, born: this.time });
    while (this.popups.length > 4) this.popups.shift();
  }

  pushSpot(world: Vec3): void {
    this.spots.push({ world: (world as THREE.Vector3).clone(), born: this.time });
    while (this.spots.length > 12) this.spots.shift();
  }

  setPrompt(key: string, label: string, hold = 0): void {
    if (!this.prompt || this.prompt.label !== label) this.prompt = { key, label, hold, since: this.time };
  }
  clearPrompt(): void {
    this.prompt = null;
  }

  pressChip(key: string): void {
    this.chipPress.set(key, this.time);
  }
  chipPressAlpha(key: string): number {
    const t = this.chipPress.get(key);
    if (t === undefined) return 0;
    const age = this.time - t;
    if (age < 0.09) return age / 0.09;
    return clamp01(1 - (age - 0.09) / 0.2);
  }

  /* ------------------------------------------------------------- ageing -- */

  advance(dt: number): void {
    this.time += dt;

    // Killfeed: retire rows whose out has finished.
    for (let i = this.killfeed.length - 1; i >= 0; i--) {
      const row = this.killfeed[i];
      const age = this.time - row.born;
      const hold = row.local ? KILLFEED_HOLD_LOCAL : KILLFEED_HOLD;
      const expired = row.evictedAt >= 0 ? this.time - row.evictedAt > KILLFEED_OUT : age > KILLFEED_IN + hold + KILLFEED_OUT;
      if (expired) this.killfeed.splice(i, 1);
    }
    this.reflowKillfeed();

    if (this.hitmarker) {
      const life = HIT_POP + HIT_HOLD + (this.hitmarker.kind === 'kill' ? HIT_OUT_KILL : HIT_OUT);
      if (this.time - this.hitmarker.born > life) this.hitmarker = null;
    }

    for (let i = this.damageChips.length - 1; i >= 0; i--) {
      if (this.time - this.damageChips[i].popAt > DAMAGE_LIFE) this.damageChips.splice(i, 1);
    }
    for (const s of this.damageSectors) {
      if (s.active && this.time - s.born > DMG_DIR_RISE + DMG_DIR_HOLD + DMG_DIR_FADE) s.active = false;
    }
    for (let i = this.notices.length - 1; i >= 0; i--) {
      const n = this.notices[i];
      if (this.time - n.born > NOTICE_IN + n.duration + NOTICE_OUT) this.notices.splice(i, 1);
    }
    for (let i = this.xpToasts.length - 1; i >= 0; i--) if (this.time - this.xpToasts[i].born > XP_LIFE) this.xpToasts.splice(i, 1);
    for (let i = this.clusters.length - 1; i >= 0; i--) if (this.time - this.clusters[i].born > CLUSTER_LIFE) this.clusters.splice(i, 1);
    for (let i = this.popups.length - 1; i >= 0; i--) if (this.time - this.popups[i].born > POPUP_LIFE) this.popups.splice(i, 1);
    for (let i = this.spots.length - 1; i >= 0; i--) if (this.time - this.spots[i].born > SPOT_LIFE + 0.6) this.spots.splice(i, 1);
    for (let i = this.blood.length - 1; i >= 0; i--) if (this.time - this.blood[i].born > BLOOD_LIFE) this.blood.splice(i, 1);

    this.pendingImpact = null;
    this.pendingImpactDamage = 0;
    this.lastImpactShooter = null;
  }

  /* -------------------------------------------------------------- reads -- */

  hitmarkerPhase(): { scale: number; alpha: number } | null {
    const h = this.hitmarker;
    if (!h) return null;
    const age = this.time - h.born;
    const out = h.kind === 'kill' ? HIT_OUT_KILL : HIT_OUT;
    if (age < HIT_POP) return { scale: 0.55 + 0.45 * EASE.snap(age / HIT_POP), alpha: 1 };
    if (age < HIT_POP + HIT_HOLD) return { scale: 1, alpha: 1 };
    return { scale: 1, alpha: clamp01(1 - (age - HIT_POP - HIT_HOLD) / out) };
  }

  damageSectorAlpha(index: number): number {
    const s = this.damageSectors[index];
    if (!s.active) return 0;
    const age = this.time - s.born;
    if (age < DMG_DIR_RISE) return s.alpha * EASE.snap(age / DMG_DIR_RISE);
    if (age < DMG_DIR_RISE + DMG_DIR_HOLD) return s.alpha;
    return s.alpha * clamp01(1 - (age - DMG_DIR_RISE - DMG_DIR_HOLD) / DMG_DIR_FADE);
  }

  noticeAlpha(n: Notice): number {
    const age = this.time - n.born;
    if (age < NOTICE_IN) return EASE.out(age / NOTICE_IN);
    return clamp01(1 - (age - NOTICE_IN - n.duration) / NOTICE_OUT);
  }

  /* ------------------------------------------------------- ticket + bars -- */

  syncTickets(tickets: Readonly<Record<Team, number>>, dt: number): void {
    const teams: Team[] = [Team.Coalition, Team.Insurgent];
    for (const t of teams) {
      const want = tickets[t] ?? 0;
      if (!this.ticketInitialised) {
        this.ticketShown[t] = want;
        this.ticketTarget[t] = want;
        continue;
      }
      if (want !== this.ticketTarget[t]) {
        this.ticketTarget[t] = want;
        this.ticketChangedAt[t] = this.time;
      }
      // Exponential approach with a 450 ms time constant — §8.2's `E_OUT` lerp
      // toward the target, evaluated per frame rather than as a keyframe, so the
      // bar stays correct when the model changes mid-transition.
      const k = 1 - Math.exp((-dt * 3) / TICKET_LERP);
      this.ticketShown[t] += (this.ticketTarget[t] - this.ticketShown[t]) * k;
      if (Math.abs(this.ticketTarget[t] - this.ticketShown[t]) < 0.05) this.ticketShown[t] = this.ticketTarget[t];
    }
    this.ticketInitialised = true;
  }

  ticketDigitFlash(team: Team): number {
    const age = this.time - this.ticketChangedAt[team];
    if (age < 0.12) return 1;
    return clamp01(1 - (age - 0.12) / 0.25);
  }

  ticketDraining(team: Team): boolean {
    return this.time - this.ticketChangedAt[team] < 1.5;
  }

  /** §8.2: grow linearly over 60 ms, recover over 220 ms `E_OUT`. */
  syncSpread(target: number, dt: number): void {
    if (target > this.spreadShown) {
      this.spreadShown = Math.min(target, this.spreadShown + (dt / 0.06) * Math.max(0.05, target));
    } else {
      const k = 1 - Math.exp((-dt * 3) / 0.22);
      this.spreadShown += (target - this.spreadShown) * k;
    }
  }

  syncHealth(key: number, value: number, dt: number): number {
    const prev = this.healthShown.get(key);
    if (prev === undefined) {
      this.healthShown.set(key, value);
      return value;
    }
    // Damage is instant; healing eases. An eased damage bar hides the hit, which
    // is the one piece of information the bar exists to convey.
    let next = value;
    if (value > prev) {
      const k = 1 - Math.exp((-dt * 3) / 0.25);
      next = prev + (value - prev) * k;
    }
    this.healthShown.set(key, next);
    return next;
  }

  /* --------------------------------------------------------------- reset -- */

  reset(): void {
    this.time = 0;
    this.killfeed.length = 0;
    this.hitmarker = null;
    this.damageChips.length = 0;
    for (const s of this.damageSectors) {
      s.alpha = 0;
      s.born = -99;
      s.active = false;
    }
    this.notices.length = 0;
    this.xpToasts.length = 0;
    this.clusters.length = 0;
    this.popups.length = 0;
    this.blood.length = 0;
    this.spots.length = 0;
    this.gadgetMarkers.length = 0;
    this.ticketInitialised = false;
    this.ticketShown = [0, 0, 0];
    this.ticketTarget = [0, 0, 0];
    this.ticketChangedAt = [-99, -99, -99];
    this.spreadShown = 0;
    this.healthShown.clear();
    this.chipState.length = 0;
    this.chipChangedAt.length = 0;
    this.chipPress.clear();
    this.prompt = null;
    this.spotted = false;
    this.spottedSince = -99;
    this.root = 'default';
    this.pendingImpact = null;
    this.pendingImpactDamage = 0;
    this.lastImpactShooter = null;
    this.unscoredCluster = null;
    this.lastScore = -1;
    // Counters are deliberately NOT cleared here. `resetHud` runs at the top of
    // every capture, and a soak that reset its own instrument on every shot
    // would measure nothing. `__HUD__.reset()` is the explicit way to zero them.
  }
}

/** Scratch for the attacker-relative bearing. Module scope: no per-hit garbage. */
const TOWARDS_THREAT = new THREE.Vector3();

/** Weapon-class → pictogram class, for the killfeed glyph and the weapon card. */
export function weaponClassOf(id: WeaponId): 'ar' | 'carbine' | 'smg' | 'dmr' | 'lmg' | 'shotgun' | 'pistol' {
  switch (id) {
    case 'carbine':
      return 'carbine';
    case 'smg_compact':
      return 'smg';
    case 'dmr_marksman':
      return 'dmr';
    case 'lmg_support':
      return 'lmg';
    case 'shotgun':
      return 'shotgun';
    case 'sidearm':
      return 'pistol';
    default:
      return 'ar';
  }
}
