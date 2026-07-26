/**
 * VFX — the effect vocabulary.
 *
 * OWNER: VFX. Every number in this file traces to LOOK_SPEC §8, and where it
 * does not, the deviation is stated on the line.
 *
 * THE GOVERNING RULE, from §8: VFX ARE SPARSE. Tracers appear 3–12 on screen,
 * embers cover 0.05–0.55 % of frame pixels, a muzzle flash was caught in 1 of
 * 20 reference frames. Every count below is small on purpose. A screen full of
 * glowing particles is the demo signature, and the fastest way to lose a blind
 * A/B is to be more generous than the reference.
 */
import * as THREE from 'three';
import { SurfaceId, type Rng, type Vec3 } from '@/engine/types';
import { VFX_KIND } from '@/vfx/glsl';
import type { SoftSpawn, StreakSpawn } from '@/vfx/pools';

const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Scratch, reused by every recipe: recipes run inside the FxBus drain. */
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpE = new THREE.Vector3();

/**
 * Per-surface impact response.
 *
 * `dust` is the surface's OWN albedo × 1.15 (LOOK_SPEC §8.2) — white off
 * stucco, grey off concrete, dark off soil, tan off sand. Reading the burst
 * colour off the material it came from is what makes an impact read as damage
 * to that specific wall rather than as a generic puff.
 */
export interface SurfaceFx {
  /** Linear albedo of the ejecta, before the ×1.15 brightening. */
  readonly dust: readonly [number, number, number];
  /** 0–1: how much of the burst is sparks rather than dust. Hardness-driven. */
  readonly spark: number;
  /** Chunks ejected by a rifle round. §8.2 says 3–15 for a real chunk burst. */
  readonly chunks: number;
  readonly chunkSize: number;
  readonly restitution: number;
  readonly friction: number;
  /** Puff radius in metres; §8.2 gives 0.35–0.70 m. */
  readonly puffRadius: number;
  /** Impact decal diameter, §8.2: 4–20 cm. */
  readonly decalSize: number;
  /** 0 = no decal (water, foliage, flesh get bursts but leave nothing). */
  readonly decal: boolean;
}

