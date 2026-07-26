/**
 * LIGHT's shot file. Owned by LIGHT and by nobody else.
 *
 * MUST PROVE: cascade transitions, PCSS contact hardening, GTAO in creases,
 * ambient with real directional variation.
 *
 * All three cameras are at standing eye height (LOOK_SPEC §7.2: 1.62 m, horizon
 * within ±6 % of the centreline) and all three are staged CROSS-SUN, because a
 * front-lit frame flattens every vertical face and there is then nothing for a
 * shadow or an ambient term to be judged against. Coordinates are literals: a
 * shot file may not import `@/level/**`, and a shot that silently followed a
 * level edit would stop being a regression test.
 *
 * Time of day is 17.4 h throughout, the golden-hour anchor the whole look spec
 * is calibrated to — sun at ~10°, shadows ~5× occluder height.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'light_cascades',
  description:
    'Down the length of the ALPHA market terrace, so the shadow of the hall runs ' +
    'from under the camera out past 40 m. Proves four cascades with no seam: the ' +
    'shadow crosses the 12 m and 38 m splits mid-length and must not change ' +
    'sharpness, offset or resolution where it does.',
  // No TAA in the chain yet, so extra frames buy nothing except cascade cadence:
  // [1,1,2,4] means cascade 3 has refreshed twice by frame 8.
  frames: 10,
  setup(ctx) {
    ctx.seed(0x11a7);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 4.0, fog: 0.0008 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // North-east of the market hall on the flat terrace (y = 11.5), looking
    // SSW across the square. The sun is WNW, so this is 107° off the sightline —
    // inside LOOK_SPEC §2.3's 100–150° band — which puts the hall's LIT north
    // face and its SKY-LIT east face in the same frame and throws the hall's own
    // shadow south-east, across the paving between the camera and the building.
    // That shadow runs from roughly 8 m to 45 m, so it crosses the 12 m and 38 m
    // cascade splits inside one continuous edge and a seam has nowhere to hide.
    ctx.poseCamera([92, 13.12, 120], [70, 12.2, 86], 56);
  },
});

registerShot({
  name: 'light_contact',
  description:
    'Close on the crates and cover at the foot of the market hall. Proves ' +
    'contact-hardening PCSS and the short-radius occlusion term: where a crate ' +
    'touches the paving the shadow is razor-sharp and carries an AO band darker ' +
    'than the cast shadow itself, and the same shadow softens measurably along ' +
    'its length as the occluder-receiver gap opens.',
  frames: 10,
  setup(ctx) {
    ctx.seed(0x11a8);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 3.5, fog: 0.0007 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // The hall's south-east corner from 18 m, cross-sun. Everything of interest
    // sits inside cascades 0 and 1, where a texel is 1.8–6 cm and the penumbra is
    // genuinely resolved rather than being the minimum-width floor.
    ctx.poseCamera([93, 12.95, 97], [80, 12.05, 84], 42);
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
  frames: 10,
  setup(ctx) {
    ctx.seed(0x11a9);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 3.0, fog: 0.0007 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Under the arcade on the hall's south side, standing eye height, looking
    // out north-west through the arches. The frame carries three bands: the dark
    // interior soffit near, the lit square mid, the terrace beyond.
    ctx.poseCamera([78, 13.62, 101], [58, 12.8, 92], 60);
  },
});
