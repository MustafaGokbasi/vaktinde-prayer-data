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
async function fixture(t, scenario, { forceCity = '', marker = false, expectedStatus = 1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runner-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('.', import.meta.url), join(root, 'sync'), { recursive: true });
  for (const directory of ['config', 'state', 'public/v1/prayer-times']) await mkdir(join(root, directory), { recursive: true });
  const cities = Array.from({ length: 81 }, (_, i) => ({ cityId: `city${i}`, officialCityId: `${i + 1}`, officialStateId: '1', reviewed: true }));
  Object.assign(cities[0], { cityId: 'antalya', officialCityId: '9225', officialStateId: '507' });
  if (scenario === 'wrong_mapping') cities[0].officialCityId = '17885';
  for (const [path, value] of [['config/cities.json', { schemaVersion: 1, cities }], ['config/quota-policy.json', scenario === 'live_quota' ? { schemaVersion: 2, adapter: 'awqat-2026-09', reviewed: true, includesAllApplicableLimits: true, role: 'Developer', buckets: [{ controllerName: 'PrayerTime', resultName: 'PrayerTimeDateRange', period: 'Daily', benefit: 100 }] } : policy], ['state/ledger.json', { schemaVersion: 1, usage: {} }]]) await writeFile(join(root, path), JSON.stringify(value));
  if (scenario.startsWith('default_')) await cp(new URL('../config/quota-policy.json', import.meta.url), join(root, 'config/quota-policy.json'));
  for (const city of cities) await writeFile(join(root, `public/v1/prayer-times/${city.cityId}.json`), JSON.stringify({ old: true }));
  if (marker) await writeFile(join(root, 'state/antalya-rollout-attempt.json'), 'invalid marker still blocks retries');
  await writeFile(join(root, 'preload.mjs'), `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync } from 'node:fs';
    import { readFileSync, existsSync } from 'node:fs';
    import { allowedWindow, datesBetween } from './sync/core.mjs';
    import { defaultQuota } from './sync/test-fixtures/default-quota.mjs';
    const secret = ${JSON.stringify(secret)};
    const scenario = ${JSON.stringify(scenario)};
    let phase = '', quotaCalls = 0;
    childProcess.execFileSync = (command, args) => {
      if (command !== 'git') throw new Error('Unexpected subprocess');
      if (args[0] === 'add') phase = args[2];
      appendFileSync('calls.jsonl', JSON.stringify({ git: args[0], phase, paths: args[0] === 'add' ? args.slice(2) : undefined }) + '\\n');
      if (scenario === 'checkout' && args[0] === 'status') throw Object.assign(new Error(secret), { status: 128, stderr: secret });
      if (args[0] === 'diff') return phase === 'state/ledger.json' || scenario === 'double' ? 'changed' : '';
      if (args[0] === 'push' && (scenario === 'persist' || (scenario === 'double' && phase !== 'state/ledger.json'))) throw Object.assign(new Error(secret), { status: 128, stderr: secret });
      if (args[0] === 'push' && scenario === 'default_stale' && phase === 'state/ledger.json') {
        const later = Date.now() + 6 * 60_000; Date.now = () => later;
      }
      return '';
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url, options) => {
      appendFileSync('calls.jsonl', JSON.stringify({ request: url.includes('Quota') ? 'quota' : 'calendar', body: url.includes('Quota') ? undefined : JSON.parse(options.body),
        markerExists: existsSync('state/antalya-rollout-attempt.json'), ledger: JSON.parse(readFileSync('state/ledger.json', 'utf8')) }) + '\\n');
      if (url.includes('Quota')) {
        quotaCalls++;
        if (scenario === 'live_quota') return Response.json({ success: true, message: secret, data: { date: new Date().toISOString(), role: secret, daily: [], weekly: [], monthly: [], yearly: [] } });
        if (scenario === 'initial_http') return new Response(secret, { status: 403 });
        if (scenario === 'initial_quota' || (scenario === 'city_quota' && quotaCalls === 2)) return Response.json({ secret });
        if (scenario.startsWith('default_')) {
          const q = defaultQuota(); q.data.date = new Date().toISOString();
          for (const p of ['daily', 'monthly', 'yearly']) for (const g of q.data[p]) { g.periodStart = '2020-01-01T00:00:00'; g.periodEnd = '2099-12-31T23:59:59.9999999'; }
          if (scenario === 'default_exhausted') q.data.monthly[0].totalUsed = 10;
          if (scenario === 'default_city_exhausted') { q.data.monthly[0].totalUsed = 9; q.data.monthly[0].lines = [{ parameter: 'cityId:9225', used: 10, remainingUse: 0, exceededCount: 0 }]; }
          return Response.json(q);
        }
        return Response.json(${JSON.stringify(quota)});
      }
      if (scenario === 'invalid_calendar') return Response.json({ success: true, data: [], secret });
      if (scenario.endsWith('success')) {
        const window = allowedWindow();
        return Response.json({ success: true, data: datesBetween(window.start, window.end).map(day => ({ gregorianDateShortIso8601: day, fajr: '05:18', dhuhr: '12:55', asr: '16:22', maghrib: '19:03', isha: '20:17' })) });
      }
      return new Response(secret, { status: 503 });
    };
  `);
  const run = () => spawnSync(process.execPath, ['--import', './preload.mjs', 'sync/github-runner.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule', GITHUB_REPOSITORY: 'MustafaGokbasi/vaktinde-prayer-data', GITHUB_REF: 'refs/heads/main', FORCE_CITY: forceCity, DIYANET_ACCESS_TOKEN: secret },
  });
  const result = run();
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(result.status, expectedStatus, result.stderr);
  if (expectedStatus === 1) assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes(secret));
  for (const city of cities) if (!scenario.endsWith('success') || city.cityId !== 'antalya') assert.deepEqual(JSON.parse(await readFile(join(root, `public/v1/prayer-times/${city.cityId}.json`))), { old: true });
  return { root, run, result, records: result.stderr.trim() ? result.stderr.trim().split('\n').map(JSON.parse) : [], calls };
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

