/**
 * The top-centre column: compass, ticket assembly, capture row, notice banner.
 * OWNER: HUD. Specified by `docs/HUD_SPEC.md` §6.1–6.5 and §6.32.
 *
 * Two things in here are the ones a reconstruction gets backwards, and both are
 * called out at the call site:
 *   - the ticket tracks fill from the OUTER screen edges and deplete from the
 *     CENTRE outward, so a losing team shows a dark stub against the gutter;
 *   - the compass LABELS scroll while the dashed rule underneath them does not,
 *     with the static pointer above — the labels are sandwiched between two
 *     stationary marks.
 */
import { CaptureState, Team, type CapturePointRuntime } from '@/engine/types';
import { ALPHA, brighten, clamp01, COLOUR, EASE, pulse, TYPE, WEIGHT, type Rgb } from '../theme';
import type { HudContext } from '../context';
import { ownerShape, type OwnerShape } from '../glyphs';

const DEG = 180 / Math.PI;

/* ------------------------------------------------------------- compass ---- */

const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

function bearingLabel(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  const card = CARDINALS[d];
  if (card) return card;
  return d.toString().padStart(3, '0');
}

export function drawCompass(ctx: HudContext): void {
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  const cx = layout.cx;

  // §6.1 — the read-head. Flush with y = 0 and cropped by the screen edge; it
  // is completely static, and the tape scrolls under it.
  const pw = 1.3 * u * 0.5;
  batch.poly(
    [
      [cx - pw, 0],
      [cx + pw, 0],
      [cx, 0.83 * u],
    ],
    COLOUR.white,
    dim,
  );

  const half = 16.5 * u;
  const perDeg = 0.247 * u;
  // Compass bearings run CLOCKWISE from north; engine yaw runs anticlockwise
  // about +Y with 0 looking down −Z. The bearing is therefore −yaw, and getting
  // the sign wrong puts you on a heading of 062 while walking north-west.
  const heading = (((-ctx.viewYaw * DEG) % 360) + 360) % 360;
  const baseline = layout.y(0) + 2.6 * u + TYPE.t1.cap * u * 0.5;

  // Alpha ramps to zero over the outer 15 % of the tape on each side. The tape
  // DISSOLVES; a hard clip or a fade-mask box reads as a panel (§6.2).
  const ramp = (x: number): number => {
    const t = Math.abs(x - cx) / half;
    return clamp01((1 - t) / 0.15);
  };

  const first = Math.floor((heading - 67) / 15) * 15;
  for (let d = first; d <= heading + 67; d += 15) {
    const delta = d - heading;
    const x = cx + delta * perDeg;
    if (Math.abs(x - cx) > half) continue;
    const fade = ramp(x);
    if (fade <= 0.01) continue;
    if (((d % 30) + 30) % 30 === 0) {
      pen.draw(batch, bearingLabel(d), x, baseline, {
        cap: TYPE.t1.cap * u,
        weight: TYPE.t1.weight,
        tracking: TYPE.t1.tracking,
        colour: COLOUR.white,
        alpha: ALPHA.compassLabel * fade * dim,
        align: 'center',
        treatment: 'shadow',
      });
    } else {
      // Minor tick at the 15° midpoint, vertically centred on the label row.
      batch.rect(x - 0.095 * u, baseline - TYPE.t1.cap * u * 0.5 - 0.465 * u, 0.19 * u, 0.93 * u, COLOUR.white, ALPHA.compassTick * fade * dim);
    }
  }

  // §6.3 — the dashed rule is STATIC. Only the labels above it move.
  const ruleY = layout.y(0) + 3.95 * u;
  const dash = 0.46 * u;
  const gap = 0.37 * u;
  for (let x = cx - half; x < cx + half; x += dash + gap) {
    const fade = ramp(x + dash * 0.5);
    if (fade <= 0.01) continue;
    if (Math.abs(x + dash * 0.5 - cx) < 0.5 * u) continue;
    batch.rect(x, ruleY - 0.095 * u, dash, 0.19 * u, COLOUR.white, ALPHA.compassRule * fade * dim);
  }
  batch.rect(cx - 0.325 * u, ruleY - 0.5, 0.65 * u, 1, COLOUR.white, 0.85 * dim);
  batch.rect(cx - 0.5, ruleY - 0.415 * u, 1, 0.83 * u, COLOUR.white, 0.85 * dim);
}

/* ------------------------------------------------------------- tickets ---- */

