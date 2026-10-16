import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, readJson } from './core.mjs';
import { defaultQuota, legacyPolicy, snapshotDate, rejectedCases } from './test-fixtures/default-quota.mjs';
const policy = JSON.parse(await readFile(new URL('../config/quota-policy.json', import.meta.url)));
const mapping = JSON.parse(await readFile(new URL('../config/cities.json', import.meta.url)));
const runProbe = async options => (await import('./antalya-probe.mjs')).runAntalyaProbe(options);
const ledger = { schemaVersion: 1, usage: { '2026-10:9541': 3, '2026-10:9225': 2 } };
const times = { fajr: '05:18', dhuhr: '12:55', asr: '16:22', maghrib: '19:03', isha: '20:17' };
const response = { success: true, data: ['2026-10-16', '2026-10-17'].map(day => ({ gregorianDateShortIso8601: day, ...times })) };
async function setup(t, { quota = defaultQuota(), selectedPolicy = policy, selectedMapping = mapping } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(snapshotDate) });
  const root = await mkdtemp(join(tmpdir(), 'antalya-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await atomicJson(join(root, 'config/cities.json'), selectedMapping);
  await atomicJson(join(root, 'config/quota-policy.json'), selectedPolicy);
  await atomicJson(join(root, 'state/ledger.json'), ledger);
  // Every original calendar must survive both successful and rejected probes.
  const originals = new Map();
  for (const city of mapping.cities) {
    const path = join(root, 'public/v1/prayer-times', `${city.cityId}.json`);
    await atomicJson(path, { original: city.cityId });
    originals.set(path, await readFile(path, 'utf8'));
  }
  const calls = [];
  const options = { root, now: new Date(),
    persistAccountLedger: next => atomicJson(join(root, 'canonical-ledger.json'), next),
    client: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/api/Quota/My?includeUnused=true') return quota;
    assert.equal(method, 'POST'); assert.equal(path, '/api/PrayerTime/DateRange');
    assert.deepEqual(body, { cityId: 9225, startDate: '2026-10-16T00:00:00', endDate: '2026-10-17T00:00:00' });
    assert.equal((await readJson(join(root, 'state/ledger.json'))).usage['2026-10:9225'], 3);
    assert.equal((await readJson(join(root, 'canonical-ledger.json'))).usage['2026-10:9225'], 3);
    assert.equal((await readJson(join(root, 'state/antalya-probe-2026-10-16.attempt.json'))).officialCityId, '9225');
    return response;
  } };
  return { root, options, calls, async unchanged() { for (const [path, before] of originals) assert.equal(await readFile(path, 'utf8'), before); } };
}
test('Antalya probe selects only configured 9225, reserves durably, writes isolated two-day result and refuses rerun', async t => {
  const f = await setup(t);
  assert.deepEqual(await runProbe({ ...f.options, forceCity: 'istanbul', cities: mapping.cities }), { updated: 1, skipped: 0 });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  const result = await readJson(join(f.root, 'probe-results/antalya-2026-10-16/v1/prayer-times/antalya.json'));
  assert.equal(result.officialCityId, '9225');
  assert.deepEqual(Object.keys(result.days), ['2026-10-16', '2026-10-17']);
  assert.deepEqual((await readJson(join(f.root, 'state/ledger.json'))).usage, { '2026-10:9541': 3, '2026-10:9225': 3 });
  await assert.rejects(runProbe(f.options));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  await f.unchanged();
});
for (const [name, edit] of rejectedCases) test(`rejected probe preserves all calendars and sends zero DateRange: ${name}`, async t => {
  const quota = defaultQuota(); edit(quota); const f = await setup(t, { quota });
  await assert.rejects(runProbe(f.options));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.deepEqual(await readJson(join(f.root, 'state/ledger.json')), ledger);
  await f.unchanged();
});
for (const roleOnly of [false, true]) test(`probe rejects legacy policy, role-only=${roleOnly}`, async t => {
  const old = legacyPolicy(); if (roleOnly) old.role = 'Default';
  const f = await setup(t, { selectedPolicy: old });
  await assert.rejects(runProbe(f.options)); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0); await f.unchanged();
});
test('failed download retains reservation and prevents a second attempt', async t => {
  const f = await setup(t); let posts = 0;
  const options = { ...f.options, client: async (method, ...args) => {
    if (method === 'POST') { posts++; throw new Error('uncertain download'); }
    return f.options.client(method, ...args);
  } };
  await assert.rejects(runProbe(options), /uncertain download/);
  await assert.rejects(runProbe(options)); assert.equal(posts, 1);
  assert.equal((await readJson(join(f.root, 'state/ledger.json'))).usage['2026-10:9225'], 3);
  await f.unchanged();
});
test('exclusive persistent attempt marker allows at most one concurrent DateRange', async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([runProbe(f.options), runProbe(f.options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1); await f.unchanged();
});
test('ledger write failure prevents DateRange and keeps the no-repeat marker', async t => {
  const f = await setup(t);
  // An existing directory cannot be atomically replaced by the ledger file.
  // Make ledger replacement fail structurally after the quota read.
  const options = { ...f.options, client: async (...args) => {
    const q = await f.options.client(...args);
    await rm(join(f.root, 'state/ledger.json'));
    await mkdir(join(f.root, 'state/ledger.json'));
    return q;
  } };
  await assert.rejects(runProbe(options));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  await f.unchanged();
});
for (const edit of [m => m.cities = m.cities.filter(c => c.cityId !== 'antalya'), m => m.cities.find(c => c.cityId === 'antalya').officialCityId = '17885']) {
  test('missing or changed Antalya mapping fails before network', async t => {
    const changed = structuredClone(mapping); edit(changed);
    const f = await setup(t, { selectedMapping: changed });
    await assert.rejects(runProbe(f.options)); assert.equal(f.calls.length, 0); await f.unchanged();
  });
}
test('failed canonical ledger persistence blocks DateRange, preserves reservation and refuses retry', async t => {
  const f = await setup(t);
  const options = { ...f.options, persistAccountLedger: async () => { throw new Error('durability failed'); } };
  await assert.rejects(runProbe(options), /durability failed/);
  assert.equal((await readJson(join(f.root, 'state/ledger.json'))).usage['2026-10:9225'], 3);
  await assert.rejects(runProbe(options));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0); await f.unchanged();
});
test('no durability implementation means zero requests', async t => {
  const f = await setup(t);
  await assert.rejects(runProbe({ ...f.options, persistAccountLedger: undefined }), /durable ledger/);
  assert.equal(f.calls.length, 0); await f.unchanged();
});
test('monthly local safety quota 9 allows last reservation, 10 blocks', async t => {
  const f = await setup(t);
  await atomicJson(join(f.root, 'state/ledger.json'), { schemaVersion: 1, usage: { '2026-10:9225': 9 } });
  let posts = 0;
  await runProbe({ ...f.options, client: async (method, path) => {
    if (method === 'GET') return defaultQuota();
    posts++;
    assert.equal((await readJson(join(f.root, 'canonical-ledger.json'))).usage['2026-10:9225'], 10);
    return response;
  } });
  assert.equal(posts, 1); await f.unchanged();
});
test('exhausted local safety quota blocks even quota GET', async t => {
  const f = await setup(t);
  await atomicJson(join(f.root, 'state/ledger.json'), { schemaVersion: 1, usage: { '2026-10:9225': 10 } });
  await assert.rejects(runProbe(f.options), /Monthly city safety quota exhausted/);
  assert.equal(f.calls.length, 0); await f.unchanged();
});
test('remote aggregate 9 permits exactly one DateRange', async t => {
  const quota = defaultQuota(); quota.data.monthly[0].totalUsed = 9;
  const f = await setup(t, { quota });
  await runProbe(f.options);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1); await f.unchanged();
});
test('completely empty response blocks DateRange and preserves every calendar', async t => {
  const f = await setup(t, { quota: {} });
  await assert.rejects(runProbe(f.options), /QUOTA_ENVELOPE_FIELDS/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0); await f.unchanged();
});
test('missing existing ledger cannot reset the account quota', async t => {
  const f = await setup(t); await rm(join(f.root, 'state/ledger.json'));
  await assert.rejects(runProbe(f.options)); assert.equal(f.calls.length, 0); await f.unchanged();
});
test('invalid calendar result keeps production files and blocks retry after a consumed request', async t => {
  const f = await setup(t);
  const options = { ...f.options, client: async (method, ...args) => method === 'POST' ? { success: true, data: [] } : f.options.client(method, ...args) };
  await assert.rejects(runProbe(options), /Incomplete official calendar coverage/);
  assert.equal((await readJson(join(f.root, 'canonical-ledger.json'))).usage['2026-10:9225'], 3);
  await assert.rejects(runProbe(options)); await f.unchanged();
});
test('quota that becomes stale during canonical persistence blocks DateRange and keeps reservation', async t => {
  const f = await setup(t);
  const options = { ...f.options, persistAccountLedger: async next => {
    await f.options.persistAccountLedger(next);
    t.mock.timers.setTime(Date.parse(snapshotDate) + 6 * 60_000);
  } };
  await assert.rejects(runProbe(options), /QUOTA_SNAPSHOT_OUT_OF_WINDOW/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal((await readJson(join(f.root, 'canonical-ledger.json'))).usage['2026-10:9225'], 3);
  await assert.rejects(runProbe(options)); await f.unchanged();
});
