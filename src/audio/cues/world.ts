/**
 * AUDIO — world cue synthesis: impacts, footsteps, player foley, explosions and
 * the ambience beds.
 *
 * OWNER: AUDIO.
 *
 * IMPACTS are struck resonators, not noise bursts. What tells you a round hit
 * steel rather than sandstone is the MODAL structure of the ring: steel has a
 * handful of long, inharmonic, high-Q modes; stone has a dense, fast-decaying
 * cluster plus a spray of dust; wood has two or three low, heavily damped modes;
 * glass has many very high modes that die at wildly different rates. Getting the
 * modes right matters more than getting the noise right.
 *
 * FOOTSTEPS are keyed by surface GROUP and stance. Sand is a broadband hiss with
 * no attack; gravel is a cluster of tiny impacts; stone is a sharp heel with a
 * room-dependent tail; metal grating rings. Stance scales level, brightness and
 * the amount of gear rattle that rides along.
 *
 * AMBIENCE beds are baked long and seam-crossfaded, so they can loop without a
 * click and without a recognisable period.
 */
import { Biquad, dbToGain, fadeEdges, makeNoise, makeUniform, normalise, seamLoop, softClip, TWO_PI } from '../dsp/core';
import {
  fillPinkNoise,
  layerModes,
  layerNoiseBand,
  layerRoom,
  layerSweep,
  layerTransient,
  smearTransients,
  type ModeSpec,
} from '../dsp/layers';
import type { CueSynth } from './weapons';

function jit(u: () => number, amount: number): number {
  return 1 + (u() * 2 - 1) * amount;
}

/* ============================================================================
 * Impacts
 * ========================================================================= */

interface ImpactSpec {
  readonly duration: number;
  /** Transient: how hard and how bright the initial contact is. */
  readonly hit: { hz: number; q: number; decay: number; gainDb: number; resonance: number };
  /** Debris/spall spray. */
  readonly spray: { hz0: number; hz1: number; q: number; attack: number; decay: number; gainDb: number };
  /** Ringing modes, as ratios of `base`. Empty for dead materials. */
  readonly base: number;
  readonly modes: readonly (readonly [ratio: number, q: number, decay: number, gainDb: number])[];
  /** Low-frequency thud from the mass behind the surface. */
  readonly thud: { hz0: number; hz1: number; decay: number; gainDb: number } | null;
  readonly roomRt: number;
  readonly roomWetDb: number;
}

