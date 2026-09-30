import { Effect } from "effect";
import { sha256, stableJson, type Engine, type CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
const prefix = "@forgegraph/foundation/configuration/_/";

export interface ResolvedEntry {
  key: string;
  /** Null for a secret parameter, whose value this package never holds. */
  value: string | null;
  /** The binding a secret parameter points at, never the secret itself. */
  secretRef: string | null;
  /** Which configuration in the chain supplied it, or null when it came from the default. */
  source: string | null;
}

export interface Resolution {
  resolved: string;
  digest: string;
  entries: ResolvedEntry[];
}

/**
 * Configuration resolution.
 *
 * Determinism comes from layer ordinals, not from traversal order: the chain is walked to the
 * root and the highest-ordinal assignment for each parameter wins, which is the same answer
 * whichever end you start from. `Configuration`'s own rules guarantee the chain is strictly
 * increasing, so there is never a tie to break.
 *
 * Every resolved value carries the configuration it came from. Without that, a surprising
 * value is unattributable and the only way to explain it is to re-derive the whole chain by
 * hand. The digest is computed over the resolved entries in key order, including its pin and effective sources, so the same snapshot
 * produces the same identity on any machine and a reconciler can compare identities
 * rather than values.
 *
 * Secrets are never resolved here. A secret parameter resolves to the binding it references;
 * dereferencing that is the caller's business, and this package is deliberately incapable of it.
 */
export class Configuration {
  constructor(private readonly engine: Engine) {}
  private call(operation: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    return this.engine.call(prefix + operation, input, ctx);
  }

  /** The configuration chain, root first. */
  private chain(configuration: string, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const order: Wire[] = [];
      let current: string | null = configuration;
      // Bounded by the layer ordinal range, which the model caps at 64.
      for (let depth = 0; current && depth <= 64; depth++) {
        const node: Wire = yield* self.call("Configuration.get", { id: current }, ctx);
        order.unshift(node);
        current = node["parent"] == null ? null : String(node["parent"]);
      }
      if (current) return yield* Effect.fail(err("ValidationFailed", "Configuration chain is too deep"));
      return order;
    });
  }

  /**
   * Resolve and record. `resolvedAt` is supplied rather than read from a clock so a resolution
   * is reproducible: re-resolving the same chain at the same instant is the same fact, and the
   * digest proves it.
   */
  resolve(configuration: string, resolvedAt: string, ctx: CallContext, limit = 256): Effect.Effect<Resolution, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      if (ctx.idempotencyKey) return yield* Effect.fail(err("ValidationFailed", "Resolution uses configuration and digest as its durable command key"));
      const chain = yield* self.chain(configuration, ctx);
      const leaf = chain[chain.length - 1];
      if (!leaf) return yield* Effect.fail(err("NotFound", "Configuration not found"));

      const definitionPage = yield* self.call("ParameterDefinition.list.byPin", {
        params: { pin: leaf["pin"] }, limit,
      }, ctx);
      if (definitionPage["next"] != null) return yield* Effect.fail(err("BudgetExceeded", "Parameter definitions exceed the lookup bound"));
      const definitions = (definitionPage["items"] ?? []) as Wire[];

      // Nearest-wins: walking the chain root-first lets a later (higher) layer overwrite.
      const winner = new Map<string, { assignment: Wire; source: string }>();
      for (const node of chain) {
        const assignmentPage = yield* self.call("ParameterAssignment.list.byConfiguration", {
          params: { configuration: node["id"] }, limit,
        }, ctx);
        if (assignmentPage["next"] != null) return yield* Effect.fail(err("BudgetExceeded", "Parameter assignments exceed the lookup bound"));
        const assignments = (assignmentPage["items"] ?? []) as Wire[];
        for (const assignment of assignments)
          winner.set(String(assignment["parameter"]), { assignment, source: String(node["id"]) });
      }

      const entries: ResolvedEntry[] = [];
      for (const definition of [...definitions].sort((a, b) => String(a["key"]) < String(b["key"]) ? -1 : String(a["key"]) > String(b["key"]) ? 1 : 0)) {
        const hit = winner.get(String(definition["id"]));
        if (!hit) {
          if (definition["defaultValue"] == null && definition["required"] === true)
            return yield* Effect.fail(
              err("ValidationFailed", `Required parameter "${String(definition["key"])}" has no assignment and no default`),
            );
          if (definition["defaultValue"] == null) continue;
          entries.push({ key: String(definition["key"]), value: String(definition["defaultValue"]), secretRef: null, source: null });
          continue;
        }
        entries.push({
          key: String(definition["key"]),
          value: hit.assignment["value"] == null ? null : String(hit.assignment["value"]),
          secretRef: hit.assignment["secretRef"] == null ? null : String(hit.assignment["secretRef"]),
          source: hit.source,
        });
      }

      // Bind effective provenance and the pinned parameter definitions as well as values.
      const digest = `sha256:${yield* Effect.promise(() => sha256(stableJson({
        pin: leaf["pin"], entries: entries.map(entry => ({ ...entry,
          parameter: definitions.find(d => d["key"] === entry.key)!["id"],
        })),
      })))}`;
      // A resolution is identified by (configuration, digest), so resolving the same desired
      // state twice is the same fact rather than an error or a second row. The unique
      // constraint is what makes that true; this just declines to fight it.
      const existing = yield* self.call("ResolvedConfiguration.find.byConfigurationDigest", {
        params: { configuration, digest },
      }, ctx).pipe(Effect.catch((e) => (e.code === "NotFound" ? Effect.succeed(null) : Effect.fail(e))));
      if (entries.length > 32) return yield* Effect.fail(err("BudgetExceeded", "Configuration resolution supports at most 32 values per atomic snapshot"));
      const resolved = existing ?? (yield* self.call("ResolvedConfiguration.create", {
        configuration, digest, resolvedAt, entryCount: entries.length,
      }, ctx).pipe(Effect.catch(error => error.code === "UniqueConflict"
        ? self.call("ResolvedConfiguration.find.byConfigurationDigest", { params: { configuration, digest } }, ctx)
        : Effect.fail(error))));
      const stored = yield* self.call("ResolvedValue.list.byResolved", { params: { resolved: resolved["id"] }, limit: 33 }, ctx);
      const values = (stored["items"] ?? []) as Wire[];
      const matches = (rows: Wire[]) => rows.length === entries.length && entries.every(entry => rows.some(row =>
        row["parameter"] === definitions.find(d => d["key"] === entry.key)!["id"] &&
        row["source"] === (entry.source ?? leaf["id"]) && row["value"] === entry.value && row["secretRef"] === entry.secretRef));
      if (resolved["entryCount"] !== entries.length || stored["next"] || (values.length !== 0 && !matches(values)))
        return yield* Effect.fail(err("ValidationFailed", "Stored configuration snapshot is incomplete; repair required"));
      if (values.length === 0 && entries.length) {
        const mutations = entries.map(entry => ({operation: prefix + "ResolvedValue.create", input: {
          resolved: resolved["id"], parameter: definitions.find(d => String(d["key"]) === entry.key)!["id"],
          source: entry.source ?? leaf["id"], value: entry.value, secretRef: entry.secretRef,
        }}));
        yield* self.engine.atomic(mutations, ctx).pipe(Effect.catch(error => {
          if (error.code !== "UniqueConflict") return Effect.fail(error);
          return self.call("ResolvedValue.list.byResolved", { params: { resolved: resolved["id"] }, limit: 33 }, ctx).pipe(Effect.flatMap(page =>
            !page["next"] && matches(page["items"] as Wire[]) ? Effect.void : Effect.fail(error)));
        }));
      }
      return { resolved: String(resolved["id"]), digest, entries };
    });
  }

  listValues(resolved: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}) {
    const self = this;
    return Effect.gen(function* () {
      const header = yield* self.call("ResolvedConfiguration.get", { id: resolved }, ctx);
      const all = yield* self.call("ResolvedValue.list.byResolved", { params: { resolved }, limit: 33 }, ctx);
      if (all["next"] || (all["items"] as Wire[]).length !== header["entryCount"])
        return yield* Effect.fail(err("TransientConflict", "Configuration resolution is not complete; retry resolve"));
      return yield* self.call("ResolvedValue.list.byResolved", { params: { resolved }, ...page }, ctx);
    });
  }
}
