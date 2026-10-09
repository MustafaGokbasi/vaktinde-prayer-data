import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { quotaShapeHash } from './core.mjs';
const secret = 'PRIVATE-SENTINEL-URL-TOKEN-PASSWORD-BODY';
const quota = { success: true, data: [{ endpoint: 'DateRange', limit: 100, used: 0 }] };
const policy = { schemaVersion: 1, reviewed: true, includesAllApplicableLimits: true, responseShapeHash: quotaShapeHash(quota), rules: [{ endpoint: '/api/PrayerTime/DateRange', officialCityId: '*', limitPointer: '/data/0/limit', usedPointer: '/data/0/used', identities: [{ pointer: '/data/0/endpoint', equals: 'DateRange' }] }] };

// Run the actual entry point in an isolated fixture. Every fetch and git call is
// intercepted before the runner imports; no network or repository writes occur.
async function fixture(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'runner-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('.', import.meta.url), join(root, 'sync'), { recursive: true });
  for (const directory of ['config', 'state', 'public/v1/prayer-times']) await mkdir(join(root, directory), { recursive: true });
  const cities = Array.from({ length: 81 }, (_, i) => ({ cityId: `city${i}`, officialCityId: `${i + 1}`, officialStateId: '1', reviewed: true }));
  for (const [path, value] of [['config/cities.json', { schemaVersion: 1, cities }], ['config/quota-policy.json', scenario === 'live_quota' ? { schemaVersion: 2, adapter: 'awqat-2026-09', reviewed: true, includesAllApplicableLimits: true, role: 'Developer', buckets: [{ controllerName: 'PrayerTime', resultName: 'PrayerTimeDateRange', period: 'Daily', benefit: 100 }] } : policy], ['state/ledger.json', { schemaVersion: 1, usage: {} }], ['public/v1/prayer-times/city0.json', { old: true }]]) await writeFile(join(root, path), JSON.stringify(value));
  await writeFile(join(root, 'preload.mjs'), `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync } from 'node:fs';
    const secret = ${JSON.stringify(secret)};
    const scenario = ${JSON.stringify(scenario)};
    let phase = '', quotaCalls = 0;
    childProcess.execFileSync = (command, args) => {
      if (command !== 'git') throw new Error('Unexpected subprocess');
      if (args[0] === 'add') phase = args[2];
      appendFileSync('calls.jsonl', JSON.stringify({ git: args[0], phase }) + '\\n');
      if (scenario === 'checkout' && args[0] === 'status') throw Object.assign(new Error(secret), { status: 128, stderr: secret });
      if (args[0] === 'diff') return phase === 'state/ledger.json' || scenario === 'double' ? 'changed' : '';
      if (args[0] === 'push' && (scenario === 'persist' || (scenario === 'double' && phase !== 'state/ledger.json'))) throw Object.assign(new Error(secret), { status: 128, stderr: secret });
      return '';
    };
    syncBuiltinESMExports();
    globalThis.fetch = async url => {
      appendFileSync('calls.jsonl', JSON.stringify({ request: url.includes('Quota') ? 'quota' : 'calendar' }) + '\\n');
      if (url.includes('Quota')) {
        quotaCalls++;
        if (scenario === 'live_quota') return Response.json({ success: true, message: secret, data: { date: new Date().toISOString(), role: secret, daily: [], weekly: [], monthly: [], yearly: [] } });
        if (scenario === 'initial_http') return new Response(secret, { status: 403 });
        if (scenario === 'initial_quota' || (scenario === 'city_quota' && quotaCalls === 2)) return Response.json({ secret });
        return Response.json(${JSON.stringify(quota)});
      }
      if (scenario === 'invalid_calendar') return Response.json({ success: true, data: [], secret });
      return new Response(secret, { status: 503 });
    };
  `);
  const result = spawnSync(process.execPath, ['--import', './preload.mjs', 'sync/github-runner.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'MustafaGokbasi/vaktinde-prayer-data', GITHUB_REF: 'refs/heads/main', FORCE_CITY: '', DIYANET_ACCESS_TOKEN: secret },
  });
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes(secret));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'public/v1/prayer-times/city0.json'))), { old: true });
  return { records: result.stderr.trim().split('\n').map(JSON.parse), calls };
}

test('actual runner reports request, quota, persistence and validation stages without leaking', async t => {
  for (const [scenario, failedStage, errorCode, httpStatus, requests] of [
    ['checkout', 'checkout_guard', 'STAGE_FAILED', null, 0],
    ['initial_http', 'initial_quota_request', 'ACCESS_DENIED', 403, 0],
    ['initial_quota', 'initial_quota_validation', 'STAGE_FAILED', null, 0],
    ['live_quota', 'initial_quota_validation', 'QUOTA_ROLE_CHANGED', null, 0],
    ['city_quota', 'quota_validation', 'STAGE_FAILED', null, 0],
    ['persist', 'persist_ledger', 'STAGE_FAILED', null, 0],
    ['calendar', 'calendar_request', 'HTTP_ERROR', 503, 1],
    ['invalid_calendar', 'calendar_validation', 'STAGE_FAILED', null, 1],
  ]) {
    const { records, calls } = await fixture(t, scenario);
    assert.deepEqual(records, [{ failedStage, errorCode, httpStatus }], scenario);
    assert.equal(calls.filter(call => call.request === 'calendar').length, requests, scenario);
    if (requests) assert.ok(calls.findIndex(call => call.git === 'push' && call.phase === 'state/ledger.json') < calls.findIndex(call => call.request === 'calendar'));
  }
});

test('calendar and final publication failures are both diagnosed without losing original failure', async t => {
  const { records } = await fixture(t, 'double');
  assert.deepEqual(records, [
    { failedStage: 'publish_calendars', errorCode: 'STAGE_FAILED', httpStatus: null },
    { failedStage: 'calendar_request', errorCode: 'HTTP_ERROR', httpStatus: 503 },
  ]);
});
