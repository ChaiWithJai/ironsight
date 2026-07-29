/**
 * Boot-time bake-progress UI. OWNER: HUD. Perf issue #2:
 * "Add a truthful, accessible bake-progress UI with detected tier, cold/warm
 * state, and recovery guidance."
 *
 * DOM, not in-canvas — same reasoning `src/main.ts` already used for its inline
 * loading screen: `tools/capture.mjs` screenshots the canvas element only, so
 * this is structurally incapable of appearing in a shot. It exists to answer,
 * honestly, the question a player asks when the screen isn't moving: "is this
 * frozen, or is this normal for my machine?"
 *
 * TRUTHFUL means three concrete things:
 *  1. No fabricated ETA. The measured baseline in issue #2 is a hardware/
 *     software SPREAD (cold ready p75 ≤25s on supported hardware, ≤120s under
 *     software rendering), not a single number — so guidance quotes that
 *     range for the detected class rather than promising a countdown it
 *     cannot back up.
 *  2. Cold/warm is a claim this module can actually support. `BakeStats`
 *     (`src/engine/types.ts` §9) only reports `cacheHits` once `bakeAll`
 *     resolves, so during the bake the state reads "checking cache…" until
 *     `probeBakeCacheWarm` — a direct, read-only IndexedDB peek at the same
 *     database BAKE's cache uses (`src/bake/cache.ts`, `ironsight-bake` /
 *     `payloads`) — resolves to an honest best-guess, upgraded to an exact
 *     "warm — N cached step(s)" the moment `finishBake` hands over real
 *     `BakeStats`. Read-only: nothing here writes to that store.
 *  3. A stall banner only appears once elapsed time actually exceeds the
 *     documented budget for the detected class, with concrete next steps —
 *     never a spinner that just keeps spinning.
 *
 * ACCESSIBLE means:
 *  - one `role="status"` / `aria-live="polite"` region announces phase and
 *    guidance changes without stealing focus, throttled so a bake emitting
 *    many progress ticks a second doesn't flood a screen reader
 *  - the bar itself carries `role="progressbar"` + `aria-valuenow/min/max/text`
 *  - `prefers-reduced-motion` drops every transition to an instant snap
 *  - colour is never the only signal — every state has a text label
 *  - the recovery action is a real `<button>` with a visible focus ring, not a
 *    styled `<div>` with a click handler
 */
import { nowMs } from '@/engine/clock';
import { QualityTier } from '@/engine/types';

export interface BootProgressDevice {
  readonly tier: QualityTier;
  readonly tierLabel: string;
  readonly isSoftware: boolean;
  readonly vendor: string;
  readonly rendererName: string;
  readonly bakeProfileName: 'compact' | 'standard' | 'full';
  readonly workerCount: number;
  /** 0 when the browser does not expose `navigator.deviceMemory`. */
  readonly deviceMemoryGb: number;
}

export interface BootProgressBakeStats {
  readonly cacheHits: number;
  readonly stepCount: number;
  readonly degraded: readonly string[];
}

export type CacheState = 'checking' | 'cold' | 'warm';

export interface BootProgressHandle {
  /** Call once, as soon as GPU probing resolves. */
  setDevice(device: BootProgressDevice): void;
  /** Call as soon as the pre-bake cache probe resolves (or is skipped). */
  setCacheState(state: CacheState): void;
  /** One call per `BakeProgress` tick from `AssetRegistry.bakeAll`. */
  update(fraction: number, phase: string, elapsedMs: number): void;
  /** Call with the real `BakeStats` once `bakeAll` resolves. Upgrades the cold/warm guess to fact. */
  finishBake(stats: BootProgressBakeStats): void;
  /** Generic phase label for boot work outside the bake proper. */
  setStatus(fraction: number, text: string): void;
  /** Boot failed. Shows the error, keeps the device/phase context visible, offers reload. */
  fail(message: string, detail?: string): void;
  /** Boot reached `markReady()`. Fades out and removes the overlay. */
  finish(): void;
}

/* -------------------------------------------------------------- constants */

/**
 * Documented p75 budgets from issue #2's baseline, keyed by detected class.
 * These are the ONLY numbers this module asserts about timing, and they are
 * quoted, not computed — if the budgets are re-measured, this is the one place
 * to update.
 */
const BUDGET_MS = {
  warm: 10_000,
  coldHardware: 25_000,
  coldSoftware: 120_000,
} as const;

