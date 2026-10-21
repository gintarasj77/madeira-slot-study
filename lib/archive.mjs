import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertScan, hash, scanCounts } from './study.mjs';

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && arguments.length > 1) return fallback; throw e; }
}

export async function atomicWrite(file, contents) {
  if (file.endsWith('.md') && typeof contents === 'string') contents = contents.replace(/[\t ]+$/gm, '');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', contents);
  await fs.rename(file + '.tmp', file);
}

export async function archiveFiles(root) {
  let months;
  try { months = await fs.readdir(path.join(root, 'data/scans')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const files = [];
  for (const month of months.sort()) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    for (const name of (await fs.readdir(path.join(root, 'data/scans', month))).sort()) {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json\.gz$/.test(name)) files.push(path.join(root, 'data/scans', month, name));
    }
  }
  return files;
}

export async function archiveSize(root) {
  let bytes = 0;
  for (const file of await archiveFiles(root)) bytes += (await fs.stat(file)).size;
  return bytes;
}

export async function writeScan(root, scan) {
  assertScan(scan);
  const compressed = gzipSync(JSON.stringify(scan) + '\n', { level: 9 });
  const relative = `data/scans/${scan.startedAt.slice(0, 7)}/${scan.id}.json.gz`;
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, compressed, { flag: 'wx' }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (hash(await fs.readFile(file)) !== hash(compressed)) throw new Error('Refusing to overwrite a historical scan');
  }
  const manifest = path.join(root, `data/manifests/${scan.startedAt.slice(0, 10)}.ndjson`);
  let old = '';
  try { old = await fs.readFile(manifest, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const record = { id: scan.id, file: relative, sha256: hash(compressed), bytes: compressed.length,
    startedAt: scan.startedAt, finishedAt: scan.finishedAt, ...scanCounts(scan) };
  const existing = old.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(x => x.id === scan.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Conflicting historical manifest');
  if (!existing) await atomicWrite(manifest, old + JSON.stringify(record) + '\n');
  await atomicWrite(path.join(root, 'data/latest.json'), JSON.stringify(scan) + '\n');
  return record;
}

export async function readScan(file) {
  return assertScan(JSON.parse(gunzipSync(await fs.readFile(file)).toString('utf8')));
}

export async function verifyArchives(root) {
  const expected = new Map();
  let manifests = [];
  try { manifests = await fs.readdir(path.join(root, 'data/manifests')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of manifests.sort().filter(x => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(x))) {
    for (const line of (await fs.readFile(path.join(root, 'data/manifests', name), 'utf8')).trim().split('\n').filter(Boolean)) {
      const item = JSON.parse(line);
      if (expected.has(item.file) || item.file !== `data/scans/${item.startedAt.slice(0, 7)}/${item.id}.json.gz`) throw new Error('Invalid or duplicate manifest record');
      expected.set(item.file, item);
    }
  }
  const files = await archiveFiles(root);
  let slots = 0, bytes = 0;
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/'), record = expected.get(rel);
    if (!record) throw new Error('Archive missing a manifest: ' + rel);
    const buffer = await fs.readFile(file);
    if (buffer.length !== record.bytes || hash(buffer) !== record.sha256) throw new Error('Archive integrity failure: ' + rel);
    const scan = await readScan(file), counts = scanCounts(scan);
    if (scan.id !== record.id || scan.finishedAt !== record.finishedAt || Object.keys(counts).some(k => counts[k] !== record[k])) throw new Error('Manifest coverage mismatch');
    slots += counts.slots; bytes += buffer.length;
  }
  if (expected.size !== files.length) throw new Error('A manifested scan is missing');
  return { scans: files.length, slots, bytes };
}
