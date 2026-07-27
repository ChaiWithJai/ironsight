/**
 * HudService. OWNER: HUD.
 *
 * The HUD is rendered INTO THE WEBGL CANVAS as an orthographic pass AFTER
 * tonemapping, at NATIVE canvas resolution (never `renderScale`). There is no
 * DOM UI anywhere in this project: `tools/capture.mjs` screenshots the canvas
 * only, so a DOM HUD is invisible in every single shot. Drawing UI BEFORE
 * tonemap is the most common single giveaway that a frame came out of a hobby
 * post stack.
 *
 * WHAT THIS FILE OWNS: the service surface, the per-frame `HudContext`, and the
 * three shot scenarios. The drawing lives in `widgets/`, the state machines in
 * `state.ts`, the geometry in `draw.ts` and the pass in `pass.ts`.
 *
 * WHAT IT READS, AND FROM WHERE. Every number on screen comes off the contract:
 * `GameMode.state` for tickets, points and scores; `PlayerService` for the
 * squad, health and yaw; `WeaponService` for ammo, reload and spread;
 * `LevelService` for the capture points and the minimap footprints; and the
 * `FxBus` for killfeed, hitmarkers and damage direction. Nothing here reaches
 * into another lane's files and nothing was added to `types.ts` for it.
 *
 * TWO PIECES OF PRESENTATION STATE ARE HUD-OWNED, and are called out because
 * they are not read from anywhere: the gadget/throwable/ability loadout (§6.11
 * –6.13 — no lane publishes gadgets on the contract) and the deployed-gadget
 * world markers (§6.31). Both are specified elements of the HUD with no data
 * source, so the HUD supplies a stable, deterministic model for them rather
 * than leaving three specified clusters missing from the frame.
 */
import * as THREE from 'three';
import {
  BakeAssets,
  HitZone,
  RenderStage,
  Team,
  type AssetKey,
  type AssetRegistry,
  type BakedFont,
  type BootContext,
  type CapturePointDef,
  type FrameCtx,
  type HudService,
  type ImpactEvent,
  type QualitySettings,
  type Services,
  type WeaponDef,
} from '@/engine/types';
import { HudState, weaponClassOf } from './state';
import { Layout } from './layout';
import { TextPen } from './text';
import { HudRenderer } from './renderer';
import { HudPass } from './pass';
import { bakeMinimapPlate, type MinimapPlate } from './minimap-plate';
import { makeScreenPoint, projectWorld, type GadgetSlot, type HudContext, type RailSlot, type ScreenPoint, type SquadRow } from './context';
import { COLOUR } from './theme';
import { installHudProbe, type HudSnapshot } from './probe';
import type { ClassKind } from './glyphs';

/* ------------------------------------------------------------- scenarios -- */

/**
 * Shot files cannot reach a service — `ShotContext` exposes no route and
 * boundary CI keeps `src/shots/` out of `src/ui/`. `seed(n)` is the one channel
 * that does reach a lane: the frozen descriptor table hands it to `resetHud`.
 * These four constants are duplicated in `src/shots/hud.ts` and defined here.
 */
export const HUD_SEED_FULL = 0x48554430; // "HUD0"
export const HUD_SEED_COMBAT = 0x48554431;
export const HUD_SEED_DEPLOY = 0x48554432;
export const HUD_SEED_SCOREBOARD = 0x48554433;

interface ScriptStep {
  readonly at: number;
  readonly run: (hud: HudImpl) => void;
}

const TMP_EULER = new THREE.Euler(0, 0, 0, 'YXZ');

/* ---------------------------------------------------------------- squad --- */

const CLASSES: readonly ClassKind[] = ['assault', 'engineer', 'support', 'recon'];

/* --------------------------------------------------------------- loadout -- */

/** Stable per-weapon-class loadouts. See the header note on HUD-owned state. */
function loadoutFor(cls: string): { gadgets: GadgetSlot[]; throwables: GadgetSlot[]; rail: RailSlot[] } {
  const support = cls === 'lmg';
  const recon = cls === 'dmr';
  return {
    gadgets: [
      { icon: support ? 'ammo' : recon ? 'sensor' : 'breach', key: '3', count: 2, infinite: false, cooldown: 0, selected: false },
      { icon: 'medkit', key: '4', count: 1, infinite: false, cooldown: 0, selected: true },
      { icon: 'repair', key: '5', count: 0, infinite: true, cooldown: 1, selected: false },
    ],
    throwables: [
      { icon: 'frag', key: 'G', count: 2, infinite: false, cooldown: 0, selected: false },
      { icon: 'smoke', key: 'T', count: 1, infinite: false, cooldown: 0, selected: false },
    ],
    rail: [
      { icon: 'sensor', cooldown: 0, selected: true, passive: false, charge: 0 },
      { icon: 'launcher', cooldown: 1, selected: false, passive: false, charge: 0.62 },
      { icon: 'medkit', cooldown: 0, selected: false, passive: false, charge: 0 },
      { icon: 'breach', cooldown: 0, selected: false, passive: true, charge: 0 },
    ],
  };
}

