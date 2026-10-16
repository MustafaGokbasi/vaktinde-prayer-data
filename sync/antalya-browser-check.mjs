// Offline response checker only. No authentication, network, ledger or calendar writes.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRemoteQuota, invariant, normalizeTimes, readJson, validateMapping } from './core.mjs';
import { failureDiagnostic, withStage } from './diagnostics.mjs';
import { ANTALYA_PROBE_WINDOW } from './antalya-probe.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));

export async function checkAntalyaBrowserPayload(mode, payload) {
  invariant(mode === 'quota' || mode === 'calendar', 'Use quota or calendar');
  const cities = validateMapping(await readJson(resolve(root, 'config/cities.json')));
  const city = cities.find(value => value.cityId === 'antalya');
  invariant(city?.officialCityId === '9225' && city.officialStateId === '507', 'Reviewed Antalya mapping changed');
  const summary = { validated: true, mode, cityId: city.cityId, officialCityId: city.officialCityId,
    dateRange: ANTALYA_PROBE_WINDOW, networkCalls: 0, reservationCreated: false };
  if (mode === 'quota') {
    const policy = await readJson(resolve(root, 'config/quota-policy.json'));
    await withStage('quota_validation', () => checkRemoteQuota(payload, policy, { endpoint: '/api/PrayerTime/DateRange', officialCityId: city.officialCityId }));
    return summary;
  }
  const document = await withStage('calendar_validation', () => normalizeTimes(payload, city, ANTALYA_PROBE_WINDOW));
  // The request's city binding must be evidenced by the browser coordinator;
  // a response containing times alone cannot prove which city was requested.
  return { ...summary, dayCount: Object.keys(document.days).length, requestIdentityVerified: false };
}

async function main() {
  invariant(process.argv.length === 3 && ['quota', 'calendar'].includes(process.argv[2]), 'Use quota or calendar');
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length; invariant(size <= 5 * 1024 * 1024, 'Input too large'); chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify(await checkAntalyaBrowserPayload(process.argv[2], payload)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify(failureDiagnostic(error))); process.exitCode = 1; });
}
