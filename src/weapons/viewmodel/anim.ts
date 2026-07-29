/**
 * The procedural viewmodel clips: reload, bolt release, inspect. WEAPONS owns
 * this file.
 *
 * There is no animation data in this project — the brief forbids imported
 * assets, and a hand-authored keyframe file would be one anyway. So a clip is a
 * SMALL KEY TABLE plus a sampler, which is the same thing an exported animation
 * is, only legible and editable.
 *
 * WHY A CLIP IS NOT JUST A POSE CURVE. A reload reads as a reload because of
 * four separate channels moving out of phase with each other:
 *
 *   `pos`/`rot`  the weapon comes in toward the chest, rolls so the magwell
 *                faces the shooter, and dips on the seat
 *   `mag`        the magazine leaves under GRAVITY (accelerating) and returns
 *                under MUSCLE (decelerating) — the two are not the same curve,
 *                and using one for both is the single biggest tell
 *   `charge`     the charging handle, on the empty variant only
 *   `hand`       where the support hand is: 0 on the handguard, 1 off the weapon
 *
 * Timings are FRACTIONS of the reload, not seconds, so `reloadTactical` and
 * `reloadEmpty` in `defs/` remain the only place the duration is stated. The
 * 0.58 seat matches `system.ts`, which fires the `magIn` sound at exactly that
 * phase — the sound and the magazine hitting the magwell are one event.
 */
import * as THREE from 'three';
import { clamp01, smoothstep } from '@/engine/math/curves';

/** One sampled frame of a clip, in WEAPON space (−Z bore, +Y up, +X ejection). */
export interface ClipPose {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Vector3;
  /** 0 = seated in the magwell, 1 = fully clear of it. */
  magazine: number;
  /** 0 = in battery, 1 = charging handle fully to the rear. */
  charging: number;
  /** 0 = support hand on the handguard, 1 = off the weapon entirely. */
  handOff: number;
  /**
   * How much of the frame this clip owns. Sway, bob and breathing are scaled
   * by `1 - weight`: a soldier performing a reload is not also swinging the
   * weapon around, and leaving them summed makes the reload look like it is
   * happening on a boat.
   */
  weight: number;
}

export function makeClipPose(): ClipPose {
  return {
    position: new THREE.Vector3(),
    rotation: new THREE.Vector3(),
    magazine: 0,
    charging: 0,
    handOff: 0,
    weight: 0,
  };
}

interface Key {
  readonly t: number;
  readonly pos: readonly [number, number, number];
  readonly rot: readonly [number, number, number];
  readonly mag: number;
  readonly charge: number;
  readonly hand: number;
}

/**
 * The tactical reload: magazine out, magazine in, back to the hip.
 *
 * The weapon comes IN toward the chest, the muzzle rises ~20° and it rolls ~30°
 * about the bore. The muzzle rising is counter-intuitive and it is the whole
 * trick: the magwell is on the UNDERSIDE, so a muzzle-down reload hides the one
 * part of the weapon the animation is about, and the magazine drops out behind
 * the receiver where nobody sees it. Muzzle up turns the magwell toward the eye
 * and puts the magazine's fall straight down the middle of the frame. Every
 * shipped shooter does this and none of them mention it.
 *
 * THE EXTREME POSE, and where its numbers come from.
 *
 * These are OFFSETS FROM THE HIP POSE, and they are solved rather than dialled
 * in, exactly like `AdsDef.hipOffset`. The constraint is that at the deepest
 * point of the reload the MAGWELL sits at 53% across and 64% down the frame
 * through the viewmodel camera's 55° vertical FOV — which puts the optic at
 * (62%, 32%), the muzzle at (42%, 34%) and the top two thirds of the falling
 * magazine inside the frame.
 *
 * That constraint is the whole difficulty of a first-person reload. The weapon
 * rotates about the FRONT of the receiver, so pitching the muzzle up 17° swings
 * everything behind the pivot — optic, magwell, magazine — a long way DOWN. An
 * author who writes "muzzle up, weapon in toward the chest" and translates the
 * weapon down as well ends up with an animation that is entirely below the
 * bottom edge of the screen. The +12 cm of LIFT here is that compensation.
 */
