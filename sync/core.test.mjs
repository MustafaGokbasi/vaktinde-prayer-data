import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedWindow, datesBetween, normalizeTimes, validateMapping, checkRemoteQuota, reserveLocalQuota, quotaShapeHash, syncCity, atomicJson } from './core.mjs';

// Synthetic examples shaped after the official C# models, NOT authenticated API captures.
const city = { cityId: 'antalya', officialCityId: '12345', officialStateId: '999', reviewed: true };
const window = { start: '2026-09-16', end: '2026-09-17' };
const row = day => ({ gregorianDateShortIso8601: day, fajr: '05:10', dhuhr: '12:58', asr: '16:29', maghrib: '19:15', isha: '20:30', sunrise: '06:31' });
const fixture = () => ({ success: true, data: datesBetween(window.start, window.end).map(row) });
// Quota field names below are intentionally synthetic and require actual account review.
const quota = (used = 0) => ({ data: [{ endpoint: 'DateRange', place: '12345', limit: 10, used }], success: true });
const policy = { responseShapeHash: quotaShapeHash(quota()), schemaVersion: 1, reviewed: true, includesAllApplicableLimits: true, rules: [{ endpoint: '/api/PrayerTime/DateRange', officialCityId: '12345', limitPointer: '/data/0/limit', usedPointer: '/data/0/used', identities: [{ pointer: '/data/0/endpoint', equals: 'DateRange' }, { pointer: '/data/0/place', equals: '12345' }] }] };
const request = { endpoint: '/api/PrayerTime/DateRange', officialCityId: '12345' };