test('scheduled production rollout processes only Antalya once and persists marker with ledger before POST', async t => {
  const f = await fixture(t, 'success', { expectedStatus: 0 });
  const requests = f.calls.filter(call => call.request === 'calendar');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.cityId, 9225);
  assert.equal(requests[0].markerExists, true);
  assert.equal(Object.values(requests[0].ledger.usage).reduce((a, b) => a + b, 0), 1);
  assert.ok(f.calls.some(call => call.git === 'add' && call.paths.includes('state/ledger.json') && call.paths.includes('state/antalya-rollout-attempt.json')));
  assert.ok(f.calls.findIndex(call => call.git === 'push' && call.phase === 'state/ledger.json') < f.calls.findIndex(call => call.request === 'calendar'));
  const before = f.calls.filter(call => call.request).length;
  const second = f.run(); assert.equal(second.status, 0, second.stderr);
  const after = (await readFile(join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(after.filter(call => call.request).length, before);
});
test('existing attempt marker blocks scheduled network even if malformed and FORCE_CITY requests Antalya', async t => {
  const f = await fixture(t, 'success', { marker: true, forceCity: 'antalya', expectedStatus: 0 });
  assert.equal(f.calls.filter(call => call.request).length, 0);
});
for (const forceCity of ['city1', '*', 'antalya,city1']) test(`production rejects selection ${forceCity} before any account request`, async t => {
  const f = await fixture(t, 'calendar', { forceCity });
  assert.deepEqual(f.records, [{ failedStage: 'validate_force_city', errorCode: 'STAGE_FAILED', httpStatus: null }]);
  assert.equal(f.calls.filter(call => call.request).length, 0);
});
test('changed Antalya mapping fails before authentication', async t => {
  const f = await fixture(t, 'wrong_mapping');
  assert.equal(f.calls.filter(call => call.request).length, 0);
});
for (const scenario of ['calendar', 'invalid_calendar', 'persist']) test(`scheduled rerun after ${scenario} does not retry the reservation`, async t => {
  const f = await fixture(t, scenario);
  const before = f.calls.filter(call => call.request).length;
  const second = f.run(); assert.equal(second.status, 0, second.stderr);
  const after = (await readFile(join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(after.filter(call => call.request).length, before);
});
test('scheduled rollout uses actual Default policy, updates full Antalya window and preserves all other cities', async t => {
  const f = await fixture(t, 'default_success', { expectedStatus: 0, forceCity: 'antalya' });
  assert.equal(f.calls.filter(call => call.request === 'calendar').length, 1);
  const calendar = JSON.parse(await readFile(join(f.root, 'public/v1/prayer-times/antalya.json')));
  assert.equal(calendar.cityId, 'antalya'); assert.equal(calendar.officialCityId, '9225');
  const request = f.calls.find(call => call.request === 'calendar').body;
  assert.equal(calendar.coverageStart, request.startDate.slice(0, 10));
  assert.equal(calendar.coverageEnd, request.endDate.slice(0, 10));
  assert.ok(calendar.days[calendar.coverageEnd]);
});
for (const [scenario, code] of [['default_exhausted', 'QUOTA_AGGREGATE_EXHAUSTED'], ['default_city_exhausted', 'QUOTA_PLACE_EXHAUSTED'], ['default_stale', 'QUOTA_SNAPSHOT_OUT_OF_WINDOW']]) test(`scheduled rollout rejects ${scenario} without a DateRange`, async t => {
  const f = await fixture(t, scenario);
  assert.equal(f.calls.filter(call => call.request === 'calendar').length, 0);
  assert.equal(f.records[0].errorCode, code);
  if (scenario === 'default_stale') {
    const marker = JSON.parse(await readFile(join(f.root, 'state/antalya-rollout-attempt.json')));
    assert.equal(marker.officialCityId, '9225');
    assert.equal(f.run().status, 0);
  }
});
