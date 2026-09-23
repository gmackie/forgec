import { Effect } from "effect";
import { decodeDatetime, formatMinor, toMinor } from "../codecs.js";
import type { Engine, CallContext, AtomicMutation } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Clock, Storage, type StoredRecord } from "../services.js";
const prefix = "@forgegraph/foundation/allocation/_/";
export type AllocationAction = "reserve" | "allocate" | "release" | "cancel" | "expire" | "book" | "replace";
type Action = AllocationAction;
export interface AllocationCommand { reservation: string; action: AllocationAction; commandKey: string; replacement?: string }
type Phase = "reserved" | "allocated" | "released" | "cancelled" | "expired";
interface Claim { row: Wire; phase: Phase }
interface State { pool: Wire; head: Wire | null; claims: Map<string, Claim>; entries: Map<string, Wire> }
const bad = (detail: string) => err("ValidationFailed", detail);
function active(claim: Claim, at: string) { return claim.phase === "allocated" || claim.phase === "reserved" && String(claim.row.holdUntil) > at; }
function capacity(state: State, at: string) {
  const points: { at: string; delta: bigint }[] = [];
  for (const claim of state.claims.values()) if (active(claim, at)) {
    points.push({ at: String(claim.row.from), delta: toMinor(String(claim.row.quantity), 6) }, { at: String(claim.row.until), delta: -toMinor(String(claim.row.quantity), 6) });
  }
  points.sort((a,b) => a.at.localeCompare(b.at) || (a.delta < b.delta ? -1 : a.delta > b.delta ? 1 : 0));
  let total = 0n;
  for (const p of points) { total += p.delta; if (total > toMinor(String(state.pool.capacity), 6)) throw bad("Pool capacity exceeded"); }
}
function apply(state: State, entry: Wire, reservation: Wire, replacement?: Wire) {
  if (entry.pool !== state.pool.id || reservation.pool !== state.pool.id || entry.reservation !== reservation.id || reservation.unit !== state.pool.unit) throw bad("Allocation identity/unit mismatch");
  if (entry.previous !== (state.head?.id ?? null) || entry.ordinal !== Number(state.head?.ordinal ?? 0) + 1 || state.head && String(entry.at) < String(state.head.at)) throw bad("Invalid allocation journal chain");
  if (toMinor(String(reservation.quantity), 6) <= 0n || toMinor(String(reservation.quantity), 6) > toMinor(String(state.pool.capacity), 6)) throw bad("Invalid reservation quantity");
  const old = state.claims.get(String(reservation.id)), at = String(entry.at);
  if (entry.action === "book") {
    if (old || String(reservation.until) <= at) throw bad("Booking already claimed or ended");
    state.claims.set(String(reservation.id), { row: reservation, phase: "allocated" });
  } else if (entry.action === "replace") {
    if (!old || old.phase !== "allocated" || !replacement || entry.replacement !== replacement.id || replacement.pool !== state.pool.id || replacement.unit !== state.pool.unit || state.claims.has(String(replacement.id)) || String(replacement.until) <= at || toMinor(String(replacement.quantity), 6) <= 0n) throw bad("Invalid allocation replacement");
    old.phase = "released";
    state.claims.set(String(replacement.id), { row: replacement, phase: "allocated" });
  } else if (entry.action === "reserve") {
    if (old || String(reservation.holdUntil) <= at || String(reservation.until) <= at) throw bad("Reservation already claimed or expired");
    state.claims.set(String(reservation.id), { row: reservation, phase: "reserved" });
  } else {
    if (!old) throw bad("Reservation has no accepted claim");
    if (entry.action === "allocate") {
      if (old.phase !== "reserved" || String(reservation.holdUntil) <= at || String(reservation.until) <= at) throw bad("Reservation cannot allocate");
      old.phase = "allocated";
    } else if (entry.action === "release") {
      if (old.phase !== "allocated") throw bad("Only allocation can release"); old.phase = "released";
    } else if (entry.action === "cancel") {
      if (old.phase !== "reserved") throw bad("Only reservation can cancel"); old.phase = "cancelled";
    } else if (entry.action === "expire") {
      if (old.phase !== "reserved" || String(reservation.holdUntil) > at) throw bad("Reservation is not expired"); old.phase = "expired";
    } else throw bad("Unknown allocation action");
  }
  capacity(state, at); state.head = entry; state.entries.set(String(entry.commandKey), entry);
}
/** All authority is obtained through this validated projection, not raw candidate
 * resources. Unique(pool,ordinal) atomically commits the guard and transition. */
