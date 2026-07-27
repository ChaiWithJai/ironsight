/**
 * Centre-field and transient feedback: crosshair, hitmarkers, damage numbers,
 * damage-direction arcs, bleedout ring, blood, the spotted diamond, the
 * interaction prompt, the kill cluster, score popups and the XP toast.
 * OWNER: HUD. `docs/HUD_SPEC.md` §6.15, §6.17, §6.20–6.27, §10.5, §10.6, §10.9.
 *
 * THE CENTRE FIELD IS OTHERWISE EMPTY. §11 reserves the middle ~44 % of width
 * by ~55 % of height for the crosshair and world-projected marks only; no panel
 * HUD may enter it, which is why everything in this file is either dead-centre,
 * world-anchored, or pinned to the lower-left kill stack.
 */
import { ALPHA, clamp01, COLOUR, EASE, pulse, TYPE, WEIGHT, type Rgb } from '../theme';
import { makeScreenPoint, type HudContext } from '../context';
import { awardRibbon, keybindChip, mapPin, skull } from '../glyphs';

/* ----------------------------------------------------------- crosshair ---- */

export function drawCrosshair(ctx: HudContext): void {
  const { batch, layout, state, dim } = ctx;
  const u = layout.u;
  const cx = layout.cx;
  const cy = layout.y(50);
  const ads = ctx.weapon ? ctx.weapon.adsSim : 0;
  const downed = ctx.player.downed === true;

  // Hidden entirely at ADS and when downed (§6.15).
  if (ads > 0.5 || downed) return;

  const alpha = 0.95 * dim;
  // The centre diamond NEVER moves and is always drawn — a free-fall or
  // no-weapon state retracts the ticks and leaves only this.
  const d = 0.42 * u;
  batch.box(cx, cy, d * 0.5 + 1, d * 0.5 + 1, 0, COLOUR.black, 0.72 * dim, { rotation: Math.PI * 0.25 });
  batch.box(cx, cy, d * 0.5, d * 0.5, 0, COLOUR.whiteKey, alpha, { rotation: Math.PI * 0.25 });

  if (!ctx.weapon) return;
  const gap = Math.min(6.5, 1.67 + state.spreadShown * 1.15) * u;
  const len = 1.11 * u;
  const thick = 0.28 * u;

  // Four ticks, each ORIENTED ALONG ITS RADIUS: top and bottom are vertical
  // bars, left and right are horizontal bars. They translate radially and never
  // rotate, never change length and never change thickness.
  const bar = (x: number, y: number, w: number, h: number): void => {
    // The 1 px dark fringe is what keeps the reticle readable against a blown
    // sky — the one place the crosshair is allowed any darkness at all (§6.15).
    batch.rect(x - 1, y - 1, w + 2, h + 2, COLOUR.black, 0.72 * dim);
    batch.rect(x, y, w, h, COLOUR.whiteKey, alpha);
  };
  bar(cx - thick * 0.5, cy - gap - len, thick, len);
  bar(cx - thick * 0.5, cy + gap, thick, len);
  bar(cx - gap - len, cy - thick * 0.5, len, thick);
  bar(cx + gap, cy - thick * 0.5, len, thick);
}

/** §10.9b — an enemy has held line of sight on you for more than 0.6 s. */
export function drawSpotted(ctx: HudContext): void {
  if (!ctx.state.spotted) return;
  const { batch, layout, state, dim } = ctx;
  const u = layout.u;
  const a = (0.2 + 0.25 * pulse(state.time, 1.2)) * dim;
  // Sits OUTSIDE the crosshair's gap radius so it never obscures the aim point.
  batch.box(layout.cx, layout.y(50), 3.7 * u * 0.5, 3.7 * u * 0.5, 0, ctx.enemy, a, { rotation: Math.PI * 0.25, stroke: 1 });
}

/* ---------------------------------------------------------- hit marker ---- */

const HIT_SCREEN = makeScreenPoint();

