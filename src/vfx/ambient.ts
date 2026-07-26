/**
 * VFX — ambient participating media.
 *
 * OWNER: VFX.
 *
 * AAA_RUBRIC calibration note #1, ranked FIRST of ten: *there is no clear air,
 * ever; every reference frame is 30–50 % particulate by area.* LOOK_SPEC §3.3
 * puts the same requirement in numbers — 12–20 % of frame area behind at least
 * one translucent layer in a quiet frame, 35–55 % in combat, and NEVER 0 %.
 *
 * THE TENSION IN THE SPEC, AND HOW THIS FILE RESOLVES IT
 * ------------------------------------------------------
 * §3.3 also says, in the same breath, that "ambient atmosphere dust motes
 * floating in the air are a demo signature" and that the reference uses the fog
 * integral instead. Those two statements are only contradictory if you read
 * "particulate" as "motes". They are not the same thing:
 *
 *  - The 30–50 % is LARGE, SOFT, LOW-CONTRAST BODIES — harbour haze, drifting
 *    dust sheets, the far end of a smoke column, sea mist off the breakwater.
 *    They are metres to tens of metres across, they carry 3–8 % alpha each,
 *    and they are what puts three separated luminance bands in a frame.
 *  - The demo signature is SMALL BRIGHT SPECKS scattered uniformly through the
 *    air at constant density regardless of light.
 *
 * So this file ships a great deal of the first and a deliberately small,
 * strongly phase-gated amount of the second. The motes exist only near the
 * ground, only within 16 m, and their brightness is driven by the
 * Henyey-Greenstein term — so they light up where the sun is behind them and
 * disappear everywhere else, which is exactly the behaviour of real backlit
 * dust and the opposite of a uniform sparkle field.
 *
 * CAMERA-RELATIVE, DETERMINISTICALLY SEEDED
 * -----------------------------------------
 * Bodies live in a shell around the camera and are recycled when they leave it.
 * Their seeds come from a stable integer index through a hash, not from a live
 * RNG draw, so the field is IDENTICAL for a given camera pose and sim time no
 * matter what else spawned this frame. That property is what keeps two
 * captures of the same shot byte-identical when combat VFX are also in flight.
 */
import * as THREE from 'three';
import { hashInt } from '@/engine/math';
import { MACRO_TERRAIN } from '@/engine/macro';
import type { SkyService, Vec3 } from '@/engine/types';
import { VFX_KIND } from '@/vfx/glsl';
import type { SoftPool, SoftSpawn, StreakPool, StreakSpawn } from '@/vfx/pools';

/** Deterministic unit float from an integer index and a channel. */
function h(index: number, channel: number): number {
  return (hashInt(index * 2654435761 + channel * 40503) >>> 8) / 16777216;
}

interface Body {
  /** Stable index; the seed source. */
  readonly id: number;
  readonly position: THREE.Vector3;
  readonly drift: THREE.Vector3;
  radius: number;
  alpha: number;
}

export interface AmbientConfig {
  /** Large haze bodies in the shell. The dominant contributor to frame area. */
  readonly hazeBodies: number;
  /** Near-ground backlit motes. Small on purpose. */
  readonly motes: number;
  /** Sea-spray bodies, only emitted below the spray ceiling. */
  readonly sprayBodies: number;
  /** Inner and outer radius of the haze shell, metres. */
  readonly innerRadius: number;
  readonly outerRadius: number;
  /** Ceiling of the haze shell above the camera, metres. */
  readonly ceiling: number;
}

/**
 * Body counts are SMALL, alphas are thin, and the inner radius is well out.
 *
 * The inner radius matters more than either of the other two. `bf6_gp_038` is
 * a bright-daylight infantry frame whose nearest 20 m is essentially CLEAR
 * AIR — the "no clear air, ever" rule is about DISTANCE, not about the space
 * between you and the wall in front of you. A haze body at 15 m veils the
 * near-field occluder that §7.2 needs to be 2–4× darker than the midground,
 * and flattens exactly the depth separation the field exists to create.
 *
 * The frame-area target in §3.3 is met by depth of layering, not by count: four
 * or five bodies along a sightline at 5–14 % each land the whole frame at
 * 30–45 % veiling, and each additional body past that costs a full screen of
 * alpha-blended overdraw for a difference nobody can see. The inner radius is
 * deliberately well beyond arm's length so no single body can fill the frame on
 * its own — a near, huge, low-alpha card is the one failure mode that reads as
 * a dirty lens rather than as air.
 */
