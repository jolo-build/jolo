ALTER TABLE login_flows ADD COLUMN return_to TEXT;

CREATE TABLE device_flows (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'approved', 'denied')),
  expires_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  poll_interval INTEGER NOT NULL DEFAULT 5
);
CREATE INDEX device_flows_expiry ON device_flows(expires_at);

CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX devices_account ON devices(account_id);
CREATE INDEX devices_expiry ON devices(expires_at);
