/**
 * AUDIO — UI cues.
 *
 * OWNER: AUDIO. These are the only sounds in the game that are not physical, so
 * they are the only ones allowed to be tonal. They still must not sound like a
 * phone notification: everything here is a filtered, transient-led tone with a
 * short room, sitting in a narrow 400 Hz – 4 kHz window so it cuts through a
 * firefight without competing with the weapons' low end.
 *
 * They route to the `ui` bus, which bypasses the duck — the whole point of the
 * duck bus is that a capture confirmation still lands during an explosion.
 */
import { makeUniform, normalise, TWO_PI } from '../dsp/core';
import { layerModes, layerNoiseBand, layerRoom, layerTransient } from '../dsp/layers';
import type { CueSynth } from './weapons';

/**
 * A struck metal tone with a controlled inharmonicity: two partials at 1 : 2.76
 * (a struck bar, not a harmonic string) plus a breath of noise on the attack.
 */
function tone(
  out: Float32Array,
  fs: number,
  at: number,
  hz: number,
  decay: number,
  gainDb: number,
  seed: number,
): void {
  layerModes(
    out,
    fs,
    at,
    0.0009,
    [
      { hz, q: 46, decay, gainDb },
      { hz: hz * 2.76, q: 54, decay: decay * 0.55, gainDb: gainDb - 11 },
      { hz: hz * 5.4, q: 60, decay: decay * 0.25, gainDb: gainDb - 20 },
    ],
    seed,
  );
}

/** Objective captured: a rising two-note figure. Confident, not celebratory. */
export const synthCapture: CueSynth = (fs, _variation, seed) => {
  const out = new Float32Array(Math.ceil(1.1 * fs));
  tone(out, fs, 0, 523.25, 0.45, -4, seed ^ 1);
  tone(out, fs, 0.11, 783.99, 0.62, -3, seed ^ 2);
  layerNoiseBand(out, fs, { at: 0, gainDb: -18, hz0: 4200, hz1: 1600, q: 1.2, attack: 0.002, decay: 0.05 }, seed ^ 3);
  layerRoom(out, fs, 0.5, -13, 0.4);
  normalise(out, 0.8);
  return out;
};

/** Objective lost: the same interval inverted and detuned flat. */
export const synthLost: CueSynth = (fs, _variation, seed) => {
  const out = new Float32Array(Math.ceil(1.2 * fs));
  tone(out, fs, 0, 622.25, 0.4, -5, seed ^ 4);
  tone(out, fs, 0.13, 415.3, 0.7, -3.5, seed ^ 5);
  layerNoiseBand(out, fs, { at: 0, gainDb: -20, hz0: 2600, hz1: 900, q: 1.0, attack: 0.004, decay: 0.07 }, seed ^ 6);
  layerRoom(out, fs, 0.55, -12, 0.5);
  normalise(out, 0.8);
  return out;
};

/** Ticket lost: a single short, dry, low tick. Heard hundreds of times a match. */
export const synthTicket: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 13));
  const out = new Float32Array(Math.ceil(0.24 * fs));
  tone(out, fs, 0, 349.23 * (1 + (u() * 2 - 1) * 0.01), 0.16, -9, seed ^ 7);
  layerTransient(out, fs, { at: 0, gainDb: -16, hz: 2800, q: 5, decay: 0.004, resonance: 0.8 }, seed ^ 8);
  normalise(out, 0.55);
  return out;
};

/**
 * Hitmarker: 6 ms, transient only, deliberately narrow-band at 2.4 kHz. It has
 * to be perceptible under a full-auto burst, which means placing it in the one
 * band the weapons have already vacated by 30 ms — not making it louder.
 */
export const synthHit: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 17));
  const out = new Float32Array(Math.ceil(0.09 * fs));
  layerTransient(
    out,
    fs,
    { at: 0, gainDb: -3, hz: 2400 * (1 + (u() * 2 - 1) * 0.03), q: 7, decay: 0.008, resonance: 0.9 },
    seed ^ 9,
  );
  layerTransient(out, fs, { at: 0.0015, gainDb: -12, hz: 5600, q: 9, decay: 0.004, resonance: 0.9 }, seed ^ 10);
  normalise(out, 0.75);
  return out;
};

/** Deploy: a low swell with a hard arrival. The transition into the world. */
export const synthSpawn: CueSynth = (fs, _variation, seed) => {
  const out = new Float32Array(Math.ceil(1.5 * fs));
  // A rising filtered-noise swell for 0.5 s, then the arrival.
  layerNoiseBand(out, fs, { at: 0, gainDb: -12, hz0: 140, hz1: 620, q: 1.1, attack: 0.42, decay: 0.2, curve: 1.2 }, seed ^ 11);
  layerTransient(out, fs, { at: 0.5, gainDb: -4, hz: 900, q: 2.2, decay: 0.02, resonance: 0.5 }, seed ^ 12);
  tone(out, fs, 0.5, 261.63, 0.85, -7, seed ^ 13);
  for (let i = 0; i < Math.ceil(0.5 * fs); i++) {
    // A slow sub swell under the whole thing.
    out[i] += Math.sin((TWO_PI * 46 * i) / fs) * 0.16 * (i / (0.5 * fs)) ** 2;
  }
  layerRoom(out, fs, 0.8, -11, 0.5);
  normalise(out, 0.85);
  return out;
};

/** Menu/weapon select: a dry mechanical detent. No tone at all. */
export const synthSelect: CueSynth = (fs, variation, seed) => {
  const u = makeUniform(seed ^ (variation * 19));
  const out = new Float32Array(Math.ceil(0.1 * fs));
  layerModes(
    out,
    fs,
    0,
    0.0006,
    [
      { hz: 3100 * (1 + (u() * 2 - 1) * 0.05), q: 11, decay: 0.014, gainDb: -6 },
      { hz: 6400, q: 15, decay: 0.007, gainDb: -14 },
    ],
    seed ^ 14,
  );
  normalise(out, 0.55);
  return out;
};
