import { requestFailure } from './diagnostics.mjs';
import { unwrap } from './core.mjs';
const API = 'https://awqatsalah.diyanet.gov.tr';
export async function makeClient() {
  let token = process.env.DIYANET_ACCESS_TOKEN;
  async function request(method, path, body, authenticated = true) {
    let response;
    try {
      response = await fetch(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw requestFailure('REQUEST_FAILED'); }
    if (response.status === 429) throw requestFailure('RATE_LIMITED', response.status);
    if (response.status === 401 || response.status === 403) throw requestFailure('ACCESS_DENIED', response.status);
    if (!response.ok) throw requestFailure('HTTP_ERROR', response.status);
    if (!response.headers.get('content-type')?.includes('json')) throw requestFailure('NON_JSON_RESPONSE', response.status);
    if (!response.body) throw requestFailure('RESPONSE_READ_FAILED', response.status);
    const reader = response.body.getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        let result;
        try { result = await reader.read(); }
        catch { throw requestFailure('RESPONSE_READ_FAILED', response.status); }
        if (result.done) break;
        total += result.value.byteLength;
        if (total > 5 * 1024 * 1024) throw requestFailure('RESPONSE_TOO_LARGE', response.status);
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw requestFailure('INVALID_JSON', response.status); }
  }
  if (!token) {
    if (!process.env.DIYANET_EMAIL || !process.env.DIYANET_PASSWORD) throw requestFailure('CREDENTIALS_MISSING');
    const payload = await request('POST', '/Auth/Login', { email: process.env.DIYANET_EMAIL, password: process.env.DIYANET_PASSWORD }, false);
    let data;
    try { data = unwrap(payload); }
    catch { throw requestFailure('AUTH_RESPONSE_INVALID'); }
    if (typeof data?.accessToken !== 'string' || data.accessToken.length === 0) throw requestFailure('AUTH_RESPONSE_INVALID');
    token = data.accessToken;
    // One bounded job, memory-only token. Refresh tokens are not persisted or logged.
  }
  return request;
}

