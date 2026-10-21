const API = 'https://api.github.com';
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export async function tick(env, { fetcher = (url, init) => globalThis.fetch(url, init), now = Date.now() } = {}) {
  const repository = env.REPOSITORY;
  const workflow = env.WORKFLOW || 'collect.yml';
  const minimum = Number(env.MINIMUM_INTERVAL_MINUTES || 55);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository || '') ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*\.ya?ml$/.test(workflow) || !Number.isInteger(minimum) || minimum < 55 || minimum > 60) {
    throw new Error('Invalid collector-clock configuration.');
  }
  if (!/^[A-Za-z0-9_]{8,255}$/.test(env.GITHUB_ACTIONS_TOKEN || '')) throw new Error('The scoped clock credential is missing or malformed.');
  const base = `/repos/${repository}`;
  async function request(endpoint, options = {}) {
    let response;
    try {
      response = await fetcher(API + endpoint, { method: options.method || 'GET',
        headers: { 'Authorization': `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, 'User-Agent': 'MadeiraPublicStudyClock',
          'X-GitHub-Api-Version': '2026-03-10', 'Accept': options.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(12000), redirect: 'manual' });
    } catch (error) {
      // Classify platform failures without emitting URLs, headers, response
      // bodies or arbitrary exception text that could contain credentials.
      const message = String(error?.message || '');
      const kind = /illegal invocation|incorrect.*this/i.test(message) ? 'runtime_binding'
        : /timeout|timed out|abort/i.test(message + ' ' + error?.name) ? 'timeout'
        : /redirect/i.test(message) ? 'redirect'
        : /certificate|\btls\b|\bssl\b/i.test(message) ? 'tls'
        : /\bdns\b|name.*resolv/i.test(message) ? 'dns' : 'network';
      throw new Error(`GitHub clock request failed (${kind}).`);
    }
    if (!response.ok) throw new Error(`GitHub clock request failed (HTTP ${response.status}).`);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error('GitHub clock response schema changed.'); }
  }
  const metadata = await request(base);
  if (metadata?.private === true) return { state: 'skipped', reason: 'private_repository' };
  if (metadata?.private !== false || metadata.default_branch !== 'main') throw new Error('Repository configuration changed; review the clock.');
  if (metadata.archived || metadata.disabled) return { state: 'skipped', reason: 'repository_inactive' };
  const result = await request(`${base}/actions/workflows/${workflow}/runs?per_page=10`);
  const runs = result?.workflow_runs;
  if (!Array.isArray(runs) || runs.some(r => ![...ACTIVE, 'completed'].includes(r.status) || !Number.isFinite(Date.parse(r.created_at)))) {
    throw new Error('GitHub workflow-run schema changed.');
  }
  if (runs.some(r => ACTIVE.has(r.status))) return { state: 'skipped', reason: 'collector_already_active' };
  const latest = Math.max(...runs.map(r => Date.parse(r.created_at)), -Infinity);
  if (latest > now) return { state: 'skipped', reason: 'clock_skew' };
  const lastRun = runs.find(r => Date.parse(r.created_at) === latest);
  const health = await request(`${base}/contents/data/collector-health.json?ref=main`, { raw: true });
  if (!health || !Number.isFinite(Date.parse(health.checkedAt))) throw new Error('Collector health schema changed.');
  if (health.error === 'ARCHIVE_SIZE_GUARD') return { state: 'skipped', reason: 'archive_storage_guard' };
  if (health.cooldownUntil != null) {
    const until = Date.parse(health.cooldownUntil);
    if (!Number.isFinite(until)) throw new Error('Collector cooldown schema changed.');
    if (until > now) return { state: 'skipped', reason: 'upstream_cooldown' };
  }
  if (health.state === 'complete') {
    // v1 archive IDs encode the exact source scan start. A successful skipped
    // workflow must not reset the collection clock without new source reads.
    const parts = health.scanId?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
    if (!parts) throw new Error('Collector scan identifier changed.');
    const iso = `${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}.${parts[5]}Z`;
    const start = Date.parse(iso);
    if (!Number.isFinite(start) || new Date(start).toISOString() !== iso || start > Date.parse(health.checkedAt)) {
      throw new Error('Collector source timestamps changed.');
    }
    if (start > now) return { state: 'skipped', reason: 'clock_skew' };
    if (now - start < minimum * 60000) return { state: 'skipped', reason: 'recent_source_scan' };
  }
  if (lastRun?.conclusion && lastRun.conclusion !== 'success' && now - latest < minimum * 60000) {
    return { state: 'skipped', reason: 'recent_failed_attempt' };
  }
  // One attempt only: an uncertain response may already have created a run.
  // Later clock ticks first inspect active/recent runs before considering another dispatch.
  const dispatched = await request(`${base}/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: { ref: 'main' } });
  if (dispatched !== null && (!Number.isSafeInteger(dispatched?.workflow_run_id) || dispatched.workflow_run_id <= 0)) {
    throw new Error('Workflow dispatch response changed; inspect runs before retrying.');
  }
  return { state: 'dispatched', runId: dispatched?.workflow_run_id || null };
}

export default {
  fetch() { return new Response('Not found', { status: 404 }); },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).then(result => console.log(JSON.stringify(result))));
  }
};
