import test from 'node:test';
import assert from 'node:assert/strict';
import { compareScan, updateComparisonState } from '../lib/changes.mjs';
const entry = (p, at = '2026-11-01T07:00:00Z') => ({ r: '301', d: '2026-11-10', at, status: 'ok',
  s: [['2026-11-10 07:00:00.000000', '2026-11-10 07:30:00.000000', 'Europe/Lisbon', p]] });

test('first scan is baseline, with no fictitious releases or sell-outs', () => {
  assert.deepEqual(compareScan({ entries: [entry(0)] }, new Map(), new Map()), []);
});
test('notification report preserves sold-out, reopen and large-drop events', () => {
  for (const [from, to, type] of [[1, 0, 'non_resident_sold_out'], [0, 1, 'non_resident_reopened'], [50, 40, 'non_resident_drop']]) {
    const good = new Map(), attempts = new Map(); updateComparisonState({ entries: [entry(from)] }, good, attempts);
    const changes = compareScan({ entries: [entry(to, '2026-11-01T08:00:00Z')] }, good, attempts);
    assert.equal(changes[0].type, type); assert.equal(changes[0].gap, false); assert.equal(changes[0].from, from);
  }
});
test('missing data raises uncertainty and recovery keeps the real comparison gap', () => {
  const good = new Map(), attempts = new Map(); updateComparisonState({ entries: [entry(80)] }, good, attempts);
  const failed = { ...entry(), at: '2026-11-01T08:00:00Z', status: 'error', error: 'Unavailable' }; delete failed.s;
  assert.equal(compareScan({ entries: [failed] }, good, attempts)[0].type, 'data_unavailable');
  updateComparisonState({ entries: [failed] }, good, attempts);
  assert.equal(compareScan({ entries: [failed] }, good, attempts).length, 0);
  const changes = compareScan({ entries: [entry(0, '2026-11-01T09:00:00Z')] }, good, attempts);
  assert.deepEqual(changes.map(c => c.type), ['data_recovered', 'non_resident_sold_out']);
  assert.ok(changes.every(c => c.gap));
});
test('empty arrays mean unknown; schedule changes do not match different intervals', () => {
  const good = new Map(), attempts = new Map(); updateComparisonState({ entries: [entry(80)] }, good, attempts);
  const empty = { ...entry(), status: 'empty', s: [] };
  assert.equal(compareScan({ entries: [empty] }, good, attempts)[0].type, 'slots_no_longer_returned');
  const different = entry(0); different.s[0][1] = '2026-11-10 08:00:00.000000';
  assert.deepEqual(compareScan({ entries: [different] }, good, attempts).map(c => c.type), ['new_slot_returned', 'slot_no_longer_returned']);
  assert.equal(compareScan({ entries: [entry(79)] }, good, attempts).length, 0);
});

test('within-scan recovery preserves uncertain timing without a spurious outage notification', () => {
  const good = new Map(), attempts = new Map(); updateComparisonState({ entries: [entry(80)] }, good, attempts);
  const recovered = { ...entry(0, '2026-11-01T08:05:00Z'), attempts: [
    { status: 'error', at: '2026-11-01T08:00:00Z', code: 'UPSTREAM_TIMEOUT' },
    { status: 'ok', at: '2026-11-01T08:05:00Z' }] };
  const changes = compareScan({ entries: [recovered] }, good, attempts);
  assert.deepEqual(changes.map(c => c.type), ['non_resident_sold_out']);
  assert.equal(changes[0].gap, true); assert.equal(changes[0].at, recovered.at);
});
