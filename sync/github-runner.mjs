import { withStage, failureDiagnostic } from './diagnostics.mjs';
// Runs only from the dedicated public DATA repository. Never stages arbitrary files.
import { execFileSync } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedWindow, atomicJson, checkRemoteQuota, invariant, readJson, validateMapping } from './core.mjs';
import { makeClient } from './api.mjs';
import { runRefresh } from './automation.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function commitPaths(message, paths) {
  git('add', '--', ...paths);
  if (!git('diff', '--cached', '--name-only').trim()) return;
  git('commit', '-m', message);
  // If this fails, the caller must not send any Diyanet data request.
  git('push', 'origin', 'HEAD:main');
}
async function rolloutAttemptExists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function main() {
  await withStage('workflow_guard', () => invariant(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'MustafaGokbasi/vaktinde-prayer-data' && process.env.GITHUB_REF === 'refs/heads/main', 'Use the trusted data repository main workflow'));
  await withStage('checkout_guard', () => invariant(!git('status', '--porcelain').trim(), 'Workflow requires a clean checkout'));
  const mapping = await withStage('read_mapping', () => readJson(join(root, 'config/cities.json')));
  const allCities = await withStage('validate_mapping', () => {
    const cities = validateMapping(mapping);
    invariant(cities.length === 81, 'Expected all 81 reviewed centres');
    return cities;
  });
  const forceCity = process.env.FORCE_CITY || undefined;
  // Temporary production allowlist. FORCE_CITY remains a refresh preference,
  // never a selector or a way to expand this rollout. No environment opt-out.
  await withStage('validate_force_city', () => invariant(!forceCity || forceCity === 'antalya', 'Only Antalya is enabled for the controlled rollout'));
  const cities = await withStage('rollout_guard', () => {
    const city = allCities.find(value => value.cityId === 'antalya');
    invariant(city?.officialCityId === '9225' && city.officialStateId === '507', 'Reviewed Antalya mapping changed');
    return [city];
  });
  const attemptPath = join(root, 'state/antalya-rollout-attempt.json');
  if (await withStage('rollout_guard', () => rolloutAttemptExists(attemptPath))) {
    // Any persisted marker, including malformed content, blocks another attempt.
    console.log(JSON.stringify({ rollout: 'antalya_only', attempt: 'already_reserved', updated: 0, skipped: 1 }));
    return;
  }
  const policy = await withStage('read_policy', () => readJson(join(root, 'config/quota-policy.json')));
  const ledgerPath = join(root, 'state/ledger.json');
  // Missing ledger MUST NOT reset existing quota on an ephemeral runner.
  const ledger = await withStage('read_ledger', () => readJson(ledgerPath));
  const window = allowedWindow();
  const transport = await withStage('authentication', () => makeClient());
  let snapshot, sent = false;
  const client = async (method, path, body) => {
    if (method === 'GET' && path === '/api/Quota/My?includeUnused=true') {
      snapshot = structuredClone(await transport(method, path));
      return snapshot;
    }
    invariant(!sent && method === 'POST' && path === '/api/PrayerTime/DateRange' && body?.cityId === 9225 && body.startDate === `${window.start}T00:00:00` && body.endDate === `${window.end}T00:00:00`, 'Request outside controlled rollout');
    await withStage('quota_validation', () => checkRemoteQuota(snapshot, policy, { endpoint: path, officialCityId: '9225' }));
    sent = true;
    return transport(method, path, body);
  };
  const quota = await withStage('initial_quota_request', () => client('GET', '/api/Quota/My?includeUnused=true'));
  await withStage('initial_quota_validation', () => checkRemoteQuota(quota, policy, { endpoint: '/api/PrayerTime/DateRange', officialCityId: cities[0].officialCityId }));
  let result, refreshError;
  try {
    result = await withStage('refresh', () => runRefresh({ cities, window, publicRoot: join(root, 'public'), policy, ledger, client, forceCity,
      persistLedger: async next => {
        const attempt = await open(attemptPath, 'wx', 0o644);
        try {
          await attempt.writeFile(`${JSON.stringify({ schemaVersion: 1, cityId: 'antalya', officialCityId: '9225', maxDateRangeAttempts: 1, window, reservedAt: new Date().toISOString() })}\n`);
          await attempt.sync();
        } finally { await attempt.close(); }
        await atomicJson(ledgerPath, next, 0o644);
        for (const path of [ledgerPath, join(root, 'state')]) {
          const handle = await open(path, 'r');
          try { await handle.sync(); } finally { await handle.close(); }
        }
        // Both files enter one canonical Git commit before any DateRange call.
        // Failed/uncertain persistence or requests never remove the marker.
        commitPaths('Reserve controlled Antalya calendar request', ['state/ledger.json', 'state/antalya-rollout-attempt.json']);
      },
    }));
  } catch (error) {
    refreshError = error;
    throw error;
  } finally {
    // Only independently validated calendars are written by runRefresh; publish these
    // even if a later city fails. Existing files remain unchanged for failed cities.
    try {
      await withStage('publish_calendars', () => commitPaths('Refresh validated official calendars', ['public/v1/prayer-times']));
    } catch (error) {
      if (!refreshError) throw error;
      // Report a secondary failure without masking the original failed stage.
      console.error(JSON.stringify(failureDiagnostic(error)));
    }
  }
  console.log(JSON.stringify({ authentication: 'verified', quota: 'verified', ...result }));
}
main().catch(error => {
  // child_process errors can include URLs/headers; never dump them or upstream bodies.
  console.error(JSON.stringify(failureDiagnostic(error)));
  process.exitCode = 1;
});
