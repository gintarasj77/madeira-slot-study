import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeScan, readJson, atomicWrite, archiveFiles } from '../lib/archive.mjs';
import { mergeCollectedEvidence } from '../lib/publication.mjs';

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
