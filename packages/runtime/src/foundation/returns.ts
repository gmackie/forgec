import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime, toMinor, formatMinor } from '../codecs.js';
import { Storage } from '../services.js';
import { err, type ForgeError } from '../errors.js';
import { Inventory } from './inventory.js';
import { Fulfillments } from './fulfillment.js';
import { AgreementCatalog } from './agreement-catalog.js';
import { Decisions } from './decision.js';
import { Evaluations } from './evaluation.js';
import { Evidence } from './evidence.js';
import { Billing } from './billing.js';
import { Settlements, type SettlementAdmission } from './settlement.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/returns/_/', inv = '@forgegraph/foundation/inventory/_/', ep = '@forgegraph/foundation/entitlement/_/';
const bad = (message: string) => Effect.fail(err('ValidationFailed', message));
export class Returns {
 constructor(private readonly engine: Engine, private readonly settlementAdmission?: SettlementAdmission) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private movement(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.engine.call(inv + 'InventoryMovement.get', { id }, ctx), position = yield* new Inventory(self.engine).position(String(row.position), ctx);
   if (!position.events.some(e => e.id === row.id)) return yield* bad('Return movement is not admitted by Inventory');
   return { row, position };
  });
 }
 private request(id: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const request = yield* self.call('ReturnRequest.get', { id }, ctx), origin = yield* self.call('ReturnOrigin.get', { id: request.origin }, ctx);
   const issue = yield* self.movement(origin.issue, ctx), original = yield* new Fulfillments(self.engine).status(String(origin.fulfillment), ctx);
   if (original.phase !== 'completed' || String(original.end!.endedAt) > String(request.requestedAt)) return yield* bad('Return requires completed original fulfillment');
   yield* self.engine.call('@forgegraph/foundation/party/_/Party.get', { id: origin.customer }, ctx);
   yield* self.engine.call('@forgegraph/foundation/party/_/Party.get', { id: origin.supplier }, ctx);
   if (origin.agreement) {
    const agreement = yield* new AgreementCatalog(self.engine).state(String(origin.agreement), String(issue.row.at), ctx);
    if (agreement.phase !== 'Active') return yield* bad('Original agreement was not active at fulfillment');
   }
   const entitlement = yield* self.engine.call(ep + 'Entitlement.get', { id: request.entitlement }, ctx), end = yield* findTerminalFact(self.engine, ep + 'EntitlementEnd', 'entitlement', entitlement.id, ctx);
   yield* self.engine.call(ep + 'RightDefinition.get', { id: entitlement.right }, ctx);
   yield* self.engine.call(ep + 'EntitlementScope.get', { id: entitlement.scope }, ctx);
   if (at < String(entitlement.validFrom) || entitlement.validUntil && at >= String(entitlement.validUntil) || end && at >= String(end.effectiveAt) || entitlement.quantity != null && (entitlement.unit !== issue.position.unit || toMinor(String(request.quantity), 6) > toMinor(String(entitlement.quantity), 6))) return yield* bad('Return entitlement is not effective for the requested quantity');
   const approval = yield* new Decisions(self.engine).state(String(request.authorization), ctx);
   if (approval.outcome?.selected !== request.authorizedOption || String(approval.terminal?.createdAt) > at) return yield* bad('Return authorization requires the prebound approved option');
   return { request, origin, issue, entitlement };
  });
 }
 claims(origin: string, ctx: CallContext): Effect.Effect<{ events: Wire[]; quantity: string }, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const original = yield* self.call('ReturnOrigin.get', { id: origin }, ctx), issue = yield* self.movement(original.issue, ctx);
   const resource = self.engine.model.resource(p + 'ReturnAuthorization'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!, storage = yield* Storage, events: Wire[] = [];
   let quantity = 0n;
   for (let ordinal = 1; ordinal <= 128; ordinal++) {
    const values = { origin, ordinal }, found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
    if (!found) break;
    const event = yield* self.call('ReturnAuthorization.get', { id: found.id }, ctx), validated = yield* self.request(String(event.request), String(event.at), ctx);
    if ((event.previous ?? null) !== (events.at(-1)?.id ?? null)) return yield* bad('Return authorization chain is not consecutive');
    quantity += toMinor(String(validated.request.quantity), 6);
    if (quantity > toMinor(String(issue.row.quantity), 6) || validated.entitlement.quantity != null && quantity > toMinor(String(validated.entitlement.quantity), 6)) return yield* bad('Authorized returns exceed original issued quantity');
    events.push(event);
   }
   return { events, quantity: formatMinor(quantity, 6) };
  }).pipe(Effect.provide(self.engine.layer));
 }
 authorize(request: string, previous: string | null, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const instant = yield* Effect.try({ try: () => decodeDatetime(at), catch: () => err('ValidationFailed', 'Invalid authorization instant') });
   const validated = yield* self.request(request, instant, ctx), claims = yield* self.claims(String(validated.origin.id), ctx);
   if ((claims.events.at(-1)?.id ?? null) !== previous) return yield* Effect.fail(err('VersionConflict', 'Return authorization head changed'));
   if (toMinor(claims.quantity, 6) + toMinor(String(validated.request.quantity), 6) > toMinor(String(validated.issue.row.quantity), 6) || validated.entitlement.quantity != null && toMinor(claims.quantity, 6) + toMinor(String(validated.request.quantity), 6) > toMinor(String(validated.entitlement.quantity), 6)) return yield* bad('Return quantity exceeds remaining original fulfillment');
   return yield* self.call('ReturnAuthorization.create', { origin: validated.origin.id, request, ordinal: claims.events.length + 1, previous, at: instant }, ctx);
  });
 }
 receipt(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const receipt = yield* self.call('ReturnReceipt.get', { id }, ctx), authorization = yield* self.call('ReturnAuthorization.get', { id: receipt.authorization }, ctx);
   const state = yield* self.claims(String(authorization.origin), ctx);
   if (!state.events.some(e => e.id === authorization.id)) return yield* bad('Receipt lacks accepted return authorization');
   const request = yield* self.call('ReturnRequest.get', { id: authorization.request }, ctx), origin = yield* self.call('ReturnOrigin.get', { id: authorization.origin }, ctx), original = yield* self.movement(origin.issue, ctx), received = yield* self.movement(receipt.movement, ctx);
   if (received.row.item !== original.row.item || received.row.quantity !== request.quantity || received.position.row.custodian !== origin.supplier) return yield* bad('Receipt must return the authorized item/quantity to the supplier custody');
   return { receipt, request, origin, received };
  });
 }
 disposition(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('ReturnDisposition.get', { id }, ctx), receipt = yield* self.receipt(String(row.receipt), ctx), result = yield* new Evaluations(self.engine).result(String(row.inspection), ctx);
   const approval = yield* new Decisions(self.engine).state(String(receipt.request.dispositionDecision), ctx);
   if (result.run !== receipt.request.inspection || String(result.finishedAt) < String(receipt.received.row.at) || approval.outcome?.selected !== receipt.request.dispositionOption || String(approval.terminal?.createdAt) > String(row.at)) return yield* bad('Disposition requires pinned inspection and accepted decision');
   const seal = yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get', { id: row.support }, ctx);
   yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
   let moved = null;
   if (row.movement) {
    moved = yield* self.movement(row.movement, ctx);
    if (moved.row.kind !== 'transfer' || moved.row.position !== receipt.received.row.position || moved.row.quantity !== receipt.request.quantity || String(moved.row.at) < String(result.finishedAt)) return yield* bad('Disposition transfer must match the inspected receipt');
   }
   if (receipt.request.disposition === 'restock') {
    if (!moved) return yield* bad('Restock requires an admitted transfer');
    const destination = yield* self.engine.call(inv + 'InventoryPosition.get', { id: moved.row.destination }, ctx);
    if (destination.condition !== 'usable') return yield* bad('Restock destination must be usable');
   }
   if (['repair', 'scrap', 'supplier'].includes(String(receipt.request.disposition)) && !row.work) return yield* bad('Disposition requires separately traceable work');
   if (row.work) yield* new Fulfillments(self.engine).status(String(row.work), ctx);
   return { row, ...receipt, result };
  });
 }
 remedy(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('ReturnRemedy.get', { id }, ctx), disposition = yield* self.disposition(String(row.disposition), ctx), request = disposition.request, origin = disposition.origin;
   const kind = String(request.remedy);
   if ((kind === 'replacement') !== (row.replacement != null) || (kind === 'refund') !== (row.refund != null) || (kind === 'credit') !== (row.credit != null)) return yield* bad('Remedy does not match its authorized kind');
   if (row.replacement) {
    const replacement = yield* new Fulfillments(self.engine).status(String(row.replacement), ctx);
    if (row.replacement === origin.fulfillment || replacement.phase !== 'completed' || replacement.coverage !== 'complete' || String(replacement.end!.endedAt) > String(row.at)) return yield* bad('Replacement requires separate complete fulfillment');
   }
   if (row.refund) {
    const refund = yield* new Settlements(self.engine, self.settlementAdmission).inspect(String(row.refund), { asOf: String(row.at) }, ctx);
    if (refund.creditor !== origin.customer || refund.debtor !== origin.supplier || refund.unit !== request.unit || refund.settled !== request.amount) return yield* bad('Refund requires exact separately settled reverse obligation');
   }
   if (row.credit) {
    const bill = yield* new Billing(self.engine).inspect(String(row.creditBill), ctx), credit = bill.charges.find(c => c.id === row.credit);
    const period = yield* self.engine.call('@forgegraph/foundation/billing/_/BillingPeriod.get', { id: bill.bill.period }, ctx);
    if (!bill.issue || !credit || period.agreement !== origin.agreement || toMinor(String(credit.amount), 6) !== -toMinor(String(request.amount), 6)) return yield* bad('Credit requires an issued matching correction for the original agreement');
    const account = yield* self.engine.call('@forgegraph/foundation/ledger/_/Account.get', { id: credit.account }, ctx);
    if (account.unit !== request.unit) return yield* bad('Credit unit differs from authorized remedy');
   }
   return { row, disposition };
  });
 }
}
