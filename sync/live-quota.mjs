import { quotaFailure } from './diagnostics.mjs';
// Adapter for authenticated Quota/My responses reviewed on 22 September 2026.
// Usage lines grow as places are requested; limit identities must remain reviewed.
const requireValue = (condition, code) => { if (!condition) throw quotaFailure(code); };
const exactKeys = (value, keys, code) => requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);
const counter = value => Number.isSafeInteger(value) && value >= 0;
const identity = group => `${group.controllerName}/${group.resultName}/${group.period}`;
const instant = value => typeof value === 'string' ? Date.parse(value.replace(/(\.\d{3})\d+/, '$1').replace(/(T\d\d:\d\d:\d\d(?:\.\d+)?)$/, '$1+03:00')) : NaN;

function endpointIdentity(request) {
  if (request.endpoint === '/api/PrayerTime/DateRange') return ['PrayerTime', 'PrayerTimeDateRange', `cityId:${request.officialCityId}`];
  if (request.endpoint === '/api/Place/Countries') return ['Place', 'Country', null];
  const state = request.endpoint.match(/^\/api\/Place\/States\/([1-9]\d*)$/);
  if (state) return ['Place', 'State', `countryId:${state[1]}`];
  const city = request.endpoint.match(/^\/api\/Place\/Cities\/([1-9]\d*)$/);
  if (city) return ['Place', 'City', `stateId:${city[1]}`];
  throw quotaFailure('QUOTA_ENDPOINT_UNMAPPED');
}

export function checkLiveQuota(payload, policy, request) {
  requireValue(policy.adapter === 'awqat-2026-09' && policy.reviewed === true && policy.includesAllApplicableLimits === true, 'QUOTA_POLICY_UNREVIEWED');
  exactKeys(payload, ['data', 'success', 'message'], 'QUOTA_ENVELOPE_FIELDS');
  requireValue(payload.success === true, 'QUOTA_RESPONSE_UNSUCCESSFUL');
  const data = payload.data;
  exactKeys(data, ['date', 'role', 'daily', 'weekly', 'monthly', 'yearly'], 'QUOTA_DATA_FIELDS');
  requireValue(data.role === policy.role, 'QUOTA_ROLE_CHANGED');
  const snapshotTime = instant(data.date);
  requireValue(Number.isFinite(snapshotTime), 'QUOTA_SNAPSHOT_INVALID');
  requireValue(Math.abs(Date.now() - snapshotTime) < 5 * 60_000, 'QUOTA_SNAPSHOT_OUT_OF_WINDOW');
  requireValue(Array.isArray(policy.buckets) && policy.buckets.length > 0, 'QUOTA_POLICY_BUCKETS_INVALID');
  const approved = new Map(policy.buckets.map(group => [identity(group), group]));
  requireValue(approved.size === policy.buckets.length, 'QUOTA_POLICY_BUCKET_DUPLICATE');
  const [controller, result, parameter] = endpointIdentity(request);
  const seen = new Set(); let matched = false;
  for (const period of ['daily', 'weekly', 'monthly', 'yearly']) {
    requireValue(Array.isArray(data[period]), 'QUOTA_PERIOD_LIST_INVALID');
    for (const group of data[period]) {
      exactKeys(group, ['controllerName', 'resultName', 'period', 'benefit', 'periodStart', 'periodEnd', 'totalUsed', 'totalExceeded', 'lines'], 'QUOTA_BUCKET_FIELDS');
      const id = identity(group), expected = approved.get(id);
      requireValue(!seen.has(id), 'QUOTA_BUCKET_DUPLICATE');
      requireValue(expected, 'QUOTA_BUCKET_UNREVIEWED');
      requireValue(group.period.toLowerCase() === period, 'QUOTA_BUCKET_PERIOD_MISMATCH');
      requireValue(group.benefit === expected.benefit, 'QUOTA_BENEFIT_CHANGED');
      seen.add(id);
      requireValue(counter(group.benefit) && counter(group.totalUsed) && counter(group.totalExceeded), 'QUOTA_BUCKET_COUNTER_INVALID');
      requireValue(instant(group.periodStart) <= snapshotTime && instant(group.periodEnd) >= snapshotTime, 'QUOTA_PERIOD_WINDOW_INVALID');
      requireValue(Array.isArray(group.lines), 'QUOTA_LINES_INVALID');
      const parameters = new Set();
      const relevant = group.controllerName === controller && group.resultName === result;
      if (relevant) {
        matched = true;
        // Conservative: also enforce the aggregate even if the provider allows per-place use.
        requireValue(group.totalUsed < group.benefit, 'QUOTA_AGGREGATE_EXHAUSTED');
      }
      for (const line of group.lines) {
        exactKeys(line, ['parameter', 'used', 'remainingUse', 'exceededCount'], 'QUOTA_LINE_FIELDS');
        requireValue(line.parameter === null || typeof line.parameter === 'string', 'QUOTA_PARAMETER_INVALID');
        requireValue(!parameters.has(line.parameter), 'QUOTA_PARAMETER_DUPLICATE');
        parameters.add(line.parameter);
        requireValue(counter(line.used) && counter(line.remainingUse) && counter(line.exceededCount) && line.used + line.remainingUse <= group.benefit, 'QUOTA_LINE_COUNTER_INVALID');
        if (relevant && (line.parameter === null || line.parameter === parameter)) requireValue(line.remainingUse >= 1, 'QUOTA_PLACE_EXHAUSTED');
      }
    }
  }
  requireValue(seen.size === approved.size, 'QUOTA_BUCKET_COVERAGE_MISSING');
  requireValue(matched, 'QUOTA_ENDPOINT_COVERAGE_MISSING');
  return true;
}
