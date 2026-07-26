/**
 * LEVEL's shot file. Owned by LEVEL and by nobody else.
 *
 * MUST PROVE: ALPHA / BRAVO / CHARLIE establishing shots, ground transitions,
 * no hard seams.
 *
 * Four shots, three of them at STANDING EYE HEIGHT rather than from a drone.
 * That is deliberate: `reference/gameplay/` is the ground truth for this project
 * and every frame in it is 1.6 m off the deck. A level that only reads from a
 * helicopter is a level that does not read.
 *
 * All coordinates are literals. `src/level/cameras.ts` holds the same poses by
 * name for the fly-in and the attract loop, but boundary CI forbids a shot file
 * from importing `@/level/**`, so the two are kept in step by hand — which is
 * correct, because a shot that silently follows a level edit stops being a
 * regression test.
 *
 * Time of day is 17.4 h everywhere, matching CORE's smoke test and
 * `docs/LOOK_SPEC.md`: sun at 6–10°, raking straight along the streets, which is
 * the condition every piece of relief in this lane — window reveals, string
 * courses, parapet copings, arcade impost bands, the drift at the foot of every
 * wall — was authored for.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'level_alpha',
  description:
    'ALPHA, the market square, at standing eye height from the east approach. ' +
    'Proves: the covered market hall is a real enterable arcade, the square has ' +
    'hard cover in it, and every wall meets the paving through a sand drift ' +
    'rather than a hard seam.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x41);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 4.0, fog: 0.0028 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // NORTH-WEST of the hall, looking south-east. At 17.4 h the sun is in the
    // western half of the sky, so the east approach — which is where a player
    // actually arrives from — puts the whole arcade in its own shadow. The
    // review frame has to be on the LIT side or it is a photograph of a
    // silhouette. Square terrace is flat at y = 11.5; 1.72 m is standing eye.
    ctx.poseCamera([52, 13.22, 76], [74, 12.4, 98], 55);
  },
});

registerShot({
  name: 'level_bravo',
  description:
    'BRAVO, the quay, looking west along the apron with all three gantry cranes ' +
    'in line. Proves: the crane lattices read as steel and not as boxes, the ' +
    'container yard makes lanes rather than a wall, and the quay coping and ' +
    'armour stone give the seawall a waterline.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x42);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 5.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Out over the water off the quay head. This is the ONLY angle from which
    // the three cranes read as ship-to-shore machines rather than as towers:
    // their 30 m jibs cantilever toward the camera, which is what a gantry
    // crane's silhouette is actually about.
    ctx.poseCamera([58, 9, -66], [-30, 16, -26], 46);
  },
});

registerShot({
  name: 'level_charlie',
  description:
    'CHARLIE, the old fort, from the crest of the headland road it is approached ' +
    'along. Proves: the gatehouse passage is a real opening, the curtain is ' +
    'battered and crenellated rather than extruded, the north wall is breached ' +
    'into a climbable ramp, and the whole enceinte sits INTO the rock.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x43);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 6.5, fog: 0.0045 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // From the seaward shoulder, looking east-south-east into the fort with the
    // low sun behind the camera. The gate faces the road, which runs away to the
    // ESE, so the gate face is in permanent shadow at golden hour and the
    // approach angle is the wrong one to review from. This angle carries the
    // BREACHED north-west curtain, two towers and the keep roof, all lit.
    ctx.poseCamera([-268, 50, -86], [-208, 34, -44], 44);
  },
});

registerShot({
  name: 'level_overview',
  description:
    'The whole of HARBOUR REACH from the south-east at 250 m: the ALPHA terrace ' +
    'right, the BRAVO quay and breakwater centre, the CHARLIE headland left, the ' +
    'wreck offshore. Proves the macro composition, the three-point triangle and ' +
    'the aerial perspective pushing the headland into haze.',
  // Fewer frames: nothing on this shot is temporally unstable at this distance,
  // and every frame under the software rasteriser is real time in the loop.
  frames: 20,
  setup(ctx) {
    ctx.seed(0x44);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.08, { wind: 5.0, fog: 0.0030 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    ctx.poseCamera([152, 236, 300], [-70, 10, 2], 45);
  },
});
