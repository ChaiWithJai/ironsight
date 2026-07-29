/**
 * Chapter IV demo — THE LEDGER. Renders chronicle.json, which was imported at
 * build time: the JSON below travelled inside the JavaScript bundle, and no
 * network request fetched it. The toggle shows the raw object — the "API
 * response" that never needed an API server.
 */
import chronicle from '../chronicle.json';
import type { Demo } from './types';

export const ledgerDemo: Demo = (root, ctx) => {
  const cards = chronicle.eras
    .map(
      (era) => `
      <div class="era">
        <div class="sigil">${era.sigil}</div>
        <div>
          <span class="name">${era.name}</span><span class="span">${era.span}</span>
          <div class="story">${era.story}</div>
          <div class="source">${era.source}</div>
        </div>
      </div>`,
    )
    .join('');

  root.innerHTML = `
    <div class="era-track">${cards}</div>
    <div class="controls">
      <button id="raw-toggle">show the raw ledger (JSON)</button>
      <span>imported with <code>import chronicle from './chronicle.json'</code> — resolved at build time</span>
    </div>
    <pre id="raw" style="display:none"><code></code></pre>
  `;

  const pre = root.querySelector<HTMLPreElement>('#raw')!;
  pre.querySelector('code')!.textContent = JSON.stringify(chronicle, null, 2);
  const btn = root.querySelector<HTMLButtonElement>('#raw-toggle')!;
  ctx.report({ rawVisible: false });
  btn.addEventListener('click', () => {
    const showing = pre.style.display !== 'none';
    pre.style.display = showing ? 'none' : 'block';
    btn.textContent = showing ? 'show the raw ledger (JSON)' : 'hide the raw ledger';
    ctx.report({ rawVisible: !showing });
  });
};