export class Allocations {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(prefix + op, input, ctx); }
  private read(pool: string, ctx: CallContext): Effect.Effect<State, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const owner = yield* self.call("AllocationPool.get", { id: pool }, ctx);
      const state: State = { pool: owner, head: null, claims: new Map(), entries: new Map() };
      const resource = self.engine.model.resource(prefix + "AllocationJournal"), list = resource.lists.find(l => l.fields.length === 1 && l.fields[0] === "pool")!, keys = self.engine.sortKeys(resource, list), storage = yield* Storage;
      let after: { keys: string[]; values: unknown[]; id: string } | null = null;
      let count = 0;
      do {
        const page: { records: StoredRecord[]; hasMore: boolean } = yield* storage.list(ctx.tenant, resource, { list, values: { pool }, after, limit: 100 }, keys);
        for (const row of page.records) {
          if (++count > 512) return yield* Effect.fail(bad("Allocation journal exceeds 512 entries"));
          const entry = yield* self.call("AllocationJournal.get", { id: row.id }, ctx);
          const reservation = yield* self.call("AllocationReservation.get", { id: entry.reservation }, ctx);
          const replacement = entry.replacement == null ? undefined : yield* self.call("AllocationReservation.get", { id: entry.replacement }, ctx);
          yield* Effect.try({ try: () => apply(state, entry, reservation, replacement), catch: e => e as ForgeError });
        }
        const last = page.records.at(-1);
        after = page.hasMore && last ? { keys: keys(last), values: list.order.map(o => last[o.field] ?? null), id: String(last.id) } : null;
      } while (after);
      return state;
    }).pipe(Effect.provide(self.engine.layer));
  }
  /** Prepare one guarded state transition per distinct pool against durable candidates.
   * Commit all returned descriptors plus the owning application's publication via
   * Engine.atomic. A UniqueConflict means reread/reprepare the entire group. */
  prepare(commands: readonly AllocationCommand[], ctx: CallContext): Effect.Effect<{ mutations: AtomicMutation[]; existing: Wire[] }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      if (!commands.length || commands.length > 16) return yield* Effect.fail(bad("Allocation batch requires 1..16 distinct pools"));
      const pools = new Set<string>(), mutations: AtomicMutation[] = [], existing: Wire[] = [];
      for (const command of commands) {
        const row = yield* self.call("AllocationReservation.get", { id: command.reservation }, ctx);
        const pool = String(row.pool);
        if (pools.has(pool)) return yield* Effect.fail(bad("Only one allocation transition per pool is supported"));
        pools.add(pool);
        const state = yield* self.read(pool, ctx), prior = state.entries.get(command.commandKey);
        if (prior) {
          if (prior.reservation !== command.reservation || prior.action !== command.action || (prior.replacement ?? null) !== (command.replacement ?? null)) return yield* Effect.fail(err("IdempotencyMismatch", "Allocation batch key reused"));
          existing.push(prior); continue;
        }
        const now = (yield* Clock).now();
        if (Number(state.head?.ordinal ?? 0) >= 512 || state.head && String(state.head.at) > now) return yield* Effect.fail(bad("Allocation journal full or future authority"));
        const entry = { pool, reservation: command.reservation, replacement: command.replacement ?? null, action: command.action, commandKey: command.commandKey, ordinal: Number(state.head?.ordinal ?? 0) + 1, previous: state.head?.id ?? null, at: now };
        const replacement = command.replacement ? yield* self.call("AllocationReservation.get", { id: command.replacement }, ctx) : undefined;
        yield* Effect.try({ try: () => apply(state, entry, row, replacement), catch: e => e as ForgeError });
        mutations.push({ operation: prefix + "AllocationJournal.create", input: entry });
      }
      if (existing.length && mutations.length) return yield* Effect.fail(bad("Allocation batch has partial prior publication"));
      return { mutations, existing };
    }).pipe(Effect.provide(self.engine.layer));
  }
  /** Validated current lifecycle of a durable candidate, with the journal guard. */
  reservation(reservation: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.call("AllocationReservation.get", { id: reservation }, ctx);
      const state = yield* self.read(String(row.pool), ctx), claim = state.claims.get(reservation);
      const now = (yield* Clock).now();
      if (state.head && String(state.head.at) > now) return yield* Effect.fail(bad("Journal contains future authority"));
      return { row, phase: claim?.phase ?? null, head: state.head?.id ?? null, history: [...state.entries.values()].filter(entry => entry.reservation === reservation || entry.replacement === reservation) };
    }).pipe(Effect.provide(self.engine.layer));
  }
  act(reservation: string, action: Action, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.call("AllocationReservation.get", { id: reservation }, ctx);
      for (let retry = 0; retry < 32; retry++) {
        const state = yield* self.read(String(row.pool), ctx);
        const commandKey = ctx.idempotencyKey ?? JSON.stringify([reservation, action]);
        const existing = state.entries.get(commandKey);
        if (existing) {
          if (existing.reservation !== reservation || existing.action !== action) return yield* Effect.fail(err("IdempotencyMismatch", "Allocation command key reused"));
          return existing;
        }
        const now = (yield* Clock).now();
        if (state.head && String(state.head.at) > now) return yield* Effect.fail(bad("Journal contains future authority"));
        if (Number(state.head?.ordinal ?? 0) >= 512) return yield* Effect.fail(bad("Allocation journal is full"));
        const entry = { pool: row.pool, reservation, replacement: null, action, commandKey, ordinal: Number(state.head?.ordinal ?? 0) + 1, previous: state.head?.id ?? null, at: now };
        yield* Effect.try({ try: () => apply(state, entry, row), catch: e => e as ForgeError });
        const { idempotencyKey: _receipt, ...commitCtx } = ctx;
        const result = yield* self.call("AllocationJournal.create", entry, commitCtx).pipe(Effect.map(value => ({ value })), Effect.catch(e => e.code === "UniqueConflict" ? Effect.succeed({ value: null }) : Effect.fail(e)));
        if (result.value) {
          // Revalidate after insertion: a raw earlier malformed candidate can
          // never turn a successful create into consumption authority.
          yield* self.read(String(row.pool), ctx);
          return result.value;
        }
      }
      return yield* Effect.fail(err("TransientConflict", "Allocation contention"));
    }).pipe(Effect.provide(self.engine.layer));
  }
  inspect(pool: string, at: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* Effect.try({ try: () => decodeDatetime(at), catch: () => bad("Invalid allocation instant") });
      const state = yield* self.read(pool, ctx);
      const now = (yield* Clock).now();
      if (state.head && String(state.head.at) > now) return yield* Effect.fail(bad("Journal contains future authority"));
      // Current claims, projected onto requested slot. Historical business state
      // is not inferred after release; consumers pin journal head as evidence.
      let used = 0n;
      const claims: { reservation: string; phase: Phase }[] = [];
      for (const [id, claim] of state.claims) if (active(claim, now) && String(claim.row.from) <= instant && instant < String(claim.row.until)) {
        used += toMinor(String(claim.row.quantity), 6); claims.push({ reservation: id, phase: claim.phase });
      }
      if (used > toMinor(String(state.pool.capacity), 6)) return yield* Effect.fail(bad("Pool oversubscribed"));
      return { pool, unit: String(state.pool.unit), available: formatMinor(toMinor(String(state.pool.capacity), 6) - used, 6), head: state.head?.id ?? null, claims };
    }).pipe(Effect.provide(self.engine.layer));
  }
}