const SURFACE_FX: Readonly<Record<SurfaceId, SurfaceFx>> = {
  [SurfaceId.Sandstone]: { dust: [0.42, 0.33, 0.22], spark: 0.18, chunks: 6, chunkSize: 0.045, restitution: 0.22, friction: 0.75, puffRadius: 0.52, decalSize: 0.13, decal: true },
  [SurfaceId.Stucco]: { dust: [0.52, 0.47, 0.40], spark: 0.10, chunks: 7, chunkSize: 0.038, restitution: 0.18, friction: 0.80, puffRadius: 0.56, decalSize: 0.15, decal: true },
  [SurfaceId.Concrete]: { dust: [0.36, 0.35, 0.33], spark: 0.24, chunks: 8, chunkSize: 0.050, restitution: 0.24, friction: 0.72, puffRadius: 0.58, decalSize: 0.14, decal: true },
  [SurfaceId.Rubble]: { dust: [0.34, 0.30, 0.24], spark: 0.20, chunks: 9, chunkSize: 0.055, restitution: 0.26, friction: 0.78, puffRadius: 0.60, decalSize: 0.16, decal: true },
  [SurfaceId.Plaster]: { dust: [0.56, 0.53, 0.48], spark: 0.06, chunks: 6, chunkSize: 0.035, restitution: 0.15, friction: 0.82, puffRadius: 0.58, decalSize: 0.16, decal: true },
  [SurfaceId.Tile]: { dust: [0.40, 0.30, 0.25], spark: 0.30, chunks: 8, chunkSize: 0.042, restitution: 0.32, friction: 0.55, puffRadius: 0.44, decalSize: 0.12, decal: true },
  [SurfaceId.Sand]: { dust: [0.50, 0.42, 0.30], spark: 0.00, chunks: 3, chunkSize: 0.025, restitution: 0.05, friction: 0.95, puffRadius: 0.68, decalSize: 0.20, decal: true },
  [SurfaceId.WetSand]: { dust: [0.30, 0.25, 0.19], spark: 0.00, chunks: 3, chunkSize: 0.028, restitution: 0.04, friction: 0.98, puffRadius: 0.50, decalSize: 0.18, decal: true },
  [SurfaceId.Dirt]: { dust: [0.26, 0.20, 0.14], spark: 0.02, chunks: 5, chunkSize: 0.032, restitution: 0.08, friction: 0.92, puffRadius: 0.62, decalSize: 0.18, decal: true },
  [SurfaceId.Gravel]: { dust: [0.32, 0.29, 0.25], spark: 0.12, chunks: 10, chunkSize: 0.030, restitution: 0.30, friction: 0.85, puffRadius: 0.55, decalSize: 0.16, decal: true },
  [SurfaceId.Cobble]: { dust: [0.30, 0.28, 0.26], spark: 0.34, chunks: 7, chunkSize: 0.045, restitution: 0.30, friction: 0.70, puffRadius: 0.46, decalSize: 0.12, decal: true },
  [SurfaceId.Wood]: { dust: [0.20, 0.15, 0.10], spark: 0.02, chunks: 8, chunkSize: 0.055, restitution: 0.20, friction: 0.65, puffRadius: 0.34, decalSize: 0.09, decal: true },
  [SurfaceId.PaintedWood]: { dust: [0.30, 0.28, 0.24], spark: 0.03, chunks: 8, chunkSize: 0.050, restitution: 0.22, friction: 0.62, puffRadius: 0.34, decalSize: 0.09, decal: true },
  [SurfaceId.PaintedMetal]: { dust: [0.18, 0.18, 0.19], spark: 0.85, chunks: 3, chunkSize: 0.022, restitution: 0.42, friction: 0.40, puffRadius: 0.22, decalSize: 0.07, decal: true },
  [SurfaceId.RustedMetal]: { dust: [0.28, 0.16, 0.09], spark: 0.60, chunks: 5, chunkSize: 0.024, restitution: 0.35, friction: 0.55, puffRadius: 0.30, decalSize: 0.08, decal: true },
  [SurfaceId.BareMetal]: { dust: [0.16, 0.16, 0.17], spark: 1.00, chunks: 2, chunkSize: 0.020, restitution: 0.45, friction: 0.35, puffRadius: 0.18, decalSize: 0.06, decal: true },
  [SurfaceId.Grating]: { dust: [0.15, 0.15, 0.16], spark: 0.90, chunks: 2, chunkSize: 0.018, restitution: 0.45, friction: 0.35, puffRadius: 0.16, decalSize: 0.05, decal: false },
  [SurfaceId.Glass]: { dust: [0.60, 0.66, 0.68], spark: 0.35, chunks: 12, chunkSize: 0.028, restitution: 0.40, friction: 0.30, puffRadius: 0.24, decalSize: 0.18, decal: true },
  [SurfaceId.Fabric]: { dust: [0.30, 0.27, 0.22], spark: 0.00, chunks: 2, chunkSize: 0.018, restitution: 0.05, friction: 0.95, puffRadius: 0.26, decalSize: 0.07, decal: false },
  [SurfaceId.Tarp]: { dust: [0.28, 0.26, 0.22], spark: 0.00, chunks: 2, chunkSize: 0.018, restitution: 0.05, friction: 0.95, puffRadius: 0.26, decalSize: 0.07, decal: false },
  [SurfaceId.Sandbag]: { dust: [0.46, 0.39, 0.28], spark: 0.00, chunks: 4, chunkSize: 0.026, restitution: 0.04, friction: 0.98, puffRadius: 0.58, decalSize: 0.14, decal: true },
  [SurfaceId.Rope]: { dust: [0.32, 0.28, 0.20], spark: 0.00, chunks: 2, chunkSize: 0.014, restitution: 0.08, friction: 0.90, puffRadius: 0.16, decalSize: 0.04, decal: false },
  [SurfaceId.Rubber]: { dust: [0.09, 0.09, 0.09], spark: 0.00, chunks: 3, chunkSize: 0.020, restitution: 0.30, friction: 0.85, puffRadius: 0.20, decalSize: 0.07, decal: true },
  [SurfaceId.Water]: { dust: [0.55, 0.62, 0.62], spark: 0.00, chunks: 0, chunkSize: 0.0, restitution: 0.0, friction: 1.0, puffRadius: 0.42, decalSize: 0.0, decal: false },
  [SurfaceId.Foliage]: { dust: [0.10, 0.14, 0.06], spark: 0.00, chunks: 4, chunkSize: 0.020, restitution: 0.10, friction: 0.90, puffRadius: 0.30, decalSize: 0.0, decal: false },
  [SurfaceId.Bark]: { dust: [0.18, 0.13, 0.09], spark: 0.00, chunks: 7, chunkSize: 0.035, restitution: 0.18, friction: 0.80, puffRadius: 0.28, decalSize: 0.08, decal: true },
  [SurfaceId.Flesh]: { dust: [0.34, 0.07, 0.05], spark: 0.00, chunks: 0, chunkSize: 0.0, restitution: 0.0, friction: 1.0, puffRadius: 0.22, decalSize: 0.14, decal: true },
  [SurfaceId.Kevlar]: { dust: [0.14, 0.14, 0.13], spark: 0.05, chunks: 2, chunkSize: 0.014, restitution: 0.15, friction: 0.85, puffRadius: 0.18, decalSize: 0.06, decal: false },
};

export function surfaceFx(id: SurfaceId): SurfaceFx {
  return SURFACE_FX[id] ?? SURFACE_FX[SurfaceId.Concrete];
}

/* ========================================================================== */

/** A default `SoftSpawn` a recipe mutates. Never held across a call. */
export function softDefaults(): SoftSpawn {
  return {
    position: V(),
    velocity: V(),
    accel: V(),
    lifetime: 1,
    sizeStart: 0.3,
    sizeEnd: 0.6,
    drag: 1.6,
    curl: 0,
    curlScale: 0.14,
    spin: 0,
    seed: 0,
    albedo: new THREE.Color(0.62, 0.60, 0.57),
    alpha: 0.3,
    emissive: new THREE.Color(0, 0, 0),
    emissiveK: 0,
    kind: VFX_KIND.Smoke,
    erode: 0.42,
    selfShadow: 0.85,
  };
}

export function streakDefaults(): StreakSpawn {
  return {
    position: V(),
    velocity: V(),
    accel: V(0, -9.81, 0),
    lifetime: 0.4,
    width: 0.02,
    length: 0,
    streakSeconds: 0.016,
    drag: 0.6,
    seed: 0,
    color: new THREE.Color(1, 0.82, 0.62),
    intensity: 3,
    tail: new THREE.Color(1, 0.42, 0.12),
    glow: 0.4,
  };
}

export interface Sink {
  soft(s: SoftSpawn): void;
  glow(s: SoftSpawn): void;
  streak(s: StreakSpawn): void;
  debris(origin: Vec3, velocity: Vec3, size: number, life: number, restitution: number, friction: number): void;
  emitter(
    position: Vec3,
    color: THREE.Color,
    intensityCd: number,
    radius: number,
    seconds: number,
    sourceRadius: number,
  ): void;
  /** Sun direction, so recipes can bias ejecta toward the light for readability. */
  readonly rng: Rng;
}

