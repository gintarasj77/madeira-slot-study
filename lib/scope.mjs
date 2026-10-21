import { ProxyError } from '../src/upstream.mjs';

export function selectCatalog(catalog, island) {
  if (island !== 'Madeira') throw new Error('Unsupported study island');
  const selected = [], excluded = [];
  for (const trail of catalog) {
    const name = trail.name.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (/^Porto Santo PR\s*\d+(?:\.\d+)?(?=\s|\||$)/i.test(name)) excluded.push(trail);
    else if (/^PR\s*\d+(?:\.\d+)?(?=\s|\||$)/i.test(name)) selected.push(trail);
    else throw new ProxyError('UPSTREAM_SCHEMA_CHANGED', 'A booking resource has an unrecognized island label; review the catalog.');
  }
  return { catalog: selected, scope: { island, totalCatalogResources: catalog.length, excludedResources: excluded } };
}

// Project old archives into the current study without rewriting their evidence.
export function scopeScan(scan, island) {
  const selection = selectCatalog(scan.catalog, island), ids = new Set(selection.catalog.map(t => t.resourceId));
  return { ...scan, catalog: selection.catalog, entries: scan.entries.filter(e => ids.has(e.r)),
    scope: scan.scope || selection.scope };
}
