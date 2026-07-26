/**
 * PHYS's character + debris shot. Owned by PHYS and by nobody else.
 *
 * PROVES: a soldier climbing a twelve-tread stone stair with no step-up hitch, a
 * second one walking a 24° ramp, a third refused by a 55° face beside it, a
 * settled masonry rubble pile, and an articulated ragdoll draped over it.
 *
 * THE SEED IS NOT DECORATION. A shot file may pose the camera and nothing else —
 * `ShotContext` has no route to a service and boundary CI forbids `src/shots/**`
 * from importing a lane — so PHYS reads the SEED as a scenario selector: any
 * seed whose high sixteen bits are 0x5048 ('PH') builds a proving ground, and
 * every other seed tears it down so it can never appear in another lane's frame.
 * The literal below is that protocol; see `src/physics/scenario.ts`.
 *
 * Camera poses are LITERAL COORDINATES, as they must be here. The arena sits on
 * the terrace east of the market at (150, 30), on ground the macro field holds
 * at 3.2 m, with the slab top at 3.6 m.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'physics_stack',
  description:
    'Kinematic character controller on a 12-tread stair and on 24°/55° ramps, ' +
    'a settled masonry rubble pile and an articulated ragdoll, at golden hour.',
  // 72 fixed ticks = 1.2 s: long enough for the walkers to be well onto the
  // stair and for the ragdoll to have draped, short enough to capture under a
  // software rasteriser inside the review loop.
  frames: 72,
  setup(ctx) {
    // 0x5048_0001 — 'PH' + scenario 1: build the stack proving ground.
    ctx.seed(0x50480001);
    ctx.setTimeOfDay(16.9);
    ctx.setWeather(0.05, { wind: 3.5, fog: 0.003 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Square on to the walking line from the south, 4.5 m above the slab: the
    // stair, both ramps and all three soldiers read across one frame, with the
    // rubble pile and the ragdoll behind them.
    ctx.poseCamera([150, 7.6, 9], [150.5, 5.8, 24], 62);
  },
});
