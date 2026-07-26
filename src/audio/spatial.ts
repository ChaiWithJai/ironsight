/**
 * AUDIO — the distance / occlusion / environment model.
 *
 * OWNER: AUDIO. This is deliberately a PLAIN JAVASCRIPT model that runs whether
 * or not an `AudioContext` exists. Two reasons, both load-bearing:
 *
 *  1. The capture page never gets a user gesture, so `unlocked` is false for the
 *     whole of every shot. If the mixing decisions lived in WebAudio nodes there
 *     would be nothing to draw in the debug overlay and nothing to reason about.
 *  2. WebAudio's own `PannerNode` distance models are inspectable only through
 *     the audio thread, which is asynchronous and not deterministic. Solving the
 *     mix here and pushing the RESULT into the nodes keeps the whole thing
 *     reproducible.
 *
 * WHAT MAKES DISTANCE SOUND LIKE DISTANCE, and none of it is gain alone:
 *
 *   inverse law        the direct path loses 6 dB per doubling.
 *   air absorption     the atmosphere is a low-pass whose corner falls with
 *                      range. At 300 m a rifle has no energy above ~4 kHz left,
 *                      which is most of why it stops sounding like a rifle.
 *   D/R ratio          the REVERBERANT field only loses 3 dB per doubling,
 *                      because it arrives from every direction. So the wet/dry
 *                      ratio climbs with range — this, far more than level, is
 *                      the cue the ear actually uses to judge distance.
 *   propagation delay  346 m/s. At 200 m the report lands 0.58 s after the
 *                      muzzle flash, and the supersonic crack lands before both.
 *   sub coupling       low frequencies diffract around buildings and are barely
 *                      absorbed, so they route through a separate send with a
 *                      much shallower rolloff. This is what lets you feel a tank
 *                      round you cannot hear.
 */
import * as THREE from 'three';
import type { AcousticEnvironment, Vec3 } from '@/engine/types';
import { clamp, dbToGain, gainToDb } from './dsp/core';
import type { CueRecipe } from './library';

/** Speed of sound, m/s. Matches `Sim.SPEED_OF_SOUND`. */
export const SPEED_OF_SOUND = 346;

export interface ListenerState {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
  readonly right: Vec3;
  readonly velocity: Vec3;
}

export interface VoiceSolution {
  distance: number;
  /** Final linear gain on the dry path. */
  dryGain: number;
  /** Early-reflection send, linear. */
  erGain: number;
  /** Late-tail send, linear. */
  tailGain: number;
  /** Sub-bass send, linear. */
  subGain: number;
  /** Combined air-absorption + occlusion corner, Hz. */
  lowpassHz: number;
  /** High-shelf trim in dB; occlusion also removes presence, not just treble. */
  shelfDb: number;
  /** -1 hard left … +1 hard right. */
  pan: number;
  /** Seconds of propagation delay before the cue should start. */
  delay: number;
  /** 0 = clear line of sight, 1 = fully occluded. */
  occlusion: number;
  /** Doppler pitch multiplier. */
  doppler: number;
  /** For the debug overlay and for voice stealing: perceived level in dB. */
  levelDb: number;
}

const tmpDir = new THREE.Vector3();
const tmpRel = new THREE.Vector3();

export function makeSolution(): VoiceSolution {
  return {
    distance: 0,
    dryGain: 1,
    erGain: 0,
    tailGain: 0,
    subGain: 0,
    lowpassHz: 20000,
    shelfDb: 0,
    pan: 0,
    delay: 0,
    occlusion: 0,
    doppler: 1,
    levelDb: 0,
  };
}

/**
 * Critical distance: where the direct and reverberant fields are equal. A tight
 * stone street reaches it within a couple of metres; open water effectively
 * never does. Everything about the wet/dry balance falls out of this one number,
 * which is why it is derived from the environment rather than authored per cue.
 */
function criticalDistance(env: AcousticEnvironment): number {
  return 3 + 34 * (1 - env.enclosure) ** 1.6;
}

export interface SolveInput {
  readonly listener: ListenerState;
  readonly position: Vec3 | null;
  readonly velocity: Vec3 | null;
  readonly recipe: CueRecipe;
  readonly env: AcousticEnvironment;
  readonly gainDb: number;
  readonly occlusion: number;
  readonly maxDistance: number;
  readonly model: 'default' | 'gunshot' | 'ui' | 'ambience';
  /** Global muffle 0..1 from `duck()` — the post-explosion hearing shift. */
  readonly deafness: number;
}

