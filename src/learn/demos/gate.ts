/**
 * Chapter V demo — THE GATE. Three determinism rituals, re-run live on every
 * learner request, using the same functions the earlier chapters draw with.
 * The verdicts are computed, not asserted: if determinism ever broke, this
 * page would show it red.
 */
import { createRng } from '@/engine/rng';
import { fingerprint, heightAt } from '../proc';
import type { Demo } from './types';

interface Rite {
  name: string;
  how: string;
  run(seed: number): { pass: boolean; detail: string };
}

const RITES: Rite[] = [
  {
    name: 'The Rite of the Twin Scribes',
    how: 'two independent PCG32 generators, same seed, 4 096 draws each — fingerprints must match',
    run(seed) {
      const drawsOf = () => {
        const rng = createRng(seed, 'rite');
        const out = new Float64Array(4096);
        for (let i = 0; i < out.length; i++) out[i] = rng.next();
        return out;
      };
      const a = fingerprint(drawsOf());
      const b = fingerprint(drawsOf());
      return { pass: a === b, detail: `scribe A ${a} · scribe B ${b}` };
    },
  },
  {
    name: 'The Rite of the Unmoved Mountain',
    how: 'the terrain of Chapter II, computed twice and fingerprinted — same seed, same mountain',
    run(seed) {
      const sample = () => {
        const out = new Float64Array(64 * 36);
        let i = 0;
        for (let y = 0; y < 36; y++)
          for (let x = 0; x < 64; x++) out[i++] = heightAt(x / 64, y / 36, seed, 5);
        return out;
      };
      const a = fingerprint(sample());
      const b = fingerprint(sample());
      return { pass: a === b, detail: `survey A ${a} · survey B ${b}` };
    },
  },
  {
    name: 'The Rite of the Separate Threads',
    how: "a decoy draws extra numbers from the root stream — the fork's fate must not move",
    run(seed) {
      const undisturbed = createRng(seed, 'rite').fork('stars').next();
      const rng = createRng(seed, 'rite');
      rng.next();
      rng.next();
      rng.next(); // the decoy consumes the root...
      const disturbed = rng.fork('stars').next(); // ...and the fork must not care
      return {
        pass: undisturbed === disturbed,
        detail: `fork before ${undisturbed.toFixed(9)} · fork after ${disturbed.toFixed(9)}`,
      };
    },
  },
];

export const gateDemo: Demo = (root, ctx) => {
  root.innerHTML = `
    <div class="gate-list" id="gate-list" role="list">
      ${RITES.map(
        (rite) => `
        <div class="gate pending" role="listitem">
          <div class="verdict"><span class="sr-only">Status: </span>WAIT</div>
          <div>
            <div class="what">${rite.name}</div>
            <div class="how">${rite.how}</div>
          </div>
        </div>`,
      ).join('')}
    </div>
    <div class="controls"><button id="run-gates" type="button">run the three rituals</button></div>
    <div class="readout" id="gate-readout" role="status" aria-live="polite">The verdicts are waiting for you, not prewritten.</div>
  `;
  ctx.report({ gateRun: false, passed: 0, total: RITES.length });

  root.querySelector('#run-gates')!.addEventListener('click', () => {
    const results = RITES.map((rite) => ({ rite, result: rite.run(ctx.seed) }));
    root.querySelector('#gate-list')!.innerHTML = results
      .map(
        ({ rite, result }) => `
        <div class="gate" role="listitem">
          <div class="verdict ${result.pass ? 'pass' : 'fail'}"><span class="sr-only">Status: </span>${result.pass ? 'PASS' : 'FAIL'}</div>
          <div>
            <div class="what">${rite.name}</div>
            <div class="how">${rite.how}</div>
            <div class="how">${result.detail}</div>
          </div>
        </div>`,
      )
      .join('');
    const passed = results.filter(({ result }) => result.pass).length;
    root.querySelector('#gate-readout')!.textContent =
      `rituals re-run in your browser at seed ${ctx.seed} — ${passed}/${RITES.length} passed. ` +
      'Reload and the fingerprints will not move.';
    ctx.report({ gateRun: true, passed, total: RITES.length });
  });
};