const REACH_POS: readonly [number, number, number] = [-0.056, 0.123, -0.049];
const REACH_ROT: readonly [number, number, number] = [0.16, 0.27, -0.475];

const RELOAD_TACTICAL: readonly Key[] = [
  { t: 0.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
  // Break the firing grip and bring it in: muzzle up, weapon rolled inboard.
  { t: 0.11, pos: [-0.0347, 0.0763, -0.0304], rot: [0.099, 0.167, -0.294], mag: 0, charge: 0, hand: 0.30 },
  // Support hand off the handguard, thumb onto the magazine release.
  { t: 0.21, pos: [-0.0532, 0.1168, -0.0466], rot: [0.152, 0.257, -0.451], mag: 0.10, charge: 0, hand: 0.86 },
  // Free fall. The magazine is clear of the magwell and dropping.
  { t: 0.34, pos: REACH_POS, rot: REACH_ROT, mag: 1.0, charge: 0, hand: 1.0 },
  // The fresh magazine is on its way up, still below the well.
  { t: 0.50, pos: [-0.0538, 0.1181, -0.047], rot: [0.154, 0.259, -0.456], mag: 0.78, charge: 0, hand: 1.0 },
  { t: 0.56, pos: [-0.0538, 0.1181, -0.047], rot: [0.154, 0.259, -0.456], mag: 0.14, charge: 0, hand: 0.95 },
  // THE SEAT. The whole weapon dips 18 mm and noses up as the heel of the hand
  // slaps the magazine home; this single spike is what gives the reload impact.
  { t: 0.61, pos: [-0.0538, 0.1001, -0.047], rot: [0.184, 0.259, -0.456], mag: 0, charge: 0, hand: 0.78 },
  { t: 0.70, pos: [-0.0403, 0.0886, -0.0353], rot: [0.115, 0.194, -0.342], mag: 0, charge: 0, hand: 0.48 },
  // Back onto the handguard and up to the ready.
  { t: 0.87, pos: [-0.0123, 0.0271, -0.0108], rot: [0.035, 0.059, -0.104], mag: 0, charge: 0, hand: 0.14 },
  { t: 1.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
];

/**
 * The empty reload: the same magazine change, then the bolt. It is 0.8 s longer
 * in `defs/` and the extra time is entirely this — the pull is what the player
 * is paying for by running the magazine dry, so it has to be VISIBLE.
 */
const RELOAD_EMPTY: readonly Key[] = [
  { t: 0.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
  { t: 0.09, pos: [-0.0347, 0.0763, -0.0304], rot: [0.099, 0.167, -0.294], mag: 0, charge: 0, hand: 0.30 },
  { t: 0.18, pos: [-0.0532, 0.1168, -0.0466], rot: [0.152, 0.257, -0.451], mag: 0.10, charge: 0, hand: 0.86 },
  { t: 0.30, pos: REACH_POS, rot: REACH_ROT, mag: 1.0, charge: 0, hand: 1.0 },
  { t: 0.46, pos: [-0.0538, 0.1181, -0.047], rot: [0.154, 0.259, -0.456], mag: 0.78, charge: 0, hand: 1.0 },
  { t: 0.54, pos: [-0.0538, 0.1181, -0.047], rot: [0.154, 0.259, -0.456], mag: 0.14, charge: 0, hand: 0.95 },
  { t: 0.58, pos: [-0.0538, 0.1001, -0.047], rot: [0.184, 0.259, -0.456], mag: 0, charge: 0, hand: 0.78 },
  // Roll the weapon UPRIGHT again to reach over the top for the handle: most of
  // the roll comes out, the lift stays, because the hand has to clear the optic.
  { t: 0.68, pos: [-0.0450, 0.1000, -0.0400], rot: [0.150, 0.230, -0.230], mag: 0, charge: 0, hand: 0.70 },
  // Pull to the rear…
  { t: 0.78, pos: [-0.0430, 0.0960, -0.0380], rot: [0.145, 0.225, -0.200], mag: 0, charge: 1.0, hand: 0.86 },
  // …and let go. The handle snaps forward faster than the hand can follow,
  // which is why the next key is only 0.03 away.
  { t: 0.81, pos: [-0.0430, 0.0960, -0.0380], rot: [0.145, 0.225, -0.200], mag: 0, charge: 0, hand: 0.82 },
  { t: 0.92, pos: [-0.0112, 0.0246, -0.0098], rot: [0.032, 0.054, -0.095], mag: 0, charge: 0, hand: 0.20 },
  { t: 1.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
];

/**
 * The inspect clip. Purely a showcase pose — it exists because
 * `ViewmodelRig.forcePose('inspect')` is in the contract and because it is the
 * one pose that puts the LEFT side of the receiver, the ejection port and the
 * magwell in front of the camera, which is what a critic wants to look at.
 */
const INSPECT: readonly Key[] = [
  { t: 0.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
  { t: 0.30, pos: [-0.0650, 0.0804, -0.0187], rot: [-0.048, 0.366, -0.249], mag: 0, charge: 0, hand: 0.25 },
  // Solved on the same constraint as the reload: the magwell at (50%, 55%),
  // which turns the receiver's left side square to the eye at 28 cm.
  { t: 0.62, pos: [-0.1083, 0.1340, -0.0311], rot: [-0.080, 0.610, -0.415], mag: 0, charge: 0, hand: 0.30 },
  { t: 1.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
];

/**
 * The melee strike: a rifle-butt swing, not a knife pull — nobody in this
 * loadout carries a blade, so the "melee" every shooter has is the buttstroke
 * every soldier's weapon can already throw.
 *
 * Three beats, same as the reload's shape: WIND UP (the stock comes off the
 * shoulder and draws back and down, out of the way of the sight), STRIKE (a
 * fast punch forward and across, muzzle dropping so the heel of the stock
 * leads), RECOVER (back to the hip, slower than the strike — a swing this
 * size does not un-happen instantly). `t: 0.42` is the strike's peak and is
 * where `system.ts` resolves the hit — the two must move together or the
 * animation and the sim-side lunge visibly disagree about when contact
 * happens.
 */
const MELEE_STRIKE: readonly Key[] = [
  { t: 0.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
  // Wind up: drawn back toward the shoulder, rolled so the butt clears the sight.
  { t: 0.22, pos: [0.028, -0.038, 0.052], rot: [-0.12, -0.22, 0.16], mag: 0, charge: 0, hand: 0.4 },
  // THE STRIKE. Thrown forward and down-across, fast — this is the frame the
  // sim's short-range check fires on.
  { t: 0.42, pos: [-0.034, -0.082, -0.118], rot: [0.34, 0.31, -0.22], mag: 0, charge: 0, hand: 0.65 },
  // Follow-through, a beat longer than the strike itself.
  { t: 0.58, pos: [-0.022, -0.058, -0.07], rot: [0.2, 0.2, -0.12], mag: 0, charge: 0, hand: 0.4 },
  { t: 1.00, pos: [0, 0, 0], rot: [0, 0, 0], mag: 0, charge: 0, hand: 0 },
];

/** The phase at which `MELEE_STRIKE` reaches contact — `system.ts`'s hit-scan
 *  timing shares this constant so the sim and the view can never drift apart. */
export const MELEE_STRIKE_IMPACT_PHASE = 0.42;

/**
 * Total swing duration, seconds. Shared by `system.ts` (which turns it into a
 * tick offset for `nextMeleeAt`/`meleeHitTick`) and `rig.ts` (which turns it
 * into the clip's playback rate) — ONE number, so the animation and the
 * cooldown can never disagree about how long a swing takes.
 */
export const MELEE_SWING_SECONDS = 0.5;

export function sampleMelee(phase: number, out: ClipPose): ClipPose {
  return sample(MELEE_STRIKE, phase, out);
}

/**
 * Sample a key table at `phase` (0..1) into `out`.
 *
 * Pose channels use `smoothstep` between keys: velocity is zero AT each key,
 * which is exactly right for a clip whose keys are the extremes of the motion
 * and which costs nothing in stability. The magazine channel is deliberately
 * NOT smoothstepped — see `magazineCurve`.
 */
function sample(keys: readonly Key[], phase: number, out: ClipPose): ClipPose {
  const p = clamp01(phase);
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.t < p) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const span = Math.max(1e-4, b.t - a.t);
  const local = clamp01((p - a.t) / span);
  const s = smoothstep(0, 1, local);

  out.position.set(
    a.pos[0] + (b.pos[0] - a.pos[0]) * s,
    a.pos[1] + (b.pos[1] - a.pos[1]) * s,
    a.pos[2] + (b.pos[2] - a.pos[2]) * s,
  );
  out.rotation.set(
    a.rot[0] + (b.rot[0] - a.rot[0]) * s,
    a.rot[1] + (b.rot[1] - a.rot[1]) * s,
    a.rot[2] + (b.rot[2] - a.rot[2]) * s,
  );
  out.magazine = magazineCurve(a.mag, b.mag, local);
  out.charging = a.charge + (b.charge - a.charge) * s;
  out.handOff = a.hand + (b.hand - a.hand) * s;
  // Fade the clip's authority in and out so a reload interrupted at either end
  // does not pop against the hip pose it is replacing.
  out.weight = smoothstep(0, 0.07, p) * (1 - smoothstep(0.93, 1, p));
  return out;
}

/**
 * The magazine channel, which is the one place a symmetric ease is WRONG.
 *
 * Out of the weapon the magazine is in free fall: it accelerates, so the curve
 * is t². Into the weapon it is driven by an arm that decelerates onto the
 * magwell: 1−(1−t)². Using one curve for both is the classic "the magazine is
 * on a string" read, and it survives even at 30 fps in a still frame because
 * the SPACING of the magazine between frames is visibly wrong.
 */
function magazineCurve(from: number, to: number, t: number): number {
  const shaped = to > from ? t * t : 1 - (1 - t) * (1 - t);
  return from + (to - from) * shaped;
}

export function sampleReload(phase: number, empty: boolean, out: ClipPose): ClipPose {
  return sample(empty ? RELOAD_EMPTY : RELOAD_TACTICAL, phase, out);
}

export function sampleInspect(phase: number, out: ClipPose): ClipPose {
  return sample(INSPECT, phase, out);
}

/** Zero every channel. Cheaper and clearer than re-sampling a clip at t=0. */
export function clearClip(out: ClipPose): ClipPose {
  out.position.set(0, 0, 0);
  out.rotation.set(0, 0, 0);
  out.magazine = 0;
  out.charging = 0;
  out.handOff = 0;
  out.weight = 0;
  return out;
}

/**
 * The bolt-carrier cycle, as a fraction of full charging-handle travel.
 *
 * A semi/auto weapon's carrier goes back and returns in roughly HALF the cycle
 * time — at 720 rpm that is a 42 ms round trip, one to three frames. It is
 * almost subliminal in motion and completely obvious by its absence: a weapon
 * whose bolt never moves reads as a prop. `sin(πt)` rather than a triangle
 * because the carrier decelerates into the buffer at the rear.
 */
export function boltCycle(secondsSinceFire: number, rpm: number): number {
  const cycle = (60 / Math.max(60, rpm)) * 0.5;
  const t = secondsSinceFire / cycle;
  return t < 0 || t > 1 ? 0 : Math.sin(Math.PI * t);
}

/**
 * Trigger break, 0..1, from the same clock as the bolt. The trigger travels
 * rearward far faster than it resets — the reset is the shooter's finger
 * returning, not a spring.
 */
export function triggerBreak(secondsSinceFire: number, rpm: number): number {
  const cycle = (60 / Math.max(60, rpm)) * 0.9;
  const t = secondsSinceFire / cycle;
  if (t < 0 || t > 1) return 0;
  return t < 0.18 ? t / 0.18 : 1 - smoothstep(0.18, 1, t);
}