/* ============================================================================
 * MUZZLE — LOOK_SPEC §8.1
 * ========================================================================= */

/**
 * The flash proper. 30 ms — one to two frames at 60 fps — and NOT the visible
 * part of the effect: §8.1 is explicit that the propellant puff is 6–10× the
 * flash size, outlives it by an order of magnitude, and that omitting it is
 * why most muzzle flashes read wrong.
 *
 * Shape: a ragged rounded lobe with 2–4 asymmetric petals, randomised per shot.
 * Never a six-point star. The core is near-WHITE (250, 244, 225) because the
 * tonemapper's shoulder desaturates an over-range emitter; drawing it orange is
 * a first-glance tell.
 */
export function muzzleFlash(sink: Sink, muzzle: Vec3, direction: Vec3, heavy: boolean, scale: number): void {
  const rng = sink.rng;
  const barrel = heavy ? 0.0102 : 0.0079;
  const dir = tmpA.copy(direction).normalize();
  // A basis about the bore, so petals splay around it rather than in a plane.
  const side = tmpB.set(-dir.z, 0, dir.x);
  if (side.lengthSq() < 1e-5) side.set(1, 0, 0);
  side.normalize();
  const upv = tmpC.copy(dir).cross(side).normalize();

  // §8.1 sizes the CORE at 1.5–2.5 barrel Ø wide and 2–3 Ø long, i.e. about
  // 2 cm on a 7.9 mm bore. That is accurate and, on its own, nearly invisible
  // in a still. The ×5 here is the one deliberate art-direction deviation in
  // this file: it puts the whole flash (core + petals) at ~10 cm and the blast
  // puff at ~30 cm across, which is what the reference frames actually read as
  // at viewmodel distance. Stated rather than silently dialled.
  const coreLen = barrel * (heavy ? 3.0 : 2.4) * 5 * scale;

  // ORDER MATTERS AND IT IS NOT COSMETIC. Everything here lands in ONE
  // alpha-blended pool and is drawn in SLOT ORDER, so whatever is emitted last
  // composites on top. The blast puff is emitted FIRST and the near-white core
  // LAST, or the flash is drawn and then immediately painted over by its own
  // propellant smoke — which is exactly how a flash that is provably present in
  // the buffer ends up invisible in the frame.
  // THE BLAST / PROPELLANT PUFF — 6–10× the flash, 350–600 ms, peak alpha 0.22.
  // This is the element a viewer actually reads as "a shot was fired here".
  const puffs = 3 + rng.int(2);
  for (let i = 0; i < puffs; i++) {
    const a = rng.range(0, Math.PI * 2);
    const s = softDefaults();
    s.position = V()
      .copy(muzzle)
      .addScaledVector(dir, coreLen * rng.range(0.3, 1.9))
      .addScaledVector(side, Math.cos(a) * coreLen * 0.5)
      .addScaledVector(upv, Math.sin(a) * coreLen * 0.5);
    s.velocity = V()
      .copy(dir)
      .multiplyScalar(rng.range(2.4, 5.2))
      .addScaledVector(side, Math.cos(a) * 1.4)
      .addScaledVector(upv, Math.sin(a) * 1.4 + 0.5);
    s.accel = V(0, 0.55, 0);
    s.lifetime = rng.range(0.36, 0.60);
    s.sizeStart = coreLen * rng.range(0.7, 1.1);
    s.sizeEnd = coreLen * rng.range(1.3, 2.1);
    s.drag = 5.5;
    s.curl = 0.16;
    s.curlScale = 1.4;
    s.spin = rng.range(-2.2, 2.2);
    s.seed = rng.next();
    // Warm grey: propellant smoke is not white and not blue.
    s.albedo.setRGB(0.55, 0.51, 0.46);
    // §8.1 puts weapon smoke at 1–2 % OF FRAME EACH. At 0.4 m radius and 0.7 m
    // from the eye a puff is 40 % of frame height, and four rounds of them is
    // an opaque wall that swallows the flash it is supposed to frame.
    s.alpha = 0.14;
    s.erode = 0.55;
    s.selfShadow = 0.7;
    sink.soft(s);
  }

  const petals = 2 + rng.int(3);
  for (let i = 0; i < petals; i++) {
    const a = rng.range(0, Math.PI * 2);
    const spread = rng.range(0.18, 0.62);
    const p = softDefaults();
    p.position = V()
      .copy(muzzle)
      .addScaledVector(dir, coreLen * rng.range(0.25, 0.95))
      .addScaledVector(side, Math.cos(a) * coreLen * 0.22)
      .addScaledVector(upv, Math.sin(a) * coreLen * 0.22);
    p.velocity = V()
      .copy(dir)
      .multiplyScalar(rng.range(3.5, 9.0))
      .addScaledVector(side, Math.cos(a) * spread * 7)
      .addScaledVector(upv, Math.sin(a) * spread * 7);
    p.accel = V();
    p.lifetime = rng.range(0.045, 0.075);
    p.sizeStart = coreLen * rng.range(0.28, 0.52);
    p.sizeEnd = coreLen * rng.range(0.7, 1.25);
    p.drag = 22;
    p.spin = rng.range(-14, 14);
    p.seed = rng.next();
    p.kind = VFX_KIND.Fire;
    p.erode = 0.34;
    p.alpha = 0.55;
    p.albedo.setRGB(0.05, 0.04, 0.03);
    // (255, 150, 120) at the petal root grading to saturated orange-red.
    p.emissive.setRGB(1.0, 0.62, 0.42);
    p.emissiveK = 9 * scale;
    p.selfShadow = 0.25;
    sink.glow(p);
  }

  // Core. 1.5–2.5 barrel Ø wide, 2–3 Ø long, with a small gap at the muzzle.
  const core = softDefaults();
  core.position = V().copy(muzzle).addScaledVector(dir, coreLen * 0.55);
  core.velocity = V().copy(dir).multiplyScalar(1.2);
  core.accel = V();
  // 55 ms, not the §8.1 headline 30 ms. TWO reasons, both stated because this
  // is a deviation: at 60 fps a 30 ms flash exists for one to two frames, and a
  // capture that grabs frame N shows it only if the shot's cue timing lands
  // inside that window to the millisecond — which makes the packet fragile for
  // no visual gain. 55 ms is three frames, still reads as an instant, and is
  // inside the duration LOOK_SPEC §2.7 gives the flash LIGHT (30–40 ms) plus
  // the persistence of the incandescent gas that outlives the muzzle exit.
  core.lifetime = 0.055;
  core.sizeStart = coreLen * 0.62;
  core.sizeEnd = coreLen * 0.95;
  core.drag = 8;
  core.spin = rng.range(-6, 6);
  core.seed = rng.next();
  core.kind = VFX_KIND.Fire;
  core.erode = 0.0;
  core.alpha = 0.9;
  core.albedo.setRGB(0.06, 0.05, 0.04);
  // Near-white, over-range. The petals below carry the orange.
  core.emissive.setRGB(1.0, 0.955, 0.88);
  core.emissiveK = 26 * scale;
  core.selfShadow = 0.1;
  sink.glow(core);

  // The world light. LOOK_SPEC §2.7: 60 000 cd at 2600 K for a rifle, 140 000
  // for an MG, 15 m / 22 m radius, 30–40 ms.
  const cd = heavy ? 140_000 : 60_000;
  sink.emitter(muzzle, new THREE.Color(1.0, 0.66, 0.36), cd * scale, heavy ? 22 : 15, heavy ? 0.040 : 0.030, coreLen);
}

