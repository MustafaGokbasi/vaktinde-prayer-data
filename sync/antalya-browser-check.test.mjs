import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultQuota, snapshotDate, rejectedCases } from './test-fixtures/default-quota.mjs';
const check = async (...args) => (await import('./antalya-browser-check.mjs')).checkAntalyaBrowserPayload(...args);
const script = fileURLToPath(new URL('./antalya-browser-check.mjs', import.meta.url));
const valid = { success: true, data: ['2026-10-16', '2026-10-17'].map(day => ({
  gregorianDateShortIso8601: day, fajr: '05:18', dhuhr: '12:55', asr: '16:22', maghrib: '19:03', isha: '20:17',
})) };
test('browser quota checker accepts reviewed fresh contract without reserving or calling API', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(snapshotDate) });
  assert.deepEqual(await check('quota', defaultQuota()), { validated: true, mode: 'quota', cityId: 'antalya', officialCityId: '9225', dateRange: { start: '2026-10-16', end: '2026-10-17' }, networkCalls: 0, reservationCreated: false });
});
for (const [name, edit] of rejectedCases) test(`browser checker rejects quota: ${name}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(snapshotDate) });
  const q = defaultQuota(); edit(q); await assert.rejects(check('quota', q));
});
test('browser calendar checker accepts only complete fixed two-day calendar', async () => {
  const result = await check('calendar', valid);
  assert.equal(result.dayCount, 2); assert.equal(result.officialCityId, '9225');
  for (const payload of [{ success: false }, { success: true, data: [] }, { success: true, data: [valid.data[0]] }, { success: true, data: [...valid.data, valid.data[0]] }]) await assert.rejects(check('calendar', payload));
});
test('browser check CLI reads only a response body, emits bounded summary, never changes tracked state', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const before = execFileSync('git', ['diff', '--', 'public', 'state'], { cwd: root, encoding: 'utf8' });
  const result = spawnSync(process.execPath, [script, 'calendar'], { input: JSON.stringify(valid), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dayCount, 2);
  assert.equal(JSON.parse(result.stdout).networkCalls, 0);
  assert.equal(execFileSync('git', ['diff', '--', 'public', 'state'], { cwd: root, encoding: 'utf8' }), before);
});
test('malformed input and execute flags fail without exposing input or environment', () => {
  const sentinel = 'PRIVATE-SENTINEL-BODY';
  for (const args of [['quota'], ['calendar'], ['--execute'], ['quota', '--execute']]) {
    const result = spawnSync(process.execPath, [script, ...args], { input: sentinel, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.ok(!`${result.stdout}${result.stderr}`.includes(sentinel));
    assert.deepEqual(Object.keys(JSON.parse(result.stderr)).sort(), ['errorCode', 'failedStage', 'httpStatus']);
  }
});
