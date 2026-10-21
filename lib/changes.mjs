import { pairKey, slotKey, md } from './study.mjs';

export function compareScan(scan, good, attempts) {
  const changes = [];
  for (const e of scan.entries) {
    const prior = good.get(pairKey(e)), lastAttempt = attempts.get(pairKey(e));
    const base = { resourceId: e.r, date: e.d, at: e.at, previousAt: prior?.at || null,
      gap: Boolean(prior && (Date.parse(e.at) - Date.parse(prior.at) > 2 * 3600000 || ['error', 'skipped'].includes(lastAttempt?.status))) };
    const add = (type, details = {}) => changes.push({ ...base, type, ...details });
    if (['error', 'skipped'].includes(e.status)) {
      if (lastAttempt && ['ok', 'empty'].includes(lastAttempt.status)) add('data_unavailable', { detail: e.error });
      continue;
    }
    if (lastAttempt && ['error', 'skipped'].includes(lastAttempt.status)) add('data_recovered');
    if (!prior) continue; // First observation is a baseline, not a release or sell-out event.
    if (!e.s.length) { if (prior.s.length) add('slots_no_longer_returned', { detail: 'Empty response; availability unknown.' }); continue; }
    if (!prior.s.length) { add('slots_released', { slotCount: e.s.length }); continue; }
    const old = new Map(prior.s.map(s => [slotKey(s), s])), current = new Set(e.s.map(slotKey));
    for (const slot of e.s) {
      const p = old.get(slotKey(slot));
      const details = { beginLocal: slot[0], endLocal: slot[1], timezone: slot[2], to: slot[3] };
      if (!p) { add('new_slot_returned', details); continue; }
      details.from = p[3];
      if (p[3] > 0 && slot[3] === 0) add('non_resident_sold_out', details);
      else if (p[3] === 0 && slot[3] > 0) add('non_resident_reopened', details);
      else if (p[3] - slot[3] >= 10) add('non_resident_drop', details);
    }
    for (const slot of prior.s) if (!current.has(slotKey(slot))) add('slot_no_longer_returned', {
      beginLocal: slot[0], endLocal: slot[1], timezone: slot[2], detail: 'Missing slot; availability unknown.' });
  }
  return changes;
}

export function updateComparisonState(scan, good, attempts) {
  for (const e of scan.entries) {
    attempts.set(pairKey(e), e);
    if (['ok', 'empty'].includes(e.status)) good.set(pairKey(e), e);
  }
}

export function renderChanges(scan, changes, previousScanId, resourceId) {
  const selected = resourceId ? changes.filter(c => c.resourceId === resourceId) : changes;
  const resources = [...new Set(changes.map(c => c.resourceId))].sort((a, b) => +a - +b);
  const rows = selected.map(c => `| ${c.resourceId} | ${c.date} | ${c.beginLocal?.slice(11, 16) || '—'} | ${c.type} | ${c.from === undefined ? md(c.detail || (c.slotCount ? c.slotCount + ' slots' : '')) : `${c.from}% → ${c.to}%`} | ${c.previousAt || 'none'} | ${c.at} | ${c.gap ? 'yes' : 'no'} |`).join('\n');
  const body = resourceId ? rows : resources.map(id => {
    const events = changes.filter(c => c.resourceId === id), types = [...new Set(events.map(c => c.type))];
    return `| ${id} | ${events.length} | ${[...new Set(events.map(c => c.date))].join(', ')} | ${types.join(', ')} | [All changes](changes/${id}.md) |`;
  }).join('\n');
  return `# ${resourceId ? `Resource ${resourceId}: changes` : 'Changes in the latest scan'}\n\nScan: **${scan.id}**. Finished: ${scan.finishedAt} UTC. Previous scan: ${previousScanId || 'none; baseline only'}. Material events: **${selected.length}**. Comparison uses the last successful matching slot/date/timezone, which can be older than the preceding scan. Each detail includes both source timestamps and a gap flag.\n\nSmall changes remain in the immutable history even when they do not cross the 10-point notification threshold. Missing data is unknown availability. The first scan is baseline only. Daily long-range observations have coarse timing; do not describe them as hourly tightening.\n\n${resourceId ? '| Resource | Visit date | Local start | Event | Change / uncertainty | Previous source at (UTC) | Current source at (UTC) | Gap |\n|---|---|---|---|---|---|---|---|' : '| Resource | Events | Visit dates | Event types | Details |\n|---|---:|---|---|---|'}\n${body || 'No material changes among comparable successful observations.'}\n`;
}
