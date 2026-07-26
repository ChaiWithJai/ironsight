/**
 * CameraRig — THE ONLY WRITER OF CAMERA TRANSFORM IN THE PROJECT.
 *
 * OWNER: RCORE. This is the day-0 implementation: it composes the interpolated
 * eye position, sim yaw/pitch, trauma shake, ADS FOV blend and the TAA jitter
 * offset, and it implements the harness pose lock. RCORE extends it with
 * aimPunch, cosmetic cameraKick, sway, bob and lean by reading
 * `WeaponFeelState` — the composition order below is already the contract order
 * and must not change.
 *
 * Composition order (contract):
 *   interpolated eye → sim yaw/pitch → aimPunch → cameraKick → sway → bob
 *   → lean → trauma → ADS FOV blend → TAA jitter
 *
 * `projection` is UNJITTERED and is what velocity, culling and every
 * world-to-screen calculation must use. Only the actual draw uses
 * `jitteredProjection`. Getting that backwards makes motion vectors wrong by a
 * sub-pixel amount every frame, which reads as TAA softness nobody can trace.
 */
import * as THREE from 'three';
import {
  RenderStage,
  type AssetRegistry,
  type BootContext,
  type CameraRig,
  type CameraState,
  type FrameCtx,
  type QualitySettings,
  type QualityService,
  type RenderSystem,
  type Services,
  type Vec2,
  type Vec3,
} from '@/engine/types';
import { AntiAliasMode } from '@/engine/types';
import { clamp, damp } from '@/engine/math/curves';
import { haltonJitter } from '@/engine/math/halton';

const WORLD_NEAR = 0.08;
const WORLD_FAR = 4000;
/** The viewmodel gets its own camera so hands can never clip a wall and never
 *  eat world depth precision. 0.01–6 m covers arm's length with room to spare. */
const VIEWMODEL_NEAR = 0.01;
const VIEWMODEL_FAR = 6;

/** Trauma decays quadratically (shake ∝ trauma²), so it dies out perceptually
 *  linearly. Linear trauma decay reads as a shake that stops abruptly. */
const TRAUMA_DECAY_PER_SECOND = 1.6;

export class IronCameraRig implements CameraRig, RenderSystem {
  readonly name = 'render.cameraRig';
  readonly stage = RenderStage.Camera;
  readonly order = 0;

  readonly world = new THREE.PerspectiveCamera(60, 16 / 9, WORLD_NEAR, WORLD_FAR);
  readonly viewmodel = new THREE.PerspectiveCamera(55, 16 / 9, VIEWMODEL_NEAR, VIEWMODEL_FAR);

  private readonly stateValue: CameraState;
  private readonly mutable: {
    -readonly [K in keyof CameraState]: CameraState[K];
  };

  private poseLocked = false;
  private readonly posedPosition = new THREE.Vector3();
  private readonly posedTarget = new THREE.Vector3();
  private posedFov = 55;

  private trauma = 0;
  private traumaFrequency = 22;
  private baseFovDeg = 68;
  private currentFovDeg = 68;

  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly tmpMatrix = new THREE.Matrix4();

  constructor(
    private readonly services: Services,
    private readonly quality: QualityService,
  ) {
    const jitter: Vec2 = new THREE.Vector2();
    this.stateValue = {
      position: new THREE.Vector3(),
      rotation: new THREE.Quaternion(),
      fovDeg: this.baseFovDeg,
      aspect: 16 / 9,
      near: WORLD_NEAR,
      far: WORLD_FAR,
      view: new THREE.Matrix4(),
      projection: new THREE.Matrix4(),
      jitteredProjection: new THREE.Matrix4(),
      viewProjection: new THREE.Matrix4(),
      inverseViewProjection: new THREE.Matrix4(),
      prevViewProjection: new THREE.Matrix4(),
      jitter,
      // 12.5 EV is a plausible golden-hour exterior key. RCORE's exposure pass
      // overwrites this every frame once it lands; while `deterministic` is true
      // it is FROZEN, which is what keeps a 32-frame shot from landing at a
      // different EV than a live session that adapted for seconds.
      exposureEv: 12.5,
      world: this.world,
      viewmodel: this.viewmodel,
    };
    this.mutable = this.stateValue as typeof this.mutable;
    this.world.matrixAutoUpdate = false;
    this.viewmodel.matrixAutoUpdate = false;
  }

