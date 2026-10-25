// FORG-42: function units and externals of a shared packed script run in the script, where its
// bindings are. The runtime Worker asks for one (`invoke`) with a `RemoteDeps` stub. This module
// rebuilds the `deps` object the engine would have passed: the same resources, transitions and
// methods (`shape`), each an Effect that crosses back to the engine and keeps its typed failure.
// Only scripts that hold a js-module unit import this (and so Effect, which their units import anyway).
import { Effect } from "effect";
import type { ExternalBinding, FunctionContext, FunctionImpl } from "@forgegraph/runtime";
import { ForgeError } from "@forgegraph/runtime/errors";
import { serializeError, type DepsShape, type Outcome, type RemoteDeps, type SerializedError } from "./protocol.ts";
import type { UnitHost } from "./script.ts";

const revive = (e: SerializedError) => new ForgeError(e as ConstructorParameters<typeof ForgeError>[0]);
const READER = ["get", "find", "list", "create", "update", "delete"] as const;

export function unitHost(functions: FunctionImpl[], externals: Record<string, ExternalBinding>): UnitHost {
  const impls = new Map(functions.map((f) => [f.id, f]));
  return {
    declared: { functions: functions.map((f) => ({ id: f.id, ...(f.transactional ? { transactional: true } : {}) })), externals: Object.keys(externals).sort() },
    async invoke(id: string, input: unknown, ctx: unknown, remote: RemoteDeps, shape: DepsShape): Promise<Outcome> {
      const impl = impls.get(id);
      if (!impl) return { ok: false, error: { code: "Internal", detail: `no implementation registered for ${id}` } };
      // A rejected call (a defect or a lost hop) is a defect here too, as an in-process die would be.
      const call = (path: string[], args: unknown[]) => Effect.flatMap(Effect.promise(() => remote.call(path, args)), (r) => (r.ok ? Effect.succeed(r.value as never) : Effect.fail(revive(r.error))));
      const resources = Object.fromEntries(shape.resources.map((r) => [r, Object.fromEntries(READER.map((m) => [m, (...a: unknown[]) => call(["resources", r, m], a)]))]));
      const transitions = Object.fromEntries(Object.entries(shape.transitions).map(([r, ts]) => [r, Object.fromEntries(ts.map((t) => [t, (...a: unknown[]) => call(["transitions", r, t], a)]))]));
      const deps = {
        input,
        ctx,
        resources,
        transitions,
        external: (eid: string, i: unknown) => call(["external"], [eid, i]),
        send: (channel: string, message: string, payload: unknown) => call(["send"], [channel, message, payload]),
        fail: (name: string, detail?: string) => call(["fail"], detail === undefined ? [name] : [name, detail]),
      } as unknown as FunctionContext;
      return Effect.runPromise(Effect.match(impl.body(deps), { onSuccess: (value): Outcome => ({ ok: true, value }), onFailure: (e): Outcome => ({ ok: false, error: serializeError(e) }) }));
    },
    async external(id: string, input: unknown, ctx: unknown) {
      const binding = externals[id];
      if (!binding) throw new Error(`no binding for external ${id}`);
      return binding(input, ctx as Parameters<ExternalBinding>[1]);
    },
  };
}
