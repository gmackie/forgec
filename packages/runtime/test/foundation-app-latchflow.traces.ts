import { resolve } from "node:path";
import { expect, it } from "vitest";
import { Effect } from "effect";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { latchFlowFoundation } from "../../../examples/foundation/apps/latchflow/adapter.js";
import { Operations } from "../src/foundation/operations.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const root = process.env["FORGE_FOUNDATION_LATCHFLOW_ROOT"];
if (!root) throw new Error("FORGE_FOUNDATION_LATCHFLOW_ROOT must point to the verified app revision");
const source = resolve(root, "packages/api/src/services/foundation-run.ts");
const { projectStartedRun } = await import(/* @vite-ignore */ source);
const app = "@foundation-app/latchflow/_/", spec = "@forgegraph/foundation/specification/_/";
const room = { id: "native-room", buildingId: "acme" };
const compiled = { id: "compiled-42", flowId: "flow-1", roomId: room.id, compiledJson: '{"version":1,"nodes":[]}' };
const nativeRun = { id: "native-run", roomId: room.id, flowId: compiled.flowId, compiledFlowId: compiled.id, runnerId: "runner-1", status: "idle", startedAt: new Date("2026-01-01T00:00:00Z") };
for (const adapter of foundationAdapters) {
  it(`${adapter}: actual LatchFlow Run projects exact compiled content and preserves runner acknowledgment boundary`, async () => {
    const f = await foundation("latchflow", adapter);
    try {
      const repository = await f.call(spec + "Repository.create", { key: "latchflow", provider: "git", locator: "https://github.com/gmackie/latchflow" });
      const pin = await f.call(spec + "SpecificationPin.create", { repository: repository.id, anchor: compiled.id, revision: "e3b2b96954b811e8a990c43d6369b8169c1ecf9f" });
      const port = latchFlowFoundation(f.engine, { context: (tenant, actor) => ({ ...f.ctx, tenant, actor }), definition: async () => String(pin.id) });
      const lostResponse = await projectStartedRun({ recordRun: async (event: Parameters<typeof port.recordRun>[0]) => { await port.recordRun(event); throw new Error("Lost projection response"); } }, "acme", "operator", room, nativeRun, compiled);
      expect(lostResponse).toEqual({ status: "pending", runId: nativeRun.id });
      const result = await projectStartedRun(port, "acme", "operator", room, nativeRun, compiled);
      expect(result).toMatchObject({ status: "recorded", phase: "Planned" });
      expect(await projectStartedRun(port, "acme", "operator", room, nativeRun, compiled)).toEqual(result);
      const linked = await f.call(app + "Run.get", { id: result.run });
      expect(linked).toMatchObject({ nativeId: nativeRun.id, runnerId: "runner-1", initialStatus: "idle" });
      expect((await Effect.runPromise(new Operations(f.engine).state(String(linked.execution), f.ctx))).phase).toBe("Planned");
      const flow = await f.call(app + "CompiledFlow.get", { id: linked.compiledFlow });
      expect(flow.definition).toBe(pin.id);
      expect(flow.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      const active = await projectStartedRun(port, "acme", "operator", room, { ...nativeRun, id: "local-run", runnerId: null, status: "running" }, compiled);
      expect(active).toMatchObject({ status: "recorded", phase: "Running" });
      const activeRun = await f.call(app + "Run.get", { id: active.run });
      expect((await Effect.runPromise(new Operations(f.engine).state(String(activeRun.execution), f.ctx))).phase).toBe("Running");
      expect((await projectStartedRun(port, "acme", "operator", room, nativeRun, { ...compiled, compiledJson: '{"substituted":true}' })).status).toBe("pending");
      await expect(f.call(app + "Run.get", { id: result.run }, { ...f.ctx, tenant: "foreign" })).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: actual LatchFlow seam rejects foreign scope and keeps native Run on denied projection`, async () => {
    const f = await foundation("latchflow", adapter);
    try {
      const port = latchFlowFoundation(f.engine, { context: (tenant, actor) => ({ ...f.ctx, tenant, actor }), definition: async () => "unreadable-pin" });
      await expect(projectStartedRun(port, "foreign", "operator", room, nativeRun, compiled)).rejects.toThrow();
      await expect(projectStartedRun(port, "acme", "operator", room, nativeRun, { ...compiled, id: "wrong-flow" })).rejects.toThrow();
      f.engine.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [], epoch: 1, knownObligations: [] });
      expect(await projectStartedRun(port, "acme", "operator", room, nativeRun, compiled)).toEqual({ status: "pending", runId: nativeRun.id });
      expect(nativeRun.status).toBe("idle");
    } finally { await f.close(); }
  });
}