const IMPACTS: Record<string, ImpactSpec> = {
  stone: {
    duration: 0.34,
    hit: { hz: 2600, q: 1.6, decay: 0.006, gainDb: -1, resonance: 0.45 },
    spray: { hz0: 5200, hz1: 1400, q: 0.7, attack: 0.0004, decay: 0.11, gainDb: -6 },
    base: 900,
    modes: [
      [1, 7, 0.045, -12],
      [1.83, 9, 0.03, -16],
      [3.11, 11, 0.018, -20],
    ],
    thud: { hz0: 190, hz1: 90, decay: 0.05, gainDb: -10 },
    roomRt: 0.18,
    roomWetDb: -15,
  },
  metal: {
    duration: 0.85,
    hit: { hz: 4200, q: 2.2, decay: 0.004, gainDb: -3, resonance: 0.7 },
    spray: { hz0: 8000, hz1: 3000, q: 0.9, attack: 0.0002, decay: 0.035, gainDb: -12 },
    base: 620,
    // Long, high-Q, deliberately inharmonic — a plate, not a bell.
    modes: [
      [1, 34, 0.55, -5],
      [1.59, 41, 0.42, -8],
      [2.71, 47, 0.3, -11],
      [4.13, 52, 0.2, -15],
      [6.37, 60, 0.12, -19],
    ],
    thud: { hz0: 150, hz1: 70, decay: 0.06, gainDb: -14 },
    roomRt: 0.2,
    roomWetDb: -16,
  },
  wood: {
    duration: 0.3,
    hit: { hz: 1500, q: 1.4, decay: 0.005, gainDb: -3, resonance: 0.5 },
    spray: { hz0: 3600, hz1: 1100, q: 0.8, attack: 0.0006, decay: 0.06, gainDb: -10 },
    base: 320,
    modes: [
      [1, 6, 0.07, -8],
      [2.37, 8, 0.04, -13],
      [4.1, 9, 0.02, -18],
    ],
    thud: { hz0: 165, hz1: 85, decay: 0.07, gainDb: -8 },
    roomRt: 0.14,
    roomWetDb: -17,
  },
  glass: {
    duration: 0.75,
    hit: { hz: 6200, q: 2.0, decay: 0.003, gainDb: -3, resonance: 0.75 },
    spray: { hz0: 11000, hz1: 4200, q: 1.2, attack: 0.0002, decay: 0.22, gainDb: -7 },
    base: 2400,
    modes: [
      [1, 40, 0.28, -6],
      [1.41, 46, 0.22, -8],
      [2.13, 52, 0.16, -10],
      [3.29, 58, 0.11, -13],
      [5.02, 64, 0.07, -16],
      [7.7, 70, 0.04, -20],
    ],
    thud: null,
    roomRt: 0.16,
    roomWetDb: -16,
  },
  sand: {
    duration: 0.24,
    hit: { hz: 900, q: 0.8, decay: 0.008, gainDb: -9, resonance: 0.2 },
    spray: { hz0: 2600, hz1: 700, q: 0.5, attack: 0.002, decay: 0.13, gainDb: -5 },
    base: 0,
    modes: [],
    thud: { hz0: 130, hz1: 62, decay: 0.055, gainDb: -9 },
    roomRt: 0.08,
    roomWetDb: -22,
  },
  water: {
    duration: 0.55,
    hit: { hz: 1800, q: 1.0, decay: 0.01, gainDb: -7, resonance: 0.3 },
    spray: { hz0: 4200, hz1: 900, q: 0.6, attack: 0.004, decay: 0.28, gainDb: -6 },
    base: 0,
    modes: [],
    // The cavity collapse: a RISING sine, which is the one place in the whole
    // library where the sweep goes up. It is the entire "plop".
    thud: { hz0: 240, hz1: 620, decay: 0.09, gainDb: -8 },
    roomRt: 0.1,
    roomWetDb: -20,
  },
  flesh: {
    duration: 0.28,
    hit: { hz: 620, q: 0.9, decay: 0.007, gainDb: -5, resonance: 0.25 },
    spray: { hz0: 1800, hz1: 500, q: 0.6, attack: 0.003, decay: 0.09, gainDb: -9 },
    base: 0,
    modes: [],
    thud: { hz0: 145, hz1: 58, decay: 0.075, gainDb: -4 },
    roomRt: 0.06,
    roomWetDb: -24,
  },
  fabric: {
    duration: 0.22,
    hit: { hz: 1100, q: 0.7, decay: 0.006, gainDb: -11, resonance: 0.2 },
    spray: { hz0: 3000, hz1: 900, q: 0.5, attack: 0.003, decay: 0.1, gainDb: -8 },
    base: 0,
    modes: [],
    thud: { hz0: 120, hz1: 70, decay: 0.05, gainDb: -13 },
    roomRt: 0.05,
    roomWetDb: -26,
  },
  foliage: {
    duration: 0.32,
    hit: { hz: 3400, q: 0.8, decay: 0.004, gainDb: -12, resonance: 0.3 },
    spray: { hz0: 6800, hz1: 2200, q: 0.5, attack: 0.004, decay: 0.19, gainDb: -7 },
    base: 0,
    modes: [],
    thud: null,
    roomRt: 0.07,
    roomWetDb: -24,
  },
};

function synthImpact(name: keyof typeof IMPACTS): CueSynth {
  return (fs, variation, seed): Float32Array => {
    const spec = IMPACTS[name];
    const u = makeUniform(seed ^ (variation * 0x45d9f3b));
    const out = new Float32Array(Math.ceil(spec.duration * fs));

    layerTransient(
      out,
      fs,
      {
        at: 0,
        gainDb: spec.hit.gainDb + (u() * 2 - 1) * 1.5,
        hz: spec.hit.hz * jit(u, 0.1),
        q: spec.hit.q,
        decay: spec.hit.decay * jit(u, 0.2),
        resonance: spec.hit.resonance,
      },
      seed ^ 0x101,
    );
    layerNoiseBand(
      out,
      fs,
      {
        at: 0.0004,
        gainDb: spec.spray.gainDb + (u() * 2 - 1) * 1.5,
        hz0: spec.spray.hz0 * jit(u, 0.09),
        hz1: spec.spray.hz1 * jit(u, 0.09),
        q: spec.spray.q,
        attack: spec.spray.attack,
        decay: spec.spray.decay * jit(u, 0.15),
        curve: 3.6,
      },
      seed ^ 0x102,
    );
    if (spec.modes.length > 0) {
      const modes: ModeSpec[] = spec.modes.map(([ratio, q, decay, gainDb]) => ({
        hz: spec.base * ratio * jit(u, 0.05),
        q,
        decay: decay * jit(u, 0.18),
        gainDb,
      }));
      layerModes(out, fs, 0.0006, 0.0015, modes, seed ^ 0x103);
    }
    if (spec.thud) {
      layerSweep(out, fs, {
        at: 0.0008,
        gainDb: spec.thud.gainDb,
        hz0: spec.thud.hz0 * jit(u, 0.08),
        hz1: spec.thud.hz1 * jit(u, 0.08),
        decay: spec.thud.decay * jit(u, 0.12),
        bend: name === 'water' ? 0.8 : 1.6,
      });
    }
    layerRoom(out, fs, spec.roomRt, spec.roomWetDb);
    softClip(out, 1.25);
    normalise(out, 0.9);
    return out;
  };
}

