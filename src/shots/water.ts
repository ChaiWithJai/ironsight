/**
 * WATER's shots. Owned by WATER and by nobody else.
 *
 * MUST PROVE: sun glitter off the water, shoreline foam, refraction, the
 * half-sunk freighter waterline.
 *
 * THE SUN, AND WHY EACH CAMERA POINTS WHERE IT DOES. At 17:24 the sun sits at
 * ~9.7° of elevation on a bearing of 261° — west, a touch north, out over the
 * open sea past the headland. LOOK_SPEC §2.3 puts the sightline 100–150° off the
 * sun for material shots and explicitly excepts BRAVO, which "runs into the sun
 * over the water" and owns the glitter path. So:
 *
 *   water_golden     dead into the sun. The glitter path is the brightest thing
 *                    in the frame and the primary bloom source.
 *   water_shore      131° off the sun — cross-lit surf, so the foam has a lit
 *                    face and a sky-lit face and the wet sand reads as wet.
 *   water_freighter  41° off the sun. The wreck is backlit and the water in
 *                    front of it is the glitter path she is silhouetted against.
 *
 * Camera poses are LITERAL COORDINATES: `ShotContext` has no route to a service
 * and boundary CI forbids `src/shots/**` from importing a lane.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'water_golden',
  description:
    'The glitter path: sea-level camera looking WNW straight into a 9.7° sun over open water. ' +
    'Over-range specular pinpricks on Gerstner slopes, the haze ladder out to the headland, ' +
    'and the whole highlight population of the frame living on the water.',
  // 30 frames: the sea needs a couple of seconds of wave phase to be somewhere
  // interesting, and nothing here is a temporal feedback loop.
  frames: 24,
  setup(ctx) {
    ctx.seed(0x1205);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Six metres over open water in the harbour approaches, 50 m clear of the
    // breakwater head so no structure crowds the near field, looking WNW
    // straight down the sun's bearing. The height is doing real work: from 1.4 m
    // every square metre of sea is at grazing incidence and the whole frame is a
    // mirror, whereas from 7 m the bottom of the frame looks down at 26° where
    // Fresnel is 0.07 and the water shows its own colour. That is what gives the
    // frame its near/mid/far luminance bands. Horizon at 0.527 H, inside §7.2's
    // ±6 %; the CHARLIE headland closes the left of the skyline at 270 m.
    ctx.poseCamera([120, 6.0, -120], [-78, 1.5, -148], 52);
  },
});

registerShot({
  name: 'water_shore',
  description:
    'Surf and swash on the town beach, cross-lit at 131° from the sun: foam on the waterline, ' +
    'wet-sand darkening under the run-up, turquoise transmission over the sand bar and the ' +
    'soft depth-faded intersection with the beach.',
  frames: 24,
  setup(ctx) {
    ctx.seed(0x1205);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // The open beach east of the town, clear of the quay and the market, on a
    // dune the macro field holds at 1.3 m. Looking ENE — 131° off the sun — so
    // the surf line runs diagonally out of frame and the shallows are read
    // THROUGH rather than across. The waterline lands 19 m out at 0.67 H; the
    // camera pitch is 2.5°, which holds the horizon at 0.54 H (§7.2's ±6 %).
    ctx.poseCamera([200, 4.5, 2], [244, 1.8, -43], 58);
  },
});

registerShot({
  name: 'water_freighter',
  description:
    'The grounded freighter at her waterline from the breakwater: hull-to-water intersection, ' +
    'foam where the swell breaks on the reef under her, refraction and absorption over the ' +
    'shallow bar, and her silhouette against the glitter path.',
  frames: 24,
  setup(ctx) {
    ctx.seed(0x1205);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Five metres over the water inside the harbour mouth, 16 m off the wreck's
    // starboard quarter with the low sun beyond her. Close, deliberately: at
    // 35 m the map's aerial perspective already has her at 60 % blend and her
    // waterline stops being readable. Pitch 2.8°, horizon at 0.54 H.
    ctx.poseCamera([74, 5.0, -78], [66, 4.2, -92], 50);
  },
});
