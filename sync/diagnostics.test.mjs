import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { makeClient } from './api.mjs';
const secret = 'SENTINEL-password-token-url-body-DO-NOT-LOG';
const diagnostics = () => import('./diagnostics.mjs');
const originalEnvironment = new WeakMap();
function env(t, key, value) {
  if (!originalEnvironment.has(t)) {
    const values = new Map();
    originalEnvironment.set(t, values);
    t.after(() => {
      for (const [name, previous] of values) {
        if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
      }
    });
  }
  const values = originalEnvironment.get(t);
  if (!values.has(key)) values.set(key, process.env[key]);
  process.env[key] = value;
}

test('runner fails closed with a structured diagnostic and no environment values', () => {
  const result = spawnSync(process.execPath, ['sync/github-runner.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY: secret, DIYANET_ACCESS_TOKEN: secret },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { failedStage: 'workflow_guard', errorCode: 'STAGE_FAILED', httpStatus: null });
  assert.ok(!result.stderr.includes(secret));
});

test('diagnostics ignore forged fields, raw errors, child-process status and serialization hooks', async () => {
  const { withStage, failureDiagnostic } = await diagnostics();
  for (const thrown of [null, secret, new Error(secret), {
    message: secret, stack: secret, status: 401, httpStatus: 403, code: secret,
    failedStage: secret, errorCode: secret, url: secret, headers: secret, body: secret,
    toJSON() { throw new Error('must not serialize'); },
  }]) {
    await assert.rejects(withStage('persist_ledger', () => { throw thrown; }), error => {
      assert.deepEqual(failureDiagnostic(error), { failedStage: 'persist_ledger', errorCode: 'STAGE_FAILED', httpStatus: null });
      return true;
    });
  }
  assert.deepEqual(failureDiagnostic(new Error(secret)), { failedStage: 'unknown', errorCode: 'UNEXPECTED_FAILURE', httpStatus: null });
});

test('nested stages retain the failing operation and reject unreviewed metadata', async () => {
  const { withStage, failureDiagnostic, requestFailure } = await diagnostics();
  await assert.rejects(withStage('refresh', () => withStage('calendar_request', () => { throw requestFailure('HTTP_ERROR', 503); })), error => {
    assert.deepEqual(failureDiagnostic(error), { failedStage: 'calendar_request', errorCode: 'HTTP_ERROR', httpStatus: 503 }); return true;
  });
  await assert.rejects(withStage(secret, () => { throw requestFailure(secret, secret); }), error => {
    assert.deepEqual(failureDiagnostic(error), { failedStage: 'unknown', errorCode: 'UNEXPECTED_FAILURE', httpStatus: null }); return true;
  });
  for (const value of [401.5, '401', 99, 600, NaN, {}, null]) {
    assert.equal(failureDiagnostic(requestFailure('HTTP_ERROR', value)).httpStatus, null);
  }
});

test('API failures expose only controlled codes and numeric HTTP status without retry', async t => {
  const { withStage, failureDiagnostic } = await diagnostics();
  env(t, 'DIYANET_ACCESS_TOKEN', secret);
  const client = await makeClient();
  const cases = [
    [() => { throw Object.assign(new Error(secret), { status: 503 }); }, 'REQUEST_FAILED', null],
    [() => new Response(secret, { status: 429 }), 'RATE_LIMITED', 429],
    [() => new Response(secret, { status: 401 }), 'ACCESS_DENIED', 401],
    [() => new Response(secret, { status: 403 }), 'ACCESS_DENIED', 403],
    [() => new Response(secret, { status: 503 }), 'HTTP_ERROR', 503],
    [() => new Response(secret, { headers: { 'Content-Type': 'text/html' } }), 'NON_JSON_RESPONSE', 200],
    [() => new Response(secret, { headers: { 'Content-Type': 'application/json' } }), 'INVALID_JSON', 200],
    [() => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }), { headers: { 'Content-Type': 'application/json' } }), 'RESPONSE_READ_FAILED', 200],
    [() => new Response('x'.repeat(5 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }), 'RESPONSE_TOO_LARGE', 200],
  ];
  for (const [response, errorCode, httpStatus] of cases) {
    const mock = t.mock.method(globalThis, 'fetch', response);
    await assert.rejects(withStage('calendar_request', () => client('POST', '/ignored', { secret })), error => {
      assert.deepEqual(failureDiagnostic(error), { failedStage: 'calendar_request', errorCode, httpStatus });
      assert.ok(!JSON.stringify(failureDiagnostic(error)).includes(secret)); return true;
    });
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('authentication distinguishes missing configuration and invalid login envelope', async t => {
  const { withStage, failureDiagnostic } = await diagnostics();
  env(t, 'DIYANET_ACCESS_TOKEN', '');
  env(t, 'DIYANET_EMAIL', '');
  env(t, 'DIYANET_PASSWORD', '');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network expected'); });
  await assert.rejects(withStage('authentication', () => makeClient()), error => {
    assert.deepEqual(failureDiagnostic(error), { failedStage: 'authentication', errorCode: 'CREDENTIALS_MISSING', httpStatus: null }); return true;
  });
  env(t, 'DIYANET_EMAIL', secret); env(t, 'DIYANET_PASSWORD', secret);
  t.mock.method(globalThis, 'fetch', () => Response.json({ success: false, message: secret }));
  await assert.rejects(withStage('authentication', () => makeClient()), error => {
    assert.deepEqual(failureDiagnostic(error), { failedStage: 'authentication', errorCode: 'AUTH_RESPONSE_INVALID', httpStatus: null }); return true;
  });
});