export const IMPACT_SYNTHS = {
  stone: synthImpact('stone'),
  metal: synthImpact('metal'),
  wood: synthImpact('wood'),
  glass: synthImpact('glass'),
  sand: synthImpact('sand'),
  water: synthImpact('water'),
  flesh: synthImpact('flesh'),
  fabric: synthImpact('fabric'),
  foliage: synthImpact('foliage'),
} as const;

/* ============================================================================
 * Footsteps — variation index encodes [surfaceGroup][stance][take]
 * ========================================================================= */

/** Surface groups a footstep is keyed by. Order is the encoding; do not reorder. */
export const FOOTSTEP_GROUPS = [
  'sand',
  'gravel',
  'stone',
  'wood',
  'metal',
  'water',
  'dirt',
  'cloth',
] as const;
export type FootstepGroup = (typeof FOOTSTEP_GROUPS)[number];

/** 3 stances × 2 takes per group: crouch, walk, run. */
export const FOOTSTEP_STANCES = 3;
export const FOOTSTEP_TAKES = 2;
export const FOOTSTEP_VARIATIONS = FOOTSTEP_GROUPS.length * FOOTSTEP_STANCES * FOOTSTEP_TAKES;

interface StepSpec {
  readonly heel: { hz: number; q: number; decay: number; gainDb: number; resonance: number } | null;
  readonly scuff: { hz0: number; hz1: number; q: number; attack: number; decay: number; gainDb: number };
  readonly grains: number;
  readonly grainHz: number;
  readonly body: { hz0: number; hz1: number; decay: number; gainDb: number } | null;
  readonly ring: readonly ModeSpec[];
  readonly duration: number;
}

const STEPS: Record<FootstepGroup, StepSpec> = {
  sand: {
    heel: null,
    scuff: { hz0: 3400, hz1: 900, q: 0.45, attack: 0.006, decay: 0.13, gainDb: -6 },
    grains: 0,
    grainHz: 0,
    body: { hz0: 120, hz1: 62, decay: 0.05, gainDb: -14 },
    ring: [],
    duration: 0.22,
  },
  gravel: {
    heel: { hz: 2200, q: 1.2, decay: 0.005, gainDb: -8, resonance: 0.35 },
    scuff: { hz0: 4600, hz1: 1500, q: 0.6, attack: 0.003, decay: 0.1, gainDb: -8 },
    grains: 11,
    grainHz: 5200,
    body: { hz0: 150, hz1: 74, decay: 0.05, gainDb: -12 },
    ring: [],
    duration: 0.26,
  },
  stone: {
    heel: { hz: 1900, q: 1.5, decay: 0.006, gainDb: -3, resonance: 0.45 },
    scuff: { hz0: 3800, hz1: 1200, q: 0.7, attack: 0.0015, decay: 0.055, gainDb: -11 },
    grains: 3,
    grainHz: 6200,
    body: { hz0: 175, hz1: 85, decay: 0.045, gainDb: -11 },
    ring: [{ hz: 780, q: 6, decay: 0.05, gainDb: -18 }],
    duration: 0.24,
  },
  wood: {
    heel: { hz: 1200, q: 1.3, decay: 0.007, gainDb: -4, resonance: 0.4 },
    scuff: { hz0: 2800, hz1: 900, q: 0.7, attack: 0.002, decay: 0.05, gainDb: -13 },
    grains: 0,
    grainHz: 0,
    body: { hz0: 190, hz1: 92, decay: 0.07, gainDb: -8 },
    ring: [
      { hz: 220, q: 5, decay: 0.1, gainDb: -14 },
      { hz: 520, q: 7, decay: 0.06, gainDb: -19 },
    ],
    duration: 0.3,
  },
  metal: {
    heel: { hz: 3600, q: 1.8, decay: 0.004, gainDb: -5, resonance: 0.6 },
    scuff: { hz0: 6000, hz1: 2200, q: 0.9, attack: 0.001, decay: 0.04, gainDb: -14 },
    grains: 0,
    grainHz: 0,
    body: { hz0: 160, hz1: 80, decay: 0.04, gainDb: -14 },
    ring: [
      { hz: 640, q: 26, decay: 0.3, gainDb: -12 },
      { hz: 1490, q: 32, decay: 0.2, gainDb: -16 },
      { hz: 3120, q: 38, decay: 0.11, gainDb: -21 },
    ],
    duration: 0.45,
  },
  water: {
    heel: null,
    scuff: { hz0: 5200, hz1: 1100, q: 0.5, attack: 0.005, decay: 0.19, gainDb: -5 },
    grains: 5,
    grainHz: 3200,
    body: { hz0: 260, hz1: 520, decay: 0.08, gainDb: -12 },
    ring: [],
    duration: 0.34,
  },
  dirt: {
    heel: { hz: 1400, q: 0.9, decay: 0.006, gainDb: -9, resonance: 0.25 },
    scuff: { hz0: 2600, hz1: 800, q: 0.5, attack: 0.004, decay: 0.09, gainDb: -8 },
    grains: 4,
    grainHz: 3800,
    body: { hz0: 135, hz1: 66, decay: 0.055, gainDb: -11 },
    ring: [],
    duration: 0.24,
  },
  cloth: {
    heel: null,
    scuff: { hz0: 2400, hz1: 700, q: 0.45, attack: 0.008, decay: 0.11, gainDb: -10 },
    grains: 0,
    grainHz: 0,
    body: { hz0: 110, hz1: 60, decay: 0.06, gainDb: -13 },
    ring: [],
    duration: 0.22,
  },
};

