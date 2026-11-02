export function withdrawalCandidates(scan) {
  return scan.catalog.filter(t => {
    const entries = scan.entries.filter(e => e.r === t.resourceId);
    return entries.length === scan.dates.length && entries.every(e => e.status === 'error' && e.code === 'UPSTREAM_REJECTED');
  }).map(t => t.resourceId);
}

export function reconcileWithdrawal(scan, selection, checkedAt) {
  const initial = new Set(scan.catalog.map(t => t.resourceId));
  const current = new Set(selection.catalog.map(t => t.resourceId));
  // Added resources require a new scan; never declare unqueried additions complete.
  if (!current.size || [...current].some(id => !initial.has(id))) return scan;
  const removed = [...initial].filter(id => !current.has(id));
  const candidates = new Set(withdrawalCandidates(scan));
  if (!removed.length || removed.some(id => !candidates.has(id))) return scan;
  const removedSet = new Set(removed);
  return { ...scan, ...selection, entries: scan.entries.filter(e => !removedSet.has(e.r)),
    catalogWithdrawal: { checkedAt, initialCatalog: scan.catalog, initialScope: scan.scope,
      entries: scan.entries.filter(e => removedSet.has(e.r)) } };
}
