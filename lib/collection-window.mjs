// A queued duplicate must not turn an already verified hourly scan into extra source traffic.
export function recentCompleteScan(scan, health, now, minimumMinutes = 55) {
  if (!scan || health?.state !== 'complete' || health.error || health.scanId !== scan.id || scan.stopReason || scan.catalogError ||
    !Array.isArray(scan.catalog) || !scan.catalog.length || !Array.isArray(scan.dates) || !scan.dates.length ||
    !Array.isArray(scan.entries) || scan.entries.length !== scan.catalog.length * scan.dates.length ||
    scan.entries.some(e => !['ok', 'empty'].includes(e.status))) return false;
  const start = Date.parse(scan.startedAt), end = Date.parse(scan.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= now && now - start < minimumMinutes * 60000;
}