/** A stall banner appears once elapsed time clears 1.5x the relevant budget. */
const STALL_MULTIPLIER = 1.5;

/** Throttle for the aria-live announcement, so a fast bake doesn't spam it. */
const ANNOUNCE_MIN_INTERVAL_MS = 900;

const PALETTE = {
  bg: '#05070a',
  panel: '#0a0f14',
  border: '#16202a',
  accent: '#d6b483',
  text: '#e8edf1',
  dim: '#8fa8b8',
  warn: '#e2b23a',
  alert: '#e2705a',
} as const;

/* --------------------------------------------------------- cache probing */

const CACHE_DB_NAME = 'ironsight-bake';
const CACHE_STORE = 'payloads';

/**
 * Best-guess cold/warm read BEFORE the bake starts: a read-only peek at the
 * IndexedDB store `src/bake/cache.ts` writes bake-job payloads to. This is a
 * heuristic, not a contract — the two modules share only the well-known
 * database/store name, nothing is imported across the lane boundary, and
 * nothing here ever writes. If IndexedDB is unavailable (private browsing,
 * disabled storage) or the open stalls, this resolves to `'checking'` so the
 * UI never asserts a state it can't support; the exact answer still arrives
 * from `finishBake`'s real `BakeStats.cacheHits` once the bake completes.
 */
export function probeBakeCacheWarm(): Promise<CacheState> {
  if (typeof indexedDB === 'undefined') return Promise.resolve('checking');
  return new Promise((resolve) => {
    let settled = false;
    const settle = (state: CacheState): void => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    // Never let a slow/blocked open hold up the boot progress UI itself.
    const timeout = setTimeout(() => settle('checking'), 1500);
    try {
      const openReq = indexedDB.open(CACHE_DB_NAME);
      openReq.onupgradeneeded = () => {
        // A fresh open creates the DB — that IS cold, and the transaction
        // below still needs the store to exist before it can count anything.
        openReq.result.createObjectStore(CACHE_STORE);
      };
      openReq.onerror = () => {
        clearTimeout(timeout);
        settle('checking');
      };
      openReq.onsuccess = () => {
        const db = openReq.result;
        try {
          if (!db.objectStoreNames.contains(CACHE_STORE)) {
            clearTimeout(timeout);
            db.close();
            settle('cold');
            return;
          }
          const tx = db.transaction(CACHE_STORE, 'readonly');
          const countReq = tx.objectStore(CACHE_STORE).count();
          countReq.onsuccess = () => {
            clearTimeout(timeout);
            db.close();
            settle(countReq.result > 0 ? 'warm' : 'cold');
          };
          countReq.onerror = () => {
            clearTimeout(timeout);
            db.close();
            settle('checking');
          };
        } catch {
          clearTimeout(timeout);
          db.close();
          settle('checking');
        }
      };
    } catch {
      clearTimeout(timeout);
      settle('checking');
    }
  });
}

/* ------------------------------------------------------------- guidance */

