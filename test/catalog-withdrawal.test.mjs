import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../lib/collector.mjs';
import { assertScan, scanCounts } from '../lib/study.mjs';
import { collectionRunStatus } from '../lib/run-status.mjs';
import { reconcileWithdrawal } from '../lib/catalog-withdrawal.mjs';

const config = { island: 'Madeira', horizonDays: 2, calendarTimezone: 'Atlantic/Madeira', minimumRequestSpacingMs: 1000,
  concurrency: 1, maximumScanMinutes: 30, maximumConsecutiveFailures: 5, expectedIntervalMinutes: 60,
  staleAfterMinutes: 90, maximumArchiveMiB: 750 };
const catalog = [{ id: 301, name: 'PR1 | full' }, { id: 272, name: 'PR10 | Furado' }];
const envelope = data => Response.json({ status: true, data });

async function fixture(endCatalog = catalog.slice(0, 1)) {
  let time = Date.parse('2026-11-02T15:00:00Z'), catalogs = 0, posts = 0;
  const scan = await collect(config, { now: () => time, sleep: async ms => { time += ms; }, fetcher: async (url, init) => {
    if (url.endsWith('/resources')) return envelope(++catalogs === 1 ? catalog : endCatalog);
    if (url.endsWith('/services/78-82-259')) return new Response('', { headers: [
      ['Set-Cookie', 'XSRF-TOKEN=x'], ['Set-Cookie', 'laravel_session=anonymous']] });
    posts++;
    const q = JSON.parse(init.body);
    if (q.resourceId === '272') return Response.json({ status: false, data: [], errors: ['Unavailable'] });
    const date = `2026-11-${String(q.day).padStart(2, '0')}`;
    return envelope([{ begin: { date: date + ' 08:00:00', timezone: 'Europe/Lisbon' },
      end: { date: date + ' 08:30:00', timezone: 'Europe/Lisbon' }, slotTitle: '100% Residentes • 42% Não residentes' }]);
  } });
  assertScan(scan); return { scan, catalogs, posts };
}

test('confirmed mid-scan withdrawal retains rejections and completes only the current catalog', async () => {
  const { scan, catalogs, posts } = await fixture();
  assert.equal(catalogs, 2); assert.equal(posts, 4);
  assert.deepEqual(scan.catalog.map(t => t.resourceId), ['301']);
  assert.equal(scan.catalogWithdrawal.initialCatalog.length, 2);
  assert.equal(scan.catalogWithdrawal.entries.length, 2);
  assert.ok(scan.catalogWithdrawal.entries.every(e => e.code === 'UPSTREAM_REJECTED' && e.s === undefined));
  assert.equal(scanCounts(scan).verified, 2); assert.equal(scanCounts(scan).failed, 0);
  const status = collectionRunStatus(scan, { state: 'complete', scanId: scan.id }, 'success');
  assert.equal(status.failed, false); assert.match(status.summary, /Withdrawn booking resources/);
  const corrupt = structuredClone(scan); corrupt.catalogWithdrawal.entries.pop();
  assert.throws(() => assertScan(corrupt), /coverage/);
});

test('still-listed rejections and added resources cannot be hidden as withdrawals', async () => {
  for (const final of [catalog, [...catalog.slice(0, 1), { id: 999, name: 'PR30 | new' }]]) {
    const { scan } = await fixture(final);
    assert.equal(scan.catalogWithdrawal, undefined); assert.equal(scanCounts(scan).failed, 2);
    assert.equal(collectionRunStatus(scan, { state: 'partial', scanId: scan.id }, 'success').failed, true);
  }
});

test('withdrawal never discards a successful observation or a different error', async () => {
  const { scan } = await fixture(catalog);
  const selection = { catalog: scan.catalog.filter(t => t.resourceId === '301') };
  for (const change of [{ status: 'error', code: 'UPSTREAM_TIMEOUT' }, { status: 'ok', s: scan.entries[0].s }]) {
    const original = structuredClone(scan);
    Object.assign(original.entries.find(e => e.r === '272'), change);
    assert.equal(reconcileWithdrawal(original, selection, scan.finishedAt), original);
  }
});