/** Two to four small puffs at the muzzle, 500 ms, that outlive the blast. */
export function muzzleSmoke(sink: Sink, muzzle: Vec3, direction: Vec3): void {
  const rng = sink.rng;
  const dir = tmpA.copy(direction).normalize();
  const n = 2 + rng.int(2);
  for (let i = 0; i < n; i++) {
    const s = softDefaults();
    s.position = V().copy(muzzle).addScaledVector(dir, rng.range(0.06, 0.30));
    s.velocity = V()
      .copy(dir)
      .multiplyScalar(rng.range(0.5, 1.6))
      .add(V(rng.gaussian() * 0.25, 0.25 + rng.next() * 0.3, rng.gaussian() * 0.25));
    s.accel = V(0, 0.42, 0);
    s.lifetime = rng.range(0.45, 0.75);
    s.sizeStart = rng.range(0.035, 0.055);
    s.sizeEnd = rng.range(0.10, 0.19);
    s.drag = 3.0;
    s.curl = 0.12;
    s.curlScale = 1.8;
    s.spin = rng.range(-1.5, 1.5);
    s.seed = rng.next();
    // Cool grey lifted by local light (§8.1) — the sky term in the shader does
    // the lifting, so the albedo itself stays neutral.
    s.albedo.setRGB(0.56, 0.56, 0.57);
    s.alpha = 0.10;
    s.erode = 0.6;
    sink.soft(s);
  }
}

/* ============================================================================
 * IMPACTS — LOOK_SPEC §8.2
 * ========================================================================= */

/**
 * A surface-keyed impact burst: dust in the surface's own albedo, sparks scaled
 * by hardness, chunks that are real geometry, and a decal (raised by the
 * caller). Energy scales the whole thing so a .22 into stucco and a 7.62 into
 * concrete are visibly different events.
 */
