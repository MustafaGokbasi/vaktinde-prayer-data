import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRemoteQuota } from './core.mjs';

// Public field structure observed on 22 Sep; values below are synthetic.
const bucket = { controllerName: 'PrayerTime', resultName: 'PrayerTimeDateRange', period: 'Daily', benefit: 100 };
const policy = { schemaVersion: 2, adapter: 'awqat-2026-09', reviewed: true, includesAllApplicableLimits: true, role: 'Developer', buckets: [bucket] };
const request = { endpoint: '/api/PrayerTime/DateRange', officialCityId: '9225' };
const fixture = () => ({ success: true, message: null, data: {
  date: new Date().toISOString(), role: 'Developer',
  daily: [{ ...bucket, periodStart: '2020-01-01T00:00:00', periodEnd: '2099-12-31T23:59:59.999', totalUsed: 1, totalExceeded: 0,
    lines: [{ parameter: 'cityId:9225', used: 1, remainingUse: 99, exceededCount: 0 }] }],
  weekly: [], monthly: [], yearly: [],
} });

test('live quota permits changing usage lines and order without losing endpoint limits', () => {
  const q = fixture();
  assert.equal(checkRemoteQuota(q, policy, request), true);
  q.data.daily[0].lines.unshift({ parameter: 'cityId:9999', used: 2, remainingUse: 98, exceededCount: 0 });
  q.data.daily[0].totalUsed = 3;
  assert.equal(checkRemoteQuota(q, policy, request), true);
});

test('live quota blocks exhausted aggregate or matching place before downloading', () => {
  for (const edit of [
    q => q.data.daily[0].totalUsed = 100,
    q => Object.assign(q.data.daily[0].lines[0], { used: 100, remainingUse: 0 }),
    q => q.data.daily[0].lines[0].remainingUse = -1,
  ]) { const q = fixture(); edit(q); assert.throws(() => checkRemoteQuota(q, policy, request)); }
});

test('live quota requires re-review for new limits, schema, role or stale snapshots', () => {
  for (const edit of [
    q => q.data.monthly.push({ ...q.data.daily[0], period: 'Monthly', benefit: 10 }),
    q => q.data.daily[0].benefit = 99,
    q => q.data.daily[0].resultName = 'DifferentEndpoint',
    q => q.data.daily[0].newLimit = 1,
    q => q.data.daily[0].lines[0].unknownLimit = 0,
    q => q.data.daily.push({ ...q.data.daily[0] }),
    q => q.data.role = 'OtherRole',
    q => q.data.date = '2020-01-01T00:00:00Z',
    q => q.data.daily[0].periodEnd = '2020-01-01T00:00:00',
  ]) { const q = fixture(); edit(q); assert.throws(() => checkRemoteQuota(q, policy, request)); }
  assert.throws(() => checkRemoteQuota(fixture(), policy, { ...request, endpoint: '/unknown' }));
});