export function drawHitmarker(ctx: HudContext): void {
  const { batch, layout, state, dim } = ctx;
  const marker = state.hitmarker;
  const phase = state.hitmarkerPhase();
  if (!marker || !phase) return;
  const u = layout.u;

  // WORLD-ANCHORED ON THE VICTIM, not at the crosshair (§6.23). If the victim
  // despawns mid-animation the marker holds its last projected position.
  let x = layout.cx;
  let y = layout.y(50);
  if (marker.hasWorld) {
    ctx.project(marker.world, HIT_SCREEN);
    if (HIT_SCREEN.ahead) {
      marker.screenX = HIT_SCREEN.x;
      marker.screenY = HIT_SCREEN.y;
      marker.screenValid = true;
    }
    if (marker.screenValid) {
      x = marker.screenX;
      y = marker.screenY;
    }
  }

  const spec = {
    body: { colour: COLOUR.fxHit, scale: 1.0, alpha: 1, glow: 0 },
    head: { colour: COLOUR.fxHit, scale: 1.15, alpha: 1, glow: 0 },
    armour: { colour: COLOUR.white, scale: 0.9, alpha: 0.65, glow: 0 },
    kill: { colour: COLOUR.fxKill, scale: 1.25, alpha: 1, glow: 0.55 * u },
  }[marker.kind];

  const scale = spec.scale * phase.scale;
  const alpha = spec.alpha * phase.alpha * dim;
  const tri = 1.1 * u * scale;
  const offset = 1.05 * u * scale;

  if (spec.glow > 0) batch.glow(x, y, 3.2 * u * scale, 3.2 * u * scale, spec.colour, 0.5 * alpha, 2.2);

  // Four small filled triangles at the four DIAGONAL positions, each apex
  // pointing OUTWARD.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI * 0.25 + (i * Math.PI) / 2;
    const ox = Math.cos(a) * offset;
    const oy = Math.sin(a) * offset;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const px = -uy;
    const py = ux;
    batch.poly(
      [
        [x + ox + ux * tri * 0.7, y + oy + uy * tri * 0.7],
        [x + ox - ux * tri * 0.25 + px * tri * 0.42, y + oy - uy * tri * 0.25 + py * tri * 0.42],
        [x + ox - ux * tri * 0.25 - px * tri * 0.42, y + oy - uy * tri * 0.25 - py * tri * 0.42],
      ],
      spec.colour,
      alpha,
    );
    if (marker.kind === 'head') {
      // A short ring segment on each triangle's outer edge.
      batch.arc(x, y, offset + tri * 0.72, offset + tri * 0.72 + 0.19 * u, a - 0.28, a + 0.28, spec.colour, alpha);
    }
  }
}

/* -------------------------------------------------------- damage number --- */

const DMG_SCREEN = makeScreenPoint();

export function drawDamageNumbers(ctx: HudContext): void {
  const { batch, pen, layout, state, dim } = ctx;
  const u = layout.u;
  for (const chip of state.damageChips) {
    const age = state.time - chip.popAt;
    const alpha = clamp01(1 - (age - 0.5) / 0.35) * dim;
    if (alpha <= 0.01) continue;
    ctx.project(chip.world, DMG_SCREEN);
    if (!DMG_SCREEN.ahead) continue;
    // Drifts up 2.0u over 850 ms; a re-pop scales 1.00 → 1.12 → 1.00 in 120 ms.
    const rise = EASE.out(clamp01(age / 0.85)) * 2.0 * u;
    const pop = age < 0.12 ? 1 + 0.12 * Math.sin((age / 0.12) * Math.PI) : 1;
    const x = DMG_SCREEN.x + 2.4 * u;
    const y = DMG_SCREEN.y - 2.0 * u - rise;

    const tileW = 2.8 * u * pop;
    const tileH = 2.6 * u * pop;
    const cap = TYPE.t5.cap * u * 0.62 * pop;
    const value = String(Math.round(chip.total));
    const numW = pen.measure(value, { cap, weight: TYPE.t5.weight, tracking: 0, colour: COLOUR.white, alpha: 1, xScale: 0.88 });
    const stripW = numW + 0.74 * u;

    // Two-part chip, not a bare number: a light translucent tile with a small
    // white multiplication glyph, then a dark strip carrying the value.
    batch.rect(x, y - tileH * 0.5, tileW, tileH, [0.784, 0.804, 0.824], 0.3 * alpha);
    batch.strokePath(
      [
        [x + tileW * 0.5 - 0.37 * u, y - 0.37 * u],
        [x + tileW * 0.5 + 0.37 * u, y + 0.37 * u],
      ],
      1.5,
      COLOUR.white,
      alpha,
    );
    batch.strokePath(
      [
        [x + tileW * 0.5 + 0.37 * u, y - 0.37 * u],
        [x + tileW * 0.5 - 0.37 * u, y + 0.37 * u],
      ],
      1.5,
      COLOUR.white,
      alpha,
    );
    batch.rect(x + tileW, y - tileH * 0.5, 1, tileH, COLOUR.white, 0.5 * alpha);
    batch.rect(x + tileW + 1, y - tileH * 0.5, stripW, tileH, COLOUR.black, ALPHA.scrimDeep * alpha);
    pen.draw(batch, value, x + tileW + 1 + stripW * 0.5, y + cap * 0.5, {
      cap,
      weight: TYPE.t5.weight,
      tracking: 0,
      colour: COLOUR.white,
      alpha,
      align: 'center',
      xScale: 0.88,
      treatment: 'shadow',
    });
  }
}