/* ------------------------------------------------------------- the impl --- */

class HudImpl implements HudService {
  visible = true;
  readonly font: AssetKey<BakedFont> = BakeAssets.font;

  readonly state: HudState;
  readonly layout = new Layout();
  readonly renderer: HudRenderer;
  private pen: TextPen | null = null;
  private plate: MinimapPlate | null = null;
  private plateBaked = false;
  private readonly screen: ScreenPoint = makeScreenPoint();
  private script: ScriptStep[] = [];
  private scriptCursor = 0;
  /**
   * Last frame's camera yaw. The damage-direction arcs are screen-relative and
   * are raised from an FxBus handler that runs at `RenderStage.Sample`, before
   * this frame's camera has been read — so they use the frame just drawn, which
   * is the same one-frame relationship every other world-anchored HUD mark has.
   */
  private viewYaw = 0;

  constructor(private readonly boot: BootContext) {
    this.state = new HudState(boot.rng);
    this.renderer = new HudRenderer(boot.services.materials);
    const font = boot.assets.tryGet(BakeAssets.font);
    if (font) {
      this.pen = new TextPen(font);
      this.renderer.setFont(font);
    }
  }

  private get services(): Services {
    return this.boot.services;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  showHitmarker(kind: 'body' | 'head' | 'armour' | 'kill'): void {
    this.state.showHitmarker(kind, null);
  }

  pushKillFeed(entry: Parameters<HudService['pushKillFeed']>[0]): void {
    this.state.pushKillFeed(entry, this.localName());
  }

  pushNotice(text: string, kind: 'capture' | 'lost' | 'objective' | 'system', durationSeconds?: number): void {
    this.state.pushNotice(text, kind, durationSeconds ?? 2.5);
  }

  setDamageDirection(worldDirection: THREE.Vector3, amount: number): void {
    this.state.addDamageDirection(worldDirection, amount, this.services.player.state.yaw);
  }

  forceState(state: string): void {
    const allowed = ['default', 'capturing', 'dead', 'spawnmenu', 'scoreboard'] as const;
    const found = allowed.find((s) => s === state);
    this.state.root = found ?? 'default';
  }

  localName(): string {
    return this.services.mode.nameOf(this.services.player.localEntity);
  }

  /* ------------------------------------------------------------- wiring -- */

  attach(): void {
    this.state.attach(this.services.fx, {
      localName: () => this.localName(),
      localEntity: () => this.services.player.localEntity as unknown as number,
      // The SCREEN's yaw, not the body's: §10.6's sectors are screen-relative
      // and the camera is what the viewer is looking through.
      viewYaw: () => this.viewYaw,
      damageOf: (e) => this.estimateDamage(e),
    });
    installHudProbe({
      counters: this.state.counters,
      services: () => this.services,
      snapshot: () => this.snapshot(),
    });
  }

  /**
   * Plain-data view of everything transient the HUD is showing, for the
   * behavioural probe. Reads only; builds nothing the frame needs.
   */
  private snapshot(): HudSnapshot {
    return {
      root: this.state.root,
      time: this.state.time,
      hitmarker: this.state.hitmarker ? this.state.hitmarker.kind : null,
      killfeed: this.state.killfeed.map((row) => ({
        killer: row.entry.killer,
        victim: row.entry.victim,
        headshot: row.entry.headshot,
        local: row.local,
      })),
      clusters: this.state.clusters.map((c) => ({ victim: c.victim, tags: [...c.tags], points: c.points })),
      activeDamageSectors: this.state.damageSectors.filter((s) => s.active).length,
      damageChips: this.state.damageChips.length,
      localName: this.localName(),
    };
  }

  /**
   * The damage number the chip shows. `FxEventMap.hitmarker` carries no amount,
   * so it is recomputed from the weapon's PUBLIC damage curve and zone
   * multipliers at the impact's own distance — the same inputs WEAPONS uses.
   * It is an approximation in exactly one respect: the residual-energy fraction
   * after a penetration is not on the contract, so a shot fired THROUGH cover
   * reads high. Flagged in the lane report.
   */
  private estimateDamage(impact: ImpactEvent): number {
    if ((impact.target as unknown as number) === 0) return 0;
    let def: Readonly<WeaponDef> | null = null;
    try {
      def = this.services.weapons.def(impact.weapon);
    } catch {
      def = null;
    }
    if (!def) return 0;
    const curve = def.ballistics.damage;
    if (curve.length === 0) return 0;
    let base = curve[curve.length - 1].damage;
    for (let i = 0; i < curve.length; i++) {
      if (impact.distanceM <= curve[i].distance) {
        if (i === 0) {
          base = curve[0].damage;
        } else {
          const a = curve[i - 1];
          const b = curve[i];
          const t = (impact.distanceM - a.distance) / Math.max(1e-3, b.distance - a.distance);
          base = a.damage + (b.damage - a.damage) * t;
        }
        break;
      }
    }
    const zone = impact.zone === HitZone.None ? HitZone.Torso : impact.zone;
    const mult = def.ballistics.zoneMultipliers[zone] ?? 1;
    return Math.max(1, Math.round(base * mult));
  }

  /** Bake the minimap plate once, after LEVEL has built its colliders. */
  private ensurePlate(): void {
    if (this.plateBaked) return;
    this.plateBaked = true;
    const colliders = this.services.level.ready ? this.services.level.collectColliders() : [];
    this.plate = bakeMinimapPlate(colliders, this.boot.rng);
    this.renderer.setMap(this.plate.texture);
  }

  /* ---------------------------------------------------------- scenarios -- */

  arm(seed: number): void {
    this.script = [];
    this.scriptCursor = 0;
    const enemy = (n: number): string => `INSURGENT-${n}`;
    switch (seed) {
      case HUD_SEED_FULL:
        this.state.root = 'default';
        // Every step lands inside the 40-frame (0.667 s) capture window, so the
        // rows are all in HOLD when the grab happens rather than mid-slide.
        this.script = [
          { at: 0.05, run: (h) => h.state.pushKillFeed(kill('BRAVO-2', enemy(4), Team.Coalition, Team.Insurgent, 'ar_service', false), h.localName()) },
          { at: 0.12, run: (h) => h.state.pushKillFeed(kill(enemy(7), 'ECHO-3', Team.Insurgent, Team.Coalition, 'smg_compact', true), h.localName()) },
          { at: 0.19, run: (h) => h.state.pushKillFeed(kill('CHARLIE-5', enemy(2), Team.Coalition, Team.Insurgent, 'dmr_marksman', true), h.localName()) },
          { at: 0.26, run: (h) => h.state.pushKillFeed(kill('DELTA-1', enemy(6), Team.Coalition, Team.Insurgent, 'lmg_support', false), h.localName()) },
          { at: 0.3, run: (h) => h.state.pushXp(200, 3514, 4000) },
          { at: 0.34, run: (h) => h.state.setPrompt('F', 'RESUPPLY', 0.42) },
        ];
        break;
      case HUD_SEED_COMBAT:
        this.state.root = 'capturing';
        // 62 frames = 1.033 s. Each transient is placed so it is caught in the
        // phase that shows it best: the killfeed settled, the kill cluster fully
        // staged, the damage chip at full alpha and the gold kill hitmarker
        // partway through its 320 ms fade rather than at peak.
        this.script = [
          { at: 0.05, run: (h) => h.state.pushKillFeed(kill('BRAVO-2', enemy(4), Team.Coalition, Team.Insurgent, 'ar_service', false), h.localName()) },
          { at: 0.12, run: (h) => h.state.pushKillFeed(kill(enemy(7), 'ECHO-3', Team.Insurgent, Team.Coalition, 'lmg_support', false), h.localName()) },
          { at: 0.19, run: (h) => h.state.pushKillFeed(kill('CHARLIE-5', enemy(2), Team.Coalition, Team.Insurgent, 'shotgun', false), h.localName()) },
          {
            at: 0.3,
            run: (h) => {
              h.state.pushKillFeed(kill(h.localName(), enemy(9), Team.Coalition, Team.Insurgent, 'carbine', true), h.localName());
              h.state.pushCluster(enemy(9), Team.Insurgent, ['HEADSHOT', 'DEFENSIVE'], 150);
              h.state.pushXp(250, 3764, 4000);
            },
          },
          { at: 0.35, run: (h) => h.state.pushSpot(h.forwardPoint(46, 3.5)) },
          {
            at: 0.36,
            run: (h) => {
              h.state.gadgetMarkers.push({ world: h.forwardPoint(9, -1.2), kind: 'ammo' });
              h.state.gadgetMarkers.push({ world: h.forwardPoint(14, -1.1), kind: 'med' });
            },
          },
          {
            at: 0.4,
            run: (h) => {
              const target = h.forwardPoint(18, -0.6);
              h.state.showHitmarker('head', target);
              h.state.addDamage(4242, target, 47);
            },
          },
          { at: 0.55, run: (h) => h.state.pushPopup('NEUTRALIZING x2', 100) },
          {
            at: 0.75,
            run: (h) => {
              const target = h.forwardPoint(18, -0.6);
              h.state.addDamage(4242, target, 41);
              h.state.showHitmarker('kill', target);
            },
          },
          {
            at: 0.8,
            run: (h) => {
              h.state.addDamageDirection(new THREE.Vector3(0.82, 0, 0.57), 34);
              h.state.addDamageDirection(new THREE.Vector3(-0.44, 0, -0.9), 18);
              h.state.addBlood(34);
              h.state.spotted = true;
            },
          },
        ];
        break;
      case HUD_SEED_DEPLOY:
        this.state.root = 'spawnmenu';
        break;
      case HUD_SEED_SCOREBOARD:
        this.state.root = 'scoreboard';
        break;
      default:
        this.state.root = 'default';
        break;
    }
  }

  /** A world point `d` metres along the camera's forward, offset in Y. */
  forwardPoint(distance: number, dy: number): THREE.Vector3 {
    const cam = this.services.camera.state;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.rotation as THREE.Quaternion);
    return (cam.position as THREE.Vector3).clone().addScaledVector(dir, distance).setY((cam.position as THREE.Vector3).y + dy);
  }

