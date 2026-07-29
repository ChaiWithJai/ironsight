/**
 * LIVE FIELD LAB — teaching inside the actual IRONSIGHT game.
 *
 * This is deliberately an observer. It reads the same typed service contracts
 * the game uses and subscribes to real simulation events; it never poses the
 * world, teleports the player, emits success events, or mutates gameplay.
 * A mission turns green only when the shipped mechanic supplies the evidence.
 */
import type { Services } from '@/engine/types';
import { isAuthoredWorld, readWorldProfile, type WorldProfile } from '@/engine/world-profile';

interface FieldEvidence {
  distanceTravelled: number;
  shotsFired: number;
  hitsLanded: number;
  propsDamaged: number;
  objectivesVisited: string[];
}

interface FieldMission {
  id: string;
  sigil: string;
  title: string;
  jam: string;
  instruction: string;
  proof: (evidence: FieldEvidence) => boolean;
  feedback: (evidence: FieldEvidence) => string;
}

const MISSIONS: FieldMission[] = [
  {
    id: 'move',
    sigil: '⌖',
    title: 'Inhabit the place',
    jam: 'JavaScript · state',
    instruction: 'Move at least 12 metres with W A S D. This is the real procedural terrain.',
    proof: (e) => e.distanceTravelled >= 12,
    feedback: (e) => `${Math.min(12, e.distanceTravelled).toFixed(1)} / 12.0 m travelled`,
  },
  {
    id: 'fire',
    sigil: '✦',
    title: 'Cause an event',
    jam: 'APIs · events',
    instruction: 'Fire the service rifle. A typed weapon event—not a button click—proves the action.',
    proof: (e) => e.shotsFired > 0,
    feedback: (e) => `${e.shotsFired} local-player weapon event${e.shotsFired === 1 ? '' : 's'}`,
  },
  {
    id: 'shape',
    sigil: '⚒',
    title: 'Change the world',
    jam: 'JavaScript · simulation',
    instruction: 'Hit a soldier or damage destructible cover. The world must report the consequence.',
    proof: (e) => e.hitsLanded > 0 || e.propsDamaged > 0,
    feedback: (e) => `${e.hitsLanded} actor hit${e.hitsLanded === 1 ? '' : 's'} · ${e.propsDamaged} cover impact${e.propsDamaged === 1 ? '' : 's'}`,
  },
  {
    id: 'place',
    sigil: '⚑',
    title: 'Enter history',
    jam: 'Markup · meaning',
    instruction: 'Enter Alpha, Bravo, or Charlie. Code becomes a place when people give it meaning.',
    proof: (e) => e.objectivesVisited.length > 0,
    feedback: (e) =>
      e.objectivesVisited.length > 0 ? `${e.objectivesVisited.join(', ')} visited` : 'no named place visited yet',
  },
];

export interface TeachingProbe {
  readonly available: true;
  readonly evidence: FieldEvidence;
  readonly completed: string[];
  readonly ready: boolean;
  readonly worldProfile: WorldProfile;
  /** The generating seed the game actually baked — proves the lesson's world is this world. */
  readonly worldSeed: number;
  readonly authoredWorld: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __TEACH__: TeachingProbe | undefined;
}

const PROGRESS_KEY = 'ironsight-live-field-lab-v1';

interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function installTeachingMode(container: HTMLElement, services: Services): () => void {
  const worldProfile = readWorldProfile(location.search);
  const local = services.player.localEntity;
  const start = { ...services.player.state.position };
  const visited = new Set<string>();
  const evidence: FieldEvidence = {
    distanceTravelled: 0,
    shotsFired: 0,
    hitsLanded: 0,
    propsDamaged: 0,
    objectivesVisited: [],
  };
  const completed = new Set<string>();
  const disposers: Array<() => void> = [];

  const style = element('style');
  style.textContent = `
    #field-lab {
      position: fixed; z-index: 20; top: 18px; right: 18px; width: min(340px, calc(100vw - 36px));
      color: #e8e2d4; background: rgba(8, 12, 17, .92); border: 1px solid #8b6b2d;
      border-radius: 8px; box-shadow: 0 18px 60px rgba(0,0,0,.5);
      font: 13px/1.45 system-ui, sans-serif; backdrop-filter: blur(10px);
    }
    #field-lab * { box-sizing: border-box; }
    #field-lab header { display:flex; justify-content:space-between; gap:12px; padding:13px 15px;
      border-bottom:1px solid #27313d; color:#e8b44a; }
    #field-lab header strong { letter-spacing:.11em; text-transform:uppercase; font-size:11px; }
    #field-lab button { color:#9a937f; background:none; border:0; cursor:pointer; font-size:12px; }
    #field-lab .field-intro { padding:12px 15px 6px; color:#aaa491; font-size:12px; }
    #field-lab ol { list-style:none; margin:0; padding:6px 10px 12px; }
    #field-lab li { display:grid; grid-template-columns:24px 1fr; gap:8px; padding:9px 6px;
      border-top:1px solid rgba(39,49,61,.75); }
    #field-lab li:first-child { border-top:0; }
    #field-lab .field-sigil { color:#e8b44a; font-family:ui-monospace,monospace; }
    #field-lab .field-title { color:#f3eee3; font-weight:600; }
    #field-lab .field-jam { float:right; color:#777f88; font:9px ui-monospace,monospace;
      text-transform:uppercase; letter-spacing:.06em; }
    #field-lab .field-task { color:#aaa491; margin-top:2px; font-size:11px; }
    #field-lab .field-proof { color:#76b9d8; margin-top:4px; font:10px ui-monospace,monospace; }
    #field-lab li.complete .field-sigil, #field-lab li.complete .field-proof { color:#7dc47a; }
    #field-lab li:not(.current) .field-task { display:none; }
    #field-lab li:not(.current):not(.complete) .field-proof { display:none; }
    #field-lab li.current { background:rgba(42,126,168,.07); }
    #field-lab .field-footer { display:flex; justify-content:space-between; padding:10px 15px;
      border-top:1px solid #27313d; font:10px ui-monospace,monospace; color:#9a937f; }
    #field-lab .field-footer a { color:#e8b44a; }
    #field-lab.collapsed > :not(header) { display:none; }
  `;
  document.head.appendChild(style);

  const panel = element('aside');
  panel.id = 'field-lab';
  panel.setAttribute('aria-label', 'JAMStack live field lab');
  const header = element('header');
  const heading = element('strong');
  heading.textContent = `${worldProfile.sigil} ${worldProfile.civilization}`;
  const toggle = element('button');
  toggle.type = 'button';
  toggle.textContent = 'hide';
  toggle.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    toggle.textContent = panel.classList.contains('collapsed') ? 'show missions' : 'hide';
  });
  header.append(heading, toggle);

  const intro = element('div', 'field-intro');
  intro.textContent =
    `${worldProfile.era}. This terrain was baked from seed #${worldProfile.seed} — ` +
    `the same seed that shaped the world in the academy. You are inside the proof now; ` +
    `these missions listen to the shipped game.`;
  const list = element('ol');
  const rows = new Map<string, HTMLLIElement>();
  for (const mission of MISSIONS) {
    const row = element('li');
    row.dataset.mission = mission.id;
    const sigil = element('span', 'field-sigil');
    sigil.textContent = mission.sigil;
    const body = element('div');
    const title = element('div', 'field-title');
    title.textContent = mission.title;
    const jam = element('span', 'field-jam');
    jam.textContent = mission.jam;
    title.appendChild(jam);
    const task = element('div', 'field-task');
    task.textContent = mission.instruction;
    const proof = element('div', 'field-proof');
    proof.textContent = mission.feedback(evidence);
    body.append(title, task, proof);
    row.append(sigil, body);
    list.appendChild(row);
    rows.set(mission.id, row);
  }
  const footer = element('div', 'field-footer');
  const progress = element('span');
  const back = element('a');
  back.href = './forge/';
  back.textContent = isAuthoredWorld(worldProfile) ? 'edit world ↗' : 'forge world ↗';
  footer.append(progress, back);
  panel.append(header, intro, list, footer);
  container.appendChild(panel);

  function render(): void {
    evidence.objectivesVisited = [...visited];
    const active = MISSIONS.find((mission) => !mission.proof(evidence))?.id ?? '';
    for (const mission of MISSIONS) {
      const done = mission.proof(evidence);
      if (done) completed.add(mission.id);
      const row = rows.get(mission.id);
      if (!row) continue;
      row.classList.toggle('complete', done);
      row.classList.toggle('current', mission.id === active);
      const sigil = row.querySelector('.field-sigil');
      if (sigil) sigil.textContent = done ? '✓' : mission.sigil;
      const proof = row.querySelector('.field-proof');
      if (proof) proof.textContent = mission.feedback(evidence);
    }
    progress.textContent = `${completed.size}/${MISSIONS.length} live mechanics proven`;
    if (completed.size === MISSIONS.length) {
      progress.textContent = '4/4 · the world is the lesson';
      localStorage.setItem(PROGRESS_KEY, 'complete');
    }
    globalThis.__TEACH__ = {
      available: true,
      ready: true,
      evidence,
      completed: [...completed],
      worldProfile,
      worldSeed: worldProfile.seed,
      authoredWorld: isAuthoredWorld(worldProfile),
    };
  }

  disposers.push(
    services.events.on('weapon.fired', (event) => {
      if (event.shooter !== local) return;
      evidence.shotsFired++;
      render();
    }),
    services.events.on('damage.applied', (event) => {
      if (event.attacker !== local || event.target === local) return;
      evidence.hitsLanded++;
      render();
    }),
    services.events.on('prop.damaged', (event) => {
      if (event.info.attacker !== local) return;
      evidence.propsDamaged++;
      render();
    }),
  );

  let previous = { ...start };
  let raf = 0;
  const observe = () => {
    const state = services.player.state;
    const step = distance(previous, state.position);
    if (step < 2) evidence.distanceTravelled += step;
    previous = { ...state.position };

    for (const point of services.level.capturePoints) {
      const flat = Math.hypot(state.position.x - point.centre.x, state.position.z - point.centre.z);
      if (flat <= point.radius) visited.add(`${String(point.id)} · ${point.label}`);
    }
    render();
    raf = requestAnimationFrame(observe);
  };
  render();
  raf = requestAnimationFrame(observe);

  return () => {
    cancelAnimationFrame(raf);
    for (const dispose of disposers) dispose();
    panel.remove();
    style.remove();
    delete globalThis.__TEACH__;
  };
}