export function drawTicketBar(ctx: HudContext): void {
  const { batch, pen, layout, state, match, dim } = ctx;
  const u = layout.u;
  const cx = layout.cx;
  const rowTop = layout.y(5.2);
  const rowH = 2.78 * u;
  const plateW = 7.69 * u;
  const trackW = 16.85 * u;
  const trackH = 1.11 * u;
  const gutter = 1.02 * u;
  const gap = 0.65 * u;
  const trackY = rowTop + (rowH - trackH) * 0.5;

  const friendlyTrackL = cx - gutter * 0.5 - trackW;
  const friendlyTrackR = cx - gutter * 0.5;
  const enemyTrackL = cx + gutter * 0.5;
  const enemyTrackR = cx + gutter * 0.5 + trackW;

  const max = Math.max(1, match.ticketsMax);
  const fFrac = clamp01(state.ticketShown[Team.Coalition] / max);
  const eFrac = clamp01(state.ticketShown[Team.Insurgent] / max);
  const fFill = Math.round(trackW * fFrac);
  const eFill = Math.round(trackW * eFrac);

  const friendly = ctx.friendly;
  const enemy = ctx.enemy;
  const friendlyTrack = COLOUR.friendlyTrack;
  const enemyTrack = COLOUR.enemyTrack;

  // THE PART EVERYONE GETS BACKWARDS (§6.4). The bright fill is anchored at the
  // OUTER end of each track and the dark depleted stub grows outward from the
  // centre gutter. The tracks themselves never change length.
  batch.rect(friendlyTrackL, trackY, fFill, trackH, friendly, dim);
  batch.rect(friendlyTrackL + fFill, trackY, trackW - fFill, trackH, friendlyTrack, ALPHA.track * dim);
  batch.rect(enemyTrackR - eFill, trackY, eFill, trackH, enemy, dim);
  batch.rect(enemyTrackL, trackY, trackW - eFill, trackH, enemyTrack, ALPHA.track * dim);

  // Drain-front glow: a brighter blob on the fill's leading (inner) edge, only
  // while the count has moved in the last 1.5 s.
  if (state.ticketDraining(Team.Coalition)) {
    batch.glow(friendlyTrackL + fFill, trackY + trackH * 0.5, 1.85 * u, trackH * 1.6, brighten(friendly, 0.35), 0.5 * dim, 1.6);
  }
  if (state.ticketDraining(Team.Insurgent)) {
    batch.glow(enemyTrackR - eFill, trackY + trackH * 0.5, 1.85 * u, trackH * 1.6, brighten(enemy, 0.35), 0.5 * dim, 1.6);
  }

  const critical = (team: Team): boolean => state.ticketShown[team] / max <= 0.15;
  const plate = (x: number, team: Team, colour: Rgb, plateColour: Rgb): void => {
    batch.rect(x, rowTop, plateW, rowH, plateColour, ALPHA.plate * dim);
    const flash = state.ticketDigitFlash(team);
    let alpha = dim * (0.85 + 0.15 * flash);
    let ink = colour;
    if (critical(team)) {
      // §10.1 CRITICAL: the losing plate's digits pulse warn ↔ team hue.
      const p = pulse(state.time, 0.9);
      ink = [colour[0] + (COLOUR.warn[0] - colour[0]) * p, colour[1] + (COLOUR.warn[1] - colour[1]) * p, colour[2] + (COLOUR.warn[2] - colour[2]) * p];
      alpha = dim;
    }
    const value = Math.round(state.ticketShown[team]);
    pen.draw(batch, String(value), x + plateW * 0.5, rowTop + rowH * 0.5 + TYPE.t4.cap * u * 0.5, {
      cap: TYPE.t4.cap * u,
      weight: TYPE.t4.weight,
      tracking: 0,
      colour: ink,
      alpha,
      align: 'center',
      treatment: 'shadow',
    });
  };
  plate(friendlyTrackL - gap - plateW, Team.Coalition, friendly, COLOUR.friendlyPlate);
  plate(enemyTrackR + gap, Team.Insurgent, enemy, COLOUR.enemyPlate);
}

/* -------------------------------------------------------- capture row ----- */

function shapeFor(state: CaptureState): OwnerShape {
  switch (state) {
    case CaptureState.OwnedCoalition:
      return 'circle';
    case CaptureState.OwnedInsurgent:
      return 'diamond';
    default:
      return 'roundsquare';
  }
}

