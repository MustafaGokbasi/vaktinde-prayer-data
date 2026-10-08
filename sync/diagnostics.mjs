// Only locally assigned metadata may reach logs. Never inspect or serialize an
// upstream error: even message, status, code and toJSON may contain private data.
const metadata = new WeakMap();
const stages = new Set([
  'workflow_guard', 'checkout_guard', 'read_mapping', 'validate_mapping',
  'validate_force_city', 'read_policy', 'read_ledger', 'authentication',
  'initial_quota_request', 'initial_quota_validation', 'refresh',
  'read_calendar', 'reserve_local_quota', 'quota_request', 'quota_validation',
  'persist_ledger', 'calendar_request', 'calendar_validation', 'write_calendar',
  'publish_calendars',
]);
const codes = new Set([
  'REQUEST_FAILED', 'RATE_LIMITED', 'ACCESS_DENIED', 'HTTP_ERROR',
  'NON_JSON_RESPONSE', 'RESPONSE_TOO_LARGE', 'RESPONSE_READ_FAILED',
  'INVALID_JSON', 'CREDENTIALS_MISSING', 'AUTH_RESPONSE_INVALID',
]);
const isObject = value => value !== null && (typeof value === 'object' || typeof value === 'function');

export function requestFailure(code, status) {
  const errorCode = codes.has(code) ? code : 'UNEXPECTED_FAILURE';
  const error = new Error(errorCode);
  metadata.set(error, {
    errorCode,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
  });
  return error;
}

export async function withStage(stage, operation) {
  try { return await operation(); }
  catch (thrown) {
    const error = isObject(thrown) ? thrown : new Error('STAGE_FAILED');
    const previous = metadata.get(error);
    if (!previous?.failedStage) metadata.set(error, {
      failedStage: stages.has(stage) ? stage : 'unknown',
      errorCode: previous?.errorCode ?? 'STAGE_FAILED',
      httpStatus: previous?.httpStatus ?? null,
    });
    throw error;
  }
}

export function failureDiagnostic(error) {
  const safe = isObject(error) ? metadata.get(error) : undefined;
  return {
    failedStage: safe?.failedStage ?? 'unknown',
    errorCode: safe?.errorCode ?? 'UNEXPECTED_FAILURE',
    httpStatus: safe?.httpStatus ?? null,
  };
}
