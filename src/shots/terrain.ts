/**
 * TERRAIN's shot file. Owned by TERRAIN and by nobody else.
 *
 * Three cameras, each isolating one thing the lane is judged on:
 *
 *   terrain_shore     the waterline silhouette, the swash scarp, wet sand and
 *                     the sand → scrub splat transition, at eye height
 *   terrain_headland  cliff strata, erosion channels, rock/scrub splat and the
 *                     aerial-perspective ladder into the headland
 *   terrain_lod_seam  a 500 m downhill sightline that crosses every LOD ring on
 *                     the map at a grazing angle — where a T-junction crack or a
 *                     tessellation pop would be impossible to miss
 *
 * SUN AZIMUTH. The null/SKY solar model puts the 17:24 sun at ≈261° world
 * azimuth (WNW, over the sea) at 9–11° elevation. Every camera below is chosen
 * so the sightline sits 60–120° off that, per LOOK_SPEC §2.3 — the point being
 * that no slope in frame is front-lit, and every one shows a sunlit face and a
 * sky-lit face at once.
 *
 * Ground heights are evaluated from MACRO_TERRAIN so the eye heights stay
 * correct if the silhouette is ever retuned; the erosion pass moves the ground
 * under these cameras by less than a metre by construction.
 */
import { registerShot } from '@/engine/harness';
import { MACRO_TERRAIN } from '@/engine/macro';

/** Standing eye height, LOOK_SPEC §7.2. */
const EYE = 1.62;

function eyeAt(x: number, z: number, lift = 0): number {
  return MACRO_TERRAIN.height(x, z) + EYE + lift;
}

registerShot({
  name: 'terrain_shore',
  description:
    'Eye-height beach: the waterline silhouette, swash scarp and cusps, wet-sand band, and the sand → dry-scrub splat transition running inland.',
  frames: 32,
  setup(ctx) {
    ctx.seed(0x7e44);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0, { wind: 0.4 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Eye height on the eastern beach, looking ESE so the waterline runs
    // DIAGONALLY across the frame about 30 m out: sea to the left, wet band,
    // dry berm and scrub terrace to the right. The sun is 136° off the
    // sightline, which rakes the ripple relief and the scarp; a front-lit beach
    // is a flat beach. The camera is level — tilting down to show more ground is
    // the demo-camera tell LOOK_SPEC §7.2 names.
    ctx.poseCamera([160, eyeAt(160, 5), 5], [324, 1.6, -89], 72);
  },
});

registerShot({
  name: 'terrain_headland',
  description:
    'The CHARLIE headland from the seaward side: bedded cliff strata, erosion channels and their deposition fans, and the rock/scrub splat boundary under raking light.',
  frames: 32,
  setup(ctx) {
    ctx.seed(0x7e45);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0, { wind: 0.4 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Over the water north-west of the promontory, looking south-east at it:
    // 124° off the sun, which lights the seaward faces at a grazing angle and
    // leaves the channels in their own shadow. A narrower FOV than gameplay
    // (55° vs 72°) because this is a vista, not a firefight — noted as a
    // deliberate departure from LOOK_SPEC §7.1's default.
    ctx.poseCamera([-248, 12, -200], [-214, 14, -110], 55);
  },
});

registerShot({
  name: 'terrain_lod_seam',
  description:
    'A 350 m grazing sightline west along the beach, straight into the low sun — every LOD ring from 0.75 m to 192 m cells crosses the frame at near-zero incidence with blown sky behind it, which is the harshest possible test for a T-junction crack or a tessellation seam.',
  frames: 32,
  setup(ctx) {
    ctx.seed(0x7e46);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0, { wind: 0.4 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Grazing incidence is the worst case for a seam: a 40 cm crack in the mesh
    // subtends far more screen space along the view direction than across it,
    // and with the sun 12° off the sightline the sky behind it is the brightest
    // thing in the frame — a hairline would read as a lit wire. Level camera,
    // eye height, 350 m of continuous beach from 1 m to the far coast.
    ctx.poseCamera([250, eyeAt(250, 20), 20], [-100, 1.0, 40], 72);
  },
});
