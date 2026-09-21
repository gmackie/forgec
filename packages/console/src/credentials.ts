/**
 * Registry credentials, and the token exchange container clients use.
 *
 * Humans authenticate to the console through whatever `AuthAdapter` the instance configured.
 * Machines cannot: `docker login` sends HTTP Basic and expects the Distribution token dance, so
 * the registry keeps its own credentials and hands out short-lived bearer tokens.
 *
 * The secret is only ever returned once, at creation. Afterwards only a salted hash exists, so
 * a leaked database does not hand over push access.
 */
import { equalSecret } from "./auth.js";
import { Problem } from "./model.js";

export interface Credential {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CredentialStore {
  list(): Promise<Credential[]>;
  /** Returns the credential *and* the one-time plaintext secret. */
  create(input: {
    label: string;
    scopes: string[];
    createdBy: string;
    expiresAt?: string;
  }): Promise<{ credential: Credential; secret: string }>;
  revoke(id: string, at: string): Promise<boolean>;
  /** Null when the id is unknown, revoked, expired, or the secret does not match. */
  verify(id: string, secret: string): Promise<Credential | null>;
  touch(id: string, at: string): Promise<void>;
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hashSecret(salt: string, secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}${secret}`),
  );
  return hex(new Uint8Array(digest));
}

export function newSecret(): { id: string; secret: string; salt: string } {
  return {
    id: `fgc_${hex(crypto.getRandomValues(new Uint8Array(8)))}`,
    secret: hex(crypto.getRandomValues(new Uint8Array(32))),
    salt: hex(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** The subset of D1/SQLite this needs, so both hosts share one implementation. */
export interface SqlLike {
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<{ changes: number }>;
}

const toCredential = (row: Record<string, unknown>): Credential => ({
  id: String(row["id"]),
  label: String(row["label"]),
  scopes: String(row["scopes"]).split(",").filter(Boolean),
  createdAt: String(row["created_at"]),
  createdBy: String(row["created_by"]),
  lastUsedAt: row["last_used_at"] ? String(row["last_used_at"]) : null,
  expiresAt: row["expires_at"] ? String(row["expires_at"]) : null,
  revokedAt: row["revoked_at"] ? String(row["revoked_at"]) : null,
});

export function credentialStore(sql: SqlLike): CredentialStore {
  return {
    async list() {
      const rows = await sql.all(
        "SELECT * FROM registry_credentials ORDER BY created_at DESC",
        [],
      );
      return rows.map(toCredential);
    },
    async create({ label, scopes, createdBy, expiresAt }) {
      if (!label.trim()) throw new Problem(400, "Give the credential a label.");
      const allowed = scopes.filter((s) => s === "pull" || s === "push");
      if (allowed.length === 0)
        throw new Problem(400, "Grant at least one of pull or push.");
      const { id, secret, salt } = newSecret();
      const createdAt = new Date().toISOString();
      await sql.run(
        "INSERT INTO registry_credentials (id, label, secret_hash, secret_salt, scopes, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          label.trim(),
          await hashSecret(salt, secret),
          salt,
          allowed.join(","),
          createdAt,
          createdBy,
          expiresAt ?? null,
        ],
      );
      return {
        credential: {
          id,
          label: label.trim(),
          scopes: allowed,
          createdAt,
          createdBy,
          lastUsedAt: null,
          expiresAt: expiresAt ?? null,
          revokedAt: null,
        },
        secret,
      };
    },
    async revoke(id, at) {
      const result = await sql.run(
        "UPDATE registry_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        [at, id],
      );
      return result.changes === 1;
    },
    async verify(id, secret) {
      const rows = await sql.all(
        "SELECT * FROM registry_credentials WHERE id = ?",
        [id],
      );
      const row = rows[0];
      // Hash a decoy for an unknown id so a missing credential and a wrong secret cost the same.
      if (!row) {
        await hashSecret("0".repeat(32), secret);
        return null;
      }
      const credential = toCredential(row);
      if (credential.revokedAt) return null;
      if (credential.expiresAt && credential.expiresAt <= new Date().toISOString())
        return null;
      const expected = String(row["secret_hash"]);
      const actual = await hashSecret(String(row["secret_salt"]), secret);
      return (await equalSecret(actual, expected)) ? credential : null;
    },
    async touch(id, at) {
      await sql.run(
        "UPDATE registry_credentials SET last_used_at = ? WHERE id = ?",
        [at, id],
      );
    },
  };
}
