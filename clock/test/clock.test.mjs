import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { tick } from '../src/clock.mjs';

const now = Date.parse('2026-10-21T10:00:00Z');
const env = { REPOSITORY: 'example/public-study', WORKFLOW: 'collect.yml', GITHUB_ACTIONS_TOKEN: 'synthetic_test_value' };
function fixture(overrides = {}) {
  const calls = [];
  const metadata = overrides.metadata || { private: false, default_branch: 'main' };
  const runs = overrides.runs || [{ status: 'completed', created_at: '2026-10-21T08:00:00Z' }];
  const health = overrides.health || { checkedAt: '2026-10-21T08:17:00Z', state: 'complete', scanId: '2026-10-21T08-00-00-000Z', cooldownUntil: null };
  return { calls, fetcher: async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    assert.ok(url.startsWith('https://api.github.com/repos/example/public-study'));
    assert.equal(init.redirect, 'manual');
    if (overrides.failure) return new Response('ignored', { status: overrides.failure });
    if (init.method === 'POST') return overrides.dispatchFailure ? new Response('ignored', { status: 502 })
      : overrides.legacy ? new Response(null, { status: 204 }) : Response.json({ workflow_run_id: 123 });
    if (url.endsWith('/jobs?per_page=1')) return Response.json(overrides.jobs || { total_count: 0, jobs: [] });
    return Response.json(url.includes('/runs?') ? { workflow_runs: runs } : url.includes('/contents/') ? health : metadata);
  } };
}

test('stale public collector is dispatched once on main; no source or account endpoints', async () => {
  for (const legacy of [false, true]) {
    const f = fixture({ legacy });
    const result = await tick(env, { ...f, now });
    assert.equal(result.state, 'dispatched');
    const posts = f.calls.filter(c => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.endsWith('/actions/workflows/collect.yml/dispatches'));
    assert.deepEqual(JSON.parse(posts[0].body), { ref: 'main' });
  }
});

const completedRun = (id, start, conclusion, finish = start) => ({ id, status: 'completed', conclusion,
  created_at: `2026-10-21T${start}:00Z`, updated_at: `2026-10-21T${finish}:00Z` });

test('a first GitHub startup failure gets one early dispatch after confirming zero jobs', async () => {
  const prior = completedRun(1, '08:45', 'success');
  const failed = completedRun(2, '09:45', 'startup_failure', '09:54');
  const f = fixture({ runs: [prior, failed] });
  assert.deepEqual(await tick(env, { ...f, now }), { state: 'dispatched', runId: 123, startupRetryFor: 2 });
  assert.ok(f.calls.some(c => c.url.endsWith('/actions/runs/2/jobs?per_page=1')));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);

  for (const options of [
    { runs: [prior, { ...failed, updated_at: '2026-10-21T09:56:00Z' }] },
    { runs: [prior, failed], jobs: { total_count: 1, jobs: [{ id: 23 }] } },
    { runs: [prior, failed], health: { checkedAt: '2026-10-21T09:59:00Z', cooldownUntil: '2026-10-21T10:30:00Z' } },
    { runs: [prior, failed], health: { checkedAt: '2026-10-21T09:47:00Z', state: 'complete', scanId: '2026-10-21T09-30-00-000Z' } },
  ]) {
    const blocked = fixture(options);
    assert.equal((await tick(env, { ...blocked, now })).state, 'skipped');
    assert.ok(blocked.calls.every(c => c.method === 'GET'));
  }
});

test('a failed early replacement preserves the original deadline without chaining early dispatches', async () => {
  const prior = completedRun(1, '08:00', 'success');
  const failed = completedRun(2, '09:00', 'startup_failure', '09:15');
  const replacement = completedRun(3, '09:30', 'startup_failure', '09:35');
  const following = completedRun(4, '09:55', 'startup_failure', '09:58');
  const runs = [replacement, failed, prior];
  const waiting = fixture({ runs });
  assert.equal((await tick(env, { ...waiting, now: now - 10 * 60_000 })).reason, 'recent_failed_attempt');
  const due = fixture({ runs });
  assert.deepEqual(await tick(env, { ...due, now }), { state: 'dispatched', runId: 123 });
  const ongoing = fixture({ runs: [following, ...runs] });
  assert.equal((await tick(env, { ...ongoing, now })).reason, 'recent_failed_attempt');
  for (const f of [waiting, due, ongoing]) assert.ok(f.calls.every(c => !c.url.includes('/jobs?')));
});

