import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionRunStatus } from '../lib/run-status.mjs';

const scan = () => ({ v: 1, id: '2026-10-27T11-00-00-000Z', startedAt: '2026-10-27T11:00:00.000Z',
  finishedAt: '2026-10-27T11:01:00.000Z', dates: ['2026-11-16'],
  catalog: [{ resourceId: '301', name: 'PR1 | full' }, { resourceId: '225', name: 'PR1 short' }],
  entries: [{ r: '301', d: '2026-11-16', at: '2026-10-27T11:00:01.000Z', status: 'ok',
    s: [['2026-11-16 08:00:00', '2026-11-16 08:30:00', 'Europe/Lisbon', 42]] },
  { r: '225', d: '2026-11-16', at: '2026-10-27T11:00:02.000Z', status: 'empty', s: [] }] });
const health = s => ({ state: 'complete', scanId: s.id });

test('partial run keeps failure visible with coverage and exact missed resource/date', () => {
  const s = scan();
  s.entries[0] = { ...s.entries[0], status: 'error', code: 'UPSTREAM_TIMEOUT', error: 'private exception text' };
  delete s.entries[0].s;
  const result = collectionRunStatus(s, { ...health(s), state: 'partial' }, 'success');
  assert.equal(result.failed, true);
  assert.match(result.message, /1\/2 checks verified; 1 failed\/not queried/);
  assert.match(result.message, /1 UPSTREAM_TIMEOUT/);
  assert.match(result.summary, /301 \| PR1 \\\| full \| 2026-11-16 \| UPSTREAM_TIMEOUT/);
  assert.match(result.summary, /unknown/);
  assert.doesNotMatch(result.summary, /private exception text/);
});

test('healthy retained data cannot hide a failed step, health error or mismatched scan', () => {
  const s = scan();
  assert.equal(collectionRunStatus(s, health(s), 'success').failed, false);
  const failedStep = collectionRunStatus(s, health(s), 'failure');
  assert.equal(failedStep.failed, true);
  assert.match(failedStep.message, /retained data may be older/);
  assert.equal(collectionRunStatus(s, { ...health(s), error: 'ARCHIVE_SIZE_GUARD' }, 'success').failed, true);
  assert.equal(collectionRunStatus(s, { ...health(s), scanId: 'older' }, 'success').failed, true);
  s.catalogError = { code: 'UPSTREAM_UNREACHABLE' };
  assert.equal(collectionRunStatus(s, health(s), 'success').failed, true);
  const zero = { ...scan(), catalog: [], entries: [] };
  const zeroStatus = collectionRunStatus(zero, health(zero), 'success');
  assert.equal(zeroStatus.failed, true);
  assert.match(zeroStatus.message, /No Madeira slot checks could be planned/);
});

test('run summary bounds large failures and keeps untrusted text out of annotations', () => {
  const s = scan();
  s.dates = Array.from({ length: 12 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  s.entries = s.dates.flatMap(d => s.catalog.map(t => ({ r: t.resourceId, d,
    at: s.startedAt, status: 'skipped', error: 'Not queried' })));
  s.catalog[0].name = 'Trail\n::error::injected | <tag>';
  const result = collectionRunStatus(s, { ...health(s), state: 'partial', cooldownUntil: '2026-10-27T12:00:00Z' }, 'success');
  assert.equal(result.failed, true);
  assert.match(result.summary, /Showing 20 of 24/);
  assert.match(result.summary, /Upstream cooldown/);
  assert.doesNotMatch(result.message, /injected|[\r\n]/);
  assert.doesNotMatch(result.summary, /\n::error::|<tag>/);
});

test('only consecutive scans stopped by the same source rejections use a warning', () => {
  const stopped = hour => {
    const s = scan();
    s.startedAt = `2026-10-27T${hour}:00:00.000Z`;
    s.finishedAt = `2026-10-27T${hour}:01:00.000Z`;
    s.id = s.startedAt.replace(/[:.]/g, '-');
    s.stopReason = 'repeated_source_failures';
    s.entries = s.entries.map(({ r, d }, i) => ({ r, d, at: s.finishedAt,
      ...(i ? { status: 'skipped', error: 'Not queried' } : { status: 'error', code: 'UPSTREAM_REJECTED', error: 'Rejected' }) }));
    return s;
  };
  const current = stopped('11'), previous = stopped('10');
  const partial = { ...health(current), state: 'partial', stopReason: current.stopReason };
  const repeat = collectionRunStatus(current, partial, 'success', previous);
  assert.equal(repeat.failed, true, 'coverage remains incomplete');
  assert.equal(repeat.repeatedSourceRejection, true);
  assert.equal(repeat.warning, true);
  assert.match(repeat.summary, /Collection partial: SIMplifica rejections continue/);
  assert.match(repeat.summary, /0\/2 checks verified; 2 failed\/not queried/);

  for (const [candidate, state, outcome, prior] of [
    [current, partial, 'success', undefined],
    [current, partial, 'success', stopped('09')],
    [current, partial, 'success', scan()],
    [current, partial, 'success', current],
    [current, partial, 'failure', previous],
    [current, { ...partial, error: 'COLLECTION_FAILED' }, 'success', previous],
    [current, { ...partial, scanId: previous.id }, 'success', previous],
    [{ ...current, catalogRecheckError: { code: 'UPSTREAM_UNREACHABLE' } }, partial, 'success', previous],
    [{ ...current, entries: [{ ...current.entries[0], code: 'UPSTREAM_TIMEOUT' }, current.entries[1]] }, partial, 'success', previous],
  ]) {
    const result = collectionRunStatus(candidate, state, outcome, prior);
    assert.equal(result.failed, true);
    assert.equal(result.repeatedSourceRejection, false);
    assert.equal(result.warning, false);
  }
});
