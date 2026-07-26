/**
 * HUD coordinate system. OWNER: HUD.
 *
 * `docs/HUD_SPEC.md` §2: `1u = viewportHeightPx / 100`, and EVERY size in the
 * spec — horizontal ones included — is in `u`. The whole interface scales with
 * screen height, never with width and never with the diagonal, which is what
 * keeps the layout identical from 16:9 to 21:9 with only the gaps between
 * clusters widening.
 *
 * The tall-window guard is §2.3: below 1.5:1 the 51.4u ticket assembly would
 * exceed the frame, so the effective unit is clamped against width/160.
 */
export const HUD_SCALE_MIN = 0.85;
export const HUD_SCALE_MAX = 1.2;

export class Layout {
  width = 1920;
  height = 1080;
  /** One percent of screen height, after the aspect guard and `hudScale`. */
  u = 10.8;
  /** Horizontal centre. NOT scaled by `hudScale` — §2.2. */
  cx = 960;
  hudScale = 1;

  /** Safe margins in px. Deliberately asymmetric: the top is flush (§2.4). */
  marginLeft = 32;
  marginRight = 32;
  marginBottom = 33;
  /** The ability rail sits further in than everything else (§6.13). */
  marginRail = 42;

  resize(width: number, height: number, hudScale = 1): void {
    this.width = width;
    this.height = height;
    this.hudScale = Math.min(HUD_SCALE_MAX, Math.max(HUD_SCALE_MIN, hudScale));
    const base = width / height < 1.5 ? Math.min(height / 100, width / 160) : height / 100;
    this.u = base * this.hudScale;
    this.cx = width * 0.5;
    this.marginLeft = this.u * 2.96;
    this.marginRight = this.u * 2.96;
    this.marginBottom = this.u * 3.05;
    this.marginRail = this.u * 3.9;
  }

  /** `u` → device px. */
  s(units: number): number {
    return units * this.u;
  }
  /** `L + n` in the spec's notation. */
  left(units: number): number {
    return this.marginLeft + units * this.u;
  }
  /** `R − n`. */
  right(units: number): number {
    return this.width - this.marginRight - units * this.u;
  }
  /** `C ± n`. */
  centre(units: number): number {
    return this.cx + units * this.u;
  }
  /** A vertical position given as a percentage of screen height. */
  y(percent: number): number {
    return (percent / 100) * this.height;
  }
  /** Bottom edge minus `units`, in px. */
  bottom(units: number): number {
    return this.height - this.marginBottom - units * this.u;
  }
}