/** Stance shaping: [levelDb, brightnessScale, gearRattleDb]. */
const STANCE_SHAPE: readonly (readonly [number, number, number])[] = [
  [-11, 0.72, -30], // crouch — quiet, dull, almost no gear noise
  [-4, 1.0, -20], // walk
  [1.5, 1.18, -13], // run — louder, brighter, gear slapping
];

export const synthFootstep: CueSynth = (fs, variation, seed) => {
  const group = FOOTSTEP_GROUPS[Math.floor(variation / (FOOTSTEP_STANCES * FOOTSTEP_TAKES)) % FOOTSTEP_GROUPS.length];
  const stance = Math.floor(variation / FOOTSTEP_TAKES) % FOOTSTEP_STANCES;
  const spec = STEPS[group];
  const [levelDb, bright, gearDb] = STANCE_SHAPE[stance];
  const u = makeUniform(seed ^ (variation * 0x2545f491));
  const out = new Float32Array(Math.ceil((spec.duration + 0.06) * fs));

  if (spec.heel) {
    layerTransient(
      out,
      fs,
      {
        at: 0,
        gainDb: spec.heel.gainDb + levelDb,
        hz: spec.heel.hz * bright * jit(u, 0.12),
        q: spec.heel.q,
        decay: spec.heel.decay * jit(u, 0.25),
        resonance: spec.heel.resonance,
      },
      seed ^ 0x201,
    );
  }
  layerNoiseBand(
    out,
    fs,
    {
      at: 0.001,
      gainDb: spec.scuff.gainDb + levelDb,
      hz0: spec.scuff.hz0 * bright * jit(u, 0.1),
      hz1: spec.scuff.hz1 * bright * jit(u, 0.1),
      q: spec.scuff.q,
      attack: spec.scuff.attack,
      decay: spec.scuff.decay * jit(u, 0.2),
      curve: 3,
    },
    seed ^ 0x202,
  );
  // Loose material: a cluster of tiny impacts scattered over the first 90 ms.
  for (let g = 0; g < spec.grains; g++) {
    layerTransient(
      out,
      fs,
      {
        at: (u() ** 1.8) * 0.09,
        gainDb: -22 + levelDb + u() * 6,
        hz: spec.grainHz * bright * (0.6 + u() * 0.9),
        q: 4 + u() * 6,
        decay: 0.003 + u() * 0.006,
        resonance: 0.8,
      },
      seed ^ (0x210 + g),
    );
  }
  if (spec.body) {
    layerSweep(out, fs, {
      at: 0.0015,
      gainDb: spec.body.gainDb + levelDb,
      hz0: spec.body.hz0 * jit(u, 0.1),
      hz1: spec.body.hz1 * jit(u, 0.1),
      decay: spec.body.decay,
      bend: group === 'water' ? 0.8 : 1.5,
    });
  }
  if (spec.ring.length > 0) {
    layerModes(
      out,
      fs,
      0.001,
      0.0012,
      spec.ring.map((m) => ({ ...m, hz: m.hz * jit(u, 0.05), gainDb: m.gainDb + levelDb })),
      seed ^ 0x203,
    );
  }
  // Gear: pouches, sling, magazines. Always there, level set by stance.
  layerNoiseBand(
    out,
    fs,
    { at: 0.012 + u() * 0.02, gainDb: gearDb, hz0: 2800, hz1: 1100, q: 0.9, attack: 0.006, decay: 0.07, lowpassHz: 7000 },
    seed ^ 0x204,
  );
  normalise(out, 0.88);
  return out;
};

