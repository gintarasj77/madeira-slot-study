import { assertScan, md, scanCounts } from './study.mjs';

const code = value => /^[A-Z][A-Z0-9_]{0,63}$/.test(value || '') ? value : 'UNKNOWN_ERROR';

export function collectionRunStatus(scan, health, outcome) {
  assertScan(scan);
  const counts = scanCounts(scan);
  const sameScan = health?.scanId === scan.id;
  const failed = outcome !== 'success' || health?.state !== 'complete' || Boolean(health?.error) ||
    !sameScan || counts.failed > 0 || Boolean(scan.catalogError);
  const failures = scan.entries.filter(e => !['ok', 'empty'].includes(e.status));
  const retried = scan.entries.filter(e => e.attempts?.length > 1);
  const recovered = retried.filter(e => ['ok', 'empty'].includes(e.status));
  const extraAttempts = retried.reduce((sum, e) => sum + e.attempts.length - 1, 0);
  const codes = new Map();
  for (const entry of failures) {
    const key = entry.status === 'skipped' ? 'NOT_QUERIED' : code(entry.code);
    codes.set(key, (codes.get(key) || 0) + 1);
  }
  const reasons = [...codes].map(([key, count]) => `${count} ${key}`).join(', ');
  const message = `${failed ? 'Collector needs attention' : 'Collection complete'}: ` +
    `${counts.verified}/${counts.expected} checks verified; ${counts.failed} failed/not queried; ` +
    `${counts.slots} slot observations retained.` + (reasons ? ` ${reasons}.` : '') +
    (retried.length ? ` ${recovered.length}/${retried.length} checks recovered in ${extraAttempts} additional attempts.` : '') +
    (health?.error ? ` Health: ${code(health.error)}.` : '') +
    (!sameScan ? ' Health does not match the retained scan.' : '') +
    (outcome !== 'success' ? ' Collection step did not succeed; retained data may be older.' : '');
  const names = new Map(scan.catalog.map(t => [t.resourceId, t.name]));
  const rows = failures.slice(0, 20).map(e =>
    `| ${md(e.r)} | ${md(names.get(e.r))} | ${md(e.d)} | ${e.status === 'skipped' ? 'NOT_QUERIED' : code(e.code)} |`).join('\n');
  const recoveryRows = recovered.map(e => `| ${md(e.r)} | ${md(names.get(e.r))} | ${md(e.d)} | ${e.attempts.length - 1} | ${md(e.at)} |`).join('\n');
  const summary = `## ${failed ? 'Collection needs attention' : 'Collection complete'}\n\n` +
    `${message}\n\nRetained scan: **${scan.id}**. Source reads: **${scan.startedAt} — ${scan.finishedAt} UTC**.\n\n` +
    `Collection step: **${outcome === 'success' ? 'succeeded' : 'did not succeed'}**. ` +
    `Health matches retained scan: **${sameScan ? 'yes' : 'no'}**.\n\n` +
    (failures.length ? `Successful observations were preserved. Missed checks remain **unknown**, never sold out or filled in retrospectively.\n\n` +
      `| Resource | Trail | Visit date | Failure |\n|---|---|---|---|\n${rows}\n\n` +
      (failures.length > 20 ? `Showing 20 of ${failures.length} missed checks; the full record remains in the archived scan.\n\n` : '') : '') +
    (recovered.length ? `### Recovered automatically\n\nEarlier failed attempts remain in the archive. The successful check's actual response time is used for availability and analysis.\n\n` +
      `| Resource | Trail | Visit date | Additional attempts | Successful response (UTC) |\n|---|---|---|---:|---|\n${recoveryRows}\n\n` : '') +
    (scan.recoverySkippedReason ? `Recovery not attempted: **${md(scan.recoverySkippedReason)}**.\n\n` : '') +
    (scan.catalogError ? `Catalog verification failed: **${code(scan.catalogError.code)}**.\n\n` : '') +
    (scan.stopReason ? `Stop reason: **${md(scan.stopReason)}**.\n\n` : '') +
    (health?.cooldownUntil ? `Upstream cooldown: **${md(health.cooldownUntil)}**.\n\n` : '') +
    `The existing clock handles subsequent scans and respects cooldowns. This status check makes no source requests.\n`;
  return { failed, message, summary };
}
