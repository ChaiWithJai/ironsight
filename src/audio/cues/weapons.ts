/**
 * AUDIO — weapon cue synthesis.
 *
 * OWNER: AUDIO. Seven weapons that must be recognisable from one shot with your
 * eyes shut, plus the handling foley and the two ballistic cues.
 *
 * WHAT MAKES THEM DIFFERENT, physically, and therefore in the table below:
 *   barrel length   → how much unburnt powder leaves the muzzle → blast energy
 *                     and how HIGH the body sits. A carbine is louder and
 *                     brighter than a rifle firing the same round.
 *   bore diameter   → the low-frequency displacement. 7.62 puts its weight an
 *                     octave below 5.56 and that is most of "it sounds bigger".
 *   action          → blowback (SMG) rattles early and loud; a rotating bolt
 *                     (rifle) is later, quieter, more metallic; a pump is a
 *                     separate event entirely.
 *
 * VARIATION POLICY: every cue is baked `variations` times with the frequency
 * centres, decays and levels jittered a few percent and a fresh noise seed.
 * Without this, an 800 rpm burst re-triggers one buffer 13 times a second and
 * the identical phase turns the whole burst into a single buzzing tone — the
 * single most recognisable "this is a game" artefact in weapon audio.
 */
import { dbToGain, makeUniform, normalise, softClip } from '../dsp/core';
import {
  layerModes,
  layerNoiseBand,
  layerRoom,
  layerSweep,
  layerTransient,
  smearTransients,
  type ModeSpec,
  type NoiseBandSpec,
} from '../dsp/layers';

export type CueSynth = (fs: number, variation: number, seed: number) => Float32Array;

interface GunSpec {
  readonly duration: number;
  readonly transient: { hz: number; q: number; decay: number; gainDb: number; resonance: number };
  readonly body: readonly Omit<NoiseBandSpec, 'at'>[];
  readonly thump: { hz0: number; hz1: number; decay: number; gainDb: number; bend: number };
  readonly mech: readonly { at: number; hz: number; q: number; decay: number; gainDb: number }[];
  readonly room: { rt: number; wetDb: number };
  readonly drive: number;
}

