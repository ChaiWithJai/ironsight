/**
 * PHYS's destruction shot. Owned by PHYS and by nobody else.
 *
 * PROVES: a pre-fractured masonry cover wall mid-collapse — Voronoi shards baked
 * at load time, released inside the tier's chunk budget, thrown by a blast
 * impulse — with the sightline it opened readable through the gap: a fuel drum
 * and a low barrier that an intact 2.4 m wall completely hides.
 *
 * The charge fires on RELATIVE tick 34 of the 64 this shot renders, so the grab
 * lands half a second into the collapse: shards still in the air, the first of
 * them already on the slab. Relative, not absolute — the tick counter keeps
 * running across captures, and a shot keyed to it would show a different half of
 * the collapse depending on what was photographed before it.
 *
 * The seed is the scenario selector; see `src/shots/physics.ts` for why that is
 * the only channel a shot file has into a lane.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'destruction_wall',
  description:
    'Voronoi pre-fractured sandstone cover wall half a second into its collapse, ' +
    'flanked by two intact bays, with the sightline it just opened.',
  frames: 64,
  setup(ctx) {
    // 0x5048_0002 — 'PH' + scenario 2: build the cover-wall proving ground.
    ctx.seed(0x50480002);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 3.5, fog: 0.003 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Eye height, ten metres WEST of the middle bay, with the low sun behind
    // the camera: the near face of the wall and the falling shards are both lit,
    // and the gap opens straight down the lens.
    ctx.poseCamera([139.2, 6.1, 23.4], [152, 4.9, 25.2], 52);
  },
});
