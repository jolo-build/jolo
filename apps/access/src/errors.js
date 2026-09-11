const reasons = new Set([
  'missing_browser_flow', 'invalid_browser_flow', 'account_storage', 'session_storage',
  'github_token_network', 'github_token_http', 'github_token_response',
  'github_credentials', 'github_code', 'github_redirect', 'github_email',
  'github_identity_network', 'github_identity_http', 'github_identity_response',
  'google_token_network', 'google_token_http', 'google_token_response', 'google_id_token', 'google_email',
  'google_keys_network', 'google_keys_http',
  'runtime_binding', 'network_certificate', 'network_timeout',
]);

export class SignInError extends Error {
  constructor(reason, status) {
    super('Sign-in failed');
    this.reason = reasons.has(reason) ? reason : 'signin';
    this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  }
}

export function networkError(fallback, error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const reason = /illegal invocation|incorrect this|requires.*this/i.test(message) ? 'runtime_binding'
    : /certificate|ssl|tls/i.test(message) ? 'network_certificate'
    : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'network_timeout'
    : fallback;
  return new SignInError(reason);
}

export function reportSignInFailure(env, error) {
  // Only fixed reason codes and HTTP statuses may reach development logs.
  // Never log an exception message, request URL, provider body, or credential.
  if (env.ENVIRONMENT !== 'development') return;
  console.error('[access] sign_in_failed', JSON.stringify({
    reason: error instanceof SignInError ? error.reason : 'signin',
    status: error instanceof SignInError ? error.status : undefined,
  }));
}
