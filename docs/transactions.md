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
hierarchy operations are rejected. Functions retain their existing independent
planning behavior; this API does not silently change their semantics.

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