export const AMBIENT_TIERS: Readonly<Record<number, AmbientConfig>> = {
  0: { hazeBodies: 20, motes: 0, sprayBodies: 4, innerRadius: 26, outerRadius: 95, ceiling: 20 },
  1: { hazeBodies: 32, motes: 34, sprayBodies: 7, innerRadius: 25, outerRadius: 118, ceiling: 24 },
  2: { hazeBodies: 44, motes: 54, sprayBodies: 10, innerRadius: 24, outerRadius: 138, ceiling: 28 },
  3: { hazeBodies: 56, motes: 72, sprayBodies: 13, innerRadius: 24, outerRadius: 158, ceiling: 32 },
};

/** Sea level in HARBOUR REACH. Spray only exists near it. */
const SEA_LEVEL = 0;

export class AmbientField {
  private readonly haze: Body[] = [];
  private readonly spray: Body[] = [];
  private readonly motes: Body[] = [];
  private readonly spawn: SoftSpawn;
  private readonly moteSpawn: StreakSpawn;
  private readonly anchor = new THREE.Vector3();
  private nextId = 1;

  constructor(
    private config: AmbientConfig,
    spawnTemplate: SoftSpawn,
    moteTemplate: StreakSpawn,
  ) {
    this.spawn = spawnTemplate;
    this.moteSpawn = moteTemplate;
  }

  setConfig(config: AmbientConfig): void {
    this.config = config;
    this.reset();
  }

  reset(): void {
    this.haze.length = 0;
    this.spray.length = 0;
    this.motes.length = 0;
    this.nextId = 1;
    this.anchor.set(1e9, 1e9, 1e9);
  }