const GUNS: Record<string, GunSpec> = {
  // 5.56 × 45, 20" barrel, rotating bolt. The reference against which the
  // others are set, and the one the player hears most.
  rifle: {
    duration: 0.44,
    transient: { hz: 3150, q: 2.2, decay: 0.0042, gainDb: -2, resonance: 0.62 },
    body: [
      { hz0: 6400, hz1: 2900, q: 0.7, attack: 0.00025, decay: 0.048, gainDb: -9 },
      { hz0: 2550, hz1: 880, q: 0.9, attack: 0.0004, decay: 0.115, gainDb: -3.5 },
      { hz0: 880, hz1: 360, q: 1.1, attack: 0.0009, decay: 0.17, gainDb: -6 },
    ],
    thump: { hz0: 132, hz1: 50, decay: 0.105, gainDb: -4.5, bend: 1.7 },
    mech: [
      { at: 0.011, hz: 4300, q: 6, decay: 0.012, gainDb: -17 },
      { at: 0.029, hz: 2550, q: 8, decay: 0.021, gainDb: -19 },
      { at: 0.047, hz: 5700, q: 11, decay: 0.009, gainDb: -24 },
    ],
    room: { rt: 0.17, wetDb: -14 },
    drive: 1.5,
  },
  // Same round, 11" barrel: far more unburnt powder at the muzzle, so a hotter,
  // brighter, shorter report with MORE low blast, not less.
  carbine: {
    duration: 0.40,
    transient: { hz: 3850, q: 2.0, decay: 0.0036, gainDb: -1.2, resonance: 0.58 },
    body: [
      { hz0: 7400, hz1: 3400, q: 0.7, attack: 0.0002, decay: 0.042, gainDb: -7.5 },
      { hz0: 2950, hz1: 1050, q: 0.85, attack: 0.00035, decay: 0.098, gainDb: -3 },
      { hz0: 1000, hz1: 420, q: 1.05, attack: 0.0008, decay: 0.14, gainDb: -6.5 },
    ],
    thump: { hz0: 152, hz1: 58, decay: 0.088, gainDb: -3.8, bend: 1.8 },
    mech: [
      { at: 0.0095, hz: 4600, q: 6, decay: 0.011, gainDb: -16 },
      { at: 0.026, hz: 2800, q: 8, decay: 0.019, gainDb: -18.5 },
    ],
    room: { rt: 0.15, wetDb: -15 },
    drive: 1.6,
  },
  // 7.62 × 51 marksman rifle. Weight an octave down and a long body — this is
  // the one that should make the harbour ring.
  dmr: {
    duration: 0.62,
    transient: { hz: 2400, q: 2.6, decay: 0.0062, gainDb: -0.8, resonance: 0.68 },
    body: [
      { hz0: 5200, hz1: 2100, q: 0.75, attack: 0.0003, decay: 0.06, gainDb: -10 },
      { hz0: 1900, hz1: 640, q: 0.9, attack: 0.0005, decay: 0.165, gainDb: -3 },
      { hz0: 620, hz1: 250, q: 1.15, attack: 0.0011, decay: 0.245, gainDb: -4.5 },
    ],
    thump: { hz0: 104, hz1: 38, decay: 0.165, gainDb: -2, bend: 1.5 },
    mech: [
      { at: 0.016, hz: 3400, q: 7, decay: 0.017, gainDb: -18 },
      { at: 0.041, hz: 2100, q: 9, decay: 0.028, gainDb: -20 },
    ],
    room: { rt: 0.23, wetDb: -13 },
    drive: 1.4,
  },
  // 9 mm blowback SMG: almost no low end, a snappy mid, and mechanics that are
  // loud, early and half the character of the gun.
  smg: {
    duration: 0.27,
    transient: { hz: 3600, q: 1.9, decay: 0.0031, gainDb: -4, resonance: 0.5 },
    body: [
      { hz0: 5400, hz1: 2500, q: 0.8, attack: 0.0002, decay: 0.028, gainDb: -10 },
      { hz0: 1850, hz1: 720, q: 0.95, attack: 0.0004, decay: 0.07, gainDb: -4.5 },
    ],
    thump: { hz0: 168, hz1: 82, decay: 0.052, gainDb: -8.5, bend: 2.0 },
    mech: [
      { at: 0.0055, hz: 3900, q: 5, decay: 0.014, gainDb: -12 },
      { at: 0.019, hz: 2300, q: 7, decay: 0.022, gainDb: -14 },
      { at: 0.033, hz: 6100, q: 9, decay: 0.008, gainDb: -19 },
    ],
    room: { rt: 0.13, wetDb: -16 },
    drive: 1.7,
  },
  // Belt-fed 7.62. Everything the DMR has plus a heavy feed tray and a longer
  // body, because the sustained fire case is what it exists for.
  lmg: {
    duration: 0.58,
    transient: { hz: 2650, q: 2.4, decay: 0.0055, gainDb: -1, resonance: 0.66 },
    body: [
      { hz0: 5600, hz1: 2300, q: 0.75, attack: 0.0003, decay: 0.055, gainDb: -9.5 },
      { hz0: 2050, hz1: 700, q: 0.9, attack: 0.00045, decay: 0.15, gainDb: -2.5 },
      { hz0: 690, hz1: 270, q: 1.15, attack: 0.001, decay: 0.225, gainDb: -4 },
    ],
    thump: { hz0: 114, hz1: 42, decay: 0.185, gainDb: -1.5, bend: 1.55 },
    mech: [
      { at: 0.008, hz: 3100, q: 5, decay: 0.02, gainDb: -13 },
      { at: 0.024, hz: 1800, q: 7, decay: 0.03, gainDb: -15 },
      { at: 0.044, hz: 4700, q: 9, decay: 0.014, gainDb: -18 },
    ],
    room: { rt: 0.22, wetDb: -13 },
    drive: 1.45,
  },
  // 12-gauge. Broadband and low-centred: a wall of pressure rather than a crack.
  shotgun: {
    duration: 0.70,
    transient: { hz: 1950, q: 1.5, decay: 0.0072, gainDb: -1.5, resonance: 0.55 },
    body: [
      { hz0: 4200, hz1: 1500, q: 0.65, attack: 0.0004, decay: 0.09, gainDb: -7 },
      { hz0: 1400, hz1: 430, q: 0.8, attack: 0.0006, decay: 0.2, gainDb: -2.5 },
      { hz0: 470, hz1: 190, q: 1.0, attack: 0.0012, decay: 0.3, gainDb: -4 },
    ],
    thump: { hz0: 96, hz1: 36, decay: 0.225, gainDb: -1, bend: 1.4 },
    mech: [{ at: 0.02, hz: 2200, q: 6, decay: 0.03, gainDb: -19 }],
    room: { rt: 0.26, wetDb: -12 },
    drive: 1.35,
  },
  // 9 mm sidearm: mid-forward, sharp, and small. It should sound underpowered
  // next to everything else, because it is.
  pistol: {
    duration: 0.31,
    transient: { hz: 3000, q: 2.4, decay: 0.0036, gainDb: -3, resonance: 0.6 },
    body: [
      { hz0: 5200, hz1: 2600, q: 0.8, attack: 0.00025, decay: 0.034, gainDb: -10 },
      { hz0: 2150, hz1: 800, q: 0.95, attack: 0.0004, decay: 0.082, gainDb: -4 },
      { hz0: 780, hz1: 330, q: 1.1, attack: 0.0009, decay: 0.11, gainDb: -8.5 },
    ],
    thump: { hz0: 142, hz1: 58, decay: 0.072, gainDb: -7, bend: 1.9 },
    mech: [
      { at: 0.013, hz: 4100, q: 6, decay: 0.013, gainDb: -14 },
      { at: 0.031, hz: 2700, q: 8, decay: 0.019, gainDb: -16 },
    ],
    room: { rt: 0.14, wetDb: -16 },
    drive: 1.6,
  },
};

