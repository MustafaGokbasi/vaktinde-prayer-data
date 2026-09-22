import { invariant, unwrap } from './core.mjs';
const API = 'https://awqatsalah.diyanet.gov.tr';
export async function makeClient() {
  let token = process.env.DIYANET_ACCESS_TOKEN;
  async function request(method, path, body, authenticated = true) {
    let response;
    try {
      response = await fetch(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('Official request failed or timed out; no automatic retry'); }
    if (response.status === 429) throw new Error('Official rate limit reached; stop and inspect quota before retrying');
    if (response.status === 401 || response.status === 403) throw new Error('Official access unavailable; review credentials or account permission');
    invariant(response.ok, `Official service returned HTTP ${response.status}`);
    invariant(response.headers.get('content-type')?.includes('json'), 'Official service returned non-JSON response');
    const reader = response.body.getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        total += result.value.byteLength;
        invariant(total <= 5 * 1024 * 1024, 'Official response exceeds size limit');
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Official service returned invalid JSON'); }
  }
  if (!token) {
    invariant(process.env.DIYANET_EMAIL && process.env.DIYANET_PASSWORD, 'Server credentials are not configured');
    const data = unwrap(await request('POST', '/Auth/Login', { email: process.env.DIYANET_EMAIL, password: process.env.DIYANET_PASSWORD }, false));
    invariant(typeof data?.accessToken === 'string' && data.accessToken.length > 0, 'Unexpected authentication response');
    token = data.accessToken;
    // One bounded job, memory-only token. Refresh tokens are not persisted or logged.
  }
  return request;
}

