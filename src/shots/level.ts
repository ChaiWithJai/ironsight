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
    // Station: the square's NE corner, a step behind the sandbag wall that
    // `buildSquare` puts at (98.6, 101.9). Sightline 202°, 121° off the light —
    // inside §2.3's window and close to its centre.
    //
    // Why THIS corner. Looking seaward (−Z) is the only direction out of ALPHA
    // with anything behind it: the square, then the terrace lip, then the town
    // rooflines stepping down, then the minaret at 44 m and the harbour cranes
    // in haze through the gap between the two blocks that close the south side.
    // Every other sightline out of the square ends on a facade at 35 m, which is
    // a frame with one depth plane in it.
    //
    // The sun is 59° to the LEFT and 11° up, just outside the left edge at this
    // FOV, so stall fabric rim-lights and every shadow in the square — stalls,
    // crates, the cistern head, the hall — rakes right-to-left ACROSS the paving
    // toward the camera. That is the whole point of the re-stage; the old 36°
    // pose hid every one of those shadows behind its own object.
    //
    // Three depth planes, per §7.2: the sandbag wall at 2.6 m bottom-right and a
    // stall at 5.7 m left are the dark near field; the square, its cistern head
    // and the market hall's east arcade (13–26 m, pure sky light, with the
    // sunlit square showing through the arches) are the mid plane; the town
    // roofline, minaret and cranes at 40–90 m are the far plane.
    //
    // Paving deck is 11.60 (buildSquare sinks the slab 4 cm into the 11.5
    // terrace), so 1.62 m standing eye puts the camera at 13.22.
    ctx.poseCamera([99.5, 13.22, 105.5], [84.5, 12.17, 68.4], 60);
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
    // Out over the water off the quay head. This is the ONLY angle from which
    // the three cranes read as ship-to-shore machines rather than as towers:
    // their 30 m jibs cantilever toward the camera, which is what a gantry
    // crane's silhouette is actually about.
    //
    // Sightline 294°, i.e. 147° off the light: back-lit, at the far end of
    // §2.3's window and deliberately so — BRAVO is the atmosphere hero and the
    // spec asks for its sightlines to run into the sun over the water. Unmoved.
    ctx.poseCamera([58, 9, -66], [-30, 16, -26], 46);
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