/**
 * Per-variation parameter jitter. Small enough that the weapon's identity is
 * untouched, large enough that two adjacent shots do not phase-align.
 */
function jitter(u: () => number, amount: number): number {
  return 1 + (u() * 2 - 1) * amount;
}

function synthGun(name: keyof typeof GUNS): CueSynth {
  return (fs, variation, seed): Float32Array => {
    const spec = GUNS[name];
    const u = makeUniform(seed ^ (variation * 0x9e3779b1));
    const s = (i: number): number => (seed ^ (variation * 2654435761 + i * 40503)) | 0;
    const n = Math.ceil(spec.duration * fs);
    const out = new Float32Array(n);

    layerTransient(
      out,
      fs,
      {
        at: 0,
        gainDb: spec.transient.gainDb + (u() * 2 - 1) * 1.2,
        hz: spec.transient.hz * jitter(u, 0.07),
        q: spec.transient.q * jitter(u, 0.12),
        decay: spec.transient.decay * jitter(u, 0.15),
        resonance: spec.transient.resonance,
      },
      s(1),
    );

    for (let b = 0; b < spec.body.length; b++) {
      const band = spec.body[b];
      layerNoiseBand(
        out,
        fs,
        {
          at: 0.0002 * b,
          gainDb: band.gainDb + (u() * 2 - 1) * 1.4,
          hz0: band.hz0 * jitter(u, 0.06),
          hz1: band.hz1 * jitter(u, 0.06),
          q: band.q * jitter(u, 0.1),
          attack: band.attack,
          decay: band.decay * jitter(u, 0.1),
          curve: 4.2,
        },
        s(10 + b),
      );
    }

    layerSweep(out, fs, {
      at: 0.0006,
      gainDb: spec.thump.gainDb + (u() * 2 - 1) * 0.9,
      hz0: spec.thump.hz0 * jitter(u, 0.05),
      hz1: spec.thump.hz1 * jitter(u, 0.05),
      decay: spec.thump.decay * jitter(u, 0.09),
      bend: spec.thump.bend,
    });

    for (let m = 0; m < spec.mech.length; m++) {
      const mech = spec.mech[m];
      layerModes(
        out,
        fs,
        mech.at * jitter(u, 0.16),
        0.0012,
        [
          { hz: mech.hz * jitter(u, 0.08), q: mech.q, decay: mech.decay, gainDb: mech.gainDb },
          { hz: mech.hz * 1.63 * jitter(u, 0.08), q: mech.q * 1.4, decay: mech.decay * 0.6, gainDb: mech.gainDb - 5 },
        ],
        s(30 + m),
      );
    }

    layerRoom(out, fs, spec.room.rt, spec.room.wetDb);
    softClip(out, spec.drive);
    normalise(out);
    return out;
  };
}

