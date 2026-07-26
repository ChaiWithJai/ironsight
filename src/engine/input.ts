/**
 * Devices → one `PlayerIntent`. CORE owns this file.
 *
 * Everything downstream of this file — movement, stance, fire control,
 * ballistics — sees ONE struct, and bots produce the identical struct from
 * `AiService.intentSource`. That is why a feel change lands for 24 bots and the
 * player at the same instant and why a movement bug cannot manifest differently
 * for AI.
 *
 * Mouse deltas are ACCUMULATED between ticks rather than sampled. At 60 Hz tick
 * and a 1000 Hz mouse you get ~16 move events per tick; sampling the last one
 * throws away 94% of the motion and produces the "heavy, laggy" feel that no
 * amount of sensitivity tuning fixes.
 *
 * SUPPRESSION: while `setScripted(intent)` is non-null the device state is still
 * drained (so deltas do not pile up and fire in one lump when control returns)
 * but is discarded. The harness sets a fully-zeroed scripted intent for the
 * duration of a capture, so a stray mouse move cannot fight `poseCamera`.
 */
import {
  Btn,
  type EntityId,
  type InputService,
  type IntentSource,
  type PlayerIntent,
  type TickCtx,
} from '@/engine/types';
import { clamp, DEG2RAD } from '@/engine/math/curves';

/**
 * Radians of yaw per unit of raw mouse movement at sensitivity 1.0. 0.022°/count
 * is the Quake-derived `m_yaw` that every shooter since has effectively inherited;
 * players' muscle memory is calibrated to it.
 */
const RAD_PER_COUNT = 0.022 * DEG2RAD;

/** Anything larger than this in one event is a pointer-lock warp, not a flick. */
const MAX_DELTA_PER_EVENT = 900;

export const KEY_BINDINGS: Readonly<Record<string, Btn>> = {
  Space: Btn.Jump,
  ShiftLeft: Btn.Sprint,
  ShiftRight: Btn.Sprint,
  ControlLeft: Btn.Crouch,
  KeyC: Btn.Crouch,
  KeyZ: Btn.Prone,
  KeyR: Btn.Reload,
  KeyF: Btn.Use,
  KeyV: Btn.Melee,
  KeyG: Btn.Grenade,
  KeyQ: Btn.LeanLeft,
  KeyE: Btn.LeanRight,
  KeyB: Btn.FireMode,
  KeyT: Btn.Spot,
  KeyX: Btn.SwapWeapon,
  Tab: Btn.Scoreboard,
  KeyM: Btn.SpawnMenu,
};

/** Standard-gamepad button index → action. Indices follow the W3C mapping. */
const PAD_BUTTONS: Readonly<Record<number, Btn>> = {
  0: Btn.Jump,
  1: Btn.Crouch,
  2: Btn.Reload,
  3: Btn.SwapWeapon,
  4: Btn.Grenade,
  5: Btn.Use,
  6: Btn.Ads,
  7: Btn.Fire,
  10: Btn.Sprint,
  11: Btn.Melee,
};

const STICK_DEADZONE = 0.18;
/** Right stick is a rate control, not a position control: rad/s at full deflection. */
const PAD_LOOK_RATE = 3.2;

export function createIntent(): PlayerIntent {
  return {
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    pressed: 0,
    released: 0,
    weaponSlot: -1,
    aimAt: null,
  };
}

export function copyIntent(src: Readonly<PlayerIntent>, dst: PlayerIntent): void {
  dst.moveX = src.moveX;
  dst.moveZ = src.moveZ;
  dst.lookYaw = src.lookYaw;
  dst.lookPitch = src.lookPitch;
  dst.buttons = src.buttons;
  dst.pressed = src.pressed;
  dst.released = src.released;
  dst.weaponSlot = src.weaponSlot;
  dst.aimAt = src.aimAt;
}

export class EngineInputService implements InputService {
  sensitivity = 1;
  invertY = false;

