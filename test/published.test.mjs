import test from 'node:test';
import assert from 'node:assert/strict';
import { publishEntry } from '../lib/published.mjs';
const entry = { r: '301', d: '2026-11-10', at: '2026-11-01T07:00:00Z', status: 'ok',
  s: [['2026-11-10 07:00:00.000001', '2026-11-10 07:30:00.000000', 'Europe/Lisbon', 42]] };
const trail = { name: 'PR1 | full' };

test('unchanged slots keep a stable payload while fresh checks update the separate index', () => {
  const first = publishEntry(entry, trail), next = publishEntry({ ...entry, at: '2026-11-01T08:00:00Z' }, trail);
  assert.deepEqual(first.profile, next.profile);
  assert.notEqual(first.index.sourceFetchedAt, next.index.sourceFetchedAt);
  assert.equal(first.profile.slots[0][0], entry.s[0][0]);
  assert.equal(first.index.profileHash, first.profile.profileHash);
  const changed = structuredClone(entry); changed.s[0][3] = 41;
  assert.notEqual(first.profile.profileHash, publishEntry(changed, trail).profile.profileHash);
});

test('failed checks never label an old payload fresh, and daily probes have explicit cadence', () => {
  const failure = publishEntry({ ...entry, status: 'error', s: undefined, error: 'Unavailable' }, trail);
  assert.equal(failure.profile, null); assert.equal(failure.index.profileHash, undefined);
  assert.equal(failure.index.staleAfterMinutes, 90);
  assert.equal(publishEntry(entry, trail, 'daily').index.staleAfterMinutes, 1560);
  const empty = publishEntry({ ...entry, status: 'empty', s: [] }, trail);
  assert.equal(empty.profile.status, 'no_slots_returned'); assert.equal(empty.index.status, 'empty');
});
