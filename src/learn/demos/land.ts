/**
 * Chapter II demo — THE LAND. An fBm heightfield painted to a canvas, with the
 * two sliders that turn mathematics into geography: sea level and octaves.
 * Every pixel is heightAt(x, y, seed) — no image is ever loaded.
 */
import { computeField, landFraction, paintField } from './terrain';
import type { Demo } from './types';

const W = 320;
const H = 180;

export const landDemo: Demo = (root, ctx) => {
  root.innerHTML = `
    <canvas id="map" width="${W}" height="${H}" role="img" aria-label="Heightfield map of the land, colored by elevation" aria-describedby="stats"></canvas>
    <div class="controls" role="group" aria-label="Land shaping controls">
      <label>seed <input id="seed-in" type="number" value="${ctx.seed}" aria-label="World seed" /></label>
      <label>sea level <input id="sea" type="range" min="0.20" max="0.60" step="0.01" value="0.38" /></label>
      <label>octaves <input id="oct" type="range" min="1" max="7" step="1" value="5" /></label>
      <button id="next-land" type="button">next land ▸</button>
    </div>
    <div class="readout" id="stats" role="status" aria-live="polite"></div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>('#map')!;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(W, H);
  const seaIn = root.querySelector<HTMLInputElement>('#sea')!;
  const octIn = root.querySelector<HTMLInputElement>('#oct')!;
  const stats = root.querySelector('#stats')!;

  const repaint = (interacted = false) => {
    const sea = Number(seaIn.value);
    const octaves = Number(octIn.value);
    const field = computeField(ctx.seed, octaves, W, H);
    paintField(img, field, sea);
    g.putImageData(img, 0, 0);
    const land = landFraction(field, sea);
    stats.textContent =
      `heightAt(x, y, ${ctx.seed}) sampled ${(W * H).toLocaleString('en-US')} times · ` +
      `${octaves} octave(s) · ${(land * 100).toFixed(1)}% of the world is land`;
    seaIn.setAttribute('aria-valuetext', `${sea.toFixed(2)} (${(land * 100).toFixed(0)}% land)`);
    octIn.setAttribute('aria-valuetext', `${octaves} octave${octaves === 1 ? '' : 's'}`);
    ctx.report({ interacted, seaLevel: sea, octaves, landFraction: land });
  };

  repaint();
  seaIn.addEventListener('input', () => repaint(true));
  octIn.addEventListener('input', () => repaint(true));

  const seedIn = root.querySelector<HTMLInputElement>('#seed-in')!;
  seedIn.addEventListener('change', () => ctx.onSeedChange(Math.trunc(Number(seedIn.value) || 0)));
  root.querySelector('#next-land')!.addEventListener('click', () => ctx.onSeedChange(ctx.seed + 1));
};
