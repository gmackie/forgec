import { Effect } from "effect";
import { encodeIdentity } from "./codecs.js";
import { MemoryStorage } from "./adapters/memory.js";
import { err, type ForgeError } from "./errors.js";
import type { Wire } from "./decode.js";
import type { Resource } from "./model.js";
import {
  RESOURCE_REVISION,
  type ResourceReadGuard,
  type CommitPlan,
  type StorageAdapter,
  type StoredRecord,
} from "./services.js";

/** Sequential resource calls only. The handle expires when the body completes. */
export interface TransactionContext {
  call(operation: string, input: Wire): Effect.Effect<Wire, ForgeError>;
}

/** A private overlay per invocation; the durable adapter still owns the commit. */
export class TransactionView {
  readonly plans: CommitPlan[] = [];
  readonly reads: ResourceReadGuard[] = [];
  private readonly snapshots = new Map<string, Map<string, StoredRecord>>();
  readonly storage: StorageAdapter;
  constructor(durable: StorageAdapter) {
    const self = this;
    this.storage = new Proxy(durable, {
      get(target, property) {
        if (
          [
            "get",
            "findUnique",
            "list",
            "countDependents",
            "overlapping",
            "effectiveAt",
            "children",
          ].includes(String(property))
        ) {
          return (tenant: string, resource: Resource, ...args: unknown[]) =>
            Effect.gen(function* () {
              if (!target.atomicReadSet)
                return yield* Effect.fail(
                  err(
                    "ValidationFailed",
                    "Adapter does not support transaction read-set guards",
                  ),
                );
              const key = JSON.stringify([tenant, resource.id]);
              let records = self.snapshots.get(key);
              if (!records) {
                if (self.reads.length >= 32)
                  return yield* Effect.fail(
                    err(
                      "BudgetExceeded",
                      "Transactions read at most 32 resources",
                    ),
                  );
                const revisionTenant = resource.decorators.tenant ? tenant : "";
                const revision = yield* target.getDocument(
                  revisionTenant,
                  RESOURCE_REVISION,
                  resource.id,
                );
                records = new Map<string, StoredRecord>();
                let cursor: string | null = null;
                let pages = 0;
                do {
                  const page: { records: StoredRecord[]; next: string | null } =
                    yield* target.exportPage(tenant, resource, cursor, 256);
                  for (const row of page.records)
                    records.set(String(row["id"]), row);
                  cursor = page.next;
                  if (++pages > 64 || records.size > 4096)
                    return yield* Effect.fail(
                      err(
                        "BudgetExceeded",
                        "Transaction resource snapshot exceeds 4096 records or 64 pages",
                      ),
                    );
                } while (cursor !== null);
                self.reads.push({
                  tenant: revisionTenant,
                  resource,
                  revision: revision ? Number(revision["_version"]) : null,
                });
                for (const plan of self.plans)
                  if (
                    plan.tenant === tenant &&
                    plan.resource.id === resource.id
                  ) {
                    if (plan.hardDelete) records.delete(plan.id);
                    else records.set(plan.id, structuredClone(plan.after));
                  }
                self.snapshots.set(key, records);
              }
              // Key-value interval guards carry a separate revision. Keep that
              // durable guard as well as the stronger resource read-set guard.
              if (property === "overlapping")
                yield* target.overlapping(
                  tenant,
                  resource,
                  args[0] as import("./services.js").IntervalGuard,
                );
              const local = MemoryStorage.snapshot(tenant, resource, [
                ...records.values(),
              ]);
              return yield* Reflect.apply(Reflect.get(local, property), local, [
                tenant,
                resource,
                ...args,
              ]) as Effect.Effect<unknown, ForgeError>;
            });
        }
        if (
          ["commit", "commitAll", "putDocument", "putDocuments"].includes(
            String(property),
          )
        )
          return () =>
            Effect.fail(
              err(
                "ValidationFailed",
                "Transaction planning cannot write durable storage",
              ),
            );
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  stage(plan: CommitPlan): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      // Also snapshots creates, so transient unique keys are checked against
      // the full staged view and guarded at commit even when later released.
      yield* self.storage.get(plan.tenant, plan.resource, plan.id);
      for (const claim of plan.claims)
        if (claim.after && claim.after !== claim.before) {
          const values = Object.fromEntries(
            [...claim.unique.within, ...claim.unique.fields].map((field) => [
              field,
              plan.after[field],
            ]),
          );
          const holder = yield* self.storage.findUnique(
            plan.tenant,
            plan.resource,
            claim.unique,
            claim.after,
            values,
          );
          if (holder && holder["id"] !== plan.id)
            return yield* Effect.fail(
              err("UniqueConflict", "A staged unique key is already held"),
            );
        }
      self.plans.push(plan);
      const records = self.snapshots.get(
        JSON.stringify([plan.tenant, plan.resource.id]),
      )!;
      if (plan.hardDelete) records.delete(plan.id);
      else records.set(plan.id, structuredClone(plan.after));
    });
  }
}

/** One physical record write per key; every logical audit/outbox remains present.
 * Changed keys/deletes need a validated resource read set. Structural guards
 * retain their own provider protocol and cannot be discarded while folding. */
export function lowerTransaction(
  plans: CommitPlan[],
  validatedReadSet = false,
): Effect.Effect<CommitPlan[], ForgeError> {
  const output: CommitPlan[] = [],
    positions = new Map<string, number>();
  for (const plan of plans) {
    const key = JSON.stringify([plan.tenant, plan.resource.id, plan.id]);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, output.length);
      output.push(plan);
      continue;
    }
    const first = output[position]!;
    if (
      !validatedReadSet &&
      (!["update", "transition"].includes(plan.kind) ||
        first.hardDelete ||
        first.kind === "delete" ||
        first.kind === "restore" ||
        !plan.resource.decorators.versioned ||
        plan.expectedVersion !== first.after["version"] ||
        plan.claims.some((c) => c.before !== c.after) ||
        first.interval ||
        plan.interval ||
        first.tree ||
        plan.tree ||
        plan.references.some(
          (g) =>
            !first.references.some(
              (f) =>
                f.field === g.field &&
                f.resource.id === g.resource.id &&
                f.id === g.id,
            ),
        ))
    )
      return Effect.fail(
        err(
          "ValidationFailed",
          "Repeated transaction writes require a validated read set for changed keys, references, deletes or structural guards",
        ),
      );
    if (validatedReadSet) {
      if (first.interval || plan.interval || first.tree || plan.tree)
        return Effect.fail(
          err(
            "ValidationFailed",
            "Repeated temporal/hierarchy writes require dedicated structural lowering",
          ),
        );
      if (first.hardDelete || plan.kind === "create")
        return Effect.fail(
          err(
            "ValidationFailed",
            "A deleted identity cannot be reused inside a transaction",
          ),
        );
      const claims = plan.resource.uniques.map((unique) => {
        const key = (record: StoredRecord | null) => {
          if (
            !record ||
            (unique.condition &&
              !unique.condition.values.includes(
                String(record[unique.condition.field]),
              ))
          )
            return null;
          const values = [...unique.within, ...unique.fields].map(
            (field) => record[field],
          );
          return values.some((value) => value === null || value === undefined)
            ? null
            : encodeIdentity([
                plan.resource.id,
                unique.name,
                ...values.map(String),
              ]);
        };
        return {
          unique,
          before: key(first.before),
          after: plan.hardDelete ? null : key(plan.after),
        };
      });
      const { interval: _firstInterval, tree: _firstTree, ...base } = first;
      const { interval: _interval, tree: _tree, ...logical } = plan;
      output[position] = {
        ...base,
        kind:
          first.kind === "create"
            ? plan.hardDelete
              ? "publish"
              : "create"
            : plan.kind,
        after: plan.after,
        hardDelete: plan.hardDelete,
        claims,
        references: plan.references,
        dependents: [],
      };
      output.push({
        ...logical,
        kind: "publish",
        claims: [],
        references: [],
        dependents: [],
        hardDelete: false,
      });
      continue;
    }
    // First record guard remains the durable guard; all intermediate validation
    // has already run against the overlay. Later audits keep their own opIds.
    output[position] = { ...first, after: plan.after };
    output.push({
      ...plan,
      kind: "publish",
      claims: [],
      references: [],
      dependents: [],
      hardDelete: false,
    });
  }
  if (validatedReadSet) {
    // Persist final parents before their children, and reference removals before
    // deleting a parent. Logical audits retain their original operation IDs.
    const pending = [...output],
      ordered: CommitPlan[] = [];
    const key = (plan: CommitPlan) =>
      JSON.stringify([plan.tenant, plan.resource.id, plan.id]);
    const records = output.filter((plan) => plan.kind !== "publish");
    const completed = new Set<string>();
    while (pending.length) {
      const index = pending.findIndex((plan) => {
        if (plan.kind === "publish") return true;
        for (const other of records) {
          if (key(other) === key(plan) || completed.has(key(other))) continue;
          if (
            !plan.hardDelete &&
            other.kind === "create" &&
            plan.resource.fields.some(
              (field) =>
                field.type.base.kind === "reference" &&
                field.type.base.resource === other.resource.id &&
                plan.after[field.name] === other.id,
            )
          )
            return false;
          if (
            plan.hardDelete &&
            other.resource.fields.some(
              (field) =>
                field.type.base.kind === "reference" &&
                field.type.base.resource === plan.resource.id &&
                other.before?.[field.name] === plan.id &&
                (other.hardDelete || other.after[field.name] !== plan.id),
            )
          )
            return false;
        }
        return true;
      });
      if (index < 0)
        return Effect.fail(
          err(
            "ValidationFailed",
            "Cyclic final transaction references require deferred constraints",
          ),
        );
      const plan = pending.splice(index, 1)[0]!;
      ordered.push(plan);
      if (plan.kind !== "publish") completed.add(key(plan));
    }
    return Effect.succeed(ordered);
  }
  return Effect.succeed(output);
}
