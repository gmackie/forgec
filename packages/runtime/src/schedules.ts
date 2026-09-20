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

export class Schedules {
  private readonly recurrences = new Map<string, Recurrence>();
  policy: SchedulePolicy = DEFAULT_POLICY;
  constructor(private readonly engine: Engine) {}

  recurrence(s: SourceDecl): Recurrence {
    let r = this.recurrences.get(s.id);
    if (!r) { r = parseRecurrence(s.cron!, s.timezone ?? "UTC"); this.recurrences.set(s.id, r); }
    return r;
  }

  /** A provider tick at `now`: run every intended occurrence that is due and not yet recorded. */
  tick(tenant: string, now: string): Effect.Effect<TickResult[], never, never> {
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
        const from = ledger.lastOccurrence ?? new Date(Date.parse(nowIso) - 60_000).toISOString();
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
    }).pipe(Effect.catch(() => Effect.succeed([] as TickResult[])), Effect.provide(this.engine.layer));
  }

  status(tenant: string): Effect.Effect<{ source: string; lastOccurrence: string | null; next: string | null; skipped: string[] }[], never, never> {
    const self = this;
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
