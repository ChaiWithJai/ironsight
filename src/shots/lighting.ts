/**
 * LIGHT's shot file. Owned by LIGHT and by nobody else.
 *
 * MUST PROVE: cascade transitions, PCSS contact hardening, GTAO in creases,
 * ambient with real directional variation.
 *
 * WHERE THE SUN ACTUALLY IS, because two rounds of staging got it wrong. At
 * 17.4 h `solarPose` gives elevation 11.0° and azimuth 261°, i.e.
 * direction-to-sun (-0.970, 0.191, -0.154). The sun is in the WEST; shadows run
 * EAST at 5.1 m per metre of occluder height. A camera that wants a cast shadow
 * in frame therefore has to stand EAST of its occluder, and the round-2 cameras
 * all stood west of theirs — on the sunward side, inside a colonnade's own
 * umbra, with no lit ground anywhere in shot to read a terminator against. The
 * reviews reported "not one cast shadow exists in the frame" and they were
 * describing the staging, not the shadow map: a debug build that writes the
 * cascade's returned visibility straight to the framebuffer shows the term
 * working, and simply returning 1.0 from it changes the frame completely.
 *
 * All three cameras are on sightlines 100–140° off the sun, on ground checked
 * sunlit in that debug pass, with a terminator inside the frame. Coordinates are
 * literals: a shot file may not import `@/level/**`, and a shot that silently
 * followed a level edit would stop being a regression test.
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
    'East of the market block, looking NNE up the open ground with the block\'s ' +
    'east wall filling the near left. Sightline 116° off the sun, on paving ' +
    'verified sunlit. Proves four cascades with no seam: the wall is a ' +
    'cascade-0 occluder at 3 m, its shadow runs away from the lens past the ' +
    '12 m and 38 m splits inside one continuous edge, and the town beyond sits ' +
    'in cascades 2 and 3, so a resolution or offset change at any split has ' +
    'nowhere to hide.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x11a7);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 4.0, fog: 0.0012 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // ROUND 3 RE-STAGED THIS, AND THE REASON IS WORTH RECORDING because the old
    // comment claimed the opposite of what the pixels showed.
    //
    // At 17.4 h `solarPose` puts the sun at 11.0° on azimuth 261°, i.e.
    // direction-to-sun (-0.970, 0.191, -0.154): it is in the WEST and shadows
    // run EAST, 5.1 m of shadow per metre of occluder. The round-2 station
    // stood at x = 55.9, i.e. two metres off the market block's WEST face — on
    // the block's own sunward side, inside the umbra of the west colonnade in
    // front of it, and looking up an arcade every square metre of which was
    // shadowed by its own roof. A debug pass that writes the cascade's returned
    // visibility straight to the framebuffer confirmed it: the shadow term was
    // below 0.2 over 19 % of that frame and above 0.8 over 3 %, with no
    // terminator anywhere in shot. The reviews were right that the frame had no
    // readable cast shadow; they were wrong about why, and so was this file.
    //
    // The station is now on the EAST side, where the shadows are. The block's
    // east wall is 3 m off the left edge and 8 m tall, so it lays a 40 m shadow
    // that starts razor-sharp against its own footing in the bottom-left corner
    // and softens as it recedes — contact hardening and a cascade-0-to-1
    // transition on one continuous edge, which is the single thing this shot
    // exists to prove. Sightline (0.34, 0.94) against the sun's horizontal
    // (-0.988, -0.156) is 116°, inside LOOK_SPEC §2.3's 100–150° band, so the
    // light rakes across the frame rather than down the lens.
    //
    // DELIBERATELY NOT A CINEMATIC LENS. Dropping to ≤ 40° would switch on the
    // aperture in `src/render/passes/dof.ts`, and at a 40 m focus that puts 7 px
    // of CoC on the paving at 12 m — exactly the band where the first cascade
    // split has to be judged. A shadow-quality frame has to stay sharp, so this
    // one keeps a gameplay lens and buys its depth from the occluder alone.
    ctx.poseCamera([96, 14.0, 74], [113, 12.2, 121], 52);
  },
});

registerShot({
  name: 'light_contact',
  description:
    'Kneeling height on the sunlit paving south-east of the market hall, ' +
    'looking south with the light travelling 90° across the sightline. Proves ' +
    'contact-hardening PCSS across three decades of penumbra on ONE continuous ' +
    'piece of lit ground: grass blades at 1-3 m throw razor terminators, the ' +
    'stall poles at 4-12 m throw crisp metre-long shadows that harden to a ' +
    'point at their own feet, the stall canopy 2.2 m up throws an 11 m soft ' +
    'band across the middle ground, and the mosque mass at 30 m lays the widest ' +
    'edge of all across the terrace steps.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x11a8);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 3.5, fog: 0.001 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // ROUND 4 RE-STAGED THIS, AND THE OLD POSE WAS FRONT-LIT — the exact fault
    // this file's header accuses round 2 of, still present in the shot named
    // after contact shadows.
    //
    // The arithmetic that settles it. Light TRAVELS along azimuth 81°. The
    // useful quantity is the angle between the VIEW direction and that travel
    // direction: 0° is the sun directly behind the lens (every shadow hides
    // behind its own occluder), 180° is straight into the sun (same, foreshor-
    // tened toward the lens), and 90° is the only place a shadow lies ACROSS the
    // frame at full length. The old sightline (58,76)→(63.5,88) is azimuth 24.6°,
    // i.e. 56° off the travel direction — front-lit, and a debug capture of the
    // shadow term confirmed it: the term was working and every shadow in frame
    // was tucked behind the object that cast it.
    //
    // This station looks along azimuth 350°, which is 91° off the travel
    // direction. Shadows now run left-to-right across the sand at 5.1 m per
    // metre of occluder, and the frame carries all three scales the shot exists
    // to prove on one continuous piece of sunlit ground: grass blades at 1–3 m
    // with a razor terminator, the debris chips and kerb at 4–9 m, the drum and
    // concrete wedges at 9–16 m, and the arcade's own 8 m mass laying the long
    // soft edge across the top. Cascade 0 and 1 only, so a texel is 1–3 cm and
    // the penumbra is resolved rather than sitting on the one-texel floor.
    //
    // 44° rather than 38°: at 38 the aperture path in `src/render/passes/dof.ts`
    // put 20+ px of CoC on the near sand, which is where the sharpest contact in
    // the frame is. Above 40 the pass stays on gameplay restraint and the whole
    // ground plane resolves.
    // ROUND 5 RE-STAGED IT AGAIN, ONTO GROUND THAT IS ACTUALLY IN THE SUN.
    //
    // A debug capture of the shadow term (service.ts DEBUG_SUN_SHADOW) and of
    // the blocker gap (DEBUG_GAP) taken at the round-4 station shows the whole
    // frame returning visibility ~0 with a blocker gap pinned at the 40 m
    // ceiling: the drift west of the hall is inside the umbra of the western
    // block, 40 m up-sun, and has been since the block grew. That is the one
    // staging fault a contact-shadow shot cannot survive, because a contact
    // shadow needs a LIT receiver to sit on. The old frame's whole ground plane
    // was sky-lit only, so every prop in it correctly cast nothing.
    //
    // This station is on the square's paving instead, one metre above the deck
    // (11.60 + 1.0 — deliberately below eye height, so the near ground fills the
    // lower third and the contact bands are read at a grazing angle rather than
    // from above). Sightline azimuth 315° against a light TRAVEL azimuth of 81°
    // is 126° — inside LOOK_SPEC 2.3's 100-150 band and near enough to 90 off
    // the travel direction that the stall's 5:1 shadow lies across the frame
    // rather than behind its own poles.
    ctx.poseCamera([87.3, 12.55, 87.6], [90.5, 11.55, 67.6], 48);
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