/* ----------------------------------------------------- damage direction --- */

export function drawDamageDirection(ctx: HudContext): void {
  const { batch, layout, state, dim } = ctx;
  const u = layout.u;
  const cx = layout.cx;
  const cy = layout.y(50);
  const radius = 13.0 * u;
  const half = ((34 * Math.PI) / 180) * 0.5;
  for (let i = 0; i < 8; i++) {
    const a = state.damageSectorAlpha(i) * dim;
    if (a <= 0.01) continue;
    // Screen-space bearing: sector 0 is straight ahead, i.e. up the screen.
    const bearing = (i * Math.PI) / 4 - Math.PI * 0.5;
    // A tapered crescent, thick at its centre and zero at both ends — the same
    // fin language as the off-screen indicator.
    batch.arc(cx, cy, radius - 0.415 * u, radius + 0.415 * u, bearing - half, bearing + half, COLOUR.alert, a, { taper: true, segments: 14 });
    batch.arc(cx, cy, radius - 0.97 * u, radius + 0.97 * u, bearing - half, bearing + half, COLOUR.alert, a * 0.28, {
      taper: true,
      segments: 14,
      additive: 1,
    });
  }
}

/* ------------------------------------------------------- bleedout ring ---- */

export function drawBleedout(ctx: HudContext): void {
  if (ctx.player.downed !== true) return;
  const { batch, pen, layout, dim } = ctx;
  const u = layout.u;
  const cx = layout.cx;
  const cy = layout.y(50);
  const radius = 9.3 * u;
  const stroke = 0.46 * u;
  const remaining = clamp01(ctx.player.bleedout ?? 1);
  const lit = Math.ceil(remaining * 12);
  for (let i = 0; i < 12; i++) {
    if (i >= lit) continue;
    // Twelve dashes extinguishing CLOCKWISE from 12 o'clock.
    const a0 = -Math.PI * 0.5 + (i / 12) * Math.PI * 2 + 0.06;
    const a1 = -Math.PI * 0.5 + ((i + 1) / 12) * Math.PI * 2 - 0.06;
    batch.arc(cx, cy, radius - stroke * 0.5, radius + stroke * 0.5, a0, a1, COLOUR.alert, dim);
    batch.arc(cx, cy, radius - stroke, radius + stroke, a0, a1, COLOUR.alert, 0.3 * dim, { additive: 1 });
  }
  pen.draw(batch, 'DOWN', cx, cy + 2.8 * u, {
    cap: TYPE.t3.cap * u,
    weight: TYPE.t3.weight,
    tracking: TYPE.t3.tracking,
    colour: COLOUR.alert,
    alpha: dim,
    align: 'center',
    treatment: 'glow',
    glowAlpha: 0.4,
  });
}

/* ---------------------------------------------------------------- blood --- */

