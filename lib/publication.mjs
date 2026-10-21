import fs from 'node:fs/promises';
import path from 'node:path';
import { archiveFiles, atomicWrite, readJson, readScan, verifyArchives, writeScan } from './archive.mjs';
import { hash } from './study.mjs';

async function newerJson(source, destination, key) {
  const incoming = await readJson(source, null);
  if (!incoming) return;
  const existing = await readJson(destination, null);
  const incomingAt = Date.parse(incoming[key]);
  const existingAt = existing ? Date.parse(existing[key]) : -Infinity;
  if (!Number.isFinite(incomingAt) || (existing && !Number.isFinite(existingAt))) throw new Error('Invalid evidence timestamp');
  if (incomingAt > existingAt) await atomicWrite(destination, JSON.stringify(incoming) + '\n');
}

// Merge raw evidence into a clean checkout of current main. Generated reports
// are rebuilt there, so a concurrent code/report commit cannot discard a scan.
export async function mergeCollectedEvidence(source, destination) {
  await verifyArchives(source);
  await verifyArchives(destination);
  const latest = await readJson(path.join(destination, 'data/latest.json'), null);
  for (const file of await archiveFiles(source)) {
    const relative = path.relative(source, file);
    const target = path.join(destination, relative);
    const incoming = await fs.readFile(file);
    let existing;
    try { existing = await fs.readFile(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) {
      if (hash(existing) !== hash(incoming)) throw new Error('Refusing conflicting historical scan');
      continue;
    }
    const record = await writeScan(destination, await readScan(file));
    if (record.sha256 !== hash(incoming)) throw new Error('Archive encoding changed; refusing publication');
  }
  // writeScan updates latest while importing; retain whichever source is newer.
  if (latest) {
    const imported = await readJson(path.join(destination, 'data/latest.json'), null);
    if (!imported || Date.parse(latest.startedAt) > Date.parse(imported.startedAt)) {
      await atomicWrite(path.join(destination, 'data/latest.json'), JSON.stringify(latest) + '\n');
    }
  }
  await newerJson(path.join(source, 'data/collector-health.json'), path.join(destination, 'data/collector-health.json'), 'checkedAt');
  const context = path.join(source, 'data/context/ifcn');
  let names = [];
  try { names = await fs.readdir(context); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of names.filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
    await newerJson(path.join(context, name), path.join(destination, 'data/context/ifcn', name), 'fetchedAt');
  }
  await newerJson(path.join(source, 'data/context/latest-ifcn.json'), path.join(destination, 'data/context/latest-ifcn.json'), 'fetchedAt');
  await newerJson(path.join(source, 'data/context/health.json'), path.join(destination, 'data/context/health.json'), 'checkedAt');
  return verifyArchives(destination);
}
