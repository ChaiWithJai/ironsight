/**
 * AI's shot. Owned by AI and by nobody else.
 *
 * MUST PROVE: a bot squad advancing and using cover, path debug, soldier
 * silhouette at 3 LODs.
 *
 * `ShotContext` has no route to a service — it exposes only `setTimeOfDay`,
 * `setWeather`, `poseCamera`, `setOverlays`, `setPlayerState` and `seed` — so a
 * shot that needs a posed firefight has to reach its own lane directly.
 * `poseAiTableau` is AI's lane-private hook for exactly that, and this file is
 * its only caller. Both files belong to AI, so nothing crosses a lane boundary.
 *
 * THE CAMERA IS SOLVED, NOT AUTHORED, and that is deliberate. The block-out
 * massing at ALPHA is generated, and the navmesh decides where twelve soldiers
 * actually end up standing; a hand-typed pose that frames them today is inside a
 * wall the next time either changes. So the lane spawns the firefight, then
 * searches an ordered candidate set of stand-off / lateral / height triples and
 * returns the nearest, lowest one with clear line of sight — scored through the
 * SAME `LosGrid` the bots see through, so the answer is deterministic and
 * "camera inside a building" is a state that cannot be reached.
 *
 * The literal pose below is the fallback for the case where AI has not been
 * constructed (the null service, or a boot that failed before `ai`): an
 * elevated three-quarter view of ALPHA that at least shows the map.
 *
 * The bots are NOT frozen. They are spawned with a live contact each and then
 * simulate normally for the warm-up frames, so what the frame shows is real
 * cover selection, a real reaction delay and a real peek rhythm — not a
 * mannequin arrangement that would pass a critic and prove nothing.
 */
import { registerShot } from '@/engine/harness';
import { MACRO_ANCHORS, MACRO_TERRAIN } from '@/engine/macro';
import { poseAiTableau } from '@/ai/system';

/** Unit engagement axis, matching the one `buildTableau` lays the squads out on. */
const AXIS_X = -0.72;
const AXIS_Z = -0.69;

const ALPHA_X = MACRO_ANCHORS.alpha.x;
const ALPHA_Z = MACRO_ANCHORS.alpha.z;

const FALLBACK_X = ALPHA_X - AXIS_X * 62;
const FALLBACK_Z = ALPHA_Z - AXIS_Z * 62;

registerShot({
  name: 'ai_soldier_lods',
  description:
    'The procedural soldier at 6 / 13 / 21 / 32 / 46 / 68 m down one street, straddling ' +
    'both LOD switches (22 m and 55 m), alternating team colours, one crouched. No debug ' +
    'overlay: this frame is about the mesh and the silhouette, not the behaviour.',
  frames: 32,
  setup(ctx) {
    ctx.seed(0x0a1e);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.06, { wind: 3.5, fog: 0.0022 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    const pose = poseAiTableau('lods');
    if (pose) {
      ctx.poseCamera(pose.position, pose.target, 55);
    } else {
      ctx.poseCamera(
        [FALLBACK_X, MACRO_TERRAIN.height(FALLBACK_X, FALLBACK_Z) + 42, FALLBACK_Z],
        [ALPHA_X, MACRO_TERRAIN.height(ALPHA_X, ALPHA_Z) + 2, ALPHA_Z],
        50,
      );
    }
  },
});

registerShot({
  name: 'ai_firefight',
  description:
    'Two bot squads contesting ALPHA: cover slots in play (cyan free, amber claimed) with ' +
    'a magenta tether from each man to the slot he chose, A* corridors and goals per bot, ' +
    'and sight lines to believed enemy positions — red while the trigger is down. ' +
    'Soldiers here are at LOD 1 and LOD 2; `ai_soldier_lods` is the close-range model shot.',
  // 64 rather than the default 32. Half of each squad is placed at a real
  // cover slot by the tableau itself, so the frames are not spent walking men
  // across a square — they are spent letting the reaction clocks expire, the
  // corridors solve for the men still advancing, and the aim springs settle.
  frames: 64,
  setup(ctx) {
    ctx.seed(0x0a1f);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.08, { wind: 4.0, fog: 0.0026 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Must run AFTER `seed`: the reset chain despawns every bot and clears the
    // squad orders, so a tableau built before it would be thrown away.
    const pose = poseAiTableau('alpha');
    if (pose) {
      ctx.poseCamera(pose.position, pose.target, 60);
    } else {
      ctx.poseCamera(
        [FALLBACK_X, MACRO_TERRAIN.height(FALLBACK_X, FALLBACK_Z) + 42, FALLBACK_Z],
        [ALPHA_X, MACRO_TERRAIN.height(ALPHA_X, ALPHA_Z) + 2, ALPHA_Z],
        50,
      );
    }
  },
});