export function drawBlood(ctx: HudContext): void {
  const { batch, layout, state, dim } = ctx;
  const u = layout.u;
  for (const blob of state.blood) {
    const a = clamp01(1 - (state.time - blob.born) / 4) * blob.strength * 0.5 * dim;
    if (a <= 0.005) continue;
    // Irregular, defocused, no hard edges, no vignette ring, no full-screen
    // tint — they read as being on a lens plane rather than on the HUD plane.
    //
    // ALPHA-BLENDED AND DARK-TINTED, not additive. Additive red over a blown
    // golden-hour sky adds nothing visible — and that is exactly the frame in
    // which taking damage matters most.
    const r = blob.r * u;
    const dark: Rgb = [COLOUR.alert[0] * 0.55, COLOUR.alert[1] * 0.1, COLOUR.alert[2] * 0.08];
    const bx = blob.x * layout.width;
    const by = blob.y * layout.height;
    batch.box(bx, by, r, r * 0.72, r * 0.62, dark, a * 0.6, { rotation: blob.rot });
    batch.box(bx + Math.cos(blob.rot) * r * 0.7, by + Math.sin(blob.rot) * r * 0.7, r * 0.45, r * 0.32, r * 0.3, dark, a * 0.45, { rotation: blob.rot * 1.7 });
    batch.glow(bx, by, r * 2.0, r * 1.6, COLOUR.alert, a * 0.16, 2.4);
  }
}

/* ------------------------------------------------------ interaction ------- */

export function drawPrompt(ctx: HudContext): void {
  const p = ctx.state.prompt;
  if (!p) return;
  const { batch, pen, layout, state, dim } = ctx;
  const u = layout.u;
  const age = state.time - p.since;
  const a = EASE.out(clamp01(age / 0.12)) * dim;
  const rise = (1 - EASE.out(clamp01(age / 0.12))) * 0.55 * u;
  const h = 2.6 * u;
  const cap = TYPE.t1.cap * u;
  const labelW = pen.measure(p.label, { cap, weight: TYPE.t1.weight, tracking: 0.07, colour: COLOUR.white, alpha: 1 });
  const w = 1.5 * u * 2 + 1.85 * u + 0.74 * u + labelW;
  const x = layout.cx - w * 0.5;
  const y = layout.y(59.6) + rise;
  batch.rect(x, y, w, h, COLOUR.black, ALPHA.scrim * a);
  if (p.hold > 0) batch.rect(x, y, w * clamp01(p.hold), h, COLOUR.white, 0.2 * a);
  keybindChip(batch, pen, p.key, x + 1.5 * u + 0.925 * u, y + h * 0.5, u, ALPHA.chip * a);
  pen.draw(batch, p.label, x + 1.5 * u + 1.85 * u + 0.74 * u, y + h * 0.5 + cap * 0.5, {
    cap,
    weight: TYPE.t1.weight,
    tracking: 0.07,
    colour: COLOUR.white,
    alpha: a,
    align: 'left',
    treatment: 'shadow',
  });
}

/* --------------------------------------------------- kill / score / xp ---- */

