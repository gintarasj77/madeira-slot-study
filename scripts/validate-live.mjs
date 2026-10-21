import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTrails, validateQuery, fetchIntervals, normalizeSlots } from '../src/upstream.mjs';
import { packSlots } from '../lib/study.mjs';
import { atomicWrite } from '../lib/archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const date = process.argv[2] || new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const resourceId = process.argv[3] || '301';
const catalog = await getTrails();
const trail = catalog.find(t => t.resourceId === resourceId);
assert.ok(trail, 'Resource must belong to the live catalog');
const raw = await fetchIntervals(validateQuery(new URL('https://validation.invalid/?' + new URLSearchParams({ resourceId, date }))));
const normalized = normalizeSlots(raw, date);
assert.ok(raw.length, 'Choose a date with returned slots for the live comparison');
for (const item of raw) {
  const actual = normalized.find(s => s.begin.local === item.begin.date);
  assert.ok(actual);
  const category = item.slotTitle.split('•').filter(p => /Não residentes/i.test(p));
  assert.equal(category.length, 1);
  const expected = Number(category[0].match(/(\d+(?:[.,]\d+)?)\s*%/)[1].replace(',', '.'));
  assert.equal(actual.nonResident, expected);
  assert.equal(actual.begin.timezone, item.begin.timezone);
  assert.equal(actual.end.local, item.end.date);
  assert.equal(actual.end.timezone, item.end.timezone);
}
const evidence = { validatedAt: new Date().toISOString(), source: 'https://simplifica.madeira.gov.pt',
  method: 'Fresh anonymous service GET, cookie/XSRF POST; independent category comparison against the same live response',
  catalogResources: catalog.length, resourceId, trail: trail.name, date, slotsCompared: raw.length, slots: packSlots(normalized) };
await atomicWrite(path.join(root, 'validation/live.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ ...evidence, slots: undefined }));