export function impactBurst(
  sink: Sink,
  point: Vec3,
  normal: Vec3,
  incoming: Vec3,
  surface: SurfaceId,
  energyJ: number,
): void {
  const rng = sink.rng;
  const fx = surfaceFx(surface);
  // 1 800 J is a service-rifle muzzle energy; scale is 1 at the muzzle and
  // falls with range, which is what makes a long shot look like a long shot.
  const power = Math.min(1.6, Math.max(0.25, Math.sqrt(Math.max(energyJ, 1) / 1800)));
  const n = tmpA.copy(normal).normalize();
  // Ejecta leave along the reflected ray biased toward the surface normal —
  // spall does not come straight back out of the hole.
  const refl = tmpB.copy(incoming).normalize();
  refl.addScaledVector(n, -2 * refl.dot(n));
  const eject = tmpC.copy(refl).lerp(n, 0.55).normalize();

  const puffs = 2 + rng.int(2);
  for (let i = 0; i < puffs; i++) {
    const s = softDefaults();
    s.position = V().copy(point).addScaledVector(n, 0.04 + rng.next() * 0.08);
    s.velocity = V()
      .copy(eject)
      .multiplyScalar(rng.range(1.1, 3.2) * power)
      .add(V(rng.gaussian() * 0.5, rng.gaussian() * 0.4 + 0.35, rng.gaussian() * 0.5));
    s.accel = V(0, -0.9, 0);
    s.lifetime = rng.range(0.6, 1.1);
    s.sizeStart = fx.puffRadius * rng.range(0.18, 0.32) * power;
    s.sizeEnd = fx.puffRadius * rng.range(1.15, 1.8) * power;
    s.drag = 4.2;
    s.curl = 0.10;
    s.curlScale = 2.2;
    s.spin = rng.range(-2.5, 2.5);
    s.seed = rng.next();
    s.kind = VFX_KIND.Dust;
    // The surface's own albedo × 1.15.
    s.albedo.setRGB(fx.dust[0] * 1.15, fx.dust[1] * 1.15, fx.dust[2] * 1.15);
    s.alpha = 0.28 * Math.min(1, power);
    s.erode = 0.5;
    s.selfShadow = 0.75;
    sink.soft(s);
  }

  // Sparks: 8–24 of them on hard surfaces, 1–3 px, 0.25–0.50 s, 2600 K, each
  // individually blooming. A spark without a glow is a dead pixel (§8.2).
  const sparkCount = Math.round(fx.spark * (8 + rng.int(17)) * power);
  for (let i = 0; i < sparkCount; i++) {
    const s = streakDefaults();
    s.position = V().copy(point).addScaledVector(n, 0.01);
    s.velocity = V()
      .copy(eject)
      .multiplyScalar(rng.range(3, 11) * power)
      .add(V(rng.gaussian() * 2.6, rng.gaussian() * 2.2, rng.gaussian() * 2.6));
    s.accel = V(0, -9.81, 0);
    s.lifetime = rng.range(0.25, 0.50);
    s.width = rng.range(0.008, 0.016);
    s.length = 0;
    // Real motion streaking: a 180° shutter at 60 fps is 8 ms of travel.
    s.streakSeconds = 0.010;
    s.drag = 1.4;
    s.seed = rng.next();
    // 2600 K: over-range core desaturating toward white, tail deep orange.
    s.color.setRGB(1.0, 0.86, 0.66);
    s.tail.setRGB(1.0, 0.34, 0.06);
    s.intensity = rng.range(4, 11);
    s.glow = 0.55;
    sink.streak(s);
  }

  // Chunks: 3–20 cm, individually rotating, 1.2–2.5 s.
  const chunkCount = Math.round(fx.chunks * power * 0.6);
  for (let i = 0; i < chunkCount; i++) {
    const vel = V()
      .copy(eject)
      .multiplyScalar(rng.range(1.5, 5.5) * power)
      .add(V(rng.gaussian() * 1.4, rng.gaussian() * 1.2 + 0.8, rng.gaussian() * 1.4));
    sink.debris(
      tmpD.copy(point).addScaledVector(n, 0.03),
      vel,
      fx.chunkSize * rng.range(0.7, 2.1),
      rng.range(1.2, 2.5),
      fx.restitution,
      fx.friction,
    );
  }
}

/** Water column + backlit mist, for `impact.water` and `waterSplash`. */
export function waterBurst(sink: Sink, point: Vec3, energyJ: number): void {
  const rng = sink.rng;
  const power = Math.min(2.2, Math.max(0.3, Math.sqrt(Math.max(energyJ, 1) / 1800)));
  for (let i = 0; i < 4 + rng.int(4); i++) {
    const s = softDefaults();
    s.position = V().copy(point).add(V(rng.gaussian() * 0.1, 0.02, rng.gaussian() * 0.1));
    s.velocity = V(rng.gaussian() * 1.2 * power, rng.range(2.5, 6.5) * power, rng.gaussian() * 1.2 * power);
    s.accel = V(0, -9.81, 0);
    s.lifetime = rng.range(0.5, 0.95);
    s.sizeStart = 0.06 * power;
    s.sizeEnd = 0.42 * power;
    s.drag = 2.2;
    s.spin = rng.range(-3, 3);
    s.seed = rng.next();
    s.kind = VFX_KIND.Dust;
    // Dense white foam that genuinely occludes (§8.5), not a translucent wash.
    s.albedo.setRGB(0.80, 0.82, 0.80);
    s.alpha = 0.55;
    s.erode = 0.45;
    s.selfShadow = 0.6;
    sink.soft(s);
  }
  // The fine backlit mist layer, which is the half that reads as water.
  for (let i = 0; i < 3; i++) {
    const s = softDefaults();
    s.position = V().copy(point).add(V(rng.gaussian() * 0.2, 0.15, rng.gaussian() * 0.2));
    s.velocity = V(rng.gaussian() * 0.6, rng.range(0.6, 1.8), rng.gaussian() * 0.6);
    s.accel = V(0, -1.2, 0);
    s.lifetime = rng.range(0.9, 1.5);
    s.sizeStart = 0.2 * power;
    s.sizeEnd = 1.1 * power;
    s.drag = 1.4;
    s.seed = rng.next();
    s.kind = VFX_KIND.Haze;
    s.albedo.setRGB(0.75, 0.79, 0.80);
    s.alpha = 0.10;
    s.erode = 0.3;
    s.selfShadow = 0.4;
    sink.soft(s);
  }
}

/* ============================================================================
 * EXPLOSIONS — LOOK_SPEC §8.3
 * ========================================================================= */

/**
 * Fireball, pressure ring, debris and a lingering column.
 *
 * The fireball is NOT a billboard: 6–12 primary lobes with sub-lobes at half
 * scale, each an individually-shaded medium element, so the body self-occludes
 * and silhouettes anything in front of it with a bright warm rim. Internal dark
 * soot filaments come from the erosion noise in the shader — voids at display
 * 60–90 immediately adjacent to 240+ cores, which is the structure that
 * separates a real fireball from a gradient blob.
 */
