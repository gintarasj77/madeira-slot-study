import { getTrails, fetchIntervals, normalizeSlots, validateQuery, ProxyError } from '../src/upstream.mjs';
import { rollingDates, packSlots, validateConfig } from './study.mjs';
import { selectCatalog } from './scope.mjs';

export function safeError(error) {
  return error instanceof ProxyError ? { code: error.code, error: error.message, retryAfter: error.retryAfter || null,
    ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}) }
    : { code: 'COLLECTOR_ERROR', error: 'The collector could not complete this observation.', retryAfter: null };
}

const retryable = entry => entry.status === 'error' &&
  (['UPSTREAM_TIMEOUT', 'UPSTREAM_UNREACHABLE'].includes(entry.code) ||
    (entry.code === 'UPSTREAM_HTTP_ERROR' && [408, 500, 502, 503, 504].includes(entry.upstreamStatus))) && !entry.retryAfter;
const attemptSummary = entry => Object.fromEntries(['at', 'durationMs', 'status', 'code', 'error', 'retryAfter', 'upstreamStatus']
  .filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));

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
  try { Object.assign(scan, selectCatalog(await getTrails(fetcher), config.island)); }
  catch (e) {
    scan.catalogError = safeError(e);
    Object.assign(scan, selectCatalog(priorCatalog, config.island));
    scan.stopReason = 'catalog_unverified';
    if (e.retryAfter) scan.cooldownUntil = new Date(now() + e.retryAfter * 1000).toISOString();
  }
  if (scan.catalog.length > 100) throw new Error('Unexpected catalog size; manual schema review required');
  const jobs = scan.dates.flatMap(d => scan.catalog.map(t => ({ r: t.resourceId, d })));
  scan.entries = jobs.map(e => ({ ...e, at: startedAt, status: 'skipped', error: 'Not queried yet.' }));
  await checkpoint(scan);
  let cursor = 0, complete = 0, failures = 0, nextStart = now(), stopped = Boolean(scan.stopReason), checkpointQueue = Promise.resolve();
  async function saveCheckpoint() {
    const copy = structuredClone(scan);
    checkpointQueue = checkpointQueue.then(() => checkpoint(copy));
    await checkpointQueue;
  }
  function stopIfNeeded() {
    if (stopRequested() || now() - started >= config.maximumScanMinutes * 60000) {
      stopped = true; scan.stopReason ||= 'scan_time_budget_or_shutdown';
    }
    return stopped;
  }
  function handleFailure(error) {
    const backoff = error.status === 429 || Boolean(error.retryAfter);
    if (backoff || ++failures >= config.maximumConsecutiveFailures || error.code === 'UPSTREAM_SCHEMA_CHANGED') {
      stopped = true;
      scan.stopReason = backoff ? (error.status === 429 ? 'rate_limited' : 'source_backoff')
        : error.code === 'UPSTREAM_SCHEMA_CHANGED' ? 'schema_changed' : 'repeated_source_failures';
      if (backoff) scan.cooldownUntil = new Date(Math.max(Date.parse(scan.cooldownUntil || '') || 0,
        now() + (error.retryAfter || 60) * 1000)).toISOString();
    }
  }
  async function readEntry(job, begin) {
    const query = validateQuery(new URL('https://local.invalid/?' + new URLSearchParams({ resourceId: job.r, date: job.d })));
    const slots = normalizeSlots(await fetchIntervals(query, fetcher), job.d);
    return { ...job, at: new Date(now()).toISOString(), durationMs: now() - begin,
      status: slots.length ? 'ok' : 'empty', s: packSlots(slots) };
  }
  const failedEntry = (job, begin, error) => ({ ...job, at: new Date(now()).toISOString(), durationMs: now() - begin,
    status: 'error', ...safeError(error) });
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++, job = jobs[index];
      const slot = Math.max(now(), nextStart);
      nextStart = slot + config.minimumRequestSpacingMs;
      if (!stopped) await sleep(Math.max(0, slot - now()));
      if (stopIfNeeded()) {
        scan.entries[index] = { ...job, at: new Date(now()).toISOString(), status: 'skipped', error: `Not queried: ${scan.stopReason}.` };
        complete++;
        continue;
      }
      const begin = now();
      try {
        scan.entries[index] = await readEntry(job, begin);
        failures = 0;
      } catch (e) {
        scan.entries[index] = failedEntry(job, begin, e);
        handleFailure(e);
      }
      complete++;
      if (complete % 20 === 0) {
        progress({ completed: complete, total: jobs.length, failures: scan.entries.filter(e => e.status === 'error').length });
        await saveCheckpoint();
      }
    }
  }
  await Promise.all(Array.from({ length: config.concurrency }, worker));
  await checkpointQueue;
  await saveCheckpoint();
  const retryDelays = config.transientRetryDelaysMs || [];
  let pending = scan.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => retryable(entry)).map(x => x.index);
  if (!stopped && retryDelays.length && pending.length > (config.maximumRetryChecks ?? 20)) {
    scan.recoverySkippedReason = 'too_many_transient_failures';
  } else if (!stopped) {
    for (const [round, delay] of retryDelays.entries()) {
      if (!pending.length || stopIfNeeded()) break;
      const readyAt = now() + delay;
      // Check shutdown/budget during the backoff; never sleep through cancellation.
      while (now() < readyAt && !stopIfNeeded()) await sleep(Math.min(1000, readyAt - now()));
      if (stopIfNeeded()) break;
      for (const index of pending) {
        if (stopIfNeeded()) break;
        const slot = Math.max(now(), nextStart);
        nextStart = slot + config.minimumRequestSpacingMs;
        await sleep(Math.max(0, slot - now()));
        if (stopIfNeeded()) break;
        const previous = scan.entries[index], job = jobs[index], begin = now();
        let entry;
        try { entry = await readEntry(job, begin); failures = 0; }
        catch (e) { entry = failedEntry(job, begin, e); handleFailure(e); }
        scan.entries[index] = { ...entry, attempts: [...(previous.attempts || [attemptSummary(previous)]), attemptSummary(entry)] };
        await saveCheckpoint();
        progress({ phase: 'recovery', round: round + 1, resourceId: job.r, date: job.d, status: entry.status });
      }
      pending = pending.filter(index => retryable(scan.entries[index]));
    }
  }
  scan.finishedAt = new Date(now()).toISOString();
  await checkpoint(scan);
  return scan;
}
