import test from 'node:test';
import assert from 'node:assert/strict';
import { recentCompleteScan } from '../lib/collection-window.mjs';

const scan = { id: 'test', startedAt: '2026-10-21T09:00:00Z', finishedAt: '2026-10-21T09:17:00Z',
  catalog: [{ resourceId: '301' }], dates: ['2026-10-26'], entries: [{ status: 'ok' }] };
const health = { state: 'complete', scanId: scan.id };
const at = text => Date.parse('2026-10-21T' + text + 'Z');

test('queued or manual duplicates skip source reads until the next collection window', () => {
  assert.equal(recentCompleteScan(scan, health, at('09:20:00')), true);
  assert.equal(recentCompleteScan(scan, health, at('09:54:59')), true);
  assert.equal(recentCompleteScan(scan, health, at('09:55:00')), false);
  const unchanged = JSON.stringify({ scan, health });
  recentCompleteScan(scan, health, at('09:30:00'));
  assert.equal(JSON.stringify({ scan, health }), unchanged);
});

test('partial, unverified, corrupt and future-dated scans are never treated as a fresh success', () => {
  for (const candidate of [null, { ...scan, stopReason: 'rate_limited' }, { ...scan, catalogError: {} },
    { ...scan, entries: [] }, { ...scan, entries: [{ status: 'error' }] }, { ...scan, startedAt: 'bad' },
    { ...scan, finishedAt: '2026-10-21T10:00:00Z' }]) {
    assert.equal(recentCompleteScan(candidate, health, at('09:30:00')), false);
  }
  for (const state of [{ state: 'partial', scanId: 'test' }, { ...health, error: 'FAILED' }, { ...health, scanId: 'other' }, null]) {
    assert.equal(recentCompleteScan(scan, state, at('09:30:00')), false);
  }
  assert.equal(recentCompleteScan({ ...scan, entries: [{ status: 'empty' }] }, health, at('09:30:00')), true);
});
