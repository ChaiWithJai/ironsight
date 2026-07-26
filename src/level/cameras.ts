/**
 * NAMED CAMERA POSES — the shared vocabulary for shots, the fly-in and the
 * attract loop.
 *
 * OWNER: LEVEL.
 *
 * These exist so "the ALPHA establishing shot" means the SAME frame to every
 * lane and to every critic across the whole review loop. A lighting change and a
 * material change reviewed from two different angles cannot be compared; from
 * the same angle they can.
 *
 * Every pose is authored against the frozen macro silhouette rather than against
 * the built geometry, so a pose stays valid when a building moves. Eye heights
 * are MACRO ground + a stated offset, and the offset is the interesting number:
 *
 *   1.62 m  standing eye height — what the player actually sees
 *   3–6 m   a low establishing height, above the props but inside the street
 *   20–70 m an aerial, for reading the map's shape rather than its detail
 *
 * Shot files may NOT import this module (boundary CI forbids `@/level/**` from
 * `src/shots/**`), so they carry literal coordinates. This table is what the
 * fly-in, the attract loop and `LevelService.cameraPose` read, and the shot
 * files' literals are copied from here deliberately — one of the two has to be
 * the source, and a shot that silently follows a level edit is worse than one
 * that has to be updated on purpose.
 */
import * as THREE from 'three';
import type { CameraRigPose } from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import { BREAKWATER, FREIGHTER, MINARET, POINTS, QUAY } from '@/level/layout';

interface PoseSpec {
  readonly name: string;
  /** World XZ and a height ABOVE THE MACRO GROUND at that XZ. */
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  readonly fovDeg: number;
  /** Treat `from[1]` / `to[1]` as absolute Y instead of ground-relative. */
  readonly absolute?: boolean;
}

/**
 * Sea level is the right datum for anything over water — the macro seabed is
 * −22 m out there and a "6 m above the ground" camera would be underwater.
 */
function groundOrSea(x: number, z: number): number {
  return Math.max(MACRO_TERRAIN.seaLevel, MACRO_TERRAIN.height(x, z));
}

