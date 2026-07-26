/**
 * World-space marks: objective markers, the capture progress bar, friendly
 * nameplates, off-screen squadmate indicators and deployed-gadget pins.
 * OWNER: HUD. `docs/HUD_SPEC.md` §6.18, §6.19, §6.28, §6.30, §6.31, §10.3.
 *
 * These sit at z = 20, UNDER the screen-space clusters, and are occluded by
 * them (§3). That is deliberate: a nameplate drawing over the ammo counter
 * looks broken, and the fix is layer order rather than per-marker exclusion
 * rectangles.
 *
 * DE-EMPHASIS IS ALWAYS A DROP TO 0.25 ALPHA, NEVER A REMOVAL. A marker that
 * vanishes at range makes the player think the objective moved.
 */
import { CaptureState, LAYER_SOLID, Team } from '@/engine/types';
import { ALPHA, clamp01, COLOUR, pulse, TYPE, WEIGHT, type Rgb } from '../theme';
import { makeScreenPoint, type HudContext, type ScreenPoint } from '../context';
import { classGlyph, directionFin, ownerShape, slotBadge, type OwnerShape } from '../glyphs';
import * as THREE from 'three';

const P = makeScreenPoint();
const TMP = new THREE.Vector3();

function shapeFor(state: CaptureState): OwnerShape {
  if (state === CaptureState.OwnedCoalition) return 'circle';
  if (state === CaptureState.OwnedInsurgent) return 'diamond';
  return 'roundsquare';
}

/** `58 m` / `1,150 m` — comma over 999, slashed zeros, normal space before the unit. */
function distanceLabel(metres: number): string {
  const m = Math.round(metres);
  return `${m > 999 ? m.toLocaleString('en-US') : String(m)} m`;
}

