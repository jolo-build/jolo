import { accountScopes } from '../../../packages/protocol/src/tasks.js';
import { deviceApprovalPage, deviceEntryPage, deviceResultPage, devicesPage } from './pages.js';
import { DEVICE_SECONDS, deviceUserCode, formValue, hashToken, randomToken, readForm } from './security.js';

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = path => new Response(null, { status: 303, headers: { Location: path } });
const failure = (error, status = 400, extra = {}) => Response.json({ error, ...extra }, { status });
const CLIENT = 'jolo';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const userCode = () => deviceUserCode(Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => ALPHABET[byte % 32]).join(''));

export function deviceRoutes({ env, config, repository, session, now }) {
  async function bearer(request) {
    const header = request.headers.get('authorization');
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(header ?? '');
    return match ? repository.getDevice(await hashToken(match[1])) : null;
  }
  return async request => {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/device/code' && request.method === 'POST') {
      const form = await readForm(request);
      const name = formValue(form, 'device_name')?.trim();
      const scope = accountScopes(form?.has('scope') ? formValue(form, 'scope') : 'account:read');
      if (!scope || formValue(form, 'client_id') !== CLIENT || !name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) return failure('invalid_request');
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = randomToken(), code = userCode();
        const created = await repository.createDeviceFlow(await hashToken(token), code, name, (request.headers.get('cf-connecting-ip') ?? 'Local connection').slice(0, 64), scope);
        if (!created) continue;
        return Response.json({ device_code: token, user_code: code, verification_uri: `${config.origin}/device`, verification_uri_complete: `${config.origin}/device?user_code=${code}`, expires_in: 600, interval: 5 });
      }
      return failure('temporarily_unavailable', 503);
    }
    if (['/device/token', '/device/cancel'].includes(path) && request.method === 'POST') {
      const form = await readForm(request), token = formValue(form, 'device_code');
      if (formValue(form, 'client_id') !== CLIENT || !/^[a-f0-9]{64}$/.test(token ?? '')) return failure('invalid_request');
      const hash = await hashToken(token);
      if (path === '/device/cancel') { await repository.cancelDeviceFlow(hash); return new Response(null, { status: 204 }); }
      if (formValue(form, 'grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code') return failure('unsupported_grant_type');
      const result = await repository.pollDevice(hash);
      if (result.error) return failure(result.error, 400, result.interval ? { interval: result.interval } : {});
      const credential = randomToken(), id = crypto.randomUUID();
      await repository.createDevice(id, await hashToken(credential), result.account_id, result.name, now() + DEVICE_SECONDS * 1000, result.scope);
      return Response.json({ access_token: credential, token_type: 'Bearer', expires_in: DEVICE_SECONDS, scope: result.scope });
    }
    if (path === '/api/device/session' && request.method === 'GET') {
      const found = await bearer(request);
      return found ? Response.json({ account: { id: found.id, name: found.name, email: found.email }, device: { id: found.device_id, name: found.device_name, expiresAt: new Date(found.expires_at).toISOString(), scopes: found.scope.split(' ') } }) : failure('invalid_token', 401);
    }
    if (path === '/api/device/logout' && request.method === 'POST') {
      const found = await bearer(request);
      if (found) await repository.revokeDevice(found.device_id, found.id);
      return new Response(null, { status: 204 });
    }
    if (path === '/device' && request.method === 'GET') {
      const code = deviceUserCode(url.searchParams.get('user_code'));
      const account = await session(request);
      if (!code) return html(deviceEntryPage(url.searchParams.has('user_code'), Boolean(account)));
      if (!account) return redirect(`/login?user_code=${code}`);
      const flow = await repository.getDeviceFlow(code);
      return flow ? html(deviceApprovalPage(account, flow)) : html(deviceEntryPage(true, true));
    }
    if (path === '/devices' && request.method === 'GET') {
      const account = await session(request);
      return account ? html(devicesPage(account, await repository.listDevices(account.id))) : redirect('/');
    }
    if (['/device/approve', '/devices/revoke'].includes(path) && request.method === 'POST') {
      if (request.headers.get('origin') !== config.origin) return failure('forbidden', 403);
      const account = await session(request), form = await readForm(request);
      if (!account || formValue(form, 'csrf') !== account.csrf) return failure('forbidden', 403);
      if (path === '/devices/revoke') {
        const id = formValue(form, 'device_id');
        if (!id || id.length > 100) return failure('invalid_request');
        await repository.revokeDevice(id, account.id);
        return redirect('/devices');
      }
      const code = deviceUserCode(formValue(form, 'user_code')), decision = formValue(form, 'decision');
      if (!code || !['approved', 'denied'].includes(decision)) return failure('invalid_request');
      const updated = await repository.decideDevice(code, account.id, decision);
      return updated ? html(deviceResultPage(decision === 'approved')) : html(deviceEntryPage(true, true), 400);
    }
    return null;
  };
}
