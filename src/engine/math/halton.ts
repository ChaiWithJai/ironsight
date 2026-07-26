/**
 * Low-discrepancy sequences. CORE owns this file.
 *
 * TAA jitter, blue-noise offsets, GTAO slice rotation and impostor view
 * placement all need well-distributed sample sets that are identical on every
 * machine — which rules out anything derived from the wall clock.
 */

/** Radical inverse in `base`. Halton(2,3) is the standard TAA pair. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * Sub-pixel TAA offset in pixels, centred on 0. `frame` is the render frame
 * index; `samples` is the TAA sample count (4, 8 or 16). Index 0 of a Halton
 * sequence is degenerate, so we bias by 1.
 */
export function haltonJitter(frame: number, samples: number, out: { x: number; y: number }): void {
  const i = (frame % samples) + 1;
  out.x = halton(i, 2) - 0.5;
  out.y = halton(i, 3) - 0.5;
}

/** 2D R2 low-discrepancy sequence (Roberts). Cheaper than Halton, no bases. */
export function r2(index: number, out: { x: number; y: number }): void {
  // Plastic number reciprocals; the 2D generalisation of the golden ratio.
  const a1 = 0.7548776662466927;
  const a2 = 0.5698402909980532;
  out.x = (0.5 + a1 * index) % 1;
  out.y = (0.5 + a2 * index) % 1;
}
