import { hash } from './study.mjs';

export function publishEntry(entry, trail, cadence = 'hourly') {
  const index = { date: entry.d, status: entry.status, sourceFetchedAt: entry.at, cadence,
    staleAfterMinutes: cadence === 'daily' ? 1560 : 90 };
  if (!['ok', 'empty'].includes(entry.status)) return { index: { ...index, error: entry.error, code: entry.code || null }, profile: null };
  const contents = { version: 1, resourceId: entry.r, trail: trail.name, date: entry.d,
    status: entry.s.length ? 'slots_returned' : 'no_slots_returned',
    slotColumns: ['beginLocal', 'endLocal', 'timezone', 'nonResidentPercentage'], slots: entry.s };
  const profileHash = hash(JSON.stringify(contents));
  return { index: { ...index, profileHash, path: `latest/slots/${entry.r}/${entry.d}.json`, slotCount: entry.s.length },
    profile: { ...contents, profileHash, freshnessIndex: `../../index/${entry.r}.json`,
      freshnessNote: 'This payload changes only when slots change. Read sourceFetchedAt and status from the freshness index at the SAME Git commit. Payload file age is not observation age.' } };
}
