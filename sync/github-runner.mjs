import { withStage, failureDiagnostic } from './diagnostics.mjs';
// Runs only from the dedicated public DATA repository. Never stages arbitrary files.
import { execFileSync } from 'node:child_process';
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
async function main() {
  await withStage('workflow_guard', () => invariant(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'MustafaGokbasi/vaktinde-prayer-data' && process.env.GITHUB_REF === 'refs/heads/main', 'Use the trusted data repository main workflow'));
  await withStage('checkout_guard', () => invariant(!git('status', '--porcelain').trim(), 'Workflow requires a clean checkout'));
  const mapping = await withStage('read_mapping', () => readJson(join(root, 'config/cities.json')));
  const cities = await withStage('validate_mapping', () => {
    const cities = validateMapping(mapping);
    invariant(cities.length === 81, 'Expected all 81 reviewed centres');
    return cities;
  });
  const forceCity = process.env.FORCE_CITY || undefined;
  await withStage('validate_force_city', () => invariant(!forceCity || cities.some(city => city.cityId === forceCity), 'Unknown requested centre'));
  const policy = await withStage('read_policy', () => readJson(join(root, 'config/quota-policy.json')));
  const ledgerPath = join(root, 'state/ledger.json');
  // Missing ledger MUST NOT reset existing quota on an ephemeral runner.
  const ledger = await withStage('read_ledger', () => readJson(ledgerPath));
  const client = await withStage('authentication', () => makeClient());
  const quota = await withStage('initial_quota_request', () => client('GET', '/api/Quota/My?includeUnused=true'));
  await withStage('initial_quota_validation', () => checkRemoteQuota(quota, policy, { endpoint: '/api/PrayerTime/DateRange', officialCityId: cities[0].officialCityId }));
  let result, refreshError;
  try {
    result = await withStage('refresh', () => runRefresh({ cities, window: allowedWindow(), publicRoot: join(root, 'public'), policy, ledger, client, forceCity,
      persistLedger: async next => {
        await atomicJson(ledgerPath, next, 0o644);
        commitPaths('Reserve official calendar request', ['state/ledger.json']);
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
