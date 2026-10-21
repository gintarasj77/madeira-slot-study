import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IFCN_SOURCE, parseOfficialInventory } from '../lib/context.mjs';
import { calendarDate } from '../lib/study.mjs';
import { readJson, atomicWrite } from '../lib/archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const today = calendarDate(Date.now(), 'Atlantic/Madeira');
const target = path.join(root, `data/context/ifcn/${today}.json`);
const existing = await readJson(target, null);
if (existing) console.log('Official route-status context already captured today.');
else {
  try {
    const response = await fetch(IFCN_SOURCE, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error('Official context source returned HTTP ' + response.status);
    const parsed = parseOfficialInventory(await response.text());
    const context = { ...parsed, fetchedAt: new Date().toISOString() };
    await atomicWrite(target, JSON.stringify(context, null, 2) + '\n');
    await atomicWrite(path.join(root, 'data/context/latest-ifcn.json'), JSON.stringify(context, null, 2) + '\n');
    await atomicWrite(path.join(root, 'data/context/health.json'), JSON.stringify({ checkedAt: context.fetchedAt, state: 'complete' }) + '\n');
    console.log(JSON.stringify({ officialRoutes: parsed.routes.length, fetchedAt: context.fetchedAt }));
  } catch {
    await atomicWrite(path.join(root, 'data/context/health.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
      error: 'Official context unavailable or schema changed; previous context retained.' }) + '\n');
    process.exitCode = 1;
  }
}
