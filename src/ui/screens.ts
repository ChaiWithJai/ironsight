/**
 * Full-screen states: the deploy map and the scoreboard. OWNER: HUD.
 * `docs/HUD_SPEC.md` §10.11, plus §7's blueprint chrome — which only ever
 * appears here, in the outer 10 % margin, and never over live gameplay.
 *
 * Both screens keep the live frame visible behind them. The scoreboard is
 * explicitly UNBLURRED (§10.11) over alternating 6 %/2 % white row bands, and
 * the deploy map is the minimap plate scaled to fill rather than a second
 * authored asset — one map render, two scales.
 */
import { CaptureState, Team } from '@/engine/types';
import { ALPHA, COLOUR, TYPE, WEIGHT, type Rgb } from './theme';
import type { HudContext } from './context';
import { blueprintBracket, blueprintColumn, blueprintCross, blueprintRuler, keybindChip, ownerShape, type OwnerShape } from './glyphs';
import { PLATE_SPAN, worldToPlateU, worldToPlateV } from './minimap-plate';

function shapeFor(state: CaptureState): OwnerShape {
  if (state === CaptureState.OwnedCoalition) return 'circle';
  if (state === CaptureState.OwnedInsurgent) return 'diamond';
  return 'roundsquare';
}

function chrome(ctx: HudContext): void {
  const { batch, layout } = ctx;
  const u = layout.u;
  const c: Rgb = COLOUR.white;
  // Three or four marks, 1 px, 25–45 % opacity. Not a border.
  blueprintRuler(batch, layout.left(0), layout.y(8), 14 * u, u, c, 0.32);
  blueprintRuler(batch, layout.right(0), layout.y(8), 14 * u, u, c, 0.32, true);
  blueprintBracket(batch, layout.left(1.5), layout.y(38), layout.height * 0.17, u, c, 0.28);
  blueprintColumn(batch, layout.right(1.8), layout.y(40), 7, u, c, 0.25);
  blueprintCross(batch, layout.left(4.5), layout.y(93), u, c, 0.35);
  // One long thin diagonal hairline crossing the frame.
  batch.strokePath(
    [
      [layout.width * 0.06, layout.height * 0.98],
      [layout.width * 0.42, layout.height * 0.02],
    ],
    1,
    c,
    0.1,
  );
}

/* ---------------------------------------------------------- deploy map ---- */