export function drawObjectiveMarkers(ctx: HudContext): void {
  const { batch, pen, layout, dim, match, state } = ctx;
  const u = layout.u;
  const letters = ['A', 'B', 'C'];
  const eye = ctx.camera.position as THREE.Vector3;

  // The squad order: the nearest objective this team does not already own.
  let orderIndex = -1;
  let orderDist = Infinity;
  for (let i = 0; i < ctx.points.length && i < 3; i++) {
    if (match.points[i]?.state === CaptureState.OwnedCoalition) continue;
    const d = eye.distanceTo(ctx.points[i].centre as THREE.Vector3);
    if (d < orderDist) {
      orderDist = d;
      orderIndex = i;
    }
  }

  for (let i = 0; i < ctx.points.length && i < 3; i++) {
    const def = ctx.points[i];
    const rt = match.points[i];
    const capture = rt ? rt.state : CaptureState.Neutral;
    const contested = rt ? rt.contested : false;
    // The marker floats above the point's own volume, not on the ground.
    TMP.copy(def.centre as THREE.Vector3).setY((def.centre as THREE.Vector3).y + def.height * 0.5 + 2.4);
    ctx.project(TMP, P);

    const friendlyOwned = capture === CaptureState.OwnedCoalition || capture === CaptureState.CapturingInsurgent;
    const enemyOwned = capture === CaptureState.OwnedInsurgent || capture === CaptureState.CapturingCoalition;
    let hue: Rgb = friendlyOwned ? ctx.friendly : enemyOwned ? COLOUR.enemyWorld : COLOUR.neutralObj;
    const shape = shapeFor(capture);
    if (contested) hue = COLOUR.contestPip;

    // §6.18 occlusion: geometry between camera and point multiplies alpha ×0.55.
    let alpha = dim;
    const vis = ctx.services.physics.ready ? ctx.services.physics.visibility(eye, TMP, LAYER_SOLID) : 1;
    if (vis < 0.5) alpha *= 0.55;

    // §10.3 LOD chain — and de-emphasis is alpha, never removal.
    const dist = P.distance;
    const lod = dist > 400 ? 2 : dist > 120 ? 1 : 0;
    const clamped = clampToScreen(ctx, P);
    if (clamped) alpha *= 0.85;
    if (lod === 2 && i !== orderIndex) alpha *= ALPHA.deEmphasis / dim;

    const size = lod === 0 ? 4.5 * u : lod === 1 ? 1.85 * u : 0.93 * u;

    if (lod === 2) {
      batch.circle(P.x, P.y, size * 0.5, hue, alpha);
    } else {
      ownerShape(batch, shape, P.x, P.y, size, hue, alpha, {
        stroke: lod === 0 ? 0.28 * u : 0.19 * u,
        fill: COLOUR.black,
        fillAlpha: ALPHA.scrimMarker,
        glow: lod === 0 ? 0.37 * u : 0,
        glowAlpha: 0.45,
      });
      pen.draw(batch, letters[i] ?? '?', P.x, P.y + TYPE.t3.cap * u * (lod === 0 ? 0.5 : 0.34), {
        cap: TYPE.t3.cap * u * (lod === 0 ? 1 : 0.68),
        weight: TYPE.t3.weight,
        tracking: 0,
        colour: hue,
        alpha,
        align: 'center',
        treatment: 'shadow',
      });
    }

    // ORDERED: an extra 2 px white ring. White is otherwise never used for an
    // objective icon, which is what makes the order unmistakable.
    if (i === orderIndex && lod < 2) {
      batch.circle(P.x, P.y, size * 0.62, COLOUR.white, 0.9 * alpha, 2);
    }

    if (lod === 0) {
      const capturing = capture === CaptureState.CapturingCoalition || capture === CaptureState.CapturingInsurgent;
      // The verb says what to DO. `CONTESTED` is the capture bar's status line
      // (§6.19), not the marker's verb — a contested point still reads CAPTURE,
      // in the contest amber that `hue` already carries.
      const verb = capturing ? 'NEUTRALIZING' : friendlyOwned ? 'DEFEND' : 'CAPTURE';
      // The verb inherits the marker's hue — EXCEPT `NEUTRALIZING`, which is
      // always white because it describes what YOU are doing rather than who
      // owns the point.
      const verbColour = verb === 'NEUTRALIZING' ? COLOUR.white : hue;
      pen.draw(batch, verb, P.x, P.y - 2.6 * u - size * 0.5, {
        cap: TYPE.t0.cap * u,
        weight: WEIGHT.bold,
        tracking: 0.11,
        colour: verbColour,
        alpha,
        align: 'center',
        treatment: verb === 'NEUTRALIZING' ? 'shadow' : 'glow',
        glowAlpha: 0.3,
      });
    }

    if (lod <= 1) {
      pen.draw(batch, distanceLabel(dist), P.x, P.y + 2.6 * u + size * 0.5, {
        cap: TYPE.t0.cap * u,
        weight: TYPE.t0.weight,
        tracking: TYPE.t0.tracking,
        colour: hue,
        alpha,
        align: 'center',
        treatment: 'shadow',
      });
    }

    if (contested && lod === 0) {
      // Four solid triangles at the 45° diagonals, apexes pointing INWARD,
      // pulsing between 0.93u and 1.4u outside the icon's bounding box.
      const off = size * 0.5 + (0.93 + 0.47 * pulse(state.time, 0.9)) * u;
      for (let k = 0; k < 4; k++) {
        const a = Math.PI * 0.25 + (k * Math.PI) / 2;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const px = -uy;
        const py = ux;
        const tipX = P.x + ux * (off - 1.0 * u);
        const tipY = P.y + uy * (off - 1.0 * u);
        batch.poly(
          [
            [tipX, tipY],
            [P.x + ux * off + px * 0.6 * u, P.y + uy * off + py * 0.6 * u],
            [P.x + ux * off - px * 0.6 * u, P.y + uy * off - py * 0.6 * u],
          ],
          COLOUR.contestPip,
          alpha,
        );
      }
    }

    if (clamped) {
      // The icon is RETAINED and a solid chevron is welded to its leading vertex
      // pointing at the true bearing. It is never replaced by a bare arrow.
      const ang = Math.atan2(P.y - layout.y(50), P.x - layout.cx);
      directionFin(batch, P.x + Math.cos(ang) * (size * 0.5 + 0.9 * u), P.y + Math.sin(ang) * (size * 0.5 + 0.9 * u), 1.2 * u, 1.6 * u, ang, hue, alpha);
    }

    // §6.19 world capture bar, under the marker.
    if (lod === 0 && rt && (rt.progress !== 0 || contested || ctx.state.root === 'capturing')) {
      drawCaptureBar(ctx, P.x, P.y + size * 0.5 + 4.2 * u, rt.progress, rt.occupants, contested, alpha);
    }
  }
}

/**
 * Clamp a marker into the safe frame. Returns true if it had to move, which is
 * what arms the welded chevron.
 *
 * A point BEHIND the camera has a mirrored projection that can land anywhere,
 * including plausibly inside the frame — so it is pushed out to the border along
 * its true bearing first, and only then clamped. Without that, a marker for an
 * objective behind you floats in the middle of the screen with an arrow on it.
 */
