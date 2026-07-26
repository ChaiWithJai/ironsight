/**
 * BAKE's shot file. Owned by BAKE and by nobody else.
 *
 * MUST PROVE: material chart — close-up, grazing angle and at distance; no
 * tiling, no smoothness on approach.
 *
 * The chart itself is built by BAKE in `afterBoot` and parked at
 * `CHART_ORIGIN` (0, -800, 0), far below the world, so it can never intrude on
 * another lane's framing. These three shots are the only cameras that go there.
 * Coordinates are literal because `ShotContext` has no route to a service —
 * that is the harness contract, not an oversight.
 *
 * WHY THREE SHOTS AND NOT ONE. The three defects the brief names for materials
 * fail at three different distances, and a single frame can only catch one:
 * visible repeat is a far-field defect, going smooth on approach is a near-field
 * one, and an over-driven normal map only betrays itself on curvature at a
 * grazing angle. `bake` is the sheet a critic reads first; the other two are
 * where an argument about a specific defect gets settled.
 */
import { registerShot } from '@/engine/harness';

/** Must match `CHART_ORIGIN` in `src/bake/chart.ts`. */
const Y = -800;

registerShot({
  name: 'bake',
  description:
    'Procedural material chart: six baked PBR sets on lit panels and spheres over a ' +
    'stochastically-tiled deck. Judges tiling, three-scale detail, normal strength and ' +
    'the SDF font atlas in one frame.',
  // Nothing temporal runs on the chart — no TAA history, no wind, no particles —
  // so eight frames is settled, and every frame under SwiftShader is real
  // wall-clock time in the review loop.
  frames: 8,
  setup(ctx) {
    ctx.seed(0x8a17);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0, { wind: 0, fog: 0 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Slightly above the sphere row, looking down the deck: the six panels fill
    // the frame, the spheres sit above them, and the floor runs away to the
    // horizon behind so near-field detail and far-field repeat are both in shot.
    ctx.poseCamera([0, Y + 3.9, 13.9], [0, Y + 2.6, -6], 44);
  },
});

registerShot({
  name: 'bake-macro',
  description:
    'Sandstone ashlar at 0.9 m — the near-field test. Mortar courses, per-block bow and ' +
    'shading-time micro-detail must all still be resolving at the closest range a player ' +
    'can stand to a wall.',
  frames: 8,
  setup(ctx) {
    ctx.seed(0x8a17);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0, { wind: 0, fog: 0 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Sandstone panel (leftmost, x = -6.9), seen three-quarters on from 0.9 m —
    // about as close as a standing player gets to a wall, and the angle that
    // shows the mortar courses in relief rather than end-on.
    ctx.poseCamera([-5.9, Y + 2.0, 1.35], [-6.9, Y + 1.7, 0], 40);
  },
});

registerShot({
  name: 'bake-grazing',
  description:
    'The sphere row raked at a grazing angle: over-driven normals, energy loss at the ' +
    'silhouette and the split-sum specular from the baked BRDF LUT all fail visibly here.',
  frames: 8,
  setup(ctx) {
    ctx.seed(0x8a17);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0, { wind: 0, fog: 0 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Down the row from the left, almost in the plane of the spheres, so every
    // sphere is seen near its terminator with the key light raking across it.
    ctx.poseCamera([-11.2, Y + 4.35, 3.0], [7.5, Y + 3.55, -0.4], 30);
  },
});
