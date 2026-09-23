import { Effect } from "effect";
import { decodeDecimal, formatMinor, toMinor } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Storage, type StoredRecord } from "../services.js";
const prefix = "@forgegraph/foundation/ledger/_/";
export interface LedgerEntry { account: string; quantity: string }
export interface LedgerPost { book: string; key: string; entries: LedgerEntry[]; policy: "balanced" | "unrestricted"; reason: string; reversalOf?: string }
type ValidGroup = { fact: Wire; entries: LedgerEntry[] };
const invalid = (message: string) => Effect.fail(err("ValidationFailed", message));
/** A bounded book (512 groups, 128 entries/group), published one immutable seal
 * at a time. Every consumer revalidates raw seals; malformed publication fails closed. */
export class Ledger {
  constructor(private readonly engine: Engine) {}
  private call(op: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> { return this.engine.call(prefix + op, body, ctx); }
  private entries(group: Wire, ctx: CallContext): Effect.Effect<LedgerEntry[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const rows: LedgerEntry[] = [], seen = new Set<string>(), sums = new Map<string, bigint>();
      let id = String(group.head);
      while (id) {
        if (seen.has(id) || rows.length >= 128) return yield* invalid("Ledger entry chain must be acyclic and bounded");
        seen.add(id);
        const row = yield* self.call("Entry.get", { id }, ctx);
        const account = yield* self.call("Account.get", { id: row.account }, ctx);
        if (row.book !== group.book || account.book !== group.book) return yield* invalid("Cross-book posting");
        const amount = toMinor(String(row.quantity), 6), unit = String(account.unit);
        sums.set(unit, (sums.get(unit) ?? 0n) + amount);
        rows.push({ account: String(row.account), quantity: String(row.quantity) });
        id = row.next == null ? "" : String(row.next);
      }
      if (!rows.length || (group.policy === "balanced" && [...sums.values()].some(n => n !== 0n))) return yield* invalid("Posting group is not balanced per unit");
      return rows;
    });
  }
  private groups(book: string, ctx: CallContext): Effect.Effect<ValidGroup[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("LedgerBook.get", { id: book }, ctx);
      const storage = yield* Storage, resource = self.engine.model.resource(prefix + "PostingGroup");
      const list = resource.lists.find(l => l.fields.length === 1 && l.fields[0] === "book")!, keys = self.engine.sortKeys(resource, list);
      let after = null as { keys: string[]; values: unknown[]; id: string } | null;
      const result: ValidGroup[] = [];
      do {
        const page: { records: StoredRecord[]; hasMore: boolean } = yield* storage.list(ctx.tenant, resource, { list, values: { book }, after, limit: 100 }, keys);
        for (const row of page.records) {
          if (result.length >= 512) return yield* Effect.fail(err("BudgetExceeded", "Ledger book exceeds 512 groups"));
          const fact = yield* self.call("PostingGroup.get", { id: row.id }, ctx);
          result.push({ fact, entries: yield* self.entries(fact, ctx) });
        }
        const last = page.records.at(-1);
        after = page.hasMore && last ? { keys: keys(last), values: list.order.map(o => last[o.field] ?? null), id: String(last.id) } : null;
      } while (after);
      const reversed = new Set<string>();
      for (const g of result) {
        const original = g.fact.reversalOf == null ? null : result.find(x => x.fact.id === g.fact.reversalOf);
        const claim = original ? "reverse:" + original.fact.id : "post:" + g.fact.key;
        if (g.fact.claim !== claim || (g.fact.reversalOf != null && !original)) return yield* invalid("Invalid ledger publication claim");
        if (original) {
          if (original.fact.reversalOf != null || reversed.has(String(original.fact.id)) || g.fact.policy !== original.fact.policy) return yield* invalid("Repeated or nested reversal");
          reversed.add(String(original.fact.id));
          const amounts = new Map<string, bigint>();
          for (const row of [...original.entries, ...g.entries]) amounts.set(row.account, (amounts.get(row.account) ?? 0n) + toMinor(row.quantity, 6));
          if ([...amounts.values()].some(n => n !== 0n)) return yield* invalid("Reversal must exactly invert every account");
        }
      }
      return result;
    }).pipe(Effect.provide(self.engine.layer));
  }
  post(input: LedgerPost, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      if (!input.entries.length || input.entries.length > 128) return yield* invalid("Post requires 1..128 entries");
      const entries = yield* Effect.try({ try: () => input.entries.map(e => ({ account: e.account, quantity: decodeDecimal(e.quantity, { scale: 6 }) })), catch: () => err("ValidationFailed", "Invalid exact ledger quantity") });
      const groups = yield* self.groups(input.book, ctx);
      const existing = groups.find(g => g.fact.key === input.key);
      const same = (g: ValidGroup) => g.fact.policy === input.policy && g.fact.reason === input.reason && (g.fact.reversalOf ?? null) === (input.reversalOf ?? null) && JSON.stringify(g.entries) === JSON.stringify(entries);
      if (existing) return same(existing) ? existing.fact : yield* Effect.fail(err("IdempotencyMismatch", "Ledger key reused for different posting"));
      if (groups.length >= 512) return yield* Effect.fail(err("BudgetExceeded", "Ledger book exceeds 512 groups"));
      const mutationContext = { ...ctx };
      delete mutationContext.idempotencyKey;
      let head: string | null = null;
      for (const entry of [...entries].reverse()) {
        const row: Wire = yield* self.call("Entry.create", { ...entry, book: input.book, next: head }, mutationContext);
        head = String(row.id);
      }
      const fact: Wire = { book: input.book, key: input.key, head, policy: input.policy, reason: input.reason, reversalOf: input.reversalOf ?? null, claim: input.reversalOf ? "reverse:" + input.reversalOf : "post:" + input.key };
      yield* self.entries(fact, ctx);
      if (input.reversalOf) {
        const original = groups.find(g => g.fact.id === input.reversalOf);
        if (!original || original.fact.reversalOf != null || groups.some(g => g.fact.reversalOf === input.reversalOf) || original.fact.policy !== input.policy) return yield* invalid("Original group cannot be reversed");
        const totals = new Map<string, bigint>();
        for (const row of [...original.entries, ...entries]) totals.set(row.account, (totals.get(row.account) ?? 0n) + toMinor(row.quantity, 6));
        if ([...totals.values()].some(n => n !== 0n)) return yield* invalid("Reversal must exactly invert original");
      }
      return yield* self.call("PostingGroup.create", fact, mutationContext).pipe(Effect.catch(error => self.groups(input.book, ctx).pipe(Effect.flatMap(current => {
        const winner = current.find(g => g.fact.key === input.key);
        return winner ? (same(winner) ? Effect.succeed(winner.fact) : Effect.fail(err("IdempotencyMismatch", "Ledger key reused for different posting"))) : Effect.fail(error);
      }))));
    });
  }
  reverse(book: string, original: string, key: string, reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const group = (yield* self.groups(book, ctx)).find(g => g.fact.id === original);
      if (!group) return yield* invalid("Original posting not found");
      return yield* self.post({ book, key, reason, reversalOf: original, policy: group.fact.policy as LedgerPost["policy"], entries: group.entries.map(e => ({ account: e.account, quantity: formatMinor(-toMinor(e.quantity, 6), 6) })) }, ctx);
    });
  }
  rebuild(book: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const groups = yield* self.groups(book, ctx), amounts = new Map<string, bigint>();
      for (const group of groups) for (const row of group.entries) amounts.set(row.account, (amounts.get(row.account) ?? 0n) + toMinor(row.quantity, 6));
      return { groupIds: groups.map(g => String(g.fact.id)), balances: Object.fromEntries([...amounts].map(([account, value]) => [account, formatMinor(value, 6)])) };
    });
  }
  balance(account: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const fact = yield* self.call("Account.get", { id: account }, ctx);
      const projection = yield* self.rebuild(String(fact.book), ctx);
      return { account, unit: String(fact.unit), quantity: projection.balances[account] ?? "0.000000", groupIds: projection.groupIds };
    });
  }
}