  private readonly keys = new Set<string>();
  private mouseButtons = 0;
  private accumX = 0;
  private accumY = 0;
  private wheelSlot = -1;
  private locked = false;
  private scripted: Partial<PlayerIntent> | null = null;
  private padIndex: number | null = null;

  /** Intent produced at TickPhase.Input; consumed at TickPhase.Intent. */
  private readonly intent: PlayerIntent = createIntent();
  private prevButtons = 0;

  private readonly detach: Array<() => void> = [];

  readonly source: IntentSource;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.source = {
      kind: 'human',
      sample: (_entity: EntityId, _ctx: TickCtx, out: PlayerIntent): void => {
        copyIntent(this.intent, out);
      },
    };
    this.attach();
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  requestPointerLock(): void {
    // Chrome rejects the promise if the element is not focused or the gesture
    // has expired; that is a normal outcome, not an error worth logging.
    void Promise.resolve(this.canvas.requestPointerLock()).catch(() => undefined);
  }

  setScripted(intent: Partial<PlayerIntent> | null): void {
    this.scripted = intent;
  }

  private attach(): void {
    const on = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      const handler = fn as EventListener;
      target.addEventListener(type, handler, opts);
      this.detach.push(() => target.removeEventListener(type, handler, opts));
    };

    on(window, 'keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 9) this.wheelSlot = n - 1;
      }
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    // Losing focus mid-strafe otherwise leaves the key latched down forever.
    on(window, 'blur', () => {
      this.keys.clear();
      this.mouseButtons = 0;
    });