export function explosion(sink: Sink, point: Vec3, radius: number, energyJ: number): void {
  const rng = sink.rng;
  // §8.3: a rocket / 40 mm fireball is 4–9 m across. `radius` is the damage
  // radius, which is larger than the visible ball.
  const ball = Math.min(9, Math.max(3.2, radius * 0.62));
  const power = Math.min(2.4, Math.max(0.6, Math.cbrt(Math.max(energyJ, 1000) / 250_000)));

  // Zone 1: the core. Small — even a frame-filling flamethrower puts only 8.6 %
  // of pixels above display 215, so this is 2–3 lobes, not twelve.
  for (let i = 0; i < 3; i++) {
    const s = softDefaults();
    s.position = V().copy(point).add(V(rng.gaussian() * 0.3, rng.gaussian() * 0.25 + 0.2, rng.gaussian() * 0.3));
    s.velocity = V(rng.gaussian() * 2.2, rng.range(1.5, 4.0), rng.gaussian() * 2.2);
    s.accel = V(0, 1.4, 0);
    s.lifetime = rng.range(0.10, 0.16);
    s.sizeStart = ball * 0.15;
    s.sizeEnd = ball * 0.34;
    s.drag = 5.5;
    s.spin = rng.range(-3, 3);
    s.seed = rng.next();
    s.kind = VFX_KIND.Fire;
    s.erode = 0.18;
    s.alpha = 0.85;
    s.albedo.setRGB(0.05, 0.045, 0.04);
    s.emissive.setRGB(1.0, 0.94, 0.78);
    s.emissiveK = 9 * power;
    s.selfShadow = 0.15;
    sink.glow(s);
  }

  // Zones 2–3: body and cooling shell. 6–12 primary lobes plus sub-lobes.
  const lobes = 7 + rng.int(6);
  for (let i = 0; i < lobes; i++) {
    const dir = V(rng.gaussian(), rng.gaussian() * 0.8 + 0.55, rng.gaussian()).normalize();
    const primary = softDefaults();
    primary.position = V().copy(point).addScaledVector(dir, ball * rng.range(0.1, 0.42));
    primary.velocity = V().copy(dir).multiplyScalar(rng.range(4, 11) * power);
    primary.accel = V(0, 2.6, 0);
    primary.lifetime = rng.range(0.26, 0.52);
    primary.sizeStart = ball * rng.range(0.20, 0.34);
    primary.sizeEnd = ball * rng.range(0.5, 0.82);
    primary.drag = 4.0;
    primary.curl = 0.55;
    primary.curlScale = 0.45;
    primary.spin = rng.range(-2.5, 2.5);
    primary.seed = rng.next();
    primary.kind = VFX_KIND.Fire;
    primary.erode = 0.40;
    primary.alpha = 0.62;
    primary.albedo.setRGB(0.055, 0.05, 0.045);
    primary.emissive.setRGB(1.0, 0.40, 0.13);
    primary.emissiveK = 13 * power;
    primary.selfShadow = 0.55;
    sink.soft(primary);

    // Sub-lobes at half scale: the cauliflower structure. Two per primary.
    for (let j = 0; j < 2; j++) {
      const sub = softDefaults();
      sub.position = V()
        .copy(primary.position)
        .addScaledVector(dir, ball * rng.range(0.2, 0.55))
        .add(V(rng.gaussian() * ball * 0.16, rng.gaussian() * ball * 0.16, rng.gaussian() * ball * 0.16));
      sub.velocity = V().copy(primary.velocity).multiplyScalar(rng.range(0.7, 1.25));
      sub.accel = V(0, 2.2, 0);
      sub.lifetime = rng.range(0.4, 0.8);
      sub.sizeStart = ball * rng.range(0.10, 0.18);
      sub.sizeEnd = ball * rng.range(0.30, 0.48);
      sub.drag = 3.4;
      sub.curl = 0.7;
      sub.curlScale = 0.7;
      sub.spin = rng.range(-3, 3);
      sub.seed = rng.next();
      sub.kind = VFX_KIND.Fire;
      sub.erode = 0.58;
      sub.alpha = 0.5;
      sub.albedo.setRGB(0.06, 0.052, 0.046);
      // Zone 3, ≈1300 K: deep saturated red on the way to soot.
      sub.emissive.setRGB(0.85, 0.24, 0.10);
      sub.emissiveK = 4.5 * power;
      sub.selfShadow = 0.8;
      sink.soft(sub);
    }
  }

  // The pressure ring: a fast, low, ground-hugging annulus of displaced dust.
  // This is the element that gives an explosion a SCALE — without it the
  // fireball could be any size.
  const ringCount = 11;
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2 + rng.range(-0.12, 0.12);
    const s = softDefaults();
    s.position = V().copy(point).add(V(Math.cos(a) * ball * 0.55, 0.2, Math.sin(a) * ball * 0.55));
    s.velocity = V(Math.cos(a) * 17 * power, rng.range(0.3, 1.2), Math.sin(a) * 17 * power);
    s.accel = V(0, 0.35, 0);
    s.lifetime = rng.range(0.9, 1.5);
    s.sizeStart = ball * 0.16;
    s.sizeEnd = ball * rng.range(0.7, 1.05);
    s.drag = 3.2;
    s.curl = 0.25;
    s.curlScale = 0.6;
    s.spin = rng.range(-1.5, 1.5);
    s.seed = rng.next();
    s.kind = VFX_KIND.Dust;
    s.albedo.setRGB(0.46, 0.40, 0.31);
    // Thin: the ring exists to give the burst a SCALE, and every point of
    // alpha it carries is veiling the fireball it is supposed to be measuring.
    s.alpha = 0.15;
    s.erode = 0.62;
    s.selfShadow = 0.7;
    sink.soft(s);
  }

  // Zone 4: the soot cap, which SEPARATES from the fireball as it rises. Long
  // lived, dark core, sheared by wind, and it is what remains in frame.
  for (let i = 0; i < 9; i++) {
    const s = softDefaults();
    const a = rng.range(0, Math.PI * 2);
    s.position = V().copy(point).add(V(Math.cos(a) * ball * 0.28, ball * rng.range(0.15, 0.6), Math.sin(a) * ball * 0.28));
    s.velocity = V(Math.cos(a) * 1.6, rng.range(3.2, 6.5), Math.sin(a) * 1.6);
    s.accel = V(0, 0.9, 0);
    s.lifetime = rng.range(5.5, 9.0);
    s.sizeStart = ball * 0.32;
    s.sizeEnd = ball * rng.range(1.4, 2.2);
    s.drag = 1.1;
    s.curl = 1.1;
    s.curlScale = 0.22;
    s.spin = rng.range(-0.8, 0.8);
    s.seed = rng.next();
    s.kind = VFX_KIND.Smoke;
    // Dense core (60, 50, 42) display → linear ≈ 0.05. Never a mid grey.
    s.albedo.setRGB(0.062, 0.054, 0.046);
    s.alpha = 0.50;
    s.erode = 0.5;
    s.selfShadow = 1.0;
    sink.soft(s);
  }

  // Ejecta: 8–18 real chunks, and they bounce.
  for (let i = 0; i < 12 + rng.int(7); i++) {
    const dir = V(rng.gaussian(), Math.abs(rng.gaussian()) * 1.4 + 0.4, rng.gaussian()).normalize();
    sink.debris(
      tmpD.copy(point).addScaledVector(dir, 0.5),
      tmpE.copy(dir).multiplyScalar(rng.range(6, 20) * power),
      rng.range(0.05, 0.2),
      rng.range(1.6, 3.0),
      0.28,
      0.7,
    );
  }

  // Embers thrown clear of the ball.
  for (let i = 0; i < 18 + rng.int(14); i++) {
    const s = streakDefaults();
    const dir = V(rng.gaussian(), Math.abs(rng.gaussian()) + 0.3, rng.gaussian()).normalize();
    s.position = V().copy(point).addScaledVector(dir, ball * rng.range(0.2, 0.7));
    s.velocity = V().copy(dir).multiplyScalar(rng.range(4, 16) * power);
    s.accel = V(0, -6.2, 0);
    s.lifetime = rng.range(1.5, 4.0);
    s.width = rng.range(0.012, 0.030);
    s.streakSeconds = 0.014;
    s.drag = 1.1;
    s.seed = rng.next();
    // §8.4 ember ramp: (255, 200, 140) → (120, 40, 15).
    s.color.setRGB(1.0, 0.78, 0.55);
    s.tail.setRGB(0.47, 0.16, 0.06);
    s.intensity = rng.range(1.6, 4.2);
    s.glow = 0.85;
    sink.streak(s);
  }

  // §2.7: 2.5e6 cd peak → 0 over 0.55 s, 2200 K → 1300 K, 60 m radius.
  // Source radius = the visible ball. Without it, 1/r² inside the fireball is a
  // singularity and everything within 5 m — including the fireball's own dust
  // ring — clips to white.
  // 9e5 cd, not the §2.7 headline 2.5e6. The two numbers have to AGREE: a
  // Lambertian ball of radius R and luminance L radiates I ≈ L·π·R², and the
  // fireball this recipe actually draws comes out at ~1.2e4 cd/m² over a 5 m
  // ball, i.e. ~9e5 cd. Feeding 2.5e6 into the medium makes every dust sheet
  // within 10 m brighter than the fireball lighting it, which is what turned
  // the whole burst into a white cloud. The WORLD light below keeps the spec
  // value — that is LIGHT's calibration, not this lane's.
  sink.emitter(point, new THREE.Color(1.0, 0.52, 0.20), 9.0e5 * power, 60, 0.55, ball * 0.55);
}

