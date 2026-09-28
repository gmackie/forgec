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
 * hand. The digest is computed over the resolved entries in key order, so the same desired
 * state produces the same identity on any machine and a reconciler can compare identities
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
      const chain = yield* self.chain(configuration, ctx);
      const leaf = chain[chain.length - 1];
      if (!leaf) return yield* Effect.fail(err("NotFound", "Configuration not found"));

      const definitions = ((yield* self.call("ParameterDefinition.list.byPin", {
        params: { pin: leaf["pin"] }, limit,
      }, ctx)) as { items?: Wire[] }).items ?? [];

      // Nearest-wins: walking the chain root-first lets a later (higher) layer overwrite.
      const winner = new Map<string, { assignment: Wire; source: string }>();
      for (const node of chain) {
        const assignments = ((yield* self.call("ParameterAssignment.list.byConfiguration", {
          params: { configuration: node["id"] }, limit,
        }, ctx)) as { items?: Wire[] }).items ?? [];
        for (const assignment of assignments)
          winner.set(String(assignment["parameter"]), { assignment, source: String(node["id"]) });
      }

      const entries: ResolvedEntry[] = [];
      for (const definition of [...definitions].sort((a, b) => String(a["key"]).localeCompare(String(b["key"])))) {
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

      // Identity is over what was resolved, not over how it was reached: two different chains
      // that produce the same values are the same desired state.
      const digest = `sha256:${yield* Effect.promise(() => sha256(stableJson(entries.map((e) => [e.key, e.value, e.secretRef]))))}`;
      // A resolution is identified by (configuration, digest), so resolving the same desired
      // state twice is the same fact rather than an error or a second row. The unique
      // constraint is what makes that true; this just declines to fight it.
      const existing = yield* self.call("ResolvedConfiguration.find.byConfigurationDigest", {
        params: { configuration, digest },
      }, ctx).pipe(Effect.catch((e) => (e.code === "NotFound" ? Effect.succeed(null) : Effect.fail(e))));
      if (existing) return { resolved: String(existing["id"]), digest, entries };

      const resolved = yield* self.call("ResolvedConfiguration.create", {
        configuration, digest, resolvedAt,
      }, ctx);
      for (const entry of entries) {
        const definition = definitions.find((d) => String(d["key"]) === entry.key)!;
        yield* self.call("ResolvedValue.create", {
          resolved: resolved["id"], parameter: definition["id"],
          // A defaulted value has no authoring configuration; it is attributed to the leaf,
          // which is the configuration that was asked to resolve.
          source: entry.source ?? leaf["id"],
          value: entry.value, secretRef: entry.secretRef,
        }, ctx);
      }
      return { resolved: String(resolved["id"]), digest, entries };
    });
  }

  listValues(resolved: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}) {
    return this.call("ResolvedValue.list.byResolved", { params: { resolved }, ...page }, ctx);
  }
}
