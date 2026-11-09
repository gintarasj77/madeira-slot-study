import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collect } from '../lib/collector.mjs';
import { assertScan, scanCounts, validateConfig } from '../lib/study.mjs';
import { collectionRunStatus } from '../lib/run-status.mjs';
import { writeScan, readScan, archiveFiles, verifyArchives } from '../lib/archive.mjs';
import { createStudy, ingestScan } from '../lib/analysis.mjs';

const config = { island: 'Madeira', horizonDays: 1, calendarTimezone: 'Atlantic/Madeira', minimumRequestSpacingMs: 1000,
  concurrency: 1, maximumScanMinutes: 30, maximumConsecutiveFailures: 5, expectedIntervalMinutes: 60,
  staleAfterMinutes: 90, maximumArchiveMiB: 750, transientRetryDelaysMs: [30000, 120000], maximumRetryChecks: 20 };
const catalog = [{ id: 301, name: 'PR1 | full' }, { id: 188, name: 'PR8 | coast' }, { id: 225, name: 'PR1 | short' }];
const slot = (percentage = 42) => ({ begin: { date: '2026-10-27 08:00:00.000000', timezone: 'Europe/Lisbon' },
  end: { date: '2026-10-27 08:30:00.000000', timezone: 'Europe/Lisbon' },
  slotTitle: `100% Residentes • ${percentage}% Não residentes • 100% Operadores económicos` });
const ok = percentage => Response.json({ status: true, data: [slot(percentage)] });
const timeout = () => { throw new DOMException('temporary timeout', 'TimeoutError'); };

async function run(scenario, { resources = catalog, settings = {}, cancelAfter = Infinity, catalogScenario, priorCatalog = [] } = {}) {
  const started = Date.parse('2026-10-27T06:00:00.000Z');
  let time = started, pages = 0;
  const calls = [], catalogCalls = [], checkpoints = [], attempts = new Map();
  const scan = await collect({ ...config, ...settings }, { now: () => time,
    priorCatalog,
    sleep: async ms => { time += ms; }, stopRequested: () => time - started >= cancelAfter,
    checkpoint: async value => { checkpoints.push(structuredClone(value)); }, fetcher: async (url, init) => {
      if (url.endsWith('/resources')) {
        catalogCalls.push(time);
        return catalogScenario ? catalogScenario(catalogCalls.length) : Response.json({ status: true, data: resources });
      }
      if (url.endsWith('/services/78-82-259')) {
        pages++;
        return new Response('unused', { headers: [['Set-Cookie', 'XSRF-TOKEN=fresh%3D; Path=/'], ['Set-Cookie', 'laravel_session=anonymous']] });
      }
      assert.equal(url, 'https://simplifica.madeira.gov.pt/api/resources/intervals');
      assert.equal(init.method, 'POST');
      const { resourceId } = JSON.parse(init.body);
      const attempt = (attempts.get(resourceId) || 0) + 1;
      attempts.set(resourceId, attempt); calls.push({ resourceId, attempt, at: time });
      return scenario(resourceId, attempt);
    } });
  assertScan(scan);
  return { scan, calls, catalogCalls, pages, checkpoints };
}

