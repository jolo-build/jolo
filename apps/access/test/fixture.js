import { afterEach, expect } from 'bun:test';
import { testDatabase } from './database.js';
import { createAccessApp } from '../src/worker.js';
const ORIGIN = 'https://access.jolo.build';
const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

export function fixture(overrides = {}) {
  const { sqlite, db } = testDatabase();
  databases.push(sqlite);
  let time = Date.now();
  let upstreamAuthorization;
  const cookies = new Map();
  const calls = [];
  const identity = { id: 12345, name: 'Jolo Developer', login: 'developer' };
  const emails = [{ email: 'dev@example.com', primary: true, verified: true }];
  const env = { ACCESS_ORIGIN: ORIGIN, ENVIRONMENT: 'production', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret', ACCESS_DB: db, ...overrides };
  const upstream = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://github.com/login/oauth/access_token') {
      const p = new URLSearchParams(init.body);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.get('code_verifier')));
      expect(Buffer.from(digest).toString('base64url')).toBe(upstreamAuthorization.searchParams.get('code_challenge'));
      expect(p.get('redirect_uri')).toBe(`${env.ACCESS_ORIGIN}/callback`);
      expect(p.get('client_secret')).toBe('test-secret');
      expect(init.redirect).toBe('manual');
      return Response.json({ access_token: 'fixture-github-token', token_type: 'bearer' });
    }
    expect(init.headers.Authorization).toBe('Bearer fixture-github-token');
    if (url === 'https://api.github.com/user') return Response.json(identity);
    if (url === 'https://api.github.com/user/emails?per_page=100') return Response.json(emails);
    throw new Error('Unexpected network request');
  };
  const app = createAccessApp(env, { now: () => time, fetch: upstream });
  const send = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('cookie')) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await app.fetch(new Request(new URL(path, env.ACCESS_ORIGIN), { ...init, headers }));
    for (const value of response.headers.getSetCookie()) {
      const [name, token] = value.split(';')[0].split('=');
      if (token) cookies.set(name, token); else cookies.delete(name);
    }
    return response;
  };
  const begin = async (path = '/login') => {
    const response = await send(path);
    expect(response.status).toBe(303);
    upstreamAuthorization = new URL(response.headers.get('location'));
    return upstreamAuthorization;
  };
  const callback = () => `/callback?code=fixture-code&state=${upstreamAuthorization.searchParams.get('state')}`;
  const login = async () => { await begin(); return send(callback()); };
  return { app, env, db, sqlite, send, begin, callback, login, cookies, calls, identity, emails, now: () => time, advance: ms => { time += ms; } };
}
