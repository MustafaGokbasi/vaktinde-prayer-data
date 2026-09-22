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
  invariant(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'MustafaGokbasi/vaktinde-prayer-data' && process.env.GITHUB_REF === 'refs/heads/main', 'Use the trusted data repository main workflow');
  invariant(!git('status', '--porcelain').trim(), 'Workflow requires a clean checkout');
  const cities = validateMapping(await readJson(join(root, 'config/cities.json')));
  invariant(cities.length === 81, 'Expected all 81 reviewed centres');
  const forceCity = process.env.FORCE_CITY || undefined;
  invariant(!forceCity || cities.some(city => city.cityId === forceCity), 'Unknown requested centre');
  const policy = await readJson(join(root, 'config/quota-policy.json'));
  const ledgerPath = join(root, 'state/ledger.json');
  // Missing ledger MUST NOT reset existing quota on an ephemeral runner.
  const ledger = await readJson(ledgerPath);
  const client = await makeClient();
  const quota = await client('GET', '/api/Quota/My?includeUnused=true');
  checkRemoteQuota(quota, policy, { endpoint: '/api/PrayerTime/DateRange', officialCityId: cities[0].officialCityId });
  let result;
  try {
    result = await runRefresh({ cities, window: allowedWindow(), publicRoot: join(root, 'public'), policy, ledger, client, forceCity,
      persistLedger: async next => {
        await atomicJson(ledgerPath, next, 0o644);
        commitPaths('Reserve official calendar request', ['state/ledger.json']);
      },
    });
  } finally {
    // Only independently validated calendars are written by runRefresh; publish these
    // even if a later city fails. Existing files remain unchanged for failed cities.
    commitPaths('Refresh validated official calendars', ['public/v1/prayer-times']);
  }
  console.log(JSON.stringify({ authentication: 'verified', quota: 'verified', ...result }));
}
main().catch(error => {
  // child_process errors can include URLs/headers; never dump them or upstream bodies.
  console.error(error?.status !== undefined ? 'Git operation failed; synchronization stopped safely.' : 'Calendar synchronization failed; review credentials, quota policy and data validation. Last valid calendars retained.');
  process.exitCode = 1;
});
