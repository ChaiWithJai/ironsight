/**
 * The HarnessDriver, the ShotContext, and THE RESET CHAIN. CORE owns this file.
 *
 * `src/engine/harness.ts` is locked; everything it calls is implemented here.
 *
 * THE RESET CHAIN IS A CONTRACT, NOT A NICETY
 * -------------------------------------------
 * The locked harness resets the seed, the overlays and the player state before
 * every capture. IT DOES NOT KNOW ABOUT YOUR LANE. Persistent decals, debris,
 * destroyed walls, TAA history, exposure adaptation, bot positions and particle
 * pools all leak from one capture into the next, which makes a shot's result
 * depend on the ORDER shots were captured in and sends the visual critics
 * chasing ghosts that reproduce for nobody.
 *
 * `ShotContext.seed(n)` therefore runs the full chain below, ending with every
 * `SubsystemDescriptor.reset?(n)` in boot order. Every one of the 23 descriptors
 * is wired to a `reset<Key>(seed)` export of its lane's entry file on day 0, as
 * a no-op — a lane FILLS IN THE BODY, it does not add a hook, because
 * `src/bootstrap/subsystems.ts` is frozen. The acceptance test is: capture every
 * shot twice in different orders and diff the PNGs. Identical bytes, or the
 * chain is incomplete.
 */
import * as THREE from 'three';
import {
  SceneGroup,
  type HarnessDriver,
  type PlayerIntent,
  type ShotContext,
} from '@/engine/types';
import { SUPPRESSED_INTENT } from '@/engine/input';
import type { IronEngine } from '@/engine/engine';

export class HarnessDriverImpl implements HarnessDriver {
  readonly context: ShotContext;

  private readonly tmpPosition = new THREE.Vector3();
  private readonly tmpTarget = new THREE.Vector3();

  constructor(private readonly engine: IronEngine) {
    this.context = {
      setTimeOfDay: (hours: number): void => {
        this.engine.services.sky.setTimeOfDay(hours);
        this.engine.services.renderer.requestEnvironmentRebake('shot:setTimeOfDay');
      },

      setWeather: (overcast: number, options): void => {
        this.engine.services.sky.setWeather(overcast, options);
        this.engine.services.renderer.requestEnvironmentRebake('shot:setWeather');
      },

      poseCamera: (position, target, fovDeg): void => {
        this.tmpPosition.set(position[0], position[1], position[2]);
        this.tmpTarget.set(target[0], target[1], target[2]);
        const camera = this.engine.services.camera;
        camera.poseAbsolute(this.tmpPosition, this.tmpTarget, fovDeg);
        camera.setPoseLocked(true);
      },

      setOverlays: (options): void => {
        const overlays = this.engine.services.renderer.overlays;
        if (options.viewmodel !== undefined) overlays.viewmodel = options.viewmodel;
        if (options.hud !== undefined) overlays.hud = options.hud;
        this.engine.services.viewmodel.setVisible(overlays.viewmodel);
        this.engine.services.hud.setVisible(overlays.hud);
      },

      setPlayerState: (state: string): void => {
        this.engine.services.player.setForcedState(state === 'idle' ? null : state);
        this.engine.services.viewmodel.forcePose(state);
      },

      seed: (n: number): void => {
        this.resetChain(n);
      },
    };
  }