export function drawDeployScreen(ctx: HudContext): void {
  const { batch, pen, layout } = ctx;
  const u = layout.u;

  // Dark enough that the map plate and the type carry the frame, light enough
  // that the live world still reads through at the edges — the deploy screen is
  // a layer over the game, not a menu page, and the difference is visible.
  batch.rect(0, 0, layout.width, layout.height, [0.02, 0.03, 0.04], 0.74);
  chrome(ctx);

  const size = Math.min(layout.height * 0.68, layout.width * 0.5);
  const mx = layout.cx - size * 0.5;
  const my = layout.y(50) - size * 0.5 + 2 * u;

  // The minimap surface scaled to fill: same plate, a wider world window.
  const windowM = 420;
  const halfWin = windowM * 0.5 / PLATE_SPAN;
  const cu = worldToPlateU(-40);
  const cv = worldToPlateV(20);
  batch.plate(mx, my, size, size, cu - halfWin, cv - halfWin, cu + halfWin, cv + halfWin, COLOUR.white, 0.92);
  batch.rect(mx, my, size, 1, COLOUR.white, 0.35);

  const toX = (worldX: number): number => mx + ((worldX + 40) / windowM + 0.5) * size;
  const toY = (worldZ: number): number => my + ((worldZ - 20) / windowM + 0.5) * size;

  for (let i = 0; i < ctx.points.length && i < 3; i++) {
    const def = ctx.points[i];
    const rt = ctx.match.points[i];
    const state = rt ? rt.state : CaptureState.Neutral;
    const colour = state === CaptureState.OwnedCoalition ? ctx.friendly : state === CaptureState.OwnedInsurgent ? ctx.enemy : COLOUR.neutralObj;
    const c = def.centre as { x: number; z: number };
    const x = toX(c.x);
    const y = toY(c.z);
    const r = (def.radius / windowM) * size;
    const pts: [number, number][] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    batch.poly(pts, colour, ALPHA.zoneFill);
    batch.strokePath(pts, 2, colour, 0.85, true);
    ownerShape(batch, shapeFor(state), x, y, 5.6 * u, colour, 1, {
      stroke: 0.28 * u,
      fill: COLOUR.black,
      fillAlpha: ALPHA.scrimMarker,
      glow: 0.5 * u,
      glowAlpha: 0.45,
    });
    pen.draw(batch, ['A', 'B', 'C'][i] ?? '?', x, y + TYPE.t3.cap * u * 0.5, {
      cap: TYPE.t3.cap * u,
      weight: TYPE.t3.weight,
      tracking: 0,
      colour,
      alpha: 1,
      align: 'center',
      treatment: 'shadow',
    });
    pen.draw(batch, ['ALPHA', 'BRAVO', 'CHARLIE'][i] ?? '', x, y + 5.4 * u, {
      cap: TYPE.t1.cap * u,
      weight: TYPE.t1.weight,
      tracking: 0.08,
      colour,
      alpha: 0.9,
      align: 'center',
      treatment: 'glow',
      glowAlpha: 0.3,
    });
  }

  // Spawn choices as pips.
  for (const sp of ctx.services.level.spawnPoints) {
    if (sp.team !== ctx.localTeam) continue;
    const p = sp.position as { x: number; z: number };
    const x = toX(p.x);
    const y = toY(p.z);
    if (x < mx || x > mx + size || y < my || y > my + size) continue;
    batch.circle(x, y, 0.55 * u, ctx.friendly, 0.9);
    batch.circle(x, y, 0.95 * u, ctx.friendly, 0.55, 1);
  }

  /* ---- identity block, top-left ----------------------------------------- */
  const bx = layout.left(0);
  pen.draw(batch, 'CONQUEST', bx, layout.y(13), {
    cap: TYPE.t1.cap * u,
    weight: TYPE.t1.weight,
    tracking: 0.11,
    colour: ctx.friendly,
    alpha: 0.95,
    align: 'left',
    treatment: 'glow',
    glowAlpha: 0.35,
  });
  pen.draw(batch, 'HARBOUR REACH', bx, layout.y(17.5), {
    cap: TYPE.t5.cap * u * 0.72,
    weight: WEIGHT.display,
    tracking: 0.02,
    colour: COLOUR.white,
    alpha: 1,
    xScale: 0.88,
    align: 'left',
    treatment: 'shadow',
  });
  batch.rect(bx, layout.y(19.4), 18 * u, 0.19 * u, COLOUR.white, 0.5);
  pen.draw(batch, 'SELECT A DEPLOYMENT POINT', bx, layout.y(22.4), {
    cap: TYPE.t2.cap * u,
    weight: TYPE.t2.weight,
    tracking: 0.05,
    colour: COLOUR.white,
    alpha: 0.7,
    align: 'left',
    treatment: 'shadow',
  });

  /* ---- DEPLOY button, bottom-right --------------------------------------- */
  const bw = 22 * u;
  const bh = 4.6 * u;
  const bxx = layout.right(0) - bw;
  const byy = layout.bottom(4.6);
  batch.rect(bxx, byy, bw, bh, ctx.friendly, 0.12);
  batch.rect(bxx, byy, bw, 0.19 * u, ctx.friendly, 1);
  batch.rect(bxx, byy + bh - 0.19 * u, bw, 0.19 * u, ctx.friendly, 1);
  batch.rect(bxx, byy, 0.19 * u, bh, ctx.friendly, 1);
  batch.rect(bxx + bw - 0.19 * u, byy, 0.19 * u, bh, ctx.friendly, 1);
  pen.draw(batch, 'DEPLOY', bxx + bw * 0.5 + 1.2 * u, byy + bh * 0.5 + TYPE.t3.cap * u * 0.5, {
    cap: TYPE.t3.cap * u,
    weight: TYPE.t3.weight,
    tracking: 0.12,
    colour: COLOUR.white,
    alpha: 1,
    align: 'center',
    treatment: 'shadow',
  });
  keybindChip(batch, pen, 'E', bxx + 2.4 * u, byy + bh * 0.5, u, ALPHA.chip);
}

