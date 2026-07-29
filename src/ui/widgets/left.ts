/**
 * Bottom-left cluster: the minimap and the squad list. OWNER: HUD.
 * `docs/HUD_SPEC.md` §6.7 and §6.8.
 *
 * TWO INVARIANTS THAT DECIDE WHETHER THIS READS AS A GAME OR AS A MOD MENU:
 *
 *   1. The minimap has NO frame — no border, no corner radius, no bezel, no
 *      drop shadow, no glow, no compass ring. It is a bare hard-edged square of
 *      translucent map render that simply ends. §0.3 names adding a bezel as the
 *      single fastest way to get this wrong.
 *   2. The squad list sits to the RIGHT of the minimap, never below it, and the
 *      local player is always the bottom row in `--self` with a bar exactly
 *      twice as wide as everyone else's. That bar is the game's ONLY health
 *      readout (§1.2); a corner health bar would give us away on its own.
 */
import { CaptureState } from '@/engine/types';
import { ALPHA, clamp01, COLOUR, TYPE, WEIGHT, type Rgb } from '../theme';
import type { HudContext } from '../context';
import { classGlyph, keybindChip, ownerShape, slotBadge, type OwnerShape } from '../glyphs';
import { PLATE_SPAN, worldToPlateU, worldToPlateV } from '../minimap-plate';

/** Metres shown across the square. Fixed zoom; the map pans (§6.7). */
const WINDOW_M = 180;

export interface MinimapFrame {
  x: number;
  y: number;
  size: number;
  /** World metres per device pixel. */
  scale: number;
  centreX: number;
  centreZ: number;
}

export function minimapFrame(ctx: HudContext): MinimapFrame {
  const u = ctx.layout.u;
  const size = 23.6 * u;
  const x = ctx.layout.left(-0.09);
  const y = ctx.layout.height - ctx.layout.marginBottom - size;
  const px = { x: ctx.viewX, z: ctx.viewZ };
  // Pan with the player but keep the window inside the baked plate, so the
  // player sits off-centre near the map edge instead of the plate running out.
  const halfSpan = PLATE_SPAN * 0.5;
  const halfWin = WINDOW_M * 0.5;
  const clampC = (v: number, centre: number): number => Math.max(centre - halfSpan + halfWin, Math.min(centre + halfSpan - halfWin, v));
  return {
    x,
    y,
    size,
    scale: WINDOW_M / size,
    centreX: clampC(px.x, -40),
    centreZ: clampC(px.z, 20),
  };
}

function mapX(f: MinimapFrame, worldX: number): number {
  return f.x + f.size * 0.5 + (worldX - f.centreX) / f.scale;
}
function mapY(f: MinimapFrame, worldZ: number): number {
  return f.y + f.size * 0.5 + (worldZ - f.centreZ) / f.scale;
}

/**
 * Sutherland–Hodgman clip of a convex polygon against the plate rectangle.
 *
 * The zone polygons and the order path are MAP CONTENT and must stop at the
 * plate's hard edge — the only thing allowed to hang outside it is a clamped
 * objective marker (§6.7). Without this, a zone whose centre is off-window
 * draws a stray octagon floating in the bottom-left of the frame, which reads as
 * a rendering bug rather than as a map.
 */
function clipToRect(points: readonly [number, number][], x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const edges: readonly [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  let out = points.slice() as [number, number][];
  for (const [inside, intersect] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
    }
    if (out.length === 0) return out;
  }
  return out;
}

