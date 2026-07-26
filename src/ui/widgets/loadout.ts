/**
 * Bottom-right cluster and the right-edge rail: weapon card, stowed row, gadget
 * tiles, throwable row, ability rail. OWNER: HUD.
 * `docs/HUD_SPEC.md` §6.9–6.13, §6.16, §10.7, §10.8.
 *
 * THE THREE DETAILS THAT CARRY THIS CLUSTER
 *   - The weapon card is framed by two square BRACKETS, not a rectangle: its top
 *     and bottom edges are open and the brackets stand proud outside the scrim,
 *     at full alpha in `--white-key`, which makes them the brightest and
 *     hardest-edged marks in the frame despite being 2 px wide.
 *   - The magazine count is zero-padded to the MAGAZINE CAPACITY's digit width
 *     with the pad digits in `--dim` — `Ø94`, not `94` and not a uniformly white
 *     `094`. That one detail is what makes the counter read as an instrument.
 *   - The reserve is set at 0.40× the magazine cap height and TOP-ALIGNED to the
 *     magazine's cap line. It is not a subscript and not baseline-aligned.
 */
import { ALPHA, clamp01, COLOUR, pulse, TYPE, WEIGHT, type Rgb } from '../theme';
import type { GadgetSlot, HudContext, RailSlot } from '../context';
import { gadgetIcon, infinityGlyph, keybindChip, weaponSilhouette } from '../glyphs';
import { weaponClassOf } from '../state';

export interface CardGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function weaponCardGeometry(ctx: HudContext): CardGeometry {
  const u = ctx.layout.u;
  const right = ctx.layout.right(0);
  return { left: right - 20.4 * u, right, top: ctx.layout.y(87.7), bottom: ctx.layout.y(93.6) };
}

/* --------------------------------------------------------- weapon card ---- */