/* ============================================================================
 * Player foley
 * ========================================================================= */

export const synthLand: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 97));
  const out = new Float32Array(Math.ceil(0.5 * fs));
  layerSweep(out, fs, { at: 0, gainDb: -2, hz0: 165 * jit(u, 0.08), hz1: 48, decay: 0.13, bend: 1.5 });
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -5, hz0: 2600, hz1: 700, q: 0.6, attack: 0.002, decay: 0.12, curve: 3.4 },
    seed ^ 0x301,
  );
  // Everything on the character shifts at once.
  layerNoiseBand(
    out,
    fs,
    { at: 0.02, gainDb: -9, hz0: 3400, hz1: 1200, q: 0.8, attack: 0.008, decay: 0.16, lowpassHz: 8000 },
    seed ^ 0x302,
  );
  layerModes(out, fs, 0.03, 0.002, [{ hz: 1900 * jit(u, 0.1), q: 12, decay: 0.05, gainDb: -18 }], seed ^ 0x303);
  normalise(out, 0.9);
  return out;
};

export const synthJump: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 89));
  const out = new Float32Array(Math.ceil(0.3 * fs));
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -8, hz0: 2400 * jit(u, 0.1), hz1: 900, q: 0.6, attack: 0.006, decay: 0.09, curve: 2.8 },
    seed ^ 0x310,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.01, gainDb: -12, hz0: 3600, hz1: 1400, q: 0.9, attack: 0.01, decay: 0.13, lowpassHz: 8000 },
    seed ^ 0x311,
  );
  normalise(out, 0.7);
  return out;
};

export const synthGear: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 83));
  const out = new Float32Array(Math.ceil(0.42 * fs));
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -14, hz0: 3200 * jit(u, 0.15), hz1: 1100, q: 0.7, attack: 0.02, decay: 0.2, lowpassHz: 9000 },
    seed ^ 0x320,
  );
  for (let i = 0; i < 3; i++) {
    layerModes(
      out,
      fs,
      u() * 0.22,
      0.0008,
      [{ hz: 2400 + u() * 3600, q: 14, decay: 0.018, gainDb: -24 + u() * 5 }],
      seed ^ (0x321 + i),
    );
  }
  normalise(out, 0.5);
  return out;
};

export const synthBreath: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 79));
  const out = new Float32Array(Math.ceil(0.9 * fs));
  // Two-phase: a sharp draw and a longer, lower release.
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -9, hz0: 900 * jit(u, 0.12), hz1: 1700, q: 1.4, attack: 0.06, decay: 0.22, curve: 1.6, lowpassHz: 4500 },
    seed ^ 0x330,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.33, gainDb: -11, hz0: 1500, hz1: 620, q: 1.2, attack: 0.09, decay: 0.36, curve: 1.4, lowpassHz: 3800 },
    seed ^ 0x331,
  );
  normalise(out, 0.55);
  return out;
};

export const synthHurt: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 73));
  const out = new Float32Array(Math.ceil(0.55 * fs));
  // A grunt: a low band with a falling formant, deliberately non-verbal.
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -3, hz0: 420 * jit(u, 0.12), hz1: 210, q: 3.2, attack: 0.012, decay: 0.24, curve: 2.4, lowpassHz: 3000 },
    seed ^ 0x340,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.004, gainDb: -10, hz0: 1250 * jit(u, 0.1), hz1: 780, q: 2.6, attack: 0.014, decay: 0.2, curve: 2.4, lowpassHz: 4200 },
    seed ^ 0x341,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.02, gainDb: -18, hz0: 3200, hz1: 1600, q: 1.1, attack: 0.02, decay: 0.25, lowpassHz: 6000 },
    seed ^ 0x342,
  );
  normalise(out, 0.85);
  return out;
};

/* ============================================================================
 * Explosions
 * ========================================================================= */

