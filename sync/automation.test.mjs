import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsRefresh, runRefresh } from './automation.mjs';
import { atomicJson, normalizeTimes, quotaShapeHash } from './core.mjs';
const city = { cityId: 'antalya', officialCityId: '9225', officialStateId: '507', reviewed: true };
const window = { start: '2026-09-22', end: '2026-09-22' };
const now = new Date('2026-09-22T10:00:00Z');
const payload = { success: true, data: [{ gregorianDateShortIso8601: window.start, fajr: '05:18', dhuhr: '12:55', asr: '16:22', maghrib: '19:03', isha: '20:17' }] };
const data = () => normalizeTimes(payload, city, window, now.toISOString());
const quota = { success: true, data: [{ endpoint: 'DateRange', limit: 100, used: 0 }] };
const policy = { schemaVersion: 1, reviewed: true, includesAllApplicableLimits: true, responseShapeHash: quotaShapeHash(quota), rules: [{ endpoint: '/api/PrayerTime/DateRange', officialCityId: '*', limitPointer: '/data/0/limit', usedPointer: '/data/0/used', identities: [{ pointer: '/data/0/endpoint', equals: 'DateRange' }] }] };
test('fresh valid calendar skips; stale, changed city, incomplete and October coverage refresh', () => {
  assert.equal(needsRefresh(data(), city, window, now), false);
  for (const [doc, range, clock] of [
    [null, window, now], [{ ...data(), officialCityId: '99' }, window, now],
    [{ ...data(), days: {} }, window, now], [data(), window, new Date(+now + 7*86400000)],
    [data(), { start: '2026-10-01', end: '2027-12-31' }, now],
  ]) assert.equal(needsRefresh(doc, city, range, clock), true);
});
test('durable reservation precedes request; lost push blocks requests; failed download keeps old file and count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'calendar-automation-'));
  const file = join(root, 'v1/prayer-times/antalya.json');
  try {
    await atomicJson(file, { old: true });
    let durable = { schemaVersion: 1, usage: {} }; let requests = 0;
    const options = { cities: [city], window, now, publicRoot: root, policy, ledger: durable,
      client: async (_, path) => {
        if (path.includes('Quota')) return quota;
        requests++; assert.equal(durable.usage['2026-09:9225'], 1); return payload;
      },
      persistLedger: async next => { durable = structuredClone(next); },
    };
    await assert.rejects(runRefresh({ ...options, persistLedger: async () => { throw new Error('push failed'); } }), /push failed/);
    assert.equal(requests, 0); assert.deepEqual(JSON.parse(await readFile(file)), { old: true });
    await assert.rejects(runRefresh({ ...options, client: async (_, path) => {
      if (path.includes('Quota')) return quota;
      assert.equal(durable.usage['2026-09:9225'], 1); throw new Error('network failed');
    } }), /network failed/);
    assert.deepEqual(JSON.parse(await readFile(file)), { old: true });
    assert.equal(durable.usage['2026-09:9225'], 1);
    await runRefresh({ ...options, ledger: durable, client: async (_, path) => {
      if (path.includes('Quota')) return quota;
      assert.equal(durable.usage['2026-09:9225'], 2); return payload;
    } });
    assert.equal(JSON.parse(await readFile(file)).source, 'diyanet');
    await runRefresh({ ...options, ledger: durable, client: async () => { throw new Error('fresh cache must not call API'); } });
    const forced = await runRefresh({ ...options, ledger: durable, forceCity: 'antalya', client: async (_, path) => path.includes('Quota') ? quota : payload });
    assert.equal(forced.updated, 1);
    assert.equal(durable.usage['2026-09:9225'], 3);
    await atomicJson(file, { old: true });
    await assert.rejects(runRefresh({ ...options, ledger: { schemaVersion: 1, usage: { '2026-09:9225': 10 } } }), /Monthly city/);
    assert.equal(requests, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
