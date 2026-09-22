import { join } from 'node:path';
import { readJson, normalizeTimes, checkRemoteQuota, reserveLocalQuota, publishCity } from './core.mjs';

export function needsRefresh(previous, city, window, now = new Date()) {
  if (previous?.schemaVersion !== 1 || previous.source !== 'diyanet' || previous.cityId !== city.cityId || previous.officialCityId !== city.officialCityId || previous.timezone !== 'Europe/Istanbul') return true;
  const age = +now - Date.parse(previous.fetchedAt);
  if (!(age >= 0 && age < 7 * 86400000) || previous.coverageStart > window.start || previous.coverageEnd < window.end) return true;
  try {
    normalizeTimes({ success: true, data: Object.entries(previous.days).map(([day, times]) => ({ ...times, gregorianDateShortIso8601: day })) }, city, { start: previous.coverageStart, end: previous.coverageEnd }, previous.fetchedAt);
    return false;
  } catch { return true; }
}

/** persistLedger must finish remote durable storage BEFORE any quota-consuming request.
 * Failed/uncertain calls remain counted. No rollback or automatic network retry.
 */
export async function runRefresh({ cities, window, now = new Date(), publicRoot, policy, ledger, client, persistLedger, forceCity }) {
  let updated = 0, skipped = 0;
  for (const city of cities) {
    const previous = await readJson(join(publicRoot, 'v1/prayer-times', `${city.cityId}.json`), null);
    if (forceCity !== city.cityId && !needsRefresh(previous, city, window, now)) { skipped++; continue; }
    const next = reserveLocalQuota(ledger, city.officialCityId, now);
    const quota = await client('GET', '/api/Quota/My?includeUnused=true');
    checkRemoteQuota(quota, policy, { endpoint: '/api/PrayerTime/DateRange', officialCityId: city.officialCityId });
    await persistLedger(next);
    ledger = next;
    const response = await client('POST', '/api/PrayerTime/DateRange', { cityId: Number(city.officialCityId), startDate: `${window.start}T00:00:00`, endDate: `${window.end}T00:00:00` });
    await publishCity(publicRoot, normalizeTimes(response, city, window, now.toISOString()));
    updated++;
  }
  return { updated, skipped };
}
