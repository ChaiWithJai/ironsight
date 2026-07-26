/**
 * RCORE's shot file. Owned by RCORE and by nobody else.
 *
 * MUST PROVE: the post chain end to end — TAA convergence on thin geometry,
 * per-object motion blur, the bloom threshold, the AgX ramp and the grade — plus
 * depth of field with real bokeh.
 *
 * Both cameras are staged for the FRAME, not for the level: what a post-chain
 * critic needs is a histogram that is genuinely occupied at both ends
 * (LOOK_SPEC §5.2: p50 in 70–115, p99 in 195–248, under 0.30 % above 250),
 * which means the sun side of the map, over water, with structure silhouetted
 * against it. BRAVO is where that lives — `docs/LOOK_SPEC.md` §2.3 chose the
 * objective's sightlines to run into the sun for exactly this reason.
 *
 * Coordinates are literals, as the harness requires: a shot file has no route to
 * a service and importing `@/level/**` breaks boundary CI.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'post_chain',
  description:
    'BRAVO, off the quay head looking west-north-west INTO the low ' +
    'sun over the water, weapon up. The post chain end to end: blown sky and water ' +
    'against silhouetted crane lattice — thin geometry TAA has to resolve without ' +
    'smearing — a fully occupied histogram, the AgX ramp, the split-tone grade, ' +
    'earned bloom on the water only, and the viewmodel carrying its 1.5–3 px ' +
    'near-field CoC while everything past 4 m stays sharp.',
  // 26 frames: three full cycles of the 8-sample Halton jitter, which is enough
  // for the history to converge on thin geometry. Every frame here is real time
  // under the software rasteriser and the harness times a shot out at 240 s.
  frames: 26,
  setup(ctx) {
    ctx.seed(0x52);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 5.5, fog: 0.0032 });
    // Weapon ON: the near field is where §9.2 says we win, and the viewmodel is
    // also the only surface in frame that exercises the tight TAA clamp, the
    // motion-blur exemption and the near-side CoC at once.
    ctx.setOverlays({ viewmodel: true, hud: false });
    // Off the quay head looking WNW down the apron: the three gantry lattices
    // are 40–90 m out, which is exactly the thin high-contrast geometry TAA has
    // to resolve without dashing or crawl, and the glitter path underneath them
    // is the frame's only legitimate bloom source. Horizon sits 4 % below the
    // centreline — inside §7.2's ±6 % for a registered shot camera.
    ctx.poseCamera([56, 13.4, 80], [84, 13.1, 88], 60);
  },
});

registerShot({
  name: 'post_dof_bokeh',
  description:
    'The same quay on a 38 deg cinematic lens. Proves the aperture path: ' +
    'auto-focus onto the crane lattice at the frame centre, the near water and ' +
    'the weapon melting in the foreground, the headland behind at ~30 px of CoC, ' +
    'and the specular glitter breaking into round 7-blade bokeh that brightens ' +
    'at the rim and squashes to a cat\'s eye toward the corners.',
  frames: 20,
  setup(ctx) {
    ctx.seed(0x53);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 4.0, fog: 0.0028 });
    ctx.setOverlays({ viewmodel: true, hud: false });
    // 38 deg is the §7.1 cinematic lens, and it is ALSO the signal the DOF pass
    // uses to switch from gameplay restraint to a real aperture — the player's
    // own FOV slider bottoms out at 60, so nothing in gameplay can reach it.
    ctx.poseCamera([64, 13.4, 88], [76, 13.0, 100], 38);
  },
});
