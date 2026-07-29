#!/usr/bin/env node
/**
 * Observable deployed-environment smoke.
 *
 * This creates one clearly marked synthetic/canary world through the public
 * forge, follows the stable id into the actual game, and proves that the
 * complete URL still boots when the read API is unavailable.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const environment = process.argv[2];
if (!['local', 'staging', 'production'].includes(environment)) {
  console.error('usage: node tools/netlify-smoke.mjs <local|staging|production>');
  process.exit(2);
}

const variable = {
  local: 'IRONSIGHT_LOCAL_URL',
  staging: 'IRONSIGHT_STAGING_URL',
  production: 'IRONSIGHT_PRODUCTION_URL',
}[environment];
const baseUrl = (process.env[variable] ?? '').replace(/\/+$/, '');
const originPattern = environment === 'local' ? /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i : /^https:\/\/[^/]+$/i;
if (!originPattern.test(baseUrl)) {
  console.error(`${variable} must be a ${environment === 'local' ? 'loopback HTTP' : 'HTTPS'} origin without a path`);
  process.exit(2);
}

const output = resolve(
  process.env.IRONSIGHT_SMOKE_OUT ?? `tools/teaching/netlify-${environment}`,
);
await mkdir(output, { recursive: true });

const routes = ['/', '/learn/', '/forge/'];
for (const path of routes) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'error' });
  assert.equal(response.status, 200, `${path} status`);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/i, `${path} HTML`);
  if (environment !== 'local') {
    assert.match(
      response.headers.get('cache-control') ?? '',
      /max-age=0.*must-revalidate/i,
      `${path} HTML revalidation`,
    );
  }
}

if (environment !== 'local') {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200, 'migration observability: /api/health ok');
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok', 'health status ok');
  assert.deepEqual(healthBody.schema?.missing ?? ['unknown'], [], 'no missing tables');
  assert.ok(health.headers.get('x-request-id'), 'health echoes a correlation id');
}

if (environment !== 'local') {
  const home = await (await fetch(`${baseUrl}/`)).text();
  const assetPath = home.match(/(?:src|href)="([^"]*assets\/[^"]+)"/)?.[1];
  assert.ok(assetPath, 'built home references a hashed asset');
  const asset = await fetch(new URL(assetPath, `${baseUrl}/`), { method: 'HEAD' });
  assert.equal(asset.status, 200, 'asset status');
  assert.match(
    asset.headers.get('cache-control') ?? '',
    /max-age=31536000.*immutable/i,
    'asset immutable caching',
  );
}

const chromiumBin = process.env.LEARN_CHROMIUM_BIN || '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(chromiumBin) ? { executablePath: chromiumBin } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
});
page.on('response', (response) => {
  if (response.status() >= 500) browserErrors.push(`HTTP ${response.status()}: ${response.url()}`);
});

const marker = environment === 'production' ? 'CANARY' : environment.toUpperCase();
const civilization = `${marker} Many Rivers`;
await page.goto(`${baseUrl}/forge/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__FORGE__?.ready === true);
await page.getByRole('textbox', { name: 'Civilization identity' }).fill(civilization);
await page.getByRole('textbox', { name: 'Sigil symbol' }).fill('☀');
await page.getByRole('textbox', { name: 'Era time' }).fill('The Release Accord');
await page.getByRole('textbox', { name: 'Alpha' }).fill('Verification Gate');
await page.getByRole('textbox', { name: 'Bravo' }).fill('Synthetic Quay');
await page.getByRole('textbox', { name: 'Charlie' }).fill('Rollback Hill');
await page.waitForFunction(() => window.__FORGE__?.complete === true);

const portable = await page.evaluate(() => window.__FORGE__?.permalink);
assert.ok(portable?.includes('civ='), 'complete portable URL exists before persistence');
await page.getByRole('button', { name: 'Publish durable world' }).click();
await page.waitForFunction(() => window.__FORGE__?.publication.state === 'saved', null, {
  timeout: 30_000,
});
const publication = await page.evaluate(() => window.__FORGE__?.publication);
assert.match(publication.id, /^[0-9a-f-]{36}$/i);
assert.ok(publication.playUrl.includes(`world=${publication.id}`));
assert.ok(publication.playUrl.includes('civ='));

const apiRead = await fetch(`${baseUrl}/api/worlds/${publication.id}`);
assert.equal(apiRead.status, 200, 'durable world read');
assert.match(apiRead.headers.get('cache-control') ?? '', /s-maxage=86400/);
const apiWorld = await apiRead.json();
assert.equal(apiWorld.world.profile.civilization, civilization);

await page.screenshot({ path: `${output}/forge-published.png`, fullPage: true });
await page.goto(new URL(publication.playUrl, baseUrl).href, { waitUntil: 'load' });
await page.waitForFunction(
  () => window.__HARNESS__?.ready === true && window.__WORLD__?.state === 'resolved',
  null,
  { timeout: 120_000 },
);
const stableWorld = await page.evaluate(() => ({
  publication: window.__WORLD__,
  profile: window.__TEACH__?.worldProfile,
}));
assert.equal(stableWorld.profile?.civilization, civilization, 'stable id boots the actual game');
await page.screenshot({ path: `${output}/stable-world-game.png` });

const fallbackPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await fallbackPage.route('**/api/worlds/**', (route) => route.abort('failed'));
await fallbackPage.goto(new URL(publication.playUrl, baseUrl).href, { waitUntil: 'load' });
await fallbackPage.waitForFunction(
  () => window.__HARNESS__?.ready === true && window.__WORLD__?.state === 'fallback',
  null,
  { timeout: 120_000 },
);
const fallback = await fallbackPage.evaluate(() => ({
  publication: window.__WORLD__,
  profile: window.__TEACH__?.worldProfile,
}));
assert.equal(fallback.profile?.civilization, civilization, 'complete URL survives API outage');
await fallbackPage.screenshot({ path: `${output}/url-fallback-game.png` });

await writeFile(
  `${output}/evidence.json`,
  `${JSON.stringify(
    {
      environment,
      routes,
      publication,
      stableWorld,
      fallback,
      browserErrors,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
await fallbackPage.close();
await browser.close();

assert.deepEqual(browserErrors, [], `browser/server errors: ${browserErrors.join('; ')}`);
console.log(
  `[netlify-smoke] ${environment}: routes, headers, durable create/read, actual game, and URL fallback passed`,
);