/* ============================================================================
 * TRACERS AND WHIZBY — LOOK_SPEC §8.1
 * ========================================================================= */

/**
 * A velocity-stretched rod, 1.8–3.2 m long, 4–7 cm wide, 15–25:1 aspect. The
 * core is warm-white over-range (255, 215, 195); the tail is amber. It casts no
 * world light — a tracer that lights a wall is a common and very visible error.
 */
export function tracer(sink: Sink, from: Vec3, to: Vec3, speedMs: number): void {
  const rng = sink.rng;
  const delta = tmpA.copy(to).sub(from);
  const dist = delta.length();
  if (dist < 0.5) return;
  const dir = tmpB.copy(delta).divideScalar(dist);
  const speed = Math.max(120, speedMs);

  const s = streakDefaults();
  s.position = V().copy(from).addScaledVector(dir, 0.35);
  s.velocity = V().copy(dir).multiplyScalar(speed);
  // Visible gravity drop over the time of flight.
  s.accel = V(0, -9.81, 0);
  s.lifetime = Math.min(1.4, dist / speed);
  s.width = rng.range(0.042, 0.068);
  s.length = rng.range(1.8, 3.2);
  s.streakSeconds = 0;
  s.drag = 0.02;
  s.seed = rng.next();
  s.color.setRGB(1.0, 0.845, 0.765);
  s.tail.setRGB(1.0, 0.55, 0.235);
  s.intensity = 5.5;
  // Glow is 3× the core width; the fragment shader's exponent pair does that.
  s.glow = 1.0;
  sink.streak(s);
}