function clampToScreen(ctx: HudContext, p: ScreenPoint): boolean {
  const m = 3.7 * ctx.layout.u;
  const top = m + 12 * ctx.layout.u;
  // Clear of the bottom clusters. §3 puts world markers UNDER the screen-space
  // HUD, so a marker clamped into the minimap or the weapon card is legal and
  // ugly; keeping the clamp band above them is cheaper than clipping.
  const bottom = ctx.layout.height - m - 30 * ctx.layout.u;
  const ox = p.x;
  const oy = p.y;
  if (!p.ahead) {
    const dx = p.x - ctx.layout.cx;
    const dy = p.y - ctx.layout.y(50);
    const len = Math.hypot(dx, dy) || 1;
    const reach = ctx.layout.width;
    p.x = ctx.layout.cx + (dx / len) * reach;
    p.y = ctx.layout.y(50) + (dy / len) * reach;
  }
  p.x = Math.max(m, Math.min(ctx.layout.width - m, p.x));
  p.y = Math.max(top, Math.min(bottom, p.y));
  return p.x !== ox || p.y !== oy;
}

function drawCaptureBar(
  ctx: HudContext,
  cx: number,
  cy: number,
  progress: number,
  occupants: Readonly<Record<Team, number>>,
  contested: boolean,
  alpha: number,
): void {
  const { batch, pen, layout } = ctx;
  const u = layout.u;
  const w = 8.5 * u;
  const h = 0.55 * u;
  const fill = clamp01(Math.abs(progress));
  const hue = progress > 0 ? ctx.friendly : ctx.enemy;
  // NO VISIBLE TRACK — the unfilled portion is fully transparent, and the bar
  // tracks the model with no smoothing because the rate IS the information.
  batch.rect(cx - w * 0.5, cy - h * 0.5, w * fill, h, hue, alpha);
  batch.glow(cx - w * 0.5 + w * fill * 0.5, cy, w * fill * 0.5 + 0.6 * u, h * 2.2, hue, 0.3 * alpha, 1.8);

  const capStyle = { cap: TYPE.t0.cap * u, weight: TYPE.t0.weight, tracking: TYPE.t0.tracking, alpha, treatment: 'shadow' as const };
  pen.draw(batch, String(occupants[Team.Coalition] ?? 0), cx - w * 0.5 - 0.93 * u, cy + TYPE.t0.cap * u * 0.5, {
    ...capStyle,
    colour: ctx.friendly,
    align: 'right',
  });
  pen.draw(batch, String(occupants[Team.Insurgent] ?? 0), cx + w * 0.5 + 0.93 * u, cy + TYPE.t0.cap * u * 0.5, {
    ...capStyle,
    colour: ctx.enemy,
    align: 'left',
  });
  pen.draw(batch, contested ? 'CONTESTED' : progress > 0 ? 'CAPTURING' : 'LOSING', cx, cy + 1.9 * u + TYPE.t0.cap * u, {
    ...capStyle,
    colour: COLOUR.white,
    tracking: 0.1,
    align: 'center',
  });
}

/* ------------------------------------------------------------ nameplates -- */

export function drawNameplates(ctx: HudContext): void {
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  const player = ctx.services.player;
  const squadEntities = new Set(ctx.squad.map((r) => r.entity));
  const eye = ctx.camera.position as THREE.Vector3;

  for (const entity of player.controlled) {
    if (entity === player.localEntity) continue;
    const s = player.stateOf(entity);
    if (!s || !s.alive) continue;
    // ENEMIES GET NO NAMEPLATE. Only a transient spot pin (§6.29).
    if (s.team !== ctx.localTeam) continue;
    const inSquad = squadEntities.has(entity as unknown as number);
    TMP.copy(s.position as THREE.Vector3).setY((s.position as THREE.Vector3).y + s.eyeHeight + 0.55);
    ctx.project(TMP, P);

    if (!P.onScreen) {
      if (inSquad) drawOffscreenSquadmate(ctx, P, entity as unknown as number);
      continue;
    }

    const fade = clamp01(1 - (P.distance - 90) / 60);
    if (fade <= 0.01) continue;
    const colour = inSquad ? COLOUR.squad : ctx.friendly;
    const name = ctx.services.mode.nameOf(entity);
    const cap = TYPE.t2.cap * u;
    const nameW = pen.measure(name, { cap, weight: TYPE.t2.weight, tracking: TYPE.t2.tracking, colour, alpha: 1 });
    const badgeW = inSquad ? 1.7 * u + 0.5 * u : 0;
    const left = P.x - (nameW + badgeW) * 0.5;

    // A faint GREEN-TINTED scrim behind the name, not a neutral dark one.
    if (inSquad) {
      batch.rect(left + badgeW - 0.28 * u, P.y - cap - 0.28 * u, nameW + 0.56 * u, cap + 0.56 * u, [0.314, 0.706, 0.157], 0.22 * fade * dim);
      const row = ctx.squad.find((r) => r.entity === (entity as unknown as number));
      slotBadge(batch, pen, left + 0.85 * u, P.y - cap * 0.5, 1.7 * u, 1.55 * u, String(row?.slot ?? 2), colour, fade * dim, TYPE.t0.cap * u);
    }
    pen.draw(batch, name, left + badgeW, P.y, {
      cap,
      weight: TYPE.t2.weight,
      tracking: TYPE.t2.tracking,
      colour,
      alpha: fade * dim,
      align: 'left',
      treatment: 'glow',
      glowAlpha: 0.3,
    });
    // Health bar drawn ONLY when health < 100 %.
    if (s.health < 99.5) {
      batch.rect(left + badgeW, P.y + 0.5 * u, nameW * clamp01(s.health / 100), 0.28 * u, colour, fade * dim);
    }
    // The class glyph is larger than the badge and sits BELOW the name, at the
    // soldier's actual world position.
    if (inSquad) {
      const row = ctx.squad.find((r) => r.entity === (entity as unknown as number));
      classGlyph(batch, row?.klass ?? 'assault', P.x, P.y + 2.6 * u, 2.4 * u, 0.24 * u, colour, fade * dim);
    }
  }
}

