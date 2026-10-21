import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect } from '../lib/collector.mjs';
import { selectCatalog, scopeScan } from '../lib/scope.mjs';
import { assertScan, hash, validateConfig } from '../lib/study.mjs';
import { createStudy, ingestScan, summarizeStudy } from '../lib/analysis.mjs';
import { parseOfficialInventory, renderInventory } from '../lib/context.mjs';

const config = { ...JSON.parse(fs.readFileSync(new URL('../study.json', import.meta.url))), horizonDays: 2,
  longRangeOffsetsDays: [], concurrency: 1 };
const catalog = [{ resourceId: '301', name: 'PR1 | full' }, { resourceId: '225', name: 'PR1 | short' },
  { resourceId: '999', name: 'PR30.1 | New Madeira variant' },
  { resourceId: '282', name: 'Porto Santo PR1 | Pico Branco' }, { resourceId: '283', name: 'Porto Santo PR2 | Castelo' },
  { resourceId: '998', name: 'Porto\u00a0Santo PR 9 | Future route' }];
const envelope = data => Response.json({ status: true, data });

test('Madeira-only collection excludes current and future Porto Santo IDs before all date jobs', async () => {
  let clock = Date.parse('2026-10-26T06:00:00Z');
  const posted = [];
  const scan = await collect(config, { now: () => clock, sleep: async ms => { clock += ms; }, fetcher: async (url, init) => {
    if (url.endsWith('/resources')) return envelope(catalog.map(t => ({ id: +t.resourceId, name: t.name })));
    if (url.endsWith('/services/78-82-259')) return new Response('page', { headers: [
      ['Set-Cookie', 'XSRF-TOKEN=x%3D; Path=/'], ['Set-Cookie', 'laravel_session=anon; HttpOnly']] });
    posted.push(JSON.parse(init.body).resourceId);
    return envelope([]);
  } });
  assertScan(scan);
  assert.deepEqual(posted, ['301', '225', '999', '301', '225', '999']);
  assert.equal(scan.scope.totalCatalogResources, 6);
  assert.equal(scan.scope.excludedResources.length, 3);
  assert.equal(scan.entries.length, 6);
});

test('catalog failure also excludes Porto Santo from unknown fallback coverage', async () => {
  const scan = await collect(config, { now: () => Date.parse('2026-10-26T06:00:00Z'), sleep: async () => {},
    priorCatalog: catalog, fetcher: async () => new Response('Down', { status: 503 }) });
  assertScan(scan);
  assert.deepEqual(scan.catalog.map(t => t.resourceId), ['301', '225', '999']);
  assert.equal(scan.entries.length, 6);
  assert.ok(scan.entries.every(e => e.status === 'skipped'));
});

test('Madeira projections preserve old evidence and do not invent catalog-removal events', () => {
  const old = { v: 1, id: '2026-10-26T06-00-00-000Z', startedAt: '2026-10-26T06:00:00.000Z',
    finishedAt: '2026-10-26T06:01:00.000Z', dates: ['2026-10-26'], catalog,
    entries: catalog.map(t => ({ r: t.resourceId, d: '2026-10-26', at: '2026-10-26T06:00:05.000Z', status: 'empty', s: [] })) };
  const originalHash = hash(JSON.stringify(old)), first = scopeScan(assertScan(old), 'Madeira');
  assertScan(first);
  assert.equal(hash(JSON.stringify(old)), originalHash);
  assert.equal(first.catalog.length, 3);
  const next = { ...first, id: '2026-10-26T07-00-00-000Z', startedAt: '2026-10-26T07:00:00.000Z',
    finishedAt: '2026-10-26T07:01:00.000Z' };
  const study = createStudy(); ingestScan(study, first); ingestScan(study, next);
  const summary = summarizeStudy(study);
  assert.equal(summary.trails.length, 3);
  assert.deepEqual(summary.catalogChanges, []);
});

test('scope fails clearly on unknown catalog labels and unsupported configuration', () => {
  assert.throws(() => selectCatalog([{ resourceId: '997', name: 'New island | route' }], 'Madeira'), { code: 'UPSTREAM_SCHEMA_CHANGED' });
  assert.throws(() => validateConfig({ ...config, island: 'Porto Santo' }), /island/);
  assert.throws(() => validateConfig({ ...config, island: undefined }), /island/);
});

test('official context and current reports cover Madeira without depending on Porto Santo rows', () => {
  const row = n => `<tr><td>${n}</td><td>${n}</td><td>Madeira route ${n}</td><td>1 km</td><td>Details</td><td>ABERTO</td><td>IFCN</td></tr>`;
  const html = `<table id="data-table">${Array.from({ length: 30 }, (_, i) => row(i + 1)).join('')}</table>` +
    '<table id="data-table"><tr><td>Changed Porto Santo schema</td></tr></table>';
  const context = parseOfficialInventory(html);
  assert.equal(context.routes.length, 30);
  assert.ok(context.routes.every(r => r.island === 'Madeira'));
  const report = renderInventory({ ...context, routes: [...context.routes,
    { island: 'Porto Santo', code: 'PR1', name: 'Pico Branco', statusText: 'ABERTO' }] }, catalog);
  assert.doesNotMatch(report, /\| Porto Santo \||Pico Branco/);
  assert.match(report, /3 current SIMplifica/);
});
