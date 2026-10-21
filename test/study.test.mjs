import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rollingDates, localInstant, assertScan, packSlots } from '../lib/study.mjs';
import { collect } from '../lib/collector.mjs';
import { writeScan, readScan, verifyArchives, archiveFiles } from '../lib/archive.mjs';
import { normalizeSlots, fetchIntervals, validateQuery } from '../src/upstream.mjs';

const config = { horizonDays: 2, calendarTimezone: 'Atlantic/Madeira', minimumRequestSpacingMs: 1000, concurrency: 1,
  maximumScanMinutes: 30, maximumConsecutiveFailures: 5, expectedIntervalMinutes: 60, staleAfterMinutes: 90, maximumArchiveMiB: 750 };
const rawSlot = (date = '2026-10-26', percent = 42) => ({ begin: { date: date + ' 07:00:00.000000', timezone: 'Europe/Lisbon' },
  end: { date: date + ' 07:30:00.000000', timezone: 'Europe/Lisbon' },
  slotTitle: `Disponibilidade: 100% Residentes • ${percent}% Não residentes • 100% Operadores económicos`, maximumCapacity: 70, reservations: 0 });
const session = () => new Response('page', { headers: [['Set-Cookie', 'XSRF-TOKEN=x%3D; Path=/'], ['Set-Cookie', 'laravel_session=anon; HttpOnly']] });
const envelope = data => Response.json({ status: true, data });
const fixture = (overrides = {}) => ({ v: 1, id: '2026-10-26T06-00-00-000Z', startedAt: '2026-10-26T06:00:00.000Z', finishedAt: '2026-10-26T06:01:00.000Z',
  dates: ['2026-10-26'], catalog: [{ resourceId: '301', name: 'PR 1' }],
  entries: [{ r: '301', d: '2026-10-26', at: '2026-10-26T06:00:05.000Z', status: 'ok', s: packSlots(normalizeSlots([rawSlot()], '2026-10-26')) }], ...overrides });

