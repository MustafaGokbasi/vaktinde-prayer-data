// Reconstructed from the account contract reviewed by the owner on 16 Oct 2026.
// No credentials; independent of the policy under test. Clock is fixed in tests.
export const snapshotDate = '2026-10-16T04:03:26.7668032+03:00';
const limits = [
  ['DailyContent', 'Get', 'Daily', 15],
  ['Place', 'City', 'Daily', 15],
  ['Place', 'CityDetail', 'Daily', 10],
  ['Place', 'Country', 'Daily', 15],
  ['Place', 'GetAllCities', 'Daily', 15],
  ['Place', 'GetAllStates', 'Daily', 15],
  ['Place', 'State', 'Daily', 15],
  ['PrayerTime', 'PrayerTimeDaily', 'Daily', 15],
  ['PrayerTime', 'PrayerTimeMonthly', 'Daily', 10],
  ['PrayerTime', 'PrayerTimeWeekly', 'Daily', 10],
  ['PrayerTime', 'PrayerTimeDateRange', 'Monthly', 10],
  ['PrayerTime', 'PrayerTimeEid', 'Yearly', 365],
  ['PrayerTime', 'PrayerTimeRamadan', 'Yearly', 300],
];
const windows = {
  Daily: ['2026-10-16T00:00:00', '2026-10-16T23:59:59.999'],
  Monthly: ['2026-10-01T00:00:00', '2026-10-31T23:59:59.9999999'],
  Yearly: ['2026-01-01T00:00:00', '2026-12-31T23:59:59.999'],
};
export function defaultQuota() {
  const data = { date: snapshotDate, role: 'Default', daily: [], weekly: [], monthly: [], yearly: [] };
  for (const [controllerName, resultName, period, benefit] of limits) {
    const dailyUsed = resultName === 'PrayerTimeDaily';
    data[period.toLowerCase()].push({ controllerName, resultName, period, benefit,
      periodStart: windows[period][0], periodEnd: windows[period][1],
      totalUsed: dailyUsed ? 1 : 0, totalExceeded: 0,
      lines: dailyUsed ? [{ parameter: 'cityId:17885', used: 1, remainingUse: 14, exceededCount: 0 }] : [],
    });
  }
  return { success: true, message: null, data };
}
export function legacyPolicy() {
  return { schemaVersion: 2, adapter: 'awqat-2026-09', reviewed: true, includesAllApplicableLimits: true, role: 'Developer',
    buckets: limits.map(([controllerName, resultName]) => ({ controllerName, resultName, period: 'Daily', benefit: 100 })) };
}

export const rejectedCases = [
  ['empty groups', q => { for (const p of ['daily', 'weekly', 'monthly', 'yearly']) q.data[p] = []; }],
  ['missing group', q => q.data.yearly.pop()],
  ['extra group', q => q.data.daily.push({ ...q.data.daily[0], resultName: 'Unknown' })],
  ['duplicate group', q => q.data.monthly.push(structuredClone(q.data.monthly[0]))],
  ['changed benefit', q => q.data.monthly[0].benefit = 100],
  ['changed period', q => q.data.monthly[0].period = 'Daily'],
  ['wrong period list', q => q.data.daily.push(q.data.monthly.pop())],
  ['stale timestamp', q => q.data.date = '2026-10-15T04:03:26+03:00'],
  ['bad aggregate', q => q.data.monthly[0].totalUsed = -1],
  ['bad exceeded', q => q.data.yearly[0].totalExceeded = 0.5],
  ['unsafe counter', q => q.data.daily[0].totalUsed = Number.MAX_SAFE_INTEGER + 1],
  ['bad line', q => q.data.daily[7].lines[0].remainingUse = -1],
  ['oversized line', q => q.data.daily[7].lines[0].remainingUse = 15],
  ['exhausted city', q => { q.data.monthly[0].totalUsed = 9; q.data.monthly[0].lines = [{ parameter: 'cityId:9225', used: 10, remainingUse: 0, exceededCount: 0 }]; }],
  ['exhausted aggregate', q => q.data.monthly[0].totalUsed = 10],
  ['monthly window', q => q.data.monthly[0].periodEnd = '2026-09-30T23:59:59.9999999'],
  ['yearly window', q => q.data.yearly[1].periodStart = '2027-01-01T00:00:00'],
  ['schema addition', q => q.data.monthly[0].extra = 1],
];
