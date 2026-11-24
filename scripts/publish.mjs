import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { mergeCollectedEvidence } from '../lib/publication.mjs';

const git = (args, cwd, timeout) => execFileSync('git', args, {
  cwd, timeout, killSignal: 'SIGKILL', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const RETRY_DELAYS = [15_000, 45_000];
const REMOTE_TIMEOUT = 90_000;

// Each attempt starts from current main and imports immutable evidence again.
export async function publish(root, { runGit = git, delay = sleep, progress = event => console.log(JSON.stringify(event)) } = {}) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Publication is restricted to the authorized hosted workflow.');
  const maximumAttempts = RETRY_DELAYS.length + 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    let remoteOperation = 'fetch';
    let temp;
    let checkout;
    let attached = false;
    try {
      runGit(['fetch', 'origin', 'main'], root, REMOTE_TIMEOUT);
      remoteOperation = null;
      temp = await fs.mkdtemp(path.join(os.tmpdir(), 'madeira-publication-'));
      checkout = path.join(temp, 'checkout');
      runGit(['worktree', 'add', '--detach', checkout, 'origin/main'], root);
      attached = true;
      const integrity = await mergeCollectedEvidence(root, checkout);
      for (const script of ['analyse.mjs', 'verify.mjs']) {
        execFileSync(process.execPath, [path.join(checkout, 'scripts', script)], { cwd: checkout, stdio: 'inherit' });
      }
      runGit(['add', 'data', 'latest', 'reports', 'analysis'], checkout);
      if (!runGit(['diff', '--cached', '--name-only'], checkout).trim()) {
        progress({ state: 'already_published', ...integrity });
        return;
      }
      runGit(['commit', '-m', 'data: retain hourly availability observations'], checkout);
      remoteOperation = 'push';
      runGit(['push', 'origin', 'HEAD:main'], checkout, REMOTE_TIMEOUT);
      remoteOperation = null;
      progress({ state: 'published', attempt, ...integrity });
      return;
    } catch (error) {
      if (!remoteOperation) throw error;
      if (attempt === maximumAttempts) throw new Error(`Publication failed at git ${remoteOperation} after ${maximumAttempts} attempts.`);
      progress({ state: 'retrying_publication', operation: remoteOperation, attempt, delayMs: RETRY_DELAYS[attempt - 1] });
    } finally {
      if (attached) runGit(['worktree', 'remove', '--force', checkout], root);
      if (temp) {
        // The directory was created above and is never derived from external input.
        if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('madeira-publication-')) {
          throw new Error('Unexpected publication temporary path');
        }
        await fs.rm(temp, { recursive: true, force: true });
      }
    }
    await delay(RETRY_DELAYS[attempt - 1]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publish(fileURLToPath(new URL('../', import.meta.url)));
}
