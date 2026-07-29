/**
 * IRONSIGHT — boot.
 * CORE owns this file. It is the ONLY place the boot ORDER is written down.
 *
 *   probe gpu → construct engine → construct asset registry → declare bakes
 *   → run bakes (progress) → construct every subsystem → prewarm shaders
 *   → attach the harness driver → markReady() → start the loop
 *
 * Two orderings here are load-bearing:
 *
 *  1. `assets` is constructed BEFORE every other subsystem, and `registerBakes`
 *     runs before `bakeAll`. A lane declares its bake steps without having been
 *     constructed, so the scheduler sees the WHOLE cost total up front and can
 *     apply `BakeProfile.unitCeiling` by degrading resolution rather than
 *     discovering it is over budget half way through.
 *  2. `markReady()` fires only after shader prewarm. A shader compiled lazily on
 *     first sight costs 20–120 ms on the main thread; under the harness that
 *     lands inside a shot's frame budget and produces a capture that "sometimes"
 *     looks different.
 *
 * `tools/capture.mjs` hard-fails at 300 s waiting for `ready`, and every status
 * string set below is what shows up in its failure diagnostic. Keep them
 * specific enough to bisect a hang from the log alone.
 */
import { TickPhase } from '@/engine/types';
import { attachDriver, markReady, setStatus } from '@/engine/harness';
import { createRenderer } from '@/engine/renderer';
import { createEngine } from '@/engine/engine';
import { installSoak } from '@/engine/soak';
import { tierName } from '@/engine/quality';
import { SHOT_MODULE_COUNT } from '@/shots/index';
import { installTeachingMode } from '@/teach/game';
import { hydratePublishedWorld } from '@/engine/world-publication';

const container = document.getElementById('app');
if (!container) throw new Error('index.html is missing #app');

/* -------------------------------------------------------------- loading screen */
/**
 * DOM, not in-canvas, and removed before `markReady()`. The capture tool
 * screenshots the canvas element only, so this is structurally incapable of
 * appearing in a shot — which is exactly what we want from a loading screen and
 * exactly what we must NOT accept from the game HUD.
 */
const loading = document.createElement('div');
loading.style.cssText = [
  'position:fixed', 'inset:0', 'z-index:10', 'display:flex', 'flex-direction:column',
  'align-items:center', 'justify-content:center', 'gap:14px', 'background:#05070a',
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace', 'color:#8fa8b8',
  'letter-spacing:0.16em', 'transition:opacity 320ms ease',
].join(';');
const title = document.createElement('div');
title.textContent = 'I R O N S I G H T';
title.style.cssText = 'font-size:16px;letter-spacing:0.5em;color:#d6b483';
const barOuter = document.createElement('div');
barOuter.style.cssText = 'width:280px;height:2px;background:#16202a;overflow:hidden';
const barInner = document.createElement('div');
barInner.style.cssText = 'width:0%;height:100%;background:#d6b483;transition:width 140ms linear';
barOuter.appendChild(barInner);
const label = document.createElement('div');
label.textContent = 'INITIALISING';
loading.append(title, barOuter, label);
container.appendChild(loading);

function progress(fraction: number, text: string): void {
  barInner.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  label.textContent = text.toUpperCase();
  setStatus(text);
}

/* ------------------------------------------------------------------------ boot */

