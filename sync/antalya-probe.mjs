// Preparation only: importing/running this module does not authenticate or call APIs.
// A future explicitly authorized caller must inject a client with NO network retries.
import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicJson, checkRemoteQuota, invariant, readJson, validateMapping } from './core.mjs';
import { withStage } from './diagnostics.mjs';
import { runRefresh } from './automation.mjs';

export const ANTALYA_PROBE_WINDOW = Object.freeze({ start: '2026-10-16', end: '2026-10-17' });
const window = ANTALYA_PROBE_WINDOW;
async function syncPath(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Uses the existing persistent state ledger; never creates/resets a missing one.
 * The exclusive attempt marker is deliberately never removed, even on rejection.
 * Keep this checkout/state on persistent storage; do not use an ephemeral copy.
 * No scheduled downloader or other process may use this account concurrently.
 * persistAccountLedger must finish durable storage in the canonical account
 * ledger (as the trusted runner does) BEFORE returning; no credentials/push here.
 */
export async function runAntalyaProbe({ root, client, persistAccountLedger, now = new Date() }) {
  invariant(typeof client === 'function', 'Explicit no-retry client required');
  invariant(typeof persistAccountLedger === 'function', 'Canonical durable ledger persistence required');
  const cities = validateMapping(await readJson(join(root, 'config/cities.json')));
  const configured = cities.find(city => city.cityId === 'antalya');
  invariant(configured?.officialCityId === '9225' && configured.officialStateId === '507', 'Reviewed Antalya mapping changed');
  const city = { ...configured };
  const policy = await readJson(join(root, 'config/quota-policy.json'));
  const ledgerPath = join(root, 'state/ledger.json');
  const ledger = await readJson(ledgerPath);
  const attemptPath = join(root, 'state/antalya-probe-2026-10-16.attempt.json');
  // Exclusive create serializes even simultaneous probe calls in this checkout.
  // A crash at any later point leaves the marker in place: no automatic retry.
  const attempt = await open(attemptPath, 'wx', 0o600);
  try {
    await attempt.writeFile(`${JSON.stringify({ officialCityId: city.officialCityId, window, attemptedAt: now.toISOString() })}\n`);
    await attempt.sync();
  } finally { await attempt.close(); }
  await syncPath(dirname(attemptPath));
  let sent = false, snapshot;
  return runRefresh({ cities: [city], window, now, forceCity: 'antalya', policy, ledger,
    publicRoot: join(root, 'probe-results/antalya-2026-10-16'),
    client: async (method, path, body) => {
      if (method === 'GET' && path === '/api/Quota/My?includeUnused=true') {
        snapshot = structuredClone(await client(method, path));
        return snapshot;
      }
      invariant(!sent && method === 'POST' && path === '/api/PrayerTime/DateRange' && body?.cityId === 9225 && body.startDate === `${window.start}T00:00:00` && body.endDate === `${window.end}T00:00:00`, 'Probe request outside reviewed scope');
      // Canonical persistence / browser handoff may take minutes. Recheck the
      // same snapshot immediately before the consuming request; never refetch/retry.
      await withStage('quota_validation', () => checkRemoteQuota(snapshot, policy, { endpoint: path, officialCityId: city.officialCityId }));
      sent = true;
      return client(method, path, body);
    },
    persistLedger: async next => {
      await atomicJson(ledgerPath, next);
      await syncPath(ledgerPath);
      await syncPath(dirname(ledgerPath));
      await persistAccountLedger(next);
    },
  });
}
