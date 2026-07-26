/**
 * WEAPONS's shot file. Owned by WEAPONS and by nobody else.
 *
 * MUST PROVE: hip / ADS / mid-burst / reload viewmodel poses, muzzle flash lighting the world.
 *
 * FRAMING. All four are calibrated against `reference/gameplay/bf6_gp_004.jpg`:
 * the weapon enters from the LOWER RIGHT, the optic sits right of and below
 * centre, the muzzle is angled UP and INBOARD toward the centreline, the support
 * hand is visible on the handguard and the stock leaves the frame at the
 * bottom-right corner. That is not a stylistic choice — it is what a
 * right-handed shooter's weapon looks like from their own eye.
 *
 * The exact numbers live in `AdsDef.hipOffset` / `hipRotation` in `defs/`, and
 * they are SOLVED for that layout rather than dialled in: at the viewmodel
 * camera's fixed 55° vertical FOV the AR's optic lands at 66% across and 66%
 * down, its muzzle at (53%, 60%). The reference frame is slightly more centred
 * still, but BF6's viewmodel FOV is wider than ours, and a narrower FOV
 * magnifies everything away from the centre — matching its screen position
 * exactly would mean holding the weapon somewhere no arm goes. If these shots
 * do not match that layout, the DATA is wrong, not the camera.
 *
 * The camera is posed at eye height on the ALPHA terrace looking north-west
 * across the market square, so the weapon sits against mid-value sunlit
 * sandstone rather than against the sky — a viewmodel silhouetted on a bright
 * sky reads as a cut-out and tells a critic nothing about its shading.
 *
 * Every shot drives the REAL state machine through `forceWeaponState`: the
 * trigger, the ADS blend and the reload clock are the ones the game uses, so
 * what these PNGs show is what the game does, not a hand-posed mock-up.
 */
import { registerShot, type ShotContext } from '@/engine/harness';
import { forceWeaponState } from '@/weapons/system';

/** Eye on the ALPHA terrace (MACRO_ANCHORS.alpha is 78, 96 at 11.5 m). */
const EYE: [number, number, number] = [96, 13.2, 118];
/** North-west across the square, into the low sun, level with the horizon. */
const LOOK: [number, number, number] = [26, 13.6, 64];
/** 68° vertical is `CameraRig.setBaseFov`; the shots match it so they are comparable. */
const FOV = 68;
const HOUR = 17.4;

/** Warm, still, a little haze — the same air every other lane's shot is in. */
function scene(ctx: ShotContext, fovDeg = FOV): void {
  ctx.seed(0x1205);
  ctx.setTimeOfDay(HOUR);
  ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
  // HUD off in all four: this packet is about the weapon, and a reticle over
  // the optic is the one thing that makes an ADS frame impossible to judge.
  ctx.setOverlays({ viewmodel: true, hud: false });
  ctx.poseCamera(EYE, LOOK, fovDeg);
}

registerShot({
  name: 'weapon_hipfire',
  description:
    'Hip-ready viewmodel: the service rifle at rest in the lower-right third, canted inboard, ' +
    'both hands on the weapon. The baseline every other weapon shot is a departure from.',
  frames: 30,
  setup(ctx) {
    scene(ctx);
    forceWeaponState({ weapon: 'ar_service', ads: false, trigger: false, adsSettled: true });
  },
});

registerShot({
  name: 'weapon_ads',
  description:
    'Aimed: the optic on the camera axis with the reticle dead centre, hands drawn in, ' +
    'the ADS transition fully settled after its eased 195 ms curve.',
  frames: 30,
  setup(ctx) {
    // 53° = the 68° base FOV × `AdsDef.fovMultiplier` (0.78, `defs/ar-service.ts`).
    // The harness pose lock bypasses `CameraRig`'s own ADS blend, so the shot has
    // to state the settled value the rig is publishing in
    // `WeaponFeelState.fovMultiplier`. The VIEWMODEL camera is deliberately not
    // zoomed — it keeps its own 55°, which is why the weapon stays the same size
    // while the world behind it tightens. That separation is the whole reason a
    // shipped shooter's iron sights do not balloon when you aim.
    scene(ctx, 53);
    // `adsSettled` skips the transition on the SIM side; the rig still runs its
    // own render-rate curve, and 30 frames at 1/60 is 500 ms — comfortably past
    // the 195 ms it takes to arrive, so this frame is the settled pose.
    forceWeaponState({ weapon: 'ar_service', ads: true, adsSettled: true, trigger: false });
  },
});

registerShot({
  name: 'weapon_recoil_midburst',
  description:
    'Mid-burst: trigger held on a full-auto rifle, so the frame lands one tick after the sixth ' +
    'round with the receiver driven back into the shoulder, the muzzle climbing and the bolt ' +
    'to the rear. (The flash CARD is VFX and the flash LIGHT is LIGHT; neither has landed yet.)',
  // 27, not 30. At 720 rpm the rounds leave 5 ticks apart starting on the first
  // tick of the capture, so 27 frames puts the grab exactly ONE tick after the
  // sixth shot: the kick springs are at their peak, the bolt carrier is 95% of
  // the way to the rear, and the trigger has broken. Land it 4 ticks later and
  // every one of those has already returned and the frame reads as idle.
  frames: 27,
  setup(ctx) {
    scene(ctx);
    // The trigger is simply HELD — the real fire-control system runs, the real
    // recoil pattern advances and the real springs load. None of that can be
    // faked by posing, which is the point of driving the actual machine.
    forceWeaponState({ weapon: 'ar_service', ads: false, trigger: true, adsSettled: true });
  },
});

registerShot({
  name: 'weapon_reload',
  description:
    'Empty reload at 26% — the magazine in free fall with 7 cm of daylight under the magwell, ' +
    'the weapon lifted and rolled toward the shooter, the support hand already off the handguard.',
  frames: 30,
  setup(ctx) {
    scene(ctx);
    // 0.26, not the mid-point of the drop: the magazine is 17.5 cm long and
    // 30 cm from the eye, so by the time it is fully clear its lower half is
    // already past the bottom edge of the frame. A quarter of the way in it is
    // unambiguously out of the weapon and still readable as a magazine.
    //
    // `framesAhead` lands that phase on the frame the harness actually GRABS,
    // not on the frame it set the state up — without it the 30-frame warm-up
    // carries the reload 17% further along than asked for.
    forceWeaponState({
      weapon: 'ar_service',
      reloadPhase: 0.26,
      reloadEmpty: true,
      framesAhead: 30,
      ads: false,
      trigger: false,
    });
  },
});
