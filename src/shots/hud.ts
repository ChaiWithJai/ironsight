/**
 * HUD's shot file. Owned by HUD and by nobody else.
 *
 * MUST PROVE: the full HUD in combat, plus the scoreboard and deploy screens.
 *
 * HOW A SHOT FILE REACHES THIS LANE. Boundary CI treats `src/shots/` as its own
 * lane, so this file may not import `@/ui/**`, and `ShotContext` exposes no
 * route to a service. `seed(n)` is the one channel that does reach a lane: the
 * frozen descriptor table calls every `reset<Key>(seed)` with it, and `resetHud`
 * arms the matching scenario when it sees one of these values. The constants are
 * therefore duplicated here rather than imported, and `HUD_SEED_*` in
 * `src/ui/system.ts` is their definition. ASCII "HUD" plus an index.
 */
import { registerShot, type ShotContext } from '@/engine/harness';

const HUD_SEED_FULL = 0x48554430;
const HUD_SEED_COMBAT = 0x48554431;
const HUD_SEED_DEPLOY = 0x48554432;
const HUD_SEED_SCOREBOARD = 0x48554433;

/** Golden hour, light haze — the project's house lighting, so shots compare. */
function light(ctx: ShotContext): void {
  ctx.setTimeOfDay(17.4);
  ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
}

/**
 * The legibility case the whole HUD is designed against: looking WNW down the
 * waterfront from the market terrace, into the low sun and across the blown-out
 * water, with the headland and CHARLIE in the haze. The upper-left and
 * upper-right quadrants stay empty of HUD by design (§11), so the composition
 * has somewhere to put the sky — and the ticket bar, compass and killfeed all
 * have to hold against the brightest part of the frame.
 *
 * Cross-sun rather than front-lit, per LOOK_SPEC §2.3: every vertical face in
 * frame shows a lit side and a sky-lit side.
 */
function overWaterfront(ctx: ShotContext): void {
  light(ctx);
  ctx.setOverlays({ viewmodel: true, hud: true });
  // `assault` and not `idle`: GAME's assault scenario is the only lever a shot
  // file has on the match model, and it is the one that produces an INTERESTING
  // ticket state — 318 vs 193, so the losing track shows its dark stub against
  // the centre gutter, which is §0.4's headline invariant and cannot be
  // demonstrated at a fresh 450/450. It also contests ALPHA, which is what puts
  // the doubled capture glyph and the world capture bar on screen.
  ctx.setPlayerState('assault');
  // On the quay above BRAVO, eye height, looking WNW down the harbour toward the
  // CHARLIE headland. Chosen for the HUD's sake: it puts the compass, ticket bar
  // and killfeed over open sky and the glitter path, which is the legibility
  // case §0.5's no-scrim rule has to survive, and it gives the frame the three
  // luminance bands LOOK_SPEC §7.2 asks for (dark quay, mid town, bright water).
  ctx.poseCamera([46, 9.5, 62], [-70, 9.0, -10], 72);
}

registerShot({
  name: 'hud_full',
  description:
    'The full HUD at rest over live gameplay, looking WNW down the waterfront into the low sun: ' +
    'compass tape and static dashed rule, the two ticket tracks filling from the outer edges with ' +
    'the losing stub against the centre gutter, the three-chip capture row encoding ownership by ' +
    'shape as well as colour, killfeed, minimap with view cone and order path, squad list with the ' +
    "local player's double-width health bar on the bottom row, bracketed weapon card with a " +
    'dim-padded magazine count and a top-aligned reserve, gadget tiles with a hatched cooldown, ' +
    'the ability rail and its segment meter, and world objective markers with distances.',
  frames: 40,
  setup(ctx) {
    ctx.seed(HUD_SEED_FULL);
    overWaterfront(ctx);
  },
});

registerShot({
  name: 'hud_combat',
  description:
    'The same HUD under load: a world-anchored gold kill hitmarker with its accumulated damage chip, ' +
    'two damage-direction arcs at 13u from centre, the spotted diamond, blood on the lens periphery, ' +
    'a five-row killfeed with the local player row recoloured white and led by a triangle, the kill ' +
    'cluster with its award ribbon and empty-box tags, an objective score popup, the XP toast with ' +
    'the one coloured scrim in the HUD, the world capture bar with occupancy counts, and a spot pin. ' +
    'Proves the hierarchy survives eight simultaneous transients.',
  frames: 62,
  setup(ctx) {
    ctx.seed(HUD_SEED_COMBAT);
    light(ctx);
    ctx.setOverlays({ viewmodel: true, hud: true });
    ctx.setPlayerState('firing');
    // Inside the ALPHA market square, cross-sun, with the arcade colonnade on
    // the right giving the frame a dark near-field band to read the HUD against.
    // Pitched down 3.6°, which puts the horizon 5 % below the centreline —
    // inside LOOK_SPEC §7.2's ±6 % budget for a registered shot camera.
    ctx.poseCamera([97, 18.5, 116], [40, 13.5, 60], 72);
  },
});

registerShot({
  name: 'hud_deploy',
  description:
    'The deploy screen: the minimap plate scaled to fill with the three capture points as large ' +
    'shape-coded markers over their real footprints, friendly spawn pips, the CONQUEST / HARBOUR ' +
    'REACH identity block, the outlined DEPLOY button with its keybind chip, and the blueprint ' +
    'chrome in the outer margin. The live frame is still visible behind it and the ticket bar and ' +
    'capture row stay on, which is what makes it a layer over the game rather than a menu page.',
  frames: 24,
  setup(ctx) {
    ctx.seed(HUD_SEED_DEPLOY);
    light(ctx);
    ctx.setOverlays({ viewmodel: false, hud: true });
    ctx.poseCamera([96, 34, 168], [-140, 8, -30], 42);
  },
});

registerShot({
  name: 'hud_scoreboard',
  description:
    'The scoreboard over a LIVE, UNBLURRED gameplay backdrop: two team columns with alternating ' +
    '6 %/2 % white row bands, the local player row in a 2 px team outline over a blue fill, tabular ' +
    'score/K/D/A columns that do not reflow, and the rest of the HUD dimmed to 0.25 rather than ' +
    'hidden.',
  frames: 24,
  setup(ctx) {
    ctx.seed(HUD_SEED_SCOREBOARD);
    light(ctx);
    ctx.setOverlays({ viewmodel: false, hud: true });
    ctx.setPlayerState('assault');
    ctx.poseCamera([64, 16.6, 92], [-96, 10, 6], 72);
  },
});
