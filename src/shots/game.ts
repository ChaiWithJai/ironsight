/**
 * GAME's shot file. Owned by GAME and by nobody else.
 *
 * MUST PROVE: a contested capture in progress — capture bar, tickets bleeding,
 * killfeed live — plus the three locomotion moves that are invisible in a still
 * frame unless the lane draws its own numbers over them.
 *
 * HOW THESE SHOTS DRIVE THE WORLD. `ShotContext` has no route to a service and
 * the reset chain suppresses live input for the whole capture, so the only lever
 * a shot file has on this lane is `setPlayerState(name)` → `PlayerService.
 * setForcedState`. GAME reads that string as a scenario id and stages the run
 * itself (`src/game/scenario.ts`): it teleports the local player onto the BRAVO
 * quay, primes its velocity, builds whatever obstacle the move needs and scripts
 * the intent stream from there. Everything is keyed to the TICK counter, so
 * `frames` below is not a "long enough" guess — it is the exact simulation
 * moment each capture lands on.
 *
 * NONE OF THE LOCOMOTION SHOTS POSE THE CAMERA, and that is deliberate: they are
 * first-person by definition. The reset chain releases the pose lock, so the
 * `CameraRig` follows the player's own eye — which is the thing under test.
 */
import { registerShot } from '@/engine/harness';

/** Golden hour, light haze — the project's house lighting, so shots compare. */
function light(ctx: {
  setTimeOfDay(h: number): void;
  setWeather(o: number, opts?: { wind?: number; fog?: number }): void;
}): void {
  ctx.setTimeOfDay(17.4);
  ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
}

registerShot({
  name: 'game_sprint',
  description:
    'Sprint from a standing start on the BRAVO quay, captured at t+1.00 s — past the ' +
    'TACTICAL_SPRINT_DELAY, so the readout is in TAC-SPRINT with stamina already draining. ' +
    'Proves the accel curve, the stance/speed coupling and the sub-centimetre step bob.',
  // 60 ticks = 1.00 s. Tactical sprint engages at 0.85 s, so this lands 0.15 s
  // inside the state it is meant to show rather than on its edge.
  frames: 60,
  setup(ctx) {
    ctx.seed(0x6a11);
    light(ctx);
    ctx.setOverlays({ viewmodel: false, hud: false });
    ctx.setPlayerState('sprint');
  },
});

registerShot({
  name: 'game_slide',
  description:
    'Slide, captured 0.5 s in: eye dropped by the crouch capsule plus VIEW.slideDrop, ' +
    'view rolled into the slide, speed still above the sprint that fed it. Proves the entry ' +
    'boost, the friction bleed and that the camera is a passenger.',
  // Crouch edge at tick 6, capture at tick 36 → 0.5 s of slide, comfortably
  // before SLIDE_MAX_TIME and above SLIDE_EXIT_SPEED.
  frames: 36,
  setup(ctx) {
    ctx.seed(0x6a12);
    light(ctx);
    ctx.setOverlays({ viewmodel: false, hud: false });
    ctx.setPlayerState('slide');
  },
});

registerShot({
  name: 'game_vault',
  description:
    'Mid-vault over a 0.9 m parapet, captured on the arc. Proves the four-ray ledge probe ' +
    'classified it as a vault rather than a mantle, that root motion is carrying the capsule ' +
    'over the obstacle, and that momentum is kept through the exit.',
  // Primed at 6.6 m/s, 4.2 m out; the traversal commits around tick 29 and runs
  // 25 ticks. 31 catches it two ticks in — MODE is already VAULT and the
  // parapet is still in front of the eye rather than under it, which is the only
  // moment in a first-person vault where the obstacle is visible at all.
  frames: 31,
  setup(ctx) {
    ctx.seed(0x6a13);
    light(ctx);
    ctx.setOverlays({ viewmodel: false, hud: false });
    ctx.setPlayerState('vault');
  },
});

registerShot({
  name: 'game_capture_contested',
  description:
    'ALPHA contested: three Coalition and two Insurgents inside the disc, the capture bar ' +
    'frozen at +0.42, Coalition holding BRAVO and CHARLIE so the Insurgent tickets are ' +
    'bleeding, and two kills already on the feed. Occupancy is COUNTED from the bodies in ' +
    'the square, not pasted into the runtime struct.',
  frames: 32,
  setup(ctx) {
    ctx.seed(0x6a14);
    light(ctx);
    ctx.setOverlays({ viewmodel: false, hud: false });
    ctx.setPlayerState('assault');
    // The one shot here that DOES pose the camera: the subject is the square and
    // the five bodies on it, which a first-person eye at 1.62 m cannot frame.
    // ALPHA is the market-square plateau at (78, 96), paving at y = 11.5. The
    // camera stands INSIDE the paved square (x 54..102, z 74..118) rather than
    // outside it — every position beyond that rectangle has a building in it,
    // and the shot becomes a photograph of a roof.
    ctx.poseCamera([97, 18.5, 116], [76, 12.0, 106], 56);
  },
});
