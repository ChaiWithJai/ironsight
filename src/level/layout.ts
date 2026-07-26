/**
 * HARBOUR REACH — LAYOUT. PURE DATA, no THREE, no RNG, no behaviour.
 *
 * OWNER: LEVEL. Architecture §2 names this file as the one that "LANDS FIRST",
 * because AI and GAME both unblock on the capture-point and spawn anchors.
 *
 * THE GAMEPLAY SHAPE, WHICH IS THE POINT OF ALL OF IT
 * ---------------------------------------------------
 * Three points, a real triangle, no leg the same:
 *
 *        CHARLIE (-212,-48) y=31            the old fort, on the headland
 *              \                            240 m of open rock and switchback
 *               \                           road to BRAVO; commands it
 *                \
 *              BRAVO (-22,-6) y=3.4         the quay. Lowest, most exposed,
 *                  \                        biggest — cranes, containers,
 *                   \                       warehouses, hard cover everywhere
 *                    \  135 m of climbing street with stairs and alleys
 *                     \
 *                    ALPHA (78,96) y=11.5   the market square. Enclosed,
 *                                           vertical, close-quarters
 *
 *   ALPHA↔BRAVO   137 m, 8 m of climb. Two routes: the main street (open, fast,
 *                 covered from the minaret) and the alley chain through the
 *                 blocks (slow, safe, ambush-heavy).
 *   BRAVO↔CHARLIE 197 m. The headland road, the beach below it, or the west
 *                 spur. CHARLIE's ramparts see all of BRAVO — which is the
 *                 tension the whole map is built around.
 *   ALPHA↔CHARLIE 300 m. Nobody walks it directly; you take BRAVO or you go the
 *                 long way inland. That asymmetry is what stops the match
 *                 collapsing into one contested middle.
 *
 * Every height here is `MACRO_TERRAIN.height` at that point, which is the same
 * function TERRAIN erodes from — so these anchors are correct before TERRAIN's
 * heightfield exists and stay correct after.
 */
import { MACRO_ANCHORS } from '@/engine/macro';
import type { PlotStyle } from '@/level/building';

/** Capture-point centres. Deliberately nudged off the macro anchors where the
 *  built geometry's natural centre is not the plateau's — never by more than the
 *  plateau's flat core radius, or the point would sit on a slope. */
export const POINTS = {
  alpha: { x: MACRO_ANCHORS.alpha.x, z: MACRO_ANCHORS.alpha.z, y: MACRO_ANCHORS.alpha.height, radius: 25, height: 16 },
  bravo: { x: -22, z: -6, y: MACRO_ANCHORS.bravo.height, radius: 29, height: 20 },
  charlie: { x: MACRO_ANCHORS.charlie.x, z: MACRO_ANCHORS.charlie.z, y: MACRO_ANCHORS.charlie.height, radius: 23, height: 17 },
} as const;

/** The market square's open paving, in world XZ. Nothing is built inside it. */
export const ALPHA_SQUARE = { x: 78, z: 96, hx: 24, hz: 22 } as const;

/** The quay apron: a built slab, because the terrace falls away seaward here. */
export const QUAY = {
  /** Seaward edge, west→east. The seawall stands on this line. */
  edge: [
    { x: -58, z: -70 },
    { x: -30, z: -62 },
    { x: -6, z: -54 },
    { x: 16, z: -47 },
    { x: 34, z: -43 },
  ],
  deckY: 3.55,
  /** How far inland the apron runs before the terrace takes over. */
  depth: 34,
} as const;

/** Breakwater centreline. The macro ridge under it dies at ~t=0.55, so the
 *  built arm continues on piers past that and ends in a light tower. */
export const BREAKWATER = {
  root: { x: 26, z: -14 },
  tip: { x: 104, z: -70 },
  deckY: 5.4,
  halfWidth: 4.6,
} as const;

/** Where the freighter went aground, and how hard. */
export const FREIGHTER = {
  x: 118,
  z: -74,
  /** Heading, radians, measured like a yaw about +Y. */
  yaw: -0.72,
  /** Starboard list, radians. She is down by the stern and heeled onto the reef. */
  roll: 0.24,
  pitch: -0.1,
  length: 84,
  beam: 13.5,
} as const;

export const MOSQUE = { x: 112, z: 74, yaw: 0.06 } as const;
export const MINARET = { x: 101, z: 66, yaw: 0.1, height: 27 } as const;
export const FUEL_DEPOT = { x: 36, z: 26, yaw: -0.24 } as const;
export const MARKET_HALL = { x: 71, z: 97, yaw: 0.02, hx: 13, hz: 9 } as const;

