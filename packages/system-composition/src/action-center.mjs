/**
 * Read-through Action Center projection. It is deliberately NOT an approval,
 * task, decision or fulfillment authority. Its publisher and authorization
 * ports MUST be supplied by the trusted host, not by an agent's request body.
 */
import { digest } from './index.mjs';

const statuses = new Set(['pending', 'resolved', 'withdrawn']);
const scopes = new Set(['read', 'decide', 'execute', 'respond']);
const required = (v, label) => {
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`invalid ${label}`);
};
const keyOf = (tenant, source, subject) => JSON.stringify([tenant, source, subject]);

/** Shared canonical event validation for ephemeral and durable projections. */
export function normalizeActionEvent(producerId, producer, event) {
  required(event?.tenant, 'tenant'); required(event?.subject, 'subject');
  required(event?.kind, 'kind'); required(event?.label, 'label');
  if (!Number.isSafeInteger(event.revision) || event.revision < 1) throw new TypeError('revision must be positive safe integer');
  if (!statuses.has(event.status)) throw new TypeError('invalid action status');
  if (!Array.isArray(event.assignees) || !event.assignees.length || event.assignees.some(a => typeof a !== 'string' || !a.trim()) || new Set(event.assignees).size !== event.assignees.length) throw new TypeError('invalid assignees');
  if (!Array.isArray(event.actions) || event.actions.some(a => !scopes.has(a))) throw new TypeError('invalid action verbs');
  if (event.status === 'pending' && !event.actions.length) throw new TypeError('pending action must have an available command');
  if (event.dueAt !== undefined && (!Number.isFinite(Date.parse(event.dueAt)))) throw new TypeError('invalid deadline');
  if (Array.isArray(producer.kinds) && !producer.kinds.includes(event.kind)) throw new Error('producer does not own action kind');
  // Normalize only display-safe metadata. Never mirror raw payload, source
  // documents, credentials, or evidence into the read model.
  const normalized = {
    tenant: event.tenant, source: producerId, subject: event.subject,
    kind: event.kind, label: event.label, status: event.status,
    revision: event.revision, assignees: [...event.assignees], actions: [...new Set(event.actions)],
    ...(event.dueAt ? { dueAt: event.dueAt } : {}),
  };
  return normalized;
}

export class ActionCenter {
  #producers;
  #authorize;
  #dispatch;
  #records = new Map();
  constructor({ producers, authorize, dispatch }) {
    if (!producers || typeof producers !== 'object' || !Object.keys(producers).length) throw new TypeError('trusted producers required');
    if (typeof authorize !== 'function' || typeof dispatch !== 'function') throw new TypeError('authorization and dispatch ports required');
    this.#producers = new Map(Object.entries(producers));
    this.#authorize = authorize;
    this.#dispatch = dispatch;
  }
  /** Publish only from an authenticated/verified producer adapter. */
  ingest(producerId, event) {
    const producer = this.#producers.get(producerId);
    if (!producer) throw new Error('unknown trusted producer');
    const normalized = normalizeActionEvent(producerId, producer, event);
    const id = keyOf(normalized.tenant, producerId, normalized.subject);
    const hash = digest(normalized);
    const previous = this.#records.get(id);
    if (previous && normalized.revision < previous.record.revision) return { accepted: false, reason: 'stale', id };
    if (previous && normalized.revision === previous.record.revision) {
      if (hash !== previous.hash) throw new Error('conflicting source revision');
      if (previous.stale && event.fullSnapshot === true) {
        this.#records.set(id, { record: normalized, hash, stale: false });
        return { accepted: true, reason: 'resynchronized', id };
      }
      return { accepted: false, reason: 'duplicate', id };
    }
    if (previous && normalized.revision > previous.record.revision + 1 && event.fullSnapshot !== true) {
      // A version gap makes the projection non-actionable until resynchronized.
      this.#records.set(id, { record: normalized, hash, stale: true });
      return { accepted: false, reason: 'gap', id };
    }
    if (previous?.stale && event.fullSnapshot !== true) return { accepted: false, reason: 'resync-required', id };
    this.#records.set(id, { record: normalized, hash, stale: false });
    return { accepted: true, id };
  }
  async list({ tenant, actor, purpose = 'work.read' }) {
    required(tenant, 'tenant'); required(actor, 'actor'); required(purpose, 'purpose');
    const matches = [];
    for (const { record, stale } of this.#records.values()) {
      if (stale || record.tenant !== tenant || record.status !== 'pending' || !record.assignees.includes(actor)) continue;
      if (await this.#authorize({ actor, tenant, purpose, operation: 'read', record }) !== true) continue;
      matches.push(structuredClone(record));
    }
    return matches.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.source.localeCompare(b.source) || a.subject.localeCompare(b.subject));
  }
  /** Command does not mark the projection resolved. A source update must do so. */
  async invoke({ tenant, actor, source, subject, revision, action, purpose, idempotencyKey }) {
    for (const [v, label] of [[tenant, 'tenant'], [actor, 'actor'], [source, 'source'], [subject, 'subject'], [action, 'action'], [purpose, 'purpose'], [idempotencyKey, 'idempotency key']]) required(v, label);
    if (!this.#producers.has(source)) throw new Error('unknown trusted producer');
    const entry = this.#records.get(keyOf(tenant, source, subject));
    if (!entry || entry.stale || entry.record.status !== 'pending') throw new Error('action not available');
    if (revision !== entry.record.revision) throw new Error('stale action revision');
    if (!entry.record.assignees.includes(actor) || !entry.record.actions.includes(action)) throw new Error('action not available');
    if (await this.#authorize({ tenant, actor, purpose, operation: action, record: entry.record }) !== true) throw new Error('not authorized');
    // The authoritative provider MUST also revalidate actor, purpose, current
    // revision, idempotency, and business decisions before side effects.
    const response = await this.#dispatch({ tenant, actor, source, subject, revision, action, purpose, idempotencyKey });
    return { state: 'submitted', providerResponse: response };
  }
}
