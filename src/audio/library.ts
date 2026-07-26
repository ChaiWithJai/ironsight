/**
 * AUDIO — the cue library: `SoundId` → synthesis recipe, variation policy,
 * mixing bus, reference level and voice priority.
 *
 * OWNER: AUDIO. This table is the whole contract between the bake (which turns
 * a recipe into Float32Arrays) and the runtime (which decides which of them get
 * to be audible when a firefight asks for more voices than exist).
 *
 * PRIORITY is what stops a firefight from exhausting the graph. It is not
 * loudness: an explosion at 80 m outranks a footstep at 2 m even though the
 * footstep is louder at the listener, because losing the explosion is a
 * gameplay defect and losing one footstep out of six is not.
 */
import { SurfaceId, type AcousticEnvironment, type SoundId } from '@/engine/types';
import {
  synthAds,
  synthBolt,
  synthCrack,
  synthDryFire,
  synthMagIn,
  synthMagOut,
  synthShell,
  synthWeaponDistant,
  synthWeaponTail,
  synthWhizby,
  WEAPON_SYNTHS,
  type CueSynth,
} from './cues/weapons';
import {
  FOOTSTEP_GROUPS,
  FOOTSTEP_STANCES,
  FOOTSTEP_TAKES,
  FOOTSTEP_VARIATIONS,
  IMPACT_SYNTHS,
  synthBreath,
  synthCollapse,
  synthDebris,
  synthDistantWar,
  synthExplosionFar,
  synthExplosionNear,
  synthGear,
  synthGull,
  synthHalyard,
  synthHurt,
  synthJump,
  synthLand,
  synthFootstep,
  synthPalms,
  synthSurf,
  synthWind,
  type FootstepGroup,
} from './cues/world';
import { synthCapture, synthHit, synthLost, synthSelect, synthSpawn, synthTicket } from './cues/ui';

export type BusName = 'sfx' | 'weapons' | 'ambience' | 'ui';

export interface CueRecipe {
  readonly synth: CueSynth;
  /** Baked takes. >1 is mandatory for anything that can retrigger fast. */
  readonly variations: number;
  /** 0..10. Higher survives voice stealing. */
  readonly priority: number;
  readonly bus: BusName;
  /** Reference level at 1 m, dB relative to a full-scale cue. */
  readonly refDb: number;
  /** Beyond this the cue is not started at all. Metres. */
  readonly maxDistance: number;
  readonly loop?: boolean;
  /** Concurrency cap for this cue alone. Stops 30 shell bounces at once. */
  readonly maxInstances: number;
  /** Long-range model: crack/thump split, air absorption, reflected tail. */
  readonly gunshot?: boolean;
  /** Skips the duck bus, so it stays audible through an explosion. */
  readonly duckImmune?: boolean;
  /** Chooses the variation from `SoundEmitDesc.surface` rather than at random. */
  readonly surfaceKeyed?: boolean;
  /** Relative bake cost, in `BakeStep.cost` units. */
  readonly cost: number;
}

/* ---------------------------------------------------------------- weapons -- */

const gun = (synth: CueSynth, refDb: number, priority: number): CueRecipe => ({
  synth,
  // Five takes at ~800 rpm means the same buffer recurs every 375 ms. Below
  // four the comb filtering between adjacent shots is plainly audible.
  variations: 5,
  priority,
  bus: 'weapons',
  refDb,
  maxDistance: 600,
  maxInstances: 6,
  gunshot: true,
  cost: 5,
});