    on(this.canvas, 'mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      if (!this.locked) this.requestPointerLock();
    });
    on(window, 'mouseup', (e) => {
      this.mouseButtons &= ~(1 << e.button);
    });
    on(window, 'contextmenu', (e) => e.preventDefault());
    on(window, 'mousemove', (e) => {
      if (!this.locked) return;
      const dx = clamp(e.movementX, -MAX_DELTA_PER_EVENT, MAX_DELTA_PER_EVENT);
      const dy = clamp(e.movementY, -MAX_DELTA_PER_EVENT, MAX_DELTA_PER_EVENT);
      this.accumX += dx;
      this.accumY += dy;
    });
    on(window, 'wheel', (e) => {
      if (e.deltaY !== 0) this.wheelSlot = e.deltaY > 0 ? -2 : -3;
    }, { passive: true });

    on(document, 'pointerlockchange' as keyof WindowEventMap, () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.accumX = 0;
        this.accumY = 0;
      }
    });

    on(window, 'gamepadconnected', (e) => {
      this.padIndex = (e as GamepadEvent).gamepad.index;
    });
    on(window, 'gamepaddisconnected', () => {
      this.padIndex = null;
    });
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  /**
   * Runs at TickPhase.Input. Folds the accumulated device state into `intent`
   * and clears the accumulators, so exactly one tick's worth of motion is
   * consumed per tick and none of it is lost or double-counted.
   */
  tickInput(adsSensitivityScale: number): void {
    const dx = this.accumX;
    const dy = this.accumY;
    this.accumX = 0;
    this.accumY = 0;
    const slot = this.wheelSlot;
    this.wheelSlot = -1;

    if (this.scripted) {
      // Suppressed: the device state above has been drained and is discarded, so
      // nothing accumulates while the harness owns the camera.
      const s = this.scripted;
      this.intent.moveX = s.moveX ?? 0;
      this.intent.moveZ = s.moveZ ?? 0;
      this.intent.lookYaw = s.lookYaw ?? 0;
      this.intent.lookPitch = s.lookPitch ?? 0;
      const buttons = s.buttons ?? 0;
      this.intent.pressed = buttons & ~this.prevButtons;
      this.intent.released = this.prevButtons & ~buttons;
      this.intent.buttons = buttons;
      this.intent.weaponSlot = s.weaponSlot ?? -1;
      this.intent.aimAt = s.aimAt ?? null;
      this.prevButtons = buttons;
      return;
    }

    let moveX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    let moveZ = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);

    let buttons = 0;
    for (const code of this.keys) {
      const bit = KEY_BINDINGS[code];
      if (bit) buttons |= bit;
    }
    if (this.mouseButtons & 1) buttons |= Btn.Fire;
    if (this.mouseButtons & 2) buttons |= Btn.Ads;

    const sens = this.sensitivity * adsSensitivityScale * RAD_PER_COUNT;
    let yaw = -dx * sens;
    let pitch = (this.invertY ? dy : -dy) * sens;

    const pad = this.pollPad();
    if (pad) {
      moveX += pad.moveX;
      moveZ += pad.moveZ;
      buttons |= pad.buttons;
      yaw += pad.lookYaw * this.sensitivity * adsSensitivityScale;
      pitch += (this.invertY ? -pad.lookPitch : pad.lookPitch) * this.sensitivity * adsSensitivityScale;
    }

    // Normalise to the unit DISC, never the unit square: a diagonal that is
    // 1.41× faster than a cardinal is the oldest movement bug in the genre.
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }

    this.intent.moveX = moveX;
    this.intent.moveZ = moveZ;
    this.intent.lookYaw = yaw;
    this.intent.lookPitch = pitch;
    this.intent.pressed = buttons & ~this.prevButtons;
    this.intent.released = this.prevButtons & ~buttons;
    this.intent.buttons = buttons;
    this.intent.weaponSlot = slot;
    this.intent.aimAt = null;
    this.prevButtons = buttons;
  }

  private pollPad(): { moveX: number; moveZ: number; lookYaw: number; lookPitch: number; buttons: number } | null {
    if (this.padIndex === null || typeof navigator.getGamepads !== 'function') return null;
    const pad = navigator.getGamepads()[this.padIndex];
    if (!pad || !pad.connected) return null;

    const dz = (v: number): number => {
      const a = Math.abs(v);
      if (a < STICK_DEADZONE) return 0;
      // Rescale past the deadzone so the stick still reaches 1.0 at full throw,
      // then square for fine control near centre without losing top speed.
      const t = (a - STICK_DEADZONE) / (1 - STICK_DEADZONE);
      return Math.sign(v) * t * t;
    };

    let buttons = 0;
    for (const key of Object.keys(PAD_BUTTONS)) {
      const i = Number(key);
      if (pad.buttons[i]?.pressed) buttons |= PAD_BUTTONS[i];
    }
    // Triggers report as analogue axes on some pads; treat >50% as a press.
    if ((pad.buttons[7]?.value ?? 0) > 0.5) buttons |= Btn.Fire;
    if ((pad.buttons[6]?.value ?? 0) > 0.5) buttons |= Btn.Ads;

    return {
      moveX: dz(pad.axes[0] ?? 0),
      moveZ: -dz(pad.axes[1] ?? 0),
      lookYaw: -dz(pad.axes[2] ?? 0) * PAD_LOOK_RATE / 60,
      lookPitch: -dz(pad.axes[3] ?? 0) * PAD_LOOK_RATE / 60,
      buttons,
    };
  }

  /** Read-only view for the debug overlay and for GAME's movement code. */
  get current(): Readonly<PlayerIntent> {
    return this.intent;
  }
}

export function createInputService(canvas: HTMLCanvasElement): EngineInputService {
  return new EngineInputService(canvas);
}

/** A fully-zeroed intent. The harness installs this to suppress live input. */
export const SUPPRESSED_INTENT: Readonly<Partial<PlayerIntent>> = Object.freeze({
  moveX: 0,
  moveZ: 0,
  lookYaw: 0,
  lookPitch: 0,
  buttons: 0,
  weaponSlot: -1,
  aimAt: null,
});
