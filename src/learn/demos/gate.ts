/**
 * Chapter V demo — THE GATE. Three determinism rituals, re-run live on every
 * page load, using the same functions the earlier chapters draw with. The
 * verdicts are computed, not asserted: if determinism ever broke, this page
 * would show it red.
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
  const rows = RITES.map((rite) => {
    const { pass, detail } = rite.run(ctx.seed);
    return `
      <div class="gate">
        <div class="verdict ${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</div>
        <div>
          <div class="what">${rite.name}</div>
          <div class="how">${rite.how}</div>
          <div class="how">${detail}</div>
        </div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="gate-list">${rows}</div>
    <div class="readout">rituals were re-run just now, in your browser, at seed ${ctx.seed} —
reload the page and the fingerprints will not move. That stability is what makes
screenshots of this academy diffable, and what made 203 parallel agents mergeable.</div>
  `;
};
