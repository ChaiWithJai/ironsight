/**
 * ViewmodelRig — THE one place sway, bob, ADS and kick are composed.
 *
 * OWNER: WEAPONS.
 *
 * The viewmodel gets its OWN camera (near 0.01 / far 6) with the depth range
 * remapped, so the weapon can never clip a wall and never eats world depth
 * precision. Its velocity comes from the VIEWMODEL RIG'S own previous
 * transform, not the camera's — use the camera's and TAA smears the gun every
 * time the player turns. `root` is snapped onto the camera each frame and every
 * mesh caches `userData.prevMatrixWorld` for exactly that reason.
 *
 * WHY THIS IS ONE FUNCTION AND NOT EIGHT
 * --------------------------------------
 * Weapon feel is the most tactile thing in an FPS and it is also the easiest
 * thing in an engine to smear across a codebase: sway in an input handler, bob
 * in a locomotion system, ADS in the camera, kick in the fire-control tick.
 * Once that happens nobody can answer "why does the gun feel floaty" without
 * reading four files, and every fix breaks one of the other three. So the whole
 * composition is `composePose()` below, in a fixed and documented order, and
 * EVERY constant it uses comes out of `WeaponDef.view` / `WeaponDef.ads`.
 *
 * THE COMPOSITION ORDER (and why each layer is where it is)
 *
 *   1  base pose       hip ⇄ ADS, on the eased `AdsDef.curve` over `AdsDef.time`
 *   2  sprint pose     additive, suppressed by ADS — you cannot aim while sprinting
 *   3  sway            a SPRING chasing the look rate, so the weapon LAGS the
 *                      camera. This is the single biggest "is it alive" cue and
 *                      it must be a second-order system: a lerp toward a target
 *                      has no overshoot and reads as a weapon on rails.
 *   4  bob             phase advanced by DISTANCE TRAVELLED, not by time, so it
 *                      stays in step with footfalls at any speed; amplitude
 *                      damps to zero on stop and the phase walks to the nearest
 *                      whole cycle (feet together) as it goes.
 *   5  landing dip     an impulse into the same kick spring family, sized by the
 *                      vertical speed that was actually arrested
 *   6  breathing       ~1 mm at 0.22 Hz. Invisible as motion, unmistakable as
 *                      life; it is what stops a stationary frame reading as a
 *                      screenshot of a static mesh.
 *   7  lean            residual only — `CameraRig` already rolls the eye
 *   8  recoil          underdamped springs, so the weapon overshoots BELOW the
 *                      line of sight on the way home and settles from
 *                      underneath. That undershoot is the recognisable part.
 *   9  clip            reload / inspect, which OWNS the frame while it runs and
 *                      scales 3, 4 and 6 down by its weight
 *
 * Nothing here can move a bullet. `WeaponState.aimPunch` is the sim recoil and
 * lives in `system.ts`; everything in this file is cosmetic by construction,
 * which is what makes the crosshair incapable of lying.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  RenderStage,
  SceneGroup,
  Sim,
  Stance,
  type AssetRegistry,
  type BootContext,
  type FrameCtx,
  type QualitySettings,
  type PlayerState,
  type Vec3,
  type ViewmodelRig,
  type WeaponDef,
  type WeaponFeelState,
  type WeaponId,
  type WeaponState,
} from '@/engine/types';
import { angleDelta, clamp, clamp01, damp, lerp, moveTowards, DEG2RAD, TAU } from '@/engine/math/curves';
import { ease } from '@/engine/math/easing';
import { impulse, integrateSpring, integrateSpring3, type Spring1 } from '@/engine/math/spring';
import { declareHandAssets, handsAssetKey, weaponModelKey, WEAPON_IDS } from '@/weapons/models/assets';
import type { PartNode, PartRole, WeaponModel } from '@/weapons/models/build';
import { mergeParts } from '@/weapons/models/prim';
import { buildViewmodelMaterials, type RoleMaterials } from '@/weapons/viewmodel/materials';
import {
  boltCycle,
  clearClip,
  makeClipPose,
  sampleInspect,
  sampleReload,
  triggerBreak,
  type ClipPose,
} from '@/weapons/viewmodel/anim';

const NODES: readonly PartNode[] = ['body', 'magazine', 'charging', 'trigger', 'handL', 'handR'];

/**
 * Cosmetic springs are integrated with the REAL frame dt, which is the only
 * correct clock for them — but a 200 ms hitch must not launch a stiff spring
 * across the screen. 50 ms is the clamp; past that the weapon simply moves less
 * than it should for one frame, which nobody can see and nothing can destabilise.
 */
const MAX_SPRING_DT = 1 / 20;

/**
 * Ground speed below which the player counts as stationary and the bob settles.
 * A THRESHOLD, not a feel constant: it exists to answer "is this person walking",
 * and 0.35 m/s is slower than any deliberate movement and faster than the
 * residual velocity a character controller leaves after a stop.
 */
const MOVING_EPSILON = 0.35;

/**
 * Cadence, in strides per second, at which the bob is at its authored full
 * amplitude. Two per second is the human walking default and it is a property of
 * PEOPLE, not of a weapon, which is why it is here and not in `WeaponDef`. The
 * speed it corresponds to falls out of the weapon's own `cyclesPerMetre`, so a
 * class authored with a longer stride reaches full bob at a higher speed without
 * anyone editing this file.
 */
const WALK_CADENCE_HZ = 2;

/**
 * How far the viewmodel's key and rim point lights stand off the eye, in metres,
 * and the d² factor that turns a requested illuminance into the candela three
 * wants. See the light-rig comment in `IronViewmodel` for why they are point
 * lights at all.
 *
 * 24 m is chosen against the weapon, not the world: across the 0.55 m from the
 * buttpad to the muzzle the light direction swings 1.3° and the inverse-square
 * falloff varies by ±2.3 %. Both are below the threshold at which anyone could
 * tell this from a directional light, and the residual falloff is in the right
 * direction anyway — the muzzle is further from the shooter's shoulder and
 * genuinely does sit a hair darker in every reference frame.
 */
const VM_LIGHT_DISTANCE = 24;
const VM_LIGHT_FALLOFF = VM_LIGHT_DISTANCE * VM_LIGHT_DISTANCE;

type MutableFeel = { -readonly [K in keyof WeaponFeelState]: WeaponFeelState[K] };

interface WeaponRigInstance {
  readonly id: WeaponId;
  readonly model: WeaponModel;
  readonly root: THREE.Group;
  readonly nodes: Readonly<Record<PartNode, THREE.Group>>;
  readonly meshes: readonly THREE.Mesh[];
}

class IronViewmodel implements ViewmodelRig {
  /** World space, snapped onto the camera every frame. */
  readonly root = new THREE.Group();
  /** Everything the feel layer produces lands on this one node. */
  private readonly pivot = new THREE.Group();

