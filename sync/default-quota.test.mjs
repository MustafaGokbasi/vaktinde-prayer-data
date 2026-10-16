import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkRemoteQuota } from './core.mjs';
import { defaultQuota, legacyPolicy, snapshotDate, rejectedCases } from './test-fixtures/default-quota.mjs';
const policy = JSON.parse(await readFile(new URL('../config/quota-policy.json', import.meta.url)));
const request = { endpoint: '/api/PrayerTime/DateRange', officialCityId: '9225' };
function clock(t, date = snapshotDate) { t.mock.timers.enable({ apis: ['Date'], now: Date.parse(date) }); }
test('reviewed Default contract passes actual policy; old policy and role-only edit fail', t => {
  clock(t);
  assert.equal(checkRemoteQuota(defaultQuota(), policy, request), true);
  assert.throws(() => checkRemoteQuota(defaultQuota(), legacyPolicy(), request));
  const roleOnly = legacyPolicy(); roleOnly.role = 'Default';
  assert.throws(() => checkRemoteQuota(defaultQuota(), roleOnly, request));
  assert.throws(() => checkRemoteQuota({}, policy, request), /QUOTA_ENVELOPE_FIELDS/);
});
for (const [name, edit] of rejectedCases) test(`Default quota rejects ${name}`, t => {
  clock(t); const q = defaultQuota(); edit(q);
  assert.throws(() => checkRemoteQuota(q, policy, request));
});
test('empty usage lines retain finite limit: aggregate 9 permits, 10 blocks', t => {
  clock(t); const q = defaultQuota(); q.data.monthly[0].totalUsed = 9;
  assert.equal(checkRemoteQuota(q, policy, request), true);
  q.data.monthly[0].totalUsed = 10;
  assert.throws(() => checkRemoteQuota(q, policy, request), /QUOTA_AGGREGATE_EXHAUSTED/);
});
for (const [date, valid] of [
  ['2026-09-30T23:59:59.999+03:00', false],
  ['2026-10-01T00:00:00+03:00', true],
  ['2026-10-31T23:59:59.999+03:00', true],
  ['2026-11-01T00:00:00+03:00', false],
  ['2026-01-01T00:00:00+03:00', true],
  ['2025-12-31T23:59:59.999+03:00', false],
  ['2026-12-31T23:59:59.999+03:00', true],
  ['2027-01-01T00:00:00+03:00', false],
]) test(`period boundary ${date}: ${valid}`, t => {
  clock(t, date); const q = defaultQuota(); q.data.date = date;
  // Keep non-target windows current to isolate the monthly/yearly boundary.
  const target = /^2026-(09|10|11)/.test(date) ? 'monthly' : 'yearly';
  for (const p of ['daily', 'monthly', 'yearly']) if (p !== target) for (const g of q.data[p]) {
    g.periodStart = '2020-01-01T00:00:00'; g.periodEnd = '2099-12-31T23:59:59.9999999';
  }
  if (valid) assert.equal(checkRemoteQuota(q, policy, request), true);
  else assert.throws(() => checkRemoteQuota(q, policy, request), /QUOTA_PERIOD_WINDOW_INVALID/);
});