/** Gantry cranes on the quay, west→east. */
export const CRANES: readonly { x: number; z: number; yaw: number; height: number }[] = [
  { x: -48, z: -33, yaw: 0.16, height: 26 },
  { x: -22, z: -30, yaw: 0.16, height: 30 },
  { x: 6, z: -26, yaw: 0.16, height: 23 },
];

/**
 * A rectangular city block, later subdivided into party-walled plots.
 * `hx`/`hz` are half-extents; `yaw` is the block's rotation.
 */
export interface BlockDef {
  readonly x: number;
  readonly z: number;
  readonly hx: number;
  readonly hz: number;
  readonly yaw: number;
  readonly style: PlotStyle;
  /** Which block face is the primary street: 0 = +Z, 1 = +X, 2 = −Z, 3 = −X. */
  readonly street: number;
  /** Rough plot frontage in metres; the subdivider aims for this. */
  readonly grain: number;
}

/**
 * The town. Blocks are placed by hand — this is level design, not scatter — and
 * every one of them is checked against the macro terrain so nothing sits in the
 * sea or on a 30° face. Between them are the alleys, which is where most of the
 * flanking happens.
 */
export const BLOCKS: readonly BlockDef[] = [
  // ---- around the market square (ALPHA) ------------------------------------
  { x: 78, z: 133, hx: 25, hz: 10, yaw: -0.03, style: 'town', street: 2, grain: 8.5 },
  { x: 34, z: 100, hx: 11, hz: 15, yaw: 0.05, style: 'town', street: 1, grain: 8.0 },
  { x: 121, z: 101, hx: 11, hz: 17, yaw: -0.04, style: 'town', street: 3, grain: 8.5 },
  { x: 50, z: 62, hx: 12, hz: 8, yaw: 0.08, style: 'town', street: 0, grain: 7.5 },
  { x: 106, z: 62, hx: 14, hz: 8, yaw: -0.06, style: 'grand', street: 0, grain: 9.5 },
  { x: 30, z: 136, hx: 15, hz: 9, yaw: 0.04, style: 'town', street: 2, grain: 8.0 },
  { x: 128, z: 140, hx: 15, hz: 10, yaw: -0.05, style: 'town', street: 2, grain: 8.5 },
  { x: 138, z: 92, hx: 9, hz: 16, yaw: 0.03, style: 'town', street: 3, grain: 8.0 },

  // ---- the climbing street, BRAVO → ALPHA ----------------------------------
  { x: 14, z: 66, hx: 13, hz: 10, yaw: 0.62, style: 'town', street: 1, grain: 8.0 },
  { x: 46, z: 38, hx: 12, hz: 9, yaw: 0.62, style: 'town', street: 3, grain: 7.5 },
  { x: -12, z: 48, hx: 10, hz: 11, yaw: 0.52, style: 'town', street: 1, grain: 7.5 },
  { x: 70, z: 34, hx: 12, hz: 9, yaw: 0.5, style: 'town', street: 3, grain: 8.0 },
  { x: 22, z: 96, hx: 8, hz: 10, yaw: 0.1, style: 'town', street: 1, grain: 7.0 },

  // ---- the beach strip, east ----------------------------------------------
  { x: 112, z: 30, hx: 13, hz: 8, yaw: -0.12, style: 'shack', street: 2, grain: 5.5 },
  { x: 146, z: 44, hx: 12, hz: 8, yaw: -0.1, style: 'shack', street: 2, grain: 5.5 },
  { x: 148, z: 78, hx: 10, hz: 12, yaw: 0.02, style: 'town', street: 3, grain: 8.0 },

  // ---- the harbour district (BRAVO) ----------------------------------------
  { x: -46, z: 22, hx: 15, hz: 8, yaw: 0.02, style: 'harbour', street: 2, grain: 14 },
  { x: -8, z: 26, hx: 13, hz: 7, yaw: 0.03, style: 'harbour', street: 2, grain: 13 },
  { x: 22, z: 4, hx: 9, hz: 7, yaw: -0.1, style: 'harbour', street: 3, grain: 11 },
  { x: -66, z: 30, hx: 12, hz: 9, yaw: 0.14, style: 'town', street: 2, grain: 7.5 },
  { x: -96, z: 36, hx: 11, hz: 8, yaw: 0.24, style: 'town', street: 2, grain: 7.5 },
  { x: -64, z: -16, hx: 10, hz: 8, yaw: 0.1, style: 'harbour', street: 0, grain: 9.0 },

  // ---- the west slope, toward the headland ---------------------------------
  { x: -98, z: 6, hx: 9, hz: 10, yaw: 0.34, style: 'compound', street: 1, grain: 10 },
  { x: -128, z: 26, hx: 10, hz: 9, yaw: 0.4, style: 'compound', street: 1, grain: 11 },
  { x: -152, z: 44, hx: 9, hz: 8, yaw: 0.45, style: 'compound', street: 1, grain: 11 },
];

