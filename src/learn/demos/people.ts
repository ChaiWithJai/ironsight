/**
 * Chapter III demo — THE PEOPLE. Twelve wanderers on Chapter II's terrain,
 * advancing in fixed ticks. Each carries a forked rng stream; each seeks
 * fertile land near the waterline and founds a named settlement when it finds
 * it. The entire history is state = f(seed, tick): "rebirth" replays it
 * identically, and frozen mode renders exactly tick 240 for the screenshot
 * harness.
 */
import { createRng } from '@/engine/rng';
import type { Rng } from '@/engine/types';
import { placeName } from '../proc';
import { computeField, paintField, type Field } from './terrain';
import type { Demo } from './types';

const W = 320;
const H = 180;
const SEA = 0.38;
const OCTAVES = 5;
const VILLAGERS = 12;
const SEASON = 20; // ticks per press of "advance a season"
const FROZEN_TICKS = 240;

interface Villager {
  x: number;
  y: number;
  rng: Rng;
  settled: boolean;
  trail: Array<[number, number]>;
}

interface Settlement {
  x: number;
  y: number;
  name: string;
}

/** Fertility peaks in a band of low land just above the waterline. */
function fertility(h: number): number {
  if (h < SEA) return 0;
  const above = h - SEA;
  const band = 0.1;
  return Math.max(0, 1 - Math.abs(above - band) / band);
}

class Sim {
  readonly field: Field;
  readonly villagers: Villager[] = [];
  readonly settlements: Settlement[] = [];
  tick = 0;

  constructor(readonly seed: number) {
    this.field = computeField(seed, OCTAVES, W, H);
    const root = createRng(seed, 'people');
    for (let i = 0; i < VILLAGERS; i++) {
      const rng = root.fork(`villager/${i}`);
      // Wander in from a random point on dry land.
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 200; tries++) {
        x = rng.int(W);
        y = rng.int(H);
        if (this.heightOf(x, y) >= SEA) break;
      }
      this.villagers.push({ x, y, rng, settled: false, trail: [] });
    }
  }

  heightOf(x: number, y: number): number {
    return this.field.height[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))];
  }

  step(): void {
    this.tick++;
    for (const v of this.villagers) {
      if (v.settled) continue;
      // Consider the eight neighbours and staying put; prefer fertile ground,
      // with a thread of personal fate breaking the ties.
      let bestX = v.x;
      let bestY = v.y;
      let bestScore = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(W - 1, v.x + dx));
          const ny = Math.max(0, Math.min(H - 1, v.y + dy));
          const h = this.heightOf(nx, ny);
          if (h < SEA) continue; // nobody walks into the sea
          const score = fertility(h) + v.rng.next() * 0.6;
          if (score > bestScore) {
            bestScore = score;
            bestX = nx;
            bestY = ny;
          }
        }
      }
      v.trail.push([v.x, v.y]);
      if (v.trail.length > 60) v.trail.shift();
      v.x = bestX;
      v.y = bestY;

      // Good land, a patient heart, and a little luck founds a town — but not
      // on top of an existing one.
      if (fertility(this.heightOf(v.x, v.y)) > 0.75 && v.rng.bool(0.02)) {
        const tooClose = this.settlements.some((s) => (s.x - v.x) ** 2 + (s.y - v.y) ** 2 < 24 ** 2);
        if (!tooClose) {
          v.settled = true;
          this.settlements.push({ x: v.x, y: v.y, name: placeName(v.rng) });
        }
      }
    }
  }
}

export const peopleDemo: Demo = (root, ctx) => {
  root.innerHTML = `
    <canvas id="map" width="${W}" height="${H}"></canvas>
    <div class="controls">
      <label>seed <input id="seed-in" type="number" value="${ctx.seed}" /></label>
      <button id="season">advance a season (+${SEASON} ticks)</button>
      <button id="auto">${ctx.frozen ? 'autoplay (off in frozen mode)' : 'autoplay'}</button>
      <button id="rebirth">rebirth ↺</button>
    </div>
    <div class="readout" id="stats"></div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>('#map')!;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(W, H);
  const stats = root.querySelector('#stats')!;
  const autoBtn = root.querySelector<HTMLButtonElement>('#auto')!;

  let sim = new Sim(ctx.seed);
  let playing = false;
  let raf = 0;
  let frameParity = 0;
  let interacted = false;

  const draw = () => {
    paintField(img, sim.field, SEA);
    g.putImageData(img, 0, 0);
    // Trails first, then the living, then the founded.
    g.fillStyle = 'rgba(232, 180, 74, 0.25)';
    for (const v of sim.villagers) for (const [tx, ty] of v.trail) g.fillRect(tx, ty, 1, 1);
    for (const v of sim.villagers) {
      if (v.settled) continue;
      g.fillStyle = '#ffd97a';
      g.fillRect(v.x - 1, v.y - 1, 2, 2);
    }
    g.font = '8px ui-monospace, monospace';
    g.textAlign = 'center';
    for (const s of sim.settlements) {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(s.x, s.y - 3);
      g.lineTo(s.x + 3, s.y);
      g.lineTo(s.x, s.y + 3);
      g.lineTo(s.x - 3, s.y);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(255, 255, 255, 0.9)';
      g.fillText(s.name, s.x, s.y - 5);
    }
    const wandering = sim.villagers.filter((v) => !v.settled).length;
    stats.textContent =
      `tick ${sim.tick} · ${wandering} wandering · ${sim.settlements.length} settlement(s)` +
      (sim.settlements.length ? ` — ${sim.settlements.map((s) => s.name).join(', ')}` : '') +
      `\nstate = f(seed ${ctx.seed}, tick ${sim.tick}) — rebirth replays this history exactly`;
    ctx.report({ interacted, tick: sim.tick, settlements: sim.settlements.length });
  };

  const advance = (ticks: number) => {
    for (let i = 0; i < ticks; i++) sim.step();
    draw();
  };

  const loop = () => {
    // One sim tick every third frame: time is counted in frames, never in ms.
    frameParity = (frameParity + 1) % 3;
    if (frameParity === 0) advance(1);
    if (playing) raf = requestAnimationFrame(loop);
  };

  if (ctx.frozen) {
    advance(FROZEN_TICKS);
  } else {
    draw();
  }

  root.querySelector('#season')!.addEventListener('click', () => {
    interacted = true;
    advance(SEASON);
  });
  root.querySelector('#rebirth')!.addEventListener('click', () => {
    interacted = true;
    sim = new Sim(ctx.seed);
    draw();
  });
  autoBtn.addEventListener('click', () => {
    if (ctx.frozen) return;
    interacted = true;
    playing = !playing;
    autoBtn.classList.toggle('active', playing);
    if (playing) raf = requestAnimationFrame(loop);
    else cancelAnimationFrame(raf);
  });

  const seedIn = root.querySelector<HTMLInputElement>('#seed-in')!;
  seedIn.addEventListener('change', () => ctx.onSeedChange(Math.trunc(Number(seedIn.value) || 0)));

  return () => cancelAnimationFrame(raf);
};
