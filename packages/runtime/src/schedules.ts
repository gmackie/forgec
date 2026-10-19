/**
 * Schedules (plan §19). A `source` with `cron` compiles to a canonical
 * recurrence IR; providers never receive the raw string. Both hosts deliver
 * ticks (Cloudflare Cron Trigger, EventBridge rule) and this module decides
 * which *intended* occurrences are due, so occurrence identity is
 * (schedule, intended instant), never the observed delivery time.
 *
 * Semantics fixed here (the two providers disagree on several):
 * - weekday numbering: 0 and 7 are Sunday;
 * - day-of-month and day-of-week both restricted: OR (Vixie cron);
 * - local-time schedules: a nonexistent local time (DST gap) is skipped, a
 *   repeated local time (DST overlap) fires once, at its first instant;
 * - missed occurrences are caught up oldest-first, bounded by a window;
 * - overlap policy `skip`: an occurrence due while its predecessor is still
 *   running is recorded as skipped, never queued.
 *
 * Which tenants a host tick reaches (FORG-3): a durable schedule index (a
 * document in the system tenant) maps every tenant that has been seen to its
 * next due instant. Hosts record tenants with `track` (off the request path)
 * and call `sweep` on every trigger; a sweep reads the index once and ticks
 * only the tenants that are due, so idle tenants fire without any outbox rows
 * and without scanning every tenant on every tick. A package with no `@tenant`
 * resource is tenant-less: its schedules are global and run once per
 * occurrence on the system tenant's ledger, whoever triggers them.
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import type { CallContext, Engine } from "./engine.js";
import { err, ForgeError } from "./errors.js";
import type { SourceDecl } from "./model.js";
import { Clock, Storage, type RuntimeServices } from "./services.js";

export type FieldSet = number[] | "any";
export interface Recurrence {
  kind: "cron";
  minutes: number[];
  hours: number[];
  daysOfMonth: FieldSet;
  months: FieldSet;
  daysOfWeek: FieldSet;
  /** How restricted day-of-month and day-of-week combine (both restricted). */
  dayCombination: "or";
  timezone: string;
}

