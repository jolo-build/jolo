import { randomToken } from './security.js';
import { githubIdentity } from './identity.js';
import { SignInError, networkError } from './errors.js';

export async function authorization(env, origin) {
  const state = randomToken();
  const verifier = randomToken();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    scope: 'read:user user:email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), state, verifier };
}

export async function authenticate(env, origin, code, verifier, fetcher = fetch) {
  let response;
  try { response = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'jolo-access' },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${origin}/callback`, code_verifier: verifier }),
    // workerd supports manual/follow, not error. Reject every non-2xx below.
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  }); } catch (error) { throw networkError('github_token_network', error); }
  if (!response.ok) throw new SignInError('github_token_http', response.status);
  let token;
  try { token = await response.json(); }
  catch { throw new SignInError('github_token_response'); }
  const errors = { incorrect_client_credentials: 'github_credentials', bad_verification_code: 'github_code', redirect_uri_mismatch: 'github_redirect', unverified_user_email: 'github_email' };
  if (token?.error) throw new SignInError(Object.hasOwn(errors, token.error) ? errors[token.error] : 'github_token_response');
  if (typeof token?.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') throw new SignInError('github_token_response');
  // Revalidate the provider identity on every sign-in. Never persist the GitHub token.
  return githubIdentity(token.access_token, fetcher);
}
