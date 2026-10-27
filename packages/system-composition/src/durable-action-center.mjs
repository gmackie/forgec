/** Durable controller over an atomic event/invocation ledger. No direct CRUD
 * to approvals, KanBanger or ForgeGraph; actual decisions stay upstream. */
import { normalizeActionEvent } from './action-center.mjs';

function nonempty(v, label) {
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`invalid ${label}`);
}

export class DurableActionCenter {
  #producers;
  #ledger;
  #authorize;
  #dispatch;
  #reconcile;
  constructor({ producers, ledger, authorize, dispatch, reconcile }) {
    if (!producers || typeof producers !== 'object' || !Object.keys(producers).length) throw new TypeError('trusted producers required');
    if (!ledger || typeof ledger.ingest !== 'function' || typeof ledger.reserveIntent !== 'function' || typeof ledger.listTenant !== 'function') throw new TypeError('atomic ledger required');
    if (typeof authorize !== 'function' || typeof dispatch !== 'function') throw new TypeError('trusted ports required');
    this.#producers = new Map(Object.entries(producers));
    for (const [name, producer] of this.#producers) {
      if (!producer?.purposes || typeof producer.purposes!=='object' || Object.keys(producer.purposes).length===0) throw new TypeError(`trusted action purposes required for ${name}`);
      for (const [verb,purpose] of Object.entries(producer.purposes)) { nonempty(verb,'action verb'); nonempty(purpose,'action purpose'); }
    }
    this.#ledger = ledger; this.#authorize = authorize; this.#dispatch = dispatch;
    this.#reconcile = reconcile;
  }
  /** Authenticated producer ID is passed by hosting middleware, never request JSON. */
  ingest(producerId, eventId, payload) {
    const producer = this.#producers.get(producerId);
    if (!producer) throw new Error('unknown trusted producer');
    const record = normalizeActionEvent(producerId, producer, payload);
    if (record.actions.some(verb=>!producer.purposes[verb])) throw new Error('producer action has no trusted purpose');
    return this.#ledger.ingest({ source: producerId, eventId, record, fullSnapshot: payload.fullSnapshot === true });
  }
  async list({ tenant, actor, purpose = 'work.read' }) {
    nonempty(tenant, 'tenant'); nonempty(actor, 'actor'); nonempty(purpose, 'purpose');
    const records = this.#ledger.listTenant(tenant);
    const result = [];
    for (const { record, stale } of records) {
      if (stale || record.status !== 'pending' || !record.assignees.includes(actor)) continue;
      if (await this.#authorize({ actor, tenant, purpose, operation: 'read', record }) !== true) continue;
      result.push(structuredClone(record));
    }
    return result.sort((a,b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.source.localeCompare(b.source) || a.subject.localeCompare(b.subject));
  }
  async invoke(command) {
    for (const field of ['tenant','actor','source','subject','action','purpose','idempotencyKey']) nonempty(command?.[field], field);
    const producer=this.#producers.get(command.source);
    if (!producer) throw new Error('unknown trusted producer');
    if (producer.purposes[command.action]!==command.purpose) throw new Error('not authorized: action purpose mismatch');
    const entry = this.#ledger.get(command.tenant, command.source, command.subject);
    if (!entry || entry.stale || entry.record.status !== 'pending') throw new Error('action not available');
    if (entry.record.revision !== command.revision) throw new Error('stale action revision');
    if (!entry.record.assignees.includes(command.actor) || !entry.record.actions.includes(command.action)) throw new Error('action not available');
    if (await this.#authorize({ tenant: command.tenant, actor: command.actor, purpose: command.purpose, operation: command.action, record: entry.record }) !== true) throw new Error('not authorized');
    const { intent, created } = this.#ledger.reserveIntent(command);
    if (!created) return { state: intent.state, backendKey: intent.backendKey, replay: true, receiptId: intent.receiptId };
    if (!this.#ledger.claimIntent(intent.backendKey)) return { state: 'in_progress', backendKey: intent.backendKey, replay: true };
    return this.#dispatchClaimed(command, intent.backendKey);
  }
  async #dispatchClaimed(command, backendKey) {
    try {
      // The producer must revalidate source revision, actor, purpose and
      // its own business policy. We never accept a provider URL from users.
      const response = await this.#dispatch({
        tenant: command.tenant, actor: command.actor, source: command.source,
        subject: command.subject, revision: command.revision,
        action: command.action, purpose: command.purpose,
        idempotencyKey: backendKey,
      });
      if (response?.accepted !== true || typeof response?.receiptId !== 'string' || !response.receiptId) {
        if (response?.accepted === false && response?.definitive === true) {
          this.#ledger.settleIntent(backendKey, { state: 'rejected' });
          return { state: 'rejected', backendKey };
        }
        this.#ledger.settleIntent(backendKey, { state: 'uncertain' });
        return { state: 'uncertain', backendKey };
      }
      this.#ledger.settleIntent(backendKey, { state: 'acknowledged', receiptId: response.receiptId });
      return { state: 'acknowledged', backendKey, receiptId: response.receiptId };
    } catch (_error) {
      this.#ledger.settleIntent(backendKey, { state: 'uncertain' });
      return { state: 'uncertain', backendKey };
    }
  }
  /** An atomic reservation without a dispatch claim is safe to resume. An
   * in-progress/uncertain claim NEVER qualifies: the provider may have acted. */
  async resumeReserved({ tenant, backendKey, operator }) {
    for (const [value,label] of [[tenant,'tenant'],[backendKey,'backend key'],[operator,'operator']]) nonempty(value,label);
    const intent = this.#ledger.getIntent(backendKey);
    if (!intent || intent.tenant !== tenant) throw new Error('command not found');
    if (await this.#authorize({tenant,actor:operator,purpose:'action.resume',operation:'resume',record:intent})!==true) throw new Error('not authorized');
    if (intent.state !== 'reserved') return {state:intent.state,backendKey};
    const entry = this.#ledger.get(tenant,intent.source,intent.subject);
    if (!entry || entry.stale || entry.record.revision!==intent.revision || entry.record.status!=='pending' ||
        !entry.record.assignees.includes(intent.actor) || !entry.record.actions.includes(intent.action)) {
      // We cannot call the provider on an obsolete decision invitation.
      if (this.#ledger.abandonReserved(backendKey)) return {state:'superseded',backendKey,blocked:'source-state-changed'};
      return {state:this.#ledger.getIntent(backendKey)?.state??'unknown',backendKey};
    }
    if (await this.#authorize({tenant,actor:intent.actor,purpose:intent.purpose,operation:intent.action,record:entry.record})!==true) {
      if (this.#ledger.abandonReserved(backendKey)) return {state:'superseded',backendKey,blocked:'actor-no-longer-authorized'};
      return {state:this.#ledger.getIntent(backendKey)?.state??'unknown',backendKey};
    }
    if (!this.#ledger.claimIntent(backendKey)) return {state:'in_progress',backendKey,replay:true};
    return this.#dispatchClaimed(intent,backendKey);
  }

  /** Trusted operator recovery: read upstream by the stable backend key only.
   * `absent` and `unknown` keep the intent uncertain; neither retries execution. */
  async reconcileIntent({ tenant, backendKey, operator }) {
    for (const [value,label] of [[tenant,'tenant'],[backendKey,'backend key'],[operator,'operator']]) nonempty(value,label);
    if (typeof this.#reconcile !== 'function') throw new Error('no trusted reconciliation port');
    const intent = this.#ledger.getIntent(backendKey);
    if (!intent || intent.tenant !== tenant) throw new Error('command not found');
    if (await this.#authorize({tenant, actor:operator, purpose:'action.reconcile', operation:'reconcile', record:intent}) !== true) throw new Error('not authorized');
    if (!['uncertain','in_progress'].includes(intent.state)) return { state: intent.state, backendKey };
    const evidence = await this.#reconcile({ ...intent, operator });
    if (evidence?.confirmed === true && typeof evidence?.receiptId === 'string' && evidence.receiptId) {
      this.#ledger.settleIntent(backendKey, {state:'acknowledged', receiptId:evidence.receiptId});
      return {state:'acknowledged',backendKey,receiptId:evidence.receiptId};
    }
    if (intent.state==='in_progress') this.#ledger.settleIntent(backendKey,{state:'uncertain'});
    return {state:'uncertain',backendKey};
  }
}
