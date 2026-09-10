import { accountScopes } from '@jolo/protocol/tasks';
import os from 'node:os';
import { ProtocolError, AccountIdentitySchema, AccountDeviceSchema } from '@jolo/protocol';
import { AccountSecretStore } from './secrets.js';

const DEFAULT_ORIGIN = 'https://access.jolo.build';
const PREFERENCE = 'account.connection';
const MAX_SECONDS = 90 * 24 * 60 * 60;
const tokenLike = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function accountOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProtocolError('invalid_params', 'Enter a valid account server URL.'); }
  if (url.origin !== value || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new ProtocolError('invalid_params', 'The account server must use HTTPS, or HTTP on a loopback address for local development.');
  }
  return url.origin;
}

function profileResponse(value) {
  return { account: AccountIdentitySchema.parse(value?.account), device: AccountDeviceSchema.parse(value?.device) };
}

export class AccountService {
  constructor({ storage, paths, lifetime, env = process.env, fetchImpl = fetch, secrets, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.storage = storage;
    this.paths = paths;
    this.lifetime = lifetime;
    this.fetch = fetchImpl;
    this.secrets = secrets ?? new AccountSecretStore({ dataDir: paths.dataDir, mode: env.JOLO_CREDENTIALS ?? 'keychain' });
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    try { this.origin = accountOrigin(storage.getPreference(PREFERENCE)?.origin ?? env.JOLO_ACCOUNT_ORIGIN ?? DEFAULT_ORIGIN); }
    catch { this.origin = DEFAULT_ORIGIN; }
    this.pending = null; this.record = null; this.credential = null; this.note = null; this.stopped = false;
    this.queue = Promise.resolve(); this.checkedAt = 0; this.checking = null;
    this.ready = this.restore().catch(() => { this.note = 'Could not restore your account. Sign in again.'; });
  }
  async restore() {
    const saved = this.storage.getPreference(PREFERENCE);
    if (!saved?.credentialID || saved.source !== 'keychain') return;
    const secret = await this.secrets.get(this.origin);
    if (!secret || secret.id !== saved.credentialID || !tokenLike(secret.token) || Date.parse(saved.device?.expiresAt) <= this.now()) return;
    try { this.record = { ...profileResponse(saved), source: 'keychain', credentialID: saved.credentialID }; this.credential = secret.token; }
    catch { /* Malformed local metadata cannot authenticate a device. */ }
  }
  exclusive(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  snapshot() {
    return {
      state: this.pending ? 'pending' : this.record ? 'signed_in' : 'signed_out',
      origin: this.origin,
      account: this.record?.account ?? null,
      device: this.record?.device ?? null,
      pending: this.pending ? { userCode: this.pending.userCode, verificationUri: this.pending.verificationUri, verificationUriComplete: this.pending.verificationUriComplete, expiresAt: new Date(this.pending.expiresAt).toISOString() } : null,
      source: this.record?.source ?? 'none',
      note: this.note,
    };
  }
  changed() {
    if (!this.stopped) this.storage.appendEvent({ type: 'account.changed', payload: { state: this.snapshot().state } });
  }
  async request(origin, path, { form, token, method = form ? 'POST' : 'GET' } = {}) {
    const headers = { Accept: 'application/json' };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try { response = await this.fetch(`${origin}${path}`, { method, headers, body: form ? new URLSearchParams(form) : undefined, redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
    catch { throw new ProtocolError('unavailable', 'Could not reach the account server. Check the connection and try again.'); }
    if (response.status >= 300 && response.status < 400) throw new ProtocolError('unavailable', 'The account server returned an unexpected redirect.');
    if (response.status === 204) return { status: 204, value: null };
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw new ProtocolError('unavailable', 'The account server returned an invalid response.'); }
      chunks.push(value);
    }
    let value;
    try { value = JSON.parse(await new Blob(chunks).text()); }
    catch { throw new ProtocolError('unavailable', 'The account server returned an invalid response.'); }
    return { status: response.status, value };
  }
  async status({ refresh = false } = {}) {
    await this.ready;
    if (this.record && (refresh || this.now() - this.checkedAt >= 60_000)) {
      if (!this.checking) this.checking = this.check().finally(() => { this.checking = null; });
      await this.checking;
    }
    return this.snapshot();
  }
  async check() {
    const credential = this.credential, origin = this.origin;
    let result;
    try { result = await this.request(origin, '/api/device/session', { token: credential }); }
    catch { result = null; }
    await this.exclusive(async () => {
      if (credential !== this.credential || this.stopped) return;
      this.checkedAt = this.now();
      if (result?.status === 401 || Date.parse(this.record.device.expiresAt) <= this.now()) {
        await this.forget(); this.note = 'Your sign-in expired or was revoked. Sign in again.'; this.changed();
      } else if (result?.status === 200) {
        try { this.record = { ...this.record, ...profileResponse(result.value) }; this.note = null; }
        catch { this.note = 'Could not verify your account. Try again when the account service is available.'; }
      } else this.note = 'Account service unavailable. Showing your last verified account.';
    });
  }
  async login({ origin, deviceName, tasks = false } = {}) {
    await this.ready;
    return this.exclusive(async () => {
      if (this.stopped) throw new ProtocolError('unavailable', 'The engine is stopping.');
      if (this.record && (!tasks || this.record.device.scopes.includes('tasks:read'))) throw new ProtocolError('conflict', 'Sign out before connecting another account.');
      if (this.record && origin && origin !== this.origin) throw new ProtocolError('conflict', 'Sign out before changing account servers.');
      if (this.pending) return this.snapshot();
      const nextOrigin = accountOrigin(origin ?? this.origin);
      const scope = tasks ? 'account:read tasks:read' : 'account:read';
      const name = (deviceName ?? `${os.hostname()} · ${this.paths.profile}`).trim().slice(0, 100);
      const response = await this.request(nextOrigin, '/device/code', { form: { client_id: 'jolo', device_name: name, scope } });
      const value = response.value;
      if (response.status !== 200 || !tokenLike(value?.device_code) || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(value?.user_code ?? '') || !Number.isInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 600 || !Number.isInteger(value.interval) || value.interval < 5 || value.interval > 60 || value.verification_uri !== `${nextOrigin}/device` || value.verification_uri_complete !== `${nextOrigin}/device?user_code=${value.user_code}`) {
        throw new ProtocolError('unavailable', 'The account service could not start sign-in. Check its configuration and try again.');
      }
      this.origin = nextOrigin; this.note = null;
      if (!this.record) this.storage.setPreference(PREFERENCE, { origin: this.origin });
      const pending = this.pending = { scope, code: value.device_code, userCode: value.user_code, verificationUri: value.verification_uri, verificationUriComplete: value.verification_uri_complete, expiresAt: this.now() + value.expires_in * 1000, interval: value.interval, origin: nextOrigin, timer: null };
      this.lifetime?.workStarted();
      this.schedule(pending); this.changed();
      return this.snapshot();
    });
  }
  schedule(pending) {
    if (this.pending !== pending || this.stopped) return;
    pending.timer = this.setTimer(() => { pending.timer = null; pending.running = this.poll(pending); }, Math.min(pending.interval * 1000, Math.max(0, pending.expiresAt - this.now())));
  }
  finishPending() {
    if (!this.pending) return;
    this.clearTimer(this.pending.timer); this.pending = null; this.lifetime?.workFinished();
  }
  async poll(pending) {
    let response;
    try {
      if (this.now() >= pending.expiresAt) response = { value: { error: 'expired_token' } };
      else response = await this.request(pending.origin, '/device/token', { form: { client_id: 'jolo', device_code: pending.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
    } catch { response = { status: 503 }; }
    await this.exclusive(async () => {
      const token = response?.value?.access_token;
      if (this.pending !== pending || this.stopped) {
        if (tokenLike(token)) await this.revoke(pending.origin, token);
        return;
      }
      if (response.value?.error === 'authorization_pending' || response.value?.error === 'slow_down' || response.status === 429 || response.status >= 500) {
        if (response.value?.error === 'slow_down') pending.interval = Math.min(300, Math.max(pending.interval + 5, Number(response.value.interval) || 0));
        if (response.status === 429 || response.status >= 500) pending.interval = Math.min(60, pending.interval + 5);
        this.schedule(pending); return;
      }
      if (response.status !== 200 || !tokenLike(token) || response.value.token_type !== 'Bearer' || accountScopes(response.value.scope) !== pending.scope || !Number.isInteger(response.value.expires_in) || response.value.expires_in < 1 || response.value.expires_in > MAX_SECONDS) {
        if (tokenLike(token)) await this.revoke(pending.origin, token);
        this.finishPending();
        this.note = response.value?.error === 'access_denied' ? 'Sign-in was declined in the browser.' : 'Sign-in expired or could not be completed. Start again.';
        this.changed(); return;
      }
      try {
        const verified = await this.request(pending.origin, '/api/device/session', { token });
        if (verified.status !== 200) throw new Error('invalid account');
        const profile = profileResponse(verified.value), credentialID = crypto.randomUUID();
        if (accountScopes(profile.device.scopes.join(' ')) !== pending.scope) throw new Error('invalid scopes');
        const previousCredential = this.credential;
        const source = await this.secrets.set(pending.origin, { id: credentialID, token });
        this.storage.setPreference(PREFERENCE, { origin: pending.origin, credentialID, ...profile, source });
        this.record = { ...profile, source, credentialID }; this.credential = token; this.checkedAt = this.now(); this.note = null;
        if (previousCredential) await this.revoke(pending.origin, previousCredential);
      } catch {
        await this.revoke(pending.origin, token);
        this.note = 'Could not save this sign-in. Please try again.';
      }
      this.finishPending(); this.changed();
    });
  }
  async taskRequest(path) {
    await this.ready;
    if (!this.credential || !this.record) throw new ProtocolError('permission_denied', 'Sign in to Jolo before referencing web tasks.');
    if (!this.record.device.scopes.includes('tasks:read')) throw new ProtocolError('permission_denied', 'Connect task access in Settings → Account, or run jolo login --tasks.');
    const credential = this.credential, origin = this.origin, accountId = this.record.account.id;
    const response = await this.request(origin, path, { token: credential });
    if (credential !== this.credential || origin !== this.origin || this.stopped) throw new ProtocolError('conflict', 'Your account connection changed. Send the message again.');
    if (response.status === 401) { await this.status({ refresh: true }); throw new ProtocolError('permission_denied', 'Your sign-in expired or was revoked. Sign in again.'); }
    if (response.status === 403) throw new ProtocolError('permission_denied', 'This device cannot read tasks. Approve task access in Settings → Account.');
    if (response.status === 404) throw new ProtocolError('not_found', 'The referenced task is unavailable or you no longer have access.');
    if (response.status !== 200) throw new ProtocolError('unavailable', 'Could not load tasks from the account service. Try again.');
    return { value: response.value, origin, accountId, current: () => credential === this.credential && origin === this.origin && !this.stopped };
  }
  async revoke(origin, token) {
    try { return (await this.request(origin, '/api/device/logout', { token, method: 'POST' })).status === 204; }
    catch { return false; }
  }
  async forget() {
    // Clear metadata first: an unavailable keyring must never resurrect a login.
    this.storage.setPreference(PREFERENCE, { origin: this.origin });
    this.record = null; this.credential = null;
    await this.secrets.clear(this.origin);
  }
  async cancelPending() {
    const pending = this.pending;
    this.finishPending();
    if (pending) try { await this.request(pending.origin, '/device/cancel', { form: { client_id: 'jolo', device_code: pending.code } }); } catch { /* The request also expires after ten minutes. */ }
  }
  async cancel() {
    await this.ready;
    return this.exclusive(async () => { await this.cancelPending(); this.note = null; this.changed(); return this.snapshot(); });
  }
  async logout() {
    await this.ready;
    return this.exclusive(async () => {
      const credential = this.credential, origin = this.origin;
      // Close local task access before waiting for remote cancellation/revocation.
      await this.forget();
      await this.cancelPending();
      const revoked = !credential || await this.revoke(origin, credential);
      this.note = revoked ? null : 'Signed out locally. Remove this device on the account website to finish revoking its connection.';
      this.changed(); return this.snapshot();
    });
  }
  async stop() {
    this.stopped = true;
    await this.ready;
    await this.exclusive(() => this.cancelPending());
  }
}