  /**
   * Re-seed the field around `camera` and push every body into the pools.
   *
   * The pools are cleared and refilled every frame rather than persisted: a
   * particle in this lane is 32 floats written once, so refilling ~200 slots
   * costs a few thousand float writes and buys a field that can follow the
   * camera, respond to a tier change and survive a harness reset with no
   * lifetime bookkeeping at all.
   */
  update(
    now: number,
    dt: number,
    camera: Vec3,
    sky: SkyService,
    pool: SoftPool,
    motePool: StreakPool,
  ): void {
    const cfg = this.config;
    const state = sky.state;
    const windDir = new THREE.Vector3(Math.cos(state.windDirectionRad), 0, Math.sin(state.windDirectionRad));
    const windSpeed = state.windSpeed;

    if (this.haze.length !== cfg.hazeBodies) this.seedHaze(camera);
    if (this.spray.length !== cfg.sprayBodies) this.seedSpray(camera);
    if (this.motes.length !== cfg.motes) this.seedMotes(camera);

    // Re-anchor when the camera has moved far enough that the shell would
    // otherwise be visibly lopsided. Under the harness the camera is static, so
    // this fires once, on the first frame, and the field is then stable.
    if (this.anchor.distanceToSquared(camera) > 400) {
      this.anchor.copy(camera);
      this.reseedAround(camera);
    }

    // Density: the sky's own dust and fog terms drive how much of the frame is
    // behind media, so a weather change moves the whole field rather than only
    // the fog integral. 0.35 dust / 0.0032 fog is the GOLDEN preset anchor.
    // Kept near 1: the per-body alphas below are already the §3.3 budget, and
    // weather moves it by tens of percent, not by multiples. A density that can
    // reach 2 stacks four bodies into an opaque wall of milk.
    const density = Math.min(1.35, 0.72 + state.dustDensity * 0.55 + state.fogDensity * 40 + state.overcast * 0.35);

    for (const b of this.haze) {
      b.position.addScaledVector(windDir, windSpeed * 0.22 * dt);
      b.position.addScaledVector(b.drift, dt);
      this.wrap(b, camera, cfg.innerRadius, cfg.outerRadius, cfg.ceiling);
      // Float the body clear of the ground under it. A 25 m sphere whose centre
      // sits at head height is half buried, and the buried half is clipped by
      // the depth fade into a flat pale patch lying on the plaza — the exact
      // artefact §8 calls out for hard-edged cards intersecting the ground.
      // MACRO_TERRAIN is the frozen analytic silhouette every lane shares, so
      // this agrees with the ground TERRAIN actually builds.
      const floor = MACRO_TERRAIN.height(b.position.x, b.position.z) + b.radius * 0.55;
      if (b.position.y < floor) b.position.y = floor;
      const s = this.spawn;
      s.position.copy(b.position);
      // Zero initial velocity and acceleration: the drift is integrated on the
      // CPU above (it has to be, so bodies can WRAP around the camera), and the
      // shader's closed-form path would otherwise apply it a second time over
      // the body's whole 60-second apparent age.
      s.velocity.set(0, 0, 0);
      s.accel.set(0, 0, 0);
      // A long lifetime with the birth pushed into the past: the shader's
      // rise/fall envelope then sits in its flat middle and the body neither
      // pops in nor fades out while it is on screen.
      s.lifetime = 400;
      s.sizeStart = b.radius;
      s.sizeEnd = b.radius * 1.35;
      s.drag = 0;
      s.curl = 0;
      s.curlScale = 0.05;
      s.spin = 0;
      s.seed = h(b.id, 7);
      s.kind = VFX_KIND.Haze;
      s.erode = 0;
      s.selfShadow = 0.55;
      // Marine haze albedo: high single-scatter albedo, very slightly warm —
      // it is water and dust, not soot.
      s.albedo.setRGB(0.80, 0.78, 0.75);
      s.alpha = b.alpha * density;
      s.emissiveK = 0;
      pool.spawn(now - 60, s);
    }

    // Sea spray: only when the camera is low enough for the breakwater to be a
    // real part of the frame. Above that it is invisible and would be waste.
    if (camera.y < 26) {
      for (const b of this.spray) {
        b.position.addScaledVector(windDir, windSpeed * 0.5 * dt);
        this.wrap(b, camera, 8, 70, 9);
        b.position.y = SEA_LEVEL + 0.6 + h(b.id, 11) * 4.0;
        const s = this.spawn;
        s.position.copy(b.position);
        s.velocity.set(0, 0, 0);
        s.accel.set(0, 0, 0);
        s.lifetime = 400;
        s.sizeStart = b.radius * 0.7;
        s.sizeEnd = b.radius;
        s.drag = 0;
        s.curl = 0;
        s.curlScale = 0.05;
        s.spin = 0;
        s.seed = h(b.id, 13);
        s.kind = VFX_KIND.Haze;
        s.erode = 0;
        s.selfShadow = 0.4;
        // Backlit sea mist is the brightest medium in the map after the fire.
        s.albedo.setRGB(0.86, 0.88, 0.88);
        s.alpha = b.alpha * density * 1.2;
        s.emissiveK = 0;
        pool.spawn(now - 60, s);
      }
    }

    // The motes. Small, near, and gated by the phase function in the shader —
    // they are rods with zero fixed length and a tiny width, so they streak
    // very slightly with their own drift and read as suspended matter rather
    // than as a sparkle overlay.
    for (const b of this.motes) {
      b.position.addScaledVector(b.drift, dt);
      b.position.addScaledVector(windDir, windSpeed * 0.08 * dt);
      this.wrap(b, camera, 1.5, 16, 5);
      const m = this.moteSpawn;
      m.position.copy(b.position);
      // Same reason as the haze: the drift is already integrated on the CPU.
      // The streak shader still needs a NON-ZERO velocity to orient the rod, so
      // it gets the drift direction at a scale that cannot displace it —
      // `drag` is zero but `streakSeconds` is what sets the visible length.
      m.velocity.copy(b.drift).multiplyScalar(0.0001);
      m.accel.set(0, 0, 0);
      m.lifetime = 400;
      m.width = b.radius;
      // A mote is a very short rod, not a point: slightly taller than it is
      // wide so it carries a hint of motion streaking even at rest.
      m.length = b.radius * 2.4;
      m.streakSeconds = 0;
      m.drag = 0;
      m.seed = h(b.id, 17);
      m.color.setRGB(1.0, 0.93, 0.80);
      m.tail.setRGB(0.9, 0.86, 0.78);
      // In MULTIPLES OF MID GREY (see `uVfxEmissiveScale`): 0.02–0.09, i.e.
      // display 25–60 additive. At that level they read as matter catching the
      // light. Raising this is the fastest way in the whole lane to look like a
      // demo, because a field of bright specks is the literal demo signature.
      m.intensity = b.alpha * 1.6 * density;
      m.glow = 0.5;
      motePool.spawn(now - 60, m);
    }
  }

