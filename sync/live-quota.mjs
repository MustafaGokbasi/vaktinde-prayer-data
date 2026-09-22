// Adapter for authenticated Quota/My responses reviewed on 22 September 2026.
// Usage lines grow as places are requested; limit identities must remain reviewed.
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const exactKeys = (value, keys) => requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'Quota response fields changed; review required');
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
  throw new Error('No reviewed quota endpoint mapping');
}

export function checkLiveQuota(payload, policy, request) {
  requireValue(policy.adapter === 'awqat-2026-09' && policy.reviewed === true && policy.includesAllApplicableLimits === true, 'Quota review required');
  exactKeys(payload, ['data', 'success', 'message']);
  requireValue(payload.success === true, 'Official quota request failed');
  const data = payload.data;
  exactKeys(data, ['date', 'role', 'daily', 'weekly', 'monthly', 'yearly']);
  requireValue(data.role === policy.role, 'Account role changed; review required');
  const snapshotTime = instant(data.date);
  requireValue(Number.isFinite(snapshotTime) && Math.abs(Date.now() - snapshotTime) < 5 * 60_000, 'Quota snapshot is stale or invalid');
  requireValue(Array.isArray(policy.buckets) && policy.buckets.length > 0, 'No reviewed quota limits');
  const approved = new Map(policy.buckets.map(group => [identity(group), group]));
  requireValue(approved.size === policy.buckets.length, 'Duplicate reviewed quota limits');
  const [controller, result, parameter] = endpointIdentity(request);
  const seen = new Set(); let matched = false;
  for (const period of ['daily', 'weekly', 'monthly', 'yearly']) {
    requireValue(Array.isArray(data[period]), 'Quota periods changed');
    for (const group of data[period]) {
      exactKeys(group, ['controllerName', 'resultName', 'period', 'benefit', 'periodStart', 'periodEnd', 'totalUsed', 'totalExceeded', 'lines']);
      const id = identity(group), expected = approved.get(id);
      requireValue(!seen.has(id) && expected && group.period.toLowerCase() === period && group.benefit === expected.benefit, 'Quota limits changed; review required');
      seen.add(id);
      requireValue(counter(group.benefit) && counter(group.totalUsed) && counter(group.totalExceeded), 'Invalid quota counters');
      requireValue(instant(group.periodStart) <= snapshotTime && instant(group.periodEnd) >= snapshotTime, 'Quota period expired or invalid');
      requireValue(Array.isArray(group.lines), 'Invalid quota usage lines');
      const parameters = new Set();
      const relevant = group.controllerName === controller && group.resultName === result;
      if (relevant) {
        matched = true;
        // Conservative: also enforce the aggregate even if the provider allows per-place use.
        requireValue(group.totalUsed < group.benefit, 'Official account quota exhausted');
      }
      for (const line of group.lines) {
        exactKeys(line, ['parameter', 'used', 'remainingUse', 'exceededCount']);
        requireValue((line.parameter === null || typeof line.parameter === 'string') && !parameters.has(line.parameter), 'Invalid quota parameter');
        parameters.add(line.parameter);
        requireValue(counter(line.used) && counter(line.remainingUse) && counter(line.exceededCount) && line.used + line.remainingUse <= group.benefit, 'Invalid quota usage counters');
        if (relevant && (line.parameter === null || line.parameter === parameter)) requireValue(line.remainingUse >= 1, 'Official place quota exhausted');
      }
    }
  }
  requireValue(seen.size === approved.size && matched, 'Reviewed quota coverage missing');
  return true;
}