export function drawWeaponCard(ctx: HudContext): void {
  const { batch, pen, layout, dim, weapon, weaponDef, state } = ctx;
  const u = layout.u;
  const g = weaponCardGeometry(ctx);
  const h = g.bottom - g.top;

  const reloading = weapon?.reloading ?? false;
  // §8.2 — the scrim flashes ×1.5 for 120 ms when a reload starts.
  const reloadProgress = reloadFraction(ctx);
  const flash = reloading && reloadProgress < 0.12 ? 1.5 : 1;
  batch.rect(g.left, g.top, g.right - g.left, h, COLOUR.black, ALPHA.scrim * flash * dim);

  // The brackets. A literal `[` and `]`: a full-height vertical stroke with
  // 1.0u horizontal returns at top and bottom only.
  const stroke = 0.19 * u;
  const arm = 1.0 * u;
  const bracket = (x: number, dir: number): void => {
    batch.rect(x - stroke * 0.5, g.top, stroke, h, COLOUR.whiteKey, dim);
    batch.rect(dir > 0 ? x : x - arm, g.top, arm, stroke, COLOUR.whiteKey, dim);
    batch.rect(dir > 0 ? x : x - arm, g.bottom - stroke, arm, stroke, COLOUR.whiteKey, dim);
  };
  bracket(g.left - stroke, 1);
  bracket(g.right + stroke, -1);

  const cls = weaponDef ? weaponDef.class : 'ar';
  weaponSilhouette(batch, cls, g.left + 1.3 * u, g.top + (h - 2.4 * u) * 0.5, 9.7 * u, 2.4 * u, COLOUR.art, dim, COLOUR.black, ALPHA.scrim * dim);

  /* ---- magazine + reserve ------------------------------------------------ */
  const magSize = weaponDef ? weaponDef.magazine : 30;
  const ammo = weapon ? weapon.ammo : magSize;
  const reserve = weapon ? weapon.reserve : 0;
  const pad = String(magSize).length;
  const text = String(Math.max(0, ammo)).padStart(pad, '0');
  const significant = String(Math.max(0, ammo)).length;

  let magColour: Rgb = COLOUR.white;
  let magAlpha = dim;
  if (reloading) {
    magColour = COLOUR.dim;
  } else if (ammo === 0) {
    // §10.8 EMPTY: 700 ms alert ↔ warn pulse.
    const p = pulse(state.time, 0.7);
    magColour = [
      COLOUR.alert[0] + (COLOUR.warn[0] - COLOUR.alert[0]) * p,
      COLOUR.alert[1] + (COLOUR.warn[1] - COLOUR.alert[1]) * p,
      COLOUR.alert[2] + (COLOUR.warn[2] - COLOUR.alert[2]) * p,
    ];
  } else if (ammo <= 0.25 * magSize) {
    // §10.8 LOW: 900 ms warn ↔ white pulse.
    const p = pulse(state.time, 0.9);
    magColour = [
      COLOUR.warn[0] + (COLOUR.white[0] - COLOUR.warn[0]) * p,
      COLOUR.warn[1] + (COLOUR.white[1] - COLOUR.warn[1]) * p,
      COLOUR.warn[2] + (COLOUR.white[2] - COLOUR.warn[2]) * p,
    ];
  }

  const magCap = TYPE.t5.cap * u;
  const superCap = magCap * 0.4;
  const reserveText = `/${reserve}`;
  const baseline = g.top + h * 0.5 + magCap * 0.5;
  const magStyle = {
    cap: magCap,
    weight: TYPE.t5.weight,
    tracking: 0,
    colour: magColour,
    alpha: magAlpha,
    xScale: 0.88,
    align: 'left' as const,
    treatment: 'shadow' as const,
  };
  const reserveStyle = {
    cap: superCap,
    weight: WEIGHT.bold,
    tracking: 0,
    colour: COLOUR.white,
    alpha: 0.8 * dim,
    align: 'left' as const,
    treatment: 'shadow' as const,
  };
  const magW = pen.measure(text, magStyle);
  const resW = pen.measure(reserveText, reserveStyle);
  const rightInner = g.right - 1.0 * u;
  const magX = rightInner - resW - 0.3 * u - magW;

  pen.drawSegments(
    batch,
    [
      { text: text.slice(0, pad - significant), colour: COLOUR.dim },
      { text: text.slice(pad - significant) },
    ],
    magX,
    baseline,
    magStyle,
  );
  // TOP-aligned to the magazine's cap line: baselineSuper = baselineMag + capMag × 0.60.
  pen.draw(batch, reserveText, magX + magW + 0.3 * u, baseline - magCap * 0.6, reserveStyle);

  /* ---- reload sweep ------------------------------------------------------ */
  if (reloading) {
    batch.rect(g.left, g.bottom - 0.19 * u, (g.right - g.left) * reloadProgress, 0.19 * u, COLOUR.whiteKey, 0.9 * dim);
  }
}

/** 0..1 through the current reload, linear — the rate IS the information. */
function reloadFraction(ctx: HudContext): number {
  const w = ctx.weapon;
  const def = ctx.weaponDef;
  if (!w || !w.reloading || !def) return 0;
  const tickDt = 1 / 60;
  const total = w.ammo > 0 ? def.reloadTactical : def.reloadEmpty;
  const remaining = Math.max(0, (w.reloadEndTick - ctx.services.clock.tick) * tickDt);
  return clamp01(1 - remaining / Math.max(0.01, total));
}

/* ---------------------------------------------------------- stowed row ---- */

export function drawStowedRow(ctx: HudContext): void {
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  const g = weaponCardGeometry(ctx);
  const top = layout.y(94.0);
  const h = 2.8 * u;
  const left = g.left + 2.6 * u;
  batch.rect(left, top, g.right - left, h, COLOUR.black, ALPHA.scrimDeep * dim);

  const def = ctx.secondary;
  weaponSilhouette(
    batch,
    def ? def.class : 'pistol',
    left + 0.7 * u,
    top + (h - 1.5 * u) * 0.5,
    5.4 * u,
    1.5 * u,
    COLOUR.art,
    0.85 * dim,
    COLOUR.black,
    0,
  );

  // Deliberately unlike the primary's big/superscript split: one uniform size on
  // one baseline, with a thin space either side of the slash.
  pen.draw(batch, `${ctx.secondaryAmmo[0]} / ${ctx.secondaryAmmo[1]}`, g.right - 1.0 * u, top + h * 0.5 + TYPE.t2.cap * u * 0.5, {
    cap: TYPE.t2.cap * u,
    weight: TYPE.t2.weight,
    tracking: TYPE.t2.tracking,
    colour: COLOUR.white,
    alpha: 0.9 * dim,
    align: 'right',
    treatment: 'shadow',
  });

  keybindChip(batch, pen, '2', left - 0.65 * u - 0.925 * u, top + h * 0.5, u, ALPHA.chip * dim);
}