async function boot(): Promise<void> {
  progress(0.01, 'resolving chronicle');
  await hydratePublishedWorld();
  progress(0.02, 'creating context');
  const { renderer, canvas, colorBufferFloat } = createRenderer(container as HTMLElement);
  if (!colorBufferFloat) {
    // Not fatal — the tier tables drop to Low, which is the one configuration
    // that does not need float render targets. But say so, loudly: every HDR
    // symptom downstream traces back here.
    console.warn('[boot] EXT_color_buffer_float unavailable; HDR targets will be unusable.');
  }

  progress(0.05, 'probing gpu');
  const engine = createEngine({
    renderer,
    canvas,
    report: (status) => setStatus(status),
  });
  const caps = engine.caps;
  console.info(
    `[boot] ${caps.vendor} / ${caps.renderer}\n` +
      `[boot] tier ${tierName(caps.estimatedTier)}${caps.isSoftware ? ' (software rasteriser)' : ''}` +
      ` · bake profile ${engine.quality.settings.bake.name}` +
      ` · ${engine.quality.settings.bake.workerCount} worker(s)`,
  );

  progress(0.08, 'asset registry');
  await engine.bootAssets();

  progress(0.10, 'declaring bakes');
  engine.registerBakes();

  progress(0.12, 'baking');
  await engine.services.assets.bakeAll((p) => {
    // 12% → 62% of the bar. The bake is the long pole on a cold load and under
    // SwiftShader it is essentially the entire load, so it owns half the bar.
    progress(0.12 + p.fraction * 0.5, `bake: ${p.phase} ${(p.fraction * 100).toFixed(0)}%`);
  });
  const bakeStats = engine.services.assets.stats;
  if (bakeStats.degraded.length > 0) {
    console.info(`[boot] bake degraded to fit the unit ceiling: ${bakeStats.degraded.join(', ')}`);
  }

  progress(0.64, 'building world');
  await engine.bootRemaining();

  progress(0.88, 'validating render graph');
  engine.services.graph.validate();

  progress(0.92, 'prewarming shaders');
  await engine.services.materials.prewarm();

  progress(0.97, 'attaching harness');
  engine.debug.attach(container as HTMLElement);
  attachDriver(engine.driver);
  // The BEHAVIOURAL counterpart to the screenshot harness. `tools/soak.mjs`
  // waits on the same `__HARNESS__.ready` flag, then drives `__SOAK__.run()` to
  // step the fixed-timestep simulation forward for N seconds and report what
  // actually moved. A screenshot cannot show that a bot has stood still for a
  // minute; this can.
  installSoak(engine);
  if (new URLSearchParams(location.search).has('teach')) {
    installTeachingMode(container as HTMLElement, engine.services);
  }

  // One frame before ready, so the very first thing the capture tool can grab is
  // a rendered image rather than the clear colour.
  engine.stepFrame(1 / 60);
  // PARK IN THE HARNESS HOLD, and do not start free-running here. This is a
  // DETERMINISM fix, not a policy preference.
  //
  // `EngineClock.tick` is deliberately never rewound (see clock.ts), so the tick
  // a capture STARTS from is whatever the live loop has reached by then — and
  // between `markReady()` and the tool's first `capture()` call the live loop was
  // running on wall-clock dt. That window is a page load, a `waitForFunction`
  // poll and an IPC round trip long, i.e. a machine-dependent number of frames:
  // measured at 7 ticks here, and one capture in a dozen landed on a different
  // count and came back with a different frame. `hud_full` is where it showed,
  // because GAME's scenario is keyed to the absolute tick counter — two runs of
  // the same build produced different killfeed entries, a different tracer and a
  // different grass phase, which is precisely the "the frame changed but the code
  // did not" failure the blind critic loop cannot survive.
  //
  // `EngineDriver.setLoopSuspended(false)` is the same HOLD every capture already
  // leaves behind: rAF keeps turning, no frame accumulates, and the first real
  // pointer/key event hands the world to the player. Boot now enters it directly,
  // so the first capture starts from the same tick as every later one.
  engine.driver.setLoopSuspended(false);
  engine.clock.deterministic = false;
  engine.quality.deterministic = false;
  engine.start();

  const stillNull = engine.registry.nullKeys();
  const materials = engine.services.materials;
  console.info(
    `[boot] ready · ${SHOT_MODULE_COUNT} shot module(s) · ` +
      `${stillNull.length} service(s) still null${stillNull.length ? `: ${stillNull.join(', ')}` : ''}`,
  );
  // Shader permutations are a SHARED budget with no reservation scheme, and
  // `MaterialFactory.create` enforces it with a throw — so the lane that
  // allocates last dies inside another lane's afterBoot with no clue that the
  // budget was the problem. Printing the headroom every boot is how the next
  // lane finds out before it costs it an afternoon. Note this counts only what
  // has been allocated so far; shot-time allocation pushes it higher.
  console.info(
    `[boot] shader permutations · ${materials.permutationCount} / ${materials.permutationCap} allocated at boot`,
  );
  // The tick schedule, by phase. An EMPTY gameplay phase is the failure mode
  // this line exists to catch: a lane that forgets to register its system is
  // otherwise indistinguishable from a lane whose system does nothing, and the
  // symptom ("bots never move") shows up three lanes away from the cause.
  const schedule = engine.loop.describe();
  const byPhase = new Map<number, string[]>();
  for (const t of schedule.ticks) {
    const list = byPhase.get(t.phase) ?? [];
    list.push(t.name);
    byPhase.set(t.phase, list);
  }
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  console.info(
    `[boot] tick schedule · ` +
      phases.map((p) => `${TickPhase[p] ?? p}[${(byPhase.get(p) ?? []).join(' ')}]`).join(' → '),
  );

  progress(1, 'ready');
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 340);
  markReady();
}

boot().catch((error: unknown) => {
  // A boot failure must be VISIBLE and must reach the capture log. The tool's
  // only other signal is a 300 s timeout with a status string, which tells a
  // reviewer nothing about which subsystem threw.
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  setStatus(`boot failed: ${message.split('\n')[0]}`);
  label.textContent = 'BOOT FAILED';
  label.style.color = '#e2705a';
  title.style.color = '#e2705a';
  const detail = document.createElement('pre');
  detail.textContent = message;
  detail.style.cssText = 'max-width:80vw;white-space:pre-wrap;color:#e2705a;font-size:11px;text-align:left';
  loading.appendChild(detail);
  console.error('[boot] failed', error);
  throw error;
});
