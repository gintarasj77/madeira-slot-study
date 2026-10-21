import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { verifyArchives, readJson } from '../lib/archive.mjs';
import { validateConfig } from '../lib/study.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
validateConfig(await readJson(path.join(root, 'study.json')));
const integrity = await verifyArchives(root);
const deniedNames = /^(?:\.env.*|\.wrangler|node_modules)$/;
const forbidden = [
  /gh[pousr]_[A-Za-z0-9]{24,}/,
  /github_pat_[A-Za-z0-9_]{24,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[A-Z]:[\\/]Users[\\/]/i,
  /chatgpt-conversation:\/\//i,
  /"(?:oauth_token|access_token|refresh_token)"\s*:\s*"[^"\s]{12,}"/i,
];
let files = 0;
async function walk(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (item.name === '.git' || item.name === '.collector.lock' || item.name === '.checkpoint.json' || item.name.endsWith('.tmp')) continue;
    if (deniedNames.test(item.name)) throw new Error('Unexpected private/dependency file in publication bundle: ' + item.name);
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Symlinks are not allowed in the publication bundle');
    if (item.isDirectory()) { await walk(file); continue; }
    if ((await fs.stat(file)).size > 5 * 1024 * 1024) throw new Error('Review oversized file: ' + path.relative(root, file));
    const bytes = await fs.readFile(file);
    const text = item.name.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    if (forbidden.some(pattern => pattern.test(text))) throw new Error('Privacy check failed: ' + path.relative(root, file));
    files++;
  }
}
await walk(root);
console.log(JSON.stringify({ verified: true, files, archive: integrity }));