test('active runs never dispatch duplicate collection', async () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    const f = fixture({ runs: [{ status, created_at: '2026-10-21T09:30:00Z' }] });
    const result = await tick(env, { ...f, now });
    assert.equal(result.state, 'skipped');
    assert.equal(f.calls.length, 2);
  }
});

test('fresh source data and recent failures are gated, while a skipped workflow does not reset source age', async () => {
  for (const override of [
    { health: { checkedAt: '2026-10-21T09:47:00Z', state: 'complete', scanId: '2026-10-21T09-30-00-000Z' } },
    { runs: [{ status: 'completed', conclusion: 'failure', created_at: '2026-10-21T09:45:00Z' }] }
  ]) {
    const f = fixture(override);
    assert.equal((await tick(env, { ...f, now })).state, 'skipped');
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
  const skipped = fixture({ runs: [{ status: 'completed', conclusion: 'success', created_at: '2026-10-21T09:45:00Z' }] });
  assert.equal((await tick(env, { ...skipped, now })).state, 'dispatched');
});

test('private visibility, storage guard and upstream cooldown stop dispatch', async () => {
  for (const override of [{ metadata: { private: true } },
    { health: { checkedAt: '2026-10-21T09:00:00Z', error: 'ARCHIVE_SIZE_GUARD' } },
    { health: { checkedAt: '2026-10-21T09:00:00Z', cooldownUntil: '2026-10-21T11:00:00Z' } }]) {
    const f = fixture(override);
    assert.equal((await tick(env, { ...f, now })).state, 'skipped');
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});

test('HTTP failures, malformed metadata and uncertain dispatches fail without retry or secret disclosure', async () => {
  for (const override of [{ failure: 429 }, { failure: 401 }, { dispatchFailure: true },
    { runs: [{ status: 'new-schema', created_at: 'bad' }] }, { health: {} }]) {
    const f = fixture(override);
    await assert.rejects(tick(env, { ...f, now }), e => !e.message.includes(env.GITHUB_ACTIONS_TOKEN));
    assert.ok(f.calls.filter(c => c.method === 'POST').length <= 1);
  }
});

test('configuration validation and HTTP surface cannot trigger collection', async () => {
  let called = false;
  await assert.rejects(tick({ ...env, REPOSITORY: '../invalid' }, { fetcher: async () => { called = true; } }));
  assert.equal(called, false);
  assert.equal((await worker.fetch()).status, 404);
});

test('transport diagnostics classify failures without forwarding arbitrary error text', async () => {
  for (const [message, kind] of [['Illegal invocation: incorrect this reference', 'runtime_binding'],
    ['The operation was aborted', 'timeout'], ['TLS certificate failure', 'tls'], ['DNS name resolution failed', 'dns'],
    ['Unexpected redirect', 'redirect'], ['Synthetic private error text', 'network']]) {
    await assert.rejects(tick(env, { fetcher: async () => { throw new Error(message + ' ' + env.GITHUB_ACTIONS_TOKEN); } }),
      error => error.message === `GitHub clock request failed (${kind}).`);
  }
});

test('default transport preserves the platform fetch receiver', async () => {
  const original = globalThis.fetch;
  const f = fixture();
  try {
    globalThis.fetch = function(url, init) {
      assert.equal(this, globalThis);
      return f.fetcher(url, init);
    };
    assert.equal((await tick(env, { now })).state, 'dispatched');
  } finally { globalThis.fetch = original; }
});

test('redirect responses never forward the clock credential to a second URL', async () => {
  const f = fixture({ failure: 302 });
  await assert.rejects(tick(env, { ...f, now }), /HTTP 302/);
  assert.equal(f.calls.length, 1);
});
