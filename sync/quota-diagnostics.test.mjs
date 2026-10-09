import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRemoteQuota } from './core.mjs';
import { failureDiagnostic, withStage } from './diagnostics.mjs';
const secret = 'PRIVATE-SENTINEL-PASSWORD-TOKEN-URL-BODY';
const fixture = () => {
  const bucket = { controllerName: 'PrayerTime', resultName: 'PrayerTimeDateRange', period: 'Daily', benefit: 100 };
  return {
    policy: { schemaVersion: 2, adapter: 'awqat-2026-09', reviewed: true, includesAllApplicableLimits: true, role: 'Developer', buckets: [bucket] },
    request: { endpoint: '/api/PrayerTime/DateRange', officialCityId: '9225' },
    payload: { success: true, message: secret, data: { date: new Date().toISOString(), role: 'Developer',
      daily: [{ ...bucket, periodStart: '2020-01-01T00:00:00Z', periodEnd: '2099-12-31T23:59:59Z', totalUsed: 1, totalExceeded: 0,
        lines: [{ parameter: 'cityId:9225', used: 1, remainingUse: 99, exceededCount: 0 }] }],
      weekly: [], monthly: [], yearly: [],
    } },
  };
};
const bucket = f => f.payload.data.daily[0];
const line = f => bucket(f).lines[0];
const cases = [
  ['QUOTA_POLICY_UNREVIEWED', f => f.policy.reviewed = false],
  ['QUOTA_ENVELOPE_FIELDS', f => f.payload[secret] = secret],
  ['QUOTA_RESPONSE_UNSUCCESSFUL', f => f.payload.success = false],
  ['QUOTA_DATA_FIELDS', f => f.payload.data[secret] = secret],
  ['QUOTA_ROLE_CHANGED', f => f.payload.data.role = secret],
  ['QUOTA_SNAPSHOT_INVALID', f => f.payload.data.date = secret],
  ['QUOTA_SNAPSHOT_OUT_OF_WINDOW', f => f.payload.data.date = '2020-01-01T00:00:00Z'],
  ['QUOTA_POLICY_BUCKETS_INVALID', f => f.policy.buckets = []],
  ['QUOTA_POLICY_BUCKET_DUPLICATE', f => f.policy.buckets.push({ ...f.policy.buckets[0] })],
  ['QUOTA_ENDPOINT_UNMAPPED', f => f.request.endpoint = secret],
  ['QUOTA_PERIOD_LIST_INVALID', f => f.payload.data.weekly = secret],
  ['QUOTA_BUCKET_FIELDS', f => bucket(f)[secret] = secret],
  ['QUOTA_BUCKET_DUPLICATE', f => f.payload.data.daily.push(structuredClone(bucket(f)))],
  ['QUOTA_BUCKET_UNREVIEWED', f => bucket(f).resultName = secret],
  ['QUOTA_BUCKET_PERIOD_MISMATCH', f => f.payload.data.weekly.push(f.payload.data.daily.pop())],
  ['QUOTA_BENEFIT_CHANGED', f => bucket(f).benefit = 99],
  ['QUOTA_BUCKET_COUNTER_INVALID', f => bucket(f).totalUsed = -1],
  ['QUOTA_PERIOD_WINDOW_INVALID', f => bucket(f).periodEnd = '2020-01-01T00:00:00Z'],
  ['QUOTA_LINES_INVALID', f => bucket(f).lines = secret],
  ['QUOTA_AGGREGATE_EXHAUSTED', f => bucket(f).totalUsed = 100],
  ['QUOTA_LINE_FIELDS', f => line(f)[secret] = secret],
  ['QUOTA_PARAMETER_INVALID', f => line(f).parameter = { secret }],
  ['QUOTA_PARAMETER_DUPLICATE', f => bucket(f).lines.push(structuredClone(line(f)))],
  ['QUOTA_LINE_COUNTER_INVALID', f => line(f).remainingUse = -1],
  ['QUOTA_PLACE_EXHAUSTED', f => Object.assign(line(f), { used: 100, remainingUse: 0 })],
  ['QUOTA_BUCKET_COVERAGE_MISSING', f => f.payload.data.daily = []],
  ['QUOTA_ENDPOINT_COVERAGE_MISSING', f => {
    f.policy.buckets[0].controllerName = bucket(f).controllerName = 'Place';
    f.policy.buckets[0].resultName = bucket(f).resultName = 'Country';
  }],
];
for (const [errorCode, edit] of cases) test(`quota rejection reports ${errorCode} without response content`, async () => {
  const f = fixture(); edit(f);
  await assert.rejects(withStage('initial_quota_validation', () => checkRemoteQuota(f.payload, f.policy, f.request)), error => {
    assert.deepEqual(failureDiagnostic(error), { failedStage: 'initial_quota_validation', errorCode, httpStatus: null });
    assert.ok(!JSON.stringify(failureDiagnostic(error)).includes(secret));
    return true;
  });
});

test('quota diagnostic factory rejects arbitrary codes and cannot report an HTTP status', async () => {
  const { quotaFailure } = await import('./diagnostics.mjs');
  assert.equal(typeof quotaFailure, 'function');
  for (const code of [secret, 'HTTP_ERROR', { code: secret }, null]) {
    assert.deepEqual(failureDiagnostic(quotaFailure(code, 403)), { failedStage: 'unknown', errorCode: 'UNEXPECTED_FAILURE', httpStatus: null });
  }
});

test('unexpected quota exceptions remain generic and never expose malformed field content', async () => {
  const f = fixture(); bucket(f).period = ['Daily']; // Existing coercion then TypeError; still fails closed.
  await assert.rejects(withStage('initial_quota_validation', () => checkRemoteQuota(f.payload, f.policy, f.request)), error => {
    assert.deepEqual(failureDiagnostic(error), { failedStage: 'initial_quota_validation', errorCode: 'STAGE_FAILED', httpStatus: null }); return true;
  });
});
