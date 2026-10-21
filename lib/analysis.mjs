import { localInstant, pairKey, slotKey, scanCounts, md } from './study.mjs';

export const LEAD_DAYS = [1, 3, 7, 14, 21, 28, 45, 60, 90];
export const THRESHOLDS = [50, 20, 0];
const sampleTolerance = days => days <= 30 ? 1.5 : 12.5;

export function createStudy(now = Date.now()) {
  return { now, scans: [], pairs: new Map(), trails: new Map(), catalogChanges: [], observationCount: 0,
    preEntryObservations: 0, afterEntryObservations: 0, invalidTimeObservations: 0, missingScanIntervals: [], lastCatalog: null };
}

function unknown(pair) {
  for (const series of pair.series.values()) series.gap = true;
}

export function ingestScan(study, scan) {
  const counts = scanCounts(scan), previous = study.scans.at(-1);
  if (previous && Date.parse(scan.startedAt) - Date.parse(previous.startedAt) > 90 * 60000) {
    study.missingScanIntervals.push({ after: previous.startedAt, before: scan.startedAt,
      durationHours: (Date.parse(scan.startedAt) - Date.parse(previous.startedAt)) / 3600000 });
  }
  study.scans.push({ id: scan.id, startedAt: scan.startedAt, finishedAt: scan.finishedAt, ...counts,
    stopReason: scan.stopReason, catalogVerified: !scan.catalogError });
  const catalogIds = new Set(scan.catalog.map(t => t.resourceId));
  if (!scan.catalogError) {
    if (study.lastCatalog) {
      for (const t of scan.catalog.filter(t => !study.lastCatalog.has(t.resourceId))) study.catalogChanges.push({ at: scan.finishedAt, type: 'added', ...t });
      for (const [resourceId, name] of study.lastCatalog) if (!catalogIds.has(resourceId)) study.catalogChanges.push({ at: scan.finishedAt, type: 'removed', resourceId, name });
    }
    study.lastCatalog = new Map(scan.catalog.map(t => [t.resourceId, t.name]));
  }
  for (const trail of scan.catalog) study.trails.set(trail.resourceId, { ...trail, catalogLastSeen: scan.finishedAt });
  for (const pair of study.pairs.values()) if (!catalogIds.has(pair.r)) unknown(pair);
  for (const entry of scan.entries) {
    const key = pairKey(entry);
    if (!study.pairs.has(key)) study.pairs.set(key, { r: entry.r, d: entry.d, series: new Map(), verified: 0, empty: 0, failed: 0 });
    const pair = study.pairs.get(key);
    if (entry.status !== 'ok') {
      if (entry.status === 'empty') pair.empty++; else pair.failed++;
      unknown(pair);
      continue;
    }
    pair.verified++;
    const returned = new Set(entry.s.map(slotKey));
    for (const [key, series] of pair.series) if (!returned.has(key)) series.gap = true;
    for (const slot of entry.s) {
      study.observationCount++;
      const instant = localInstant(slot[0], slot[2]);
      if (instant.at === null) { study.invalidTimeObservations++; continue; }
      const leadHours = (instant.at - Date.parse(entry.at)) / 3600000;
      if (leadHours < 0) { study.afterEntryObservations++; continue; }
      study.preEntryObservations++;
      const key = slotKey(slot), p = slot[3], current = { at: entry.at, p, leadHours };
      if (!pair.series.has(key)) pair.series.set(key, { begin: slot[0], end: slot[1], timezone: slot[2], entryAt: new Date(instant.at).toISOString(),
        first: current, last: null, firstSeenAtOrBelow: THRESHOLDS.filter(t => p <= t), gap: false,
        observations: 0, changes: 0, smallChanges: 0, crossings: [], reopenings: [], samples: {}, maxDropPointsPerHour: null, decreaseIntervals: 0 });
      const series = pair.series.get(key), prior = series.last;
      // Preserve out-of-order raw observations, but do not invent reverse-time changes.
      if (prior && Date.parse(entry.at) <= Date.parse(prior.at)) continue;
      const hours = prior ? (Date.parse(entry.at) - Date.parse(prior.at)) / 3600000 : null;
      const gap = series.gap || (hours !== null && hours > 2);
      if (prior && prior.p !== p) {
        series.changes++;
        if (Math.abs(prior.p - p) < 10) series.smallChanges++;
        for (const threshold of THRESHOLDS) {
          if (prior.p > threshold && p <= threshold) series.crossings.push({ threshold, from: prior.p, to: p,
            between: [prior.at, entry.at], leadHours: [leadHours, prior.leadHours], gap });
        }
        if (prior.p === 0 && p > 0) series.reopenings.push({ from: 0, to: p, between: [prior.at, entry.at], gap });
        if (!gap && prior.p > p) {
          series.maxDropPointsPerHour = Math.max(series.maxDropPointsPerHour || 0, (prior.p - p) / hours);
          series.decreaseIntervals++;
        }
      }
      for (const days of LEAD_DAYS) {
        const distance = Math.abs(leadHours - days * 24);
        if (distance <= sampleTolerance(days) && (!series.samples[days] || distance < series.samples[days].distance)) {
          series.samples[days] = { ...current, distance };
        }
      }
      series.last = current; series.observations++; series.gap = false;
    }
  }
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * q;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}