  private runScript(): void {
    while (this.scriptCursor < this.script.length && this.state.time >= this.script[this.scriptCursor].at) {
      this.script[this.scriptCursor].run(this);
      this.scriptCursor++;
    }
  }

  /* -------------------------------------------------------- frame build -- */

  build(ctx: FrameCtx, width: number, height: number): HudContext | null {
    if (!this.visible || !this.services.renderer.overlays.hud) return null;
    if (!this.pen) {
      const font = this.boot.assets.tryGet(BakeAssets.font);
      if (!font) return null;
      this.pen = new TextPen(font);
      this.renderer.setFont(font);
    }
    this.ensurePlate();

    this.state.advance(ctx.dt);
    this.runScript();

    this.layout.resize(width, height, 1);
    const match = this.services.mode.state;
    const player = this.services.player.state;
    const localTeam = match.localTeam;
    this.state.syncTickets(match.tickets, ctx.dt);

    const weapon = this.services.weapons.stateOf(this.services.player.localEntity);
    const weaponDef = weapon ? this.services.weapons.def(weapon.def) : null;
    this.state.syncSpread(weapon ? weapon.currentSpreadDeg : 0, ctx.dt);

    // The stowed slot: the sidearm, unless the primary IS the sidearm.
    const secondaryId = weaponDef && weaponDef.id === 'sidearm' ? 'smg_compact' : 'sidearm';
    const secondary = this.services.weapons.def(secondaryId);

    const loadout = loadoutFor(weaponDef ? weaponDef.class : 'ar');

    const points: readonly Readonly<CapturePointDef>[] = this.services.level.capturePoints;
    const squad = this.buildSquad(localTeam);

    const dim = this.state.root === 'dead' ? 0.6 : this.state.root === 'scoreboard' ? 0.25 : 1;

    // Compass heading and minimap centre come from the CAMERA, not from
    // `PlayerState`. They agree during play; under a posed shot camera the
    // camera is what the viewer is looking through, and a compass that
    // disagreed with the frame would be worse than no compass at all.
    TMP_EULER.setFromQuaternion(ctx.camera.rotation as THREE.Quaternion, 'YXZ');
    const viewYaw = TMP_EULER.y;
    this.viewYaw = viewYaw;
    const eye = ctx.camera.position as THREE.Vector3;
    // Points on a kill cluster come from GAME's own score, one tick behind the
    // killfeed event that raised it.
    this.state.syncScore(match.localScore.score);

    const self = this;
    const hud: HudContext = {
      batch: this.renderer.batch,
      pen: this.pen,
      layout: this.layout,
      state: this.state,
      services: this.services,
      camera: ctx.camera,
      match,
      player,
      weapon,
      weaponDef,
      secondary,
      secondaryAmmo: [secondary.magazine, secondary.reserve],
      squad,
      points,
      gadgets: loadout.gadgets,
      throwables: loadout.throwables,
      rail: loadout.rail,
      viewYaw,
      viewX: eye.x,
      viewZ: eye.z,
      time: this.state.time,
      dt: ctx.dt,
      dim,
      localTeam,
      localName: this.localName(),
      // Resolved from `localTeam` at draw time, never hardcoded by enum value.
      friendly: localTeam === Team.Coalition ? COLOUR.friendly : COLOUR.enemy,
      enemy: localTeam === Team.Coalition ? COLOUR.enemy : COLOUR.friendly,
      project(world, out) {
        return projectWorld(self.services.camera.state, world, self.layout.width, self.layout.height, out);
      },
    };
    void this.screen;
    return hud;
  }

