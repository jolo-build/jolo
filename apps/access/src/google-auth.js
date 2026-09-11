import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { randomToken } from './security.js';
import { SignInError, networkError } from './errors.js';

const providerFetch = (...args) => fetch(...args);
const keySets = new WeakMap();

export async function googleAuthorization(env, origin) {
  const state = randomToken(), verifier = randomToken(), nonce = randomToken();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/callback/google`,
    response_type: 'code', scope: 'openid email profile', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  return { url: url.toString(), provider: 'google', state, verifier, nonce };
}

export async function authenticateGoogle(env, origin, code, flow, fetcher = providerFetch, now = Date.now) {
  let response;
  try {
    response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        code, code_verifier: flow.verifier, grant_type: 'authorization_code', redirect_uri: `${origin}/callback/google` }),
    });
  } catch (error) { throw networkError('google_token_network', error); }
  if (!response.ok) throw new SignInError('google_token_http', response.status);
  let tokens;
  try { tokens = await response.json(); } catch { throw new SignInError('google_token_response'); }
  if (tokens?.error || typeof tokens?.id_token !== 'string' || tokens.id_token.length > 16384) throw new SignInError('google_token_response');

  // Verify locally with Google's rotating public keys. Never trust decoded JWT claims alone.
  let keys = keySets.get(fetcher);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
      timeoutDuration: 10_000,
      [customFetch]: async (url, init) => {
        let result;
        try { result = await fetcher(url, { ...init, redirect: 'manual' }); }
        catch (error) { throw networkError('google_keys_network', error); }
        if (!result.ok) throw new SignInError('google_keys_http', result.status);
        return result;
      },
    });
    keySets.set(fetcher, keys);
  }
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(tokens.id_token, keys, {
      algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID, currentDate: new Date(now()), clockTolerance: 30, maxTokenAge: 600,
      requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'],
    }));
  } catch (error) { throw error instanceof SignInError ? error : new SignInError('google_id_token'); }
  if (!flow.nonce || claims.nonce !== flow.nonce ||
      (claims.azp !== undefined && claims.azp !== env.GOOGLE_CLIENT_ID) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== env.GOOGLE_CLIENT_ID) ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new SignInError('google_id_token');
  if (claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(claims.email)) throw new SignInError('google_email');
  return { id: claims.sub, email: claims.email, name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.slice(0, 200) : claims.email };
}