  private readonly feel: MutableFeel = {
    adsBlend: 0,
    sprintBlend: 0,
    bobPhase: 0,
    positionOffset: new THREE.Vector3(),
    rotationOffset: new THREE.Vector3(),
    cameraKick: new THREE.Vector3(),
    fovMultiplier: 1,
    muzzleWorld: new THREE.Vector3(),
    muzzleDirection: new THREE.Vector3(0, 0, -1),
    secondsSinceFire: 99,
  };

  private rigs = new Map<WeaponId, WeaponRigInstance>();
  private active: WeaponRigInstance | null = null;
  private materials: RoleMaterials | null = null;

  /**
   * THE VIEWMODEL LIGHT RIG — three lights that exist only on
   * `RenderLayer.Viewmodel`, and the reason they have to exist.
   *
   * A light contributes to a draw only when `light.layers` intersects the
   * CAMERA's layers, and the viewmodel is drawn through its own camera with
   * `layers.set(RenderLayer.Viewmodel)`. Every world light sits on layer 0, so
   * from the viewmodel camera's point of view the world is pitch dark and the
   * weapon renders as a pure black silhouette — which is the top item on the
   * brief's defect list, and it is not a shading problem, it is an arithmetic
   * one. These three are the answer, and they are also what every shipped
   * shooter does: a viewmodel is 25 cm from the eye and cannot be left to
   * whatever the world lighting happens to be doing, or the weapon disappears
   * every time the player walks into a shadow.
   *
   * KEY tracks the world sun in direction, colour and intensity, so the weapon
   * still reads as being in the same light as the scene. FILL is the sky
   * hemisphere. RIM comes from behind and opposite the key at a fraction of the
   * intensity, and it is the one that is a deliberate cheat: it draws a bright
   * edge down the top of the receiver that separates the silhouette from
   * whatever is behind it. Without it a dark weapon against a dark building is
   * one shape.
   *
   * THE UNITS ARE LUX AND THEY ARE NOT NEGOTIABLE. LIGHT drives this renderer in
   * absolute photometry (`render/lighting/photometry.ts`): the world's own key
   * is `DirectionalLight.intensity = directNormalIlluminance(...)`, which is
   * 47 100 lux at an 11° sun, and the tonemap exposure is DERIVED from that as
   * `0.18 / L_grey`. A viewmodel rig authored at "intensity ≈ 3" is therefore
   * four orders of magnitude under the scene it sits in — the key contributes
   * nothing measurable, the weapon is lit entirely by `Scene.environment`, and
   * what lands on screen is a flat value with no key, no rim, no bounce and no
   * modelling of the form. That is not a look; it is an arithmetic error, and it
   * is the one that made the viewmodel read as a cardboard wedge. The
   * intensities below are all set per frame from the live sun and sky.
   *
   * WHY THE KEY AND THE RIM ARE POINT LIGHTS AND NOT DIRECTIONAL ONES. This is
   * the round-3 fix and it is the single reason the weapon had no key at all.
   * LIGHT patches three's `lights_fragment_begin` (`render/lighting/shading.ts`)
   * so that inside the unrolled DIRECTIONAL loop every light — not the sun, EVERY
   * directional light — is multiplied by `ironSunShadow(worldPos, worldNormal,
   * viewZ, dot(N, sunDir))`, the world's cascaded sun shadow. That is right for
   * the world, which has exactly one directional light, and it is catastrophic
   * here for two compounding reasons:
   *
   *   1. the viewmodel is a CASCADE-0 CASTER by design (`csm.ts` SHADOW_LAYERS,
   *      LOOK_SPEC §2.6 wants the weapon's shadow on the ground), and it sits
   *      inside cascade 0 at a few centimetres from the eye, where one shadow
   *      texel is centimetres across — so the weapon shadows ITSELF, entirely;
   *   2. the term is the world's, so standing in a building's shadow — which
   *      this shot's camera does — takes the key to zero anyway.
   *
   * The measured result on the round-2 `weapon_ads` frame was a viewmodel whose
   * brightest surface was (43, 62, 75) sRGB — pure sky chroma, B/R = 1.7,
   * meaning ZERO contribution from a warm 40 000 lux key. A flat, cool, evenly
   * lit object at the same value as the hazy midground is what a critic reads as
   * "alpha-blended over the scene": it has no key, so it has no form, so it does
   * not occlude anything perceptually even though it occludes it in the buffer.
   *
   * Three's POINT-light block carries no such patch, and its shadow lookup is
   * behind `NUM_POINT_LIGHT_SHADOWS`, which is zero while `castShadow` is false.
   * So the key and rim are point lights parked `VM_LIGHT_DISTANCE` away with
   * their intensity multiplied by d² — inverse-square makes that exactly the
   * illuminance we asked for, and at 24 m the direction varies by 0.6° and the
   * falloff by ±2 % across a 0.5 m weapon, which is a directional light in every
   * way that can be measured on a viewmodel.
   */
  private readonly keyLight = new THREE.PointLight(0xffd9a8, 0, 0, 2);
  private readonly fillLight = new THREE.HemisphereLight(0x9dc0e0, 0x5a4a34, 0);
  private readonly rimLight = new THREE.PointLight(0xbcd2ea, 0, 0, 2);

  /* ---- feel state. Every one of these is transient and reset per capture. -- */

  /** ADS runs on a re-based eased curve, not a spring: see `stepAds`. */
  private adsFrom = 0;
  private adsT = 1;
  private adsTarget = 0;
  private adsDuration = 0.2;

  private readonly swayPos = new THREE.Vector3();
  private readonly swayPosV = new THREE.Vector3();
  private readonly swayRot = new THREE.Vector3();
  private readonly swayRotV = new THREE.Vector3();
  private readonly swayTargetPos = new THREE.Vector3();
  private readonly swayTargetRot = new THREE.Vector3();

  private readonly kickPos = new THREE.Vector3();
  private readonly kickPosV = new THREE.Vector3();
  private readonly kickRot = new THREE.Vector3();
  private readonly kickRotV = new THREE.Vector3();
  private readonly camKick = new THREE.Vector3();
  private readonly camKickV = new THREE.Vector3();

  private readonly land: Spring1 = { value: 0, velocity: 0 };
  /**
   * Breathing runs on its OWN accumulated clock, not on `FrameCtx.time`.
   *
   * `FrameCtx.time` is `tick × TICK_DT` and the tick counter is NOT zeroed by
   * the harness reset chain — it keeps counting from however long the page
   * happened to be alive before the capture tool attached. Phasing a ~1 mm
   * oscillation off that makes the weapon sit a few pixels differently in every
   * run of the same shot, which is exactly the kind of ghost the reset chain
   * exists to prevent. This counter starts at zero in `reset()`.
   */
  private breatheTime = 0;
  private bobAmplitude = 0;
  private leanValue = 0;
  private prevShotIndex = 0;
  private prevGrounded = true;
  private prevFallSpeed = 0;
  private prevYaw = 0;
  private prevPitch = 0;
  private hasLookBaseline = false;

  private readonly clip: ClipPose = makeClipPose();
  private forcedPose: string | null = null;

