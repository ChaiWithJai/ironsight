/**
 * Chapter I demo — THE SEED. Two "scribes" (canvases) each construct their own
 * PCG32 from the same seed and draw a founding star-chart, independently. The
 * demo then compares their pixels and reports the count — the determinism
 * lesson, proven live rather than asserted.
 */
import { createRng } from '@/engine/rng';
import type { Rng } from '@/engine/types';
import { placeName } from '../proc';
import type { Demo } from './types';

const W = 360;
const H = 270;

function drawChart(canvas: HTMLCanvasElement, seed: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const fate = createRng(seed, 'fate');

  // Night sky wash.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#060913');
  bg.addColorStop(1, '#141126');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // The star guild reads its own thread of fate.
  const stars = fate.fork('stars');
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 150; i++) {
    const x = stars.next() * W;
    const y = stars.next() * H;
    const r = 0.4 + stars.next() * 1.3;
    const a = 0.25 + stars.next() * 0.75;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(232, 226, 212, ${a.toFixed(3)})`;
    ctx.fill();
    if (i < 40) pts.push([x, y]);
  }

  // The chart-makers connect what the stars gave them.
  const lines = fate.fork('lines');
  ctx.strokeStyle = 'rgba(232, 180, 74, 0.28)';
  ctx.lineWidth = 0.7;
  for (let c = 0; c < 5; c++) {
    let [x, y] = lines.pick(pts);
    ctx.beginPath();
    ctx.moveTo(x, y);
    const hops = 2 + lines.int(3);
    for (let h = 0; h < hops; h++) {
      [x, y] = lines.pick(pts);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // The founding sigil: k-fold symmetry, because symbols are cheap in polar space.
  const sigil = fate.fork('sigil');
  drawSigil(ctx, sigil, W / 2, H / 2, 62);

  // The name the seed brings forth.
  const name = placeName(fate.fork('names'));
  ctx.fillStyle = 'rgba(232, 180, 74, 0.9)';
  ctx.font = '13px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(`the world of ${name}`, W / 2, H - 14);
}

function drawSigil(ctx: CanvasRenderingContext2D, rng: Rng, cx: number, cy: number, radius: number): void {
  const k = 5 + rng.int(4); // 5..8-fold symmetry
  const strokes = 2 + rng.int(2);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(232, 180, 74, 0.75)';
  ctx.lineWidth = 1.1;
  for (let s = 0; s < strokes; s++) {
    // One polar polyline, echoed k times around the circle.
    const segs = 3 + rng.int(3);
    const pts: Array<[number, number]> = [];
    for (let p = 0; p <= segs; p++) {
      const ang = (p / segs) * (Math.PI / k) * 2;
      const rad = radius * (0.25 + rng.next() * 0.75);
      pts.push([ang, rad]);
    }
    for (let mirror = 0; mirror < k; mirror++) {
      const base = (mirror / k) * Math.PI * 2;
      ctx.beginPath();
      for (let p = 0; p < pts.length; p++) {
        const [ang, rad] = pts[p];
        const x = Math.cos(base + ang) * rad;
        const y = Math.sin(base + ang) * rad;
        if (p === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  ctx.beginPath();
  ctx.arc(0, 0, radius + 8, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(232, 180, 74, 0.3)';
  ctx.stroke();
  ctx.restore();
}

/** First few draws of a stream, for the fate table. */
function draws(rng: Rng, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(rng.next().toFixed(6));
  return out.join('  ');
}

export const seedDemo: Demo = (root, ctx) => {
  root.innerHTML = `
    <div class="canvas-pair">
      <figure><canvas id="scribe-a" width="${W}" height="${H}"></canvas><figcaption>Scribe A — seed ${ctx.seed}</figcaption></figure>
      <figure><canvas id="scribe-b" width="${W}" height="${H}"></canvas><figcaption>Scribe B — seed ${ctx.seed}</figcaption></figure>
    </div>
    <div class="controls">
      <label>seed <input id="seed-in" type="number" value="${ctx.seed}" /></label>
      <button id="prev-fate">◂ previous fate</button>
      <button id="next-fate">next fate ▸</button>
    </div>
    <div class="readout" id="verdict"></div>
    <div class="readout" id="fates"></div>
  `;

  const a = root.querySelector<HTMLCanvasElement>('#scribe-a')!;
  const b = root.querySelector<HTMLCanvasElement>('#scribe-b')!;
  drawChart(a, ctx.seed);
  drawChart(b, ctx.seed);

  // Compare the scribes' work, pixel by pixel.
  const da = a.getContext('2d')!.getImageData(0, 0, W, H).data;
  const db = b.getContext('2d')!.getImageData(0, 0, W, H).data;
  let diff = 0;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) diff++;
  const verdict = root.querySelector('#verdict')!;
  verdict.innerHTML =
    diff === 0
      ? `<span class="ok">✓ ${(da.length / 4).toLocaleString('en-US')} pixels compared — the scribes agree exactly.</span>`
      : `<span class="warn">✗ ${diff} channel(s) differ — determinism is broken; the gate would turn red.</span>`;

  // The fate table: independent forks of the same seed.
  const fresh = () => createRng(ctx.seed, 'fate');
  root.querySelector('#fates')!.textContent =
    `fate           ${draws(fresh(), 4)}\n` +
    `fate/stars     ${draws(fresh().fork('stars'), 4)}\n` +
    `fate/sigil     ${draws(fresh().fork('sigil'), 4)}`;

  const input = root.querySelector<HTMLInputElement>('#seed-in')!;
  input.addEventListener('change', () => ctx.onSeedChange(Math.trunc(Number(input.value) || 0)));
  root.querySelector('#next-fate')!.addEventListener('click', () => ctx.onSeedChange(ctx.seed + 1));
  root.querySelector('#prev-fate')!.addEventListener('click', () => ctx.onSeedChange(ctx.seed - 1));
};
