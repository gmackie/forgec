/**
 * Node/SQLite implementation of the Action Center's durable projection and
 * command-intent ledger. The database, rather than an in-memory Map, owns
 * sequencing, replay protection, and the dispatch claim.
 *
 * This is an executable local/Node profile. Cloudflare/Dynamo providers need
 * their own atomicity/concurrency certification; D1 cannot be treated as an
 * interactive SQLite transaction merely because its SQL syntax is familiar.
 */
import { DatabaseSync } from 'node:sqlite';
import { digest } from './index.mjs';

const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`invalid ${label}`);
};
const parse = value => JSON.parse(value);

export class SqliteActionLedger {
  #db;
  #own;
  constructor({ filename = ':memory:', database, now = () => new Date().toISOString() } = {}) {
    if (database && typeof database.prepare !== 'function') throw new TypeError('SQLite database required');
    this.#db = database ?? new DatabaseSync(filename);
    this.#own = !database;
    this.now = now;
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS action_projections (
        tenant TEXT NOT NULL, source TEXT NOT NULL, subject TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        hash TEXT NOT NULL, stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
        record TEXT NOT NULL,
        PRIMARY KEY (tenant, source, subject)
      );
      CREATE INDEX IF NOT EXISTS action_projections_tenant_state
        ON action_projections (tenant, stale, source, subject);
      CREATE TABLE IF NOT EXISTS action_inbox (
        tenant TEXT NOT NULL, source TEXT NOT NULL, event_id TEXT NOT NULL,
        subject TEXT NOT NULL, revision INTEGER NOT NULL,
        payload_hash TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY (tenant, source, event_id)
      );
      CREATE TABLE IF NOT EXISTS action_command_intents (
        backend_key TEXT PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT NOT NULL,
        client_key TEXT NOT NULL, source TEXT NOT NULL, subject TEXT NOT NULL,
        revision INTEGER NOT NULL, action TEXT NOT NULL, purpose TEXT NOT NULL,
        request_hash TEXT NOT NULL, state TEXT NOT NULL,
        receipt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant, actor, client_key)
      );
      CREATE INDEX IF NOT EXISTS action_command_intents_reconcile
        ON action_command_intents (state, tenant, updated_at);
    `);
  }
  #atomic(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Atomic replay/sequence claim. Event IDs are unique only within a trusted producer and tenant. */
  ingest({ source, eventId, record, fullSnapshot = false }) {
    required(source, 'producer'); required(eventId, 'event ID');
    if (eventId.length > 256) throw new TypeError('event ID too long');
    if (!record || record.source !== source) throw new TypeError('mismatched producer record');
    required(record.tenant, 'tenant'); required(record.subject, 'subject');
    const hash = digest(record);
    const payloadHash = digest({ record, fullSnapshot });
    const { tenant, subject, revision } = record;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('invalid revision');
    return this.#atomic(() => {
      const seen = this.#db.prepare('SELECT payload_hash FROM action_inbox WHERE tenant=? AND source=? AND event_id=?').get(tenant, source, eventId);
      if (seen) {
        if (seen.payload_hash !== payloadHash) throw new Error('conflicting event ID');
        return { accepted: false, reason: 'duplicate-event' };
      }
      const previous = this.#db.prepare('SELECT revision, hash, stale FROM action_projections WHERE tenant=? AND source=? AND subject=?').get(tenant, source, subject);
      let accepted = true, reason = 'applied', stale = 0, write = true;
      if (previous && revision < previous.revision) { accepted = false; reason = 'stale'; write = false; }
      else if (previous && revision === previous.revision) {
        if (hash !== previous.hash) throw new Error('conflicting source revision');
        if (previous.stale && fullSnapshot) { reason = 'resynchronized'; }
        else { accepted = false; reason = 'duplicate'; write = false; }
      } else if (previous && revision > previous.revision + 1 && !fullSnapshot) {
        accepted = false; reason = 'gap'; stale = 1;
      } else if (previous?.stale && !fullSnapshot) {
        accepted = false; reason = 'resync-required'; stale = 1;
      }
      this.#db.prepare('INSERT INTO action_inbox (tenant, source, event_id, subject, revision, payload_hash, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tenant, source, eventId, subject, revision, payloadHash, this.now());
      if (write) {
        this.#db.prepare(`INSERT INTO action_projections (tenant, source, subject, revision, hash, stale, record)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant, source, subject) DO UPDATE SET revision=excluded.revision, hash=excluded.hash,
            stale=excluded.stale, record=excluded.record`).run(tenant, source, subject, revision, hash, stale, JSON.stringify(record));
      }
      return { accepted, reason };
    });
  }
  get(tenant, source, subject) {
    const row = this.#db.prepare('SELECT record, stale FROM action_projections WHERE tenant=? AND source=? AND subject=?').get(tenant, source, subject);
    return row ? { record: parse(row.record), stale: Boolean(row.stale) } : null;
  }
  listTenant(tenant) {
    // A bounded read cannot silently yield an incomplete authorization view.
    const rows = this.#db.prepare('SELECT record, stale FROM action_projections WHERE tenant=? ORDER BY source, subject LIMIT 5001').all(tenant);
    if (rows.length > 5000) throw new Error('action projection page limit exceeded');
    return rows.map(row => ({ record: parse(row.record), stale: Boolean(row.stale) }));
  }
  #intent(row) {
    return row ? {
      backendKey: row.backend_key, tenant: row.tenant, actor: row.actor, source: row.source,
      subject: row.subject, revision: row.revision, action: row.action, purpose: row.purpose,
      state: row.state, receiptId: row.receipt_id ?? null,
    } : null;
  }
  reserveIntent(command) {
    for (const field of ['tenant', 'actor', 'source', 'subject', 'action', 'purpose', 'idempotencyKey']) required(command[field], field);
    if (!Number.isSafeInteger(command.revision) || command.revision < 1) throw new TypeError('invalid command revision');
    const { tenant, actor, source, subject, revision, action, purpose, idempotencyKey } = command;
    const terms = { tenant, actor, source, subject, revision, action, purpose };
    const backendKey = digest({ version: 1, terms });
    const requestHash = digest({ terms, input: command.input ?? null });
    return this.#atomic(() => {
      const previousKey = this.#db.prepare('SELECT * FROM action_command_intents WHERE tenant=? AND actor=? AND client_key=?').get(tenant, actor, idempotencyKey);
      if (previousKey) {
        if (previousKey.request_hash !== requestHash) throw new Error('idempotency_conflict');
        return { intent: this.#intent(previousKey), created: false };
      }
      const previous = this.#db.prepare('SELECT * FROM action_command_intents WHERE backend_key=?').get(backendKey);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new Error('operation_conflict');
        return { intent: this.#intent(previous), created: false };
      }
      const timestamp = this.now();
      this.#db.prepare(`INSERT INTO action_command_intents
        (backend_key, tenant, actor, client_key, source, subject, revision, action, purpose, request_hash, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
        backendKey, tenant, actor, idempotencyKey, source, subject, revision, action, purpose, requestHash, timestamp, timestamp);
      return { intent: this.#intent(this.#db.prepare('SELECT * FROM action_command_intents WHERE backend_key=?').get(backendKey)), created: true };
    });
  }
  claimIntent(backendKey) {
    return this.#atomic(() => {
      const result = this.#db.prepare("UPDATE action_command_intents SET state='in_progress', updated_at=? WHERE backend_key=? AND state='reserved'").run(this.now(), backendKey);
      return result.changes === 1;
    });
  }
  settleIntent(backendKey, { state, receiptId = null }) {
    if (!['acknowledged', 'uncertain', 'rejected'].includes(state)) throw new TypeError('invalid settlement state');
    if (receiptId !== null) required(receiptId, 'provider receipt');
    return this.#atomic(() => {
      const row = this.#db.prepare('SELECT * FROM action_command_intents WHERE backend_key=?').get(backendKey);
      if (!row) throw new Error('missing command intent');
      if (row.state === state && row.receipt_id === receiptId) return this.#intent(row);
      // An uncertain remote result can later be reconciled, but cannot be
      // opportunistically retried or overwritten with a contradictory result.
      if (!(row.state === 'in_progress' || (row.state === 'uncertain' && state === 'acknowledged'))) throw new Error('invalid command settlement transition');
      this.#db.prepare('UPDATE action_command_intents SET state=?, receipt_id=?, updated_at=? WHERE backend_key=?').run(state, receiptId, this.now(), backendKey);
      return this.#intent(this.#db.prepare('SELECT * FROM action_command_intents WHERE backend_key=?').get(backendKey));
    });
  }
  getIntent(backendKey) { return this.#intent(this.#db.prepare('SELECT * FROM action_command_intents WHERE backend_key=?').get(backendKey)); }
  listRecovery({ tenant, limit = 100 } = {}) {
    required(tenant, 'tenant');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid limit');
    return this.#db.prepare("SELECT * FROM action_command_intents WHERE tenant=? AND state IN ('reserved','in_progress','uncertain') ORDER BY created_at, backend_key LIMIT ?")
      .all(tenant, limit).map(row => this.#intent(row));
  }
  close() { if (this.#own) this.#db.close(); }
}
