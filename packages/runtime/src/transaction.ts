import { Effect } from "effect";
import { err, type ForgeError } from "./errors.js";
import type { Wire } from "./decode.js";
import type { Resource } from "./model.js";
import type { CommitPlan, StorageAdapter, StoredRecord } from "./services.js";

/** Sequential resource calls only. The handle expires when the body completes. */
export interface TransactionContext {
  call(operation: string, input: Wire): Effect.Effect<Wire, ForgeError>;
}

/** A private overlay per invocation; the durable adapter still owns the commit. */
export class TransactionView {
  readonly plans: CommitPlan[] = [];
  private readonly records = new Map<string, StoredRecord | null>();
  private readonly touched = new Set<string>();
  readonly storage: StorageAdapter;
  constructor(durable: StorageAdapter) {
    const self = this;
    // Keep every other adapter method bound to its original receiver. In
    // particular, never copy class instances with object spread.
    this.storage = new Proxy(durable, {
      get(target, property) {
        if (property === "get")
          return (tenant: string, resource: Resource, id: string) =>
            Effect.suspend(() => {
              const key = self.key(tenant, resource, id);
              return self.records.has(key)
                ? Effect.succeed(structuredClone(self.records.get(key)!))
                : target.get(tenant, resource, id);
            });
        // A partial durable page cannot safely be merged with staged rows:
        // filtering/ordering can move rows across the page boundary.
        if (
          [
            "findUnique",
            "list",
            "countDependents",
            "overlapping",
            "effectiveAt",
            "children",
          ].includes(String(property))
        ) {
          return (tenant: string, resource: Resource, ...args: unknown[]) =>
            Effect.suspend(() => {
              if (self.touched.has(JSON.stringify([tenant, resource.id])))
                return Effect.fail(
                  err(
                    "ValidationFailed",
                    "Transaction query overlays are not supported; use point reads or query before staging writes",
                  ),
                );
              return Reflect.apply(Reflect.get(target, property), target, [
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
  private key(tenant: string, resource: Resource, id: string) {
    return JSON.stringify([tenant, resource.id, id]);
  }
  stage(plan: CommitPlan): void {
    this.plans.push(plan);
    this.records.set(
      this.key(plan.tenant, plan.resource, plan.id),
      plan.hardDelete ? null : structuredClone(plan.after),
    );
    this.touched.add(JSON.stringify([plan.tenant, plan.resource.id]));
  }
}

/** One physical record write per key; every logical audit/outbox remains present.
 * Only stable-key, stable-reference updates can be folded in this first slice. */
export function lowerTransaction(
  plans: CommitPlan[],
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
      !["update", "transition"].includes(plan.kind) ||
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
      )
    ) {
      return Effect.fail(
        err(
          "ValidationFailed",
          "Repeated transaction writes require versioned updates with stable unique keys and references and no temporal/hierarchy guards",
        ),
      );
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
  return Effect.succeed(output);
}