export function solve(input: SolveInput, out: VoiceSolution): VoiceSolution {
  const { listener, recipe, env } = input;

  /* -------- non-spatial cues ------------------------------------------ */
  if (input.model === 'ui' || input.position === null) {
    out.distance = 0;
    out.occlusion = 0;
    out.pan = 0;
    out.delay = 0;
    out.doppler = 1;
    out.dryGain = dbToGain(recipe.refDb + input.gainDb);
    out.erGain = 0;
    out.tailGain = input.model === 'ui' ? 0 : dbToGain(recipe.refDb + input.gainDb + env.wetDb);
    out.subGain = 0;
    // UI is never muffled by deafness — it is the layer that has to survive.
    out.lowpassHz = input.model === 'ui' ? 20000 : 18000 - 12000 * input.deafness;
    out.shelfDb = 0;
    out.levelDb = gainToDb(out.dryGain);
    return out;
  }

  tmpRel.subVectors(input.position, listener.position);
  const d = Math.max(tmpRel.length(), 0.05);
  out.distance = d;

  /* -------- direct path ------------------------------------------------ */
  // Inverse law with a 1 m reference and a near-field clamp, so a cue emitted
  // exactly at the listener does not divide by zero into a full-scale blast.
  const nearClamp = 0.9;
  const directAtten = 1 / Math.max(d, nearClamp);

  // Excess attenuation over and above the inverse law: ground interference and
  // scattering off buildings. ~1.5 dB per 100 m, which matters at 500 m.
  const excessDb = -0.015 * d;

  const sourceDb = recipe.refDb + input.gainDb;
  const occ = clamp(input.occlusion, 0, 1);
  out.occlusion = occ;

  // Occlusion attenuates the DIRECT path hard and the reverberant path barely:
  // a wall between you and a shot removes the line of sight, not the room.
  // Muting an occluded source is the classic mistake — you lose the tactical
  // information that someone is firing at all.
  const occDirectDb = -(3 + 21 * Math.pow(occ, 1.25));
  const occReverbDb = -(1.5 * occ);

  let dryDb = sourceDb + excessDb + occDirectDb;
  out.dryGain = dbToGain(dryDb) * directAtten;

  /* -------- reverberant field ------------------------------------------ */
  const dc = criticalDistance(env);
  // -3 dB per doubling instead of -6: the reverberant field arrives from the
  // whole room, so it decays as 1/sqrt(d) rather than 1/d.
  const reverbAtten = 1 / Math.sqrt(Math.max(d / dc, 0.25));
  const wetBase = dbToGain(sourceDb + env.wetDb + occReverbDb) * reverbAtten * 0.5;
  // Early reflections still have a direction and therefore still fall off
  // faster than the late field.
  out.erGain = wetBase * (0.45 + 0.9 * env.enclosure) * Math.pow(Math.max(d / dc, 0.25), -0.18);
  out.tailGain = wetBase * (0.5 + 0.7 * env.enclosure);

  /* -------- sub coupling ------------------------------------------------ */
  // Only things with real low-frequency content get a sub send, and it decays
  // at roughly -2 dB per doubling because LF neither absorbs nor diffracts away.
  const subAmount = input.model === 'gunshot' ? 0.55 : recipe.bus === 'sfx' && recipe.refDb > -6 ? 0.35 : 0.08;
  out.subGain = dbToGain(sourceDb) * subAmount * Math.pow(Math.max(d, 1), -0.35);

  /* -------- air absorption + occlusion filter --------------------------- */
  // Atmospheric absorption is ~f² so a first-order corner falling exponentially
  // with range is a good match over the 0–600 m we care about. 180 m e-folding
  // puts a rifle's 8 kHz content 20 dB down at 300 m, which is about right for
  // a warm coastal afternoon.
  let fc = 21000 * Math.exp(-d / 180);
  // The environment's own damping: sand and cloth eat treble, stone does not.
  fc = Math.min(fc, env.dampingHz * 3.2);
  // Occlusion is a diffraction low-pass: a 30 cm stone wall passes almost
  // nothing above ~700 Hz, and the corner drops fast as coverage completes.
  fc *= 1 - 0.86 * Math.pow(occ, 0.8);
  // Post-explosion temporary threshold shift.
  fc *= 1 - 0.62 * input.deafness;
  out.lowpassHz = clamp(fc, 240, 20500);
  // Occluded sources also lose presence, not just air. A shelf as well as a
  // corner is the difference between "muffled" and "behind a wall".
  out.shelfDb = -14 * occ - 6 * input.deafness;

  /* -------- panning ----------------------------------------------------- */
  tmpDir.copy(tmpRel).divideScalar(d);
  const lateral = tmpDir.dot(listener.right);
  // Collapse the image as the source approaches the head: a sound 20 cm away
  // panned hard left is a headphone artefact, not a position.
  const spread = clamp((d - 0.4) / 1.6, 0, 1);
  out.pan = clamp(lateral, -1, 1) * spread * 0.92;

  /* -------- propagation delay + doppler --------------------------------- */
  out.delay = input.model === 'gunshot' || input.model === 'default' ? d / SPEED_OF_SOUND : 0;
  if (input.velocity) {
    // Radial component only; positive = receding.
    const radial = input.velocity.dot(tmpDir) - listener.velocity.dot(tmpDir);
    out.doppler = clamp(SPEED_OF_SOUND / (SPEED_OF_SOUND + radial), 0.85, 1.2);
  } else {
    out.doppler = 1;
  }

  /* -------- perceived level (voice stealing + overlay) ------------------ */
  // A-weighting-ish: the low-passed energy is what the ear actually gets, so a
  // heavily occluded distant source scores lower than its raw gain suggests.
  const bandFactor = clamp(Math.log2(out.lowpassHz / 240) / Math.log2(20500 / 240), 0.1, 1);
  out.levelDb = gainToDb(out.dryGain * (0.55 + 0.45 * bandFactor) + out.erGain * 0.4 + out.tailGain * 0.3);
  return out;
}

/** Beyond this the cue is not started at all — cheaper than starting and stealing. */
export function audible(distance: number, recipe: CueRecipe, gainDb: number): boolean {
  const max = recipe.maxDistance;
  if (max <= 0) return true;
  // Loud emits carry further than the table's nominal range.
  return distance <= max * clamp(1 + gainDb / 24, 0.35, 2.5);
}

export function buildListener(position: Vec3, forward: Vec3, up: Vec3, velocity: Vec3, out: ListenerState): void {
  const m = out as {
    -readonly [K in keyof ListenerState]: ListenerState[K];
  };
  m.position.copy(position);
  m.forward.copy(forward).normalize();
  m.up.copy(up).normalize();
  m.right.crossVectors(m.forward, m.up).normalize();
  m.velocity.copy(velocity);
}

export function emptyListener(): ListenerState {
  return {
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    velocity: new THREE.Vector3(),
  };
}
