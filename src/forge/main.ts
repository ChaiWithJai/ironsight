import './theme.css';
import {
  DEFAULT_WORLD_PROFILE,
  applyWorldProfile,
  isAuthoredWorld,
  readWorldProfile,
  worldAuthorshipChecks,
  type WorldProfile,
} from '@/engine/world-profile';
import { publishWorld, type PublishedWorld } from '@/engine/world-publication';

interface PublicationState {
  state: 'portable' | 'saving' | 'saved' | 'fallback';
  id?: string;
  playUrl?: string;
  error?: string;
}

interface ForgeProbe {
  ready: boolean;
  complete: boolean;
  profile: WorldProfile;
  checks: ReturnType<typeof worldAuthorshipChecks>;
  permalink: string;
  publication: PublicationState;
}

declare global {
  interface Window {
    __FORGE__?: ForgeProbe;
  }
}

const mount = document.getElementById('forge');
if (!mount) throw new Error('forge/index.html is missing #forge');

mount.innerHTML = `
  <header class="forge-head">
    <a href="../learn/#/gate">← academy</a>
    <div><span class="eyebrow">DharmicData · transfer mission</span><h1>Civilization Forge</h1></div>
    <a href="../?teach=1">field lab →</a>
  </header>
  <div class="forge-grid">
    <section class="workbench" aria-labelledby="workbench-title">
      <p class="kicker">Create · Bloom level 6</p>
      <h2 id="workbench-title" tabindex="-1">Give computation a culture</h2>
      <p class="lede">Change all four kinds of meaning. JavaScript validates the record, the browser URL is the API, and semantic markup makes it usable. Your link boots the real game.</p>
      <form id="world-form" novalidate>
        <label>
          <span>Civilization <small>identity</small></span>
          <input name="civilization" maxlength="24" required aria-describedby="error-civilization" />
          <span class="field-error" id="error-civilization" role="alert"></span>
        </label>
        <label class="sigil-field">
          <span>Sigil <small>symbol</small></span>
          <input name="sigil" maxlength="8" required aria-describedby="error-sigil" />
          <span class="field-error" id="error-sigil" role="alert"></span>
        </label>
        <label>
          <span>Era <small>time</small></span>
          <input name="era" maxlength="48" required aria-describedby="error-era" />
          <span class="field-error" id="error-era" role="alert"></span>
        </label>
        <fieldset>
          <legend>Named places</legend>
          <label><span>Alpha</span><input name="alpha" maxlength="32" required aria-describedby="error-alpha" /><span class="field-error" id="error-alpha" role="alert"></span></label>
          <label><span>Bravo</span><input name="bravo" maxlength="32" required aria-describedby="error-bravo" /><span class="field-error" id="error-bravo" role="alert"></span></label>
          <label><span>Charlie</span><input name="charlie" maxlength="32" required aria-describedby="error-charlie" /><span class="field-error" id="error-charlie" role="alert"></span></label>
        </fieldset>
      </form>
      <div class="proof" id="proof" role="status" aria-live="polite"></div>
      <div class="actions">
        <button class="publish" type="button" id="publish-world" disabled>Publish durable world</button>
        <a class="enter disabled" id="enter-world" aria-disabled="true">Complete the four changes</a>
        <button type="button" id="reset-world">restore Harbour Reach</button>
      </div>
      <p class="publication-status" id="publication-status" role="status" aria-live="polite"></p>
    </section>
    <section class="chronicle" aria-labelledby="chronicle-name">
      <div class="sky-mark" id="preview-sigil"></div>
      <p class="kicker">Live markup preview</p>
      <h2 id="chronicle-name"></h2>
      <p class="era" id="preview-era"></p>
      <blockquote>Names do not decorate a world. They make coordinates memorable enough to become places.</blockquote>
      <ol class="places" id="preview-places"></ol>
      <div class="stack">
        <div><strong>J</strong><span>JavaScript</span><small>validates and transforms</small></div>
        <div><strong>A</strong><span>API</span><small>URLSearchParams carries the contract</small></div>
        <div><strong>M</strong><span>Markup</span><small>labels meaning for people and machines</small></div>
      </div>
    </section>
  </div>
`;

const form = document.querySelector<HTMLFormElement>('#world-form')!;
const enter = document.querySelector<HTMLAnchorElement>('#enter-world')!;
const publish = document.querySelector<HTMLButtonElement>('#publish-world')!;
const proof = document.querySelector<HTMLElement>('#proof')!;
const publicationStatus = document.querySelector<HTMLElement>('#publication-status')!;
let publication: PublicationState = { state: 'portable' };
const fields = {
  civilization: form.elements.namedItem('civilization') as HTMLInputElement,
  sigil: form.elements.namedItem('sigil') as HTMLInputElement,
  era: form.elements.namedItem('era') as HTMLInputElement,
  alpha: form.elements.namedItem('alpha') as HTMLInputElement,
  bravo: form.elements.namedItem('bravo') as HTMLInputElement,
  charlie: form.elements.namedItem('charlie') as HTMLInputElement,
};
const FIELD_LABEL: Record<keyof typeof fields, string> = {
  civilization: 'Civilization name',
  sigil: 'Sigil',
  era: 'Era',
  alpha: 'Alpha',
  bravo: 'Bravo',
  charlie: 'Charlie',
};
/** Fields the learner has blurred at least once — errors stay silent until then
 *  so the form does not open with every required field already flagged red. */
const touched = new Set<keyof typeof fields>();

