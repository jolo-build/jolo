// Preserve account IDs and all referencing sessions, devices, tasks and memberships.
const sql = `ALTER TABLE accounts RENAME COLUMN github_id TO provider_key;
UPDATE accounts SET provider_key = 'github:' || provider_key;
ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'google'));
ALTER TABLE login_flows ADD COLUMN provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'google'));
ALTER TABLE login_flows ADD COLUMN nonce TEXT;
`;

export default sql;