/**
 * The reflected report — what the town hands back a few hundred milliseconds
 * after the shot. Not reverb on the shot: a separate, diffuse, band-limited
 * roar with no transient at all, which the runtime schedules at a distance
 * dependent delay. This is the layer that sells "outdoors, with buildings".
 */
export const synthWeaponTail: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 0x27d4eb2f));
  const dur = 1.35 * jitter(u, 0.18);
  const out = new Float32Array(Math.ceil(dur * fs));
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -6, hz0: 900 * jitter(u, 0.2), hz1: 220, q: 0.55, attack: 0.03, decay: dur * 0.85, curve: 2.4 },
    seed ^ 0x51,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.02, gainDb: -12, hz0: 2600 * jitter(u, 0.2), hz1: 700, q: 0.6, attack: 0.012, decay: dur * 0.45, curve: 3 },
    seed ^ 0x52,
  );
  layerSweep(out, fs, { at: 0.006, gainDb: -12, hz0: 90, hz1: 46, decay: 0.28, attack: 0.02, bend: 1.2 });
  layerRoom(out, fs, 0.9, -6, 0.5);
  smearTransients(out, fs, 0.05, seed ^ 0x53);
  normalise(out, 0.8);
  return out;
};

/**
 * The same shot heard from 250 m+: the transient is gone, the body is a
 * low-passed thump, and the mechanics never arrive at all. Baked separately
 * rather than derived by filtering, because a distant report also loses its
 * temporal structure — that is what `smearTransients` models.
 */
export const synthWeaponDistant: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 0x85ebca6b));
  const out = new Float32Array(Math.ceil(0.85 * fs));
  layerSweep(out, fs, {
    at: 0,
    gainDb: -2,
    hz0: 118 * jitter(u, 0.1),
    hz1: 44,
    decay: 0.17,
    attack: 0.004,
    bend: 1.5,
  });
  layerNoiseBand(
    out,
    fs,
    { at: 0.002, gainDb: -7, hz0: 620 * jitter(u, 0.15), hz1: 180, q: 0.7, attack: 0.003, decay: 0.14, curve: 3.6 },
    seed ^ 0x61,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.03, gainDb: -15, hz0: 380, hz1: 130, q: 0.5, attack: 0.04, decay: 0.5, curve: 2.2 },
    seed ^ 0x62,
  );
  smearTransients(out, fs, 0.018, seed ^ 0x63);
  layerRoom(out, fs, 0.45, -9, 0.6);
  normalise(out, 0.85);
  return out;
};

/* ============================================================================
 * Handling foley
 * ========================================================================= */

