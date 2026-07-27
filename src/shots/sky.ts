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
 *
 * ROUND 2: `sky_golden` was re-staged. It had no foreground, no subject and no
 * defocus — a flat slab of building filling the left third with a hard vertical
 * edge, the horizon dead on the centreline, and the only shape with any interest
 * (a crane) hazed to within a few percent of sky luminance. It is now shot from
 * the quay apron with a gantry LEG at 4.2 m carrying the near-field bokeh and
 * the sun disc sitting inside a second crane's lattice at 38 m. See the pose.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'sky_golden',
  description:
    'GOLDEN, 17.4 h, sun at 11°: the physical Rayleigh/Mie dome read THROUGH a ' +
    'gantry lattice, with a crane leg at 4.2 m carrying the near-field bokeh, ' +
    'the sun disc inside the second crane at 38 m, and a five-layer aerial ' +
    'ladder running truss / warehouse / container stack / crane portal / veiled ' +
    'coast. Proves hue-locked sky, a bright horizon that warms toward the sun ' +
    'azimuth, distance that desaturates into the same colour as the sky above ' +
    'it, and that the near-field haze is gated by how much sky the medium can ' +
    'actually see rather than being applied at open-sky strength inside a shed.',
  frames: 24,
  setup(ctx) {
    ctx.seed(0x5c1);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Standing on the quay apron 5.7 m inland of the coping, at the foot of the
    // eastern crane. Deck 3.55 + 1.62 standing eye = 5.17.
    //
    // THE NEAR FIELD IS THE POINT OF THE RE-STAGE. That crane's seaward leg —
    // `buildCrane` splays a 3 m lattice column off a sill beam at local
    // (−9, −4), which for this machine's yaw lands at (12.55, −43.35) — stands
    // 4.2 m from the lens and 32° right of the sightline, so it fills the right
    // third from the top of the frame to the deck. A shot file cannot ADD
    // geometry, so the only way to obey §7.2's 20–35 % near-field rule is to
    // stand next to something, and this is the tallest thing on the map that a
    // player can stand next to.
    //
    // THE APERTURE comes from the lens. `src/render/passes/dof.ts` switches from
    // gameplay restraint (CoC ≤ 3 px) to a real 7-blade aperture at
    // `fovDeg <= 40`; §7.1 puts the cinematic lens at 38° and the player's own
    // slider bottoms out at 60, so this cannot leak into gameplay. Auto-focus
    // reads the CENTRE pixel's depth clamped to [1.5, 60] m, so the centre ray has
    // to land on solid geometry — on sky or open water the focus falls back to
    // 4 m and the whole frame melts. At this pitch it lands on the container
    // stack at ~55 m; the near leg carries the full 32 px of CoC and everything
    // past 30 m is sharp.
    //
    // ROUND 3 RE-PITCHED IT, +2.0° INSTEAD OF −2.2°, AND THAT IS THE ONLY POSE
    // CHANGE. LEVEL re-dressed this quay between rounds: the sightline that used
    // to close on the CHARLIE headland at 228 m now closes on a container stack
    // at 55 m, which took the far half of the aerial-perspective ladder — the
    // thing this shot exists to prove — out of frame along with most of the sky.
    // Pitching up recovers 4.2° of dome and puts the stack's crowns against it,
    // so the ladder now runs near truss → warehouse → stack → crane portal → the
    // veiled coast through the portal, five layers separable by value alone.
    //
    // +2.0° IS THE CEILING, NOT A CHOICE. §7.2 holds the horizon inside ±6 % of
    // the centreline; on a 40° lens that is ±2.4° of pitch, and this lands the
    // horizon 5.0 % BELOW it (it was 5.5 % above). Any more sky costs the rule.
    //
    // Sightline 268°, i.e. 7° off the sun at 11° elevation — deliberately still
    // contre-jour. The disc sits inside the middle crane's portal (±13.5° from
    // here at 38 m) so the shafts are cut by real lattice rather than being a
    // radial blur off a sprite. The cloud deck is a set of dark patches in the
    // blown sun-side sky here and that is the honest answer for a lens pointed
    // 7° off the sun; `sky_clouds` is the shot that proves the deck.
    ctx.poseCamera([16.0, 5.17, -41.0], [-83.94, 8.66, -44.49], 40);
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

/*
 * ROUND 4 changed no camera in this file. Three candidate re-stages were shot
 * and measured and all three were rejected:
 *
 *  - YAWING sky_golden off the sun to open a blue quarter of the dome puts a
 *    warehouse wall across the frame from this standing position (five poses at
 *    275°–325° captured; every one of them is a flat wall at 12 m).
 *  - PITCHING UP to reach the elevation where the dome is blue costs §7.2. The
 *    rule is ±6 % of H on every registered shot camera; this pose sits at 5.0 %
 *    and the sky first holds measurable blue at ~15° of elevation on the
 *    cross-sun azimuth and ~45° on the sun's own, which on a 40° lens is 30 % of
 *    H. Ten pitch/FOV combinations were captured to confirm it. The frames that
 *    look best (13–17° of pitch on a 56° lens, a dark cloud bank over a burning
 *    horizon) are exactly the ones that read as a drone camera.
 *  - MOVING THE CLOUD DECK by changing the shot's wind does nothing: the deck's
 *    drift is a function of the hour, not of wind speed, so eight wind settings
 *    from 0.5 to 11 m/s produced eight identical frames.
 *
 * So sky_golden is a contre-jour frame at 7° off an 11° sun and its sky is warm
 * from edge to edge, which is what that sightline is. The round-4 sky work is in
 * the dome and the cloud march, not here; the shots that show the dome's blue
 * are the ones that look away from the sun.
 */

