/**
 * VEG's shot file. Owned by VEG and by nobody else.
 *
 * MUST PROVE: palms in wind, grass field density falloff, LOD/impostor
 * transition.
 *
 * Composition notes, because these cameras are not arbitrary:
 *
 *  - The sun sits at azimuth ≈ 261° (WNW, over the sea) and 9–10° of elevation
 *    at 17:24. `veg_field` therefore runs CROSS-SUN, 125° off the sightline, so
 *    every tuft shows a lit face and a sky-lit face and the field carries a
 *    shadow ladder (LOOK_SPEC §2.3). `veg_palms` runs straight INTO it, which
 *    is the only framing in which leaf translucency is doing visible work
 *    (§4.7).
 *  - Every camera is at standing eye height 1.62 m over the ground it is
 *    standing on, with the aim point at the same height, so the horizon lands on
 *    the centreline (§7.2) instead of the tilted-down demo camera.
 *  - Heights come from `MACRO_TERRAIN`, which is on the shared-import list, so
 *    the cameras cannot end up buried or floating when TERRAIN's eroded
 *    heightfield replaces the analytic one.
 */
import { registerShot } from '@/engine/harness';
import { MACRO_TERRAIN } from '@/engine/macro';

const EYE = 1.62;

function ground(x: number, z: number): number {
  return MACRO_TERRAIN.height(x, z);
}

registerShot({
  name: 'veg_field',
  description:
    'Standing in the dry grass on the inland terrace, cross-sun: blade geometry at 2 m, ' +
    'the gust wave running across the field, density falling off into the distance mat.',
  frames: 32,
  setup(ctx) {
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.12, { wind: 5.4 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Standing on the open terrace south-east of ALPHA. The sightline runs
    // NNW across the field toward the town and the water beyond it, which is
    // 125° off the sun azimuth: raking light, long shadows, and every tuft with
    // a lit face and a sky-lit face.
    const cx = 96;
    const cz = 214;
    const tx = -6;
    const tz = 92;
    ctx.poseCamera([cx, ground(cx, cz) + EYE, cz], [tx, ground(tx, tz) + EYE + 6.5, tz], 72);
  },
});

registerShot({
  name: 'veg_palms',
  description:
    'Palms on the harbour flat between the camera and a 10° sun: frond silhouette, ' +
    'backlit leaf translucency, trunk sway and the LOD ladder receding to impostors.',
  frames: 32,
  setup(ctx) {
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.10, { wind: 6.2 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // On the coastal flat east of the harbour, looking WNW straight down the
    // sun azimuth over the palm belt to the headland. Contre-jour: the fronds
    // are between the eye and a 10° sun, which is the only framing in which
    // leaf transmission does visible work.
    const cx = 212;
    const cz = 62;
    const tx = -160;
    const tz = 14;
    ctx.poseCamera([cx, ground(cx, cz) + EYE, cz], [tx, ground(cx, cz) + EYE + 9.0, tz], 72);
  },
});

registerShot({
  name: 'veg_distance_blend',
  description:
    'Down the terrace toward the harbour: near tufts, mid clusters, far ground mat and haze ' +
    'in one frame — the test for a visible LOD ring or a density cliff.',
  frames: 32,
  setup(ctx) {
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.14, { wind: 4.8 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    const cx = 150;
    const cz = 236;
    const tx = 8;
    const tz = 30;
    ctx.poseCamera([cx, ground(cx, cz) + EYE + 1.2, cz], [tx, ground(tx, tz) + EYE + 11.0, tz], 72);
  },
});