export const synthExplosionNear: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 0x6a09e667));
  const out = new Float32Array(Math.ceil(3.2 * fs));
  // Pressure front.
  layerTransient(out, fs, { at: 0, gainDb: -1, hz: 1500 * jit(u, 0.15), q: 1.1, decay: 0.011, resonance: 0.35 }, seed ^ 1);
  // Fireball body: three overlapping bands sweeping down over ~0.6 s.
  layerNoiseBand(out, fs, { at: 0, gainDb: -4, hz0: 4400 * jit(u, 0.12), hz1: 900, q: 0.55, attack: 0.0006, decay: 0.28, curve: 3.2 }, seed ^ 2);
  layerNoiseBand(out, fs, { at: 0.004, gainDb: -2, hz0: 1200 * jit(u, 0.1), hz1: 260, q: 0.6, attack: 0.002, decay: 0.55, curve: 2.6 }, seed ^ 3);
  layerNoiseBand(out, fs, { at: 0.02, gainDb: -6, hz0: 420, hz1: 120, q: 0.7, attack: 0.006, decay: 0.9, curve: 2.0 }, seed ^ 4);
  // The displacement. Two sweeps an octave apart make it feel physically large
  // rather than merely loud.
  layerSweep(out, fs, { at: 0.001, gainDb: 0, hz0: 88 * jit(u, 0.08), hz1: 26, decay: 0.42, bend: 1.35 });
  layerSweep(out, fs, { at: 0.004, gainDb: -6, hz0: 168 * jit(u, 0.08), hz1: 52, decay: 0.24, bend: 1.6 });
  // Debris rain: 40 scattered impacts over 1.6 s, thinning out.
  for (let i = 0; i < 40; i++) {
    const t = 0.08 + (u() ** 1.7) * 1.55;
    layerTransient(
      out,
      fs,
      { at: t, gainDb: -20 - u() * 12, hz: 900 + u() * 4200, q: 3 + u() * 8, decay: 0.006 + u() * 0.02, resonance: 0.6 },
      seed ^ (0x400 + i),
    );
  }
  // The long tail: the town answering back.
  layerNoiseBand(out, fs, { at: 0.12, gainDb: -14, hz0: 700, hz1: 180, q: 0.5, attack: 0.09, decay: 1.9, curve: 1.5 }, seed ^ 5);
  layerRoom(out, fs, 1.5, -8, 0.45);
  softClip(out, 1.9);
  normalise(out);
  return out;
};

export const synthExplosionFar: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 0xbb67ae85));
  const out = new Float32Array(Math.ceil(2.6 * fs));
  layerSweep(out, fs, { at: 0, gainDb: -1, hz0: 74 * jit(u, 0.1), hz1: 28, decay: 0.5, attack: 0.012, bend: 1.2 });
  layerNoiseBand(out, fs, { at: 0.004, gainDb: -6, hz0: 480 * jit(u, 0.15), hz1: 130, q: 0.6, attack: 0.02, decay: 0.7, curve: 2.0 }, seed ^ 11);
  layerNoiseBand(out, fs, { at: 0.05, gainDb: -12, hz0: 260, hz1: 90, q: 0.5, attack: 0.12, decay: 1.7, curve: 1.4 }, seed ^ 12);
  smearTransients(out, fs, 0.06, seed ^ 13);
  layerRoom(out, fs, 1.2, -9, 0.6);
  normalise(out, 0.9);
  return out;
};

export const synthDebris: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 0x3c6ef372));
  const out = new Float32Array(Math.ceil(1.4 * fs));
  for (let i = 0; i < 26; i++) {
    const t = (u() ** 1.4) * 1.2;
    layerTransient(
      out,
      fs,
      { at: t, gainDb: -8 - u() * 14, hz: 700 + u() * 3600, q: 2.5 + u() * 7, decay: 0.005 + u() * 0.025, resonance: 0.55 },
      seed ^ (0x500 + i),
    );
  }
  layerNoiseBand(out, fs, { at: 0, gainDb: -13, hz0: 3200, hz1: 800, q: 0.5, attack: 0.01, decay: 0.7, curve: 2.2 }, seed ^ 21);
  layerRoom(out, fs, 0.5, -13);
  normalise(out, 0.85);
  return out;
};

