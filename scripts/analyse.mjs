import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveFiles, readScan, readJson, atomicWrite, verifyArchives } from '../lib/archive.mjs';
import { createStudy, ingestScan, summarizeStudy, renderSummary, renderTrail } from '../lib/analysis.mjs';
import { validateConfig } from '../lib/study.mjs';
import { renderInventory } from '../lib/context.mjs';
import { compareScan, updateComparisonState, renderChanges } from '../lib/changes.mjs';
import { publishEntry } from '../lib/published.mjs';
import { renderLeads, renderEvents } from '../lib/history-reports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = validateConfig(await readJson(path.join(root, 'study.json')));
const integrity = await verifyArchives(root);
const study = createStudy();
let latest, dailyScan, changes = [], previousScanId = null;
const good = new Map(), attempts = new Map();
for (const file of await archiveFiles(root)) {
  previousScanId = latest?.id || null;
  latest = await readScan(file); ingestScan(study, latest);
  changes = compareScan(latest, good, attempts);
  updateComparisonState(latest, good, attempts);
  if (latest.sentinelDates?.length) dailyScan = latest;
}
if (!latest) throw new Error('No historical scans to analyse');
const summary = summarizeStudy(study);
const health = await readJson(path.join(root, 'data/collector-health.json'), null);
const { trails, ...overview } = summary;
await atomicWrite(path.join(root, 'analysis/summary.json'), JSON.stringify({ ...overview, archive: integrity,
  trails: trails.map(({ groups, ...t }) => ({ ...t, timeDayGroups: groups.length, groupsWithLeadTimeSuggestion: groups.filter(g => g.suggestedLeadDays !== null).length })) }, null, 2) + '\n');
await atomicWrite(path.join(root, 'reports/SUMMARY.md'), renderSummary(latest, summary, integrity, config, health));
await atomicWrite(path.join(root, 'reports/CHANGES.md'), renderChanges(latest, changes, previousScanId));
for (const trail of latest.catalog) {
  const history = trails.find(t => t.resourceId === trail.resourceId);
  const longRangeSamples = (dailyScan?.entries || []).filter(e => e.r === trail.resourceId && dailyScan.sentinelDates.includes(e.d));
  const published = new Map();
  for (const [entries, cadence] of [[longRangeSamples, 'daily'], [latest.entries.filter(e => e.r === trail.resourceId), 'hourly']]) {
    for (const e of entries) published.set(e.d, publishEntry(e, trail, latest.sentinelDates?.includes(e.d) ? 'daily' : cadence));
  }
  for (const { index, profile } of published.values()) if (profile) {
    await atomicWrite(path.join(root, index.path), JSON.stringify(profile, null, 2) + '\n');
  }
  await atomicWrite(path.join(root, `latest/index/${trail.resourceId}.json`), JSON.stringify({ version: 1,
    resourceId: trail.resourceId, trail: trail.name, latestScanId: latest.id, scanFinishedAt: latest.finishedAt,
    entries: [...published.values()].map(p => p.index) }, null, 2) + '\n');
  await atomicWrite(path.join(root, `reports/trails/${trail.resourceId}.md`), renderTrail(latest, trail, history, longRangeSamples));
  await atomicWrite(path.join(root, `reports/changes/${trail.resourceId}.md`), renderChanges(latest, changes, previousScanId, trail.resourceId));
  await atomicWrite(path.join(root, `latest/trails/${trail.resourceId}.json`), JSON.stringify({ v: 1, trail, scanId: latest.id,
    scanStartedAt: latest.startedAt, scanFinishedAt: latest.finishedAt, dates: latest.dates,
    slotColumns: ['beginLocal', 'endLocal', 'timezone', 'nonResidentPercentage'],
    entries: latest.entries.filter(e => e.r === trail.resourceId), longRangeSamples }) + '\n');
}
for (const history of trails) {
  await atomicWrite(path.join(root, `analysis/trails/${history.resourceId}.json`), JSON.stringify(history) + '\n');
  await atomicWrite(path.join(root, `reports/leads/${history.resourceId}.md`), renderLeads(history, summary.generatedAt));
  await atomicWrite(path.join(root, `reports/events/${history.resourceId}.md`), renderEvents(history, summary.generatedAt));
}
const context = await readJson(path.join(root, 'data/context/latest-ifcn.json'), null);
const contextHealth = await readJson(path.join(root, 'data/context/health.json'), null);
await atomicWrite(path.join(root, 'reports/INVENTORY.md'), context ? renderInventory(context, latest.catalog, contextHealth)
  : '# Official route inventory\n\nOfficial context is not verified. All current SIMplifica catalog resources are still collected.\n');
console.log(JSON.stringify({ analysedScans: integrity.scans, archivedSlots: integrity.slots, trailResources: latest.catalog.length,
  scanGaps: summary.missingScanIntervals.length, suggestedGroups: trails.flatMap(t => t.groups).filter(g => g.suggestedLeadDays !== null).length }));
