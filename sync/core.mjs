import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkLiveQuota } from './live-quota.mjs';

const FIELDS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
export function invariant(condition, message) { if (!condition) throw new Error(message); }
export function dateKey(value) {
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid calendar date');
  const date = new Date(`${value}T00:00:00Z`);
  invariant(Number.isFinite(+date) && date.toISOString().slice(0, 10) === value, 'Invalid calendar date');
  return value;
}
export function turkeyDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function allowedWindow(now = new Date()) {
  const start = dateKey(turkeyDate(now));
  const year = Number(start.slice(0, 4)) + (Number(start.slice(5, 7)) >= 10 ? 1 : 0);
  return { start, end: `${year}-12-31` };
}
export function datesBetween(start, end) {
  dateKey(start); dateKey(end);
  invariant(start <= end, 'Reversed calendar range');
  const count = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  invariant(count <= 732, 'Calendar range too large');
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
}
export function unwrap(payload) {
  invariant(payload && payload.success === true && payload.data !== undefined, 'Unexpected official response envelope');
  return payload.data;
}
export function isOfficialId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}
export function validateMapping(mapping) {
  invariant(mapping?.schemaVersion === 1 && Array.isArray(mapping.cities) && mapping.cities.length > 0, 'Invalid city mapping');
  const appIds = new Set(), officialIds = new Set();
  for (const city of mapping.cities) {
    invariant(/^[a-z][a-z0-9-]*$/.test(city.cityId) && !appIds.has(city.cityId), 'Invalid or duplicate app city ID');
    invariant(city.reviewed === true && isOfficialId(city.officialCityId) && isOfficialId(city.officialStateId), 'Official place mapping requires review');
    invariant(!officialIds.has(city.officialCityId), 'Duplicate official city ID');
    appIds.add(city.cityId); officialIds.add(city.officialCityId);
  }
  return mapping.cities;
}
export function normalizeTimes(payload, city, window, fetchedAt = new Date().toISOString()) {
  const rows = unwrap(payload);
  invariant(Array.isArray(rows) && rows.length <= 732, 'Unexpected prayer time list');
  const expected = datesBetween(window.start, window.end);
  const days = {};
  for (const row of rows) {
    invariant(typeof row?.gregorianDateShortIso8601 === 'string', 'Missing ISO calendar date');
    const rawDate = row.gregorianDateShortIso8601;
    let day;
    if (row.gregorianDateLongIso8601 != null) {
      // Live API labels DD.MM.YYYY as ShortIso8601; use the actual ISO field,
      // and require agreement instead of guessing from a locale date alone.
      invariant(typeof row.gregorianDateLongIso8601 === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?\+03:00$/.test(row.gregorianDateLongIso8601), 'Unsupported official long calendar date');
      invariant(row.greenwichMeanTimeZone === 3, 'Unexpected official timezone');
      day = dateKey(row.gregorianDateLongIso8601.slice(0, 10));
      invariant(rawDate === day || rawDate === `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`, 'Official calendar dates disagree');
    } else {
      invariant(/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?(?:Z|\+03:00)?)?$/.test(rawDate), 'Unsupported official calendar date format');
      day = dateKey(rawDate.slice(0, 10));
    }
    invariant(day >= window.start && day <= window.end && !days[day], 'Unexpected or duplicate calendar date');
    const times = {};
    let previous = -1;
    for (const name of FIELDS) {
      const time = row[name];
      invariant(typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time), 'Invalid prayer time');
      const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      invariant(minute > previous, 'Prayer times are out of order');
      times[name] = time; previous = minute;
    }
    days[day] = times;
  }
  invariant(expected.length === rows.length && expected.every(day => days[day]), 'Incomplete official calendar coverage');
  invariant(Number.isFinite(Date.parse(fetchedAt)), 'Invalid fetch timestamp');
  return { schemaVersion: 1, source: 'diyanet', cityId: city.cityId, officialCityId: String(city.officialCityId), timezone: 'Europe/Istanbul', fetchedAt, coverageStart: window.start, coverageEnd: window.end, days };
}
function at(value, pointer) {
  invariant(typeof pointer === 'string' && pointer.startsWith('/'), 'Invalid reviewed quota JSON pointer');
  return pointer.slice(1).split('/').reduce((v, key) => v?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], value);
}
// Quota/My currently has no public response schema. Explicit selectors must be reviewed
// against the real account response; example test fixtures are NOT a claimed API schema.
export function quotaShapeHash(payload) {
  const shape = value => Array.isArray(value) ? value.map(shape) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])])) : value === null ? 'null' : typeof value;
  return createHash('sha256').update(JSON.stringify(shape(payload))).digest('hex');
}
export function checkRemoteQuota(payload, policy, request) {
  if (policy?.schemaVersion === 2) return checkLiveQuota(payload, policy, request);
  unwrap(payload);
  invariant(policy?.schemaVersion === 1 && policy.reviewed === true && policy.includesAllApplicableLimits === true, 'Quota adapter requires account response review');
  invariant(policy.responseShapeHash === quotaShapeHash(payload), 'Quota response structure changed; review required');
  invariant(Array.isArray(policy.rules) && policy.rules.length > 0, 'No reviewed quota rules');
  const relevant = policy.rules.filter(rule => rule.endpoint === request.endpoint && (rule.officialCityId === '*' || rule.officialCityId === request.officialCityId));
  invariant(relevant.length > 0, 'No reviewed quota coverage for request');
  for (const rule of relevant) {
    const limit = at(payload, rule.limitPointer), used = at(payload, rule.usedPointer);
    invariant(Number.isInteger(limit) && Number.isInteger(used) && limit >= 0 && used >= 0 && used <= limit, 'Quota response changed or is invalid');
    // Identity pointers bind numeric counters to the endpoint/place reviewed by the operator.
    invariant(Array.isArray(rule.identities) && rule.identities.length > 0, 'Quota rule has no identity binding');
    for (const identity of rule.identities) invariant(at(payload, identity.pointer) === identity.equals, 'Quota identity changed; review required');
    invariant(limit - used >= 1, 'Official account quota exhausted');
  }
  return true;
}
export function reserveLocalQuota(ledger, cityId, now = new Date()) {
  const month = turkeyDate(now).slice(0, 7);
  invariant(ledger?.schemaVersion === 1 && ledger.usage && typeof ledger.usage === 'object', 'Invalid quota ledger');
  const key = `${month}:${cityId}`;
  const used = ledger.usage[key] ?? 0;
  invariant(Number.isInteger(used) && used >= 0 && used < 10, 'Monthly city safety quota exhausted');
  // Reserve BEFORE network: failures/timeouts may have consumed remote quota.
  return { schemaVersion: 1, usage: { ...ledger.usage, [key]: used + 1 } };
}
export async function atomicJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export async function readJson(path, missing) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && missing !== undefined) return missing; throw error; }
}
export async function publishCity(root, document) {
  invariant(/^[a-z][a-z0-9-]*$/.test(document.cityId), 'Unsafe public file name');
  const file = join(root, 'v1', 'prayer-times', `${document.cityId}.json`);
  await atomicJson(file, document, 0o644);
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}
export async function syncCity({ city, window, now = new Date(), client, policy, privateRoot, publicRoot }) {
  const quota = await client('GET', '/api/Quota/My?includeUnused=true');
  checkRemoteQuota(quota, policy, { endpoint: '/api/PrayerTime/DateRange', officialCityId: city.officialCityId });
  const ledgerPath = join(privateRoot, 'ledger.json');
  const ledger = await readJson(ledgerPath, { schemaVersion: 1, usage: {} });
  await atomicJson(ledgerPath, reserveLocalQuota(ledger, city.officialCityId, now));
  const response = await client('POST', '/api/PrayerTime/DateRange', { cityId: Number(city.officialCityId), startDate: `${window.start}T00:00:00`, endDate: `${window.end}T00:00:00` });
  const document = normalizeTimes(response, city, window, now.toISOString());
  // A failed request or validation never modifies the prior public calendar.
  const checksum = await publishCity(publicRoot, document);
  return { cityId: city.cityId, coverageStart: document.coverageStart, coverageEnd: document.coverageEnd, checksum };
}
