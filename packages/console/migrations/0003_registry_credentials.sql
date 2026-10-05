-- Credentials for the registry's own Bearer scheme.
--
-- These exist because Cloudflare Access cannot authenticate a container client: Access
-- identifies machines with CF-Access-Client-* headers and the Docker CLI cannot send custom
-- headers, since it reserves Authorization for the registry's own auth. So humans authenticate
-- to the console through Access, and the console mints these for machines.
--
-- The secret is stored as a salted SHA-256, never in the clear. Deliberately not bcrypt or
-- argon2: neither exists in workerd, and a slow KDF defends against guessing a *chosen* secret.
-- These are 32 bytes from crypto.getRandomValues, so there is nothing to guess and the cost
-- would buy nothing. If these ever become user-chosen, this reasoning stops holding.
CREATE TABLE IF NOT EXISTS registry_credentials (
  id           TEXT PRIMARY KEY,   -- public identifier; the username for `docker login`
  label        TEXT NOT NULL,      -- what it is for, so an operator can revoke the right one
  secret_hash  TEXT NOT NULL,      -- hex sha256(salt || secret)
  secret_salt  TEXT NOT NULL,      -- hex, 16 random bytes, per credential
  scopes       TEXT NOT NULL,      -- comma-separated: 'pull' or 'pull,push'
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,      -- the Access identity that minted it
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);
-- Revocation is checked on every token exchange, so it wants an index rather than a scan.
CREATE INDEX IF NOT EXISTS registry_credentials_active
  ON registry_credentials (revoked_at);
