# Availability

Experimental weekly calendars with immutable revisions, typed rule rows and bounded
queries. This package owns neither capacity nor appointments.

Use `Availability` from the runtime's Foundation availability module to create a
calendar, publish a revision, and query its effective UTC windows. The application
explicitly deploys this package and Specification. Queries take an exact revision ID.
Weekly windows use Sunday = 0 and minute-of-day integers. `endMinute < startMinute`
means overnight; equal endpoints are invalid. Use `[0, 1440)` for a whole day.

```ts
const calendar = await Effect.runPromise(availability.createCalendar("Lab", context));
const revision = await Effect.runPromise(availability.createRevision({
  calendar: String(calendar.id), timezone: "America/New_York",
  weekly: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
  exceptions: [{ date: "2026-12-28", windows: [] }],
}, context));
const result = await Effect.runPromise(availability.effectiveWindows(
  String(revision.id), "2026-12-28T00:00:00Z", "2026-12-29T00:00:00Z", context,
));
```

A local-date exception replaces all weekly availability on that civil date, including
an overnight window carried from yesterday. Exception windows cannot cross midnight;
write an explicit entry for each date. Empty windows close the date. Absolute UTC
overrides apply last; highest priority wins and overlapping equal priorities fail.
All returned intervals are half-open and clipped to the requested bounds.

Queries enumerate at most 44,640 whole UTC minutes (31 days), evaluating local civil
parts through `Intl.DateTimeFormat`. No handwritten offset calculation is used.
Nonexistent DST wall minutes have no UTC instants; both occurrences of repeated wall
minutes are evaluated. This differs intentionally from cron's first-occurrence-only
trigger rule. Historical sub-minute offsets are refused. Results have minute resolution;
non-aligned timestamps fail rather than round. At most 128 stored rules are accepted.
Monthly recurrence, RRULE, holiday providers, business-duration arithmetic and unbounded
search are unsupported and must not be implied by this interface.

Every revision pins the timezone database label. Node defaults to `process.versions.tz`;
hosts without that information must supply a truthful, deployment-controlled version
label. A mismatch fails closed. Keep the matching host image for historical replay;
the library does not bundle an old timezone database or attest supplied labels.

Publication validates and normalizes rules, stores append-only rows, then publishes
an append-only revision with their count and digest. Each ordinal is unique within
its rule set. Queries read exactly the pinned ordinals and validate their digest and
semantics. A later append cannot change an old revision. Failed publication can leave
unreferenced staging rows, never a partially published successful revision. CRUD-authored
incomplete or malformed seals are refused at query time. Callers should retain an
idempotency key for retry; rule writes derive distinct ordinal keys from it.

`fixtures/consumer` demonstrates typed WorkerAvailability, MachineAvailability and
FacilityAvailability resources. `AvailabilitySearchInput` sketches the future Scheduling
boundary only. Allocation/Scheduling integration (F55-05) remains planned; these tests
do not reserve capacity or prove either system. Local memory/SQLite tests are not
hosted D1, PostgreSQL or DynamoDB certification.

To verify locally, build `fixtures/consumer` into a temporary directory and run
`foundation-availability.test.ts` with `FORGE_FOUNDATION_CONSUMER` pointing there.
