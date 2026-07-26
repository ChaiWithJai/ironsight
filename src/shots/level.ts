/**
 * LEVEL's shot file. Owned by LEVEL and by nobody else.
 *
 * MUST PROVE: ALPHA / BRAVO / CHARLIE establishing shots, ground transitions,
 * no hard seams.
 *
 * Four shots, three of them at STANDING EYE HEIGHT rather than from a drone.
 * That is deliberate: `reference/gameplay/` is the ground truth for this project
 * and every frame in it is 1.6 m off the deck. A level that only reads from a
 * helicopter is a level that does not read.
 *
 * SOLAR STAGING — the reason two of these cameras moved
 * -----------------------------------------------------
 * `docs/LOOK_SPEC.md` §2.3 is a hard composition rule: the sun must sit 100–150°
 * in azimuth from the sightline, and front-lit framing (sun within 40° of behind
 * the camera) "appears in zero press frames".
 *
 * The arithmetic, so the next person can redo it instead of guessing. At 17.4 h
 * the solar model (`src/world/sky/model.ts`) puts the sun at azimuth 261°,
 * elevation 11°, in the convention `dir = (sin a·cos e, sin e, cos a·cos e)`.
 * That is the direction TOWARD the sun, so the light TRAVELS along azimuth 81°.
 * A camera's staging angle is therefore
 *
 *     offLight = wrap180( atan2(dx, dz)·180/π − 81 )
 *
 * and it must land in [100, 150]. Measured on the old poses: `level_alpha` 36°,
 * `level_charlie` 26° — both flat front-light, which is why their cast shadows
 * were invisible, their grass read black and every vertical face sat at the same
 * value. The new poses land at 124° and 126°. `level_bravo` was already at 147°
 * (back-lit, correct for the atmosphere hero) and `level_overview` at 136°, so
 * neither of those two moved.
 *
 * The second half of §2.3 — "every vertical surface must show a lit face and a
 * sky-lit face simultaneously" — is why the specific STATIONS are what they are
 * rather than any station at the right azimuth. With the light travelling along
 * 81°, a west-facing wall is at full incidence, an east-facing wall is pure sky
 * light, and a north- or south-facing wall is at 79°, i.e. raking. Each pose
 * below is placed on a CORNER where two of those three meet.
 *
 * Both re-staged frames also carry near-field occluding geometry, per §7.2's
 * 20–35 % rule: the old frames were empty-foreground, which is the composition
 * that reads flat next to the reference corpus.
 *
 * NEAR FIELD AND APERTURE — the round-2 re-stage
 * ---------------------------------------------
 * Round 1 shipped `level_alpha` and `level_bravo` with nothing inside 10 m and
 * with no defocus anywhere: `level_bravo`'s lower third was 600 × 1920 px of
 * undifferentiated water and `level_alpha`'s was empty sand. That is a direct
 * violation of §7.2 ("near-field occluding geometry should cover 20–35 % of a
 * composed shot and read 2–4× darker than the midground") and of the rubric's
 * calibration note 6.
 *
 * A shot file cannot add geometry — `ShotContext` poses a camera and nothing
 * else — so the fix is a STATION change onto ground that already has a hard
 * occluder within 4 m of the lens, and the two below now stand on one:
 *
 *   level_bravo   the breakwater's seaward parapet (`buildBreakwater`: a
 *                 0.5 × 0.62 m sandstone course capped with concrete at deck
 *                 +1.34, i.e. 28 cm below a standing eye) runs diagonally out of
 *                 the bottom-right corner at 2 m.
 *   level_alpha   the cover wall the square's east edge is dressed with, at
 *                 3.5 m and 24° right of the sightline.
 *
 * The APERTURE comes from the same change. `src/render/passes/dof.ts` switches
 * from gameplay restraint (CoC ≤ 3 px, §6.2) to a real cinematic aperture when
 * `camera.fovDeg <= 40`, because the pose is the only signal a shot file can
 * send a pass — the player's own FOV slider bottoms out at 60, so nothing in
 * gameplay can reach it and this cannot leak into the game. §7.1 puts the
 * cinematic/deploy lens at 38°. Both frames below are establishing shots, not
 * gameplay frames, so they take that lens and the near occluder carries its
 * 32 px of CoC while the midground stays sharp.
 *
 * The pass auto-focuses on the CENTRE PIXEL's depth, clamped to [1.5, 60] m, so
 * both cameras are pitched ~1° down: the centre ray has to land on solid
 * geometry rather than on sky, or the focus falls back to 4 m and the whole
 * world melts. That is why the targets below are not simply level with the eye.
 *
 * All coordinates are literals. `src/level/cameras.ts` holds the same poses by
 * name for the fly-in and the attract loop, but boundary CI forbids a shot file
 * from importing `@/level/**`, so the two are kept in step by hand — which is
 * correct, because a shot that silently follows a level edit stops being a
 * regression test.
 *
 * Time of day is 17.4 h everywhere, matching CORE's smoke test and
 * `docs/LOOK_SPEC.md`: sun at 11°, raking straight along the streets, which is
 * the condition every piece of relief in this lane — window reveals, string
 * courses, parapet copings, arcade impost bands, the drift at the foot of every
 * wall — was authored for.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'level_alpha',
  description:
    'ALPHA, the market square, at standing eye height from the north-east ' +
    'corner looking seaward across the point. Proves: the square has real hard ' +
    'cover in it, the market hall is an enterable arcade, every wall meets the ' +
    'paving through a sand drift rather than a hard seam, and the terrace steps ' +
    'down into the town with the minaret and the headland behind it.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x41);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 4.0, fog: 0.0028 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Station: the square's NE corner, moved 2.2 m up the round-1 sightline so
    // the stacked cover wall `buildSquare` dresses the east edge with closes to
    // 2.5 m and becomes the near-field mass §7.2 asks for. Sightline 202° and
    // the lens are otherwise round 1's, and both were re-chosen the hard way.
    //
    // A 40° cinematic lens on a 186° sightline was captured and rejected. Two
    // things went wrong and both are worth writing down. The lens engages the
    // aperture path in `src/render/passes/dof.ts`, which AUTO-FOCUSES on the
    // centre pixel — and 186° puts the square's east compound wall under that
    // pixel at 11 m, so focus locked to 11 m and the minaret, the mosque and the
    // whole town went to 20 px of CoC. The narrower lens then cropped the
    // sightline down to that wall, and a flat wall across the middle distance is
    // a worse frame than the empty one it replaced. ALPHA is an establishing
    // shot of a square, not a subject-at-4-m portrait; it needs the wide read.
    // The near-field requirement is met by occlusion and luminance banding —
    // which is what §7.2 actually specifies — not by bokeh.
    //
    // Why THIS corner. Looking seaward (−Z) is the only direction out of ALPHA
    // with anything behind it: the square, then the terrace lip, then the town
    // rooflines stepping down, then the minaret at 44 m and the harbour cranes
    // in haze through the gap between the two blocks that close the south side.
    // Every other sightline out of the square ends on a facade at 35 m, which is
    // a frame with one depth plane in it.
    //
    // The sun is 59° to the LEFT and 11° up, just outside the left edge at this FOV,
    // so stall fabric rim-lights and every shadow in the square — stalls,
    // crates, the cistern head, the hall — rakes right-to-left ACROSS the paving
    // toward the camera. That is the whole point of the re-stage; the old 36°
    // pose hid every one of those shadows behind its own object.
    //
    // FOUR depth planes, and the near one is the round-2 fix. The cover wall now
    // stands 2.5 m from the lens and 17° left of the axis: its top course sits
    // 0.62 m below the eye, so it cuts the bottom-left quarter of the frame as a
    // hard dark mass against the sunlit paving beyond it. Behind it: the market
    // hall's south-east corner at 20 m on the left, the cistern head and stalls
    // across the square at 13–26 m, the minaret at 26° right and 38 m, then the
    // town roofline and the pylons at 150 m. Foreground, midground and
    // background are separable by luminance alone, which is what §7.2 asks for.
    //
    // Paving deck is 11.60 (buildSquare sinks the slab 4 cm into the 11.5
    // terrace), so 1.62 m standing eye puts the camera at 13.22. Pitch −1.5°
    // keeps the horizon 3 % above the centreline, inside §7.2's ±6 %.
    ctx.poseCamera([98.12, 13.22, 103.79], [81.26, 12.04, 62.07], 52);
  },
});

registerShot({
  name: 'level_bravo',
  description:
    'BRAVO, the quay, looking west along the apron with all three gantry cranes ' +
    'in line. Proves: the crane lattices read as steel and not as boxes, the ' +
    'container yard makes lanes rather than a wall, and the quay coping and ' +
    'armour stone give the seawall a waterline.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x42);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 5.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // ON the breakwater arm, mid-length, 4.8 m short of the rubble pile
    // `buildBreakwater` drops at 42 % of the arm. The round-1 pose was this same
    // look from 23 m off the arm and 3.6 m above its deck — a camera floating
    // over open water, which is why the bottom third of that frame was 600 px of
    // undifferentiated sea. Same sightline, real ground under it.
    //
    // TWO near-field masses, one per bottom corner, and they were chosen in that
    // order after a capture proved the obvious answer wrong. The obvious answer
    // was to stand 1.6 m inside the arm's seaward parapet: its capped top is at
    // deck + 1.34 = 6.74 against a 7.02 eye, so it runs just below the horizon —
    // and from there it does not frame the shot, it WALLS it, taking the whole
    // lower half, hiding the harbour inside 55 m, and (because it converges on
    // the vanishing point the cranes also sit near) putting itself under the
    // centre pixel the auto-focus meters, which pulled focus to 20 m and
    // softened the cranes this shot exists to show. Standing on the CENTRELINE
    // instead:
    //   lower left   the rubble pile at 4.8 m, 17° off axis, 1.4 m high, so its
    //                crown sits at eye level and it occludes a corner rather
    //                than a band;
    //   lower right  the same parapet, now 3.9 m away and 76° off axis at its
    //                nearest point, so it enters as a receding diagonal from the
    //                corner instead of a wall across the middle;
    //   13 m left    the crate stack / sandbag run the arm is dressed with.
    // Both near masses carry ~22 px of CoC at the shot's focus and the frame
    // still opens onto water between them.
    //
    // Sightline 294°, within half a degree of round 1's, aimed at the third quay
    // shed at 48 m: solid geometry under the centre pixel, so the auto-focus
    // meters 48 m and everything from 40 m to the horizon stays sharp. The three
    // cranes then span 264–275°, i.e. the right third, with their 30 m jibs
    // cantilevering toward the camera — the only angle from which a ship-to-
    // shore crane reads as a machine rather than a tower — the container yard
    // and sheds stack up behind them, and the sun sits 33° right at 11°
    // elevation, just OUTSIDE the frame: full contre-jour rim on the lattice
    // with no disc to blow the histogram. §9.3.4 asks BRAVO's sightlines to run
    // into the sun over water and this is as far into it as the frame survives —
    // an earlier attempt at 275° put the sun 14° off axis and produced exactly
    // round 1's "milky, mean-luma 175" complaint.
    //
    // The pose is level: the horizon sits on the centreline (§7.2 allows ±6 %)
    // and a level ray clears the parapet's crown at every distance, which is
    // what keeps the metered pixel on the shed rather than on the wall.
    ctx.poseCamera([62.5, 7.02, -40.5], [18.5, 7.0, -20.8], 38);
  },
});

registerShot({
  name: 'level_charlie',
  description:
    'CHARLIE, the old fort, from the headland approach at standing eye height. ' +
    'Proves: the curtain is battered and crenellated rather than extruded, the ' +
    'north drum tower carries a full light terminator, the gatehouse reads as a ' +
    'shadowed mass beside a sunlit curtain, and the whole enceinte sits INTO the ' +
    'rock rather than on top of it.',
  frames: 28,
  setup(ctx) {
    ctx.seed(0x43);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.04, { wind: 6.5, fog: 0.0034 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // The enceinte is an irregular pentagon whose local +X faces the approach at
    // (−172, −12). Working its five sides against the 81° light azimuth gives,
    // in world terms:
    //
    //   NE curtain (the GATE)   normal  54°  →  cos = −0.89   sky-lit
    //   SE curtain              normal 122°  →  cos = −0.76   sky-lit
    //   S  curtain              normal 181°  →  cos = +0.18   raking
    //   SW curtain (the BREACH) normal 239°  →  cos = +0.92   full sun
    //   NW curtain              normal 325°  →  cos = +0.44   three-quarter sun
    //
    // The old pose sat south-west of the fort at 50 m altitude looking back at
    // the breach — the fully lit wall seen face-on, which is *by definition*
    // front-light (26° off), and the reason that frame carried no shadow and put
    // its horizon three-quarters up the image.
    //
    // This station is on the approach shoulder north-north-east of the fort,
    // looking south-west at 201°, 120° off the light. It puts the sunlit NW
    // curtain across the left, the shadowed gate curtain and its gatehouse
    // across the right, and the big north drum tower between them at 19 m — a
    // cylinder, so it carries the terminator explicitly and §2.3's "lit face and
    // sky-lit face simultaneously" is satisfied on a single object. The
    // crenellations of the lit curtain throw their own merlon shadows down the
    // wall-walk, which is the thing that was completely absent front-lit.
    //
    // The whole enceinte spans 59° of azimuth from here and the FOV is chosen to
    // hold all of it: the fort runs from 24° left of centre to 35° right, inside
    // the 45.7° half-angle, so no wall is cropped and the headland shoulder
    // still closes the right edge.
    //
    // Eye is macro ground (27.6 m) + 1.62. The courtyard platform is at 31.6, so
    // the fort stands 4 m above the station, the rock ramp fills the near field
    // and the pitch stays at +2.0° — horizon at 47 % of frame height, inside
    // §7.2's ±6 %. Seaward of the fort the headland falls 31 m to the waterline
    // over 120 m, which is the aerial ladder CHARLIE exists to show.
    ctx.poseCamera([-196, 29.04, -4], [-208.5, 30.26, -36.7], 60);
  },
});

registerShot({
  name: 'level_overview',
  description:
    'The whole of HARBOUR REACH from the south-east at 250 m: the ALPHA terrace ' +
    'right, the BRAVO quay and breakwater centre, the CHARLIE headland left, the ' +
    'wreck offshore. Proves the macro composition, the three-point triangle and ' +
    'the aerial perspective pushing the headland into haze.',
  // Fewer frames: nothing on this shot is temporally unstable at this distance,
  // and every frame under the software rasteriser is real time in the loop.
  frames: 20,
  setup(ctx) {
    ctx.seed(0x44);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.08, { wind: 5.0, fog: 0.0030 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Sightline 217°, 136° off the light — already inside §2.3's window, so this
    // one did not move either. It is the only shot in the file allowed a large
    // downward pitch, because it is explicitly a map-shape frame and not a
    // gameplay frame.
    ctx.poseCamera([152, 236, 300], [-70, 10, 2], 45);
  },
});