export const LIBRARY: Readonly<Record<SoundId, CueRecipe>> = {
  'w.rifle.fire': gun(WEAPON_SYNTHS.rifle, 0, 8),
  'w.carbine.fire': gun(WEAPON_SYNTHS.carbine, 1.5, 8),
  'w.dmr.fire': gun(WEAPON_SYNTHS.dmr, 3, 8),
  'w.smg.fire': gun(WEAPON_SYNTHS.smg, -4, 8),
  'w.lmg.fire': gun(WEAPON_SYNTHS.lmg, 2.5, 8),
  'w.shotgun.fire': gun(WEAPON_SYNTHS.shotgun, 1, 8),
  'w.pistol.fire': gun(WEAPON_SYNTHS.pistol, -2.5, 8),

  'w.tail': {
    synth: synthWeaponTail,
    variations: 4,
    priority: 5,
    bus: 'weapons',
    refDb: -9,
    maxDistance: 600,
    // Five, not eight. A reflected report is 1.35 s long, so even the runtime's
    // one-per-110 ms gate can stack twelve of them across a sustained burst —
    // and twelve overlapping diffuse roars is one roar plus seven wasted voices.
    maxInstances: 5,
    cost: 6,
  },
  'w.distant': {
    synth: synthWeaponDistant,
    variations: 4,
    priority: 4,
    bus: 'weapons',
    refDb: -4,
    maxDistance: 900,
    maxInstances: 8,
    cost: 5,
  },
  'w.dry': { synth: synthDryFire, variations: 2, priority: 7, bus: 'weapons', refDb: -14, maxDistance: 25, maxInstances: 2, cost: 1 },
  'w.magout': { synth: synthMagOut, variations: 3, priority: 6, bus: 'weapons', refDb: -13, maxDistance: 30, maxInstances: 3, cost: 2 },
  'w.magin': { synth: synthMagIn, variations: 3, priority: 6, bus: 'weapons', refDb: -12, maxDistance: 30, maxInstances: 3, cost: 2 },
  'w.bolt': { synth: synthBolt, variations: 3, priority: 6, bus: 'weapons', refDb: -12, maxDistance: 30, maxInstances: 3, cost: 2 },
  'w.ads': { synth: synthAds, variations: 3, priority: 4, bus: 'weapons', refDb: -19, maxDistance: 8, maxInstances: 2, cost: 1 },
  'w.shell': { synth: synthShell, variations: 4, priority: 2, bus: 'sfx', refDb: -20, maxDistance: 18, maxInstances: 4, cost: 2 },

  'b.whizby': { synth: synthWhizby, variations: 4, priority: 7, bus: 'sfx', refDb: -6, maxDistance: 14, maxInstances: 4, cost: 2 },
  // The crack is the round's own shock wave, generated AT the listener, so it
  // has no meaningful distance falloff inside its (tiny) trigger radius.
  'b.crack': { synth: synthCrack, variations: 4, priority: 9, bus: 'sfx', refDb: -1, maxDistance: 22, maxInstances: 5, cost: 2 },

  /* ------------------------------------------------------------- impacts -- */

  'i.stone': { synth: IMPACT_SYNTHS.stone, variations: 4, priority: 5, bus: 'sfx', refDb: -6, maxDistance: 120, maxInstances: 6, cost: 3 },
  'i.metal': { synth: IMPACT_SYNTHS.metal, variations: 4, priority: 5, bus: 'sfx', refDb: -6, maxDistance: 140, maxInstances: 5, cost: 4 },
  'i.wood': { synth: IMPACT_SYNTHS.wood, variations: 4, priority: 5, bus: 'sfx', refDb: -8, maxDistance: 100, maxInstances: 5, cost: 3 },
  'i.glass': { synth: IMPACT_SYNTHS.glass, variations: 4, priority: 6, bus: 'sfx', refDb: -7, maxDistance: 140, maxInstances: 4, cost: 4 },
  'i.sand': { synth: IMPACT_SYNTHS.sand, variations: 4, priority: 4, bus: 'sfx', refDb: -12, maxDistance: 70, maxInstances: 5, cost: 2 },
  'i.water': { synth: IMPACT_SYNTHS.water, variations: 4, priority: 4, bus: 'sfx', refDb: -10, maxDistance: 90, maxInstances: 5, cost: 3 },
  'i.flesh': { synth: IMPACT_SYNTHS.flesh, variations: 4, priority: 8, bus: 'sfx', refDb: -9, maxDistance: 60, maxInstances: 4, cost: 2 },
  'i.fabric': { synth: IMPACT_SYNTHS.fabric, variations: 3, priority: 4, bus: 'sfx', refDb: -14, maxDistance: 50, maxInstances: 4, cost: 2 },
  'i.foliage': { synth: IMPACT_SYNTHS.foliage, variations: 3, priority: 3, bus: 'sfx', refDb: -15, maxDistance: 60, maxInstances: 4, cost: 2 },

  /* ------------------------------------------------------------- player --- */

  'p.footstep': {
    synth: synthFootstep,
    variations: FOOTSTEP_VARIATIONS,
    priority: 3,
    bus: 'sfx',
    refDb: -17,
    maxDistance: 34,
    maxInstances: 8,
    surfaceKeyed: true,
    cost: 14,
  },
  'p.land': { synth: synthLand, variations: 3, priority: 5, bus: 'sfx', refDb: -10, maxDistance: 40, maxInstances: 3, cost: 2 },
  'p.jump': { synth: synthJump, variations: 3, priority: 3, bus: 'sfx', refDb: -16, maxDistance: 25, maxInstances: 3, cost: 2 },
  'p.gear': { synth: synthGear, variations: 4, priority: 2, bus: 'sfx', refDb: -20, maxDistance: 16, maxInstances: 4, cost: 2 },
  'p.breath': { synth: synthBreath, variations: 3, priority: 4, bus: 'sfx', refDb: -18, maxDistance: 6, maxInstances: 2, cost: 3 },
  'p.hurt': { synth: synthHurt, variations: 4, priority: 8, bus: 'sfx', refDb: -8, maxDistance: 35, maxInstances: 3, cost: 3 },

  /* ---------------------------------------------------------- explosions -- */

  'x.near': { synth: synthExplosionNear, variations: 3, priority: 10, bus: 'sfx', refDb: 8, maxDistance: 500, maxInstances: 3, cost: 12 },
  'x.far': { synth: synthExplosionFar, variations: 3, priority: 7, bus: 'sfx', refDb: 4, maxDistance: 900, maxInstances: 3, cost: 9 },
  'x.debris': { synth: synthDebris, variations: 3, priority: 4, bus: 'sfx', refDb: -8, maxDistance: 120, maxInstances: 4, cost: 5 },
  'x.collapse': { synth: synthCollapse, variations: 3, priority: 9, bus: 'sfx', refDb: 2, maxDistance: 300, maxInstances: 2, cost: 9 },

  /* ------------------------------------------------------------ ambience -- */

  'amb.surf': { synth: synthSurf, variations: 1, priority: 6, bus: 'ambience', refDb: -12, maxDistance: 400, loop: true, maxInstances: 2, cost: 10 },
  'amb.wind': { synth: synthWind, variations: 1, priority: 6, bus: 'ambience', refDb: -16, maxDistance: 400, loop: true, maxInstances: 2, cost: 9 },
  'amb.palms': { synth: synthPalms, variations: 1, priority: 5, bus: 'ambience', refDb: -18, maxDistance: 45, loop: true, maxInstances: 3, cost: 9 },
  'amb.gull': { synth: synthGull, variations: 4, priority: 3, bus: 'ambience', refDb: -16, maxDistance: 180, maxInstances: 3, cost: 4 },
  'amb.halyard': { synth: synthHalyard, variations: 1, priority: 3, bus: 'ambience', refDb: -20, maxDistance: 60, loop: true, maxInstances: 2, cost: 6 },
  'amb.distant': { synth: synthDistantWar, variations: 1, priority: 5, bus: 'ambience', refDb: -14, maxDistance: 900, loop: true, maxInstances: 1, cost: 12 },

  /* ------------------------------------------------------------------ ui -- */

  'ui.capture': { synth: synthCapture, variations: 1, priority: 10, bus: 'ui', refDb: -6, maxDistance: 0, maxInstances: 1, duckImmune: true, cost: 3 },
  'ui.lost': { synth: synthLost, variations: 1, priority: 10, bus: 'ui', refDb: -6, maxDistance: 0, maxInstances: 1, duckImmune: true, cost: 3 },
  'ui.ticket': { synth: synthTicket, variations: 3, priority: 6, bus: 'ui', refDb: -17, maxDistance: 0, maxInstances: 2, duckImmune: true, cost: 1 },
  'ui.hit': { synth: synthHit, variations: 4, priority: 9, bus: 'ui', refDb: -9, maxDistance: 0, maxInstances: 3, duckImmune: true, cost: 1 },
  'ui.spawn': { synth: synthSpawn, variations: 1, priority: 10, bus: 'ui', refDb: -7, maxDistance: 0, maxInstances: 1, duckImmune: true, cost: 4 },
  'ui.select': { synth: synthSelect, variations: 3, priority: 7, bus: 'ui', refDb: -13, maxDistance: 0, maxInstances: 2, duckImmune: true, cost: 1 },
};

