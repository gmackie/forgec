/**
 * Authorized composition API, never an alternate Foundation data authority.
 * Every callable operation maps to an exact catalog owner and an explicitly
 * installed trusted binding. No user-controllable provider URLs or CRUD escape.
 */
import { validateCatalog } from './index.mjs';

const text = (v, label) => {
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`invalid ${label}`);
};
const keyOf = (system, operation) => `${system}/${operation}`;

export class SystemGateway {
  #catalog; #bindings; #authorize; #ledger;
  constructor({ catalog, bindings, authorize, ledger }) {
    validateCatalog(catalog);
    if (!bindings || typeof bindings !== 'object') throw new TypeError('trusted operation bindings required');
    if (typeof authorize !== 'function') throw new TypeError('trusted authorization port required');
    this.#catalog = catalog;
    this.#bindings = new Map();
    this.#authorize = authorize;
    this.#ledger = ledger;
    for (const [key, binding] of Object.entries(bindings)) {
      const [sysId, operationId, extra] = key.split('/');
      const sys = catalog.systems.find(s=>s.id===sysId);
      const operation = sys?.operations.find(op=>op.id===operationId);
      if (!operation || extra || key !== keyOf(sysId,operationId)) throw new Error(`unrecognized operation binding ${key}`);
      if (binding?.owner!==operation.owner || typeof binding.validate!=='function' || typeof binding.execute!=='function' || typeof binding.project!=='function') {
        throw new TypeError(`invalid or unauthorized trusted binding ${key}`);
      }
      if (!binding.inputSchema || binding.inputSchema.type!=='object' || binding.inputSchema.additionalProperties!==false) {
        throw new TypeError(`closed JSON Schema required for ${key}`);
      }
      if (operation.kind==='command' && (typeof binding.logicalKey!=='function' || typeof binding.revision!=='function')) {
        throw new TypeError(`command ${key} must bind stable business identity and revision`);
      }
      this.#bindings.set(key,{ system:sys, operation, binding });
    }
    if ([...this.#bindings.values()].some(x=>x.operation.kind==='command') &&
        (!ledger || typeof ledger.reserveIntent!=='function' || typeof ledger.claimIntent!=='function' || typeof ledger.settleIntent!=='function')) {
      throw new TypeError('durable command ledger required');
    }
  }
  operations() {
    return [...this.#bindings.values()].map(({system,operation,binding}) => ({
      system:system.id, name:operation.id, kind:operation.kind,
      purpose:operation.purpose, owner:operation.owner,
      inputSchema:structuredClone(binding.inputSchema),
    })).sort((a,b)=>keyOf(a.system,a.name).localeCompare(keyOf(b.system,b.name)));
  }
  async invoke({ principal, systemId, operationId, input, idempotencyKey }) {
    if (!principal || principal.verified !== true) throw new Error('unauthenticated');
    text(principal.tenant,'trusted tenant'); text(principal.actor,'trusted actor');
    text(systemId,'system'); text(operationId,'operation');
    const installed=this.#bindings.get(keyOf(systemId,operationId));
    if (!installed) throw new Error('operation not installed');
    const {binding,operation}=installed;
    const checked=await binding.validate(input);
    // `validate` is a trusted decoder, must return an object containing only
    // the explicitly modeled operation terms; never trust the caller's actor.
    if (!checked || typeof checked!=='object' || Array.isArray(checked)) throw new TypeError('invalid decoded operation input');
    const context={tenant:principal.tenant,actor:principal.actor,principal,purpose:operation.purpose,operation:operation.id,system:systemId,owner:operation.owner,input:checked};
    if (await this.#authorize(context)!==true) throw new Error('not authorized');
    if (operation.kind==='query') {
      const result=await binding.execute({context,input:checked});
      return {state:'queried',data:structuredClone(await binding.project(result,context))};
    }
    text(idempotencyKey,'idempotency key');
    const subject=binding.logicalKey(checked,context),revision=binding.revision(checked,context);
    text(subject,'business operation key');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('invalid business revision');
    const {intent,created}=this.#ledger.reserveIntent({
      tenant:principal.tenant,actor:principal.actor,source:systemId,subject,
      revision,action:operationId,purpose:operation.purpose,idempotencyKey,input:checked,
    });
    if (!created) return {state:intent.state,backendKey:intent.backendKey,replay:true,receiptId:intent.receiptId};
    if (!this.#ledger.claimIntent(intent.backendKey)) return {state:'in_progress',backendKey:intent.backendKey,replay:true};
    try {
      const result=await binding.execute({context,input:checked,idempotencyKey:intent.backendKey});
      const published=await binding.project(result,context);
      // This projection is not evidence of business fulfillment or acceptance.
      if (published?.accepted === true && typeof published.receiptId==='string' && published.receiptId) {
        this.#ledger.settleIntent(intent.backendKey,{state:'acknowledged',receiptId:published.receiptId});
        return {state:'acknowledged',backendKey:intent.backendKey,receiptId:published.receiptId};
      }
      if (published?.accepted===false && published.definitive===true) {
        this.#ledger.settleIntent(intent.backendKey,{state:'rejected'});
        return {state:'rejected',backendKey:intent.backendKey};
      }
      this.#ledger.settleIntent(intent.backendKey,{state:'uncertain'});
      return {state:'uncertain',backendKey:intent.backendKey};
    } catch(_error) {
      this.#ledger.settleIntent(intent.backendKey,{state:'uncertain'});
      return {state:'uncertain',backendKey:intent.backendKey};
    }
  }
}

/** MCP tools are **descriptors**, not a second execution path. Bind their calls
 * to `gateway.invoke` in the authenticated MCP transport; principal is a
 * trusted transport result, not a tool parameter. */
export function mcpDescriptors(gateway) {
  return gateway.operations().map(op=>({
    name:`forge_${op.system.replaceAll('-','_')}__${op.name.replaceAll('-','_')}`,
    description:`${op.kind} ${op.system}/${op.name} (${op.purpose}). The authoritative ${op.owner} provider enforces the operation.`,
    inputSchema:{
      type:'object',
      properties:{
        input:op.inputSchema,
        ...(op.kind==='command'?{idempotencyKey:{type:'string',minLength:1,maxLength:256}}:{}),
      },
      required:op.kind==='command'?['input','idempotencyKey']:['input'],
      additionalProperties:false,
    },
    annotations:{readOnlyHint:op.kind==='query',destructiveHint:op.kind==='command',openWorldHint:true},
    _binding:{systemId:op.system,operationId:op.name},
  }));
}

/** Minimal transport-independent entrypoint for MCP tools/call. Actual HTTP
 * and stdio transport/session/origin handling belongs to the supported MCP
 * server, not this framework-neutral descriptor. */
export async function callMcpTool({gateway,descriptors,principal,toolName,arguments:input,idempotencyKey}) {
  const tool=descriptors.find(d=>d.name===toolName);
  if (!tool) throw new Error('unknown MCP tool');
  return gateway.invoke({principal,...tool._binding,input,idempotencyKey});
}
