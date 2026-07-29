/**
 * THE CHRONICLE OF HARBOUR REACH — a JAMStack academy. LEARN owns this lane.
 *
 * A second, tiny Vite entry that teaches the JAMStack (JavaScript, APIs,
 * Markup) through worldbuilding: five chapters, each a Markdown scroll plus a
 * live deterministic demo. It deliberately imports nothing heavy — no three.js,
 * no rapier — only the engine's shared seams (rng), so the dev loop is
 * instant and the deployed page is a few kilobytes of JS.
 *
 * The lane obeys the same laws as the game and teaches by obeying them:
 * seeded randomness only, no wall clock, no runtime network, and a `?frozen`
 * mode that renders pixel-stable states for tools/learn-shots.mjs.
 */
import './theme.css';
import { renderMarkdown } from './md';
import type { Demo, DemoCtx } from './demos/types';
import { seedDemo } from './demos/seed';
import { landDemo } from './demos/land';
import { peopleDemo } from './demos/people';
import { ledgerDemo } from './demos/ledger';
import { gateDemo } from './demos/gate';

import seedMd from './lessons/01-seed.md?raw';
import landMd from './lessons/02-land.md?raw';
import peopleMd from './lessons/03-people.md?raw';
import ledgerMd from './lessons/04-ledger.md?raw';
import gateMd from './lessons/05-gate.md?raw';

interface Chapter {
  id: string;
  sigil: string;
  roman: string;
  title: string;
  epigraph: string;
  pillar: string;
  md: string;
  demoTitle: string;
  demo: Demo;
}

const CHAPTERS: Chapter[] = [
  {
    id: 'seed',
    sigil: '✶',
    roman: 'I',
    title: 'The Seed',
    epigraph: 'Speak a number, and a world must follow. — on time, fate, and determinism',
    pillar: 'JavaScript · determinism',
    md: seedMd,
    demoTitle: 'The Founding Star-Chart',
    demo: seedDemo,
  },
  {
    id: 'land',
    sigil: '⛰',
    roman: 'II',
    title: 'The Land',
    epigraph: 'The mountains are an opinion held by mathematics. — on places',
    pillar: 'JavaScript · procedural generation',
    md: landMd,
    demoTitle: 'The Shaping of the World',
    demo: landDemo,
  },
  {
    id: 'people',
    sigil: '𐂃',
    roman: 'III',
    title: 'The People',
    epigraph: 'Character is the same physics wearing a different will. — on characters and time',
    pillar: 'JavaScript · simulation',
    md: peopleMd,
    demoTitle: 'The Peopling of the Shore',
    demo: peopleDemo,
  },
  {
    id: 'ledger',
    sigil: '📜',
    roman: 'IV',
    title: 'The Ledger',
    epigraph: 'A record is an API that learned to sit still. — on symbols and records',
    pillar: 'APIs · build-time data',
    md: ledgerMd,
    demoTitle: 'The Chronicle of the Eras',
    demo: ledgerDemo,
  },
  {
    id: 'gate',
    sigil: '⚖',
    roman: 'V',
    title: 'The Gate',
    epigraph: 'The law is only real if something enforces it. — on containing entropy',
    pillar: 'Markup · testing · the loop',
    md: gateMd,
    demoTitle: 'The Rituals of the Gate',
    demo: gateDemo,
  },
];

const DEFAULT_SEED = 108;

const params = new URLSearchParams(location.search);
const FROZEN = params.has('frozen');
let seed = Math.trunc(Number(params.get('seed') ?? DEFAULT_SEED)) || DEFAULT_SEED;

const app = document.getElementById('academy')!;
let disposeDemo: (() => void) | null = null;

function currentChapter(): Chapter {
  const id = location.hash.replace(/^#\/?/, '');
  return CHAPTERS.find((c) => c.id === id) ?? CHAPTERS[0];
}

function hrefFor(id: string): string {
  const q = new URLSearchParams();
  if (seed !== DEFAULT_SEED) q.set('seed', String(seed));
  if (FROZEN) q.set('frozen', '');
  const qs = q.toString();
  return `${location.pathname}${qs ? '?' + qs : ''}#/${id}`;
}

function render(): void {
  if (disposeDemo) {
    disposeDemo();
    disposeDemo = null;
  }
  const chapter = currentChapter();
  const index = CHAPTERS.indexOf(chapter);
  const prev = CHAPTERS[index - 1];
  const next = CHAPTERS[index + 1];

  const nav = CHAPTERS.map(
    (c) => `
      <a class="chapter ${c === chapter ? 'active' : ''}" href="${hrefFor(c.id)}">
        <span class="sigil">${c.sigil}</span>
        <span>${c.roman}. ${c.title}</span>
      </a>`,
  ).join('');

  app.innerHTML = `
    <nav class="chapters">
      <div class="masthead">
        <div class="title">THE CHRONICLE OF<br/>HARBOUR REACH</div>
        <div class="subtitle">a JAMStack academy — JavaScript, APIs, Markup — taught by building a civilization from one seed</div>
      </div>
      ${nav}
      <div class="footer">
        a <a href="https://dharmicdata.org" rel="noopener">DharmicData.org</a> teaching world<br/>
        built from the <a href="../" rel="noopener">IRONSIGHT</a> engine ·
        <a href="https://github.com/gillworks/ironsight" rel="noopener">source</a>
      </div>
    </nav>
    <main class="scroll">
      <h1>${chapter.roman}. ${chapter.title}</h1>
      <p class="epigraph">${chapter.epigraph}</p>
      <section class="demo">
        <header><span>${chapter.demoTitle}</span><span class="kind">${chapter.pillar}</span></header>
        <div class="body" id="demo-mount"></div>
      </section>
      <div id="lesson">${renderMarkdown(chapter.md)}</div>
      <div class="pager">
        <span>${prev ? `<a href="${hrefFor(prev.id)}">◂ ${prev.roman}. ${prev.title}</a>` : ''}</span>
        <span>${next ? `<a href="${hrefFor(next.id)}">${next.roman}. ${next.title} ▸</a>` : ''}</span>
      </div>
    </main>
  `;

  const ctx: DemoCtx = {
    seed,
    frozen: FROZEN,
    onSeedChange(newSeed: number) {
      seed = newSeed;
      history.replaceState(null, '', hrefFor(chapter.id));
      render();
    },
  };
  const disposer = chapter.demo(document.getElementById('demo-mount')!, ctx);
  if (disposer) disposeDemo = disposer;

  probe.ready = true;
}

/** The capture harness's contract, mirroring the game's window.__HARNESS__. */
const probe = {
  ready: false,
  chapters: CHAPTERS.map((c) => c.id),
  goto(id: string) {
    probe.ready = false;
    location.hash = `#/${id}`;
  },
};
declare global {
  interface Window {
    __LEARN__?: typeof probe;
  }
}
window.__LEARN__ = probe;

window.addEventListener('hashchange', render);
render();
