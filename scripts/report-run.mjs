import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJson } from '../lib/archive.mjs';
import { collectionRunStatus } from '../lib/run-status.mjs';

try {
  const [scan, health] = await Promise.all([
    readJson(fileURLToPath(new URL('../data/latest.json', import.meta.url))),
    readJson(fileURLToPath(new URL('../data/collector-health.json', import.meta.url))),
  ]);
  const status = collectionRunStatus(scan, health, process.env.COLLECT_OUTCOME);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, status.summary);
  // Annotation text is constructed from counts and bounded error codes only.
  console.log(`${status.failed ? '::error::' : ''}${status.message}`);
  if (status.failed) process.exitCode = 1;
} catch {
  console.error('::error::Collector status could not be verified; inspect the collection and publication steps.');
  process.exitCode = 1;
}
