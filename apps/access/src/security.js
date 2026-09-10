export const FLOW_SECONDS = 600;
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const DEVICE_SECONDS = 90 * 24 * 60 * 60;

export async function readForm(request, limit = 4096) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new URLSearchParams(await new Blob(chunks).text());
}
export const formValue = (form, key) => form?.getAll(key).length === 1 ? form.get(key) : null;

export function deviceUserCode(value) {
  const code = typeof value === 'string' ? value.toUpperCase().replaceAll('-', '').replaceAll(' ', '') : '';
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}

export function configuration(env) {
  const origin = new URL(env.ACCESS_ORIGIN);
  const local = env.ENVIRONMENT === 'development' && ['127.0.0.1', 'localhost'].includes(origin.hostname);
  if (origin.origin !== env.ACCESS_ORIGIN || origin.username || origin.password || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) {
    throw new Error('Invalid access service origin');
  }
  return { origin: origin.origin, secure: origin.protocol === 'https:', configured: Boolean(env.ACCESS_DB && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) };
}

export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const cookieName = (name, secure) => `${secure ? '__Host-' : ''}jolo_${name}`;
export function cookie(name, value, seconds, secure) {
  return `${cookieName(name, secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}

export function readToken(request, name, secure) {
  const key = cookieName(name, secure);
  const values = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(key + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(key.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function protect(response, secure = true) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  // no-referrer turns Origin into "null" on native form POSTs, failing CSRF
  // origin checks. Send only the origin, never approval codes or callback URLs.
  // https://fetch.spec.whatwg.org/#append-a-request-origin-header
  headers.set('Referrer-Policy', 'strict-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(response.body, { status: response.status, headers });
}
