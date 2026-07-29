/**
 * Shared terrain sampling + painting for Chapters II and III. LEARN owns this.
 * One height function, one palette — the villagers of Chapter III must walk on
 * exactly the land Chapter II shows, which is why this lives in one file.
 */
import { heightAt } from '../proc';

export interface Field {
  w: number;
  h: number;
  height: Float32Array;
}

export function computeField(seed: number, octaves: number, w: number, h: number): Field {
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      height[y * w + x] = heightAt(x / w, y / h, seed, octaves);
    }
  }
  return { w, h, height };
}

/** Terrain palette: height → rgb, split at the sea level. */
function shade(v: number, sea: number): [number, number, number] {
  if (v < sea) {
    // Deep → shallow water.
    const t = Math.max(0, v / Math.max(sea, 1e-5));
    return [11 + 22 * t, 35 + 55 * t, 66 + 78 * t];
  }
  const land = (v - sea) / Math.max(1 - sea, 1e-5);
  if (land < 0.06) return [217, 195, 138]; // sand
  if (land < 0.45) {
    const t = (land - 0.06) / 0.39; // grass, darkening with altitude
    return [106 - 30 * t, 143 - 32 * t, 77 - 20 * t];
  }
  if (land < 0.75) {
    const t = (land - 0.45) / 0.3; // rock
    return [110 + 28 * t, 104 + 27 * t, 96 + 26 * t];
  }
  return [232, 230, 223]; // snow
}

/** Paint the field with a simple NW hillshade into an ImageData. */
export function paintField(img: ImageData, field: Field, sea: number): void {
  const { w, h, height } = field;
  const px = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = height[i];
      let [r, g, b] = shade(v, sea);
      if (v >= sea) {
        // Light from the north-west: slope against the light darkens.
        const hx = height[y * w + Math.min(w - 1, x + 1)] - v;
        const hy = height[Math.min(h - 1, y + 1) * w + x] - v;
        const light = 1 + (hx + hy) * -14;
        const l = Math.max(0.55, Math.min(1.35, light));
        r *= l;
        g *= l;
        b *= l;
      }
      const o = i * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
}

/** Fraction of the field above the waterline. */
export function landFraction(field: Field, sea: number): number {
  let n = 0;
  for (let i = 0; i < field.height.length; i++) if (field.height[i] >= sea) n++;
  return n / field.height.length;
}