/** Clip a segment to the plate; returns null when it misses entirely. */
function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number, number] | null {
  // Liang–Barsky.
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const tests: readonly [number, number][] = [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}

/** Clamp a marker so its CENTRE lands on the boundary, uncropped (§6.7). */
function clampToPlate(f: MinimapFrame, x: number, y: number): { x: number; y: number; clamped: boolean } {
  const cx = Math.max(f.x, Math.min(f.x + f.size, x));
  const cy = Math.max(f.y, Math.min(f.y + f.size, y));
  return { x: cx, y: cy, clamped: cx !== x || cy !== y };
}

function shapeFor(state: CaptureState): OwnerShape {
  if (state === CaptureState.OwnedCoalition) return 'circle';
  if (state === CaptureState.OwnedInsurgent) return 'diamond';
  return 'roundsquare';
}

export function drawMinimap(ctx: HudContext): void {
  const { batch, pen, layout, dim, match } = ctx;
  const u = layout.u;
  const f = minimapFrame(ctx);

  /* ---- z = 0: the surface. A bare square that simply ends. ---------------- */
  const halfWinU = (WINDOW_M * 0.5) / PLATE_SPAN;
  const u0 = worldToPlateU(f.centreX) - halfWinU;
  const u1 = worldToPlateU(f.centreX) + halfWinU;
  const v0 = worldToPlateV(f.centreZ) - halfWinU;
  const v1 = worldToPlateV(f.centreZ) + halfWinU;
  batch.plate(f.x, f.y, f.size, f.size, u0, v0, u1, v1, COLOUR.white, ALPHA.mapPlate * dim);
  // The one permitted rule: 1 px along the TOP edge only. It reads as a lens
  // edge; a rule on all four sides is a bezel and is a defect.
  batch.rect(f.x, f.y, f.size, 1, COLOUR.white, 0.35 * dim);

  /* ---- capture-zone polygons -------------------------------------------- */
  for (let i = 0; i < ctx.points.length && i < 3; i++) {
    const def = ctx.points[i];
    const rt = match.points[i];
    const state = rt ? rt.state : CaptureState.Neutral;
    const colour = state === CaptureState.OwnedCoalition ? ctx.friendly : state === CaptureState.OwnedInsurgent ? ctx.enemy : COLOUR.neutralObj;
    const c = def.centre as { x: number; z: number };
    const r = def.radius / f.scale;
    if (r < 1) continue;
    // Hard corners, no smoothing — an octagon, not a circle (§6.7).
    const pts: [number, number][] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      pts.push([mapX(f, c.x) + Math.cos(a) * r, mapY(f, c.z) + Math.sin(a) * r]);
    }
    const clipped = clipToRect(pts, f.x, f.y, f.x + f.size, f.y + f.size);
    if (clipped.length < 3) continue;
    batch.poly(clipped, colour, ALPHA.zoneFill * dim);
    // The stroke is drawn from the UNCLIPPED ring, segment by segment through
    // the same clip, so the outline stops at the plate edge instead of gaining a
    // false wall along it.
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      const seg = clipSegment(a[0], a[1], b[0], b[1], f.x, f.y, f.x + f.size, f.y + f.size);
      if (seg) batch.strokePath([[seg[0], seg[1]], [seg[2], seg[3]]], 2, colour, 0.85 * dim);
    }
  }

  /* ---- order path -------------------------------------------------------- */
  // The squad's current order: the nearest objective not already held.
  const order = ctx.points.find((_p, i) => match.points[i]?.state !== CaptureState.OwnedCoalition);
  if (order) {
    const oc = order.centre as { x: number; z: number };
    const seg = clipSegment(mapX(f, ctx.viewX), mapY(f, ctx.viewZ), mapX(f, oc.x), mapY(f, oc.z), f.x, f.y, f.x + f.size, f.y + f.size);
    // Each dash lies ALONG the path direction, so on a diagonal leg they are
    // diagonal slashes rather than axis-aligned ticks (§6.7).
    if (seg) batch.dashedLine(seg[0], seg[1], seg[2], seg[3], 2, 0.55 * u, 0.46 * u, COLOUR.orderPath, 0.85 * dim);
  }

  /* ---- z = 10: contents -------------------------------------------------- */
  for (let i = 0; i < ctx.points.length && i < 3; i++) {
    const def = ctx.points[i];
    const rt = match.points[i];
    const state = rt ? rt.state : CaptureState.Neutral;
    const colour = state === CaptureState.OwnedCoalition ? ctx.friendly : state === CaptureState.OwnedInsurgent ? ctx.enemy : COLOUR.neutralObj;
    const c = def.centre as { x: number; z: number };
    const p = clampToPlate(f, mapX(f, c.x), mapY(f, c.z));
    ownerShape(batch, shapeFor(state), p.x, p.y, 2.4 * u, colour, dim, {
      stroke: 2,
      fill: COLOUR.black,
      fillAlpha: ALPHA.scrimMarker,
    });
    pen.draw(batch, ['A', 'B', 'C'][i] ?? '?', p.x, p.y + TYPE.t0.cap * u * 0.5, {
      cap: TYPE.t0.cap * u,
      weight: WEIGHT.bold,
      tracking: 0,
      colour,
      alpha: dim,
      align: 'center',
      treatment: 'shadow',
    });
  }

  // Teammates and squadmates as facing arrowheads.
  const player = ctx.services.player;
  const squadEntities = new Set(ctx.squad.map((r) => r.entity));
  for (const entity of player.controlled) {
    if (entity === player.localEntity) continue;
    const s = player.stateOf(entity);
    if (!s || !s.alive) continue;
    const inSquad = squadEntities.has(entity as unknown as number);
    if (s.team !== ctx.localTeam) continue;
    const pos = s.position as { x: number; z: number };
    const mx = mapX(f, pos.x);
    const my = mapY(f, pos.z);
    if (mx < f.x || mx > f.x + f.size || my < f.y || my > f.y + f.size) continue;
    arrowhead(ctx, mx, my, s.yaw, (inSquad ? 1.1 : 1.0) * u, inSquad ? COLOUR.squad : ctx.friendly, dim);
  }

  // Enemy contacts appear ONLY when spotted (§6.7). A minimap that shows every
  // enemy is a different game.
  for (const spot of ctx.state.spots) {
    const age = ctx.state.time - spot.born;
    const a = clamp01(1 - (age - 4) / 0.6) * dim;
    if (a <= 0.01) continue;
    const mx = mapX(f, spot.world.x);
    const my = mapY(f, spot.world.z);
    if (mx < f.x || mx > f.x + f.size || my < f.y || my > f.y + f.size) continue;
    ownerShape(batch, 'diamond', mx, my, 0.93 * u, ctx.enemy, a);
  }

  /* ---- player marker + view cone ---------------------------------------- */
  const px = mapX(f, ctx.viewX);
  const py = mapY(f, ctx.viewZ);
  // forward = (−sin yaw, −cos yaw) in world XZ; on a north-up plate +Z is down.
  const heading = Math.atan2(-Math.cos(ctx.viewYaw), -Math.sin(ctx.viewYaw));
  const coneHalf = (50 * Math.PI) / 180 / 2;
  batch.arc(px, py, 0, 6.0 * u, heading - coneHalf, heading + coneHalf, COLOUR.self, 0.13 * dim, { fadeOuter: true, segments: 10 });
  batch.circle(px, py, 1.85 * u * 0.5, COLOUR.self, dim);
  const localSlot = ctx.squad.find((r) => r.isLocal)?.slot ?? 1;
  pen.draw(batch, String(localSlot), px, py + TYPE.t0.cap * u * 0.5, {
    cap: TYPE.t0.cap * u,
    weight: WEIGHT.bold,
    tracking: 0,
    colour: COLOUR.ink,
    alpha: dim,
    align: 'center',
    treatment: 'none',
  });

  /* ---- labels ------------------------------------------------------------ */
  pen.draw(batch, ctx.services.level.name, f.x + f.size * 0.5, f.y + f.size * 0.88, {
    cap: TYPE.t2.cap * u,
    weight: TYPE.t2.weight,
    tracking: TYPE.t2.tracking,
    colour: COLOUR.white,
    alpha: 0.85 * dim,
    align: 'center',
    treatment: 'shadow',
  });
  keybindChip(batch, pen, 'M', f.x + 0.55 * u + 0.925 * u, f.y + f.size - 0.55 * u - 0.925 * u, u, ALPHA.chip * dim);
}