  /* ---- scratch. Allocation inside a render system is a frame-time defect. -- */
  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpRot = new THREE.Vector3();
  private readonly zero = new THREE.Vector3();

  constructor(private readonly ctx: BootContext) {
    this.root.name = 'viewmodel';
    this.pivot.name = 'viewmodel.pivot';
    this.root.add(this.pivot);
  }

  /* ------------------------------------------------------------------ build -- */

  /**
   * Built in `afterBoot`, not in the factory: `viewmodel` only declares
   * `dependsOn: ['weapons']`, `subsystems.ts` is frozen so that edge cannot be
   * added, and reading `services.materials` from the factory body would silently
   * get the NULL factory on any boot order where RCORE sorts later. Every asset
   * this needs has already been baked by the time any `create` runs, so the only
   * thing being waited for here is the material factory.
   */
  build(): void {
    const services = this.ctx.services;
    this.materials = buildViewmodelMaterials(services.materials);
    const hands = services.assets.get(handsAssetKey());

    for (const id of WEAPON_IDS) {
      const model = services.assets.get(weaponModelKey(id));
      const rig = buildWeaponRig(model, hands, this.materials);
      rig.root.visible = false;
      this.pivot.add(rig.root);
      this.rigs.set(id, rig);
    }
    this.active = this.rigs.get(WEAPON_IDS[0]!) ?? null;
    if (this.active) this.active.root.visible = true;

    const group = services.scene.group(SceneGroup.Viewmodel);
    group.add(this.root);
    // No bounds: the viewmodel is camera-attached, so a frustum test against a
    // world-space AABB is both pointless and wrong (see `SceneGraph.addDynamic`).
    services.scene.addDynamic(this.root, RenderLayer.Viewmodel);

    // The lights are SIBLINGS of `root`, not children of it: `addDynamic`
    // rewrites the layer mask of everything it traverses, and a light that ends
    // up frustum-culled or re-layered is a light that silently stops working.
    // `castShadow` stays off on both: it is what keeps `NUM_POINT_LIGHT_SHADOWS`
    // at zero, which is what keeps three's point-light shadow lookup compiled
    // out. A viewmodel light that acquired a shadow map would put the weapon in
    // an atlas at arm's length from the light and shadow it with itself again.
    this.keyLight.castShadow = false;
    this.rimLight.castShadow = false;
    for (const light of [this.keyLight, this.fillLight, this.rimLight]) {
      light.layers.set(RenderLayer.Viewmodel as number);
      group.add(light);
    }
  }

  /* --------------------------------------------------------------- contract -- */

  get state(): Readonly<WeaponFeelState> {
    return this.feel;
  }

