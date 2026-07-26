/**
 * AUDIO's shot file. Owned by AUDIO and by nobody else.
 *
 * MUST PROVE: the mixer / occlusion debug overlay rendered in-canvas — audio is
 * the one lane the visual critic loop is structurally blind to, so the proof has
 * to be a readout of the model's real numbers over a real frame.
 *
 * HOW A SHOT FILE REACHES THIS LANE. Boundary CI treats `src/shots/` as its own
 * lane, so this file may not import `@/audio/**`, and `ShotContext` exposes no
 * route to a service. `seed(n)` is the one channel that does reach a lane: the
 * frozen descriptor table calls every `reset<Key>(seed)` with it, and
 * `resetAudio` arms the debug scenario and registers the overlay pass when it
 * sees this exact value. The constant is therefore duplicated here rather than
 * imported, and `AUDIO_DEBUG_SEED` in `src/audio/system.ts` is its definition.
 * ASCII "AUDI".
 */
import { registerShot, type ShotContext } from '@/engine/harness';

const AUDIO_DEBUG_SEED = 0x41554449;

/** Fixed timestep for both shots. `frames * DT` is the scenario time captured. */
const DT = 1 / 30;

/**
 * Looking north-west along the waterfront from above the market terrace. The
 * frame behind the overlay is incidental — what matters is that it is a LIVE
 * frame, so a reviewer can tell the readout is composited over a running engine
 * rather than rendered onto a blank canvas.
 */
function poseOverTown(ctx: ShotContext): void {
  ctx.seed(AUDIO_DEBUG_SEED);
  ctx.setTimeOfDay(17.4);
  ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
  ctx.setOverlays({ viewmodel: false, hud: false });
  ctx.poseCamera([64, 44, -96], [-40, 8, 54], 48);
}

registerShot({
  name: 'audio',
  description:
    'Audio mixer readout at t+5.0s of the scripted firefight: bus meters, the live voice table with ' +
    'distance / air-absorption LPF / occlusion / pan / propagation delay per voice, the seven ' +
    'procedural convolution IRs with measured RT60, the analytic occlusion blockers, and the layered ' +
    'envelope of the last gunshot cue.',
  // 150 frames at 1/30 s lands on the first over-subscribed volley, where all
  // four firing stations, the impacts and the player's own foley are competing
  // for the voice budget — so the STEALS counter is non-zero and the table is
  // full rather than showing a tidy, unrepresentative handful of rows.
  frames: 150,
  dt: DT,
  setup: poseOverTown,
});

registerShot({
  name: 'audio_debug',
  description:
    'Same readout at t+7.87s, 150 ms after an 18 m grenade: the duck bus is pulled 15 dB down and the ' +
    'temporary threshold shift has every unoccluded voice low-passed to 10.7 kHz instead of 18. The ' +
    'listener has walked from the open quay through the stone street into the market courtyard, so the ' +
    'active convolution IR has changed twice. The enemy carbine at 34 m is occluded — 7 dB further down ' +
    'and filtered to 4.0 kHz, audible rather than muted, which is the whole point of the occlusion model.',
  frames: 236,
  dt: DT,
  setup: poseOverTown,
});
