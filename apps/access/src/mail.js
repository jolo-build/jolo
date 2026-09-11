import { roleSQL } from './tasks/permissions.js';

const MAX_ATTEMPTS = 6;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000; // Resend retains idempotency keys for 24 hours.
const singleLine = value => String(value).replace(/[\r\n]+/g, ' ').trim();

export function mailConfigured(env) {
  return Boolean(env.RESEND_API_KEY && typeof env.MAIL_FROM === 'string' &&
    env.MAIL_FROM.length <= 320 && !/[\r\n]/.test(env.MAIL_FROM) &&
    /^(?:[^<>]+<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(env.MAIL_FROM.trim()));
}

/**
 * Renders the invitation message, or null when the service has no mail credentials. Nothing in the
 * invitation is read before that check, so a caller that only expects null may pass an empty bag.
 * @param env the Worker environment; `mailConfigured` names the bindings a message needs.
 * @param {{ team?: { name: string }, inviter?: { name: string }, recipient?: string, role?: string }} invitation
 */
export function invitationEmail(env, { team, inviter, recipient, role }) {
  if (!mailConfigured(env)) return null;
  return {
    from: env.MAIL_FROM,
    to: [recipient],
    subject: `You're invited to ${singleLine(team.name)} on Jolo`,
    text: `${singleLine(inviter.name)} invited you to join ${singleLine(team.name)} on Jolo as a ${role}.\n\nSign in with ${recipient}, then open Teams to accept your invitation:\n${new URL('/teams', env.ACCESS_ORIGIN).href}\n\nThis invitation expires in seven days. If you weren't expecting it, you can ignore this email.`,
  };
}

const eligible = `SELECT i.id FROM team_invitations i WHERE i.id=mail_outbox.id
  AND i.accepted_by IS NULL AND i.revoked_at IS NULL AND i.expires_at>?1
  AND (${roleSQL('i.team_id', 'i.inviter_id')}='owner' OR
    (${roleSQL('i.team_id', 'i.inviter_id')}='admin' AND i.role IN ('member','viewer')))`;

// Delivery goes through an injectable fetch so tests and the browser check never reach Resend. The
// stand-ins take the same arguments the platform's own fetch does.
/** @typedef {(...args: Parameters<typeof fetch>) => Promise<Response>} FetchLike */

/**
 * Claim each message atomically; retries reuse the same persisted payload and idempotency key.
 * @param env the Worker environment, carrying the mail credentials and the database binding.
 * @param {{ id?: string | null, now?: () => number, fetchImpl?: FetchLike }} [options] `id` narrows the
 *   run to one queued message, which is how the invitation route sends a new invitation immediately;
 *   the scheduled sweep passes nothing and drains whatever is due.
 */
export async function deliverMail(env, { id = null, now = Date.now, fetchImpl = fetch } = {}) {
  if (!mailConfigured(env) || !env.ACCESS_DB) return;
  const db = env.ACCESS_DB;
  const at = now();
  await db.prepare(`UPDATE mail_outbox SET state='cancelled', lease_until=NULL WHERE
    (state='pending' OR (state='sending' AND lease_until<=?1)) AND NOT EXISTS (${eligible})`).bind(at).run();
  await db.prepare(`UPDATE mail_outbox SET state='failed', last_error='retry_limit', lease_until=NULL WHERE
    (state='pending' OR (state='sending' AND lease_until<=?1)) AND (attempts>=?2 OR created_at<=?3)`)
    .bind(at, MAX_ATTEMPTS, at - RETRY_WINDOW_MS).run();
  const candidates = (await db.prepare(`SELECT id FROM mail_outbox WHERE
    (state='pending' AND available_at<=?1 OR state='sending' AND lease_until<=?1)
    AND (?2 IS NULL OR id=?2) ORDER BY created_at LIMIT 10`).bind(at, id).all()).results;
  for (const candidate of candidates) {
    const claimedAt = now();
    const message = await db.prepare(`UPDATE mail_outbox SET state='sending', attempts=attempts+1, lease_until=?3
      WHERE id=?2 AND (state='pending' AND available_at<=?1 OR state='sending' AND lease_until<=?1)
      AND attempts<?4 AND created_at>?5 AND EXISTS (${eligible}) RETURNING *`)
      .bind(claimedAt, candidate.id, claimedAt + 60_000, MAX_ATTEMPTS, claimedAt - RETRY_WINDOW_MS).first();
    if (!message) continue;
    let failure = 'network', retryable = true, providerId = null;
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `jolo-invitation/${message.id}` },
        body: message.payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const result = await response.json();
        if (typeof result.id === 'string' && result.id.length <= 200) providerId = result.id;
        else failure = 'invalid_response';
      } else {
        failure = `http_${response.status}`;
        retryable = response.status === 409 || response.status === 429 || response.status >= 500;
      }
    } catch { /* Persist a bounded code, never provider bodies, credentials, or recipient details. */ }
    if (providerId) {
      await db.prepare(`UPDATE mail_outbox SET state='sent', provider_id=?2, sent_at=?3, lease_until=NULL, last_error=NULL
        WHERE id=?1 AND state='sending' AND attempts=?4`).bind(message.id, providerId, now(), message.attempts).run();
    } else {
      const state = retryable && message.attempts < MAX_ATTEMPTS ? 'pending' : 'failed';
      await db.prepare(`UPDATE mail_outbox SET state=?2, last_error=?3, available_at=?4, lease_until=NULL
        WHERE id=?1 AND state='sending' AND attempts=?5`)
        .bind(message.id, state, failure, now() + Math.min(900_000, 30_000 * 2 ** (message.attempts - 1)), message.attempts).run();
    }
  }
}