/* --------------------------------------------------------- gadget tiles --- */

export function drawGadgetTiles(ctx: HudContext): void {
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  const g = weaponCardGeometry(ctx);
  const tileW = 6.1 * u;
  const tileH = 5.8 * u;
  const gap = 0.19 * u;
  const top = layout.y(87.7);
  let right = g.left - 1.9 * u;

  for (let i = ctx.gadgets.length - 1; i >= 0; i--) {
    const slot = ctx.gadgets[i];
    const x = right - tileW;
    drawTile(ctx, x, top, tileW, tileH, slot);
    keybindChip(batch, pen, slot.key, x + tileW * 0.5, top + tileH + 0.37 * u + 0.925 * u, u, (slot.count === 0 ? 0.45 : ALPHA.chip) * dim);
    right = x - gap;
  }
}

function drawTile(ctx: HudContext, x: number, y: number, w: number, h: number, slot: GadgetSlot): void {
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  batch.rect(x, y, w, h, COLOUR.black, ALPHA.scrim * dim);
  const iconAlpha = slot.cooldown > 0 ? 0.45 * dim : dim;
  gadgetIcon(batch, slot.icon, x + w * 0.5, y + h * 0.5, w * 0.5, 0.19 * u, COLOUR.art, iconAlpha);

  if (slot.infinite) {
    infinityGlyph(batch, x + w - 0.46 * u - 0.6 * u, y + 0.46 * u + TYPE.t1.cap * u * 0.5, TYPE.t1.cap * u, COLOUR.white, dim);
  } else {
    pen.draw(batch, String(slot.count), x + w - 0.46 * u, y + 0.46 * u + TYPE.t1.cap * u, {
      cap: TYPE.t1.cap * u,
      weight: TYPE.t1.weight,
      tracking: 0,
      colour: COLOUR.white,
      alpha: dim,
      align: 'right',
      treatment: 'shadow',
    });
  }

  // The disabled state is a 45° HATCH, not a grey-out and not a hidden tile.
  if (slot.cooldown > 0) {
    batch.hatch(x, y, w, h, COLOUR.white, ALPHA.hatch * dim, 0.83 * u, 0.19 * u);
  }

  // Selection is four L-shaped corner brackets INSIDE the tile corners. Not a
  // fill, not a border, not a glow.
  if (slot.selected) cornerBrackets(ctx, x, y, w, h, 0.25, 0.19 * u, 0.7 * dim);
}

export function cornerBrackets(ctx: HudContext, x: number, y: number, w: number, h: number, armFrac: number, stroke: number, alpha: number): void {
  const { batch } = ctx;
  const ax = w * armFrac;
  const ay = h * armFrac;
  const c: Rgb = COLOUR.white;
  batch.rect(x, y, ax, stroke, c, alpha);
  batch.rect(x, y, stroke, ay, c, alpha);
  batch.rect(x + w - ax, y, ax, stroke, c, alpha);
  batch.rect(x + w - stroke, y, stroke, ay, c, alpha);
  batch.rect(x, y + h - stroke, ax, stroke, c, alpha);
  batch.rect(x, y + h - ay, stroke, ay, c, alpha);
  batch.rect(x + w - ax, y + h - stroke, ax, stroke, c, alpha);
  batch.rect(x + w - stroke, y + h - ay, stroke, ay, c, alpha);
}

/* ------------------------------------------------------- throwable row ---- */