const STEEL_MODES = (hz: number, decay: number, gainDb: number): ModeSpec[] => [
  { hz, q: 9, decay, gainDb },
  { hz: hz * 1.71, q: 12, decay: decay * 0.7, gainDb: gainDb - 4 },
  { hz: hz * 2.94, q: 15, decay: decay * 0.45, gainDb: gainDb - 9 },
];

export const synthDryFire: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ variation);
  const out = new Float32Array(Math.ceil(0.14 * fs));
  layerModes(out, fs, 0, 0.0009, STEEL_MODES(3900 * jitter(u, 0.06), 0.035, -3), seed ^ 1);
  layerModes(out, fs, 0.004, 0.0006, STEEL_MODES(6800 * jitter(u, 0.08), 0.012, -12), seed ^ 2);
  normalise(out, 0.7);
  return out;
};

export const synthMagOut: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 7919));
  const out = new Float32Array(Math.ceil(0.34 * fs));
  // Catch release, then the magazine body clearing the well, then it swings free.
  layerModes(out, fs, 0, 0.0008, STEEL_MODES(4400 * jitter(u, 0.07), 0.02, -6), seed ^ 3);
  layerNoiseBand(
    out,
    fs,
    { at: 0.02 * jitter(u, 0.2), gainDb: -10, hz0: 2400, hz1: 900, q: 1.1, attack: 0.004, decay: 0.07, lowpassHz: 6000 },
    seed ^ 4,
  );
  layerModes(out, fs, 0.1 * jitter(u, 0.15), 0.0015, STEEL_MODES(1650 * jitter(u, 0.08), 0.09, -7), seed ^ 5);
  normalise(out, 0.75);
  return out;
};

export const synthMagIn: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 104729));
  const out = new Float32Array(Math.ceil(0.3 * fs));
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -12, hz0: 1800, hz1: 700, q: 1.0, attack: 0.006, decay: 0.05, lowpassHz: 5200 },
    seed ^ 6,
  );
  // The seat: a hard, well-damped thunk with almost no ring. This is the one
  // sound in a reload that has to feel mechanical rather than plastic.
  layerModes(out, fs, 0.055 * jitter(u, 0.12), 0.0022, [
    { hz: 780 * jitter(u, 0.07), q: 5, decay: 0.055, gainDb: -2 },
    { hz: 2350 * jitter(u, 0.07), q: 9, decay: 0.022, gainDb: -8 },
    { hz: 5100, q: 12, decay: 0.008, gainDb: -15 },
  ], seed ^ 7);
  normalise(out, 0.82);
  return out;
};

export const synthBolt: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 15485863));
  const out = new Float32Array(Math.ceil(0.36 * fs));
  // Draw: rails rasping. Then the spring. Then the bolt slamming into battery.
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -14, hz0: 3200, hz1: 1400, q: 0.9, attack: 0.01, decay: 0.075, lowpassHz: 8000 },
    seed ^ 8,
  );
  layerModes(out, fs, 0.02, 0.02, [{ hz: 2900 * jitter(u, 0.1), q: 22, decay: 0.09, gainDb: -18 }], seed ^ 9);
  layerModes(out, fs, 0.115 * jitter(u, 0.1), 0.0018, STEEL_MODES(1450 * jitter(u, 0.06), 0.075, -1), seed ^ 10);
  normalise(out, 0.85);
  return out;
};

export const synthAds: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 31));
  const out = new Float32Array(Math.ceil(0.2 * fs));
  // Cloth and a sling swivel. Quiet, mostly 2–6 kHz, no low end whatsoever.
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -16, hz0: 3800 * jitter(u, 0.1), hz1: 1500, q: 0.8, attack: 0.012, decay: 0.09, lowpassHz: 9000 },
    seed ^ 11,
  );
  layerModes(out, fs, 0.04 * jitter(u, 0.3), 0.001, [{ hz: 5200, q: 14, decay: 0.02, gainDb: -22 }], seed ^ 12);
  normalise(out, 0.5);
  return out;
};

