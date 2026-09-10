import { SignInError, networkError } from './errors.js';

export async function githubIdentity(accessToken, fetcher = fetch) {
  if (typeof accessToken !== 'string' || !accessToken) throw new SignInError('github_token_response');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'jolo-access', 'X-GitHub-Api-Version': '2022-11-28' };
  let responses;
  try { responses = await Promise.all([
    fetcher('https://api.github.com/user', { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) }),
    fetcher('https://api.github.com/user/emails?per_page=100', { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) }),
  ]); } catch (error) { throw networkError('github_identity_network', error); }
  const failed = responses.find(response => !response.ok);
  if (failed) throw new SignInError('github_identity_http', failed.status);
  let user, emails;
  try { [user, emails] = await Promise.all(responses.map(response => response.json())); }
  catch { throw new SignInError('github_identity_response'); }
  const email = Array.isArray(emails) && emails.find(entry => entry.primary === true && entry.verified === true);
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new SignInError('github_identity_response');
  if (!email || typeof email.email !== 'string' || email.email.length > 320 || !email.email.includes('@')) throw new SignInError('github_email');
  return { id: String(user.id), email: email.email, name: String(user.name || user.login || 'Jolo user').slice(0, 200) };
}
