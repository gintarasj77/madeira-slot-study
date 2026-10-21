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
  for (const e of scan.entries) {
    const key = pairKey(e);
    if (pairs.has(key) || !ids.has(e.r) || !scan.dates.includes(e.d) || !['ok', 'empty', 'error', 'skipped'].includes(e.status)) throw new Error('Invalid scan entry');
    pairs.add(key);
    if (!Number.isFinite(Date.parse(e.at))) throw new Error('Missing observation time');
    if (['ok', 'empty'].includes(e.status)) {
      if (!Array.isArray(e.s) || (e.status === 'ok') !== (e.s.length > 0)) throw new Error('Invalid slot status');
      const starts = new Set();
      for (const slot of e.s) {
        if (!Array.isArray(slot) || slot.length !== 4 || !slot[0].startsWith(e.d + ' ') || slot[1] <= slot[0] ||
          typeof slot[2] !== 'string' || !Number.isFinite(slot[3]) || slot[3] < 0 || slot[3] > 100 || starts.has(slot[0])) throw new Error('Invalid archived slot');
        starts.add(slot[0]);
        if ([slot[0], slot[1]].some(local => localInstant(local, slot[2]).reason === 'invalid')) throw new Error('Invalid archived local timestamp');
      }
    } else if (e.s !== undefined || typeof e.error !== 'string') throw new Error('Failure masquerading as availability');
  }
  if (scan.entries.length !== scan.catalog.length * scan.dates.length) throw new Error('Incomplete coverage accounting');
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
  return { expected: scan.entries.length, verified: scan.entries.filter(e => ['ok', 'empty'].includes(e.status)).length,
    withSlots: scan.entries.filter(e => e.status === 'ok').length, empty: scan.entries.filter(e => e.status === 'empty').length,
    failed: scan.entries.filter(e => ['error', 'skipped'].includes(e.status)).length,
    slots: scan.entries.reduce((n, e) => n + (e.s?.length || 0), 0) };
}
