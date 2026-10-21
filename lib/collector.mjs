import { getTrails, fetchIntervals, normalizeSlots, validateQuery, ProxyError } from '../src/upstream.mjs';
import { rollingDates, packSlots, validateConfig } from './study.mjs';

export function safeError(error) {
  return error instanceof ProxyError ? { code: error.code, error: error.message, retryAfter: error.retryAfter || null }
    : { code: 'COLLECTOR_ERROR', error: 'The collector could not complete this observation.', retryAfter: null };
}

export async function collect(config, { fetcher = fetch, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)),
  checkpoint = async () => {}, progress = () => {}, priorCatalog = [], stopRequested = () => false } = {}) {
  validateConfig(config);
  const started = now(), startedAt = new Date(started).toISOString();
  const scan = { v: 1, id: startedAt.replace(/[:.]/g, '-'), startedAt, finishedAt: startedAt,
    calendarTimezone: config.calendarTimezone, dates: rollingDates(started, config.horizonDays, config.calendarTimezone),
    catalog: [], entries: [], cooldownUntil: null, stopReason: null };
  scan.mainDates = [...scan.dates];
  scan.sentinelDates = (config.longRangeOffsetsDays || []).map(days =>
    new Date(Date.parse(scan.dates[0] + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10));
  scan.dates.push(...scan.sentinelDates);
  try { scan.catalog = await getTrails(fetcher); }
  catch (e) {
    scan.catalogError = safeError(e);
    scan.catalog = priorCatalog;
    scan.stopReason = 'catalog_unverified';
    if (e.retryAfter) scan.cooldownUntil = new Date(now() + e.retryAfter * 1000).toISOString();
  }
  if (scan.catalog.length > 100) throw new Error('Unexpected catalog size; manual schema review required');
  const jobs = scan.dates.flatMap(d => scan.catalog.map(t => ({ r: t.resourceId, d })));
  scan.entries = jobs.map(e => ({ ...e, at: startedAt, status: 'skipped', error: 'Not queried yet.' }));
  await checkpoint(scan);
  let cursor = 0, complete = 0, failures = 0, nextStart = now(), stopped = Boolean(scan.stopReason), checkpointQueue = Promise.resolve();
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++, job = jobs[index];
      const slot = Math.max(now(), nextStart);
      nextStart = slot + config.minimumRequestSpacingMs;
      if (!stopped) await sleep(Math.max(0, slot - now()));
      if (stopRequested() || now() - started > config.maximumScanMinutes * 60000) {
        stopped = true; scan.stopReason ||= 'scan_time_budget_or_shutdown';
      }
      if (stopped) {
        scan.entries[index] = { ...job, at: new Date(now()).toISOString(), status: 'skipped', error: `Not queried: ${scan.stopReason}.` };
        complete++;
        continue;
      }
      const begin = now();
      try {
        const query = validateQuery(new URL('https://local.invalid/?' + new URLSearchParams({ resourceId: job.r, date: job.d })));
        const slots = normalizeSlots(await fetchIntervals(query, fetcher), job.d);
        scan.entries[index] = { ...job, at: new Date(now()).toISOString(), durationMs: now() - begin,
          status: slots.length ? 'ok' : 'empty', s: packSlots(slots) };
        failures = 0;
      } catch (e) {
        scan.entries[index] = { ...job, at: new Date(now()).toISOString(), durationMs: now() - begin, status: 'error', ...safeError(e) };
        if (e.status === 429 || ++failures >= config.maximumConsecutiveFailures || e.code === 'UPSTREAM_SCHEMA_CHANGED') {
          stopped = true;
          scan.stopReason = e.status === 429 ? 'rate_limited' : e.code === 'UPSTREAM_SCHEMA_CHANGED' ? 'schema_changed' : 'repeated_source_failures';
          if (e.status === 429) scan.cooldownUntil = new Date(Math.max(Date.parse(scan.cooldownUntil || '') || 0,
            now() + (e.retryAfter || 60) * 1000)).toISOString();
        }
      }
      complete++;
      if (complete % 20 === 0) {
        progress({ completed: complete, total: jobs.length, failures: scan.entries.filter(e => e.status === 'error').length });
        // Serialize file writes when concurrent requests finish together.
        const copy = structuredClone(scan);
        checkpointQueue = checkpointQueue.then(() => checkpoint(copy));
        await checkpointQueue;
      }
    }
  }
  await Promise.all(Array.from({ length: config.concurrency }, worker));
  await checkpointQueue;
  scan.finishedAt = new Date(now()).toISOString();
  await checkpoint(scan);
  return scan;
}