  /**
   * Four rows, local player ALWAYS last. Rows never reorder, so the squad is
   * picked by ascending entity id and then the local player is appended —
   * iterating `controlled` is documented as deterministic.
   */
  private buildSquad(localTeam: Team): SquadRow[] {
    const player = this.services.player;
    const rows: SquadRow[] = [];
    const mates: number[] = [];
    for (const entity of player.controlled) {
      if (entity === player.localEntity) continue;
      const s = player.stateOf(entity);
      if (!s || s.team !== localTeam) continue;
      mates.push(entity as unknown as number);
      if (mates.length >= 3) break;
    }
    mates.sort((a, b) => a - b);
    for (let i = 0; i < mates.length; i++) {
      const entity = mates[i] as unknown as Parameters<typeof player.stateOf>[0];
      const s = player.stateOf(entity);
      if (!s) continue;
      rows.push({
        entity: mates[i],
        name: this.services.mode.nameOf(entity),
        // Stable per entity, so a squadmate never changes class mid-round.
        klass: CLASSES[mates[i] % CLASSES.length],
        slot: i + 1,
        health: s.health,
        alive: s.alive,
        downed: s.downed === true,
        isLocal: false,
      });
    }
    const local = player.state;
    rows.push({
      entity: player.localEntity as unknown as number,
      name: this.localName(),
      klass: 'assault',
      slot: rows.length + 1,
      health: local.health,
      alive: local.alive,
      downed: local.downed === true,
      isLocal: true,
    });
    return rows;
  }
}