export const synthShell: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 6151));
  const out = new Float32Array(Math.ceil(0.5 * fs));
  // Brass on stone: three bounces at a shortening interval, each duller than
  // the last as the case loses energy.
  let t = 0;
  let gap = 0.075 * jitter(u, 0.3);
  for (let i = 0; i < 3; i++) {
    const g = -6 - i * 5;
    layerModes(
      out,
      fs,
      t,
      0.0006,
      [
        { hz: 5400 * jitter(u, 0.1) * (1 - i * 0.06), q: 16, decay: 0.03 - i * 0.006, gainDb: g },
        { hz: 8900 * jitter(u, 0.1), q: 20, decay: 0.014, gainDb: g - 6 },
        { hz: 3100 * jitter(u, 0.1), q: 11, decay: 0.02, gainDb: g - 3 },
      ],
      seed ^ (20 + i),
    );
    t += gap;
    gap *= 0.62;
  }
  normalise(out, 0.6);
  return out;
};

/* ============================================================================
 * Ballistics
 * ========================================================================= */

/**
 * The supersonic crack: an N-wave, not a bang. A round passing at Mach 2.4 drags
 * a conical shock whose pressure signature at the listener is a ~180 µs
 * positive step, a linear fall through zero, and a negative step at the tail.
 * Rendering that shape literally — rather than as "a short noise burst" — is
 * why it reads as a bullet rather than as a snare.
 */
export const synthCrack: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 1013904223));
  const out = new Float32Array(Math.ceil(0.09 * fs));
  const width = (0.00019 * jitter(u, 0.25) * fs) | 0;
  for (let i = 0; i < width * 2 && i < out.length; i++) {
    // +1 → -1 ramp through zero at the midpoint: the classic N.
    out[i] = 1 - (2 * i) / (width * 2);
  }
  // The ground/torso reflection that always follows within a few ms.
  layerNoiseBand(
    out,
    fs,
    { at: 0.0025 * jitter(u, 0.4), gainDb: -8, hz0: 5200, hz1: 1500, q: 0.7, attack: 0.0002, decay: 0.02, curve: 5 },
    seed ^ 40,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.008, gainDb: -18, hz0: 1800, hz1: 500, q: 0.8, attack: 0.002, decay: 0.05, curve: 3 },
    seed ^ 41,
  );
  normalise(out);
  return out;
};

export const synthWhizby: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 22695477));
  const out = new Float32Array(Math.ceil(0.22 * fs));
  // A Doppler-swept hiss: the round is closing, abeam, then receding, so the
  // band centre falls by roughly a factor of two through the pass.
  layerNoiseBand(
    out,
    fs,
    { at: 0, gainDb: -4, hz0: 4200 * jitter(u, 0.15), hz1: 1300, q: 2.6, attack: 0.02, decay: 0.11, curve: 2.2 },
    seed ^ 42,
  );
  layerNoiseBand(
    out,
    fs,
    { at: 0.01, gainDb: -13, hz0: 9000, hz1: 3000, q: 1.8, attack: 0.015, decay: 0.06, curve: 2.6 },
    seed ^ 43,
  );
  normalise(out, 0.75);
  return out;
};

export const WEAPON_SYNTHS = {
  rifle: synthGun('rifle'),
  carbine: synthGun('carbine'),
  dmr: synthGun('dmr'),
  smg: synthGun('smg'),
  lmg: synthGun('lmg'),
  shotgun: synthGun('shotgun'),
  pistol: synthGun('pistol'),
} as const;

/** Reference level of each weapon at 1 m, dB SPL-ish. Used by the runtime model. */
export const WEAPON_REFERENCE_DB: Record<string, number> = {
  rifle: 158,
  carbine: 160,
  dmr: 162,
  smg: 153,
  lmg: 161,
  shotgun: 159,
  pistol: 155,
};

export { dbToGain };