export const ALL_SOUND_IDS = Object.keys(LIBRARY) as SoundId[];

/* ============================================================================
 * Surface → footstep group, and surface → impact cue
 * ========================================================================= */

const GROUP_OF_SURFACE: Readonly<Record<SurfaceId, FootstepGroup>> = {
  [SurfaceId.Sandstone]: 'stone',
  [SurfaceId.Stucco]: 'stone',
  [SurfaceId.Concrete]: 'stone',
  [SurfaceId.Rubble]: 'gravel',
  [SurfaceId.Plaster]: 'stone',
  [SurfaceId.Tile]: 'stone',
  [SurfaceId.Sand]: 'sand',
  [SurfaceId.WetSand]: 'water',
  [SurfaceId.Dirt]: 'dirt',
  [SurfaceId.Gravel]: 'gravel',
  [SurfaceId.Cobble]: 'stone',
  [SurfaceId.Wood]: 'wood',
  [SurfaceId.PaintedWood]: 'wood',
  [SurfaceId.PaintedMetal]: 'metal',
  [SurfaceId.RustedMetal]: 'metal',
  [SurfaceId.BareMetal]: 'metal',
  [SurfaceId.Grating]: 'metal',
  [SurfaceId.Glass]: 'stone',
  [SurfaceId.Fabric]: 'cloth',
  [SurfaceId.Tarp]: 'cloth',
  [SurfaceId.Sandbag]: 'cloth',
  [SurfaceId.Rope]: 'cloth',
  [SurfaceId.Rubber]: 'dirt',
  [SurfaceId.Water]: 'water',
  [SurfaceId.Foliage]: 'dirt',
  [SurfaceId.Bark]: 'wood',
  [SurfaceId.Flesh]: 'cloth',
  [SurfaceId.Kevlar]: 'cloth',
};