export function summarizeStudy(study) {
  const trails = [];
  for (const trail of study.trails.values()) {
    const pairs = [...study.pairs.values()].filter(p => p.r === trail.resourceId), series = pairs.flatMap(p => [...p.series.values()].map(s => ({ ...s, date: p.d })));
    const groups = new Map();
    for (const s of series) {
      const weekday = new Date(s.date + 'T12:00:00Z').getUTCDay(), dayType = weekday === 0 || weekday === 6 ? 'weekend' : 'weekday';
      // Separate exact entry time, duration/zone and weekday/weekend; no repeated hourly pseudo-samples.
      const key = [s.begin.slice(11), s.end.slice(11), s.timezone, dayType].join('|');
      if (!groups.has(key)) groups.set(key, { beginTime: s.begin.slice(11), endTime: s.end.slice(11), timezone: s.timezone, dayType,
        visitDates: new Set(), matureVisitDates: new Set(), samples: Object.fromEntries(LEAD_DAYS.map(d => [d, new Map()])),
        crossings: [], initialCrossings: [], eligibleInitialDates: Object.fromEntries(THRESHOLDS.map(t => [t, new Set()])),
        firstSeenAtOrBelow: Object.fromEntries(THRESHOLDS.map(t => [t, new Set()])), reopenings: 0, smallChanges: 0,
        maxObservedDropPointsPerHour: null, gapFreeDecreaseIntervals: 0 });
      const group = groups.get(key), mature = Date.parse(s.entryAt) <= study.now;
      group.visitDates.add(s.date);
      if (mature) group.matureVisitDates.add(s.date);
      for (const days of LEAD_DAYS) if (s.samples[days]) group.samples[days].set(s.date, { date: s.date, mature, ...s.samples[days] });
      group.crossings.push(...s.crossings.map(c => ({ date: s.date, ...c })));
      for (const threshold of THRESHOLDS) if (!s.firstSeenAtOrBelow.includes(threshold)) {
        group.eligibleInitialDates[threshold].add(s.date);
        const crossing = s.crossings.find(c => c.threshold === threshold);
        if (crossing) group.initialCrossings.push({ date: s.date, ...crossing });
      }
      for (const threshold of s.firstSeenAtOrBelow) group.firstSeenAtOrBelow[threshold].add(s.date);
      group.reopenings += s.reopenings.length; group.smallChanges += s.smallChanges;
      if (s.maxDropPointsPerHour !== null) group.maxObservedDropPointsPerHour = Math.max(group.maxObservedDropPointsPerHour || 0, s.maxDropPointsPerHour);
      group.gapFreeDecreaseIntervals += s.decreaseIntervals;
    }
    const summaries = [...groups.values()].map(group => {
      const leadTime = Object.fromEntries(LEAD_DAYS.map(days => {
        const all = [...group.samples[days].values()], mature = all.filter(s => s.mature);
        const values = mature.map(s => s.p), positive = values.filter(v => v > 0).length;
        // Include missing sampling opportunities in coverage; future dates do not yet count as opportunities.
        const opportunities = series.filter(s => s.begin.slice(11) === group.beginTime && s.end.slice(11) === group.endTime &&
          s.timezone === group.timezone && group.matureVisitDates.has(s.date) &&
          Date.parse(s.entryAt) - days * 86400000 >= Date.parse(study.scans[0].startedAt)).length;
        return [days, { distinctDates: all.length, matureDistinctDates: mature.length, samplingOpportunities: opportunities,
          coverage: opportunities ? mature.length / opportunities : null,
          positiveAvailabilityRate: values.length ? positive / values.length : null,
          above20Rate: values.length ? values.filter(v => v > 20).length / values.length : null,
          median: quantile(values, .5), p20: quantile(values, .2), minimum: values.length ? Math.min(...values) : null,
          allDateMedian: quantile(all.map(s => s.p), .5), allDateP20: quantile(all.map(s => s.p), .2) }];
      }));
      const thresholdSummary = Object.fromEntries(THRESHOLDS.map(t => {
        const initial = group.initialCrossings.filter(c => c.threshold === t);
        const observedDates = new Set(initial.map(c => c.date));
        return [t, { observedInitialCrossingDates: observedDates.size,
          firstSeenAtOrBelowDates: group.firstSeenAtOrBelow[t].size,
          noInitialCrossingObservedDates: group.eligibleInitialDates[t].size - observedDates.size,
          gapSpanningInitialCrossings: initial.filter(c => c.gap).length,
          medianObservedLowerLeadHours: quantile(initial.map(c => c.leadHours[0]), .5),
          medianObservedUpperLeadHours: quantile(initial.map(c => c.leadHours[1]), .5) }];
      }));
      const supported = LEAD_DAYS.filter(d => leadTime[d].matureDistinctDates >= 14 && leadTime[d].coverage >= .85 && leadTime[d].above20Rate >= .9);
      return { beginTime: group.beginTime, endTime: group.endTime, timezone: group.timezone, dayType: group.dayType,
        distinctVisitDates: group.visitDates.size, matureDistinctVisitDates: group.matureVisitDates.size, leadTime,
        firstSeenAtOrBelow: Object.fromEntries(THRESHOLDS.map(t => [t, group.firstSeenAtOrBelow[t].size])),
        crossings: group.crossings, reopenings: group.reopenings, smallChanges: group.smallChanges,
        thresholdSummary, maxObservedDropPointsPerHour: group.maxObservedDropPointsPerHour,
        gapFreeDecreaseIntervals: group.gapFreeDecreaseIntervals,
        suggestedLeadDays: supported.length ? supported[0] : null,
        suggestionBasis: supported.length ? 'Earliest sampled lead bucket with >20% quota on at least 90% of 14+ mature visit dates and >=85% sampling coverage; observational only.' : 'Insufficient mature evidence; no booking lead-time recommendation.' };
    }).sort((a, b) => a.beginTime.localeCompare(b.beginTime) || a.dayType.localeCompare(b.dayType));
    trails.push({ ...trail, distinctVisitDates: pairs.length, slotSeries: series.length,
      observedChanges: series.reduce((n, s) => n + s.changes, 0), smallChanges: series.reduce((n, s) => n + s.smallChanges, 0),
      observedCrossings: series.reduce((n, s) => n + s.crossings.length, 0),
      gapSpanningCrossings: series.reduce((n, s) => n + s.crossings.filter(c => c.gap).length, 0),
      reopenings: series.reduce((n, s) => n + s.reopenings.length, 0),
      firstSeenSoldOutSeries: series.filter(s => s.first.p === 0).length,
      groups: summaries });
  }
  return { generatedAt: new Date(study.now).toISOString(), firstObservationAt: study.scans[0]?.startedAt || null,
    lastObservationAt: study.scans.at(-1)?.finishedAt || null, scans: study.scans.length, observationCount: study.observationCount,
    preEntryObservations: study.preEntryObservations, afterEntryObservations: study.afterEntryObservations,
    invalidTimeObservations: study.invalidTimeObservations, missingScanIntervals: study.missingScanIntervals,
    catalogChanges: study.catalogChanges, trails: trails.sort((a, b) => +a.resourceId - +b.resourceId) };
}

