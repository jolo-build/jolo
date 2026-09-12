export function prefixCandidate(name, fallback, attempt = 0) {
  const clean = String(name).normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const stem = (/^[A-Z]/.test(clean) && clean.length >= 2 ? clean : fallback).slice(0, 12);
  return stem + (attempt === 0 ? '' : attempt < 8 ? String(attempt + 1) : crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase());
}

// The unique namespace covers both personal accounts and teams. A conflict on
// the workspace means another concurrent request already assigned its prefix.
export async function ensureTaskPrefix(db, { accountId = null, teamId = null, name }) {
  const find = () => db.prepare('SELECT prefix FROM task_prefixes WHERE account_id=?1 OR team_id=?2').bind(accountId, teamId).first();
  for (let attempt = 0; attempt < 16; attempt++) {
    const current = await find();
    if (current) return current.prefix;
    const candidate = prefixCandidate(name, teamId ? 'TEAM' : 'PERSONAL', attempt);
    const claimed = await db.prepare('INSERT INTO task_prefixes(prefix,account_id,team_id) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING RETURNING prefix').bind(candidate, accountId, teamId).first();
    if (claimed) return claimed.prefix;
  }
  throw new Error('Could not assign a unique workspace prefix.');
}
