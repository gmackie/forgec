import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime } from '../codecs.js';
import { Storage, Clock } from '../services.js';
import { err, type ForgeError } from '../errors.js';
import { Evidence } from './evidence.js';
import { Attestations } from './attestation.js';
import { ResourceRelations } from './resource-relations.js';
const p = '@forgegraph/foundation/asset-lifecycle/_/', r = '@forgegraph/foundation/resource-relations/_/';
export type AssetAction = 'acquire' | 'provision' | 'commission' | 'operate' | 'deactivate' | 'move' | 'refurbish' | 'retire' | 'decommission';
export type AssetPhase = 'unprovisioned' | 'acquired' | 'commissioned' | 'operational' | 'inactive' | 'retired' | 'decommissioned';
export interface AssetState { row: Wire; events: Wire[]; phase: AssetPhase; head: string | null; place: string | null; custody: string | null; configuration: string | null }
function transition(phase: AssetPhase, action: string): AssetPhase | null {
 if (phase === 'unprovisioned' && ['acquire', 'provision'].includes(action)) return 'acquired';
 if (['acquired', 'inactive'].includes(phase) && action === 'commission') return 'commissioned';
 if (phase === 'commissioned' && action === 'operate') return 'operational';
 if (['commissioned', 'operational'].includes(phase) && action === 'deactivate') return 'inactive';
 if (phase === 'inactive' && action === 'refurbish') return 'acquired';
 if (['acquired', 'inactive', 'commissioned'].includes(phase) && action === 'retire') return 'retired';
 if (phase === 'retired' && action === 'decommission') return 'decommissioned';
 if (!['unprovisioned', 'retired', 'decommissioned'].includes(phase) && action === 'move') return phase;
 return null;
}
export class Assets {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private validate(state: AssetState, event: Wire, ctx: CallContext): Effect.Effect<AssetPhase, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const phase = transition(state.phase, String(event.action));
   if (!phase) return yield* Effect.fail(err('InvalidTransition', 'Asset lifecycle transition is not permitted'));
   if (state.head && !['move'].includes(String(event.action)) && (event.place !== state.place || event.custody !== state.custody)) return yield* Effect.fail(err('ValidationFailed', 'Location/custody changes require a move event'));
   if (state.head && !['commission', 'refurbish'].includes(String(event.action)) && event.configuration !== state.configuration) return yield* Effect.fail(err('ValidationFailed', 'Configuration changes require commissioning or refurbishment'));
   const configuration = yield* self.call('AssetConfiguration.get', { id: event.configuration }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: configuration.definition }, ctx);
   if (configuration.snapshot) yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get', { id: configuration.snapshot }, ctx);
   if (event.place) yield* self.engine.call('@forgegraph/foundation/place/_/Place.get', { id: event.place }, ctx);
   if (event.custody) {
    const relation = yield* self.engine.call(r + 'PartyResourceRelation.get', { id: event.custody }, ctx), kind = yield* self.engine.call(r + 'RelationKind.get', { id: relation.kind }, ctx);
    if (relation.subject !== state.row.resource || relation.kind !== state.row.custodyKind) return yield* Effect.fail(err('ValidationFailed', 'Custody relation belongs to another resource or role'));
    const knownAt = event.createdAt == null ? (yield* Clock).now() : String(event.createdAt);
    const relations = yield* new ResourceRelations(self.engine, { namespace: String(kind.namespace), kinds: [String(kind.name)] }).asOf(String(state.row.resource), { validAt: String(event.at), knownAt }, ctx);
    if (!relations.some(view => view.relation === relation.id)) return yield* Effect.fail(err('ValidationFailed', 'Custody is not established at the lifecycle occurrence'));
   }
   const seal = yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get', { id: event.evidence }, ctx);
   yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
   if (event.action === 'commission' && state.row.commissioningAttestationRequired && !event.attestation) return yield* Effect.fail(err('ValidationFailed', 'Commissioning requires an attestation'));
   if (event.attestation && !(yield* new Attestations(self.engine).current(String(event.attestation), String(event.at), ctx))) return yield* Effect.fail(err('ValidationFailed', 'Lifecycle attestation is not effective'));
   return phase;
  }).pipe(Effect.provide(self.engine.layer));
 }
 state(asset: string, ctx: CallContext): Effect.Effect<AssetState, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('AssetProfile.get', { id: asset }, ctx);
   yield* self.engine.call(r + 'ResourceSubject.get', { id: row.resource }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.specification }, ctx);
   yield* self.engine.call('@forgegraph/foundation/attestation/_/AttestationSubject.get', { id: row.attestationSubject }, ctx);
   const state: AssetState = { row, events: [], phase: 'unprovisioned', head: null, place: null, custody: null, configuration: null };
   const resource = self.engine.model.resource(p + 'AssetLifecycleEvent'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!, storage = yield* Storage;
   for (let ordinal = 1; ordinal <= 128; ordinal++) {
    const values = { asset, ordinal }, found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
    if (!found) break;
    const event = yield* self.call('AssetLifecycleEvent.get', { id: found.id }, ctx);
    if ((event.previous ?? null) !== state.head) return yield* Effect.fail(err('ValidationFailed', 'Asset history is not consecutive'));
    state.phase = yield* self.validate(state, event, ctx);
    state.events.push(event); state.head = String(event.id); state.place = event.place == null ? null : String(event.place); state.custody = event.custody == null ? null : String(event.custody); state.configuration = String(event.configuration);
   }
   return state;
  }).pipe(Effect.provide(self.engine.layer));
 }
 act(input: { asset: string; previous: string | null; action: AssetAction; at: string; place?: string; custody?: string; configuration: string; evidence: string; attestation?: string; reason: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const state = yield* self.state(input.asset, ctx);
   if (state.head !== input.previous) return yield* Effect.fail(err('VersionConflict', 'Asset history changed'));
   const at = yield* Effect.try({ try: () => decodeDatetime(input.at), catch: () => err('ValidationFailed', 'Invalid lifecycle instant') });
   const row = { ...input, at, place: input.place ?? null, custody: input.custody ?? null, attestation: input.attestation ?? null, ordinal: state.events.length + 1, recordedBy: ctx.actor };
   yield* self.validate(state, row, ctx);
   return yield* self.call('AssetLifecycleEvent.create', row, ctx);
  });
 }
}
