import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeAvailability, normalizeSlots } from '../src/upstream.mjs';
import { collect } from '../lib/collector.mjs';
import { assertScan, scanCounts } from '../lib/study.mjs';
import { writeScan, readScan, archiveFiles, verifyArchives } from '../lib/archive.mjs';
import { collectionRunStatus } from '../lib/run-status.mjs';
import { recentCompleteScan } from '../lib/collection-window.mjs';
import { publishEntry } from '../lib/published.mjs';
import { compareScan, updateComparisonState } from '../lib/changes.mjs';
import { createStudy, ingestScan, renderSummary, renderTrail } from '../lib/analysis.mjs';

const config = { island: 'Madeira', horizonDays: 2, calendarTimezone: 'Atlantic/Madeira', minimumRequestSpacingMs: 1000,
  concurrency: 1, maximumScanMinutes: 30, maximumConsecutiveFailures: 5, expectedIntervalMinutes: 60,
  staleAfterMinutes: 90, maximumArchiveMiB: 750, transientRetryDelaysMs: [30000, 120000], maximumRetryChecks: 20 };
const row = (date, title = '0 vagas disponíveis', hour = '08') => ({
  begin: { date: `${date} ${hour}:00:00.000000`, timezone: 'Europe/Lisbon' },
  end: { date: `${date} ${hour}:30:00.000000`, timezone: 'Europe/Lisbon' },
  slotTitle: title, maximumCapacity: 100, reservations: 100 });
const percentage = n => `100% Residentes • ${n}% Não residentes • 100% Operadores económicos`;

test('exact generic source response remains unknown; malformed and ambiguous category responses still stop', () => {
  const d = '2026-11-08';
  assert.equal(normalizeAvailability([row(d)], d)[0].nonResident, null);
  assert.throws(() => normalizeSlots([row(d)], d), { code: 'UPSTREAM_CATEGORY_UNAVAILABLE' });
  assert.equal(normalizeAvailability([row(d, percentage(42))], d)[0].nonResident, 42);
  assert.equal(normalizeAvailability([row(d, '0 vagas disponíveis • 42% Não residentes')], d)[0].nonResident, 42);
  for (const title of ['1 vagas disponíveis', '0% Residentes',
    '1% Não residentes • 2% Não residentes']) {
    assert.throws(() => normalizeAvailability([row(d, title)], d), { code: 'UPSTREAM_SCHEMA_CHANGED' });
  }
  for (const rows of [[{ ...row(d), begin: { date: d + ' invalid', timezone: 'Europe/Lisbon' } }],
    [row(d), row(d)], [row('2026-11-09')], [row(d), row(d, 'changed schema', '09')]]) {
    assert.throws(() => normalizeAvailability(rows, d), { code: 'UPSTREAM_SCHEMA_CHANGED' });
  }
});

async function fixture({ transient = false } = {}) {
  let time = Date.parse('2026-11-07T06:00:00Z'), posts = 0;
  const scan = await collect(config, { now: () => time, sleep: async ms => { time += ms; }, fetcher: async (url, init) => {
    if (url.endsWith('/resources')) return Response.json({ status: true,
      data: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `PR${i + 1} | Madeira` })) });
    if (url.endsWith('/services/78-82-259')) return new Response('', {
      headers: [['Set-Cookie', 'XSRF-TOKEN=x; Path=/'], ['Set-Cookie', 'laravel_session=anonymous']] });
    posts++;
    if (transient && posts === 1) throw new DOMException('timeout', 'TimeoutError');
    const q = JSON.parse(init.body), d = `2026-11-${String(q.day).padStart(2, '0')}`;
    // More than five consecutive generic responses must not trip the circuit.
    return Response.json({ status: true, data: q.day === 7 ? [row(d)] : [row(d, percentage(42))] });
  } });
  return { scan: assertScan(scan), posts, time };
}

