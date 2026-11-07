import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const slotKey = slot => JSON.stringify(slot.slice(0, 3));
export const pairKey = entry => `${entry.r}/${entry.d}`;
export const md = value => String(value).replace(/[\\`*_[\]<>|]/g, '\\$&').replace(/[\r\n]+/g, ' ');

export function validateConfig(config) {
  if (config.island !== 'Madeira') throw new Error('Invalid config: island must be Madeira');
  if (!Number.isInteger(config.minimumScanIntervalMinutes ?? 55) || (config.minimumScanIntervalMinutes ?? 55) < 50 ||
    (config.minimumScanIntervalMinutes ?? 55) > 60) throw new Error('Invalid config: minimumScanIntervalMinutes');
  for (const [key, min, max] of [['horizonDays', 1, 60], ['minimumRequestSpacingMs', 750, 10000],
    ['concurrency', 1, 3], ['maximumScanMinutes', 1, 40], ['maximumConsecutiveFailures', 1, 5],
    ['expectedIntervalMinutes', 60, 1440], ['staleAfterMinutes', 90, 2880], ['maximumArchiveMiB', 1, 750]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid config: ${key}`);
  }
  new Intl.DateTimeFormat('en', { timeZone: config.calendarTimezone });
  const offsets = config.longRangeOffsetsDays || [];
  if (!Array.isArray(offsets) || offsets.length > 6 || new Set(offsets).size !== offsets.length ||
    offsets.some(d => !Number.isInteger(d) || d < config.horizonDays || d > 180)) throw new Error('Invalid long-range offsets');
  const retryDelays = config.transientRetryDelaysMs ?? [];
  if (!Array.isArray(retryDelays) || retryDelays.length > 2 || retryDelays.some((delay, i) =>
    !Number.isInteger(delay) || delay < 30000 || delay > 300000 || (i > 0 && delay <= retryDelays[i - 1]))) {
    throw new Error('Invalid transient retry delays');
  }
  if (!Number.isInteger(config.maximumRetryChecks ?? 20) || (config.maximumRetryChecks ?? 20) < 1 ||
    (config.maximumRetryChecks ?? 20) > 20) throw new Error('Invalid maximumRetryChecks');
  return config;
}