export function renderSummary(scan, history, integrity, config, health) {
  const counts = scanCounts(scan), age = (Date.parse(history.generatedAt) - Date.parse(scan.finishedAt)) / 60000;
  const healthy = age <= config.staleAfterMinutes && !counts.failed && !scan.catalogError && !health?.error;
  const rows = scan.catalog.map(t => {
    const entries = scan.entries.filter(e => e.r === t.resourceId), stats = scanCounts({ entries });
    return `| ${t.resourceId} | ${md(t.name)} | ${stats.verified}/${entries.length} | ${stats.slots} | ${stats.empty} | [Full slots and history](trails/${t.resourceId}.md) |`;
  }).join('\n');
  return `# Madeira non-resident availability study\n\nGenerated: **${history.generatedAt}**. Latest scan: **${scan.id}**. Source reads: **${scan.startedAt} — ${scan.finishedAt} UTC**.\n\nHealth: **${healthy ? 'fresh and complete' : 'ATTENTION: incomplete, stale or stopped'}**. Verified responses: **${counts.verified}/${counts.expected}**; responses with slots: **${counts.withSlots}**; empty responses: **${counts.empty}**; failed/not queried: **${counts.failed}**. **${counts.slots} slot observations** in this scan. Empty responses are verified API responses with unknown booking availability. ${scan.stopReason ? `Stop reason: ${scan.stopReason}.` : ''}${health?.error ? ` Collector health: ${health.error}.` : ''}\n\nRolling window: **${scan.mainDates?.[0] || scan.dates[0]} through ${(scan.mainDates || scan.dates).at(-1)}**, ${(scan.mainDates || scan.dates).length} calendar dates in ${scan.calendarTimezone}. Additional daily long-range samples: ${(scan.sentinelDates || []).join(", ") || "none in this scan"}; the latest daily sample remains in each trail report. All ${scan.catalog.length} current booking-catalog resources and every returned slot are included, including 0% and 100%. Route variants remain separate. This covers SIMplifica service 259, not a claim that every official PR route is bookable there.\n\nCollection began: **${history.firstObservationAt}**. Retained: **${integrity.scans} immutable scans**, **${integrity.slots} slot observations**, **${integrity.bytes} compressed bytes**; all archive hashes verified. Scheduled refresh: hourly, at minute 17 UTC; timing is best effort. Treat individual source observations older than ${config.staleAfterMinutes} minutes as stale.\n\n## Learning booking lead times\n\nAnalysis retains small changes, threshold crossings at 50%, 20% and 0%, and reopenings. It compares 1, 3, 7, 14, 21 and 28 days before entry, plus coarse daily 45-, 60- and 90-day samples, separately by route variant, exact slot, timezone and weekday/weekend. Samples count distinct visit dates. Observations after entry are excluded from booking-pressure analysis.\n\nPre-entry observations: ${history.preEntryObservations}; after-entry observations retained but excluded: ${history.afterEntryObservations}; ambiguous/invalid local-time observations excluded: ${history.invalidTimeObservations}. Scan gaps over 90 minutes: **${history.missingScanIntervals.length}**. Catalog additions/removals: ${history.catalogChanges.length}.\n\nA first observation already at 0% cannot tell when a slot filled. An observed crossing is bounded between checks, and gaps widen that uncertainty. No recommendation is produced until the relevant time/day group has at least 14 mature visit-date samples and adequate coverage. These percentages do not reveal seat counts or distinguish bookings from quota changes. Autumn history may not predict another season.\n\n## Current coverage\n\n| Resource | Booking resource / route variant | Verified pairs | Slots | Empty responses | Details |\n|---|---|---:|---:|---:|---|\n${rows}\n\n[Official routes and missing booking resources](INVENTORY.md) · [Machine-readable historical summary](../analysis/summary.json) · [Methodology and limitations](../METHODOLOGY.md) · [Source](https://simplifica.madeira.gov.pt/services/78-82-259)\n`;
}

