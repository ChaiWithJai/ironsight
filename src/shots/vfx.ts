/**
 * VFX's shot file. Owned by VFX and by nobody else.
 *
 * MUST PROVE: surface-keyed impacts, smoke plume, explosion, decal accumulation,
 * muzzle flash, and the ambient participating media that stops the air being
 * empty.
 *
 * FRAMING. Every camera here obeys LOOK_SPEC §2.3 and §7.2: the sun sits well
 * off the sightline so every vertical face shows a lit side AND a sky-lit side,
 * the horizon stays near the centreline, and each frame resolves into three
 * separated luminance bands — a dark near-field occluder, a mid-value action
 * plane, a bright atmospheric far plane. At 17:24 the sun bears roughly 261°
 * (WNW, out over the sea), so a sightline running south-west across the market
 * square is cross-sun, which is the framing that makes smoke read as a lit
 * volume rather than as a grey shape. `vfx_ambient_dust` is the deliberate
 * exception: it looks straight into the sun, because forward-scattering haze is
 * the property that shot exists to test.
 *
 * The scenes are driven through a lane-private export rather than through
 * `ShotContext`, which exposes only setTimeOfDay / setWeather / poseCamera /
 * setOverlays / setPlayerState / seed. That is the same route WEAPONS, AI, HUD
 * and GAME use for their own shots.
 */
import { registerShot, type ShotContext } from '@/engine/harness';
import { armVfxScene } from '@/vfx/scenes';

/** The golden-hour anchor every lane's shots share. */
const HOUR = 17.4;

function scene(
  ctx: ShotContext,
  eye: [number, number, number],
  look: [number, number, number],
  fov = 68,
  viewmodel = false,
): void {
  ctx.seed(0x1205);
  ctx.setTimeOfDay(HOUR);
  ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
  ctx.setOverlays({ viewmodel, hud: false });
  ctx.poseCamera(eye, look, fov);
}

registerShot({
  name: 'vfx_muzzle_flash',
  description:
    'A rifle muzzle flash caught one frame after the break: near-white over-range core with 2–4 ' +
    'asymmetric petals, the propellant puff that outlives it by 20×, weapon smoke from the three ' +
    'preceding rounds still hanging, and the flash registered as a 60 000 cd / 15 m emitter that ' +
    'its own smoke shades against.',
  // 20 frames. The flash itself is 32 ms — TWO frames — so the scene fires the
  // last round at t = 0.300 s and the grab lands 17 ms later: any later and the
  // only thing left is the puff, which is correct behaviour and a bad shot.
  frames: 20,
  setup(ctx) {
    // Viewmodel ON: the flash belongs to the weapon, and this is the frame
    // `weapon_recoil_midburst` is missing. Sightline runs south-west across the
    // square — cross-sun, so the weapon shows a lit and a sky-lit face at once.
    scene(ctx, [96, 13.2, 118], [46, 12.6, 80], 62, true);
    ctx.setPlayerState('firing');
    armVfxScene('muzzle');
  },
});

registerShot({
  name: 'vfx_explosion',
  description:
    'A 40 mm-class fireball 83 ms after detonation: 7–13 primary lobes with sub-lobes at half ' +
    'scale, internal dark soot filaments against over-range cores, a ground-hugging pressure ring, ' +
    'real geometry debris in flight, embers, and a second, older burst behind it whose soot column ' +
    'has already separated and risen.',
  frames: 26,
  setup(ctx) {
    scene(ctx, [100, 13.6, 120], [46, 15.4, 76], 64);
    armVfxScene('explosion');
  },
});

registerShot({
  name: 'vfx_impacts',
  description:
    'Surface-keyed impacts walked across the market wall: each burst tinted with the albedo of the ' +
    'surface the ray actually hit, sparks scaled by its hardness, real chunks bouncing off the ' +
    'ground, and 44 accumulated bullet decals with noise-broken outlines and spalled rings.',
  frames: 24,
  setup(ctx) {
    scene(ctx, [93, 13.0, 113], [58, 12.4, 86], 52);
    armVfxScene('impacts');
  },
});

registerShot({
  name: 'vfx_ambient_dust',
  description:
    'The air, on its own. Marine haze bodies, sea spray off the harbour and backlit near-ground ' +
    'motes with no combat VFX in frame — the calibration-note-#1 test that no part of the frame is ' +
    'clear air — plus two smoke columns at 70 m and 260 m for the aerial-perspective ladder.',
  frames: 22,
  setup(ctx) {
    // Raised above the market roofline on the ALPHA terrace, looking WSW across
    // the whole town toward the harbour, the sea and the CHARLIE headland at
    // 300 m — the deepest aerial-perspective ladder the map has, and the only
    // sightline that is not blocked by the market hall. Backlit, because
    // forward scattering is the property this shot exists to test.
    scene(ctx, [110, 22.5, 126], [-140, 12, -34], 60);
    armVfxScene('ambient');
  },
});
