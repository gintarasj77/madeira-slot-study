import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeScan, readJson, atomicWrite, archiveFiles } from '../lib/archive.mjs';
import { mergeCollectedEvidence } from '../lib/publication.mjs';
import { publish } from '../scripts/publish.mjs';

const scan = hour => ({ v: 1, id: `2026-10-26T${hour}-00-00-000Z`, startedAt: `2026-10-26T${hour}:00:00.000Z`,
  finishedAt: `2026-10-26T${hour}:01:00.000Z`, dates: ['2026-10-26'], catalog: [{ resourceId: '301', name: 'PR 1' }],
  entries: [{ r: '301', d: '2026-10-26', at: `2026-10-26T${hour}:00:05.000Z`, status: 'ok',
    s: [['2026-10-26 12:00:00.000000', '2026-10-26 12:30:00.000000', 'Europe/Lisbon', 42]] }] });

test('publication unions concurrent archives without report conflicts or changed historical bytes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-publication-test-'));
  const source = path.join(temp, 'source'), target = path.join(temp, 'main');
  try {
    await writeScan(source, scan('06')); await writeScan(source, scan('07'));
    await writeScan(target, scan('06')); await writeScan(target, scan('08'));
    await atomicWrite(path.join(source, 'data/collector-health.json'), JSON.stringify({ checkedAt: scan('07').finishedAt, state: 'complete', scanId: scan('07').id }));
    await atomicWrite(path.join(target, 'data/collector-health.json'), JSON.stringify({ checkedAt: scan('08').finishedAt, state: 'complete', scanId: scan('08').id }));
    await atomicWrite(path.join(source, 'reports/SUMMARY.md'), 'older generated report');
    await atomicWrite(path.join(target, 'reports/SUMMARY.md'), 'concurrent report change');
    const old = await fs.readFile((await archiveFiles(target))[0]);
    assert.equal((await mergeCollectedEvidence(source, target)).scans, 3);
    assert.equal((await readJson(path.join(target, 'data/latest.json'))).id, scan('08').id);
    assert.equal((await readJson(path.join(target, 'data/collector-health.json'))).scanId, scan('08').id);
    assert.equal(await fs.readFile(path.join(target, 'reports/SUMMARY.md'), 'utf8'), 'concurrent report change');
    assert.deepEqual(await fs.readFile((await archiveFiles(target))[0]), old);
    assert.equal((await mergeCollectedEvidence(source, target)).scans, 3);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('publication preserves newer collection health and refuses conflicting immutable observations', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-publication-test-'));
  const source = path.join(temp, 'source'), target = path.join(temp, 'main');
  try {
    await writeScan(source, scan('07')); await writeScan(target, scan('06'));
    await atomicWrite(path.join(source, 'data/collector-health.json'), JSON.stringify({ checkedAt: scan('07').finishedAt, state: 'partial' }));
    assert.equal((await mergeCollectedEvidence(source, target)).scans, 2);
    assert.equal((await readJson(path.join(target, 'data/latest.json'))).id, scan('07').id);
    assert.equal((await readJson(path.join(target, 'data/collector-health.json'))).state, 'partial');
    const changed = scan('07'); changed.entries[0].s[0][3] = 0;
    const conflicting = path.join(temp, 'conflicting'); await writeScan(conflicting, changed);
    await assert.rejects(mergeCollectedEvidence(conflicting, target), /conflicting historical scan/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('publication retries a failed fetch and push while preserving the original scan', async () => {
  const savedFlag = process.env.GITHUB_ACTIONS;
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-publication-test-'));
  process.env.GITHUB_ACTIONS = 'true';
  try {
    const record = await writeScan(source, scan('07'));
    const original = await fs.readFile(path.join(source, record.file));
    const calls = [];
    const waits = [];
    const events = [];
    const checkouts = [];
    let fetches = 0;
    let pushes = 0;
    await publish(source, {
      runGit(args, cwd, timeout) {
        calls.push(args[0]);
        if (args[0] === 'fetch') {
          assert.equal(cwd, source);
          assert.equal(timeout, 90_000);
          if (++fetches === 1) throw new Error('Connection failed');
        } else if (args[0] === 'worktree' && args[1] === 'add') {
          checkouts.push(args[3]);
          mkdirSync(path.join(args[3], 'scripts'), { recursive: true });
          for (const script of ['analyse.mjs', 'verify.mjs']) writeFileSync(path.join(args[3], 'scripts', script), '');
        } else if (args[0] === 'diff') {
          return record.file;
        } else if (args[0] === 'push') {
          assert.equal(timeout, 90_000);
          assert.deepEqual(readFileSync(path.join(cwd, record.file)), original);
          if (++pushes === 1) throw new Error('Concurrent push');
        }
        return '';
      },
      delay: async ms => { waits.push(ms); },
      progress: event => events.push(event),
    });
    assert.deepEqual(waits, [15_000, 45_000]);
    assert.deepEqual(calls, ['fetch', 'fetch', 'worktree', 'add', 'diff', 'commit', 'push', 'worktree',
      'fetch', 'worktree', 'add', 'diff', 'commit', 'push', 'worktree']);
    assert.deepEqual(events.map(event => [event.state, event.operation, event.attempt]), [
      ['retrying_publication', 'fetch', 1], ['retrying_publication', 'push', 2], ['published', undefined, 3],
    ]);
    for (const dir of checkouts) assert.equal(existsSync(dir), false);
    assert.deepEqual(await fs.readFile(path.join(source, record.file)), original);

    let failures = 0;
    await assert.rejects(publish(source, {
      runGit(args) {
        assert.deepEqual(args, ['fetch', 'origin', 'main']);
        failures++;
        throw new Error('Connection still unavailable');
      },
      delay: async () => {}, progress: () => {},
    }), /git fetch after 3 attempts/);
    assert.equal(failures, 3);
  } finally {
    if (savedFlag === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = savedFlag;
    await fs.rm(source, { recursive: true, force: true });
  }
});
