import { assertScan, md, scanCounts } from './study.mjs';

const code = value => /^[A-Z][A-Z0-9_]{0,63}$/.test(value || '') ? value : 'UNKNOWN_ERROR';

function stoppedBySourceRejections(scan) {
  if (scan?.stopReason !== 'repeated_source_failures' || scan.catalogError || scan.catalogRecheckError || scan.cooldownUntil) return false;
  const errors = scan.entries.filter(entry => entry.status === 'error');
  return errors.length > 0 && errors.every(entry => entry.code === 'UPSTREAM_REJECTED');
}

export function collectionRunStatus(scan, health, outcome, previousScan) {
  assertScan(scan);
  const counts = scanCounts(scan);
  const sameScan = health?.scanId === scan.id;
  const failed = outcome !== 'success' || health?.state !== 'complete' || Boolean(health?.error) ||
    !sameScan || counts.expected === 0 || counts.failed > 0 || Boolean(scan.catalogError) || Boolean(scan.stopReason);
  const start = Date.parse(scan.startedAt);
  const repeatedSourceRejection = outcome === 'success' && sameScan && health.state === 'partial' &&
    health.stopReason === scan.stopReason && !health.error && !health.cooldownUntil &&
    stoppedBySourceRejections(scan) && stoppedBySourceRejections(previousScan) &&
    Date.parse(previousScan.finishedAt) < start && start - Date.parse(previousScan.startedAt) <= 90 * 60_000;
  const failures = scan.entries.filter(e => !['ok', 'empty'].includes(e.status));
  const retried = scan.entries.filter(e => e.attempts?.length > 1);
  const recovered = retried.filter(e => ['ok', 'empty'].includes(e.status));
  const extraAttempts = retried.reduce((sum, e) => sum + e.attempts.length - 1, 0);
  const catalogRecovered = scan.catalogAttempts?.at(-1)?.status === 'ok';
  const codes = new Map();
  for (const entry of failures) {
    const key = entry.status === 'skipped' ? 'NOT_QUERIED' : code(entry.code);
    codes.set(key, (codes.get(key) || 0) + 1);
  }
  const reasons = [...codes].map(([key, count]) => `${count} ${key}`).join(', ');
  const label = repeatedSourceRejection ? 'Collection partial: SIMplifica rejections continue' :
    failed ? 'Collector needs attention' : counts.unreported ? 'Collection complete with source data unavailable' : 'Collection complete';
  const message = `${label}: ` +
    `${counts.verified}/${counts.expected} checks verified; ${counts.failed} failed/not queried; ` +
    `${counts.slots} slot observations retained.` +
    (counts.expected === 0 ? ' No Madeira slot checks could be planned.' : '') +
    (counts.unreported ? ` ${counts.unreported} responses omit the non-resident category (${counts.unreportedSlots} unknown slots); no percentage inferred.` : '') +
    (reasons ? ` ${reasons}.` : '') +
    (retried.length ? ` ${recovered.length}/${retried.length} checks recovered in ${extraAttempts} additional attempts.` : '') +
    (catalogRecovered ? ` Trail list recovered after ${scan.catalogAttempts.length - 1} additional attempts.` : '') +
    (scan.catalogError ? ` Trail-list failure: ${code(scan.catalogError.code)}.` : '') +
    (scan.catalogWithdrawal ? ` ${scan.catalogWithdrawal.entries.length} rejected checks belong to resources withdrawn from the verified live catalog; evidence retained.` : '') +
    (health?.error ? ` Health: ${code(health.error)}.` : '') +
    (!sameScan ? ' Health does not match the retained scan.' : '') +
    (outcome !== 'success' ? ' Collection step did not succeed; retained data may be older.' : '') +
    (repeatedSourceRejection ? ' The preceding scan stopped for the same source error. This run posts a warning.' : '');
  const names = new Map(scan.catalog.map(t => [t.resourceId, t.name]));
  const rows = failures.slice(0, 20).map(e =>
    `| ${md(e.r)} | ${md(names.get(e.r))} | ${md(e.d)} | ${e.status === 'skipped' ? 'NOT_QUERIED' : code(e.code)} |`).join('\n');
  const recoveryRows = recovered.map(e => `| ${md(e.r)} | ${md(names.get(e.r))} | ${md(e.d)} | ${e.attempts.length - 1} | ${md(e.at)} |`).join('\n');
  const summary = `## ${label}\n\n` +
    `${message}\n\nRetained scan: **${scan.id}**. Source reads: **${scan.startedAt} — ${scan.finishedAt} UTC**.\n\n` +
    `Collection step: **${outcome === 'success' ? 'succeeded' : 'did not succeed'}**. ` +
    `Health matches retained scan: **${sameScan ? 'yes' : 'no'}**.\n\n` +
    (failures.length ? `Successful observations were preserved. Missed checks remain **unknown**, never sold out or filled in retrospectively.\n\n` +
      `| Resource | Trail | Visit date | Failure |\n|---|---|---|---|\n${rows}\n\n` +
      (failures.length > 20 ? `Showing 20 of ${failures.length} missed checks; the full record remains in the archived scan.\n\n` : '') : '') +
    (recovered.length ? `### Recovered automatically\n\nEarlier failed attempts remain in the archive. The successful check's actual response time is used for availability and analysis.\n\n` +
      `| Resource | Trail | Visit date | Additional attempts | Successful response (UTC) |\n|---|---|---|---:|---|\n${recoveryRows}\n\n` : '') +
    (scan.recoverySkippedReason ? `Recovery not attempted: **${md(scan.recoverySkippedReason)}**.\n\n` : '') +
    (scan.catalogAttempts ? `### Trail-list attempts\n\n| Response time (UTC) | Status | Failure |\n|---|---|---|\n` +
      scan.catalogAttempts.map(a => `| ${md(a.at)} | ${a.status} | ${a.status === 'error' ? code(a.code) : 'recovered'} |`).join('\n') + '\n\n' : '') +
    (scan.catalogError ? `Catalog verification failed: **${code(scan.catalogError.code)}**.\n\n` : '') +
    (scan.catalogWithdrawal ? `### Withdrawn booking resources\n\nA fresh catalog check at ${md(scan.catalogWithdrawal.checkedAt)} confirmed removal of: ` +
      scan.catalogWithdrawal.initialCatalog.filter(t => !scan.catalog.some(c => c.resourceId === t.resourceId)).map(t => `${md(t.resourceId)}: ${md(t.name)}`).join('; ') +
      `. Their rejected queries remain in catalogWithdrawal; availability is unknown. Removal does not establish physical trail closure.\n\n` : '') +
    (scan.stopReason ? `Stop reason: **${md(scan.stopReason)}**.\n\n` : '') +
    (health?.cooldownUntil ? `Upstream cooldown: **${md(health.cooldownUntil)}**.\n\n` : '') +
    `The existing clock handles subsequent scans and respects cooldowns. This status check makes no source requests.\n`;
  return { failed, repeatedSourceRejection, warning: repeatedSourceRejection || (!failed && Boolean(counts.unreported)), message, summary };
}
