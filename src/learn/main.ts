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
import { applyWorldProfile, DEFAULT_WORLD_PROFILE } from '@/engine/world-profile';
import { renderMarkdown } from './md';
import type { Demo, DemoCtx } from './demos/types';
import { seedDemo } from './demos/seed';
import { landDemo } from './demos/land';
import { peopleDemo } from './demos/people';
import { ledgerDemo } from './demos/ledger';
import { gateDemo } from './demos/gate';
import { MISSIONS, type MissionEvidence, type MissionResult } from './course';

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
const PROGRESS_KEY = 'ironsight-academy-progress-v1';

const params = new URLSearchParams(location.search);
const FROZEN = params.has('frozen');
let seed = Math.trunc(Number(params.get('seed') ?? DEFAULT_SEED)) || DEFAULT_SEED;
function storedProgress(): string[] {
  if (FROZEN) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const completed = new Set<string>(storedProgress());
let evidence: MissionEvidence = {};
let missionResult: MissionResult = { complete: false, feedback: '' };

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

function saveProgress(): void {
  if (!FROZEN) localStorage.setItem(PROGRESS_KEY, JSON.stringify([...completed]));
}

/**
 * The deep-link out of the academy and into the running game. The seed the
 * learner has been shaping across the chapters is carried through the shared
 * WorldProfile contract, so the terrain they shaped in Chapter II is the terrain
 * the engine bakes. `applyWorldProfile` builds the same `?teach=1&seed=…` link
 * the forge and the durable publisher produce — one contract, three doors.
 */
function worldBridge(): string {
  const gameUrl = applyWorldProfile(new URL('../', location.href), {
    ...DEFAULT_WORLD_PROFILE,
    seed,
  }).href;
  const forgeUrl = new URL('../forge/', location.href);
  forgeUrl.searchParams.set('seed', String(seed >>> 0));
  return `
    <div class="worldbridge" aria-label="Enter the living world">
      <span class="worldbridge-kicker">The bridge · seed #${seed}</span>
      <p>The same seed that shaped this map boots the real 3D world.</p>
      <a class="worldbridge-play" href="${gameUrl}">Walk this world ▸</a>
      <a class="worldbridge-forge" href="${forgeUrl.href}">Name it first ↗</a>
    </div>`;
}

function updateMissionUi(chapter: Chapter): void {
  const mission = MISSIONS[chapter.id];
  const status = document.getElementById('mission-status');
  if (status) {
    status.className = `mission-status ${missionResult.complete ? 'complete' : ''}`;
    status.innerHTML = `
      <span class="mission-mark">${missionResult.complete ? '✓' : '◇'}</span>
      <span>${missionResult.feedback}</span>
    `;
  }
  const count = document.getElementById('progress-count');
  if (count) count.textContent = `${completed.size}/${CHAPTERS.length} missions`;
  const meter = document.getElementById('progress-meter');
  if (meter) meter.style.setProperty('--progress', `${(completed.size / CHAPTERS.length) * 100}%`);
  for (const link of document.querySelectorAll<HTMLElement>('[data-chapter]')) {
    const mastered = completed.has(link.dataset.chapter ?? '');
    link.classList.toggle('mastered', mastered);
    const check = link.querySelector('.chapter-check');
    if (check) check.textContent = mastered ? '✓' : '';
  }
  probe.mission = { id: mission.id, ...missionResult };
  probe.completed = [...completed];
  probe.evidence = { ...evidence };
}

function reportEvidence(chapter: Chapter, next: MissionEvidence): void {
  evidence = { ...evidence, ...next };
  missionResult = MISSIONS[chapter.id].evaluate(evidence);
  if (missionResult.complete && !completed.has(chapter.id)) {
    completed.add(chapter.id);
    saveProgress();
  }
  updateMissionUi(chapter);
}

function render(): void {
  if (disposeDemo) {
    disposeDemo();
    disposeDemo = null;
  }
  const chapter = currentChapter();
  const mission = MISSIONS[chapter.id];
  evidence = {};
  missionResult = mission.evaluate(evidence);
  const index = CHAPTERS.indexOf(chapter);
  const prev = CHAPTERS[index - 1];
  const next = CHAPTERS[index + 1];

  const nav = CHAPTERS.map(
    (c) => `
      <a class="chapter ${c === chapter ? 'active' : ''} ${completed.has(c.id) ? 'mastered' : ''}"
         data-chapter="${c.id}" href="${hrefFor(c.id)}">
        <span class="sigil">${c.sigil}</span>
        <span>${c.roman}. ${c.title}</span>
        <span class="chapter-check">${completed.has(c.id) ? '✓' : ''}</span>
      </a>`,
  ).join('');

  app.innerHTML = `
    <nav class="chapters">
      <div class="masthead">
        <div class="title">THE CHRONICLE OF<br/>HARBOUR REACH</div>
        <div class="subtitle">a JAMStack academy — JavaScript, APIs, Markup — taught by building a civilization from one seed</div>
      </div>
      <div class="progress-block">
        <div><span>civilization progress</span><strong id="progress-count">${completed.size}/${CHAPTERS.length} missions</strong></div>
        <div class="progress-meter" id="progress-meter" style="--progress:${(completed.size / CHAPTERS.length) * 100}%"></div>
      </div>
      ${nav}
      ${worldBridge()}
      <div class="footer">
        a <a href="https://dharmicdata.org" rel="noopener">DharmicData.org</a> teaching world<br/>
        built from the <a href="../" rel="noopener">IRONSIGHT</a> engine ·
        <a href="https://github.com/ChaiWithJai/ironsight" rel="noopener">source</a>
      </div>
    </nav>
    <main class="scroll">
      <h1>${chapter.roman}. ${chapter.title}</h1>
      <p class="epigraph">${chapter.epigraph}</p>
      <section class="mission" aria-labelledby="mission-title">
        <div class="mission-kicker">Field mission · ${chapter.roman}</div>
        <h2 id="mission-title">${mission.objective}</h2>
        <p>${mission.task}</p>
        <div class="mission-success"><strong>Proof:</strong> ${mission.success}</div>
        <div class="mission-status" id="mission-status" role="status" aria-live="polite"></div>
      </section>
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
    report(nextEvidence) {
      reportEvidence(chapter, nextEvidence);
    },
  };
  const disposer = chapter.demo(document.getElementById('demo-mount')!, ctx);
  if (disposer) disposeDemo = disposer;

  updateMissionUi(chapter);
  probe.ready = true;
}

/** The capture harness's contract, mirroring the game's window.__HARNESS__. */
const probe = {
  ready: false,
  chapters: CHAPTERS.map((c) => c.id),
  mission: { id: '', complete: false, feedback: '' },
  completed: [] as string[],
  evidence: {} as MissionEvidence,
  goto(id: string) {
    probe.ready = false;
    location.hash = `#/${id}`;
  },
  resetProgress() {
    completed.clear();
    saveProgress();
    render();
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