/**
 * Variation index for a footstep: `[group][stance][take]`. The runtime supplies
 * the stance through `SoundEmitDesc.pitch` conventions it owns; this function is
 * the single place the packing is defined.
 */
export function footstepVariation(surface: SurfaceId, stance: 0 | 1 | 2, take: number): number {
  const group = GROUP_OF_SURFACE[surface] ?? 'dirt';
  const gi = FOOTSTEP_GROUPS.indexOf(group);
  return ((gi < 0 ? 6 : gi) * FOOTSTEP_STANCES + stance) * FOOTSTEP_TAKES + (take % FOOTSTEP_TAKES);
}

/**
 * How much a surface soaks up the reflected field. Mirrors
 * `SurfaceProfile.acousticAbsorption`, but AUDIO cannot depend on the material
 * factory existing at bake time, so the reverb send falls back to this when
 * `MaterialFactory` is still the null service.
 */
export function fallbackAbsorption(surface: SurfaceId): number {
  const group = GROUP_OF_SURFACE[surface] ?? 'dirt';
  switch (group) {
    case 'stone':
      return 0.08;
    case 'metal':
      return 0.05;
    case 'wood':
      return 0.22;
    case 'gravel':
      return 0.45;
    case 'sand':
      return 0.6;
    case 'water':
      return 0.12;
    case 'dirt':
      return 0.5;
    case 'cloth':
      return 0.85;
    default:
      return 0.4;
  }
}

/* ============================================================================
 * Acoustic environments
 * ========================================================================= */

export type EnvName = AcousticEnvironment['name'];

/** The seven named environments, as the mixer's blend targets. */
export const ENVIRONMENTS: Readonly<Record<EnvName, AcousticEnvironment>> = {
  open: { name: 'open', enclosure: 0.05, reverbSeconds: 0.6, wetDb: -22, dampingHz: 5200 },
  harbour: { name: 'harbour', enclosure: 0.3, reverbSeconds: 1.9, wetDb: -14, dampingHz: 3800 },
  street: { name: 'street', enclosure: 0.72, reverbSeconds: 1.5, wetDb: -9, dampingHz: 6200 },
  courtyard: { name: 'courtyard', enclosure: 0.55, reverbSeconds: 1.2, wetDb: -11, dampingHz: 5000 },
  interior: { name: 'interior', enclosure: 0.9, reverbSeconds: 0.75, wetDb: -8, dampingHz: 2600 },
  tunnel: { name: 'tunnel', enclosure: 1.0, reverbSeconds: 2.4, wetDb: -5, dampingHz: 2000 },
  fort: { name: 'fort', enclosure: 0.62, reverbSeconds: 2.1, wetDb: -10, dampingHz: 4200 },
};

export const ENV_NAMES = Object.keys(ENVIRONMENTS) as EnvName[];