export function drawCaptureRow(ctx: HudContext): void {
  const { batch, pen, layout, match, dim, state } = ctx;
  const u = layout.u;
  const s = 3.4 * u;
  const pitch = 4.35 * u;
  const cy = layout.y(10.5);
  const runtimes = match.points;
  const n = Math.min(3, Math.max(runtimes.length, 3));
  const letters = ['A', 'B', 'C'];

  for (let i = 0; i < n; i++) {
    // BRAVO lands exactly on C — with an odd point count the middle chip must
    // sit on screen centre (§6.5).
    const cx = layout.cx + (i - (n - 1) * 0.5) * pitch;
    const rt: CapturePointRuntime | undefined = runtimes[i];
    const cap = rt ? rt.state : CaptureState.Neutral;
    const contested = rt ? rt.contested : false;

    let owner: OwnerShape = shapeFor(cap);
    let colour = COLOUR.neutralObj;
    let stroke = 0.14 * u;
    let fill: Rgb | undefined = COLOUR.black;
    let fillAlpha: number = ALPHA.scrimMarker;
    let letterColour: Rgb = COLOUR.neutralStroke;
    let alpha = dim;
    let glow = 0;

    if (cap === CaptureState.OwnedCoalition || cap === CaptureState.CapturingInsurgent) {
      owner = 'circle';
      colour = ctx.friendly;
      stroke = 0.23 * u;
      letterColour = colour;
      glow = 0.37 * u;
    } else if (cap === CaptureState.OwnedInsurgent || cap === CaptureState.CapturingCoalition) {
      owner = 'diamond';
      colour = ctx.enemy;
      stroke = 0.28 * u;
      fillAlpha = 0.18;
      letterColour = colour;
      glow = 0.37 * u;
    } else if (cap === CaptureState.Neutral) {
      owner = 'roundsquare';
      colour = COLOUR.neutralObj;
      stroke = 0.14 * u;
      // The ONLY chip with a light interior fill.
      fill = COLOUR.white;
      fillAlpha = 0.3;
      letterColour = COLOUR.neutralStroke;
    }

    if (contested || cap === CaptureState.Contested) {
      // §10.2 CONTESTED: owner shape, solid-filled in the owner hue at 0.55,
      // letter knocked out white, alpha pulsing.
      const p = pulse(state.time, 1.1);
      alpha = dim * (0.35 + 0.65 * p);
      fill = colour;
      fillAlpha = 0.55;
      letterColour = COLOUR.white;
    }

    ownerShape(batch, owner, cx, cy, s, colour, alpha, { stroke, fill, fillAlpha, glow, glowAlpha: 0.4 });

    // The capturing overlay is a SECOND concentric glyph in the capturing
    // team's shape and colour — a salmon diamond inside a cyan circle is the
    // contested read, and it survives a colour-blind palette.
    if (cap === CaptureState.CapturingCoalition) {
      const p = pulse(state.time, 1.1);
      ownerShape(batch, 'circle', cx, cy, s * 0.72, ctx.friendly, dim * (0.35 + 0.65 * p), { stroke: 0.2 * u });
    } else if (cap === CaptureState.CapturingInsurgent) {
      const p = pulse(state.time, 1.1);
      ownerShape(batch, 'diamond', cx, cy, s * 0.72, ctx.enemy, dim * (0.35 + 0.65 * p), { stroke: 0.2 * u });
    }

    pen.draw(batch, letters[i] ?? '?', cx, cy + TYPE.t1.cap * u * 0.5, {
      cap: TYPE.t1.cap * u,
      weight: TYPE.t1.weight,
      tracking: 0,
      colour: letterColour,
      alpha,
      align: 'center',
      treatment: 'shadow',
    });
  }

  // §6.5 status line, shown only while the objective count is uneven.
  const held = { [Team.Coalition]: 0, [Team.Insurgent]: 0, [Team.Neutral]: 0 };
  for (const rt of runtimes) {
    if (rt.state === CaptureState.OwnedCoalition) held[Team.Coalition]++;
    else if (rt.state === CaptureState.OwnedInsurgent) held[Team.Insurgent]++;
  }
  const line =
    held[Team.Insurgent] > held[Team.Coalition]
      ? 'THE ENEMY HOLDS MORE OBJECTIVES'
      : held[Team.Coalition] > held[Team.Insurgent]
        ? 'YOU HOLD MORE OBJECTIVES'
        : null;
  if (line) {
    // DEVIATION: §6.5 puts this at y = 12.6. The chips are centred at y = 10.5
    // and are 3.40u across, so their lower edge is at 12.2 and a 1.05u cap set
    // on a 12.6 baseline collides with them. Moved to 13.9, which is the same
    // 1.7u gap below the chips that 12.6 would have given below a smaller row.
    pen.draw(batch, line, layout.cx, layout.y(13.9), {
      cap: TYPE.t1.cap * u,
      weight: TYPE.t1.weight,
      tracking: 0.07,
      colour: COLOUR.white,
      alpha: 0.8 * dim,
      align: 'center',
      treatment: 'shadow',
    });
  }
}

/* -------------------------------------------------------- notice banner --- */

export function drawNotices(ctx: HudContext): void {
  const { batch, pen, layout, state, dim } = ctx;
  const u = layout.u;
  let y = layout.y(20.5);
  for (const n of state.notices) {
    const a = state.noticeAlpha(n) * dim;
    if (a <= 0.01) continue;
    const rise = (1 - EASE.out(clamp01((state.time - n.born) / 0.18))) * 1.1 * u;
    const colour =
      n.kind === 'capture' ? ctx.friendly : n.kind === 'lost' ? ctx.enemy : n.kind === 'objective' ? COLOUR.scoreObj : COLOUR.white;
    const cap = TYPE.t3.cap * u;
    const width = pen.measure(n.text, { cap, weight: WEIGHT.bold, tracking: 0.08, colour, alpha: 1 });
    pen.draw(batch, n.text, layout.cx, y + rise, {
      cap,
      weight: WEIGHT.bold,
      tracking: 0.08,
      colour,
      alpha: a,
      align: 'center',
      treatment: n.kind === 'system' ? 'shadow' : 'glow',
      glowAlpha: 0.35,
    });
    // A 0.14u rule 1.1u beneath, extending 2.8u past the text on each side.
    batch.rect(layout.cx - width * 0.5 - 2.8 * u, y + rise + 1.1 * u, width + 5.6 * u, 0.14 * u, colour, a * 0.8);
    y += 3.4 * u;
  }
}