  /**
   * The order below matters. RNG first, so anything a reset handler draws is
   * already on the fresh stream. Graph histories before the world resets, so a
   * subsystem that re-seeds a temporal buffer in its own `reset` is not undone.
   * Descriptor hooks last, in boot order, because a lane's reset may legitimately
   * depend on a service it declared `dependsOn`.
   */
  private resetChain(seed: number): void {
    const s = this.engine.services;

    this.engine.rng.reseed(seed);
    s.graph.resetHistories();

    // CORE's own transient state.
    this.engine.clock.deterministic = true;
    this.engine.quality.deterministic = true;
    this.engine.loop.resetAccumulator();
    s.fx.clear();
    s.events.clear();
    // Release the camera from any previous shot's pose. A shot that does not
    // call `poseCamera` must start from the player's own view, not from
    // wherever the last shot happened to leave the camera.
    s.camera.setPoseLocked(false);
    // Suppress live devices for the whole capture so a stray mouse move cannot
    // fight the posed camera.
    s.input.setScripted(SUPPRESSED_INTENT as Partial<PlayerIntent>);
    // Debug gizmos never appear in a review PNG.
    this.engine.scene.group(SceneGroup.Debug).visible = false;

    // The services the architecture names explicitly.
    s.destruction.reset();
    s.vfx.clearTransient();
    s.ballistics.clear();
    s.ai.despawnAll();
    s.mode.reset(seed);

    // Then every lane that declared it holds transient state, in boot order.
    for (const descriptor of this.engine.bootOrder) {
      descriptor.reset?.(seed);
    }
  }

  /** Advance simulation + render exactly one frame with the given fixed dt. */
  stepFrame(dt: number): void {
    this.engine.stepFrame(dt);
  }

  /**
   * THE SUBTLEST THING IN THIS FILE. READ BEFORE CHANGING IT.
   *
   * The locked harness resumes the loop in a `finally`, i.e. BEFORE
   * `tools/capture.mjs` screenshots the canvas:
   *
   *     for (i of frames) driver.stepFrame(dt);
   *     await driver.flush();
   *     return meta;                    ← capture.mjs grabs the canvas AFTER this
   *   } finally {
   *     driver.setLoopSuspended(false); ← ...but this already ran
   *   }
   *
   * So anything this method hands back to live play lands in the PNG. Restoring
   * the player camera here means every shot in the repo screenshots the player's
   * viewpoint instead of the posed one — and because the null player pose is
   * deterministic, EVERY shot comes out byte-identical, which reads as "the
   * camera pose is broken" rather than as "the loop restarted too early".
   *
   * Therefore: resuming does NOT restore anything. It parks the engine in a HOLD
   * — rAF keeps running, the world stays exactly as the last `stepFrame` left it,
   * and no further frames accumulate into any temporal history. Live play resumes
   * only when a real human touches the mouse or keyboard (`armLiveTakeover`), and
   * the next capture's reset chain clears the pose lock on its own.
   */
  setLoopSuspended(suspended: boolean): void {
    this.engine.setLoopSuspended(suspended);
    if (suspended) {
      this.engine.clock.deterministic = true;
      this.engine.quality.deterministic = true;
      this.engine.harnessHold = false;
    } else {
      this.engine.harnessHold = true;
      this.armLiveTakeover();
    }
  }

  /**
   * One-shot: the first real device event after a capture hands the world back
   * to the player. Passive and capture-phase so it cannot interfere with input
   * handling, and it re-arms after every capture.
   */
  private takeoverArmed = false;

  private armLiveTakeover(): void {
    if (this.takeoverArmed) return;
    this.takeoverArmed = true;
    const release = (): void => {
      window.removeEventListener('pointerdown', release, true);
      window.removeEventListener('keydown', release, true);
      this.takeoverArmed = false;
      if (!this.engine.harnessHold) return;
      this.engine.harnessHold = false;
      this.engine.clock.deterministic = false;
      this.engine.quality.deterministic = false;
      this.engine.services.input.setScripted(null);
      this.engine.services.camera.setPoseLocked(false);
      this.engine.scene.group(SceneGroup.Debug).visible = true;
    };
    window.addEventListener('pointerdown', release, true);
    window.addEventListener('keydown', release, true);
  }

  /**
   * Resolve once all pending GPU work for the last frame has landed.
   *
   * `gl.finish()` alone is not enough: the compositor still has to pick the
   * canvas up, and grabbing before it does can race the swap and produce a
   * torn or stale PNG. Two rAF turns after the fence is the cheapest reliable
   * barrier, and under SwiftShader the fence itself is where the real wait is.
   */
  async flush(): Promise<void> {
    const gl = this.engine.renderer.getContext();
    gl.finish();
    await nextFrame();
    await nextFrame();
  }
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