function arrowhead(ctx: HudContext, x: number, y: number, yaw: number, size: number, colour: Rgb, alpha: number): void {
  const a = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const local: [number, number][] = [
    [size * 0.6, 0],
    [-size * 0.45, size * 0.42],
    [-size * 0.2, 0],
    [-size * 0.45, -size * 0.42],
  ];
  ctx.batch.poly(
    local.map(([lx, ly]): [number, number] => [x + lx * cos - ly * sin, y + lx * sin + ly * cos]),
    colour,
    alpha,
  );
}

/* ------------------------------------------------------------ squad list -- */

export function drawSquadList(ctx: HudContext): void {
  const { batch, pen, layout, state, dim } = ctx;
  const u = layout.u;
  const f = minimapFrame(ctx);
  const left = f.x + f.size + 1.8 * u;
  const pitch = 5.46 * u;
  const rows = ctx.squad;
  const bottom = f.y + f.size;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Bottom-aligned to the minimap's bottom edge, growing upward; the local
    // player is always the bottom row regardless of slot number.
    const baseline = bottom - (rows.length - 1 - i) * pitch - 1.6 * u;
    const dead = !row.alive;
    const colour: Rgb = row.isLocal ? COLOUR.self : dead || row.downed ? COLOUR.squadDead : COLOUR.squad;
    const alpha = dim * (dead ? 0.8 : 1);

    const glyphCx = left + 1.2 * u;
    classGlyph(batch, dead ? 'dead' : row.klass, glyphCx, baseline - 0.7 * u, 2.4 * u, 0.28 * u, colour, alpha);

    const badgeCx = glyphCx + 1.2 * u + 1.5 * u;
    slotBadge(batch, pen, badgeCx, baseline - 0.7 * u, 2.2 * u, 2.0 * u, String(row.slot), colour, alpha, TYPE.t1.cap * u);

    const dividerX = badgeCx + 1.1 * u + 0.6 * u;
    batch.rect(dividerX, baseline - 1.45 * u, 0.19 * u, 1.5 * u, colour, alpha);

    pen.draw(batch, row.name, dividerX + 0.19 * u + 0.37 * u, baseline, {
      cap: TYPE.t2.cap * u,
      weight: TYPE.t2.weight,
      tracking: TYPE.t2.tracking,
      colour,
      alpha,
      align: 'left',
      treatment: 'glow',
      glowAlpha: 0.3,
    });

    // The health bar sits on a SECOND LINE below the whole row, never inline,
    // and its empty track is fully transparent — only the filled part is drawn.
    const shown = state.syncHealth(row.entity, row.alive ? row.health : 0, ctx.dt);
    const full = row.isLocal ? 16.5 * u : 8.2 * u;
    const barY = baseline + 1.0 * u;
    const barX = left + 1.2 * u - 1.2 * u - 0.19 * u;
    if (row.downed) {
      batch.box(barX + full * 0.5, barY + 0.21 * u, full * 0.5, 0.21 * u, 0, colour, alpha * 0.6, { stroke: 1 });
    } else if (row.alive) {
      batch.rect(barX, barY, full * clamp01(shown / 100), 0.42 * u, colour, alpha);
    }
  }
}
