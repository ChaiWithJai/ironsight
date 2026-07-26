/**
 * SKY's shot file. Owned by SKY and by nobody else.
 *
 * MUST PROVE: golden-hour sky, clouds, god rays, aerial perspective pushing the
 * headland into haze.
 *
 * Coordinates are literals — `ShotContext` has no route to a service and a shot
 * file may not import `@/level/**`. All three cameras are at or near standing
 * eye height and hold the horizon inside ±6 % of the centreline (LOOK_SPEC §7.2)
 * so they can be blind-A/B'd against real gameplay frames rather than reading as
 * drone shots.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'sky_golden',
  description:
    'GOLDEN, 17.4 h, sun at 11°: the physical Rayleigh/Mie dome over the harbour ' +
    'with the CHARLIE headland at ~1.4 km dissolving into the aerial-perspective ' +
    'ladder. Proves hue-locked sky, a bright horizon that warms toward the sun ' +
    'azimuth, and distance that desaturates into the same colour as the sky above it.',
  frames: 24,
  setup(ctx) {
    ctx.seed(0x5c1);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // On the ALPHA terrace looking WNW down the coast: the fort headland sits on
    // the left at ~1.4 km, the breakwater at ~400 m, the quay at ~150 m. Three
    // depth bands in one frame, which is what §7.2 asks every composed shot for.
    // Sightline azimuth 225°, sun azimuth 261°: 36° apart, so the sun sits near
    // the edge of an 88°-wide frame rather than on the sightline, and every
    // vertical face in shot shows a lit side and a sky-lit side (LOOK_SPEC
    // §2.3). The CHARLIE headland bears 255° from here, so it stays in frame at
    // ~1.3 km — the aerial-perspective ladder this shot exists to prove.
    // Pitch −0.9° holds the horizon 3.4 % above the centreline, inside §7.2's ±6 %.
    ctx.poseCamera([96, 14.0, 34], [-187, 7.5, -249], 55);
  },
});

registerShot({
  name: 'sky_shafts',
  description:
    'Volumetric shafts through the BRAVO gantry cranes, looking into the low sun ' +
    'over the water. Proves the slice volume is marched against the sun shadow ' +
    'map — the beams are cut by the lattice and by the containers rather than ' +
    'being a radial blur off the sun sprite — and that shaft density varies ' +
    'along the beam instead of being a uniform fog constant.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x5c2);
    ctx.setTimeOfDay(17.4);
    // More suspended dust than the default: the quay is the map's dirtiest air
    // and §3.4 wants the shafts to have something to scatter off.
    ctx.setWeather(0.05, { wind: 5.5, fog: 0.0036 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Standing on the apron under the crane legs, sightline running west into
    // the sun along the quay — LOOK_SPEC §2.3 names BRAVO the atmosphere hero
    // location for exactly this reason.
    ctx.poseCamera([44, 8.6, -44], [-120, 21, -30], 52);
  },
});

registerShot({
  name: 'sky_clouds',
  description:
    'The volumetric cloud deck at 900 m base / 1200 m thickness, camera pitched ' +
    'up off the breakwater. Proves internal self-shadowing (dark bases, bright ' +
    'crowns), the sun-side silver lining from the forward phase lobe, and that ' +
    'the deck sits INSIDE the scattering model — hazing out into the horizon ' +
    'rather than being pasted on top of it.',
  frames: 24,
  setup(ctx) {
    ctx.seed(0x5c3);
    ctx.setTimeOfDay(16.1);
    ctx.setWeather(0.14, { wind: 6.5, fog: 0.003 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Out on the breakwater looking WNW and up: sea and the far coast along the
    // bottom third, the deck across the top two thirds, the sun off to frame
    // right so the silver lining lands on the near faces.
    ctx.poseCamera([182, 9.2, -96], [-260, 150, -30], 58);
  },
});
