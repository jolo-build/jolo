import { authenticate, authorization } from './auth.js';
import { deviceRoutes } from './devices.js';
import { taskRoutes } from './tasks/routes.js';
import { createRepository } from './storage.js';
import { accountPage, errorPage, signInPage } from './pages.js';
import { SignInError, reportSignInFailure } from './errors.js';
import { deliverMail } from './mail.js';
import { FLOW_SECONDS, SESSION_SECONDS, configuration, cookie, hashToken, protect, randomToken, readToken, readForm, formValue, deviceUserCode } from './security.js';

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = path => new Response(null, { status: 303, headers: { Location: path } });

export function createAccessApp(env, options = {}) {
  const config = configuration(env);
  const now = options.now ?? Date.now;
  const repository = env.ACCESS_DB ? createRepository(env.ACCESS_DB, now) : null;
  const setCookie = (response, name, value, seconds) => response.headers.append('Set-Cookie', cookie(name, value, seconds, config.secure));
  const session = async request => {
    const token = readToken(request, 'session', config.secure);
    return token && repository ? repository.getSession(await hashToken(token)) : null;
  };
  const handleDevices = deviceRoutes({ env, config, repository, session, now });
  const handleTasks = taskRoutes({ env, config, repository, session, now, mailFetch: options.mailFetch });
  const failedSignIn = error => {
    reportSignInFailure(env, error);
    const response = redirect(error instanceof SignInError && error.reason === 'github_email' ? '/?error=email' : '/?error=signin');
    setCookie(response, 'flow', '', 0);
    return response;
  };

  async function route(request, context) {
    const url = new URL(request.url);
    if (url.origin !== config.origin) return html(errorPage(421), 421);
    const path = url.pathname;
    if ((path === '/styles.css' || path === '/theme.js' || path.startsWith('/assets/')) && ['GET', 'HEAD'].includes(request.method)) {
      return env.ASSETS?.fetch(request) ?? html(errorPage(404), 404);
    }
    if (request.method === 'GET' && path === '/health') {
      let ready = config.configured;
      if (ready) {
        try { await env.ACCESS_DB.prepare('SELECT 1 FROM accounts LIMIT 1').first(); }
        catch { ready = false; }
      }
      return Response.json({ ok: ready }, { status: ready ? 200 : 503 });
    }
    if (request.method === 'GET' && path === '/') {
      if (config.configured && await session(request)) return redirect('/account');
      return html(signInPage({ configured: config.configured, error: url.searchParams.get('error') }));
    }
    if (!config.configured) return html(errorPage(503), 503);
    if (['/login', '/callback', '/device', '/device/code', '/device/token', '/device/approve'].includes(path) && env.ACCESS_RATE_LIMIT) {
      const { success } = await env.ACCESS_RATE_LIMIT.limit({ key: `${path}:${request.headers.get('cf-connecting-ip') ?? 'local'}` });
      if (!success) {
        const response = html(errorPage(429), 429);
        response.headers.set('Retry-After', '60');
        return response;
      }
    }
    const deviceResponse = await handleDevices(request);
    if (deviceResponse) return deviceResponse;
    const taskResponse = await handleTasks(request, context);
    if (taskResponse) return taskResponse;
    if (request.method === 'GET' && path === '/login') {
      const previous = readToken(request, 'flow', config.secure);
      if (previous) await repository.removeFlow(await hashToken(previous));
      const token = randomToken();
      const flow = await authorization(env, config.origin);
      await repository.saveFlow(await hashToken(token), flow, now() + FLOW_SECONDS * 1000, deviceUserCode(url.searchParams.get('user_code')) ? `/device?user_code=${deviceUserCode(url.searchParams.get('user_code'))}` : null);
      const response = redirect(flow.url);
      setCookie(response, 'flow', token, FLOW_SECONDS);
      return response;
    }
    if (request.method === 'GET' && path === '/callback') {
      const token = readToken(request, 'flow', config.secure);
      if (!token) return failedSignIn(new SignInError('missing_browser_flow'));
      const flow = await repository.consumeFlow(await hashToken(token));
      const p = url.searchParams;
      if (!flow || p.has('error') || p.getAll('code').length !== 1 || p.getAll('state').length !== 1 || p.get('state') !== flow.state || !p.get('code') || p.get('code').length > 512) return failedSignIn(new SignInError('invalid_browser_flow'));
      let stage = 'signin';
      try {
        const identity = await authenticate(env, config.origin, p.get('code'), flow.verifier, options.fetch ?? fetch);
        stage = 'account_storage';
        const account = await repository.account(identity);
        stage = 'session_storage';
        const previous = readToken(request, 'session', config.secure);
        if (previous) await repository.removeSession(await hashToken(previous));
        const sessionToken = randomToken();
        await repository.saveSession(await hashToken(sessionToken), account.id, randomToken(), now() + SESSION_SECONDS * 1000);
        // GitHub tokens never leave the server or become browser sessions.
        const response = redirect(flow.return_to ?? '/account');
        setCookie(response, 'flow', '', 0);
        setCookie(response, 'session', sessionToken, SESSION_SECONDS);
        return response;
      } catch (error) {
        return failedSignIn(error instanceof SignInError ? error : new SignInError(stage));
      }
    }
    if (request.method === 'GET' && path === '/account') {
      const account = await session(request);
      return account ? html(accountPage(account)) : redirect('/');
    }
    if (request.method === 'GET' && path === '/api/session') {
      const account = await session(request);
      return account ? Response.json({ account: { id: account.id, name: account.name, email: account.email } }) : Response.json({ account: null }, { status: 401 });
    }
    if (request.method === 'POST' && path === '/logout') {
      if (request.headers.get('origin') !== config.origin) return html(errorPage(403), 403);
      const account = await session(request);
      if (!account || formValue(await readForm(request), 'csrf') !== account.csrf) return html(errorPage(403), 403);
      await repository.removeSession(await hashToken(readToken(request, 'session', config.secure)));
      const flow = readToken(request, 'flow', config.secure);
      if (flow) await repository.removeFlow(await hashToken(flow));
      const response = redirect('/');
      setCookie(response, 'session', '', 0);
      setCookie(response, 'flow', '', 0);
      return response;
    }
    return html(errorPage(404), 404);
  }

  return {
    async fetch(request, context) {
      try { return protect(await route(request, context), config.secure); }
      catch { return protect(html(errorPage(503), 503), config.secure); }
    },
  };
}

const applications = new WeakMap();
export default {
  async scheduled(_controller, env) {
    await deliverMail(env);
    await createRepository(env.ACCESS_DB).cleanup();
  },
  async fetch(request, env, context) {
    try {
      let app = applications.get(env);
      if (!app) { app = createAccessApp(env); applications.set(env, app); }
      return app.fetch(request, context);
    } catch {
      return protect(html(errorPage(503), 503));
    }
  },
};
