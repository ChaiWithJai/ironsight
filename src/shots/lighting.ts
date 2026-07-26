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
    'The market hall from beside its own south-west corner pier, sightline ' +
    '122° off the sun. Proves four cascades with no seam: a pier at 2.5 m opens ' +
    'the frame, the west arcade rakes away from it, and the hall\'s shadow ' +
    'terminator recedes past the 12 m and 38 m splits inside one continuous ' +
    'edge, so a resolution or offset change at a split has nowhere to hide.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x11a7);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 4.0, fog: 0.0012 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Same sightline as round 1, moved 12 m up it. Sightline (0.394, 0.919)
    // against sun (-0.988, -0.156) = 122°, inside LOOK_SPEC §2.3's band, so the
    // hall shows a sun-lit long face and a sky-lit end face in the same frame
    // and its shadow lies across the paving ahead rather than behind the camera.
    //
    // WHY IT MOVED. Round 1 stood 12 m clear of everything: nothing inside 15 m,
    // an empty centre, and no near-field occluder at all, which §7.2 makes a
    // defect regardless of how the shadows read. The station is now 2.5 m off
    // the hall's south-west corner (the hall is 26 × 18 centred on 71, 97, so
    // that corner is at 57.8, 88.3 and its plinth reaches 1.3 m short of the
    // lens): the corner pier is 5.6 m tall and 25° left, so it fills the left
    // edge top to bottom as a dark mass against the lit paving, and the west
    // arcade recedes from it toward the centre — a leading line that terminates
    // on the sunlit facade of the north block at 40 m instead of on nothing.
    //
    // DELIBERATELY NOT A CINEMATIC LENS. Dropping to ≤ 40° would switch on the
    // aperture in `src/render/passes/dof.ts`, and at a 40 m focus that puts 7 px
    // of CoC on the paving at 12 m — exactly the band where the first cascade
    // split has to be judged. A shadow-quality frame has to stay sharp, so this
    // one keeps a gameplay lens and buys its depth from the occluder alone.
    // 50° rather than 55° only so the near pier reads at the size §7.2 wants.
    ctx.poseCamera([55.94, 13.22, 86.63], [79.58, 12.17, 141.78], 50);
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