export function calendarDate(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function rollingDates(at, days, timezone) {
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('Horizon must contain 1–60 days');
  const start = Date.parse(calendarDate(at, timezone) + 'T00:00:00Z');
  // Calendar arithmetic, not elapsed-time arithmetic in the study timezone.
  return Array.from({ length: days }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}

export function packSlots(slots) {
  return slots.map(s => [s.begin.local, s.end.local, s.begin.timezone, s.nonResident]);
}

function assertSlotRows(slots, date, allowUnknown = false) {
  const starts = new Set();
  for (const slot of slots) {
    if (!Array.isArray(slot) || slot.length !== 4 || typeof slot[0] !== 'string' || typeof slot[1] !== 'string' ||
      !slot[0].startsWith(date + ' ') || slot[1] <= slot[0] || typeof slot[2] !== 'string' ||
      (!(allowUnknown && slot[3] === null) && (!Number.isFinite(slot[3]) || slot[3] < 0 || slot[3] > 100)) ||
      starts.has(slot[0])) throw new Error('Invalid archived slot');
    starts.add(slot[0]);
    if ([slot[0], slot[1]].some(local => localInstant(local, slot[2]).reason === 'invalid')) throw new Error('Invalid archived local timestamp');
  }
}

export function assertScan(scan) {
  if (scan?.v !== 1 || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(scan.id) ||
    !Number.isFinite(Date.parse(scan.startedAt)) || !Number.isFinite(Date.parse(scan.finishedAt)) ||
    !Array.isArray(scan.catalog) || !Array.isArray(scan.entries) || !Array.isArray(scan.dates)) throw new Error('Invalid scan envelope');
  if (scan.id !== scan.startedAt.replace(/[:.]/g, '-') || Date.parse(scan.finishedAt) < Date.parse(scan.startedAt) ||
    new Set(scan.dates).size !== scan.dates.length || !scan.dates.length ||
    scan.dates.some(d => !/^20\d{2}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) throw new Error('Invalid scan calendar or identifier');
  const ids = new Set(), pairs = new Set();
  for (const trail of scan.catalog) {
    if (!/^[1-9]\d{0,8}$/.test(trail.resourceId) || typeof trail.name !== 'string' || ids.has(trail.resourceId)) throw new Error('Invalid scan catalog');
    ids.add(trail.resourceId);
  }
  if (scan.catalogAttempts !== undefined) {
    if (!Array.isArray(scan.catalogAttempts) || !scan.catalogAttempts.length || scan.catalogAttempts.length > 3) {
      throw new Error('Invalid catalog retry history');
    }
    let previousAt = Date.parse(scan.startedAt);
    for (const [i, attempt] of scan.catalogAttempts.entries()) {
      const at = Date.parse(attempt.at);
      if (!Number.isFinite(at) || at < previousAt || at > Date.parse(scan.finishedAt) ||
        !Number.isFinite(attempt.durationMs) || attempt.durationMs < 0 || attempt.s !== undefined ||
        !['ok', 'error'].includes(attempt.status) || (i < scan.catalogAttempts.length - 1 && attempt.status !== 'error') ||
        (attempt.status === 'error' && (typeof attempt.error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(attempt.code))) ||
        (attempt.status === 'ok' && (attempt.error !== undefined || attempt.code !== undefined))) {
        throw new Error('Invalid catalog retry attempt');
      }
      previousAt = at;
    }
    const last = scan.catalogAttempts.at(-1);
    if ((last.status === 'ok' && scan.catalogError) || (last.status === 'error' && (!scan.catalogError ||
      ['code', 'error', 'retryAfter', 'upstreamStatus'].some(k => last[k] !== scan.catalogError[k])))) {
      throw new Error('Catalog retry history does not match catalog health');
    }
  }
  for (const e of scan.entries) {
    const key = pairKey(e);
    if (pairs.has(key) || !ids.has(e.r) || !scan.dates.includes(e.d) || !['ok', 'empty', 'unreported', 'error', 'skipped'].includes(e.status)) throw new Error('Invalid scan entry');
    pairs.add(key);
    if (!Number.isFinite(Date.parse(e.at))) throw new Error('Missing observation time');
    if (['ok', 'empty'].includes(e.status)) {
      if (!Array.isArray(e.s) || (e.status === 'ok') !== (e.s.length > 0)) throw new Error('Invalid slot status');
      assertSlotRows(e.s, e.d);
    } else if (e.s !== undefined || typeof e.error !== 'string') throw new Error('Failure masquerading as availability');
    if (e.status === 'unreported') {
      if (e.code !== 'UPSTREAM_CATEGORY_UNAVAILABLE' || e.sourceTitle !== '0 vagas disponíveis' ||
        !Array.isArray(e.sourceSlots) || !e.sourceSlots.length || !e.sourceSlots.some(s => Array.isArray(s) && s[3] === null)) {
        throw new Error('Invalid unreported category evidence');
      }
      assertSlotRows(e.sourceSlots, e.d, true);
    } else if (e.sourceSlots !== undefined || e.sourceTitle !== undefined) throw new Error('Unexpected unreported category evidence');
    if (e.attempts !== undefined) {
      if (!Array.isArray(e.attempts) || e.attempts.length < 2 || e.attempts.length > 3) throw new Error('Invalid retry history');
      let previousAt = -Infinity;
      for (const [i, attempt] of e.attempts.entries()) {
        const at = Date.parse(attempt.at);
        if (!Number.isFinite(at) || at < previousAt || at > Date.parse(e.at) || !Number.isFinite(attempt.durationMs) ||
          attempt.durationMs < 0 || attempt.s !== undefined || !['ok', 'empty', 'unreported', 'error'].includes(attempt.status) ||
          (i < e.attempts.length - 1 && attempt.status !== 'error') ||
          (attempt.status === 'error' && (typeof attempt.error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(attempt.code))) ||
          (attempt.status === 'unreported' && (attempt.code !== 'UPSTREAM_CATEGORY_UNAVAILABLE' || typeof attempt.error !== 'string')) ||
          (['ok', 'empty'].includes(attempt.status) && (attempt.code !== undefined || attempt.error !== undefined))) {
          throw new Error('Invalid retry attempt');
        }
        previousAt = at;
      }
      const last = e.attempts.at(-1);
      if (['at', 'durationMs', 'status', 'code', 'error', 'retryAfter', 'upstreamStatus'].some(k => last[k] !== e[k])) {
        throw new Error('Retry history does not match the final observation');
      }
    }
  }
  if (scan.entries.length !== scan.catalog.length * scan.dates.length) throw new Error('Incomplete coverage accounting');
  if (scan.catalogWithdrawal !== undefined) {
    const w = scan.catalogWithdrawal;
    if (!Array.isArray(w.initialCatalog) || !Array.isArray(w.entries) || !w.entries.length ||
      !Number.isFinite(Date.parse(w.checkedAt)) || Date.parse(w.checkedAt) < Date.parse(scan.startedAt) ||
      Date.parse(w.checkedAt) > Date.parse(scan.finishedAt) ||
      w.entries.some(e => ids.has(e.r) || e.status !== 'error' || e.code !== 'UPSTREAM_REJECTED' || e.s !== undefined)) {
      throw new Error('Invalid catalog withdrawal evidence');
    }
    const original = { ...scan, catalog: w.initialCatalog, entries: [...scan.entries, ...w.entries] };
    delete original.catalogWithdrawal;
    assertScan(original); // Every original resource/date and rejection remains accounted for.
  }
  return scan;
}

const formatters = new Map(), instantCache = new Map();
function partsAt(at, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  return Object.fromEntries(formatters.get(zone).formatToParts(new Date(at)).map(p => [p.type, p.value]));
}

export function localInstant(local, zone) {
  const key = local + '|' + zone;
  if (instantCache.has(key)) return instantCache.get(key);
  let result;
  try {
    if (!/^20\d{2}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(local)) throw new Error();
    const naive = Date.parse(local.replace(' ', 'T').slice(0, 23) + 'Z');
    if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 10) !== local.slice(0, 10)) throw new Error();
    const candidates = new Set();
    for (const shift of [-36, -12, 0, 12, 36]) {
      const at = Math.floor((naive + shift * 3600000) / 1000) * 1000;
      const p = partsAt(at, zone);
      const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at;
      const candidate = naive - offset, c = partsAt(candidate, zone);
      if (`${c.year}-${c.month}-${c.day} ${c.hour}:${c.minute}:${c.second}` === local.slice(0, 19)) candidates.add(candidate);
    }
    result = candidates.size === 1 ? { at: [...candidates][0] } : { at: null, reason: candidates.size ? 'ambiguous' : 'nonexistent' };
  } catch { result = { at: null, reason: 'invalid' }; }
  if (instantCache.size > 200000) instantCache.clear();
  instantCache.set(key, result);
  return result;
}

export function scanCounts(scan) {
  const unreported = scan.entries.filter(e => e.status === 'unreported');
  return { expected: scan.entries.length, verified: scan.entries.filter(e => ['ok', 'empty'].includes(e.status)).length,
    withSlots: scan.entries.filter(e => e.status === 'ok').length, empty: scan.entries.filter(e => e.status === 'empty').length,
    failed: scan.entries.filter(e => ['error', 'skipped'].includes(e.status)).length,
    slots: scan.entries.reduce((n, e) => n + (e.s?.length || 0), 0),
    ...(unreported.length ? { unreported: unreported.length,
      unreportedSlots: unreported.reduce((n, e) => n + e.sourceSlots.filter(s => s[3] === null).length, 0) } : {}) };
}