/** A near miss: a short bright shear right past the ear, gone in 60 ms. */
export function whizby(sink: Sink, point: Vec3, missDistance: number, supersonic: boolean): void {
  const rng = sink.rng;
  const s = streakDefaults();
  s.position = V().copy(point);
  s.velocity = V(rng.gaussian(), rng.gaussian() * 0.3, rng.gaussian()).normalize().multiplyScalar(340);
  s.accel = V();
  s.lifetime = 0.05;
  s.width = 0.03;
  s.length = supersonic ? 4.5 : 2.2;
  s.streakSeconds = 0.02;
  s.drag = 0;
  s.seed = rng.next();
  s.color.setRGB(0.85, 0.86, 0.88);
  s.tail.setRGB(0.5, 0.52, 0.55);
  // Falls off hard with miss distance: a round 4 m away is not a visual event.
  s.intensity = Math.max(0, 1.6 - missDistance * 0.5);
  s.glow = 0.3;
  if (s.intensity > 0.05) sink.streak(s);
}

/* ============================================================================
 * GROUND AND DESTRUCTION DUST — LOOK_SPEC §8.4
 * ========================================================================= */

/**
 * Vehicle / footfall / destruction dust. §8.4: stays under 2 m, spreads 3–8 m,
 * tinted the exact colour of the ground it came from, warmer, lower, faster and
 * lower-opacity than smoke, and it moves as SHEETS, not puffs — which is why
 * these are wide, flat and short-lived rather than round and buoyant.
 */
export function groundDust(
  sink: Sink,
  point: Vec3,
  surface: SurfaceId,
  strength: number,
  spread: number,
): void {
  const rng = sink.rng;
  const fx = surfaceFx(surface);
  const n = Math.max(2, Math.round(4 * strength));
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const s = softDefaults();
    s.position = V().copy(point).add(V(Math.cos(a) * spread * 0.3, 0.12 + rng.next() * 0.25, Math.sin(a) * spread * 0.3));
    s.velocity = V(Math.cos(a) * spread * rng.range(0.7, 1.5), rng.range(0.25, 0.9), Math.sin(a) * spread * rng.range(0.7, 1.5));
    // Slight downdraft: dust sheets hug the ground rather than mushrooming.
    s.accel = V(0, -0.35, 0);
    s.lifetime = rng.range(1.0, 1.5);
    s.sizeStart = spread * rng.range(0.2, 0.35);
    s.sizeEnd = spread * rng.range(0.9, 1.5);
    s.drag = 2.4;
    s.curl = 0.2;
    s.curlScale = 0.9;
    s.spin = rng.range(-1.2, 1.2);
    s.seed = rng.next();
    s.kind = VFX_KIND.Dust;
    s.albedo.setRGB(fx.dust[0] * 1.15, fx.dust[1] * 1.15, fx.dust[2] * 1.15);
    s.alpha = 0.18 * Math.min(1.4, strength);
    s.erode = 0.62;
    s.selfShadow = 0.6;
    sink.soft(s);
  }
}

/** A wall coming down: a lot of ground dust plus tumbling masonry. */
export function destructionDust(sink: Sink, point: Vec3, normal: Vec3, surface: SurfaceId, count: number): void {
  const rng = sink.rng;
  const fx = surfaceFx(surface);
  const n = Math.min(14, Math.max(3, count));
  const nrm = tmpA.copy(normal).normalize();
  for (let i = 0; i < n; i++) {
    const s = softDefaults();
    s.position = V().copy(point).add(V(rng.gaussian() * 0.6, rng.gaussian() * 0.7, rng.gaussian() * 0.6));
    s.velocity = V()
      .copy(nrm)
      .multiplyScalar(rng.range(0.8, 3.0))
      .add(V(rng.gaussian() * 1.0, rng.range(0.4, 1.8), rng.gaussian() * 1.0));
    s.accel = V(0, -0.5, 0);
    s.lifetime = rng.range(1.6, 3.2);
    s.sizeStart = rng.range(0.3, 0.6);
    s.sizeEnd = rng.range(1.8, 3.4);
    s.drag = 1.8;
    s.curl = 0.35;
    s.curlScale = 0.55;
    s.spin = rng.range(-1.0, 1.0);
    s.seed = rng.next();
    s.kind = VFX_KIND.Dust;
    s.albedo.setRGB(fx.dust[0] * 1.15, fx.dust[1] * 1.15, fx.dust[2] * 1.15);
    s.alpha = 0.28;
    s.erode = 0.55;
    s.selfShadow = 0.75;
    sink.soft(s);
  }
  for (let i = 0; i < Math.min(10, n); i++) {
    sink.debris(
      tmpB.copy(point).add(V(rng.gaussian() * 0.5, rng.gaussian() * 0.5, rng.gaussian() * 0.5)),
      tmpC.copy(nrm).multiplyScalar(rng.range(1, 4)).add(V(rng.gaussian(), rng.range(0.5, 2.5), rng.gaussian())),
      rng.range(0.06, 0.19),
      rng.range(1.8, 3.2),
      fx.restitution,
      fx.friction,
    );
  }
}

/** A brass case, tumbling, catching the key light. §8.1: 9–14 mm, 2.5 s. */
export function shellEject(sink: Sink, position: Vec3, velocity: Vec3): void {
  const rng = sink.rng;
  sink.debris(position, velocity, 0.012 + rng.next() * 0.004, 2.5, 0.42, 0.35);
}
