/**
 * CORE's shot. This is the smoke test the whole repo depends on: if `core`
 * captures, the engine booted, the bake ran, the fixed-tick loop advanced, the
 * render graph executed and a frame landed in the framebuffer.
 *
 * Do not make it depend on any other lane's work. Every other shot in the repo
 * can be red while this one is green, and that is exactly the diagnostic value
 * it has.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'core',
  description:
    'Engine smoke test: boot, fixed-tick loop, render graph, one frame. ' +
    'Looks north-west across the town terrace to the headland at golden hour.',
  // 24 rather than the default 32: nothing temporal is running yet, and every
  // frame under SwiftShader is real wall-clock time in the review loop.
  frames: 24,
  setup(ctx) {
    ctx.seed(0x1205);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Offshore, looking back at the coast. Deliberately OUTSIDE the level's
    // massing volume (which spans z -88..270) so no lane's future geometry can
    // ever end up in front of the smoke-test camera and turn this shot into a
    // close-up of a wall. Frames the CHARLIE headland left, the BRAVO quay
    // centre, the ALPHA terrace right, with the sea and the low sun behind.
    ctx.poseCamera([90, 62, -180], [-60, 12, 60], 46);
  },
});
