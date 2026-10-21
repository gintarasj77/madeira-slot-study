import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudy, ingestScan, summarizeStudy, renderTrail } from '../lib/analysis.mjs';

const slot = p => ['2026-11-10 07:00:00.000000', '2026-11-10 07:30:00.000000', 'Europe/Lisbon', p];
function scan(at, p, status = 'ok') {
  return { v: 1, id: at.replace(/[:.]/g, '-'), startedAt: at, finishedAt: at, dates: ['2026-11-10'],
    calendarTimezone: 'Atlantic/Madeira', catalog: [{ resourceId: '301', name: 'PR1 | full' }],
    entries: [{ r: '301', d: '2026-11-10', at, status, ...(status === 'ok' ? { s: [slot(p)] } : status === 'empty' ? { s: [] } : { error: 'Unavailable' }) }] };
}
const seriesOf = study => [...study.pairs.values()][0].series.values().next().value;

test('already-full first observations are censored, not fabricated threshold crossings', () => {
  const study = createStudy(Date.parse('2026-11-11T00:00:00Z'));
  ingestScan(study, scan('2026-11-01T07:00:00.000Z', 0));
  assert.deepEqual(seriesOf(study).firstSeenAtOrBelow, [50, 20, 0]);
  assert.equal(seriesOf(study).crossings.length, 0);
  const trail = summarizeStudy(study).trails[0];
  assert.equal(trail.firstSeenSoldOutSeries, 1);
  assert.ok(trail.groups.every(g => g.suggestedLeadDays === null));
});

test('all small changes, bounded threshold crossings and reopenings are retained', () => {
  const study = createStudy();
  for (const [hour, p] of [[7, 51], [8, 49], [9, 20], [10, 0], [11, 4]]) ingestScan(study, scan(`2026-11-01T${String(hour).padStart(2, '0')}:00:00.000Z`, p));
  const s = seriesOf(study);
  assert.equal(s.changes, 4); assert.equal(s.smallChanges, 2);
  assert.deepEqual(s.crossings.map(c => c.threshold), [50, 20, 0]);
  assert.deepEqual(s.crossings[0].between, ['2026-11-01T07:00:00.000Z', '2026-11-01T08:00:00.000Z']);
  assert.deepEqual(s.crossings[0].leadHours, [215, 216]);
  assert.equal(s.crossings[0].gap, false);
  assert.equal(s.reopenings.length, 1);
});

test('failed and empty checks never manufacture zero and mark uncertain crossings', () => {
  for (const status of ['error', 'empty', 'skipped']) {
    const study = createStudy();
    ingestScan(study, scan('2026-11-01T07:00:00.000Z', 60));
    ingestScan(study, scan('2026-11-01T08:00:00.000Z', undefined, status));
    assert.equal(seriesOf(study).last.p, 60);
    assert.equal(seriesOf(study).crossings.length, 0);
    ingestScan(study, scan('2026-11-01T09:00:00.000Z', 0));
    assert.equal(seriesOf(study).crossings.length, 3);
    assert.ok(seriesOf(study).crossings.every(c => c.gap));
  }
});

test('missing entire scans widen intervals and raise a collection gap', () => {
  const study = createStudy();
  ingestScan(study, scan('2026-11-01T07:00:00.000Z', 60));
  ingestScan(study, scan('2026-11-01T11:00:00.000Z', 0));
  assert.equal(study.missingScanIntervals.length, 1);
  assert.ok(seriesOf(study).crossings.every(c => c.gap));
});

test('after-entry expiry does not appear as booking pressure', () => {
  const study = createStudy();
  ingestScan(study, scan('2026-11-10T06:00:00.000Z', 80));
  ingestScan(study, scan('2026-11-10T08:00:00.000Z', 0));
  assert.equal(study.afterEntryObservations, 1);
  assert.equal(seriesOf(study).crossings.length, 0);
  assert.equal(seriesOf(study).last.p, 80);
});

test('lead-time samples count visit dates once and separate mature evidence', () => {
  const study = createStudy(Date.parse('2026-11-11T00:00:00Z'));
  for (const at of ['2026-11-09T06:00:00.000Z', '2026-11-09T07:00:00.000Z', '2026-11-09T08:00:00.000Z']) ingestScan(study, scan(at, 50));
  const group = summarizeStudy(study).trails[0].groups[0];
  assert.equal(group.leadTime[1].distinctDates, 1);
  assert.equal(group.leadTime[1].matureDistinctDates, 1);
  assert.equal(group.leadTime[1].median, 50);
  assert.equal(group.leadTime[1].samplingOpportunities, 1);
  assert.equal(group.suggestedLeadDays, null);
  const future = createStudy(Date.parse('2026-11-09T12:00:00Z'));
  ingestScan(future, scan('2026-11-09T07:00:00.000Z', 50));
  assert.equal(summarizeStudy(future).trails[0].groups[0].leadTime[1].matureDistinctDates, 0);
});

test('route variants and catalog changes remain distinct', () => {
  const study = createStudy();
  const first = scan('2026-11-01T07:00:00.000Z', 60);
  ingestScan(study, first);
  const second = structuredClone(first); second.startedAt = second.finishedAt = '2026-11-01T08:00:00.000Z';
  second.catalog = [{ resourceId: '225', name: 'PR1 | short' }]; second.entries[0].r = '225';
  ingestScan(study, second);
  assert.equal(study.trails.size, 2);
  assert.deepEqual(study.catalogChanges.map(c => c.type), ['added', 'removed']);
});

test('per-trail reader report includes every returned percentage with freshness and uncertainty', () => {
  const current = scan('2026-11-01T07:00:00.000Z', 0);
  current.entries[0].s.push(['2026-11-10 12:00:00.000000', '2026-11-10 12:30:00.000000', 'Europe/Lisbon', 100]);
  const report = renderTrail(current, current.catalog[0], null);
  assert.match(report, /07:00–07:30 0%/); assert.match(report, /12:00–12:30 100%/);
  assert.match(report, /2026-11-01T07:00:00.000Z/); assert.match(report, /Europe\/Lisbon/); assert.match(report, /unknown/);
});

test('lead-time suggestions require 14 mature dates and sufficient sampling coverage', () => {
  const study = createStudy(Date.parse('2026-12-20T00:00:00Z'));
  const seed = scan('2026-10-01T07:00:00.000Z', 50, 'error');
  ingestScan(study, seed);
  let count = 0;
  for (let i = 0; count < 14; i++) {
    const visit = new Date(Date.parse('2026-11-02T07:00:00Z') + i * 86400000);
    if ([0, 6].includes(visit.getUTCDay())) continue;
    const d = visit.toISOString().slice(0, 10), at = new Date(+visit - 86400000).toISOString();
    const current = scan(at, 50); current.dates = [d]; current.entries[0].d = d;
    current.entries[0].s = [[d + ' 07:00:00.000000', d + ' 07:30:00.000000', 'Europe/Lisbon', 50]];
    ingestScan(study, current); count++;
    const group = summarizeStudy(study).trails[0].groups[0];
    if (count < 14) assert.equal(group.suggestedLeadDays, null);
  }
  assert.equal(summarizeStudy(study).trails[0].groups[0].suggestedLeadDays, 1);
});