export function drawKillCluster(ctx: HudContext): void {
  const { batch, pen, layout, state, dim } = ctx;
  const u = layout.u;
  const left = layout.cx - 32 * u;
  let bottom = layout.y(71);

  for (let i = state.clusters.length - 1; i >= 0; i--) {
    const c = state.clusters[i];
    const age = state.time - c.born;
    const alpha = clamp01(1 - (age - 1.66) / 0.35) * dim;
    if (alpha <= 0.01) continue;

    // Staged entrance: ribbon at t=0, victim name +80 ms, KILL banner +160 ms,
    // tags +240 ms, each a 120 ms alpha and a 0.37u rise.
    const stage = (delay: number): { a: number; rise: number } => {
      const t = clamp01((age - delay) / 0.12);
      return { a: EASE.out(t) * alpha, rise: (1 - EASE.out(t)) * 0.37 * u };
    };

    const s0 = stage(0);
    awardRibbon(batch, left + 1.85 * u, bottom - 5.4 * u + s0.rise, 3.7 * u, 1.6 * u, COLOUR.white, s0.a);

    const s2 = stage(0.16);
    const cap = TYPE.t1.cap * u;
    const bannerW = pen.measure('KILL', { cap, weight: TYPE.t1.weight, tracking: TYPE.t1.tracking, colour: COLOUR.white, alpha: 1 }) + 1.48 * u;
    const bannerY = bottom - 3.4 * u + s2.rise;
    // Empty-box treatment: 2 px stroke, sharp corners, FULLY TRANSPARENT fill.
    // Filling an award tag is what makes it read as an interaction band.
    boxOutline(ctx, left, bannerY - 1.3 * u, bannerW, 2.2 * u, 0.19 * u, COLOUR.white, s2.a);
    pen.draw(batch, 'KILL', left + bannerW * 0.5, bannerY + cap * 0.5 - 0.2 * u, {
      cap,
      weight: TYPE.t1.weight,
      tracking: TYPE.t1.tracking,
      colour: COLOUR.white,
      alpha: s2.a,
      align: 'center',
      treatment: 'shadow',
    });

    let tagX = left + bannerW + 0.37 * u;
    const s3 = stage(0.24);
    for (const tag of c.tags) {
      const tw = pen.measure(tag, { cap, weight: TYPE.t1.weight, tracking: TYPE.t1.tracking, colour: COLOUR.white, alpha: 1 }) + 1.1 * u;
      boxOutline(ctx, tagX, bannerY - 1.3 * u, tw, 2.2 * u, 0.14 * u, COLOUR.white, s3.a);
      pen.draw(batch, tag, tagX + tw * 0.5, bannerY + cap * 0.5 - 0.2 * u, {
        cap,
        weight: TYPE.t1.weight,
        tracking: TYPE.t1.tracking,
        colour: COLOUR.white,
        alpha: s3.a,
        align: 'center',
        treatment: 'shadow',
      });
      tagX += tw + 0.37 * u;
    }

    // The skull carries a VALUE, so it is drawn only once there is one. A live
    // kill raises the cluster the instant the killfeed event lands and GAME
    // publishes the score a tick later; drawing early put a literal "0" beside
    // the skull for two frames of every kill.
    if (c.points > 0) {
      skull(batch, tagX + 1.0 * u, bannerY - 0.2 * u, 1.6 * u, COLOUR.white, s3.a, COLOUR.black, 0.6);
      pen.draw(batch, String(c.points), tagX + 2.2 * u, bannerY + TYPE.t3.cap * u * 0.4, {
        cap: TYPE.t3.cap * u,
        weight: TYPE.t3.weight,
        tracking: TYPE.t3.tracking,
        colour: COLOUR.white,
        alpha: s3.a,
        align: 'left',
        treatment: 'shadow',
      });
    }

    const s1 = stage(0.08);
    pen.draw(batch, c.victim, left, bottom - 0.6 * u + s1.rise, {
      cap: TYPE.t2.cap * u,
      weight: TYPE.t2.weight,
      tracking: TYPE.t2.tracking,
      colour: c.victimTeam === ctx.localTeam ? ctx.friendly : ctx.enemy,
      alpha: s1.a,
      align: 'left',
      treatment: 'glow',
      glowAlpha: 0.3,
    });

    bottom -= 8.0 * u;
  }

  // Objective score popups share the anchor family, and are told apart from the
  // kill cluster ONLY by colour (§5.2).
  for (let i = state.popups.length - 1; i >= 0; i--) {
    const p = state.popups[i];
    const age = state.time - p.born;
    const alpha = clamp01(1 - (age - 1.2) / 0.3) * dim;
    if (alpha <= 0.01) continue;
    const scale = age < 0.14 ? 1.15 - 0.15 * EASE.snap(age / 0.14) : 1;
    const rise = age > 1.2 ? ((age - 1.2) / 0.3) * 0.55 * u : 0;
    const cap = TYPE.t1.cap * u * scale;
    const w = pen.measure(p.label, { cap, weight: TYPE.t1.weight, tracking: TYPE.t1.tracking, colour: COLOUR.scoreObj, alpha: 1 }) + 1.1 * u;
    const y = bottom - 0.6 * u - rise;
    boxOutline(ctx, left, y - 1.7 * u, w, 2.3 * u, 0.14 * u, COLOUR.scoreObj, alpha);
    pen.draw(batch, p.label, left + w * 0.5, y - 0.2 * u, {
      cap,
      weight: TYPE.t1.weight,
      tracking: TYPE.t1.tracking,
      colour: COLOUR.scoreObj,
      alpha,
      align: 'center',
      treatment: 'glow',
      glowAlpha: 0.3,
    });
    pen.draw(batch, String(p.value), left + w + 1.5 * u, y - 0.1 * u, {
      cap: TYPE.t3.cap * u,
      weight: TYPE.t3.weight,
      tracking: TYPE.t3.tracking,
      colour: COLOUR.scoreObj,
      alpha,
      align: 'left',
      treatment: 'glow',
      glowAlpha: 0.3,
    });
    bottom -= 3.0 * u;
  }
}