test('only failed checks recover, with bounded delays, real timestamps and lossless attempt history', async () => {
  const { scan, calls, pages, checkpoints } = await run((id, attempt) => {
    if (id === '301' && attempt === 1) return timeout();
    if (id === '225' && attempt === 1) return new Response('', { status: 503 });
    if (id === '225' && attempt === 2) throw new TypeError('connection interrupted');
    return ok(id === '301' ? 0 : 42);
  });
  assert.deepEqual(calls.map(c => c.resourceId), ['301', '188', '225', '301', '225', '225']);
  assert.equal(pages, calls.length, 'each recovery starts a fresh anonymous session');
  assert.ok(calls[3].at - calls[2].at >= 30000);
  assert.ok(calls[5].at - calls[4].at >= 120000);
  assert.ok(calls.slice(1).every((c, i) => c.at - calls[i].at >= config.minimumRequestSpacingMs));
  assert.equal(scanCounts(scan).verified, 3); assert.equal(scanCounts(scan).slots, 3);
  const full = scan.entries.find(e => e.r === '301'), short = scan.entries.find(e => e.r === '225');
  assert.equal(scan.entries.find(e => e.r === '188').attempts, undefined);
  assert.deepEqual(full.attempts.map(a => a.status), ['error', 'ok']);
  assert.deepEqual(short.attempts.map(a => a.code), ['UPSTREAM_HTTP_ERROR', 'UPSTREAM_UNREACHABLE', undefined]);
  assert.equal(short.attempts[0].upstreamStatus, 503);
  assert.equal(full.s[0][3], 0); assert.equal(full.at, new Date(calls[3].at).toISOString());
  assert.equal(short.at, new Date(calls[5].at).toISOString());
  assert.ok(checkpoints.some(s => s.entries.find(e => e.r === '301').status === 'error'));
  const status = collectionRunStatus(scan, { scanId: scan.id, state: 'complete' }, 'success');
  assert.equal(status.failed, false);
  assert.match(status.message, /2\/2 checks recovered in 3 additional attempts/);
  assert.match(status.summary, /Recovered automatically/);

  const baselineAt = '2026-10-27T05:00:00.000Z';
  const baseline = { ...scan, id: baselineAt.replace(/[:.]/g, '-'), startedAt: baselineAt, finishedAt: baselineAt,
    entries: scan.entries.map(e => ({ r: e.r, d: e.d, at: baselineAt, status: 'ok', s: e.s.map(s => [...s.slice(0, 3), 100]) })) };
  const study = createStudy(); ingestScan(study, baseline); ingestScan(study, scan);
  assert.equal(study.observationCount, 6, 'retry metadata is never another availability sample');
  const series = [...study.pairs.get('301/2026-10-27').series.values()][0];
  assert.ok(series.crossings.length && series.crossings.every(c => c.gap));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-recovery-test-'));
  try {
    await writeScan(root, scan);
    assert.deepEqual(await readScan((await archiveFiles(root))[0]), scan);
    assert.equal((await verifyArchives(root)).slots, 3);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('madeira-recovery-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('exhausted recovery stays partial and is still reported as a failed run', async () => {
  const { scan, calls } = await run(id => id === '301' ? timeout() : ok(100), { resources: catalog.slice(0, 2) });
  assert.deepEqual(calls.map(c => c.resourceId), ['301', '188', '301', '301']);
  const failed = scan.entries.find(e => e.r === '301');
  assert.equal(failed.attempts.length, 3); assert.equal(failed.s, undefined);
  assert.equal(scanCounts(scan).failed, 1);
  assert.equal(collectionRunStatus(scan, { scanId: scan.id, state: 'partial' }, 'success').failed, true);
});

test('three simultaneous first-pass failures recover serially after all initial work finishes', async () => {
  let active = 0, maximum = 0;
  const { scan, calls } = await run(async (_id, attempt) => {
    if (attempt === 1) return timeout();
    active++; maximum = Math.max(maximum, active);
    await Promise.resolve(); active--;
    return ok(42);
  }, { settings: { concurrency: 3 } });
  assert.equal(calls.length, 6); assert.equal(scanCounts(scan).failed, 0);
  assert.ok(calls.slice(0, 3).every(c => c.attempt === 1));
  assert.ok(calls.slice(3).every(c => c.attempt === 2));
  assert.equal(maximum, 1); assert.ok(scan.entries.every(e => e.attempts.length === 2));
});

test('429 or schema drift during recovery stops further attempts and preserves the evidence', async () => {
  for (const cause of ['rate', 'schema']) {
    const { scan, calls } = await run((id, attempt) => {
      if (id === '188') return ok(100);
      if (attempt === 1) return timeout();
      if (cause === 'rate') return new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
      return Response.json({ status: true, data: [{ ...slot(), slotTitle: '100% Residentes' }] });
    });
    assert.equal(calls.length, 4);
    assert.equal(scan.stopReason, cause === 'rate' ? 'rate_limited' : 'schema_changed');
    assert.equal(scan.entries.find(e => e.r === '225').attempts, undefined);
    assert.equal(scan.entries.find(e => e.r === '301').attempts.length, 2);
    if (cause === 'rate') assert.equal(Date.parse(scan.cooldownUntil) - Date.parse(scan.finishedAt), 3600000);
  }
});

test('authentication errors and explicit server backoff are never retried', async () => {
  const forbidden = await run(id => id === '301' ? new Response('', { status: 403 }) : ok(42), { resources: catalog.slice(0, 2) });
  assert.equal(forbidden.calls.length, 2); assert.equal(forbidden.scan.entries[0].attempts, undefined);
  const backoff = await run(() => new Response('', { status: 503, headers: { 'Retry-After': '120' } }));
  assert.equal(backoff.calls.length, 1); assert.equal(backoff.scan.stopReason, 'source_backoff');
  assert.equal(Date.parse(backoff.scan.cooldownUntil) - Date.parse(backoff.scan.finishedAt), 120000);
  assert.ok(backoff.scan.entries.slice(1).every(e => e.status === 'skipped'));
});

test('time budget, cancellation, and the source circuit breaker also stop recovery', async () => {
  const scenario = id => id === '301' ? timeout() : ok(42);
  const budget = await run(scenario, { resources: catalog.slice(0, 2), settings: { maximumScanMinutes: 1 } });
  assert.equal(budget.calls.length, 3); assert.equal(budget.scan.stopReason, 'scan_time_budget_or_shutdown');
  const cancel = await run(scenario, { resources: catalog.slice(0, 2), cancelAfter: 10000 });
  assert.equal(cancel.calls.length, 2); assert.equal(cancel.scan.stopReason, 'scan_time_budget_or_shutdown');
  const circuit = await run(timeout, { settings: { maximumConsecutiveFailures: 2 } });
  assert.equal(circuit.calls.length, 2); assert.equal(circuit.scan.stopReason, 'repeated_source_failures');
});

test('widespread transient failures are not multiplied into a recovery storm', async () => {
  const resources = Array.from({ length: 42 }, (_, i) => ({ id: 400 + i, name: `PR1 | fixture ${i}` }));
  const { scan, calls } = await run(id => Number(id) % 2 === 0 ? timeout() : ok(42), { resources });
  assert.equal(calls.length, 42); assert.equal(scanCounts(scan).failed, 21);
  assert.equal(scan.recoverySkippedReason, 'too_many_transient_failures');
  assert.ok(scan.entries.every(e => e.attempts === undefined));
});

test('retry configuration and archive validation refuse unbounded or falsified attempts', async () => {
  for (const settings of [{ transientRetryDelaysMs: [100] }, { transientRetryDelaysMs: [30000, 120000, 180000] },
    { transientRetryDelaysMs: [120000, 30000] }, { maximumRetryChecks: 21 }]) {
    assert.throws(() => validateConfig({ ...config, ...settings }));
  }
  const { scan } = await run((id, attempt) => attempt === 1 ? timeout() : ok(42), { resources: catalog.slice(0, 1) });
  const changed = structuredClone(scan);
  changed.entries[0].at = scan.startedAt;
  assert.throws(() => assertScan(changed), /retry|Retry/);
  const fabricated = structuredClone(scan);
  fabricated.entries[0].attempts[0].s = [];
  assert.throws(() => assertScan(fabricated), /retry|Retry/);
});

test('startup catalog connection failures recover before any availability query uses a freshly scoped catalog', async () => {
  const { scan, calls, catalogCalls, checkpoints } = await run(() => ok(42), {
    priorCatalog: [{ resourceId: '999', name: 'PR1 | previous catalog' }, { resourceId: '282', name: 'Porto Santo PR1 | coast' }],
    catalogScenario: attempt => {
      if (attempt === 1) throw new TypeError('temporary connection failure');
      if (attempt === 2) return new Response('', { status: 503 });
      return Response.json({ status: true, data: [...catalog, { id: 282, name: 'Porto Santo PR1 | coast' }] });
    },
  });
  assert.equal(catalogCalls.length, 3);
  assert.ok(catalogCalls[1] - catalogCalls[0] >= 30000);
  assert.ok(catalogCalls[2] - catalogCalls[1] >= 120000);
  assert.ok(calls.every(c => c.at >= catalogCalls[2]));
  assert.deepEqual(calls.map(c => c.resourceId), ['301', '188', '225']);
  assert.equal(scan.catalogError, undefined); assert.equal(scan.stopReason, null);
  assert.deepEqual(scan.catalogAttempts.map(a => a.status), ['error', 'error', 'ok']);
  assert.equal(scan.catalogAttempts[0].code, 'UPSTREAM_UNREACHABLE');
  assert.ok(checkpoints.some(s => s.catalogError && s.entries.every(e => e.status === 'skipped')));
  const status = collectionRunStatus(scan, { scanId: scan.id, state: 'complete' }, 'success');
  assert.equal(status.failed, false); assert.match(status.message, /Trail list recovered after 2 additional attempts/);
  assert.match(status.summary, /Trail-list attempts/);
  const invalid = structuredClone(scan); invalid.catalogError = scan.catalogAttempts[0];
  assert.throws(() => assertScan(invalid), /Catalog retry history/);
});

test('exhausted catalog retries retain unknown scoped coverage and make no availability queries', async () => {
  const { scan, calls, catalogCalls } = await run(() => assert.fail('Unverified catalog must not authorize availability'), {
    priorCatalog: [{ resourceId: '301', name: 'PR1 | full' }, { resourceId: '282', name: 'Porto Santo PR1 | coast' }],
    catalogScenario: () => new Response('', { status: 503 }),
  });
  assert.equal(catalogCalls.length, 3); assert.equal(calls.length, 0);
  assert.equal(scan.catalogAttempts.length, 3); assert.equal(scan.stopReason, 'catalog_unverified');
  assert.deepEqual(scan.catalog.map(t => t.resourceId), ['301']);
  assert.ok(scan.entries.every(e => e.status === 'skipped' && e.s === undefined));
  const status = collectionRunStatus(scan, { scanId: scan.id, state: 'partial' }, 'success');
  assert.equal(status.failed, true); assert.match(status.message, /Trail-list failure: UPSTREAM_HTTP_ERROR/);
});

const missingCatalog = (headers) => Response.json({ status: false, data: [],
  errors: { code: 'e071', msg: 'Resource not found', errors: [] } }, { headers });

test('the exact catalog e071 error gets bounded recovery and requires a fresh list', async () => {
  for (const recovers of [true, false]) {
    const { scan, calls, catalogCalls } = await run(() => ok(42), {
      priorCatalog: [{ resourceId: '999', name: 'PR1 | previous catalog' }],
      catalogScenario: attempt => recovers && attempt === 3 ?
        Response.json({ status: true, data: catalog }) : missingCatalog(),
    });
    assert.equal(catalogCalls.length, 3);
    assert.equal(catalogCalls[1] - catalogCalls[0], 30000);
    assert.equal(catalogCalls[2] - catalogCalls[1], 120000);
    assert.deepEqual(scan.catalogAttempts.map(attempt => attempt.code || attempt.status),
      ['UPSTREAM_CATALOG_NOT_FOUND', 'UPSTREAM_CATALOG_NOT_FOUND', recovers ? 'ok' : 'UPSTREAM_CATALOG_NOT_FOUND']);
    assert.deepEqual(calls.map(call => call.resourceId), recovers ? ['301', '188', '225'] : []);
    assert.ok(calls.every(call => call.at >= catalogCalls[2]));
    assert.equal(collectionRunStatus(scan, { scanId: scan.id, state: recovers ? 'complete' : 'partial' }, 'success').failed, !recovers);
  }
});

test('catalog rate limits, explicit backoff, authentication and schema failures are never retried', async () => {
  for (const response of [new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
    new Response('', { status: 503, headers: { 'Retry-After': '120' } }), new Response('', { status: 403 }),
    missingCatalog({ 'Retry-After': '120' }), Response.json({ status: false, data: [], errors: { code: 'other' } }),
    Response.json({ status: true, data: [{ id: 282, name: 'Porto Santo PR1 | Pico Branco' }] }, { headers: { 'Retry-After': '120' } }),
    Response.json({ status: true, data: [{ id: 301, missingName: true }] })]) {
    const { scan, calls, catalogCalls } = await run(() => assert.fail('No availability permitted'), {
      priorCatalog: [{ resourceId: '301', name: 'PR1 | full' }], catalogScenario: () => response,
    });
    assert.equal(catalogCalls.length, 1); assert.equal(calls.length, 0); assert.equal(scan.catalogAttempts.length, 1);
    if (response.headers.has('retry-after')) assert.equal(Date.parse(scan.cooldownUntil) - Date.parse(scan.finishedAt),
      Number(response.headers.get('retry-after')) * 1000);
  }
});

test('a Porto Santo-only catalog is retried and cannot authorize slot collection', async () => {
  for (const recovers of [true, false]) {
    const { scan, calls, catalogCalls, pages } = await run(() => ok(42), {
      priorCatalog: [{ resourceId: '999', name: 'PR1 | previous catalog' }],
      catalogScenario: attempt => Response.json({ status: true, data: recovers && attempt === 3 ? catalog :
        [{ id: 282, name: 'Porto Santo PR1 | Pico Branco' }] }),
    });
    assert.equal(catalogCalls.length, 3);
    assert.equal(catalogCalls[2] - catalogCalls[0], 150000);
    assert.equal(scan.catalogAttempts[0].code, 'UPSTREAM_CATALOG_NO_MADEIRA');
    assert.deepEqual(calls.map(call => call.resourceId), recovers ? ['301', '188', '225'] : []);
    assert.ok(calls.every(call => call.at >= catalogCalls[2]));
    if (!recovers) {
      assert.equal(pages, 0);
      assert.equal(scan.stopReason, 'catalog_unverified');
      assert.deepEqual(scan.entries.map(e => [e.r, e.status]), [['999', 'skipped']]);
    }
  }
});

test('catalog retry backoff obeys cancellation and the shared scan time budget', async () => {
  for (const options of [{ cancelAfter: 10000 }, { settings: { maximumScanMinutes: 1 } }]) {
    const { scan, calls, catalogCalls } = await run(() => assert.fail('No verified catalog'), {
      ...options, priorCatalog: [{ resourceId: '301', name: 'PR1 | full' }], catalogScenario: () => new Response('', { status: 503 }),
    });
    assert.equal(scan.stopReason, 'scan_time_budget_or_shutdown'); assert.equal(calls.length, 0);
    assert.ok(catalogCalls.length < 3); assert.ok(scan.catalogError);
  }
});