function drawOffscreenSquadmate(ctx: HudContext, p: ScreenPoint, entity: number): void {
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  const m = 3.0 * u;
  // §6.30 floats at the screen EDGE where the teammate leaves view. Push out
  // along the bearing first — a behind-camera projection lands anywhere, and an
  // "off-screen" indicator sitting in the middle of the frame is a bug the
  // player reads as a floating icon.
  let px = p.x;
  let py = p.y;
  const dx = px - layout.cx;
  const dy = py - layout.y(50);
  const len = Math.hypot(dx, dy) || 1;
  const reach = layout.width;
  px = layout.cx + (dx / len) * reach;
  py = layout.y(50) + (dy / len) * reach;
  const x = Math.max(m, Math.min(layout.width - m, px));
  const y = Math.max(m + 14 * u, Math.min(layout.height - m - 10 * u, py));
  const ang = Math.atan2(y - layout.y(50), x - layout.cx);
  const row = ctx.squad.find((r) => r.entity === entity);
  batch.glow(x, y, 2.4 * u, 2.4 * u, COLOUR.squad, 0.4 * dim, 2.0);
  batch.circle(x, y, 1.2 * u, COLOUR.squad, dim);
  pen.draw(batch, String(row?.slot ?? 2), x, y + TYPE.t1.cap * u * 0.5, {
    cap: TYPE.t1.cap * u,
    weight: WEIGHT.bold,
    tracking: 0,
    colour: COLOUR.ink,
    alpha: dim,
    align: 'center',
    treatment: 'none',
  });
  directionFin(batch, x + Math.cos(ang) * 2.0 * u, y + Math.sin(ang) * 2.0 * u, 1.5 * u, 2.0 * u, ang, COLOUR.squad, dim);
  pen.draw(batch, distanceLabel(p.distance), x, y + 1.3 * u + TYPE.t1.cap * u * 1.6, {
    cap: TYPE.t1.cap * u,
    weight: TYPE.t1.weight,
    tracking: TYPE.t1.tracking,
    colour: COLOUR.squad,
    alpha: dim,
    align: 'center',
    treatment: 'shadow',
  });
}

/* ------------------------------------------------------- gadget markers --- */

/**
 * §6.31 — a pure `--gadget` green hard-edged silhouette at the gadget's world
 * position. Green, NOT team-coloured; no scrim, no outline, no leader line, no
 * text.
 *
 * No lane publishes deployed gadgets on the contract today, so this list is
 * empty during play and is populated only by the HUD shot scenarios. Called out
 * in the lane report rather than faked into normal gameplay.
 */
export function drawGadgetMarkers(ctx: HudContext): void {
  const { batch, dim } = ctx;
  const u = ctx.layout.u;
  for (const g of ctx.state.gadgetMarkers) {
    ctx.project(g.world, P);
    if (!P.onScreen) continue;
    const s = 2.6 * u;
    // Ammo crate / med pouch / sensor, as three distinct hard-edged silhouettes.
    if (g.kind === 'ammo') {
      batch.rect(P.x - s * 0.5, P.y - s * 0.35, s, s * 0.7, COLOUR.gadget, dim);
      batch.rect(P.x - s * 0.5, P.y - s * 0.05, s, s * 0.1, COLOUR.black, 0.5 * dim);
    } else if (g.kind === 'med') {
      batch.rect(P.x - s * 0.4, P.y - s * 0.12, s * 0.8, s * 0.24, COLOUR.gadget, dim);
      batch.rect(P.x - s * 0.12, P.y - s * 0.4, s * 0.24, s * 0.8, COLOUR.gadget, dim);
    } else {
      batch.poly(
        [
          [P.x, P.y - s * 0.5],
          [P.x + s * 0.42, P.y + s * 0.3],
          [P.x - s * 0.42, P.y + s * 0.3],
        ],
        COLOUR.gadget,
        dim,
      );
    }
  }
}
