/**
 * Killfeed. OWNER: HUD. `docs/HUD_SPEC.md` §6.6 and §10.4.
 *
 * NO BACKGROUND SCRIM WHATSOEVER — §0.5. The rows survive on a 1 px dark drop
 * shadow and a coloured outer glow, which is what lets five of them sit over a
 * blown-out sky without turning the top-right quadrant into a panel. Ragged
 * left edge, flush right edge.
 */
import { Team } from '@/engine/types';
import { COLOUR, TYPE, type Rgb } from '../theme';
import type { HudContext } from '../context';
import { skull, weaponSilhouette } from '../glyphs';
import { weaponClassOf } from '../state';

/** §6.6 name tiers. Three, plus a fourth white recolour when you are involved. */
function nameColour(ctx: HudContext, team: Team, inSquad: boolean): Rgb {
  if (team === ctx.localTeam) return inSquad ? COLOUR.squad : ctx.friendly;
  return ctx.enemy;
}

export function drawKillfeed(ctx: HudContext): void {
  const { batch, pen, layout, state, dim } = ctx;
  const u = layout.u;
  const rule = layout.right(0);
  const pitch = 2.75 * u;
  const cap = TYPE.t2.cap * u;
  const squadNames = new Set(ctx.squad.map((r) => r.name));

  for (const row of state.killfeed) {
    const alpha = state.killRowAlpha(row) * dim;
    if (alpha <= 0.01) continue;
    const slot = state.killRowSlot(row);
    const baseline = layout.y(5.6) + slot * pitch;
    // Rows slide in from +2.5u in X — a small, lateral entrance. Nothing in the
    // HUD animates position by more than 3u (§8.3).
    const slide = state.killRowSlideUnits(row) * u;

    const e = row.entry;
    const local = e.killer === ctx.localName || e.victim === ctx.localName;
    const killerColour = local ? COLOUR.white : nameColour(ctx, e.killerTeam, squadNames.has(e.killer));
    const victimColour = local ? COLOUR.white : nameColour(ctx, e.victimTeam, squadNames.has(e.victim));
    const style = { cap, weight: TYPE.t2.weight, tracking: TYPE.t2.tracking, colour: COLOUR.white, alpha: 1 };

    const suicide = e.killer === e.victim;
    const victimW = pen.measure(e.victim, style);
    const killerW = suicide ? 0 : pen.measure(e.killer, style);
    const glyphW = e.weapon && !suicide ? 2.4 * u : 0;
    const gap = 0.46 * u;
    const skullW = e.headshot ? 1.2 * u + gap : 0;
    const markerW = local ? 0.74 * u + gap : 0;

    let x = rule + slide;
    // Laid out right-to-left from the flush right rule.
    pen.draw(batch, e.victim, x, baseline, {
      ...style,
      colour: victimColour,
      alpha,
      align: 'right',
      treatment: local ? 'shadow' : 'glow',
      glowAlpha: 0.3,
    });
    x -= victimW;

    if (e.headshot) {
      x -= gap;
      skull(batch, x - 0.6 * u, baseline - cap * 0.45, 1.2 * u, victimColour, alpha);
      x -= 1.2 * u;
    }

    if (glyphW > 0 && e.weapon) {
      x -= gap;
      weaponSilhouette(batch, weaponClassOf(e.weapon), x - glyphW, baseline - 1.5 * u * 0.78, glyphW, 1.5 * u, killerColour, alpha * 0.55, COLOUR.black, 0);
      x -= glyphW + gap;
    }

    if (!suicide) {
      pen.draw(batch, e.killer, x, baseline, {
        ...style,
        colour: killerColour,
        alpha,
        align: 'right',
        treatment: local ? 'shadow' : 'glow',
        glowAlpha: 0.3,
      });
      x -= killerW;
    }

    if (local) {
      // Solid white right-pointing triangle leading the row.
      x -= gap;
      batch.poly(
        [
          [x - 0.74 * u, baseline - 0.83 * u],
          [x, baseline - 0.415 * u],
          [x - 0.74 * u, baseline],
        ],
        COLOUR.white,
        alpha,
      );
      x -= markerW;
    }
  }
}