function kill(
  killer: string,
  victim: string,
  killerTeam: Team,
  victimTeam: Team,
  weapon: Parameters<typeof weaponClassOf>[0],
  headshot: boolean,
): Parameters<HudService['pushKillFeed']>[0] {
  return { killer, victim, killerTeam, victimTeam, weapon, headshot };
}

/* ------------------------------------------------------- lane exports ----- */

let instance: HudImpl | null = null;
let pendingSeed: number | null = null;

export function createHudService(ctx: BootContext): HudService {
  const hud = new HudImpl(ctx);
  instance = hud;

  // Registered from `afterBoot`, never from the factory body: `graph` may not be
  // constructed yet when this runs, and the null graph accepts passes silently —
  // `addPass` returns normally, the pass never runs, and the shot is black.
  ctx.afterBoot((services) => {
    hud.attach();
    services.graph.addPass(new HudPass(services, hud.renderer, (frame, w, h) => hud.build(frame, w, h)));
    if (pendingSeed !== null) {
      hud.arm(pendingSeed);
      pendingSeed = null;
    }
  });

  // A no-op render system at `Presentation`, kept so the HUD owns a declared
  // slot in the frame graph even though its work happens inside the pass — the
  // profiler and the frame-graph inspector both key off registered systems.
  ctx.addRender({
    name: 'hud.layout',
    stage: RenderStage.Presentation,
    order: 100,
    update: () => {
      /* Layout runs inside the pass, where the NATIVE resolution is known. */
    },
  });

  return hud;
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 *
 * The HUD declares NOTHING. The SDF font atlas it uses is `BakeAssets.font`,
 * declared and baked by BAKE (`src/bake/font.ts`, step 14) and reached through
 * `ctx.assets` — which is precisely why the `hud` descriptor carries
 * `dependsOn: ['assets']`. The minimap plate cannot be a bake step: it needs
 * `LevelService.collectColliders()`, and no service exists at this point.
 */
export function registerHudBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  /* No HUD-owned bake steps. See the note above. */
}

/**
 * Harness reset chain, at the top of EVERY capture. Drops all transient state —
 * a killfeed left over from the previous shot is the single most obvious
 * order-dependence in a review sheet — and then arms the shot scenario keyed to
 * the seed, which is the only channel a shot file has into this lane.
 */
export function resetHud(seed: number): void {
  if (!instance) {
    pendingSeed = seed;
    return;
  }
  instance.state.reset();
  instance.setVisible(true);
  instance.arm(seed);
}
