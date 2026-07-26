/**
 * LIGHT's shot file. Owned by LIGHT and by nobody else.
 *
 * MUST PROVE: cascade transitions, PCSS contact hardening, GTAO in creases,
 * ambient with real directional variation.
 *
 * THE STAGING WAS WRONG AND THIS IS THE FIX. At 17.4 h the sun sits at 11°
 * elevation on azimuth WNW — direction-to-sun (-0.970, 0.191, -0.154). The
 * previous three cameras all looked 42–48° AWAY from that vector, i.e. nearly
 * into the sun, from inside the market hall's own 51 m umbra. Every square metre
 * of ground in all three frames was shadowed by the same occluder, so there was
 * no lit surface anywhere to read a shadow against and the whole point of the
 * shot file — "is the cast shadow correct?" — could not be answered from it.
 * That is a violation of LOOK_SPEC §2.3 (sun 100–150° off the sightline) and it
 * is why the review said "cast shadows are barely visible".
 *
 * All three cameras below are re-aimed onto sightlines 100–140° off the sun,
 * standing on ground verified sunlit, with the shadow terminator inside the
 * frame. Coordinates are literals: a shot file may not import `@/level/**`, and
 * a shot that silently followed a level edit would stop being a regression test.
 *
 * Frame counts are 28, not 10. The TAA resolve is in the chain now (it was not
 * when this file was first written) and an 8-sample Halton history needs three
 * full cycles to settle; at 10 frames these were the only shots in the repo
 * being graded on an unconverged image.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'light_cascades',
  description:
    'The market hall from the sunlit terrace on its north-west side, sightline ' +
    '122° off the sun. Proves four cascades with no seam: the hall throws its ' +
    'shadow across the paving in the near field and the terminator recedes past ' +
    'the 12 m and 38 m splits inside one continuous edge, so a resolution or ' +
    'offset change at a split has nowhere to hide.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x11a7);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 4.0, fog: 0.0012 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Standing on the open terrace north-west of the hall (ground y = 11.6,
    // verified open to sky and sunlit), looking SSE down the length of the
    // arcade. Sightline (0.394, 0.919) against sun (-0.988, -0.156) = 122°,
    // inside LOOK_SPEC §2.3's band, so the hall shows a sun-lit long face and a
    // sky-lit end face in the same frame and its shadow lies across the near
    // paving rather than behind the camera.
    ctx.poseCamera([50, 13.22, 76], [68, 12.4, 118], 55);
  },
});

registerShot({
  name: 'light_contact',
  description:
    'Close on the foot of the market hall where the plinth, the sand drift and ' +
    'the paving meet, 14 m out and cross-sun. Proves contact-hardening PCSS and ' +
    'the short-radius occlusion term: at the contact line the cast shadow is ' +
    'razor-sharp and carries an AO band darker than the shadow itself, and the ' +
    'same edge softens measurably as the occluder-receiver gap opens up the wall.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x11a8);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 3.5, fog: 0.001 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Everything of interest sits inside cascades 0 and 1, where a texel is
    // 1.5–5 cm and the penumbra is genuinely resolved rather than sitting on the
    // one-texel floor.
    ctx.poseCamera([58, 12.55, 76], [63.5, 12.45, 88], 38);
  },
});

registerShot({
  name: 'light_interior',
  description:
    'Inside the covered market arcade looking out into the sunlit square. ' +
    'Proves sky occlusion and ground bounce: the interior loses SKY light and not ' +
    'only sun light, the vaults and column bases darken toward the back, and the ' +
    'shaded faces are lit warm from the paving below rather than being void-black ' +
    'or a flat grey fill.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x11a9);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 3.0, fog: 0.001 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Under the arcade on the hall's north side, standing eye height, looking
    // out along the colonnade into the lit terrace. The frame carries three
    // bands: the dark interior soffit near, the lit square mid, the town beyond.
    ctx.poseCamera([70, 13.42, 90], [52, 12.7, 78], 60);
  },
});