  get state(): Readonly<CameraState> {
    return this.stateValue;
  }

  addTrauma(amount: number, frequencyHz = 22): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
    this.traumaFrequency = frequencyHz;
  }

  poseAbsolute(position: Vec3, target: Vec3, fovDeg?: number): void {
    this.posedPosition.copy(position);
    this.posedTarget.copy(target);
    if (fovDeg !== undefined) this.posedFov = fovDeg;
    this.poseLocked = true;
    // Kill any in-flight shake immediately: a shot that inherits trauma from the
    // previous capture is the classic order-dependent screenshot.
    this.trauma = 0;
  }

  setPoseLocked(locked: boolean): void {
    this.poseLocked = locked;
  }

  setAspect(width: number, height: number): void {
    const aspect = height > 0 ? width / height : 16 / 9;
    this.mutable.aspect = aspect;
    this.world.aspect = aspect;
    this.viewmodel.aspect = aspect;
  }

  update(ctx: FrameCtx): Readonly<CameraState> {
    // Last frame's UNJITTERED view-projection is the only correct camera-motion
    // input for the velocity buffer; capture it before anything moves.
    this.mutable.prevViewProjection.copy(this.stateValue.viewProjection);

    if (this.poseLocked) {
      this.mutable.position.copy(this.posedPosition);
      this.tmpMatrix.lookAt(this.posedPosition, this.posedTarget, THREE.Object3D.DEFAULT_UP);
      this.mutable.rotation.setFromRotationMatrix(this.tmpMatrix);
      this.currentFovDeg = this.posedFov;
    } else {
      const player = this.services.player.state;
      // Interpolated eye position. Under the harness alpha is 0, so this is a
      // straight copy and interpolation is a deliberate no-op during capture.
      this.mutable.position.set(player.position.x, player.position.y + player.eyeHeight, player.position.z);
      this.tmpEuler.set(player.pitch, player.yaw, 0, 'YXZ');
      this.mutable.rotation.setFromEuler(this.tmpEuler);

      // ADS FOV blend. `adsBlend` is the RENDER-side value, never the sim one:
      // the camera must never influence where a bullet goes.
      const feel = this.services.viewmodel.state;
      const wantFov = this.baseFovDeg * feel.fovMultiplier;
      this.currentFovDeg = damp(this.currentFovDeg, wantFov, 0.06, ctx.dt);

      // Trauma shake, applied as a rotational offset so it never moves the eye
      // through geometry. Decays with the square so it fades perceptually evenly.
      if (this.trauma > 0) {
        const t = ctx.time * this.traumaFrequency;
        const mag = this.trauma * this.trauma * 0.035;
        this.tmpEuler.set(
          player.pitch + Math.sin(t * 1.7) * mag,
          player.yaw + Math.sin(t * 2.3 + 1.1) * mag,
          Math.sin(t * 1.31 + 2.2) * mag * 1.6,
          'YXZ',
        );
        this.mutable.rotation.setFromEuler(this.tmpEuler);
        this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY_PER_SECOND * ctx.dt);
      }
    }

    this.mutable.fovDeg = this.currentFovDeg;
    this.world.fov = this.currentFovDeg;
    this.world.position.copy(this.stateValue.position);
    this.world.quaternion.copy(this.stateValue.rotation);
    this.world.updateMatrix();
    this.world.updateMatrixWorld(true);
    this.world.updateProjectionMatrix();

    // The viewmodel camera shares the eye transform but keeps its own near/far
    // and a fixed FOV, so the weapon does not stretch when the world FOV blends.
    this.viewmodel.position.copy(this.stateValue.position);
    this.viewmodel.quaternion.copy(this.stateValue.rotation);
    this.viewmodel.updateMatrix();
    this.viewmodel.updateMatrixWorld(true);
    this.viewmodel.updateProjectionMatrix();

    this.mutable.view.copy(this.world.matrixWorldInverse);
    this.mutable.projection.copy(this.world.projectionMatrix);
    this.mutable.viewProjection.multiplyMatrices(this.stateValue.projection, this.stateValue.view);
    this.mutable.inverseViewProjection.copy(this.stateValue.viewProjection).invert();

    this.applyJitter(ctx);
    return this.stateValue;
  }

  /**
   * Halton(2,3) sub-pixel offset folded into `jitteredProjection` only. The
   * three.js camera keeps the UNJITTERED matrix, so anything that reads
   * `camera.projectionMatrix` (culling, world-to-screen, the debug gizmos) is
   * automatically correct; RCORE's forward pass is what installs the jittered
   * matrix for the draw itself.
   */
  private applyJitter(ctx: FrameCtx): void {
    const q = this.quality.settings;
    const jitter = this.stateValue.jitter as THREE.Vector2;
    if (q.aa !== AntiAliasMode.Taa) {
      jitter.set(0, 0);
      this.mutable.jitteredProjection.copy(this.stateValue.projection);
      return;
    }
    haltonJitter(ctx.frame, q.taaSamples, jitter);
    const width = Math.max(1, this.renderWidth);
    const height = Math.max(1, this.renderHeight);
    this.mutable.jitteredProjection.copy(this.stateValue.projection);
    // NDC offset is 2 × (pixel offset / resolution): NDC spans -1..1.
    this.mutable.jitteredProjection.elements[8] += (jitter.x * 2) / width;
    this.mutable.jitteredProjection.elements[9] += (jitter.y * 2) / height;
  }

  /** Internal render resolution, pushed in by the render service on resize. */
  renderWidth = 1920;
  renderHeight = 1080;

  worldToScreen(world: Vec3, out: Vec2): boolean {
    const v = TMP_V4.set(world.x, world.y, world.z, 1).applyMatrix4(this.stateValue.viewProjection);
    if (v.w <= 1e-5) {
      out.set(0, 0);
      return false;
    }
    out.set((v.x / v.w) * 0.5 + 0.5, (v.y / v.w) * 0.5 + 0.5);
    return out.x >= 0 && out.x <= 1 && out.y >= 0 && out.y <= 1;
  }

  /** GAME/HUD read this to know the un-zoomed field of view. */
  setBaseFov(fovDeg: number): void {
    this.baseFovDeg = fovDeg;
  }

  /** Written by RCORE's exposure pass. Frozen while `deterministic` is true. */
  setExposureEv(ev: number): void {
    this.mutable.exposureEv = ev;
  }
}

const TMP_V4 = new THREE.Vector4();

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * RCORE: replace the BODY of this file, keep this signature and this path.
 */
export function createCameraRig(ctx: BootContext): IronCameraRig {
  const rig = new IronCameraRig(ctx.services, ctx.quality);
  ctx.addRender(rig);
  // 68° vertical. Wider than a cinematic 50° because a shooter needs peripheral
  // awareness; narrower than the 90° that makes a viewmodel look like a toy.
  rig.setBaseFov(68);
  return rig;
}

/** The camera bakes nothing today; a lens-distortion LUT would land here. */
export function registerCameraBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Nothing.
}

/**
 * Harness reset chain. Trauma, sway springs, the ADS FOV damp and the previous
 * view-projection all persist across a capture boundary otherwise, and the first
 * frames of a shot come out mid-shake.
 */
export function resetCamera(_seed: number): void {
  // The pose lock is cleared by the driver's reset chain, before this runs.
}
