import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import { sha256, stableJson } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
import { decodeDatetime } from "../codecs.js";

const prefix = "@forgegraph/foundation/availability/_/";
const MINUTE = 60_000;
export const AVAILABILITY_LIMITS = Object.freeze({ rules: 128, queryMinutes: 31 * 24 * 60 });
export interface LocalWindow { startMinute: number; endMinute: number }
/** Sunday = 0. endMinute < startMinute carries into the next local day. */
export interface WeeklyWindow extends LocalWindow { weekday: number }
/** Replaces all weekly availability on this civil date; [] closes the whole date. */
export interface DateException { date: string; windows: readonly LocalWindow[] }
/** Absolute half-open interval. Highest priority wins; tied overlapping priorities are rejected. */
export interface AvailabilityOverride { from: string; until: string; available: boolean; priority: number }
export interface CalendarRevisionInput {
  calendar: string;
  timezone: string;
  weekly: readonly WeeklyWindow[];
  exceptions?: readonly DateException[];
  overrides?: readonly AvailabilityOverride[];
  origin?: string;
}
export interface AvailabilityWindow { from: string; until: string }
export interface EffectiveAvailability {
  revision: string;
  timezone: string;
  timezoneDataVersion: string;
  windows: AvailabilityWindow[];
}
interface Rule {
  kind: "Weekly" | "Date" | "Override";
  weekday: number | null;
  localDate: string | null;
  startMinute: number | null;
  endMinute: number | null;
  available: boolean;
  from: string | null;
  until: string | null;
  priority: number | null;
}
const blank = { weekday: null, localDate: null, startMinute: null, endMinute: null, from: null, until: null, priority: null };
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function integer(value: unknown, min: number, max: number): value is number { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max; }
function instant(value: string): number {
  const ms = Date.parse(decodeDatetime(value));
  check(ms % MINUTE === 0, "Availability timestamps must align to whole minutes");
  return ms;
}
function date(value: string): void {
  check(/^\d{4}-\d{2}-\d{2}$/.test(value), "Expected a local ISO date");
  const ms = Date.parse(value + "T00:00:00.000Z");
  check(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value, "Invalid local date");
}
function formatter(timezone: string): Intl.DateTimeFormat {
  check(typeof timezone === "string" && timezone.length <= 128 && !/^[+-]/.test(timezone), "Expected an IANA timezone");
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function localWindow(w: LocalWindow, overnight: boolean): void {
  check(integer(w.startMinute, 0, 1439) && integer(w.endMinute, 0, 1440) && w.startMinute !== w.endMinute, "Invalid minute window");
  check(overnight || w.endMinute > w.startMinute, "Date exceptions cannot cross midnight; use a window on each date");
}
function rulesFor(input: CalendarRevisionInput): Rule[] {
  formatter(input.timezone);
  check(typeof input.calendar === "string" && input.calendar.length > 0, "Calendar is required");
  check(Array.isArray(input.weekly) && Array.isArray(input.exceptions ?? []) && Array.isArray(input.overrides ?? []), "Expected weekly windows, date exceptions and overrides");
  check(Object.keys(input).every(k => ["calendar", "timezone", "weekly", "exceptions", "overrides", "origin"].includes(k)), "Unsupported calendar recurrence or option");
  check(input.weekly.length <= 128 && (input.exceptions?.length ?? 0) <= 128 && (input.overrides?.length ?? 0) <= 128, "Calendar exceeds 128 rules");
  const rules: Rule[] = [];
  for (const w of input.weekly) {
    check(Object.keys(w).every(k => ["weekday", "startMinute", "endMinute"].includes(k)), "Unsupported weekly rule");
    check(integer(w.weekday, 0, 6), "Invalid weekday"); localWindow(w, true);
    rules.push({ ...blank, kind: "Weekly", weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute, available: true });
  }
  const dates = new Set<string>();
  for (const exception of input.exceptions ?? []) {
    check(Object.keys(exception).every(k => ["date", "windows"].includes(k)), "Unsupported date exception");
    date(exception.date);
    check(!dates.has(exception.date), "Duplicate date exception"); dates.add(exception.date);
    check(Array.isArray(exception.windows) && exception.windows.length <= 128, "Expected at most 128 exception windows");
    if (!exception.windows.length) rules.push({ ...blank, kind: "Date", localDate: exception.date, available: false });
    for (const w of exception.windows) {
      check(Object.keys(w).every(k => ["startMinute", "endMinute"].includes(k)), "Unsupported exception window");
      localWindow(w, false);
      check(rules.length < 128, "Calendar exceeds 128 rules");
      rules.push({ ...blank, kind: "Date", localDate: exception.date, startMinute: w.startMinute, endMinute: w.endMinute, available: true });
    }
  }
  const overrides = input.overrides ?? [];
  for (const override of overrides) {
    check(Object.keys(override).every(k => ["from", "until", "available", "priority"].includes(k)), "Unsupported override");
    const from = instant(override.from), until = instant(override.until);
    check(until > from && typeof override.available === "boolean" && integer(override.priority, 0, 127), "Invalid override");
    rules.push({ ...blank, kind: "Override", from: new Date(from).toISOString(), until: new Date(until).toISOString(), available: override.available, priority: override.priority });
  }
  for (let a = 0; a < overrides.length; a++) for (let b = a + 1; b < overrides.length; b++) {
    const x = overrides[a]!, y = overrides[b]!;
    check(x.priority !== y.priority || instant(x.from) >= instant(y.until) || instant(y.from) >= instant(x.until), "Overlapping overrides require distinct priorities");
  }
  check(rules.length <= AVAILABILITY_LIMITS.rules, "Calendar exceeds 128 rules");
  return rules.sort((a, b) => { const x = stableJson(a), y = stableJson(b); return x < y ? -1 : x > y ? 1 : 0; });
}
function nodeTimezoneVersion(): string {
  const versions = (globalThis as { process?: { versions?: { tz?: string } } }).process?.versions;
  return versions?.tz ? `tzdb:${versions.tz}` : "";
}
/** Pinned revision queries use the host's versioned Intl timezone database. Hosts without
 * a discoverable tzdb version must supply a truthful deployment-controlled version label.
 * Version mismatches fail closed; replay on another tzdb requires the matching host image. */
export class Availability {
  private readonly timezoneDataVersion: string;
  constructor(private readonly engine: Engine, options: { timezoneDataVersion?: string } = {}) {
    this.timezoneDataVersion = options.timezoneDataVersion ?? nodeTimezoneVersion();
    check(this.timezoneDataVersion.length > 0 && this.timezoneDataVersion.length <= 128, "A timezone database version is required");
  }
  private call(operation: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> { return this.engine.call(prefix + operation, input, ctx); }
  createCalendar(label: string, ctx: CallContext) { return this.call("AvailabilityCalendar.create", { label }, ctx); }
  /** Publish the immutable revision last. Failed staging can leave orphan rows, never a partial revision.
   * The pinned count + unique ordinals mean later appends cannot change this revision's rule set. */
  createRevision(input: CalendarRevisionInput, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const rules = yield* Effect.try({ try: () => rulesFor(input), catch: e => err("ValidationFailed", String(e)) });
      const snapshot = { calendar: input.calendar, timezone: input.timezone, origin: input.origin ?? null };
      const rulesDigest = yield* Effect.promise(() => sha256(stableJson({ rules })));
      const ruleSet = yield* self.call("AvailabilityRuleSet.create", { calendar: snapshot.calendar }, ctx);
      for (const [ordinal, rule] of rules.entries()) yield* self.call("AvailabilityRule.create", { ruleSet: ruleSet.id, ordinal, ...rule }, { ...ctx, ...(ctx.idempotencyKey ? { idempotencyKey: `${ctx.idempotencyKey}:rule:${ordinal}` } : {}) });
      return yield* self.call("AvailabilityCalendarRevision.create", { ...snapshot, ruleSet: ruleSet.id, ruleCount: rules.length, rulesDigest, timezoneDataVersion: self.timezoneDataVersion }, ctx);
    });
  }
  effectiveWindows(revision: string, from: string, until: string, ctx: CallContext): Effect.Effect<EffectiveAvailability, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const bounds = yield* Effect.try({ try: () => {
        const start = instant(from), end = instant(until);
        check(end > start && (end - start) / MINUTE <= AVAILABILITY_LIMITS.queryMinutes, "Query must span 1 minute to 31 days");
        return { start, end };
      }, catch: e => err("ValidationFailed", String(e)) });
      const pin = yield* self.call("AvailabilityCalendarRevision.get", { id: revision }, ctx);
      if (pin.timezoneDataVersion !== self.timezoneDataVersion) return yield* Effect.fail(err("ValidationFailed", "Calendar revision requires a different timezone database version"));
      const rules: Rule[] = [];
      for (let ordinal = 0; ordinal < Number(pin.ruleCount); ordinal++) {
        const row = yield* self.call("AvailabilityRule.find.byRuleSetOrdinal", { params: { ruleSet: pin.ruleSet, ordinal } }, ctx);
        rules.push({ kind: row.kind as Rule["kind"], weekday: row.weekday as number | null, localDate: row.localDate as string | null, startMinute: row.startMinute as number | null, endMinute: row.endMinute as number | null, available: row.available as boolean, from: row.from as string | null, until: row.until as string | null, priority: row.priority as number | null });
      }
      const digest = yield* Effect.promise(() => sha256(stableJson({ rules })));
      if (digest !== pin.rulesDigest) return yield* Effect.fail(err("ValidationFailed", "Calendar revision rule digest mismatch"));
      return yield* Effect.try({ try: () => {
        // Revalidate directly authored rows too. CRUD never grants malformed persisted rules meaning.
        const weekly: WeeklyWindow[] = [], dates = new Map<string, LocalWindow[]>(), overrides: AvailabilityOverride[] = [];
        for (const r of rules) {
          if (r.kind === "Weekly") { check(r.available && r.localDate === null && r.from === null && r.until === null && r.priority === null, "Invalid persisted weekly rule"); weekly.push({ weekday: r.weekday!, startMinute: r.startMinute!, endMinute: r.endMinute! }); }
          else if (r.kind === "Date") {
            check(r.weekday === null && r.from === null && r.until === null && r.priority === null, "Invalid persisted date rule");
            date(r.localDate!); const windows = dates.get(r.localDate!) ?? [];
            if (r.available) windows.push({ startMinute: r.startMinute!, endMinute: r.endMinute! });
            else check(r.startMinute === null && r.endMinute === null, "Invalid closed-date rule");
            dates.set(r.localDate!, windows);
          } else if (r.kind === "Override") { check(r.weekday === null && r.localDate === null && r.startMinute === null && r.endMinute === null, "Invalid persisted override"); overrides.push({ from: r.from!, until: r.until!, available: r.available, priority: r.priority! }); }
          else throw new Error("Unsupported persisted rule kind");
        }
        const checked = rulesFor({ calendar: String(pin.calendar), timezone: String(pin.timezone), weekly, exceptions: [...dates].map(([date, windows]) => ({ date, windows })), overrides });
        check(stableJson({ rules: checked }) === stableJson({ rules }), "Persisted rules are not canonical");
        return { revision, timezone: String(pin.timezone), timezoneDataVersion: self.timezoneDataVersion, windows: expand(checked, String(pin.timezone), bounds.start, bounds.end) };
      }, catch: e => err("ValidationFailed", String(e)) });
    });
  }
}
function expand(rules: readonly Rule[], timezone: string, start: number, end: number): AvailabilityWindow[] {
  const fmt = formatter(timezone);
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const windows: AvailabilityWindow[] = [];
  let opened: number | null = null;
  for (let ms = start; ms < end; ms += MINUTE) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    check(Number(parts.second) === 0, "Sub-minute historical timezone offsets are unsupported");
    const localDate = `${parts.year}-${parts.month}-${parts.day}`;
    const weekday = weekdayNames.indexOf(parts.weekday!);
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    const dates = rules.filter(r => r.kind === "Date" && r.localDate === localDate);
    let available = dates.length ? dates.some(r => r.available && minute >= r.startMinute! && minute < r.endMinute!) : rules.some(r => {
      if (r.kind !== "Weekly") return false;
      return r.endMinute! > r.startMinute! ? r.weekday === weekday && minute >= r.startMinute! && minute < r.endMinute! : (r.weekday === weekday && minute >= r.startMinute!) || ((r.weekday! + 1) % 7 === weekday && minute < r.endMinute!);
    });
    const override = rules.filter(r => r.kind === "Override" && ms >= Date.parse(r.from!) && ms < Date.parse(r.until!)).sort((a, b) => b.priority! - a.priority!)[0];
    if (override) available = override.available;
    if (available && opened === null) opened = ms;
    if (!available && opened !== null) { windows.push({ from: new Date(opened).toISOString(), until: new Date(ms).toISOString() }); opened = null; }
  }
  if (opened !== null) windows.push({ from: new Date(opened).toISOString(), until: new Date(end).toISOString() });
  return windows;
}
