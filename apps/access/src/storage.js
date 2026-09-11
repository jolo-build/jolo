export function createRepository(db, now = Date.now) {
  return {
    async account(identity, provider = 'github') {
      if (!['github', 'google'].includes(provider)) throw new Error('Unknown identity provider');
      // Link by immutable provider ID, never by a matching email address.
      return db.prepare(`INSERT INTO accounts (id, provider_key, provider, email, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider_key) DO UPDATE SET
        email = excluded.email, name = excluded.name, updated_at = excluded.updated_at
        RETURNING id, email, name, created_at`)
        .bind(crypto.randomUUID(), `${provider}:${identity.id}`, provider, identity.email, identity.name, now(), now()).first();
    },
    async saveFlow(hash, challenge, expiresAt, returnTo = null) {
      await db.prepare('INSERT INTO login_flows (token_hash, state, verifier, expires_at, return_to, provider, nonce) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(hash, challenge.state, challenge.verifier, expiresAt, returnTo, challenge.provider ?? 'github', challenge.nonce ?? null).run();
    },
    async consumeFlow(hash) {
      const row = await db.prepare('DELETE FROM login_flows WHERE token_hash = ? RETURNING state, verifier, expires_at, return_to, provider, nonce').bind(hash).first();
      return row && row.expires_at > now() ? row : null;
    },
    async removeFlow(hash) {
      await db.prepare('DELETE FROM login_flows WHERE token_hash = ?').bind(hash).run();
    },
    async saveSession(hash, accountID, csrf, expiresAt) {
      await db.prepare('INSERT INTO sessions (token_hash, account_id, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(hash, accountID, csrf, expiresAt, now()).run();
    },
    getSession(hash) {
      return db.prepare(`SELECT accounts.id, accounts.email, accounts.name, accounts.provider, accounts.created_at, sessions.csrf
        FROM sessions JOIN accounts ON accounts.id = sessions.account_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
        .bind(hash, now()).first();
    },
    async removeSession(hash) {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    },
    async createDeviceFlow(hash, userCode, name, address, scope = 'account:read') {
      return db.prepare('INSERT INTO device_flows (token_hash, user_code, name, address, expires_at, next_poll_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_code) DO NOTHING RETURNING user_code')
        .bind(hash, userCode, name, address, now() + 600_000, now() + 5000, scope).first();
    },
    getDeviceFlow(userCode) {
      return db.prepare("SELECT user_code, name, address, scope FROM device_flows WHERE user_code = ? AND state = 'pending' AND expires_at > ?").bind(userCode, now()).first();
    },
    decideDevice(userCode, accountID, decision) {
      return db.prepare("UPDATE device_flows SET state = ?, account_id = ? WHERE user_code = ? AND state = 'pending' AND expires_at > ? RETURNING user_code")
        .bind(decision, accountID, userCode, now()).first();
    },
    async pollDevice(hash) {
      // Claim the polling interval atomically. Concurrent and early polls cannot
      // redeem a grant; each early poll increases the interval as RFC 8628 requires.
      const early = await db.prepare('UPDATE device_flows SET poll_interval = poll_interval + 5, next_poll_at = ? + (poll_interval + 5) * 1000 WHERE token_hash = ? AND expires_at > ? AND next_poll_at > ? RETURNING poll_interval')
        .bind(now(), hash, now(), now()).first();
      if (early) return { error: 'slow_down', interval: early.poll_interval };
      const flow = await db.prepare('UPDATE device_flows SET next_poll_at = ? + poll_interval * 1000 WHERE token_hash = ? AND expires_at > ? AND next_poll_at <= ? RETURNING state, poll_interval')
        .bind(now(), hash, now(), now()).first();
      if (!flow) return { error: 'expired_token' };
      if (flow.state === 'pending') return { error: 'authorization_pending' };
      const claimed = await db.prepare("DELETE FROM device_flows WHERE token_hash = ? AND state != 'pending' AND expires_at > ? RETURNING state, account_id, name, scope")
        .bind(hash, now()).first();
      if (!claimed) return { error: 'expired_token' };
      if (claimed.state === 'denied') return { error: 'access_denied' };
      return claimed;
    },
    async cancelDeviceFlow(hash) {
      await db.prepare('DELETE FROM device_flows WHERE token_hash = ?').bind(hash).run();
    },
    async createDevice(id, hash, accountID, name, expiresAt, scope = 'account:read') {
      await db.prepare('INSERT INTO devices (id, token_hash, account_id, name, created_at, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, hash, accountID, name, now(), expiresAt, scope).run();
    },
    getDevice(hash) {
      return db.prepare(`SELECT accounts.id, accounts.name, accounts.email, devices.id AS device_id, devices.name AS device_name, devices.expires_at, devices.scope
        FROM devices JOIN accounts ON accounts.id = devices.account_id WHERE devices.token_hash = ? AND devices.expires_at > ?`).bind(hash, now()).first();
    },
    async listDevices(accountID) {
      return (await db.prepare('SELECT id, name, created_at, expires_at, scope FROM devices WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 100').bind(accountID, now()).all()).results;
    },
    async revokeDevice(id, accountID) {
      await db.prepare('DELETE FROM devices WHERE id = ? AND account_id = ?').bind(id, accountID).run();
    },
    async cleanup() {
      await db.batch([
        db.prepare('DELETE FROM login_flows WHERE expires_at <= ?').bind(now()),
        db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
        db.prepare('DELETE FROM device_flows WHERE expires_at <= ?').bind(now()),
        db.prepare('DELETE FROM devices WHERE expires_at <= ?').bind(now()),
        db.prepare('DELETE FROM mail_outbox WHERE created_at <= ?').bind(now() - 14 * 86400_000),
      ]);
    },
  };
}