const SPECS: readonly PoseSpec[] = [
  // ---- the three points, at eye height, from the direction you attack them --
  {
    // ALPHA at standing eye height, from the square's north-west corner looking
    // south-east across the stalls into the market hall's arcade.
    //
    // The player's own approach is from the EAST, and that is deliberately not
    // this pose: at 17.4 h the sun is in the western half of the sky, so a
    // camera on the east side photographs the hall's own shadow. A review frame
    // has to be on the lit side of its subject.
    name: 'alpha_square',
    from: [POINTS.alpha.x - 26, 1.72, POINTS.alpha.z - 20],
    to: [POINTS.alpha.x - 4, 0.9, POINTS.alpha.z + 2],
    fovDeg: 55,
  },
  {
    // ALPHA from above the east blocks — the establishing shot: rooflines,
    // the market hall, the mosque dome and the sea past them.
    name: 'alpha_establish',
    from: [POINTS.alpha.x + 62, 24, POINTS.alpha.z + 46],
    to: [POINTS.alpha.x - 10, 8, POINTS.alpha.z - 14],
    fovDeg: 44,
  },
  {
    // Off the quay head, looking WNW down the line of cranes with the water in
    // the foreground. It is the only angle from which all three read as
    // ship-to-shore cranes rather than as three towers: the jibs cantilever
    // TOWARD the camera.
    name: 'bravo_quay',
    from: [58, 9, -66],
    to: [-30, 16, -26],
    fovDeg: 46,
    absolute: true,
  },
  {
    // BRAVO from the landward terrace, above the container yard, looking out to
    // sea past the crane booms. The point's shape in one frame.
    name: 'bravo_establish',
    from: [POINTS.bravo.x + 62, 34, POINTS.bravo.z + 78],
    to: [POINTS.bravo.x - 18, 6, POINTS.bravo.z - 26],
    fovDeg: 46,
    absolute: true,
  },
  {
    // CHARLIE from the seaward shoulder, looking ESE into the fort with the low
    // sun behind the camera: the breached north-west curtain, two towers and the
    // keep roof, all lit. The gate faces the road, which runs away ESE, so the
    // gate elevation is in shadow all through golden hour — `charlie_courtyard`
    // is the pose that shows it, from inside.
    name: 'charlie_fort',
    from: [POINTS.charlie.x - 56, 50, POINTS.charlie.z - 38],
    to: [POINTS.charlie.x + 4, 34, POINTS.charlie.z + 4],
    fovDeg: 44,
    absolute: true,
  },
  {
    // From the rampart, looking back along the headland road — the approach the
    // fort actually commands.
    //
    // HONEST NOTE, because `layout.ts` claims otherwise and the claim is wrong:
    // CHARLIE does NOT see BRAVO. The frozen macro field puts a 39.5 m shoulder
    // at about (−155, −35), which is 8 m above the fort's courtyard and squarely
    // across the 200 m line to the quay. Nothing in this lane can move it —
    // `src/engine/macro.ts` is CORE's and frozen since day 0 — so the fort
    // dominates the road and the western sea approach instead, and BRAVO is
    // overlooked by the town terrace rather than by the fort.
    name: 'charlie_rampart',
    from: [POINTS.charlie.x + 16, 38.6, POINTS.charlie.z + 12],
    to: [POINTS.charlie.x + 62, 36, POINTS.charlie.z + 40],
    fovDeg: 44,
    absolute: true,
  },
  {
    // Inside the fort courtyard, standing. Proves the interior is real.
    name: 'charlie_courtyard',
    from: [POINTS.charlie.x + 15, 1.62, POINTS.charlie.z + 13],
    to: [POINTS.charlie.x - 12, 5.5, POINTS.charlie.z - 10],
    fovDeg: 62,
  },

  // ---- the map, and the things that give it scale -------------------------
  {
    // The whole town from offshore at golden hour: headland left, quay centre,
    // market terrace right. Same framing family as CORE's smoke test.
    name: 'establish_harbour',
    from: [96, 62, -186],
    to: [-72, 12, 54],
    fovDeg: 42,
    absolute: true,
  },
  {
    // Straight down the breakwater from the root, light tower at the end,
    // freighter off the starboard bow.
    name: 'breakwater_low',
    from: [BREAKWATER.root.x - 8, BREAKWATER.deckY + 1.7, BREAKWATER.root.z + 8],
    to: [BREAKWATER.tip.x, BREAKWATER.deckY + 3, BREAKWATER.tip.z],
    fovDeg: 60,
    absolute: true,
  },
  {
    // The wreck at three-quarters, from the breakwater deck halfway out.
    name: 'freighter_beam',
    from: [
      (BREAKWATER.root.x + BREAKWATER.tip.x) / 2 - 4,
      BREAKWATER.deckY + 2.2,
      (BREAKWATER.root.z + BREAKWATER.tip.z) / 2 + 2,
    ],
    to: [FREIGHTER.x, 4, FREIGHTER.z],
    fovDeg: 50,
    absolute: true,
  },
  {
    // The climbing street, BRAVO → ALPHA, from the bottom. Vertical stack of
    // facades, washing lines, and the minaret closing the view.
    name: 'main_street',
    from: [-14, 1.62, 10],
    to: [MINARET.x - 24, 14, MINARET.z - 10],
    fovDeg: 55,
  },
  {
    // High to the south-east: ALPHA terrace right, BRAVO quay centre, CHARLIE
    // headland left, the wreck offshore. The whole three-point triangle.
    name: 'map_overview',
    from: [152, 236, 300],
    to: [-70, 10, 2],
    fovDeg: 45,
    absolute: true,
  },
];

function build(): Map<string, CameraRigPose> {
  const out = new Map<string, CameraRigPose>();
  for (const s of SPECS) {
    const py = s.absolute ? s.from[1] : groundOrSea(s.from[0], s.from[2]) + s.from[1];
    const ty = s.absolute ? s.to[1] : groundOrSea(s.to[0], s.to[2]) + s.to[1];
    out.set(s.name, {
      name: s.name,
      position: new THREE.Vector3(s.from[0], py, s.from[2]),
      target: new THREE.Vector3(s.to[0], ty, s.to[2]),
      fovDeg: s.fovDeg,
    });
  }
  return out;
}

/**
 * Resolved once at module load. The poses depend only on `MACRO_TERRAIN`, which
 * is frozen, so there is nothing to recompute on reset.
 */
export const CAMERA_POSES: ReadonlyMap<string, CameraRigPose> = build();

export const CAMERA_POSE_NAMES: readonly string[] = [...CAMERA_POSES.keys()];