/* ----------------------------------------------------------- scoreboard --- */

interface ScoreRow {
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  local: boolean;
}

export function drawScoreboard(ctx: HudContext): void {
  const { batch, pen, layout, match } = ctx;
  const u = layout.u;

  chrome(ctx);

  // Built from the CONTROLLED set rather than from `MatchState.scores`, which
  // only carries entities that have already scored — a scoreboard listing three
  // of twenty-five players reads as a bug. Scores are looked up per entity and
  // default to zero, which is what a player who has done nothing yet has.
  const rows: ScoreRow[] = [];
  const seen = new Set<number>();
  for (const entity of ctx.services.player.controlled) {
    seen.add(entity as unknown as number);
    const score = match.scores.get(entity);
    rows.push({
      name: ctx.services.mode.nameOf(entity),
      team: ctx.services.mode.teamOf(entity),
      kills: score?.kills ?? 0,
      deaths: score?.deaths ?? 0,
      assists: score?.assists ?? 0,
      score: score?.score ?? 0,
      local: entity === ctx.services.player.localEntity,
    });
  }
  for (const [entity, score] of match.scores) {
    if (seen.has(entity as unknown as number)) continue;
    rows.push({
      name: ctx.services.mode.nameOf(entity),
      team: ctx.services.mode.teamOf(entity),
      kills: score.kills,
      deaths: score.deaths,
      assists: score.assists,
      score: score.score,
      local: entity === ctx.services.player.localEntity,
    });
  }
  // Deterministic ordering: score descending, then name, never Map order.
  rows.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const colTeams: Team[] = [Team.Coalition, Team.Insurgent];
  const tableW = Math.min(layout.width * 0.86, 150 * u);
  const colW = (tableW - 4 * u) * 0.5;
  const left0 = layout.cx - tableW * 0.5;
  // Below the ticket bar, the capture row AND the status line, all of which
  // stay live at 0.25 alpha behind the board (§10.11).
  const top = layout.y(26);
  const rowH = 3.2 * u;
  const maxRows = Math.floor((layout.height * 0.62) / rowH);

  pen.draw(batch, 'CONQUEST — HARBOUR REACH', layout.cx, layout.y(19), {
    cap: TYPE.t3.cap * u,
    weight: TYPE.t3.weight,
    tracking: 0.1,
    colour: COLOUR.white,
    alpha: 0.95,
    align: 'center',
    treatment: 'shadow',
  });

  for (let c = 0; c < 2; c++) {
    const team = colTeams[c];
    const hue = team === ctx.localTeam ? ctx.friendly : ctx.enemy;
    const x = left0 + c * (colW + 4 * u);
    const teamRows = rows.filter((r) => r.team === team).slice(0, maxRows);

    pen.draw(batch, team === Team.Coalition ? 'COALITION' : 'INSURGENT', x, top - 1.4 * u, {
      cap: TYPE.t1.cap * u,
      weight: TYPE.t1.weight,
      tracking: 0.1,
      colour: hue,
      alpha: 0.95,
      align: 'left',
      treatment: 'glow',
      glowAlpha: 0.3,
    });
    // ROUNDED. `MatchState.tickets` is a float because bleed is per-second, and
    // a scoreboard reading 190.59999999999968 is the single most damning number
    // that can appear on a HUD.
    pen.draw(batch, String(Math.round(match.tickets[team] ?? 0)), x + colW, top - 1.4 * u, {
      cap: TYPE.t1.cap * u,
      weight: TYPE.t1.weight,
      tracking: 0,
      colour: hue,
      alpha: 0.95,
      align: 'right',
      treatment: 'glow',
      glowAlpha: 0.3,
    });
    batch.rect(x, top - 0.6 * u, colW, 0.14 * u, hue, 0.6);

    const headStyle = {
      cap: TYPE.t0.cap * u,
      weight: WEIGHT.bold,
      tracking: 0.09,
      colour: COLOUR.white,
      alpha: 0.55,
      treatment: 'none' as const,
    };
    const cols = [
      { label: 'SCORE', dx: colW - 22 * u },
      { label: 'K', dx: colW - 15 * u },
      { label: 'D', dx: colW - 10 * u },
      { label: 'A', dx: colW - 5 * u },
    ];
    for (const col of cols) pen.draw(batch, col.label, x + col.dx, top + 1.4 * u, { ...headStyle, align: 'right' });

    for (let i = 0; i < teamRows.length; i++) {
      const r = teamRows[i];
      const y = top + 2.6 * u + i * rowH;
      // Alternating bands over a LIVE, UNBLURRED backdrop.
      batch.rect(x, y, colW, rowH - 0.3 * u, COLOUR.white, i % 2 === 0 ? 0.06 : 0.02);
      if (r.local) {
        batch.rect(x, y, colW, rowH - 0.3 * u, [0.157, 0.431, 0.745], 0.35);
        batch.box(x + colW * 0.5, y + (rowH - 0.3 * u) * 0.5, colW * 0.5, (rowH - 0.3 * u) * 0.5, 0, ctx.friendly, 1, { stroke: 2 });
      }
      const baseline = y + rowH * 0.5 + TYPE.t2.cap * u * 0.4;
      pen.draw(batch, r.name, x + 1.2 * u, baseline, {
        cap: TYPE.t2.cap * u,
        weight: TYPE.t2.weight,
        tracking: TYPE.t2.tracking,
        colour: r.local ? COLOUR.self : hue,
        alpha: 0.95,
        align: 'left',
        treatment: 'shadow',
      });
      const numStyle = {
        cap: TYPE.t2.cap * u,
        weight: WEIGHT.bold,
        tracking: 0,
        colour: COLOUR.white,
        alpha: 0.9,
        align: 'right' as const,
        treatment: 'shadow' as const,
      };
      pen.draw(batch, String(r.score), x + colW - 22 * u, baseline, numStyle);
      pen.draw(batch, String(r.kills), x + colW - 15 * u, baseline, numStyle);
      pen.draw(batch, String(r.deaths), x + colW - 10 * u, baseline, { ...numStyle, colour: COLOUR.dim });
      pen.draw(batch, String(r.assists), x + colW - 5 * u, baseline, { ...numStyle, colour: COLOUR.dim });
    }
    if (teamRows.length === 0) {
      pen.draw(batch, 'NO PLAYERS', x + 1.2 * u, top + 4.4 * u, {
        cap: TYPE.t2.cap * u,
        weight: TYPE.t2.weight,
        tracking: 0.04,
        colour: COLOUR.dim,
        alpha: 0.8,
        align: 'left',
        treatment: 'shadow',
      });
    }
  }

  const remaining = Math.max(0, Math.round(match.timeRemaining));
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  pen.draw(batch, `${mm}:${String(ss).padStart(2, '0')}`, layout.cx, layout.y(21.6), {
    cap: TYPE.t2.cap * u,
    weight: TYPE.t2.weight,
    tracking: 0.04,
    colour: COLOUR.white,
    alpha: 0.75,
    align: 'center',
    treatment: 'shadow',
  });
}
