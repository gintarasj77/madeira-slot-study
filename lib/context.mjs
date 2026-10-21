import { hash, md } from './study.mjs';

export const IFCN_SOURCE = 'https://ifcn.madeira.gov.pt/en/atividades-de-natureza/percursos-pedestres-recomendados/percursos-pedestres-recomendados.html';

function text(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}

export function parseOfficialInventory(html) {
  const tables = [...html.matchAll(/<table\b[^>]*\bid=["']data-table["'][^>]*>[\s\S]*?<\/table>/gi)].map(m => m[0]);
  if (tables.length !== 2) throw new Error('Official route-table schema changed');
  const routes = tables.flatMap((table, index) => [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].flatMap(m => {
    const cells = [...m[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c => text(c[1]));
    if (!cells.length) return [];
    if (cells.length !== 7 || !/^\d+(?:\.\d+)?$/.test(cells[1]) || !cells[2] || !cells[5]) throw new Error('Official route row changed');
    return [{ island: index === 0 ? 'Madeira' : 'Porto Santo', code: 'PR' + cells[1], name: cells[2],
      distance: cells[3], passageDetails: cells[4], statusText: cells[5], manager: cells[6] }];
  }));
  if (routes.filter(r => r.island === 'Madeira').length < 30 || routes.filter(r => r.island === 'Porto Santo').length < 3) throw new Error('Official inventory unexpectedly incomplete');
  if (new Set(routes.map(r => r.island + '/' + r.code)).size !== routes.length) throw new Error('Duplicate official route code');
  return { source: IFCN_SOURCE, tableSha256: hash(tables.join('\n')), routes };
}

export function reconcileInventory(context, catalog) {
  return context.routes.map(route => ({ ...route, bookingResources: catalog.filter(t => {
    const code = t.name.match(/^(?:Porto\s+Santo\s+)?PR\s*(\d+(?:\.\d+)?)(?=\s|\||$)/i)?.[1];
    // PR numbers are island-specific; never assign Porto Santo PR1 to Madeira PR1.
    const isPortoSanto = /Porto\s+Santo/i.test(t.name);
    return 'PR' + code === route.code && (route.island === 'Porto Santo') === isPortoSanto;
  }).map(t => ({ resourceId: t.resourceId, name: t.name })) }));
}

export function renderInventory(context, catalog, health) {
  const routes = reconcileInventory(context, catalog), missing = routes.filter(r => !r.bookingResources.length);
  const mapped = new Set(routes.flatMap(r => r.bookingResources.map(t => t.resourceId))), unmatched = catalog.filter(t => !mapped.has(t.resourceId));
  const rows = routes.map(r => `| ${r.island} | ${r.code} | ${md(r.name)} | ${md(r.statusText)} | ${r.bookingResources.map(t => `[${t.resourceId}: ${md(t.name)}](trails/${t.resourceId}.md)`).join('; ') || '**No matching booking resource**'} |`).join('\n');
  return `# Official route inventory and booking coverage\n\nIFCN source fetched: **${context.fetchedAt} UTC**. [Official source](${context.source}). ${health?.error ? `**Context refresh failed:** ${md(health.error)}. Retained source may be stale.` : ''}\n\n${catalog.length} current SIMplifica booking resources; ${routes.length} official island-specific routes in the IFCN tables. ${missing.length} official routes have no matching catalog resource; ${unmatched.length} booking resources have no automatic island/code match. Every catalog resource is still collected, including unmatched variants. The booking catalog and official walking-route list are different inventories. A missing booking resource or an empty API response is not proof of closure or exemption.\n\nStatus text is source context, preserved separately from availability. Read restrictions in the official source; a percentage does not establish that a route is open. Daily status snapshots are retained in data/context/ifcn.\n\n| Island | Code | Official route | Official status text | Matching booking resources |\n|---|---|---|---|---|\n${rows}\n\n## Catalog resources needing manual matching\n\n${unmatched.map(t => `- ${t.resourceId}: ${md(t.name)}`).join('\n') || 'None.'}\n`;
}