function parseField(text: string, min: number, max: number, name: string): FieldSet {
  if (text === "*") return "any";
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid ${name} field \`${part}\``);
    const step = m[3] ? Number(m[3]) : 1;
    let lo = m[1] === "*" ? min : Number(m[1]);
    let hi = m[1] === "*" ? max : m[2] ? Number(m[2]) : m[3] ? max : lo;
    if (name === "day-of-week") {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max || step < 1) throw new Error(`${name} value out of range in \`${part}\``);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseRecurrence(cron: string, timezone = "UTC"): Recurrence {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression must have five fields, got ${fields.length}`);
  const minutes = parseField(fields[0]!, 0, 59, "minute");
  const hours = parseField(fields[1]!, 0, 23, "hour");
  // Ensure the zone is known up front so a bad timezone is a build error, not a silent UTC.
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  return {
    kind: "cron",
    minutes: minutes === "any" ? range(0, 59) : minutes,
    hours: hours === "any" ? range(0, 23) : hours,
    daysOfMonth: parseField(fields[2]!, 1, 31, "day-of-month"),
    months: parseField(fields[3]!, 1, 12, "month"),
    daysOfWeek: parseField(fields[4]!, 0, 7, "day-of-week"),
    dayCombination: "or",
    timezone,
  };
}
function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

// ------------------------------------------------------------ local time
interface Local { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  return f;
}
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function toLocal(ms: number, tz: string): Local {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: Number(parts["year"]), month: Number(parts["month"]), day: Number(parts["day"]), hour: Number(parts["hour"]) % 24, minute: Number(parts["minute"]), weekday: WEEKDAYS[parts["weekday"]!] ?? 0 };
}
/** UTC offset (ms) in effect at an instant. */
function offsetAt(ms: number, tz: string): number {
  const l = toLocal(ms, tz);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, 0, 0);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}
/**
 * Instant of a local wall-clock time, or null when it does not exist (DST gap).
 * For a repeated wall time (DST overlap) the earlier instant is returned.
 */
function fromLocal(year: number, month: number, day: number, hour: number, minute: number, tz: string): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const candidates = new Set<number>();
  for (const probe of [guess - 86_400_000, guess, guess + 86_400_000]) {
    const off = offsetAt(probe, tz);
    candidates.add(guess - off);
  }
  const hits = [...candidates].filter((c) => {
    const l = toLocal(c, tz);
    return l.year === year && l.month === month && l.day === day && l.hour === hour && l.minute === minute;
  });
  if (!hits.length) return null;
  return Math.min(...hits);
}
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
function dayMatches(r: Recurrence, year: number, month: number, day: number): boolean {
  if (r.months !== "any" && !r.months.includes(month)) return false;
  const domOk = r.daysOfMonth === "any" || r.daysOfMonth.includes(day);
  const dowOk = r.daysOfWeek === "any" || r.daysOfWeek.includes(weekdayOf(year, month, day));
  if (r.daysOfMonth !== "any" && r.daysOfWeek !== "any") return domOk || dowOk;
  return domOk && dowOk;
}

/** First occurrence strictly after `after` (ISO), as canonical UTC. */
export function nextOccurrence(r: Recurrence, after: string): string | null {
  const afterMs = Date.parse(after);
  const start = toLocal(afterMs, r.timezone);
  let { year, month, day } = start;
  for (let d = 0; d < 366 * 4; d++) {
    if (dayMatches(r, year, month, day)) {
      for (const hour of r.hours) {
        for (const minute of r.minutes) {
          const ms = fromLocal(year, month, day, hour, minute, r.timezone);
          if (ms !== null && ms > afterMs) return new Date(ms).toISOString();
        }
      }
    }
    day++;
    if (day > daysInMonth(year, month)) { day = 1; month++; }
    if (month > 12) { month = 1; year++; }
  }
  return null;
}

/** Occurrences in (from, to], oldest first, bounded. */
export function occurrencesBetween(r: Recurrence, from: string, to: string, limit = 1000): string[] {
  const out: string[] = [];
  let cursor = from;
  while (out.length < limit) {
    const n = nextOccurrence(r, cursor);
    if (!n || n > to) break;
    out.push(n);
    cursor = n;
  }
  return out;
}

// ------------------------------------------------------------- ledger
const KIND = "schedule";
export interface SchedulePolicy {
  /** How far back a tick catches up missed occurrences (ms). Older ones are recorded as skipped. */
  catchUpWindowMs: number;
  overlap: "skip" | "allow";
}
export const DEFAULT_POLICY: SchedulePolicy = { catchUpWindowMs: 3 * 24 * 3600 * 1000, overlap: "skip" };

interface Ledger { lastOccurrence: string | null; running: string | null; skipped: string[]; _version?: number }
export interface TickResult { source: string; occurrence: string; outcome: "ran" | "duplicate" | "skipped-overlap" | "failed"; error?: string }
export interface SweepResult extends TickResult { tenant: string }

/** System tenant holding the schedule index and, for tenant-less packages, the global ledgers. */
export const SCHEDULE_SYSTEM_TENANT = "_forge";
const INDEX_ID = "index";
/** tenant -> next due instant (ISO). Every tenant ever tracked has an entry. */
interface ScheduleIndex { due: Record<string, string>; _version?: number }

export class Schedules {
  private readonly recurrences = new Map<string, Recurrence>();
  policy: SchedulePolicy = DEFAULT_POLICY;
  constructor(private readonly engine: Engine) {}

  /** True when the package declares at least one cron schedule. */
  get active(): boolean {
    return this.engine.model.sources.some((s) => !!s.cron);
  }

  /** A package with no `@tenant` resource has global schedules: one ledger, on the system tenant. */
  get global(): boolean {
    return !this.engine.model.resources.some((r) => r.decorators.tenant);
  }

  /** The tenant whose ledger a tick or status for `tenant` reads. */
  private scope(tenant: string): string {
    return this.global ? SCHEDULE_SYSTEM_TENANT : tenant;
  }

  /** Earliest occurrence strictly after `after` across every cron schedule. */
  private nextDue(after: string): string | null {
    let best: string | null = null;
    for (const s of this.engine.model.sources) {
      if (!s.cron) continue;
      const n = nextOccurrence(this.recurrence(s), after);
      if (n && (best === null || n < best)) best = n;
    }
    return best;
  }

  /**
   * Record that `tenant` exists so the next sweep reaches it even when it is idle. Idempotent: one
   * point read when already tracked. Hosts call it off the request path and memoise per process.
   */
  track(tenant: string): Effect.Effect<void, never, never> {
    const self = this;
    if (!this.active || tenant === SCHEDULE_SYSTEM_TENANT || this.global) return Effect.void;
    return Effect.gen(function* () {
      const now = (yield* Clock).now();
      yield* self.updateIndex((due) => {
        if (due[tenant]) return null;
        const next = self.nextDue(now);
        return next ? { ...due, [tenant]: next } : null;
      });
    }).pipe(Effect.catch(() => Effect.void), Effect.provide(this.engine.layer));
  }

  /**
   * A host trigger at `now`: tick every tracked tenant whose next occurrence is due, then record each
   * one's next due instant. `seen` are tenants the host already knows about (outbox, workflows); they
   * are tracked first, so nothing that fired before the index existed stops firing.
   */
  sweep(now: string, seen: readonly string[] = []): Effect.Effect<SweepResult[], never, never> {
    const self = this;
    if (!this.active) return Effect.succeed([]);
    return Effect.gen(function* () {
      const nowIso = new Date(Date.parse(now)).toISOString();
      const storage = yield* Storage;
      const index = ((yield* storage.getDocument(SCHEDULE_SYSTEM_TENANT, KIND, INDEX_ID)) ?? { due: {} }) as unknown as ScheduleIndex;
      const due = { ...index.due };
      // Untracked tenants start one minute back, like a ledger with no history.
      const firstSeen = new Date(Date.parse(nowIso) - 60_000).toISOString();
      const fresh = (self.global ? [SCHEDULE_SYSTEM_TENANT] : seen).filter((t) => !due[t]);
      for (const t of fresh) {
        const n = self.nextDue(firstSeen);
        if (n) due[t] = n;
      }
      const ready = Object.entries(due).filter(([, at]) => at <= nowIso);
      const results: SweepResult[] = [];
      const updates: Record<string, string> = {};
      for (const t of fresh) if (due[t] && !ready.some(([r]) => r === t)) updates[t] = due[t]!;
      for (const [tenant, at] of ready) {
        // A tenant with no ledger yet catches up from its first due instant, not from "a minute ago".
        const ticked = yield* self.tickScoped(tenant, nowIso, new Date(Date.parse(at) - 1).toISOString());
        results.push(...ticked.map((r) => ({ tenant, ...r })));
        // A failed occurrence is not recorded as done; keep the tenant due so the next sweep retries it.
        const next = ticked.some((r) => r.outcome === "failed") ? at : self.nextDue(nowIso);
        if (next) updates[tenant] = next;
      }
      if (Object.keys(updates).length) yield* self.updateIndex((cur) => ({ ...cur, ...updates }));
      return results;
    }).pipe(Effect.catch(() => Effect.succeed([] as SweepResult[])), Effect.provide(this.engine.layer));
  }

  /** CAS-update the index; concurrent sweeps and tracks merge (each writes only its own tenants). */
  private updateIndex(f: (due: Record<string, string>) => Record<string, string> | null): Effect.Effect<void, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const storage = yield* Storage;
      for (let attempt = 0; attempt < 5; attempt++) {
        const cur = ((yield* storage.getDocument(SCHEDULE_SYSTEM_TENANT, KIND, INDEX_ID)) ?? { due: {} }) as unknown as ScheduleIndex;
        const next = f(cur.due ?? {});
        if (!next) return;
        const r = yield* Effect.exit(storage.putDocument(SCHEDULE_SYSTEM_TENANT, KIND, INDEX_ID, { due: next } as Wire, cur._version ?? null));
        if (r._tag === "Success") return;
      }
      return yield* Effect.fail(err("TransientConflict", "schedule index contention"));
    });
  }

  recurrence(s: SourceDecl): Recurrence {
    let r = this.recurrences.get(s.id);
    if (!r) { r = parseRecurrence(s.cron!, s.timezone ?? "UTC"); this.recurrences.set(s.id, r); }
    return r;
  }

  /** A provider tick at `now`: run every intended occurrence that is due and not yet recorded. */
  tick(tenant: string, now: string): Effect.Effect<TickResult[], never, never> {
    return this.tickScoped(this.scope(tenant), now).pipe(Effect.provide(this.engine.layer));
  }

  /** `notBefore`: lower bound (exclusive) for a schedule with no ledger yet; default one minute before `now`. */
  private tickScoped(tenant: string, now: string, notBefore?: string): Effect.Effect<TickResult[], never, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const results: TickResult[] = [];
      const nowIso = new Date(Date.parse(now)).toISOString();
      for (const s of self.engine.model.sources) {
        if (!s.cron) continue;
        const r = self.recurrence(s);
        const storage = yield* Storage;
        const docId = `${s.name}:ledger`;
        const ledger = ((yield* storage.getDocument(tenant, KIND, docId)) ?? { lastOccurrence: null, running: null, skipped: [] }) as unknown as Ledger;
        // Due = occurrences after the last recorded one up to now; older than the window are skipped, not run.
        const windowStart = new Date(Date.parse(nowIso) - self.policy.catchUpWindowMs).toISOString();
        const from = ledger.lastOccurrence ?? notBefore ?? new Date(Date.parse(nowIso) - 60_000).toISOString();
        const due = occurrencesBetween(r, from, nowIso, 10_000);
        const tooOld = due.filter((o) => o <= windowStart);
        const toRun = due.filter((o) => o > windowStart);
        if (!due.length) {
          // Duplicate delivery of an already-recorded occurrence.
          const last = ledger.lastOccurrence;
          if (last && Date.parse(nowIso) - Date.parse(last) < 3600_000) results.push({ source: s.id, occurrence: last, outcome: "duplicate" });
          continue;
        }
        let state: Ledger = { ...ledger, skipped: [...ledger.skipped, ...tooOld] };
        for (const occurrence of toRun) {
          if (state.running && self.policy.overlap === "skip") {
            state = { ...state, lastOccurrence: occurrence, skipped: [...state.skipped, occurrence] };
            state = yield* self.save(tenant, docId, state);
            results.push({ source: s.id, occurrence, outcome: "skipped-overlap" });
            continue;
          }
          // Claim the occurrence (CAS) before running: a concurrent tick for the same instant loses the claim.
          const claimed = yield* self.save(tenant, docId, { ...state, running: occurrence }).pipe(Effect.exit);
          if (claimed._tag === "Failure") { results.push({ source: s.id, occurrence, outcome: "duplicate" }); break; }
          state = claimed.value;
          const ctx: CallContext = { tenant, actor: "scheduler", requestId: `${s.name}:${occurrence}`, idempotencyKey: `schedule:${s.name}:${occurrence}` };
          const exit = yield* Effect.exit(self.engine.callInternal(s.target, { occurrence, source: s.id }, ctx));
          if (exit._tag === "Failure") {
            const e = exit.cause;
            const fe = (e as { error?: unknown }).error;
            const code = fe instanceof ForgeError ? fe.code : "Internal";
            // A failed occurrence is not recorded as done: the next tick (or provider retry) runs it again.
            state = yield* self.complete(tenant, docId, null);
            results.push({ source: s.id, occurrence, outcome: "failed", error: code });
            break;
          }
          state = yield* self.complete(tenant, docId, occurrence);
          results.push({ source: s.id, occurrence, outcome: "ran" });
        }
      }
      return results;
    }).pipe(Effect.catch(() => Effect.succeed([] as TickResult[])));
  }

  status(caller: string): Effect.Effect<{ source: string; lastOccurrence: string | null; next: string | null; skipped: string[] }[], never, never> {
    const self = this;
    const tenant = this.scope(caller);
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const now = (yield* Clock).now();
      const out = [];
      for (const s of self.engine.model.sources) {
        if (!s.cron) continue;
        const ledger = ((yield* storage.getDocument(tenant, KIND, `${s.name}:ledger`)) ?? { lastOccurrence: null, skipped: [] }) as unknown as Ledger;
        out.push({ source: s.id, lastOccurrence: ledger.lastOccurrence, next: nextOccurrence(self.recurrence(s), ledger.lastOccurrence ?? now), skipped: ledger.skipped });
      }
      return out;
    }).pipe(Effect.catch(() => Effect.succeed([])), Effect.provide(this.engine.layer));
  }

  /** Release the running claim; other ticks may have recorded skips meanwhile, so reload and merge. */
  private complete(tenant: string, docId: string, ran: string | null): Effect.Effect<Ledger, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      for (let attempt = 0; attempt < 5; attempt++) {
        const cur = ((yield* storage.getDocument(tenant, KIND, docId)) ?? { lastOccurrence: null, running: null, skipped: [] }) as unknown as Ledger;
        const last = [cur.lastOccurrence, ran].filter((x): x is string => x !== null).sort().at(-1) ?? null;
        const r = yield* Effect.exit(self.save(tenant, docId, { ...cur, running: null, lastOccurrence: last }));
        if (r._tag === "Success") return r.value;
      }
      return yield* Effect.fail(err("TransientConflict", "schedule ledger contention"));
    });
  }

  private save(tenant: string, docId: string, state: Ledger): Effect.Effect<Ledger, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const { _version, ...doc } = state;
      yield* (yield* Storage).putDocument(tenant, KIND, docId, doc as Wire, _version ?? null).pipe(Effect.mapError((e) => (e.code === "VersionConflict" ? err("TransientConflict", "another tick claimed this occurrence") : e)));
      return { ...doc, _version: (_version ?? 0) + 1 } as unknown as Ledger;
    });
  }
}
