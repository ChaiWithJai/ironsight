/**
 * The per-frame draw context handed to every widget. OWNER: HUD.
 *
 * Widgets are pure draw code: they read this, they emit into `batch`, and they
 * hold no state of their own. Everything that persists between frames lives in
 * `HudState`; everything that is derived from the game lives here and is
 * rebuilt once per frame by `src/ui/system.ts`.
 */
import * as THREE from 'three';
import type {
  CameraState,
  CapturePointDef,
  MatchState,
  PlayerState,
  Services,
  Team,
  Vec3,
  WeaponDef,
  WeaponState,
} from '@/engine/types';
import type { HudBatch } from './draw';
import type { TextPen } from './text';
import type { Layout } from './layout';
import type { HudState } from './state';
import type { ClassKind, GadgetIcon } from './glyphs';
import type { Rgb } from './theme';

export interface SquadRow {
  readonly entity: number;
  readonly name: string;
  readonly klass: ClassKind;
  readonly slot: number;
  /** 0..100. */
  readonly health: number;
  readonly alive: boolean;
  readonly downed: boolean;
  readonly isLocal: boolean;
}

export interface GadgetSlot {
  readonly icon: GadgetIcon;
  readonly key: string;
  readonly count: number;
  /** Infinite stock draws the `∞` vector glyph rather than a numeral (§6.14). */
  readonly infinite: boolean;
  /** 0 = ready, 1 = fully unavailable. Drives the 45° hatch (§6.11). */
  readonly cooldown: number;
  readonly selected: boolean;
}

export interface RailSlot {
  readonly icon: GadgetIcon;
  readonly cooldown: number;
  readonly selected: boolean;
  /** A passive trait renders as a bare icon with no tile at all (§6.13). */
  readonly passive: boolean;
  /** 0..1 charge, drawn as a bar across the tile's bottom edge. */
  readonly charge: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** True when the point is in front of the camera, regardless of framing. */
  ahead: boolean;
  /** True when the point projects inside the viewport. */
  onScreen: boolean;
  /** Metres from the camera. */
  distance: number;
}

export interface HudContext {
  readonly batch: HudBatch;
  readonly pen: TextPen;
  readonly layout: Layout;
  readonly state: HudState;
  readonly services: Services;
  readonly camera: Readonly<CameraState>;
  readonly match: Readonly<MatchState>;
  readonly player: Readonly<PlayerState>;
  readonly weapon: Readonly<WeaponState> | null;
  readonly weaponDef: Readonly<WeaponDef> | null;
  /**
   * True while the active weapon is still being drawn (`WeaponService.isDeploying`).
   * The weapon card's brackets — the "active weapon" affordance, HUD_SPEC
   * §6.9 — hide during this window: "a transitional state" per the spec, and
   * the only honest way to show a weapon swap actually costing time.
   */
  readonly deploying: boolean;
  /** The REAL stowed weapon — `WeaponService.loadoutOf` slot 1 — not a guess. */
  readonly secondary: Readonly<WeaponDef> | null;
  readonly secondaryAmmo: readonly [number, number];
  /** The digit key ("1".."9") that draws `secondary` — the stowed row's chip. */
  readonly secondaryKey: string;
  readonly squad: readonly SquadRow[];
  readonly points: readonly Readonly<CapturePointDef>[];
  readonly gadgets: readonly GadgetSlot[];
  readonly throwables: readonly GadgetSlot[];
  readonly rail: readonly RailSlot[];
  /**
   * Yaw and eye position taken from the CAMERA rather than from `PlayerState`.
   * They agree during play, and under a posed shot camera the camera is what the
   * viewer is actually looking through — a compass that disagrees with the frame
   * is worse than no compass.
   */
  readonly viewYaw: number;
  readonly viewX: number;
  readonly viewZ: number;
  readonly time: number;
  readonly dt: number;
  /** Global alpha multiplier. `dead` puts the whole HUD at 0.6 (§10.11). */
  readonly dim: number;
  readonly localTeam: Team;
  /** `GameMode.nameOf(localEntity)`. The killfeed's "you were involved" test. */
  readonly localName: string;
  /**
   * Resolved AT DRAW TIME from `MatchState.localTeam`, never hardcoded by enum
   * value — §5.1. The two hues are variables so the colour-blind palette test
   * (`bf6_gp_024`) is a token swap and nothing else.
   */
  readonly friendly: Rgb;
  readonly enemy: Rgb;
  project(world: Vec3, out: ScreenPoint): ScreenPoint;
}

const TMP = new THREE.Vector4();

/**
 * World → device pixels, keeping the sign of `w` so an off-screen marker can be
 * told from a behind-the-camera one. `CameraRig.worldToScreen` collapses both
 * into a single `false`, and §6.18's edge clamping needs them apart: a point
 * behind you clamps to the OPPOSITE edge from where its raw projection lands.
 */
export function projectWorld(camera: Readonly<CameraState>, world: Vec3, width: number, height: number, out: ScreenPoint): ScreenPoint {
  const w = world as THREE.Vector3;
  TMP.set(w.x, w.y, w.z, 1).applyMatrix4(camera.viewProjection as THREE.Matrix4);
  out.distance = (camera.position as THREE.Vector3).distanceTo(w);
  const behind = TMP.w <= 1e-5;
  out.ahead = !behind;
  const iw = behind ? 1 / Math.max(1e-5, -TMP.w) : 1 / TMP.w;
  const ndcX = TMP.x * iw * (behind ? -1 : 1);
  const ndcY = TMP.y * iw * (behind ? -1 : 1);
  out.x = (ndcX * 0.5 + 0.5) * width;
  out.y = (1 - (ndcY * 0.5 + 0.5)) * height;
  out.onScreen = !behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
  return out;
}

export function makeScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, ahead: false, onScreen: false, distance: 0 };
}
