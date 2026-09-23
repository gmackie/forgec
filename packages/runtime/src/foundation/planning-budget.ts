import { Effect } from 'effect';
import type { Engine, CallContext, AtomicMutation } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Storage } from '../services.js';
import { toMinor, formatMinor } from '../codecs.js';
import { Allocations } from './allocation.js';
import { Ledger } from './ledger.js';
const p = '@forgegraph/foundation/planning-budget/_/', l = '@forgegraph/foundation/ledger/_/';
export type BudgetAction = 'Commit' | 'Release' | 'Spend' | 'Reverse';
type Claim = { row: Wire; phase: BudgetAction; actual: Wire | null };
export interface BudgetState { envelope: Wire; events: Wire[]; claims: Map<string, Claim>; committed: string; spent: string; available: string }
const invalid = (detail: string) => Effect.fail(err('ValidationFailed', detail));
export class Budgets {
  constructor(private readonly engine: Engine) {}
  private validateActual(actual: Wire, envelope: Wire, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const account = yield* self.engine.call(l + 'Account.get', { id: actual.account }, ctx);
      if (account.id !== envelope.account) return yield* invalid('Budget actual must debit the envelope account');
      const book = yield* new Ledger(self.engine).rebuild(String(account.book), ctx);
      if (!book.groupIds.includes(String(actual.posting))) return yield* invalid('Actual posting is not published');
      const group = yield* self.engine.call(l + 'PostingGroup.get', { id: actual.posting }, ctx);
      if (group.reversalOf != null) return yield* invalid('A reversal cannot be a new budget actual');
      let head: string | null = String(group.head), amount = 0n, count = 0;
      while (head) {
        if (++count > 128) return yield* invalid('Posting entry bound exceeded');
        const entry: Wire = yield* self.engine.call(l + 'Entry.get', { id: head }, ctx);
        if (entry.account === account.id) amount += toMinor(String(entry.quantity), 6);
        head = entry.next == null ? null : String(entry.next);
      }
      if (amount !== toMinor(String(actual.amount), 6)) return yield* invalid('Budget actual must equal the posting amount on its envelope account');
      if (actual.usage != null) yield* self.engine.call('@forgegraph/foundation/usage/_/UsageEvent.get', { id: actual.usage }, ctx);
      if (actual.fulfillment != null) yield* self.engine.call('@forgegraph/foundation/fulfillment/_/Fulfillment.get', { id: actual.fulfillment }, ctx);
    });
  }
  private apply(state: BudgetState, event: Wire, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.engine.call(p + 'Encumbrance.get', { id: event.encumbrance }, ctx);
      const old = state.claims.get(String(row.id));
      if (event.action === 'Commit') {
        if (old) return yield* invalid('Encumbrance was already published');
        state.claims.set(String(row.id), { row, phase: 'Commit', actual: null });
      } else if (event.action === 'Release') {
        if (!old || old.phase !== 'Commit') return yield* invalid('Only outstanding encumbrance can release');
        old.phase = 'Release';
      } else if (event.action === 'Spend') {
        if (!old || old.phase !== 'Commit') return yield* invalid('Actual requires outstanding encumbrance');
        const actual = yield* self.engine.call(p + 'BudgetActual.get', { id: event.actual }, ctx);
        if (toMinor(String(actual.amount), 6) > toMinor(String(row.amount), 6)) return yield* invalid('Actual exceeds encumbrance');
        yield* self.validateActual(actual, state.envelope, ctx);
        old.phase = 'Spend'; old.actual = actual;
      } else if (event.action === 'Reverse') {
        if (!old || old.phase !== 'Spend' || old.actual?.id !== event.actual) return yield* invalid('Reversal must match a spent actual');
        const group = yield* self.engine.call(l + 'PostingGroup.get', { id: event.reversal }, ctx);
        const rebuilt = yield* new Ledger(self.engine).rebuild(String(group.book), ctx);
        if (!rebuilt.groupIds.includes(String(group.id)) || group.reversalOf !== old.actual!.posting) return yield* invalid('Reversal is not the exact published inverse');
        old.phase = 'Reverse';
      } else return yield* invalid('Unknown budget action');
      let committed = 0n, spent = 0n;
      for (const claim of state.claims.values()) {
        if (claim.phase === 'Commit') committed += toMinor(String(claim.row.amount), 6);
        if (claim.phase === 'Spend') spent += toMinor(String(claim.actual!.amount), 6);
      }
      const available = toMinor(String(state.envelope.limit), 6) - committed - spent;
      if (available < 0n) return yield* invalid('Funding limit exceeded');
      state.committed = formatMinor(committed, 6); state.spent = formatMinor(spent, 6); state.available = formatMinor(available, 6);
    });
  }
  state(envelope: string, ctx: CallContext): Effect.Effect<BudgetState, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const fact = yield* self.engine.call(p + 'FundingEnvelope.get', { id: envelope }, ctx);
      yield* self.engine.call(l + 'Account.get', { id: fact.account }, ctx);
      const resource = self.engine.model.resource(p + 'BudgetEvent'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!, storage = yield* Storage;
      const state: BudgetState = { envelope: fact, events: [], claims: new Map(), committed: '0.000000', spent: '0.000000', available: String(fact.limit) };
      for (let ordinal = 1; ordinal <= 128; ordinal++) {
        const values = { envelope, ordinal };
        const found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
        if (!found) break;
        const event = yield* self.engine.call(resource.id + '.get', { id: found.id }, ctx);
        yield* self.apply(state, event, ctx); state.events.push(event);
      }
      return state;
    }).pipe(Effect.provide(self.engine.layer));
  }
  publish(input: { encumbrance: string; action: BudgetAction; previous: string | null; actual?: string; reversal?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.engine.call(p + 'Encumbrance.get', { id: input.encumbrance }, ctx);
      const state = yield* self.state(String(row.envelope), ctx);
      if ((state.events.at(-1)?.id ?? null) !== input.previous) return yield* Effect.fail(err('VersionConflict', 'Funding journal changed'));
      const event = { ...input, envelope: row.envelope, ordinal: state.events.length + 1, actual: input.actual ?? null, reversal: input.reversal ?? null };
      yield* self.apply(state, event, ctx);
      const mutations: AtomicMutation[] = [];
      if (row.reservation != null && input.action !== 'Reverse') {
        const prepared = yield* new Allocations(self.engine).prepare([{ reservation: String(row.reservation), action: input.action === 'Commit' ? 'book' : 'release', commandKey: `budget:${input.encumbrance}:${input.action}` }], ctx);
        if (prepared.existing.length) return yield* invalid('Budget allocation was claimed outside this publication');
        mutations.push(...prepared.mutations);
      }
      mutations.push({ operation: p + 'BudgetEvent.create', input: event });
      const results = yield* self.engine.atomic(mutations, ctx);
      return results[results.length - 1]!;
    });
  }
}
