import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../lib/collector.mjs';
import { validateConfig, scanCounts, calendarDate } from '../lib/study.mjs';
import { readJson, atomicWrite, archiveSize, writeScan } from '../lib/archive.mjs';
import { recentCompleteScan } from '../lib/collection-window.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = validateConfig(await readJson(path.join(root, 'study.json')));
const data = path.join(root, 'data');
await fs.mkdir(data, { recursive: true });
const lock = path.join(data, '.collector.lock');
let handle;
try { handle = await fs.open(lock, 'wx'); }
catch (e) { if (e.code === 'EEXIST') throw new Error('Another collector is running; refusing duplicate source traffic.'); throw e; }
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  const previous = await readJson(path.join(data, 'latest.json'), null);
  const priorHealth = await readJson(path.join(data, 'collector-health.json'), null);
  const today = calendarDate(Date.now(), config.calendarTimezone);
  if (previous?.cooldownUntil && Date.parse(previous.cooldownUntil) > Date.now()) {
    await atomicWrite(path.join(data, 'collector-health.json'), JSON.stringify({ ...priorHealth,
      checkedAt: new Date().toISOString(), state: 'cooldown', cooldownUntil: previous.cooldownUntil }) + '\n');
    console.log(JSON.stringify({ state: 'cooldown', until: previous.cooldownUntil }));
  } else if (recentCompleteScan(previous, priorHealth, Date.now(), config.minimumScanIntervalMinutes ?? 55)) {
    // Keep original observation timestamps and health; this was not a new source read.
    console.log(JSON.stringify({ state: 'recent_complete_scan', scanId: previous.id, sourceFinishedAt: previous.finishedAt }));
  } else if (await archiveSize(root) >= config.maximumArchiveMiB * 1024 * 1024) {
    await atomicWrite(path.join(data, 'collector-health.json'), JSON.stringify({ checkedAt: new Date().toISOString(), error: 'ARCHIVE_SIZE_GUARD', message: 'Collection stopped without deleting history. Storage review required.' }) + '\n');
    process.exitCode = 1;
  } else {
    const effectiveConfig = priorHealth?.lastCompletedLongRangeDate === today ? { ...config, longRangeOffsetsDays: [] } : config;
    const scan = await collect(effectiveConfig, { priorCatalog: previous?.catalog || [], stopRequested: () => stopping,
      checkpoint: scan => atomicWrite(path.join(data, '.checkpoint.json'), JSON.stringify(scan) + '\n'),
      progress: value => console.log(JSON.stringify(value)) });
    const record = await writeScan(root, scan);
    await atomicWrite(path.join(data, 'collector-health.json'), JSON.stringify({ checkedAt: scan.finishedAt,
      state: scanCounts(scan).failed || scan.catalogError ? 'partial' : 'complete', scanId: scan.id, stopReason: scan.stopReason,
      cooldownUntil: scan.cooldownUntil,
      lastCompletedLongRangeDate: scan.sentinelDates?.length && !scan.catalogError &&
        scan.entries.filter(e => scan.sentinelDates.includes(e.d)).every(e => ['ok', 'empty'].includes(e.status))
        ? today : priorHealth?.lastCompletedLongRangeDate || null }) + '\n');
    await fs.rm(path.join(data, '.checkpoint.json'), { force: true });
    console.log(JSON.stringify({ archived: record.file, ...scanCounts(scan), stopReason: scan.stopReason }));
  }
} catch {
  // A disk/process failure must not leave an older healthy status masquerading as a new scan.
  const partial = await readJson(path.join(data, '.checkpoint.json'), null);
  if (partial) {
    partial.finishedAt = new Date().toISOString();
    partial.stopReason = 'collector_interrupted';
    for (const entry of partial.entries.filter(e => e.status === 'skipped')) entry.error = 'Not queried: collector interrupted.';
    await writeScan(root, partial);
    await atomicWrite(path.join(data, 'collector-health.json'), JSON.stringify({ checkedAt: partial.finishedAt,
      state: 'partial', error: 'COLLECTOR_INTERRUPTED', scanId: partial.id, stopReason: partial.stopReason }) + '\n');
    await fs.rm(path.join(data, '.checkpoint.json'), { force: true });
  } else await atomicWrite(path.join(data, 'collector-health.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
    state: 'error', error: 'COLLECTOR_FAILED', message: 'No new complete scan; prior observations retained.' }) + '\n');
  console.error('Collection failed; available checkpoint evidence and prior history were preserved.');
  process.exitCode = 1;
} finally {
  await handle.close();
  await fs.rm(lock, { force: true });
}