test('rolling window uses Madeira calendar across DST and year boundaries', () => {
  assert.deepEqual(rollingDates('2026-10-24T23:30:00Z', 3, 'Atlantic/Madeira'), ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.deepEqual(rollingDates('2026-12-31T23:30:00Z', 2, 'Atlantic/Madeira'), ['2026-12-31', '2027-01-01']);
  assert.throws(() => rollingDates(Date.now(), 61, 'UTC'));
});

test('lead times use the source IANA timezone and reject ambiguous/missing DST times', () => {
  assert.equal(localInstant('2026-10-24 07:00:00.000001', 'Europe/Lisbon').at, Date.parse('2026-10-24T06:00:00Z'));
  assert.equal(localInstant('2026-10-26 07:00:00.000000', 'Europe/Lisbon').at, Date.parse('2026-10-26T07:00:00Z'));
  assert.equal(localInstant('2026-10-25 01:30:00', 'Europe/Lisbon').reason, 'ambiguous');
  assert.equal(localInstant('2026-03-29 01:30:00', 'Europe/Lisbon').reason, 'nonexistent');
  assert.equal(localInstant('2026-02-30 07:00:00', 'Europe/Lisbon').reason, 'invalid');
});

test('non-resident schema fails explicitly; percentages never use capacity or residents', () => {
  assert.equal(normalizeSlots([rawSlot(undefined, 0)], '2026-10-26')[0].nonResident, 0);
  assert.equal(normalizeSlots([rawSlot(undefined, 100)], '2026-10-26')[0].nonResident, 100);
  assert.throws(() => normalizeSlots([{ ...rawSlot(), slotTitle: '100% Residentes' }], '2026-10-26'), { code: 'UPSTREAM_SCHEMA_CHANGED' });
  assert.throws(() => normalizeSlots([{ ...rawSlot(), slotTitle: '1% Não residentes • 2% Não residentes' }], '2026-10-26'));
  for (const q of ['resourceId=301&date=2026-02-30', 'resourceId=1&date=2026-10-26&date=2026-10-27', 'resourceId=0&date=2026-10-26']) assert.throws(() => validateQuery(new URL('https://test.invalid/?' + q)));
});

test('anonymous session is fresh; only allowed read POST; retry 419 once', async () => {
  let pages = 0, posts = 0;
  const data = await fetchIntervals(validateQuery(new URL('https://test.invalid/?resourceId=301&date=2026-10-26')), async (url, init) => {
    assert.equal(init.redirect, 'manual');
    if (url.endsWith('/services/78-82-259')) { pages++; return session(); }
    assert.equal(url, 'https://simplifica.madeira.gov.pt/api/resources/intervals');
    assert.equal(init.method, 'POST'); assert.equal(init.headers['X-XSRF-TOKEN'], 'x=');
    assert.match(init.headers.Cookie, /laravel_session=anon/);
    return ++posts === 1 ? new Response('', { status: 419 }) : envelope([rawSlot()]);
  });
  assert.equal(data.length, 1); assert.equal(pages, 2); assert.equal(posts, 2);
});

test('collector accounts for every resource/day, empty arrays, and every returned slot', async () => {
  let now = Date.parse('2026-10-26T06:00:00Z'), posts = 0;
  const scan = await collect(config, { now: () => now, sleep: async ms => { now += ms; }, fetcher: async (url, init) => {
    if (url.endsWith('/resources')) return envelope([{ id: 301, name: 'PR 1 full' }, { id: 225, name: 'PR 1 short' }]);
    if (url.endsWith('/services/78-82-259')) return session();
    const q = JSON.parse(init.body), d = `${q.year}-${String(q.month).padStart(2, '0')}-${String(q.day).padStart(2, '0')}`;
    posts++;
    return envelope(q.resourceId === '225' ? [] : [rawSlot(d, posts === 1 ? 0 : 100)]);
  } });
  assertScan(scan); assert.equal(scan.entries.length, 4); assert.equal(posts, 4);
  assert.equal(scan.entries.filter(x => x.status === 'empty').length, 2);
  assert.deepEqual(scan.entries.filter(x => x.status === 'ok').map(e => e.s[0][3]), [0, 100]);
});

test('429 stops further source queries and persists cooldown; failures do not become zero', async () => {
  let calls = 0, now = Date.parse('2026-10-26T06:00:00Z');
  const scan = await collect(config, { now: () => now, sleep: async ms => { now += ms; }, fetcher: async url => {
    if (url.endsWith('/resources')) return envelope([{ id: 301, name: 'PR 1' }]);
    calls++; return new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
  } });
  assertScan(scan); assert.equal(calls, 1); assert.equal(scan.entries[0].status, 'error');
  assert.equal(scan.entries[1].status, 'skipped'); assert.equal(scan.entries[0].s, undefined);
  assert.equal(scan.cooldownUntil, '2026-10-26T07:00:00.000Z');
});

test('archives are lossless and idempotent; mutation and deletion are detected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-study-test-'));
  try {
    const scan = fixture();
    await writeScan(root, scan); await writeScan(root, scan);
    const [file] = await archiveFiles(root);
    assert.deepEqual(await readScan(file), scan);
    assert.equal((await verifyArchives(root)).scans, 1);
    const changed = structuredClone(scan); changed.entries[0].s[0][3]--;
    await assert.rejects(writeScan(root, changed), /overwrite/);
    await fs.appendFile(file, 'bad');
    await assert.rejects(verifyArchives(root), /integrity/);
    await fs.rm(file);
    await assert.rejects(verifyArchives(root), /missing/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('archive schema distinguishes empty, errors and incomplete accounting', () => {
  const scan = fixture();
  assert.throws(() => assertScan({ ...scan, entries: [] }), /coverage/);
  const invalid = structuredClone(scan); invalid.entries[0].status = 'error';
  assert.throws(() => assertScan(invalid), /masquerading/);
});
