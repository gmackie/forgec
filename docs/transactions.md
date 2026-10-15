# Sequential resource transactions

`Engine.transaction` provides an experimental bounded transaction body. Run
resource calls sequentially using the supplied context; return an Effect result.
The runtime stages mutations and calls the durable adapter's `commitAll` once.

```ts
const result = await Effect.runPromise(
  engine.transaction(
    (tx) =>
      Effect.gen(function* () {
        const parent = yield* tx.call("@acme/commerce/_/Customer.create", {
          code: "PARENT",
          name: "Parent",
        });
        const child = yield* tx.call("@acme/commerce/_/Site.create", {
          customer: parent.id,
          code: "HQ",
          name: "HQ",
          timezone: "UTC",
        });
        return { parent, child };
      }),
    context,
  ),
);
```

Point reads and reference validation see earlier staged records in the same
tenant. Each call runs the ordinary purpose, authorization, validation,
suppression and write-fence checks. The transaction context expires when the
body completes and refuses concurrent calls. It is not an HTTP operation or a
user-supplied function execution mechanism.

Sequential versioned updates can use the staged version from the preceding
operation. Lowering writes the final record once with the original durable
version precondition. Every logical audit and outbox event retains its own
operation ID and intermediate payload/version. Unique/reference keys must stay
stable across repeated updates, and temporal/hierarchy guards cannot be folded.
An unhandled body failure, lowering rejection, provider conflict or budget
rejection leaves the group uncommitted. Application code must not publish an
external side effect from the body expecting it to roll back with storage.

At most 32 mutations are permitted. Physical budgeting uses the fully lowered
plans, including all audit/outbox work, before commit. Sequence allocation,
credential sealing, per-operation receipt keys, functions, blob operations and
hierarchy operations are rejected. Declared functions have a separate opt-in described below; existing function
implementations retain their independent planning behavior.

Queries on a resource already touched by the group are rejected. A paginated
durable result cannot safely be merged with staged records without implementing
the complete query and cursor protocol. Reads of untouched durable state use
the ordinary adapter; this API does not add a serializable read set for arbitrary
application predicates. Use a versioned mutation as the durable guard for an
invariant. Predicate overlays and read-set validation remain FORG-15 follow-up
work.

Memory and SQL storage advertise `atomicComposition`. Local tests exercise
memory, real SQLite and native libSQL, including late-conflict rollback and
staged foreign keys. The SQL path includes D1 and PostgreSQL facades, but these
tests do not certify deployed D1 or live PostgreSQL. DynamoDB does not advertise
the capability: its duplicate-item and reference-counter lowering needs separate
work before it can support this API. Unsupported/custom adapters fail before
running the body. No cross-provider certification is implied.

## Declared functions

Opt an implementation into the same bounded transaction view explicitly:

```ts
defineFunction(
  "@acme/commerce/_/Compose",
  (deps) =>
    Effect.gen(function* () {
      const parent = yield* deps.resources.Customer!.create({
        code: "HQ",
        name: "HQ",
      });
      yield* deps.resources.Customer!.update(String(parent.id), 1, {
        name: "Headquarters",
      });
      return yield* deps.resources.Customer!.get(String(parent.id));
    }),
  { transactional: true },
);
```

The declaration still controls resource capabilities, transitions, external
bindings and allowed messages. Every mutation uses ordinary authorization,
scope, suppression and write-fence checks. The same query and repeated-write
restrictions apply. Calls must execute sequentially and finish inside the body;
escaped resource, send and external Effects fail when executed later. A send
stages a message only when its Effect runs.

Lowered writes, logical audits, messages, the function's result receipt and any
subscription completion are budgeted together and committed once. A receipt-only
or message-only function also stores its actual result for replay when called
with an idempotency key. Unsupported adapters reject the invocation before the
body runs. Legacy implementations without the option keep their existing
planning behavior.

External bindings remain external side effects and cannot roll back with
storage. Subscription external-effect intent fencing remains in effect; it does
not make an arbitrary external service transactional. Tests cover memory, real
SQLite and native libSQL, including subscription completion and result replay;
live provider certification remains separate work.