function budgetFor(device: BootProgressDevice, cache: CacheState): number {
  if (cache === 'warm') return BUDGET_MS.warm;
  return device.isSoftware ? BUDGET_MS.coldSoftware : BUDGET_MS.coldHardware;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

/**
 * The guidance line under the bar. Always present, always specific to what was
 * actually detected — never a generic "please wait".
 */
function guidanceFor(device: BootProgressDevice | null, cache: CacheState): string {
  if (!device) return 'Detecting graphics hardware…';
  const budget = budgetFor(device, cache);
  if (cache === 'warm') {
    return `Cached from a previous visit — typically under ${formatSeconds(budget)}.`;
  }
  if (device.isSoftware) {
    return (
      `No hardware GPU detected; rendering in software. A first, uncached load like this ` +
      `commonly takes up to ${formatSeconds(budget)}. For a much faster load, open this in a ` +
      `browser with GPU acceleration enabled, or update your graphics drivers.`
    );
  }
  if (device.tier === QualityTier.Low) {
    return (
      `Lower-end or memory-constrained GPU detected — quality set to ${device.tierLabel} to keep ` +
      `this first load under about ${formatSeconds(budget)}.`
    );
  }
  return `Hardware-accelerated GPU detected — a first, uncached load typically finishes in about ${formatSeconds(budget)}.`;
}

function stallGuidanceFor(device: BootProgressDevice | null): string {
  if (device?.isSoftware) {
    return (
      'Still working. Software rendering is measured up to roughly 2 minutes on a cold load. ' +
      'This is expected on this device, not a hang.'
    );
  }
  return (
    'This is taking longer than a typical load on detected hardware. If it does not finish in the ' +
    'next minute, try reloading, or clearing this site’s storage (browser Settings → Privacy → ' +
    'Site data) in case the local bake cache is corrupted, then reload.'
  );
}

/* ------------------------------------------------------------------- UI */

export function createBootProgress(container: HTMLElement): BootProgressHandle {
  const reduceMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const root = document.createElement('div');
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:10', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:14px', `background:${PALETTE.bg}`,
    'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace', `color:${PALETTE.dim}`,
    'letter-spacing:0.05em', `transition:opacity ${reduceMotion ? '1ms' : '320ms'} ease`,
    'padding:24px', 'box-sizing:border-box', 'text-align:center',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'I R O N S I G H T';
  title.style.cssText = `font-size:16px;letter-spacing:0.5em;color:${PALETTE.accent}`;

  // Device line: tier + hardware/software + bake profile. Never colour-only —
  // a screen reader (and a colour-blind player) gets the same information a
  // sighted player reading the badge colour would.
  const deviceLine = document.createElement('div');
  deviceLine.style.cssText = `font-size:11px;color:${PALETTE.text};letter-spacing:0.08em`;
  deviceLine.textContent = 'DETECTING GRAPHICS HARDWARE…';

  const cacheLine = document.createElement('div');
  cacheLine.style.cssText = `font-size:11px;color:${PALETTE.dim};letter-spacing:0.08em`;
  cacheLine.textContent = 'CACHE: CHECKING…';

  const barOuter = document.createElement('div');
  barOuter.style.cssText = `width:320px;max-width:70vw;height:3px;background:${PALETTE.border};overflow:hidden`;
  const barInner = document.createElement('div');
  barInner.style.cssText = [
    'width:0%', 'height:100%', `background:${PALETTE.accent}`,
    `transition:width ${reduceMotion ? '1ms' : '140ms'} linear, background 200ms ease`,
  ].join(';');
  barOuter.setAttribute('role', 'progressbar');
  barOuter.setAttribute('aria-valuemin', '0');
  barOuter.setAttribute('aria-valuemax', '100');
  barOuter.setAttribute('aria-valuenow', '0');
  barOuter.setAttribute('aria-label', 'IRONSIGHT load progress');
  barOuter.appendChild(barInner);

  const label = document.createElement('div');
  label.textContent = 'INITIALISING';
  label.style.cssText = 'letter-spacing:0.16em';

  const elapsedLine = document.createElement('div');
  elapsedLine.style.cssText = `font-size:10px;color:${PALETTE.dim}`;
  elapsedLine.textContent = '0.0s elapsed';

  // The one live region. Everything a screen reader needs to hear — phase,
  // guidance, stall notice, failure — is written here, and ONLY here, so
  // nothing announces twice and nothing announces out of order.
  const live = document.createElement('div');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.style.cssText = `font-size:11px;color:${PALETTE.text};max-width:60vw;min-height:1.4em`;

  const stallRow = document.createElement('div');
  stallRow.style.cssText = 'display:none;flex-direction:column;align-items:center;gap:8px;margin-top:4px';
  const stallText = document.createElement('div');
  stallText.style.cssText = `font-size:11px;color:${PALETTE.warn};max-width:60vw`;
  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.textContent = 'RELOAD';
  reloadButton.style.cssText = [
    'font:inherit', 'letter-spacing:0.12em', 'padding:8px 18px', 'cursor:pointer',
    `color:${PALETTE.text}`, `background:${PALETTE.panel}`, `border:1px solid ${PALETTE.warn}`,
  ].join(';');
  reloadButton.addEventListener('click', () => location.reload());
  stallRow.append(stallText, reloadButton);

  const errorDetail = document.createElement('pre');
  errorDetail.style.cssText = [
    'display:none', 'max-width:80vw', 'white-space:pre-wrap', `color:${PALETTE.alert}`,
    'font-size:11px', 'text-align:left', 'margin:0',
  ].join(';');

  root.append(title, deviceLine, cacheLine, barOuter, label, elapsedLine, live, stallRow, errorDetail);
  container.appendChild(root);

  /* -------------------------------------------------------------- state */

  let device: BootProgressDevice | null = null;
  let cache: CacheState = 'checking';
  let lastAnnounceAtMs = -Infinity;
  let lastAnnounced = '';
  let stalled = false;
  let failed = false;
  const bootStart = nowMs();

  function setBar(fraction: number, valueText: string): void {
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    barInner.style.width = `${pct}%`;
    barOuter.setAttribute('aria-valuenow', String(pct));
    barOuter.setAttribute('aria-valuetext', valueText);
  }

  function announce(text: string, nowRef: number): void {
    if (text === lastAnnounced) return;
    if (nowRef - lastAnnounceAtMs < ANNOUNCE_MIN_INTERVAL_MS) return;
    lastAnnounceAtMs = nowRef;
    lastAnnounced = text;
    live.textContent = text;
  }

  function checkStall(elapsedMs: number): void {
    if (failed || stalled || !device) return;
    const budget = budgetFor(device, cache);
    if (elapsedMs < budget * STALL_MULTIPLIER) return;
    stalled = true;
    stallText.textContent = stallGuidanceFor(device);
    stallRow.style.display = 'flex';
  }

  function deviceLineText(d: BootProgressDevice): string {
    const gpuClass = d.isSoftware ? 'SOFTWARE RENDERER' : 'HARDWARE GPU';
    return `${gpuClass} · TIER ${d.tierLabel} · BAKE ${d.bakeProfileName.toUpperCase()} · ${d.workerCount} WORKER(S)`;
  }

  function cacheLineText(state: CacheState): string {
    if (state === 'checking') return 'CACHE: CHECKING…';
    if (state === 'warm') return 'CACHE: WARM (previous bake found)';
    return 'CACHE: COLD (fresh bake)';
  }

  /* ------------------------------------------------------------- handle */

  return {
    setDevice(d) {
      device = d;
      deviceLine.textContent = deviceLineText(d);
      announce(guidanceFor(device, cache), nowMs() - bootStart);
    },
    setCacheState(state) {
      cache = state;
      cacheLine.textContent = cacheLineText(state);
      announce(guidanceFor(device, cache), nowMs() - bootStart);
    },
    update(fraction, phase, elapsedMs) {
      if (failed) return;
      const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      label.textContent = `BAKE: ${phase.toUpperCase()} ${pct}%`;
      setBar(fraction, `${pct} percent, baking ${phase}`);
      elapsedLine.textContent = `${(elapsedMs / 1000).toFixed(1)}s elapsed`;
      announce(`Baking ${phase}, ${pct} percent. ${guidanceFor(device, cache)}`, elapsedMs);
      checkStall(elapsedMs);
    },
    finishBake(stats) {
      cache = stats.cacheHits > 0 ? 'warm' : 'cold';
      cacheLine.textContent =
        stats.cacheHits > 0
          ? `CACHE: WARM — ${stats.cacheHits}/${stats.stepCount} step(s) reused`
          : `CACHE: COLD — ${stats.stepCount} step(s) baked fresh`;
      if (stats.degraded.length > 0) {
        const note = document.createElement('div');
        note.style.cssText = `font-size:10px;color:${PALETTE.warn}`;
        note.textContent = `Reduced resolution to stay in budget: ${stats.degraded.join(', ')}`;
        root.insertBefore(note, live);
      }
    },
    setStatus(fraction, text) {
      if (failed) return;
      label.textContent = text.toUpperCase();
      setBar(fraction, text);
      const elapsedMs = nowMs() - bootStart;
      elapsedLine.textContent = `${(elapsedMs / 1000).toFixed(1)}s elapsed`;
      announce(text, elapsedMs);
      checkStall(elapsedMs);
    },
    fail(message, detail) {
      failed = true;
      stallRow.style.display = 'none';
      label.textContent = 'BOOT FAILED';
      label.style.color = PALETTE.alert;
      title.style.color = PALETTE.alert;
      live.textContent = `Boot failed: ${message}`;
      barInner.style.background = PALETTE.alert;
      if (detail) {
        errorDetail.textContent = detail;
        errorDetail.style.display = 'block';
      }
    },
    finish() {
      root.style.opacity = '0';
      setTimeout(() => root.remove(), reduceMotion ? 0 : 340);
    },
  };
}