export function renderTrail(scan, trail, history, longRangeSamples = []) {
  const entries = scan.entries.filter(e => e.r === trail.resourceId);
  const rows = entries.map(e => `| ${e.d} | ${e.at} | ${e.status} | ${e.s?.length || 0} | ${e.status === 'ok' ? e.s.map(s => `${s[0].slice(11, 16)}–${s[1].slice(11, 16)} ${s[3]}%`).join('; ') : md(e.error || 'No slots returned; unknown availability')} |`).join('\n');
  const zones = [...new Set(entries.flatMap(e => (e.s || []).map(s => s[2])))];
  const dailyRows = longRangeSamples.map(e => `| ${e.d} | ${e.at} | ${e.status} | ${e.s?.length || 0} | ${e.s?.map(s => `${s[0].slice(11, 16)}–${s[1].slice(11, 16)} ${s[3]}%`).join('; ') || md(e.error || 'No slots; unknown availability')} |`).join('\n');
  const metrics = history ? `Observed changes: ${history.observedChanges}, including ${history.smallChanges} changes below 10 percentage points. Threshold crossings: ${history.observedCrossings} (${history.gapSpanningCrossings} across gaps); reopenings: ${history.reopenings}; slot/date series first seen already sold out: ${history.firstSeenSoldOutSeries}.` : 'No historical observations yet.';
  const groups = (history?.groups || []).map(g => `| ${g.beginTime.slice(0, 5)}–${g.endTime.slice(0, 5)} | ${g.dayType} | ${LEAD_DAYS.map(d => {
    const s = g.leadTime[d];
    return `${s.matureDistinctDates}/${s.distinctDates}${s.matureDistinctDates ? `; ${Math.round(s.positiveAvailabilityRate * 100)}% available` : ''}`;
  }).join(' | ')} | ${g.suggestedLeadDays === null ? 'Insufficient evidence' : `${g.suggestedLeadDays} days; observational`} |`).join('\n');
  return `# ${md(trail.name)}\n\nResource: **${trail.resourceId}**. Latest scan: **${scan.id}**. Scan finished: ${scan.finishedAt} UTC. Source timezones: ${zones.join(', ') || 'not verified'}. All percentages below are **Não residentes**. Slot times are source local times, not UTC. Exact timestamps (including fractional seconds) are retained in [normalized data](../../latest/trails/${trail.resourceId}.json) and immutable archives.\n\n${metrics}\n\n## Latest complete slot inventory\n\nEach row has its own source observation time. Missing/empty/error data are unknown, never inferred sold out. Data older than 90 minutes are stale.\n\n| Visit date | Source fetched at (UTC) | Status | Slots | Local interval and non-resident percentage |\n|---|---|---|---:|---|\n${rows}\n\n## Daily long-range samples\n\nThese dates are sampled daily at 45-, 60- and 90-day offsets, with gaps between horizons. Check the source timestamp; samples older than 26 hours are stale.\n\n| Visit date | Source fetched at (UTC) | Status | Slots | Local interval and non-resident percentage |\n|---|---|---|---:|---|\n${dailyRows || "| — | — | unverified | — | No daily long-range sample yet |"}\n\n## Historical lead-time samples\n\nCells show mature distinct visit dates / all distinct visit dates sampled near each lead time (within 90 minutes for hourly buckets, 12.5 hours for daily long-range buckets). Where mature samples exist, the percentage of dates with any availability is shown. Repeated hourly observations are not independent samples. Low sample counts are exploratory.\n\n| Local interval | Day group | ${LEAD_DAYS.map(d => d + " days").join(" | ")} | Lead-time suggestion |\n|---|---|${LEAD_DAYS.map(() => "---|").join("")}---|\n${groups || '| — | — | ' + LEAD_DAYS.map(() => '0').join(' | ') + ' | Insufficient evidence |'}\n\n[Summary](../SUMMARY.md) · [Detailed historical statistics](../../analysis/trails/${trail.resourceId}.json)\n`;
}