export const synthCollapse: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 0xa54ff53a));
  const out = new Float32Array(Math.ceil(2.4 * fs));
  // A grind that builds, then the mass arriving, then rubble settling.
  layerNoiseBand(out, fs, { at: 0, gainDb: -9, hz0: 520, hz1: 180, q: 0.5, attack: 0.22, decay: 0.7, curve: 1.3 }, seed ^ 31);
  layerSweep(out, fs, { at: 0.28, gainDb: -2, hz0: 96 * jit(u, 0.1), hz1: 34, decay: 0.55, attack: 0.05, bend: 1.3 });
  layerNoiseBand(out, fs, { at: 0.3, gainDb: -4, hz0: 2600, hz1: 500, q: 0.5, attack: 0.02, decay: 0.9, curve: 2.0 }, seed ^ 32);
  for (let i = 0; i < 34; i++) {
    const t = 0.32 + (u() ** 1.3) * 1.7;
    layerTransient(
      out,
      fs,
      { at: t, gainDb: -14 - u() * 14, hz: 600 + u() * 2800, q: 2.5 + u() * 6, decay: 0.006 + u() * 0.02, resonance: 0.5 },
      seed ^ (0x600 + i),
    );
  }
  layerRoom(out, fs, 1.1, -9, 0.5);
  softClip(out, 1.5);
  normalise(out, 0.95);
  return out;
};

/* ============================================================================
 * Ambience beds
 * ========================================================================= */

/** Surf: broadband pink noise breathing at ~0.09 Hz with a swell every ~7 s. */
export const synthSurf: CueSynth = (fs, _variation, seed) => {
  const n = Math.ceil(9 * fs);
  const raw = new Float32Array(n);
  fillPinkNoise(raw, 1, seed ^ 0x700);
  const lp = new Biquad().lowpass(fs, 2600, 0.6);
  const hp = new Biquad().highpass(fs, 90, 0.7);
  const u = makeUniform(seed ^ 0x701);
  const swellPhase = u() * TWO_PI;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    // Two incommensurate swells so the loop period is not audible.
    const a = 0.55 + 0.45 * Math.sin(TWO_PI * 0.143 * t + swellPhase);
    const b = 0.7 + 0.3 * Math.sin(TWO_PI * 0.0567 * t + 1.3);
    raw[i] = hp.process(lp.process(raw[i])) * a * b;
  }
  // Individual breakers riding the bed.
  for (let i = 0; i < 7; i++) {
    layerNoiseBand(
      raw,
      fs,
      { at: u() * 8.2, gainDb: -9 - u() * 5, hz0: 1800, hz1: 300, q: 0.4, attack: 0.35, decay: 1.5, curve: 1.4 },
      seed ^ (0x710 + i),
    );
  }
  const out = seamLoop(raw, Math.floor(1.2 * fs));
  normalise(out, 0.72);
  return out;
};

/** Onshore wind: filtered noise with a slowly wandering band centre. */
export const synthWind: CueSynth = (fs, _variation, seed) => {
  const n = Math.ceil(9 * fs);
  const raw = new Float32Array(n);
  const noise = makeNoise(seed ^ 0x720);
  const bp = new Biquad();
  const u = makeUniform(seed ^ 0x721);
  const p1 = u() * TWO_PI;
  const p2 = u() * TWO_PI;
  for (let i = 0; i < n; i++) {
    if (i % 64 === 0) {
      const t = i / fs;
      const hz = 420 * Math.pow(2, 0.9 * Math.sin(TWO_PI * 0.071 * t + p1) + 0.4 * Math.sin(TWO_PI * 0.19 * t + p2));
      bp.bandpass(fs, hz, 0.85);
    }
    const t = i / fs;
    const gust = 0.5 + 0.5 * Math.sin(TWO_PI * 0.053 * t + p2) * Math.sin(TWO_PI * 0.017 * t);
    raw[i] = bp.process(noise()) * (0.35 + 0.65 * gust);
  }
  const out = seamLoop(raw, Math.floor(1.4 * fs));
  normalise(out, 0.6);
  return out;
};

/** Palm fronds: a dense cluster of tiny dry rattles gated by the gust envelope. */
export const synthPalms: CueSynth = (fs, _variation, seed) => {
  const n = Math.ceil(8 * fs);
  const raw = new Float32Array(n);
  const u = makeUniform(seed ^ 0x730);
  for (let i = 0; i < 420; i++) {
    const t = u() * 7.7;
    // Rattles cluster where the gust is strong, which is what makes it read as
    // wind moving through a canopy rather than as static.
    const gust = 0.5 + 0.5 * Math.sin(TWO_PI * 0.083 * t + 0.7);
    if (u() > gust * 0.9 + 0.1) continue;
    layerNoiseBand(
      raw,
      fs,
      {
        at: t,
        gainDb: -22 - u() * 10,
        hz0: 2600 + u() * 5200,
        hz1: 1400 + u() * 2200,
        q: 1.6 + u() * 2,
        attack: 0.002,
        decay: 0.02 + u() * 0.05,
        curve: 3,
      },
      seed ^ (0x731 + i),
    );
  }
  const bed = new Float32Array(n);
  fillPinkNoise(bed, 0.22, seed ^ 0x740);
  const hp = new Biquad().highpass(fs, 1400, 0.7);
  for (let i = 0; i < n; i++) raw[i] += hp.process(bed[i]) * (0.4 + 0.6 * Math.abs(Math.sin(TWO_PI * 0.083 * (i / fs))));
  const out = seamLoop(raw, Math.floor(1 * fs));
  normalise(out, 0.55);
  return out;
};