test('Turkey calendar boundary and Q4 access to following year', () => {
  assert.deepEqual(allowedWindow(new Date('2026-09-30T20:59:59Z')), { start: '2026-09-30', end: '2026-12-31' });
  assert.deepEqual(allowedWindow(new Date('2026-09-30T21:00:00Z')), { start: '2026-10-01', end: '2027-12-31' });
  assert.deepEqual(allowedWindow(new Date('2026-12-31T21:00:00Z')), { start: '2027-01-01', end: '2027-12-31' });
  assert.equal(datesBetween('2028-02-28', '2028-03-01').length, 3);
  assert.throws(() => datesBetween('2026-02-29', '2026-03-01'));
});
test('public contract contains only five times and exact reviewed city mapping', () => {
  const result = normalizeTimes(fixture(), city, window, '2026-09-16T12:00:00Z');
  assert.equal(result.source, 'diyanet'); assert.equal(result.officialCityId, '12345');
  assert.equal(result.timezone, 'Europe/Istanbul');
  assert.deepEqual(Object.keys(result.days['2026-09-16']), ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
  assert.equal(result.coverageEnd, '2026-09-17');
});
test('live Diyanet long ISO date is accepted when the mislabeled short date agrees', () => {
  const payload = { success: true, data: [{ ...row('22.09.2026'), gregorianDateLongIso8601: '2026-09-22T00:00:00.0000000+03:00', greenwichMeanTimeZone: 3 }] };
  const result = normalizeTimes(payload, city, { start: '2026-09-22', end: '2026-09-22' });
  assert.equal(result.days['2026-09-22'].fajr, '05:10');
  for (const change of [
    { gregorianDateShortIso8601: '23.09.2026' },
    { gregorianDateLongIso8601: '2026-09-22T12:00:00.0000000+03:00' },
    { gregorianDateLongIso8601: '2026-09-22T00:00:00+02:00' },
    { greenwichMeanTimeZone: 2 },
  ]) assert.throws(() => normalizeTimes({ success: true, data: [{ ...payload.data[0], ...change }] }, city, { start: '2026-09-22', end: '2026-09-22' }));
});
test('invalid/partial/unordered official data must not become a calendar', () => {
  for (const edit of [x => x.success = false, x => x.data.pop(), x => x.data.push(x.data[0]), x => x.data[0].fajr = '25:05', x => x.data[0].isha = '10:00', x => x.data[0].gregorianDateShortIso8601 = '16.09.2026', x => x.data[0].gregorianDateShortIso8601 = '2026-09-16T14:00:00Z']) {
    const x = fixture(); edit(x); assert.throws(() => normalizeTimes(x, city, window));
  }
});
test('mapping rejects unreviewed, duplicate and unsafe IDs', () => {
  assert.equal(validateMapping({ schemaVersion: 1, cities: [city] }).length, 1);
  for (const cities of [[{ ...city, reviewed: false }], [{ ...city, cityId: '../escape' }], [city, city], [{ ...city, officialCityId: null }]]) assert.throws(() => validateMapping({ schemaVersion: 1, cities }));
});
test('official IDs must be positive safe integer strings for both city and state', () => {
  for (const field of ['officialCityId', 'officialStateId']) {
    for (const value of ['0', '-1', '01', '1.5', '9007199254740992', '999999999999999999999999', 12345]) {
      assert.throws(() => validateMapping({ schemaVersion: 1, cities: [{ ...city, [field]: value }] }));
    }
    assert.equal(validateMapping({ schemaVersion: 1, cities: [{ ...city, [field]: '9007199254740991' }] }).length, 1);
  }
});
test('quota fails closed on missing schema, unknown place, limit, changed identity', () => {
  assert.equal(checkRemoteQuota(quota(), policy, request), true);
  assert.throws(() => checkRemoteQuota(quota(10), policy, request));
  assert.throws(() => checkRemoteQuota(quota(), { ...policy, reviewed: false }, request));
  assert.throws(() => checkRemoteQuota(quota(), policy, { ...request, officialCityId: '456' }));
  const q = quota(); q.data[0].place = '456'; assert.throws(() => checkRemoteQuota(q, policy, request));
  assert.throws(() => checkRemoteQuota({ data: [] }, policy, request));
});
test('local quota persists attempts per place and resets only at Turkish month boundary', () => {
  const ledger = { schemaVersion: 1, usage: { '2026-09:12345': 9 } };
  const next = reserveLocalQuota(ledger, '12345', new Date('2026-09-30T20:00:00Z'));
  assert.equal(next.usage['2026-09:12345'], 10);
  assert.throws(() => reserveLocalQuota(next, '12345', new Date('2026-09-30T20:00:00Z')));
  assert.equal(reserveLocalQuota(next, '12345', new Date('2026-09-30T21:00:00Z')).usage['2026-10:12345'], 1);
});
test('bad download preserves public file and records quota attempt; good download atomically replaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vaktinde-sync-'));
  try {
    const privateRoot = join(root, 'private'), publicRoot = join(root, 'public');
    const target = join(publicRoot, 'v1/prayer-times/antalya.json');
    await atomicJson(target, { previous: 'keep' });
    const options = { city, window, privateRoot, publicRoot, policy, now: new Date('2026-09-16T10:00:00Z') };
    const calls = [];
    await assert.rejects(syncCity({ ...options, client: async (method, path) => { calls.push(path); return path.includes('Quota') ? quota() : { success: true, data: [] }; } }));
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { previous: 'keep' });
    assert.equal(JSON.parse(await readFile(join(privateRoot, 'ledger.json'), 'utf8')).usage['2026-09:12345'], 1);
    assert.equal(calls[0], '/api/Quota/My?includeUnused=true');
    await syncCity({ ...options, client: async (_, path) => path.includes('Quota') ? quota() : fixture() });
    assert.equal(JSON.parse(await readFile(target, 'utf8')).source, 'diyanet');
    assert.equal(JSON.parse(await readFile(join(privateRoot, 'ledger.json'), 'utf8')).usage['2026-09:12345'], 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('exhausted official quota prevents prayer request and local reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vaktinde-quota-')); let calls = 0;
  try {
    await assert.rejects(syncCity({ city, window, now: new Date(), policy, privateRoot: root, publicRoot: join(root, 'public'), client: async () => { calls++; return quota(10); } }));
    assert.equal(calls, 1);
    await assert.rejects(readFile(join(root, 'ledger.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('CLI sync is dry-run without credentials by default', () => {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const text = execFileSync(process.execPath, [cli, 'sync'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const result = JSON.parse(text); assert.equal(result.dryRun, true); assert.equal(result.provinceCount, 81);
});