export function drawThrowableRow(ctx: HudContext): void {
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  const g = weaponCardGeometry(ctx);
  const cy = layout.y(85.3) + 0.925 * u;
  const items = ctx.throwables;
  if (items.length === 0) return;

  // Items are left- and right-aligned to the CARD's edges rather than clustered:
  // the card's width is the row's measure (§6.12).
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const alpha = (item.count === 0 ? 0.45 : 1) * dim;
    const t = items.length === 1 ? 0 : i / (items.length - 1);
    const x = g.left + t * (g.right - g.left - 5.2 * u);
    const chipW = keybindChip(batch, pen, item.key, x + 0.925 * u, cy, u, (item.count === 0 ? 0.45 : ALPHA.chip) * dim);
    gadgetIcon(batch, item.icon, x + chipW + 0.5 * u + 0.85 * u, cy, 1.7 * u, 0.19 * u, COLOUR.art, alpha);
    pen.draw(batch, String(item.count), x + chipW + 0.5 * u + 1.9 * u, cy + TYPE.t1.cap * u * 0.5, {
      cap: TYPE.t1.cap * u,
      weight: TYPE.t1.weight,
      tracking: TYPE.t1.tracking,
      colour: COLOUR.white,
      alpha,
      align: 'left',
      treatment: 'shadow',
    });
  }
}

/* --------------------------------------------------------- ability rail --- */

export function drawAbilityRail(ctx: HudContext): void {
  const { batch, layout, dim } = ctx;
  const u = layout.u;
  const tile = 4.4 * u;
  const rail = ctx.rail;
  if (rail.length === 0) return;
  const right = layout.width - layout.marginRail;
  const totalH = tile * rail.length;
  const top = layout.y(69) - totalH * 0.5;

  for (let i = 0; i < rail.length; i++) {
    const slot: RailSlot = rail[i];
    const y = top + i * tile;
    if (slot.passive) {
      // A passive trait renders as a BARE ICON with no tile at all (§6.13).
      gadgetIcon(batch, slot.icon, right - tile * 0.5, y + tile * 0.5, 3.1 * u, 0.19 * u, COLOUR.white, 0.8 * dim);
      continue;
    }
    batch.rect(right - tile, y, tile, tile, COLOUR.black, ALPHA.scrim * dim);
    // A 1 px darker rule between butted tiles.
    if (i > 0) batch.rect(right - tile, y, tile, 1, COLOUR.black, 0.5 * dim);
    gadgetIcon(batch, slot.icon, right - tile * 0.5, y + tile * 0.5, 3.1 * u, 0.19 * u, COLOUR.white, (slot.cooldown > 0 ? 0.45 : 1) * dim);
    if (slot.cooldown > 0) batch.hatch(right - tile, y, tile, tile, COLOUR.white, ALPHA.hatch * dim, 0.83 * u, 0.19 * u);
    // A tile can be hatched AND bracketed at once (§6.13).
    if (slot.selected) cornerBrackets(ctx, right - tile - 0.37 * u, y - 0.37 * u, tile + 0.74 * u, tile + 0.74 * u, 0.25, 0.19 * u, 0.7 * dim);
    if (slot.charge > 0 && slot.charge < 1) {
      batch.rect(right - tile, y + tile - 0.37 * u, tile * slot.charge, 0.37 * u, COLOUR.gadget, 0.9 * dim);
      batch.rect(right - tile + tile * slot.charge - 0.37 * u, y + tile - 0.55 * u, 0.37 * u, 0.55 * u, COLOUR.gadget, dim);
    }
  }

  // Segment meter: one segment per tile, filling bottom-to-top, its right edge
  // landing exactly on the global right rule — which is WHY the rail's tiles are
  // inset further than everything else in the HUD.
  const meterX = layout.right(0) - 0.55 * u;
  const filled = rail.filter((r) => r.cooldown <= 0 && !r.passive).length;
  for (let i = 0; i < rail.length; i++) {
    const y = top + i * tile;
    const ready = rail.length - i <= filled;
    batch.rect(meterX, y + 0.19 * u, 0.55 * u, tile - 0.38 * u, COLOUR.white, (ready ? 0.85 : 0.22) * dim);
  }
}