  muzzleWorld(out: Vec3): Vec3 {
    return out.copy(this.feel.muzzleWorld);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  forcePose(pose: string): void {
    this.forcedPose = pose === 'idle' || pose === '' ? null : pose;
  }

  /* ------------------------------------------------------------ frame entry -- */

  /**
   * The `RenderStage.Animation` entry point. Resolves whose weapon this is and
   * hands the real work to `update`, which is the contract method and is also
   * callable directly by anything that wants to pose a rig it owns.
   */
  frame(ctx: FrameCtx): void {
    const services = ctx.services;
    const entity = services.player.localEntity;
    const sim = services.weapons.stateOf(entity);
    const def = services.weapons.def(sim?.def ?? WEAPON_IDS[0]!);
    this.update(ctx, sim ?? restingState(def), def);
  }

  update(ctx: FrameCtx, sim: Readonly<WeaponState>, def: Readonly<WeaponDef>): Readonly<WeaponFeelState> {
    const dt = Math.min(ctx.dt, MAX_SPRING_DT);
    this.breatheTime += dt;
    this.selectWeapon(sim.def);

    const player = ctx.services.player.stateOf(ctx.services.player.localEntity) ?? ctx.services.player.state;
    const tickNow = Math.round(ctx.time * Sim.TICK_HZ);
    this.feel.secondsSinceFire = Math.min(99, (tickNow - sim.lastFireTick) * Sim.TICK_DT);

    this.stepAds(dt, sim, def);
    this.stepSprint(dt, player, def);
    this.stepClip(ctx, sim, def);
    this.stepLook(ctx, dt, def);
    this.stepBob(dt, player, def);
    this.stepLanding(dt, player, def);
    this.stepRecoil(dt, sim, def);
    this.stepLean(dt, player, def);

    this.composePose(ctx, def);
    this.poseNodes(def);
    this.snapToCamera(ctx);
    this.updateLightRig(ctx);
    this.readMuzzle();
    this.captureVelocity();
    return this.feel;
  }

  /* ------------------------------------------------------------------- ADS -- */

  /**
   * ADS is a RE-BASED EASED CURVE, not a spring and not a lerp-toward.
   *
   * A lerp-toward-target is exponential: it is fastest at the start and never
   * arrives, so the sight creeps into place and the transition has no defined
   * duration. A spring overshoots, which puts the reticle past the centre of the
   * screen — unusable. What a shipped shooter does is run a fixed-duration eased
   * curve, and `AdsDef.curve` (`outExpo`) front-loads it so the sight is most of
   * the way up in the first 90 ms of a 195 ms transition: it MEASURES 195 ms and
   * FEELS like 120.
   *
   * Re-basing is what makes an interrupted transition continuous: on a direction
   * change the curve restarts from wherever the blend actually is, and the
   * duration is scaled by the distance still to travel, so tapping the aim
   * button does not produce a jump or a full-length transition from 5%.
   */
  private stepAds(dt: number, sim: Readonly<WeaponState>, def: Readonly<WeaponDef>): void {
    const forced = this.forcedPose;
    const wants = forced === 'ads' ? true : forced === 'sprint' || forced === 'reload' ? false : sim.adsWanted;
    const target = wants ? 1 : 0;
    if (target !== this.adsTarget) {
      this.adsFrom = this.feel.adsBlend;
      this.adsT = 0;
      this.adsTarget = target;
      // Lowering is ~25% quicker than raising: dropping the weapon out of the
      // way is gravity plus a relaxing arm, raising it is a controlled push.
      const full = wants ? def.ads.time : def.ads.time * 0.78;
      this.adsDuration = Math.max(0.02, full * Math.abs(target - this.adsFrom));
    }
    this.adsT = clamp01(this.adsT + dt / this.adsDuration);
    this.feel.adsBlend = this.adsFrom + (this.adsTarget - this.adsFrom) * ease(def.ads.curve, this.adsT);
    this.feel.fovMultiplier = 1 + (def.ads.fovMultiplier - 1) * this.feel.adsBlend;
  }

  private stepSprint(dt: number, player: Readonly<PlayerState>, def: Readonly<WeaponDef>): void {
    const forced = this.forcedPose;
    const wants = forced === 'sprint' ? true : forced !== null ? false : player.sprinting;
    // `blendTime` is the time to arrive; an exponential damp with a third of it
    // as its half-life is ~90% there at that point, which is where the eye stops
    // being able to tell the difference.
    const target = wants ? 1 : 0;
    this.feel.sprintBlend = damp(this.feel.sprintBlend, target, def.view.sprintPose.blendTime / 3, dt);
  }

  /* ------------------------------------------------------------------ clip -- */

  /**
   * Reload / inspect. The phase is derived from `WeaponState.reloadEndTick`
   * rather than from a timer the rig starts itself, because the harness poses a
   * reload by writing sim state directly — a rig with its own clock would show
   * frame one of the animation in a shot that asked for the magazine on its way
   * out. Empty vs tactical is read off `ammo`, which the fire-control system
   * only refills at the very end of the reload.
   */
  private stepClip(ctx: FrameCtx, sim: Readonly<WeaponState>, def: Readonly<WeaponDef>): void {
    if (this.forcedPose === 'reload') {
      // The most legible single frame of the clip: magazine clear of the well,
      // weapon rolled toward the shooter, support hand off the handguard.
      sampleReload(0.30, false, this.clip);
      return;
    }
    if (this.forcedPose === 'inspect') {
      sampleInspect(0.62, this.clip);
      return;
    }
    if (!sim.reloading) {
      clearClip(this.clip);
      return;
    }
    const empty = sim.ammo === 0;
    const duration = empty ? def.reloadEmpty : def.reloadTactical;
    const tickNow = ctx.time * Sim.TICK_HZ;
    const remaining = (sim.reloadEndTick - tickNow) * Sim.TICK_DT;
    sampleReload(1 - remaining / Math.max(0.05, duration), empty, this.clip);
  }

  /* ------------------------------------------------------------------ sway -- */

  /**
   * Sway: the weapon TRAILS the look, driven by a spring so it overshoots and
   * settles rather than snapping into place.
   *
   * The look rate is measured off the CAMERA quaternion, not off player yaw and
   * pitch, so the rig lags whatever actually moved the view — recoil, a
   * scripted camera and the mouse all produce sway, and a posed harness camera
   * correctly produces none.
   */
  private stepLook(ctx: FrameCtx, dt: number, def: Readonly<WeaponDef>): void {
    this.tmpEuler.setFromQuaternion(ctx.camera.rotation, 'YXZ');
    const yaw = this.tmpEuler.y;
    const pitch = this.tmpEuler.x;
    let yawRate = 0;
    let pitchRate = 0;
    if (this.hasLookBaseline && dt > 1e-5) {
      yawRate = angleDelta(this.prevYaw, yaw) / dt;
      pitchRate = angleDelta(this.prevPitch, pitch) / dt;
    }
    this.prevYaw = yaw;
    this.prevPitch = pitch;
    this.hasLookBaseline = true;

    const sway = def.view.sway;
    // Aiming braces the weapon against the shoulder and the cheek: the same
    // wrist movement produces a fraction of the offset it does at the hip.
    const scale = lerp(1, sway.adsScale, this.feel.adsBlend) * (1 - this.clip.weight * 0.85);
    // Negated: the weapon is left BEHIND by the turn, it does not lead it.
    this.swayTargetPos.set(-yawRate * sway.gain.x, -pitchRate * sway.gain.y, 0);
    if (this.swayTargetPos.length() > sway.maxOffset) this.swayTargetPos.setLength(sway.maxOffset);
    this.swayTargetPos.multiplyScalar(scale);
    // Rotational lag, about all three axes: a weapon held in two hands rotates
    // about the shoulder as much as it translates, and rotation is what the eye
    // reads as weight.
    this.swayTargetRot.set(-pitchRate * sway.gain.z * 0.7, -yawRate * sway.gain.z, -yawRate * sway.gain.z * 0.55);
    this.swayTargetRot.multiplyScalar(scale);

    integrateSpring3(this.swayPos, this.swayPosV, this.swayTargetPos, sway.spring, dt);
    integrateSpring3(this.swayRot, this.swayRotV, this.swayTargetRot, sway.spring, dt);
  }

  /* ------------------------------------------------------------------- bob -- */

  /**
   * Bob, advanced by DISTANCE rather than by time.
   *
   * `cyclesPerMetre` means one cycle is one stride at every speed, so the bob
   * and the footstep audio stay locked together whether the player is walking,
   * crouch-walking or sprinting — a time-based bob drifts against the footfalls
   * the moment the speed changes and reads as a limp.
   *
   * The figure-eight is lateral at 1× and vertical at 2×: two footfalls per
   * stride, one dip each. A single sine is the classic "the camera is on a
   * boat" tell.
   */
  private stepBob(dt: number, player: Readonly<PlayerState>, def: Readonly<WeaponDef>): void {
    const bob = def.view.bob;
    const speed = player.grounded ? player.groundSpeed : 0;
    const moving = speed > MOVING_EPSILON;
    if (moving) {
      this.feel.bobPhase += speed * bob.cyclesPerMetre * dt;
      if (this.feel.bobPhase > 1024) this.feel.bobPhase -= 1024;
    } else {
      // Settle to feet-together rather than freezing mid-stride: a bob that
      // stops wherever it happened to be leaves the weapon visibly off-centre.
      this.feel.bobPhase = damp(this.feel.bobPhase, Math.round(this.feel.bobPhase), 0.09, dt);
    }
    const fullAmplitudeSpeed = WALK_CADENCE_HZ / Math.max(0.05, bob.cyclesPerMetre);
    const want = moving ? clamp01(speed / fullAmplitudeSpeed) : 0;
    this.bobAmplitude = damp(this.bobAmplitude, want, 0.11, dt);
  }

  private bobOffset(def: Readonly<WeaponDef>, outPos: Vec3, outRot: Vec3): void {
    const bob = def.view.bob;
    const amount =
      this.bobAmplitude *
      lerp(1, bob.adsScale, this.feel.adsBlend) *
      (1 - this.clip.weight * 0.7);
    if (amount < 1e-5) {
      outPos.set(0, 0, 0);
      outRot.set(0, 0, 0);
      return;
    }
    const a = this.feel.bobPhase * TAU;
    const walk = bob.walk;
    const sprint = bob.sprint;
    const s = this.feel.sprintBlend;
    const ax = lerp(walk.x, sprint.x, s) * amount;
    const ay = lerp(walk.y, sprint.y, s) * amount;
    const az = lerp(walk.z, sprint.z, s) * amount;
    outPos.set(Math.sin(a) * ax, -Math.abs(Math.sin(a * 2)) * ay, 0);
    // Roll opposes the lateral swing, which is what a torso does, and a small
    // pitch on the vertical so the muzzle traces the eight instead of pumping.
    outRot.set(Math.sin(a * 2) * az * 0.22, Math.sin(a) * az * 0.30, -Math.sin(a) * az);
  }

  /* --------------------------------------------------------------- landing -- */

  /**
   * The landing dip. The impulse is sized by the vertical speed that was
   * actually arrested, so stepping off a kerb and dropping off a roof are the
   * same code and visibly different events — a fixed-size dip on every landing
   * is the giveaway that it is a canned animation.
   */
  private stepLanding(dt: number, player: Readonly<PlayerState>, def: Readonly<WeaponDef>): void {
    const bob = def.view.bob;
    if (player.grounded && !this.prevGrounded) {
      // 7 m/s ≈ a two-storey drop, which is where the dip saturates.
      const severity = clamp01(this.prevFallSpeed / 7);
      impulse(this.land, -bob.landImpulse * (0.35 + severity * 0.65));
    }
    this.prevGrounded = player.grounded;
    if (!player.grounded) this.prevFallSpeed = Math.max(0, -player.velocity.y);

    // Softer and slower than the recoil spring: a body absorbing a landing with
    // its knees is a much lower-frequency system than a receiver on a buffer.
    integrateSpring(this.land, 0, LANDING_SPRING, dt);
  }

  /* -------------------------------------------------------------- recoil -- */

  /**
   * View recoil. Every shot is an instantaneous VELOCITY impulse into an
   * underdamped spring, which is what a real impulse response looks like: a
   * fast rise, a follow-through past the peak, and a settle from BELOW the line
   * of sight. `defs/shared.ts` deliberately authors damping at 0.55–0.62 rather
   * than 1.0 for that undershoot.
   *
   * `WeaponDef.view.weaponKickPos` is the PEAK displacement the author wants, so
   * it is converted to the impulse that peaks there: for an underdamped spring
   * that is v₀ = A·ω, and ω = √(k/m).
   */
  private stepRecoil(dt: number, sim: Readonly<WeaponState>, def: Readonly<WeaponDef>): void {
    const view = def.view;
    if (sim.shotIndex > this.prevShotIndex) {
      // A frame that spans several shots (low frame rate, high rpm) gets all of
      // them, capped: a 200 ms hitch during an LMG burst must not launch the
      // weapon off the screen.
      const shots = Math.min(3, sim.shotIndex - this.prevShotIndex);
      // A shouldered weapon moves less than one held at the hip. The figure is
      // the authored sim-side ADS recoil multiplier, so the view and the sim
      // agree about how much bracing is worth.
      const braced = lerp(1, def.recoil.adsMultiplier, this.feel.adsBlend);
      const wOmega = omegaOf(view.weaponKick);
      const cOmega = omegaOf(view.cameraKick);
      for (let i = 0; i < shots; i++) {
        this.kickPosV.addScaledVector(view.weaponKickPos, wOmega * braced);
        this.kickRotV.addScaledVector(view.weaponKickRot, wOmega * braced);
        this.camKickV.addScaledVector(view.cameraKickImpulse, cOmega * braced);
      }
    }
    this.prevShotIndex = sim.shotIndex;

    integrateSpring3(this.kickPos, this.kickPosV, this.zero, view.weaponKick, dt);
    integrateSpring3(this.kickRot, this.kickRotV, this.zero, view.weaponKick, dt);
    integrateSpring3(this.camKick, this.camKickV, this.zero, view.cameraKick, dt);
    this.feel.cameraKick.copy(this.camKick);
  }

  private stepLean(dt: number, player: Readonly<PlayerState>, def: Readonly<WeaponDef>): void {
    this.leanValue = moveTowards(this.leanValue, clamp(player.lean, -1, 1), def.view.lean.speed * dt);
  }

  /* ------------------------------------------------------------- compose -- */

  private composePose(ctx: FrameCtx, def: Readonly<WeaponDef>): void {
    const view = def.view;
    const ads = def.ads;
    const pos = this.feel.positionOffset;
    const rot = this.feel.rotationOffset;
    const blend = this.feel.adsBlend;

    /* 1 — base pose. */
    const hipRot = ads.hipRotation ?? this.zero;
    pos.set(
      lerp(ads.hipOffset.x, ads.adsOffset.x, blend),
      lerp(ads.hipOffset.y, ads.adsOffset.y, blend),
      lerp(ads.hipOffset.z, ads.adsOffset.z, blend),
    );
    rot.set(
      lerp(hipRot.x, ads.adsRotation.x, blend),
      lerp(hipRot.y, ads.adsRotation.y, blend),
      lerp(hipRot.z, ads.adsRotation.z, blend),
    );

    /* 2 — sprint pose, suppressed by ADS and by any running clip. */
    const sprint = this.feel.sprintBlend * (1 - blend) * (1 - this.clip.weight);
    if (sprint > 1e-4) {
      pos.addScaledVector(view.sprintPose.position, sprint);
      rot.addScaledVector(view.sprintPose.rotation, sprint);
    }

    /* 3 — sway. */
    pos.add(this.swayPos);
    rot.add(this.swayRot);

    /* 4 — bob. */
    this.bobOffset(def, this.tmpPos, this.tmpRot);
    pos.add(this.tmpPos);
    rot.add(this.tmpRot);

    /* 5 — landing dip. The weapon drops with the body and the muzzle rises,
     *     because the hands are the last thing to arrive. */
    if (Math.abs(this.land.value) > 1e-5) {
      pos.y += this.land.value;
      rot.x += -this.land.value * 2.4;
    }

    /* 6 — breathing. */
    const breathe = view.breathe;
    // Steadiness: aiming, and being low, brace the weapon. `holdScale` is the
    // floor a scoped prone shooter reaches, which is what makes a long shot
    // possible at all.
    const steadiness = blend * (0.3 + 0.7 * stanceSteadiness(ctx));
    const amplitude =
      breathe.amplitude * lerp(1, breathe.holdScale, steadiness) * (1 - this.bobAmplitude) * (1 - this.clip.weight);
    if (amplitude > 1e-7) {
      const t = this.breatheTime * TAU * breathe.frequencyHz;
      pos.y += Math.sin(t) * amplitude;
      // The chest expands forward as well as up, and the two are a quarter of a
      // cycle apart, which is what makes it read as a breath and not a bounce.
      pos.z += Math.sin(t - Math.PI * 0.5) * amplitude * 0.55;
      rot.x += Math.sin(t) * amplitude * 1.8;
    }

    /* 7 — lean. `CameraRig` already rolls the eye through `PlayerState.viewRoll`,
     *     so only the RESIDUAL belongs here: the weapon swings out around the
     *     corner further than the head does. */
    if (Math.abs(this.leanValue) > 1e-4) {
      pos.x += this.leanValue * view.lean.offset;
      rot.z += -this.leanValue * view.lean.maxDeg * DEG2RAD * 0.35;
    }

    /* 8 — recoil. */
    pos.add(this.kickPos);
    rot.add(this.kickRot);

    /* 9 — the clip owns whatever is left. */
    if (this.clip.weight > 1e-4) {
      pos.addScaledVector(this.clip.position, this.clip.weight);
      rot.addScaledVector(this.clip.rotation, this.clip.weight);
    }

    this.pivot.position.copy(pos);
    this.pivot.rotation.set(rot.x, rot.y, rot.z, 'YXZ');
  }

  /* ------------------------------------------------------------ node poses -- */

  /** The parts that move relative to the weapon: magazine, bolt, trigger, hands. */
  private poseNodes(def: Readonly<WeaponDef>): void {
    const rig = this.active;
    if (!rig) return;
    const model = rig.model;

    const mag = rig.nodes.magazine;
    mag.position.copy(model.pivots.magazine).addScaledVector(model.magazineDrop, this.clip.magazine);
    // A dropping magazine tips forward off the front lip of the well; a seated
    // one is dead square. Both fall out of the same channel.
    mag.rotation.set(this.clip.magazine * -0.30, 0, this.clip.magazine * 0.12, 'YXZ');
    mag.visible = this.clip.magazine < 0.999;

    // The charging handle carries the manual pull from the clip AND the bolt
    // cycling under recoil, whichever is larger — they are the same part.
    const cycling = boltCycle(this.feel.secondsSinceFire, def.rpm);
    const charge = Math.max(this.clip.charging, cycling);
    rig.nodes.charging.position.copy(model.pivots.charging).addScaledVector(model.chargingPull, charge);

    const trig = triggerBreak(this.feel.secondsSinceFire, def.rpm);
    rig.nodes.trigger.rotation.set(trig * 0.30, 0, 0, 'YXZ');

    // The support hand comes off the handguard, drops past the magwell and
    // carries on down to the magazine pouch on the belt — which is below and
    // behind the eye, so it leaves the frame through the bottom rather than
    // being switched off. A hand that pops out of existence is worse than no
    // hand at all.
    const off = this.clip.handOff;
    const handL = rig.nodes.handL;
    handL.position.copy(model.pivots.handL);
    handL.position.y -= off * 0.34;
    handL.position.z += off * 0.26;
    handL.rotation.set(HAND_L_EULER.x - off * 0.55, HAND_L_EULER.y, HAND_L_EULER.z - off * 0.45, 'YXZ');
  }

  /* ---------------------------------------------------------------- output -- */

  private snapToCamera(ctx: FrameCtx): void {
    this.root.position.copy(ctx.camera.position);
    this.root.quaternion.copy(ctx.camera.rotation);
    this.root.updateMatrixWorld(true);
  }

  /**
   * Park the light rig on the eye and point the key down the world sun.
   *
   * The lights follow the CAMERA rather than the weapon: a rig welded to the
   * weapon rotates with every kick and every sway, so the highlights slide
   * around the receiver as the gun moves and the whole thing reads as a lamp
   * bolted to the barrel. Anchored to the eye and aimed along the world sun,
   * the highlights stay where the world says they should be and the weapon
   * moves THROUGH them, which is the entire point.
   *
   * The key and rim are POINT lights standing `VM_LIGHT_DISTANCE` off the eye
   * with their intensity multiplied by d²; the class comment says why, and it is
   * the round-3 fix for a viewmodel that had no key light at all.
   */
  private updateLightRig(ctx: FrameCtx): void {
    const lighting = ctx.services.lighting;
    const sun = lighting.sun;
    const eye = ctx.camera.position;

    this.keyLight.position.copy(eye).addScaledVector(sun.direction, VM_LIGHT_DISTANCE);
    this.keyLight.color.copy(sun.color);

    // LUX, straight off the world's own sun. Not a remapping of it — the same
    // number the world's `DirectionalLight` is given — so a sunlit face of the
    // receiver and a sunlit face of the wall behind it differ by exactly their
    // albedos and by nothing else. That is the whole definition of "the weapon
    // is in the same light as the scene".
    const above = Math.max(0, sun.direction.y);
    const sunLux = sun.illuminanceLux;
    const skyLux = lighting.skyIlluminanceLux;
    // THE BODY-OCCLUSION FACTOR, and round 3 took it from 0.85 to 0.42 on a
    // measurement rather than a feeling.
    //
    // The viewmodel is deliberately shadowless — that is what the point-light
    // rig above buys, and it is the right trade, because a self-shadowing
    // viewmodel at cascade-0 texel sizes is worse than none. But "shadowless"
    // means the one occluder that matters most is missing: the shooter. A rifle
    // held at the hip or at the shoulder sits inside a cone of the shooter's own
    // torso, head and forearms, and that geometry is not in the scene at any
    // LOD. Taking 85 % of the sun implies a weapon floating in open air.
    //
    // The measurement is `weapon_hipfire` at 0.85: the sunlit face of the
    // handguard read (120, 83, 48) sRGB against sunlit paving at (133, 86, 54) —
    // the same value and the same hue. That is physically defensible (the
    // weapon's side takes the low sun near-normal while the ground takes it at
    // sin 25°, and the 2.1x irradiance almost exactly cancels the 2.2x albedo
    // deficit) and compositionally fatal: LOOK_SPEC §7.2 requires the near-field
    // occluder to read 2-4x DARKER than the midground, and every first-person
    // frame in the corpus obeys it. 0.42 lands the weapon at ~2.4x down, inside
    // that window, without touching an albedo that is right for the material.
    //
    // × d² because this is a point light standing in for a directional one:
    // three's inverse-square attenuation divides it straight back out at the
    // weapon, so what lands on the receiver is `sunLux · 0.42` lux exactly.
    this.keyLight.intensity = sunLux * 0.42 * VM_LIGHT_FALLOFF;

    // Ground bounce, computed rather than dialled: the horizontal illuminance
    // falling on the street times the street's albedo is what comes back up.
    // 0.34 is sandstone/dry sand, which is what this town is made of and is why
    // the undersides of a weapon carried here go warm rather than black.
    const bounceLux = (sunLux * above + skyLux) * 0.34;
    // What the hemisphere buys over `Scene.environment`'s prefiltered sky probe
    // is DIRECTION: it separates the sky term from the ground term along the
    // surface normal, so the top of the receiver goes cool and the magwell,
    // trigger guard and bottom rail go warm, instead of everything settling on
    // one ambient value. The probe knows nothing about the two square metres of
    // sunlit street directly under the weapon, which for a first-person camera
    // is the single largest thing in the viewmodel's own hemisphere.
    //
    // ROUND 3 TOOK IT FROM THE FULL PHYSICAL VALUE TO 0.62 OF IT, and the reason
    // is that until this round the key was being extinguished (see the light-rig
    // comment above) and this term was carrying the ENTIRE weapon on its own.
    // With 40 000 lux of key back, the full hemisphere plus the probe is a
    // double count of the sky and it flattens the modelling to a key:fill of
    // about 1.6:1 — which is a weapon photographed under an overcast, not one in
    // hard golden-hour sun. 0.62 puts it near 2.6:1, which is where the
    // reference frames sit and where a chamfer still has a bright side and a
    // dark side.
    // The same body occlusion applies to the dome — a weapon held against a
    // torso sees maybe half the sky — so the 0.62 above carries a further 0.72,
    // which is what keeps the key:fill ratio where the round-3 rebalance put it
    // rather than letting the ambient swallow the weapon again now that the key
    // has come down.
    const hemisphereLux = Math.max(skyLux, bounceLux);
    this.fillLight.intensity = hemisphereLux * 0.62 * 0.72;
    // Colours carry the RATIO between the two halves; the intensity carries the
    // magnitude. Sky is the LOOK_SPEC teal shadow chroma, ground is sandstone.
    // The shares divide by the UNSCALED hemisphere, not by the scaled intensity:
    // dividing by the scaled one clamps both to 1 and silently throws away the
    // sky/ground split that is the only reason this light exists.
    const skyShare = Math.min(1, skyLux / Math.max(hemisphereLux, 1e-3));
    const groundShare = Math.min(1, bounceLux / Math.max(hemisphereLux, 1e-3));
    //
    // ROUND 3 PULLED BOTH HALVES A THIRD OF THE WAY TOWARD EACH OTHER (sky was
    // 0.34/0.46/0.70, ground 0.62/0.50/0.35). The split is still unmistakably
    // teal-over-warm, which is what LOOK_SPEC §1 asks for, but at the old spread
    // the dome was effectively two SATURATED lights 180° apart, and a
    // bead-blasted surface whose micro-normals swing either side of horizontal
    // then resolves into a blue-and-orange speckle rather than into metal. The
    // hue split belongs on the FORM — the top of a receiver against its magwell —
    // not on adjacent pixels of the same panel.
    this.fillLight.color.setRGB(0.42 * skyShare, 0.50 * skyShare, 0.64 * skyShare);
    this.fillLight.groundColor.setRGB(0.60 * groundShare, 0.52 * groundShare, 0.42 * groundShare);

    // Rim: opposite the key and only slightly above, so it draws a line down
    // the top EDGE of the receiver rather than washing the whole top face. It
    // is the cheapest separation there is and the easiest to overdo — visible on
    // a chamfer, invisible on a flat — and it is what draws the line down the top
    // edge of the receiver that the round-1 critique recorded as missing.
    //
    // ROUND 3: raised from 0.45 to 0.80 of sky illuminance. It was authored when
    // it was competing with a full-strength hemisphere and no key at all, and a
    // rim that is half the ambient is not a rim, it is a second ambient. Against
    // a 0.62 hemisphere it is now genuinely the brightest thing on an up-facing
    // chamfer that the sun is not reaching, which is exactly the 1–2 px silver
    // line down the top of the receiver that separates the silhouette.
    const rimUp = VM_LIGHT_DISTANCE * 0.37;
    this.rimLight.position.set(
      eye.x - sun.direction.x * VM_LIGHT_DISTANCE,
      eye.y + rimUp,
      eye.z - sun.direction.z * VM_LIGHT_DISTANCE,
    );
    // Same d² compensation as the key, measured rather than assumed: the sun
    // direction is a unit vector, so dropping its `y` leaves a horizontal run
    // SHORTER than `VM_LIGHT_DISTANCE` by cos(elevation) and the rim would come
    // out up to 20 % hot at a high sun.
    this.rimLight.intensity = skyLux * 0.80 * this.rimLight.position.distanceToSquared(eye);
    this.keyLight.updateMatrixWorld(true);
    this.rimLight.updateMatrixWorld(true);

    // THE RETICLE, on the same absolute scale as everything above.
    //
    // A red dot is a brightness the shooter DIALS: too dim and it disappears
    // against a sunlit wall, too bright and it blooms into a starburst that
    // hides the target. Both failures are about the ratio to the BACKGROUND, so
    // the emitter is driven from scene illuminance rather than from a constant.
    // `(sunLux·sinθ + skyLux)/π × 0.34` is the luminance of the sandstone the
    // shooter is aiming at; 2.4× that is a dot that reads as hot without
    // swallowing what is behind it. The floor keeps it alive at night.
    const backgroundLuminance = ((sunLux * above + skyLux) / Math.PI) * 0.34;
    const reticleMaterial = this.materials?.reticle as
      | (THREE.Material & { emissiveIntensity?: number })
      | undefined;
    if (reticleMaterial && reticleMaterial.emissiveIntensity !== undefined) {
      reticleMaterial.emissiveIntensity = Math.max(45, backgroundLuminance * 2.4);
    }
  }

  private readMuzzle(): void {
    const rig = this.active;
    if (!rig) return;
    this.feel.muzzleWorld.copy(rig.model.muzzle).applyMatrix4(rig.nodes.body.matrixWorld);
    this.tmpVec.set(0, 0, -1).transformDirection(rig.nodes.body.matrixWorld);
    this.feel.muzzleDirection.copy(this.tmpVec).normalize();
  }

  /**
   * The viewmodel's own previous world transform, cached per mesh.
   *
   * The velocity pass MUST use this and never the camera's previous matrix: the
   * weapon is rigidly attached to the eye, so camera-derived motion vectors say
   * the gun moved the whole width of the screen every time the player turns and
   * TAA smears it into a streak. From here the only motion the gun reports is
   * the motion it actually has — sway, bob and recoil.
   */
  private captureVelocity(): void {
    const rig = this.active;
    if (!rig) return;
    for (const mesh of rig.meshes) {
      const prev = mesh.userData.prevMatrixWorld as THREE.Matrix4 | undefined;
      if (prev) prev.copy(mesh.matrixWorld);
      else mesh.userData.prevMatrixWorld = mesh.matrixWorld.clone();
    }
  }

  private selectWeapon(id: WeaponId): void {
    const next = this.rigs.get(id);
    if (!next || next === this.active) return;
    if (this.active) this.active.root.visible = false;
    next.root.visible = true;
    this.active = next;
  }

  /* ----------------------------------------------------------------- reset -- */

  reset(): void {
    this.adsFrom = 0;
    this.adsT = 1;
    this.adsTarget = 0;
    this.feel.adsBlend = 0;
    this.feel.sprintBlend = 0;
    this.feel.bobPhase = 0;
    this.feel.fovMultiplier = 1;
    this.feel.secondsSinceFire = 99;
    this.feel.positionOffset.set(0, 0, 0);
    this.feel.rotationOffset.set(0, 0, 0);
    this.feel.cameraKick.set(0, 0, 0);
    this.swayPos.set(0, 0, 0);
    this.swayPosV.set(0, 0, 0);
    this.swayRot.set(0, 0, 0);
    this.swayRotV.set(0, 0, 0);
    this.kickPos.set(0, 0, 0);
    this.kickPosV.set(0, 0, 0);
    this.kickRot.set(0, 0, 0);
    this.kickRotV.set(0, 0, 0);
    this.camKick.set(0, 0, 0);
    this.camKickV.set(0, 0, 0);
    this.land.value = 0;
    this.land.velocity = 0;
    this.breatheTime = 0;
    this.bobAmplitude = 0;
    this.leanValue = 0;
    this.prevShotIndex = 0;
    this.prevGrounded = true;
    this.prevFallSpeed = 0;
    this.hasLookBaseline = false;
    this.forcedPose = null;
    clearClip(this.clip);
    // The previous transforms go too: carried across a capture boundary they
    // ghost the gun on frame one of the next shot.
    for (const rig of this.rigs.values()) {
      for (const mesh of rig.meshes) mesh.userData.prevMatrixWorld = undefined;
    }
  }
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * The landing spring. NOT from `WeaponDef`, because a landing is the BODY
 * absorbing an impact, not the weapon: it is the same event with the same
 * frequency whether the soldier is carrying a carbine or an LMG, and hanging it
 * off the weapon's mass would make a heavy gun land softer, which is backwards.
 * ~2 Hz, well damped — knees, not a buffer spring.
 */
const LANDING_SPRING = { stiffness: 165, damping: 0.72, mass: 1 } as const;

/** Undamped natural frequency, for converting a peak amplitude to an impulse. */
function omegaOf(params: { stiffness: number; mass: number }): number {
  return Math.sqrt(params.stiffness / Math.max(params.mass, 1e-4));
}

/** How much the stance itself steadies the weapon: prone ≫ crouch ≫ standing. */
function stanceSteadiness(ctx: FrameCtx): number {
  const stance = ctx.services.player.state.stance;
  return stance === Stance.Prone ? 1 : stance === Stance.Crouch ? 0.55 : 0;
}

/**
 * Support-hand orientation on the handguard: a thumb-forward grip, rolled ~46°
 * so the knuckles face up and out and the thumb lies along the top of the rail.
 *
 * The YAW is the part that is easy to get wrong and obvious once seen, and it
 * is a COMPROMISE, not a solve. The forearm is welded to the hand in
 * `buildHand` — there is no wrist joint — so one rotation has to serve both.
 * Zero yaw aims the fingers correctly along the handguard but swings the LEFT
 * forearm across the body to the lower right of the frame, an arm that plainly
 * belongs to nobody. Enough yaw to fix the arm (−0.55) rotates the fingers
 * round the far side of the handguard and hides the glove completely. −0.20 is
 * the point where the hand still reads on the rail and the arm still leaves the
 * frame on the correct side. A real wrist joint is the proper fix.
 */
const HAND_L_EULER = { x: -0.18, y: -0.20, z: 1.0 } as const;
/** The firing hand matches the grip's 16° rake, authored in `models/build.ts`. */
const HAND_R_EULER = { x: -0.30, y: 0.0, z: 0.04 } as const;

/**
 * Merge the part list into one mesh per (node, role) and hang the nodes off
 * their pivots.
 *
 * Geometry is authored in weapon space, so a node's parts are re-based onto its
 * pivot here — which is what lets `build.ts` place a magazine block at its real
 * position without ever thinking about the pivot it will later rotate around.
 */
function buildWeaponRig(
  model: WeaponModel,
  hands: { left: THREE.BufferGeometry; right: THREE.BufferGeometry },
  materials: RoleMaterials,
): WeaponRigInstance {
  const root = new THREE.Group();
  root.name = `viewmodel.${model.id}`;

  const nodes = {} as Record<PartNode, THREE.Group>;
  for (const node of NODES) {
    const group = new THREE.Group();
    group.name = `${model.id}.${node}`;
    group.position.copy(model.pivots[node]);
    root.add(group);
    nodes[node] = group;
  }

  const buckets = new Map<string, THREE.BufferGeometry[]>();
  for (const part of model.parts) {
    const key = `${part.node}|${part.role}`;
    const pivot = model.pivots[part.node];
    const geometry = part.geometry.clone();
    geometry.translate(-pivot.x, -pivot.y, -pivot.z);
    const list = buckets.get(key);
    if (list) list.push(geometry);
    else buckets.set(key, [geometry]);
  }

  const meshes: THREE.Mesh[] = [];
  for (const [key, geometries] of buckets) {
    const [node, role] = key.split('|') as [PartNode, PartRole];
    const mesh = new THREE.Mesh(mergeParts(geometries), materials[role]);
    mesh.name = `${model.id}.${node}.${role}`;
    // The viewmodel is drawn through its own near camera against a cleared
    // depth range; it never casts or receives a world shadow, and asking for
    // one puts the gun in the shadow atlas at arm's length from the light.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    meshes.push(mesh);
    nodes[node].add(mesh);
  }

  const left = new THREE.Mesh(hands.left.clone(), materials.glove);
  left.name = `${model.id}.handL`;
  left.castShadow = false;
  left.frustumCulled = false;
  nodes.handL.add(left);
  nodes.handL.rotation.set(HAND_L_EULER.x, HAND_L_EULER.y, HAND_L_EULER.z, 'YXZ');
  meshes.push(left);

  const right = new THREE.Mesh(hands.right.clone(), materials.glove);
  right.name = `${model.id}.handR`;
  right.castShadow = false;
  right.frustumCulled = false;
  nodes.handR.add(right);
  nodes.handR.rotation.set(HAND_R_EULER.x, HAND_R_EULER.y, HAND_R_EULER.z, 'YXZ');
  meshes.push(right);

  return { id: model.id, model, root, nodes, meshes };
}

/**
 * A resting `WeaponState` for the frames before the fire-control system has
 * auto-equipped anything — during the boot frame, and in any shot that poses the
 * camera without touching the weapon. Showing the default weapon at rest is the
 * honest answer; hiding the viewmodel until a tick has run makes the first frame
 * of every capture different from the second.
 */
const restingCache = new Map<WeaponId, WeaponState>();
function restingState(def: Readonly<WeaponDef>): Readonly<WeaponState> {
  const cached = restingCache.get(def.id);
  if (cached) return cached;
  const state: WeaponState = {
    def: def.id,
    ammo: def.magazine,
    reserve: def.reserve,
    fireMode: def.fireModes[def.fireModes.length - 1]!,
    nextFireTick: 0,
    reloadEndTick: 0,
    lastFireTick: -999,
    shotIndex: 0,
    burstRemaining: 0,
    recoilStep: 0,
    reloading: false,
    firing: false,
    adsSim: 0,
    adsWanted: false,
    aimPunch: new THREE.Vector3(),
    aimPunchVelocity: new THREE.Vector3(),
    currentSpreadDeg: def.spread.baseHip,
    heat: 0,
  };
  restingCache.set(def.id, state);
  return state;
}

/* ============================================================ lane exports == */

let instance: IronViewmodel | null = null;

export function createViewmodelRig(ctx: BootContext): ViewmodelRig {
  const rig = new IronViewmodel(ctx);
  instance = rig;
  // Meshes and materials are built once every service exists — see `build()`.
  ctx.afterBoot(() => rig.build());
  ctx.addRender({
    name: 'weapons.viewmodel',
    stage: RenderStage.Animation,
    order: 0,
    update: (frame) => rig.frame(frame),
  });
  return rig;
}

/** Arms, gloves and the procedural reload/bolt/inspect clips. */
export function registerViewmodelBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  declareHandAssets(_assets);
}

/**
 * Harness reset chain. Sway, bob phase, kick springs and the ADS blend are all
 * transient, and the viewmodel's PREVIOUS transform feeds the velocity buffer —
 * carrying it across a capture boundary ghosts the gun on frame one.
 */
export function resetViewmodel(_seed: number): void {
  instance?.reset();
}
