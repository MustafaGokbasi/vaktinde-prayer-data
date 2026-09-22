#!/usr/bin/env node
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariant, allowedWindow, validateMapping, unwrap, checkRemoteQuota, atomicJson, readJson, syncCity, quotaShapeHash, normalizeTimes, isOfficialId } from './core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const privateRoot = join(ROOT, '.private');
const publicRoot = join(ROOT, 'public');
const args = process.argv.slice(2);
const command = args[0] ?? 'plan';
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const execute = args.includes('--execute');
import { makeClient } from './api.mjs';
const window = allowedWindow();


async function main() {
  invariant(['plan', 'quota', 'discover', 'sync'].includes(command), 'Use plan, quota, discover or sync');
  if (!execute || command === 'plan') {
    const template = await readJson(join(ROOT, 'cities.template.json'));
    console.log(JSON.stringify({ dryRun: true, command, provinceCount: template.cities.length, dateRange: window, publicPath: 'v1/prayer-times/{cityId}.json', needs: ['API account credentials', 'official place hierarchy review', 'real account quota schema review', 'hosting and publication decision'], note: 'No network call, account change or publication performed. Add --execute only after review.' }, null, 2));
    return;
  }
  // Validate all local prerequisites before login or any account request.
  let cities, policy, discoveryPath;
  if (command === 'sync') {
    const mapping = await readJson(join(ROOT, 'cities.reviewed.json'));
    const selected = value('--city');
    if (selected) mapping.cities = mapping.cities.filter(city => city.cityId === selected);
    cities = validateMapping(mapping);
    const known = new Set((await readJson(join(ROOT, 'cities.template.json'))).cities.map(city => city.cityId));
    invariant(cities.every(city => known.has(city.cityId)), 'Mapping contains unknown app city');
    invariant(selected || cities.length === known.size, 'Full sync requires every province mapping; use --city for a reviewed pilot');
    policy = await readJson(join(ROOT, 'quota.reviewed.json'));
    invariant(policy.reviewed === true && policy.includesAllApplicableLimits === true, 'Quota review required');
  }
  if (command === 'discover') {
    const country = value('--country-id'), state = value('--state-id');
    invariant(!(country && state), 'Choose country OR state hierarchy level');
    invariant(!country || isOfficialId(country), 'Invalid official country ID');
    invariant(!state || isOfficialId(state), 'Invalid official state ID');
    discoveryPath = state ? `/api/Place/Cities/${state}` : country ? `/api/Place/States/${country}` : '/api/Place/Countries';
    policy = await readJson(join(ROOT, 'quota.reviewed.json'));
  }
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const lock = join(privateRoot, 'job.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error('Another job or stale lock exists; inspect it before continuing'); }
  try {
    const client = await makeClient();
    if (command === 'quota') {
      const quota = await client('GET', '/api/Quota/My?includeUnused=true');
      unwrap(quota);
      await atomicJson(join(privateRoot, 'quota-snapshot.json'), { fetchedAt: new Date().toISOString(), response: quota });
      console.log(JSON.stringify({ note: 'Private quota snapshot saved for schema review; no prayer data requested.', responseShapeHash: quotaShapeHash(quota) }));
    } else if (command === 'discover') {
      const quota = await client('GET', '/api/Quota/My?includeUnused=true');
      checkRemoteQuota(quota, policy, { endpoint: discoveryPath, officialCityId: '*' });
      const data = unwrap(await client('GET', discoveryPath));
      invariant(Array.isArray(data) && data.every(place => Number.isInteger(place.id) && typeof place.name === 'string'), 'Unexpected official place list');
      // Preserve authoritative hierarchy response for manual mapping; no inferred IDs.
      const file = `places-${value('--state-id') ? `state-${value('--state-id')}` : value('--country-id') ? `country-${value('--country-id')}` : 'countries'}.json`;
      await atomicJson(join(privateRoot, file), { fetchedAt: new Date().toISOString(), endpoint: discoveryPath, places: data });
      console.log(`${data.length} official places saved privately for review.`);
    } else {
      for (const city of cities) {
        const previous = await readJson(join(publicRoot, 'v1', 'prayer-times', `${city.cityId}.json`), null);
        const age = previous ? Date.now() - Date.parse(previous.fetchedAt) : Infinity;
        let validPrevious = false;
        if (previous?.schemaVersion === 1 && previous.cityId === city.cityId && previous.timezone === 'Europe/Istanbul' && previous.days && typeof previous.days === 'object') {
          try {
            normalizeTimes({ success: true, data: Object.entries(previous.days).map(([day, times]) => ({ ...times, gregorianDateShortIso8601: day })) }, city, { start: previous.coverageStart, end: previous.coverageEnd }, previous.fetchedAt);
            validPrevious = true;
          } catch { /* Invalid old metadata cannot suppress a replacement download. */ }
        }
        if (!args.includes('--force') && validPrevious && previous?.source === 'diyanet' && previous.officialCityId === city.officialCityId && previous.coverageStart <= window.start && previous.coverageEnd >= window.end && age >= 0 && age < 7 * 86400000) {
          console.log(`${city.cityId}: existing calendar is recent and covers the permitted range; skipped.`); continue;
        }
        const result = await syncCity({ city, window, client, policy, privateRoot, publicRoot });
        console.log(JSON.stringify(result));
      }
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
}
main().catch(error => {
  // No upstream body, URL, stack, environment or token in CLI output.
  const message = error.code === 'ENOENT' ? 'Required local reviewed configuration is missing.' : error instanceof SyntaxError ? 'A local JSON configuration is invalid.' : error.message;
  console.error(message); process.exitCode = 1;
});
