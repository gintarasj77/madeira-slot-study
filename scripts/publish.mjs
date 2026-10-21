import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeCollectedEvidence } from '../lib/publication.mjs';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Publication is restricted to the authorized hosted workflow.');
const root = fileURLToPath(new URL('../', import.meta.url));
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Each attempt starts from current main and imports immutable evidence again.
// A push race retries publication only; it never repeats upstream collection.
for (let attempt = 1; attempt <= 3; attempt++) {
  git(['fetch', 'origin', 'main']);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-publication-'));
  const checkout = path.join(temp, 'checkout');
  let attached = false;
  try {
    git(['worktree', 'add', '--detach', checkout, 'origin/main']);
    attached = true;
    const integrity = await mergeCollectedEvidence(root, checkout);
    for (const script of ['analyse.mjs', 'verify.mjs']) {
      execFileSync(process.execPath, [path.join(checkout, 'scripts', script)], { cwd: checkout, stdio: 'inherit' });
    }
    git(['add', 'data', 'latest', 'reports', 'analysis'], checkout);
    if (!git(['diff', '--cached', '--name-only'], checkout).trim()) {
      console.log(JSON.stringify({ state: 'already_published', ...integrity }));
      break;
    }
    git(['commit', '-m', 'data: retain hourly availability observations'], checkout);
    try {
      git(['push', 'origin', 'HEAD:main'], checkout);
      console.log(JSON.stringify({ state: 'published', attempt, ...integrity }));
      break;
    } catch {
      if (attempt === 3) throw new Error('Publication failed after three attempts; inspect GitHub permissions or concurrent pushes.');
      console.log(JSON.stringify({ state: 'retrying_publication', attempt }));
    }
  } finally {
    if (attached) git(['worktree', 'remove', '--force', checkout]);
    // The directory was created above and is never derived from external input.
    if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('madeira-publication-')) {
      throw new Error('Unexpected publication temporary path');
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}