test('known unreported responses do not abort, retry, fabricate zero, or fail a completed scan', async () => {
  const { scan, posts, time } = await fixture();
  assert.equal(posts, 12); assert.equal(scan.stopReason, null);
  const counts = scanCounts(scan);
  assert.deepEqual(counts, { expected: 12, verified: 6, withSlots: 6, empty: 0, failed: 0, slots: 6, unreported: 6, unreportedSlots: 6 });
  assert.ok(scan.entries.slice(0, 6).every(e => e.status === 'unreported' && e.s === undefined && e.sourceSlots[0][3] === null));
  const health = { state: 'complete', scanId: scan.id };
  const status = collectionRunStatus(scan, health, 'success');
  assert.equal(status.failed, false); assert.equal(status.warning, true);
  assert.match(status.message, /6 responses omit the non-resident category/);
  assert.equal(recentCompleteScan(scan, health, time), true);
  assert.equal(collectionRunStatus({ ...scan, stopReason: 'schema_changed' }, health, 'success').failed, true);
  const entry = scan.entries[0], published = publishEntry(entry, scan.catalog[0]);
  assert.equal(published.profile, null); assert.equal(published.index.path, undefined);
  assert.equal(published.index.sourceFetchedAt, undefined);
  assert.deepEqual(published.index.sourceSlots, entry.sourceSlots);
  const integrity = { scans: 1, slots: 6, bytes: 1 }, history = { generatedAt: new Date(time).toISOString(), missingScanIntervals: [], catalogChanges: [] };
  assert.match(renderSummary(scan, history, integrity, config, health), /category-unreported responses: \*\*6\*\*/);
  assert.match(renderTrail(scan, scan.catalog[0], null), /unreported.*availability is unknown/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-unreported-'));
  try {
    await writeScan(root, scan); await writeScan(root, scan);
    assert.deepEqual(await readScan((await archiveFiles(root))[0]), scan);
    assert.equal((await verifyArchives(root)).scans, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  for (const mutate of [e => e.sourceSlots[0][3] = 0, e => e.sourceTitle = 'other',
    e => e.sourceSlots[0][0] = 'invalid', e => e.s = [], e => e.sourceSlots.push(e.sourceSlots[0])]) {
    const invalid = structuredClone(scan); mutate(invalid.entries[0]); assert.throws(() => assertScan(invalid));
  }
});

test('unreported responses after a transient attempt preserve retry evidence', async () => {
  const { scan, posts } = await fixture({ transient: true });
  assert.equal(posts, 13);
  const entry = scan.entries[0];
  assert.equal(entry.status, 'unreported');
  assert.deepEqual(entry.attempts.map(a => a.status), ['error', 'unreported']);
});

test('unreported and mixed responses create analytical gaps, never sell-outs or numerical samples', async () => {
  const { scan } = await fixture();
  const source = scan.entries[0], base = { ...scan, catalog: [scan.catalog[0]], dates: [source.d] };
  const make = (minute, entry) => ({ ...base, id: `2026-11-07T06-${minute}-00-000Z`,
    startedAt: `2026-11-07T06:${minute}:00.000Z`, finishedAt: `2026-11-07T06:${minute}:01.000Z`,
    entries: [{ ...entry, at: `2026-11-07T06:${minute}:00.500Z` }] });
  const a = make('00', { ...source, status: 'ok', sourceSlots: undefined, sourceTitle: undefined, s: [[...source.sourceSlots[0].slice(0, 3), 42]] });
  const b = make('10', source);
  // Preserve explicit percentages in mixed source evidence, but exclude the
  // whole uncertain resource/date from numerical analysis conservatively.
  b.entries[0].sourceSlots.push([`${source.d} 09:00:00.000000`, `${source.d} 09:30:00.000000`, 'Europe/Lisbon', 100]);
  assertScan(b);
  const c = make('20', { ...a.entries[0], s: [[...source.sourceSlots[0].slice(0, 3), 0]] });
  const good = new Map(), attempts = new Map(), study = createStudy();
  updateComparisonState(a, good, attempts); ingestScan(study, a);
  assert.deepEqual(compareScan(b, good, attempts).map(e => e.type), ['data_unavailable']);
  updateComparisonState(b, good, attempts); ingestScan(study, b);
  assert.equal(study.observationCount, 1);
  const changes = compareScan(c, good, attempts);
  assert.ok(changes.some(e => e.type === 'data_recovered'));
  assert.equal(changes.find(e => e.type === 'non_resident_sold_out').gap, true);
  ingestScan(study, c);
  assert.equal(study.observationCount, 2);
  assert.ok([...study.pairs.values()][0].series.values().next().value.crossings.every(c => c.gap));
});
