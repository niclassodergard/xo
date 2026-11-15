-- Trusted-device cookies: a login that carries a known device token is rate-limited per device
-- instead of per IP / globally. Only the SHA-256 hash of the cookie token is stored.
CREATE TABLE devices (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