/**
 * Circles nothing may be built inside. Landmarks own their own footprint, and a
 * plot that overlaps one is dropped rather than moved — moving it is how you get
 * a building parked in the middle of a street.
 */
export const KEEP_CLEAR: readonly { x: number; z: number; r: number }[] = [
  { x: ALPHA_SQUARE.x, z: ALPHA_SQUARE.z, r: 27 },
  { x: MOSQUE.x, z: MOSQUE.z, r: 17 },
  { x: MINARET.x, z: MINARET.z, r: 8 },
  { x: FUEL_DEPOT.x, z: FUEL_DEPOT.z, r: 22 },
  { x: POINTS.bravo.x, z: POINTS.bravo.z, r: 26 },
  { x: POINTS.charlie.x, z: POINTS.charlie.z, r: 52 },
  { x: BREAKWATER.root.x, z: BREAKWATER.root.z, r: 18 },
  ...CRANES.map((c) => ({ x: c.x, z: c.z, r: 15 })),
];

/**
 * Street centrelines. Used for the paving strip, for the alley-facing rule, and
 * as the spine the navmesh is guaranteed to be connected along.
 */
export const STREETS: readonly { pts: readonly { x: number; z: number }[]; width: number }[] = [
  // The climbing main street, BRAVO → ALPHA.
  { pts: [{ x: -18, z: 14 }, { x: 4, z: 34 }, { x: 30, z: 52 }, { x: 54, z: 68 }, { x: 68, z: 80 }], width: 8.5 },
  // The quay road, running the length of the harbour.
  { pts: [{ x: -70, z: 16 }, { x: -30, z: 10 }, { x: 6, z: 4 }, { x: 34, z: 8 }], width: 9.5 },
  // The headland road, west out of town to CHARLIE.
  {
    pts: [
      { x: -70, z: 12 }, { x: -96, z: 14 }, { x: -118, z: 24 }, { x: -142, z: 34 },
      { x: -166, z: 22 }, { x: -180, z: -2 }, { x: -196, z: -26 }, { x: -206, z: -40 },
    ],
    width: 7.0,
  },
  // The square's east approach.
  { pts: [{ x: 104, z: 96 }, { x: 128, z: 92 }, { x: 146, z: 84 }], width: 7.5 },
  // The beach road.
  { pts: [{ x: 96, z: 20 }, { x: 124, z: 26 }, { x: 152, z: 38 }], width: 6.5 },
];

/** Team-agnostic deploy anchors; `harbour-reach.ts` turns these into SpawnPointDefs. */
export const SPAWNS: readonly {
  x: number;
  z: number;
  yaw: number;
  link: 'ALPHA' | 'BRAVO' | 'CHARLIE' | null;
  team: 'coalition' | 'insurgent';
}[] = [
  // Coalition come in from the east beach and the inland road.
  { x: 168, z: 66, yaw: -1.9, link: null, team: 'coalition' },
  { x: 160, z: 108, yaw: -1.75, link: null, team: 'coalition' },
  { x: 120, z: 118, yaw: -2.3, link: 'ALPHA', team: 'coalition' },
  { x: 108, z: 46, yaw: -2.5, link: 'ALPHA', team: 'coalition' },
  { x: 40, z: 22, yaw: -1.4, link: 'BRAVO', team: 'coalition' },
  // Insurgents hold the headland and the west quay.
  { x: -262, z: -30, yaw: 1.3, link: null, team: 'insurgent' },
  { x: -244, z: -84, yaw: 0.9, link: null, team: 'insurgent' },
  { x: -226, z: -20, yaw: 1.5, link: 'CHARLIE', team: 'insurgent' },
  { x: -150, z: 40, yaw: 1.9, link: 'CHARLIE', team: 'insurgent' },
  { x: -72, z: 16, yaw: 1.6, link: 'BRAVO', team: 'insurgent' },
];

/**
 * The navmesh's region of interest. Rasterising the full 800×800 m playable
 * envelope at a useful cell size costs ten times the memory for ground nobody
 * fights over; this rectangle covers every route between the three points with
 * ~40 m of margin.
 */
export const NAV_BOUNDS = { minX: -290, maxX: 200, minZ: -110, maxZ: 175, cell: 2.0 } as const;
