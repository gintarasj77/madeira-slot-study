import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveFiles, readJson, readScan } from '../lib/archive.mjs';
import { collectionRunStatus } from '../lib/run-status.mjs';

try {
  const [scan, health] = await Promise.all([
    readJson(fileURLToPath(new URL('../data/latest.json', import.meta.url))),
    readJson(fileURLToPath(new URL('../data/collector-health.json', import.meta.url))),
  ]);
  let previousScan;
  if (scan.stopReason === 'repeated_source_failures') {
    const files = await archiveFiles(fileURLToPath(new URL('../', import.meta.url)));
    if (files.length > 1 && path.basename(files.at(-1)) === `${scan.id}.json.gz`) {
      previousScan = await readScan(files.at(-2));
    }
  }
  const status = collectionRunStatus(scan, health, process.env.COLLECT_OUTCOME, previousScan);
  const failWorkflow = status.failed && !status.repeatedSourceRejection;
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, status.summary);
  // Annotation text is constructed from counts and bounded error codes only.
  console.log(`${failWorkflow ? '::error::' : status.warning ? '::warning::' : ''}${status.message}`);
  if (failWorkflow) process.exitCode = 1;
} catch {
  console.error('::error::Collector status could not be verified; inspect the collection and publication steps.');
  process.exitCode = 1;
}