function boxOutline(ctx: HudContext, x: number, y: number, w: number, h: number, stroke: number, colour: Rgb, alpha: number): void {
  const { batch } = ctx;
  batch.rect(x, y, w, stroke, colour, alpha);
  batch.rect(x, y + h - stroke, w, stroke, colour, alpha);
  batch.rect(x, y, stroke, h, colour, alpha);
  batch.rect(x + w - stroke, y, stroke, h, colour, alpha);
}

export function drawXpToast(ctx: HudContext): void {
  const { batch, pen, layout, state, dim } = ctx;
  const u = layout.u;
  const right = layout.right(10.6 - 2.96);
  let y = layout.y(60.6);
  for (const toast of state.xpToasts) {
    const age = state.time - toast.born;
    const alpha = clamp01(1 - (age - 1.75) / 0.35) * dim;
    if (alpha <= 0.01) continue;
    const rise = age > 1.75 ? ((age - 1.75) / 0.35) * 0.55 * u : 0;
    const cap = TYPE.t3.cap * u;
    const label = `+${toast.value} XP`;
    const w = pen.measure(label, { cap, weight: TYPE.t3.weight, tracking: TYPE.t3.tracking, colour: COLOUR.xp, alpha: 1 });
    // The ONE coloured scrim in the HUD, and it wipes in left→right over 220 ms.
    const wipe = clamp01(age / 0.22);
    batch.rect(right - w - 0.37 * u, y - cap - 0.37 * u - rise, (w + 0.74 * u) * wipe, cap + 0.74 * u, COLOUR.xpScrim, ALPHA.xpScrim * alpha);
    pen.draw(batch, label, right, y - rise, {
      cap,
      weight: TYPE.t3.weight,
      tracking: TYPE.t3.tracking,
      colour: COLOUR.xp,
      alpha: clamp01(age / 0.15) * alpha,
      align: 'right',
      treatment: 'glow',
      glowAlpha: 0.35,
    });
    pen.draw(batch, `${toast.progress.toLocaleString('en-US')}/${toast.total.toLocaleString('en-US')}`, right, y + 2.0 * u - rise, {
      cap: TYPE.t2.cap * u,
      weight: TYPE.t2.weight,
      tracking: TYPE.t2.tracking,
      colour: COLOUR.white,
      alpha: 0.85 * alpha,
      align: 'right',
      treatment: 'shadow',
    });
    y += 4.6 * u;
  }
}

/* -------------------------------------------------------------- spot pin -- */

const SPOT_SCREEN = makeScreenPoint();

export function drawSpotPins(ctx: HudContext): void {
  const { batch, layout, state, dim } = ctx;
  const u = layout.u;
  for (const spot of state.spots) {
    const age = state.time - spot.born;
    const alpha = clamp01(1 - (age - 4) / 0.6) * 0.65 * dim;
    if (alpha <= 0.01) continue;
    ctx.project(spot.world, SPOT_SCREEN);
    if (!SPOT_SCREEN.onScreen) {
      // A small chevron beside it when the ping is off-screen in that direction.
      const side = SPOT_SCREEN.x < layout.cx ? -1 : 1;
      const x = side < 0 ? layout.left(1.5) : layout.right(1.5);
      const y = Math.max(layout.y(20), Math.min(layout.y(80), SPOT_SCREEN.y));
      batch.poly(
        [
          [x, y - 0.9 * u],
          [x + side * 1.1 * u, y],
          [x, y + 0.9 * u],
        ],
        ctx.enemy,
        alpha,
      );
      continue;
    }
    mapPin(batch, SPOT_SCREEN.x, SPOT_SCREEN.y - 3.2 * u, 1.85 * u, ctx.enemy, alpha);
  }
}

export { boxOutline };