function validateField(name: keyof typeof fields): boolean {
  const input = fields[name];
  const error = document.getElementById(`error-${name}`)!;
  const empty = input.value.trim() === '';
  const invalid = touched.has(name) && empty;
  input.setAttribute('aria-invalid', String(invalid));
  error.textContent = invalid ? `${FIELD_LABEL[name]} is required.` : '';
  return !empty;
}

function validateAll(): boolean {
  return (Object.keys(fields) as Array<keyof typeof fields>)
    .map((name) => validateField(name))
    .every(Boolean);
}

for (const name of Object.keys(fields) as Array<keyof typeof fields>) {
  fields[name].addEventListener('blur', () => {
    touched.add(name);
    validateField(name);
  });
}

function values(): WorldProfile {
  const query = new URLSearchParams({
    civ: fields.civilization.value,
    sigil: fields.sigil.value,
    era: fields.era.value,
    alpha: fields.alpha.value,
    bravo: fields.bravo.value,
    charlie: fields.charlie.value,
  });
  return readWorldProfile(query);
}

function gameUrl(profile: WorldProfile): URL {
  return applyWorldProfile(new URL('../', location.href), profile);
}

function render(): void {
  validateAll();
  const profile = values();
  const checks = worldAuthorshipChecks(profile);
  const complete = isAuthoredWorld(profile);
  const permalink = gameUrl(profile).href;
  const completed = Object.values(checks).filter(Boolean).length;

  document.querySelector<HTMLElement>('#preview-sigil')!.textContent = profile.sigil;
  document.querySelector<HTMLElement>('#chronicle-name')!.textContent = profile.civilization;
  document.querySelector<HTMLElement>('#preview-era')!.textContent = profile.era;
  document.querySelector<HTMLElement>('#preview-places')!.innerHTML = (
    Object.entries(profile.places) as Array<[keyof WorldProfile['places'], string]>
  )
    .map(([id, name]) => `<li><span>${id}</span><strong>${escapeMarkup(name)}</strong></li>`)
    .join('');

  proof.innerHTML = Object.entries(checks)
    .map(([key, done]) => `<span class="${done ? 'done' : ''}">${done ? '✓' : '◇'} ${key}</span>`)
    .join('');
  proof.dataset.complete = String(complete);
  enter.textContent = complete ? 'Enter from URL →' : `${completed}/4 meanings changed`;
  enter.classList.toggle('disabled', !complete);
  enter.setAttribute('aria-disabled', String(!complete));
  if (complete) enter.href = permalink;
  else enter.removeAttribute('href');
  publish.disabled = !complete || publication.state === 'saving';
  publish.textContent =
    publication.state === 'saving'
      ? 'Publishing…'
      : publication.state === 'saved'
        ? 'Published ✓'
        : 'Publish durable world';
  publicationStatus.className = `publication-status ${publication.state}`;
  if (publication.state === 'saved') {
    publicationStatus.innerHTML =
      `Saved as <code>${escapeMarkup(publication.id ?? '')}</code>. ` +
      `<a href="${escapeMarkup(publication.playUrl ?? permalink)}">Enter stable world →</a>`;
  } else if (publication.state === 'fallback') {
    publicationStatus.textContent =
      `${publication.error ?? 'Durable publishing is unavailable.'} Your complete URL world still works.`;
  } else {
    publicationStatus.textContent =
      'Portable by default. Publishing adds a stable Database id and immutable Blob export.';
  }

  const current = new URL(location.href);
  current.search = gameUrl(profile).search;
  current.searchParams.delete('teach');
  history.replaceState(null, '', current);
  window.__FORGE__ = { ready: true, complete, profile, checks, permalink, publication };
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function load(profile: WorldProfile): void {
  fields.civilization.value = profile.civilization;
  fields.sigil.value = profile.sigil;
  fields.era.value = profile.era;
  fields.alpha.value = profile.places.ALPHA;
  fields.bravo.value = profile.places.BRAVO;
  fields.charlie.value = profile.places.CHARLIE;
  render();
}

form.addEventListener('input', () => {
  publication = { state: 'portable' };
  render();
});
// This form has no submit action of its own — the URL updates live as the
// learner types. Pressing Enter in a single-field form still fires an
// implicit submit, though, which would otherwise reload the page out from
// under a keyboard user. Catch it, surface any empty required fields, and
// move focus to the first one instead.
form.addEventListener('submit', (event) => {
  event.preventDefault();
  for (const name of Object.keys(fields) as Array<keyof typeof fields>) touched.add(name);
  const ok = validateAll();
  if (!ok) {
    const firstInvalid = (Object.keys(fields) as Array<keyof typeof fields>).find(
      (name) => fields[name].getAttribute('aria-invalid') === 'true',
    );
    if (firstInvalid) fields[firstInvalid].focus();
  }
  render();
});
publish.addEventListener('click', async () => {
  if (!isAuthoredWorld(values()) || publication.state === 'saving') return;
  publication = { state: 'saving' };
  render();
  try {
    const world: PublishedWorld = await publishWorld(values());
    publication = { state: 'saved', id: world.id, playUrl: world.playUrl };
  } catch (error) {
    publication = {
      state: 'fallback',
      error: error instanceof Error ? error.message : 'Durable publishing is unavailable.',
    };
  }
  render();
});
document.querySelector('#reset-world')!.addEventListener('click', () => load(DEFAULT_WORLD_PROFILE));
load(readWorldProfile(location.search));