/** Gull call: two or three formant-swept cries. Not a loop. */
export const synthGull: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 0x9d2c5681));
  const out = new Float32Array(Math.ceil(1.6 * fs));
  const cries = 2 + Math.floor(u() * 2);
  let t = 0.02;
  for (let c = 0; c < cries; c++) {
    const base = 1150 * (1 + (u() * 2 - 1) * 0.16);
    layerNoiseBand(
      out,
      fs,
      { at: t, gainDb: -5, hz0: base, hz1: base * 1.9, q: 8, attack: 0.03, decay: 0.16, curve: 2.0 },
      seed ^ (0x750 + c),
    );
    layerNoiseBand(
      out,
      fs,
      { at: t + 0.01, gainDb: -12, hz0: base * 2.1, hz1: base * 3.6, q: 6, attack: 0.03, decay: 0.13, curve: 2.2 },
      seed ^ (0x760 + c),
    );
    t += 0.22 + u() * 0.24;
  }
  normalise(out, 0.7);
  return out;
};

/** Halyard on a mast: a metal-on-metal tap at an irregular, wind-driven rate. */
export const synthHalyard: CueSynth = (fs, _variation, seed) => {
  const n = Math.ceil(7 * fs);
  const raw = new Float32Array(n);
  const u = makeUniform(seed ^ 0x770);
  let t = u() * 0.6;
  while (t < 6.6) {
    layerModes(
      raw,
      fs,
      t,
      0.0006,
      [
        { hz: 1450 * (1 + (u() * 2 - 1) * 0.09), q: 28, decay: 0.22, gainDb: -14 - u() * 8 },
        { hz: 3380 * (1 + (u() * 2 - 1) * 0.09), q: 34, decay: 0.12, gainDb: -21 },
      ],
      seed ^ (0x780 + ((t * 100) | 0)),
    );
    t += 0.35 + u() * 0.95;
  }
  const out = seamLoop(raw, Math.floor(0.7 * fs));
  normalise(out, 0.5);
  return out;
};

/** Distant war: muffled reports and rumbles at the edge of hearing. */
export const synthDistantWar: CueSynth = (fs, _variation, seed) => {
  const n = Math.ceil(11 * fs);
  const raw = new Float32Array(n);
  const u = makeUniform(seed ^ 0x790);
  // Sparse far explosions.
  for (let i = 0; i < 6; i++) {
    const t = u() * 10.2;
    layerSweep(raw, fs, { at: t, gainDb: -9 - u() * 8, hz0: 62, hz1: 26, decay: 0.5, attack: 0.03, bend: 1.2 });
    layerNoiseBand(
      raw,
      fs,
      { at: t + 0.01, gainDb: -16 - u() * 6, hz0: 320, hz1: 95, q: 0.5, attack: 0.05, decay: 1.1, curve: 1.5 },
      seed ^ (0x7a0 + i),
    );
  }
  // Far small-arms chatter: bursts of 3–6 muffled reports.
  for (let b = 0; b < 9; b++) {
    let t = u() * 10.4;
    const shots = 3 + Math.floor(u() * 4);
    const rate = 0.075 + u() * 0.05;
    for (let s = 0; s < shots; s++) {
      layerNoiseBand(
        raw,
        fs,
        { at: t, gainDb: -24 - u() * 8, hz0: 620, hz1: 200, q: 0.8, attack: 0.004, decay: 0.1, curve: 3 },
        seed ^ (0x7b0 + b * 8 + s),
      );
      t += rate;
    }
  }
  // Low rumble bed.
  const bed = new Float32Array(n);
  fillPinkNoise(bed, 0.35, seed ^ 0x7c0);
  const lp = new Biquad().lowpass(fs, 180, 0.6);
  for (let i = 0; i < n; i++) raw[i] += lp.process(bed[i]) * 0.8;
  smearTransients(raw, fs, 0.03, seed ^ 0x7d0);
  const out = seamLoop(raw, Math.floor(1.5 * fs));
  fadeEdges(out, 64, 64);
  normalise(out, 0.55);
  return out;
};

export { dbToGain };