  /**
   * Keep a body inside the shell around the camera.
   *
   * A body that leaves is REFLECTED through the camera to the far side rather
   * than re-randomised: reflection preserves the field's density exactly and
   * puts the body behind the viewer, so nothing ever pops into existence in
   * the middle of frame. The degenerate case (a body exactly on the camera
   * axis) falls back to a hashed position on the shell.
   */
  private wrap(b: Body, camera: Vec3, inner: number, outer: number, ceiling: number): void {
    const dx = b.position.x - camera.x;
    const dz = b.position.z - camera.z;
    const dy = b.position.y - camera.y;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= outer && d >= inner * 0.5 && dy < ceiling && dy > -ceiling) return;
    if (d > 1e-3) {
      const k = (outer * 0.97) / d;
      b.position.set(camera.x - dx * k, camera.y + (h(b.id, 31) * 0.95 - 0.34) * ceiling, camera.z - dz * k);
      return;
    }
    const a = h(b.id, 23) * Math.PI * 2;
    const r = inner + h(b.id, 29) * (outer - inner);
    b.position.set(camera.x + Math.cos(a) * r, camera.y + h(b.id, 31) * ceiling * 0.6, camera.z + Math.sin(a) * r);
  }

  private seedHaze(camera: Vec3): void {
    this.haze.length = 0;
    for (let i = 0; i < this.config.hazeBodies; i++) this.haze.push(this.makeHaze(i, camera));
  }

  private makeHaze(i: number, camera: Vec3): Body {
    const id = this.nextId++;
    const cfg = this.config;
    // Golden-angle spiral in the horizontal plane: a stratified distribution
    // with no clumping and no visible grid, from an integer index alone.
    const a = i * 2.39996323;
    const t = (i + 0.5) / Math.max(1, cfg.hazeBodies);
    const r = cfg.innerRadius + Math.sqrt(t) * (cfg.outerRadius - cfg.innerRadius);
    // Bodies get LARGER with distance, so the far field is a few big soft
    // masses and the near field is a few small ones. That is what produces an
    // aerial-perspective ladder instead of a uniform grey wash.
    const radius = 5.5 + (r / cfg.outerRadius) * 20 + h(id, 3) * 7;
    return {
      id,
      position: new THREE.Vector3(
        camera.x + Math.cos(a) * r,
        // Biased LOW. A haze body silhouetted against open sky has nothing to
        // veil and reads as a discrete cloud; the value is in the band between
        // the camera and the skyline, where it separates the depth planes.
        camera.y + (h(id, 5) * 0.95 - 0.34) * cfg.ceiling,
        camera.z + Math.sin(a) * r,
      ),
      drift: new THREE.Vector3((h(id, 41) - 0.5) * 0.16, (h(id, 43) - 0.5) * 0.05, (h(id, 47) - 0.5) * 0.16),
      radius,
      // 5–14 % each. Four or five overlapping along a sightline land the frame
      // at the §3.3 target without any single body being individually visible.
      // 0.35–1.1 % each. MEASURED, not guessed: at 1–3 % the same field lifted
      // the frame's p0.1 luminance from the reference's 0 to 67 and collapsed
      // the p25–p75 spread to 25 levels against the reference's 92. LOOK_SPEC
      // §3.3's "12–20 % of frame area behind a translucent layer" is a COVERAGE
      // figure, not an opacity; reading it as opacity puts a 35 % white veil
      // over the whole image and destroys the black point, which §5.2 calls the
      // one property worth spending your time on. SKY already carries the §3.2
      // aerial-perspective integral for world geometry — this field's job is
      // the STRUCTURE on top of it, not a second atmosphere.
      alpha: 0.0035 + h(id, 53) * 0.0075,
    };
  }

  private seedSpray(camera: Vec3): void {
    this.spray.length = 0;
    for (let i = 0; i < this.config.sprayBodies; i++) {
      const id = this.nextId++;
      const a = i * 2.39996323;
      const r = 8 + ((i + 0.5) / Math.max(1, this.config.sprayBodies)) * 62;
      this.spray.push({
        id,
        position: new THREE.Vector3(camera.x + Math.cos(a) * r, SEA_LEVEL + 1.2, camera.z + Math.sin(a) * r),
        drift: new THREE.Vector3((h(id, 59) - 0.5) * 0.3, 0, (h(id, 61) - 0.5) * 0.3),
        radius: 3.5 + h(id, 67) * 6.5,
        alpha: 0.006 + h(id, 71) * 0.010,
      });
    }
  }

  private seedMotes(camera: Vec3): void {
    this.motes.length = 0;
    for (let i = 0; i < this.config.motes; i++) {
      const id = this.nextId++;
      const a = i * 2.39996323;
      const r = 1.5 + Math.sqrt((i + 0.5) / Math.max(1, this.config.motes)) * 14.5;
      this.motes.push({
        id,
        position: new THREE.Vector3(
          camera.x + Math.cos(a) * r,
          camera.y + (h(id, 73) * 1.6 - 0.9) * 2.6,
          camera.z + Math.sin(a) * r,
        ),
        drift: new THREE.Vector3((h(id, 79) - 0.5) * 0.10, (h(id, 83) - 0.42) * 0.06, (h(id, 89) - 0.5) * 0.10),
        // 3–6 px at typical distance: 1–2 cm at 4 m.
        radius: 0.012 + h(id, 97) * 0.016,
        alpha: 0.03 + h(id, 101) * 0.06,
      });
    }
  }

  private reseedAround(camera: Vec3): void {
    this.seedHaze(camera);
    this.seedSpray(camera);
    this.seedMotes(camera);
  }
}
