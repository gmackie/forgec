import { resolve } from "node:path";
import { expect, it } from "vitest";
import { Effect } from "effect";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { streamConductorFoundation } from "../../../examples/foundation/apps/stream-conductor/adapter.js";
import { Fulfillments } from "../src/foundation/fulfillment.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const root = process.env["FORGE_FOUNDATION_STREAM_CONDUCTOR_ROOT"];
if (!root) throw new Error("FORGE_FOUNDATION_STREAM_CONDUCTOR_ROOT must point to the verified app revision");
const source = resolve(root, "apps/web/src/server/services/foundation-production.ts");
const { projectAcknowledgedProduction } = await import(/* @vite-ignore */ source);
const app = "@foundation-app/stream-conductor/_/";
const session = { id: "native-session", teamId: "acme", broadcastId: "native-broadcast" };
const command = { id: "native-command", sessionId: session.id, operatorId: "operator", sequence: 1, type: "cut", status: "acknowledged", payload: { scene: "camera-wide" }, issuedAt: new Date("2026-01-01T00:00:00Z"), completedAt: new Date("2026-01-01T00:00:01Z") };
for (const adapter of foundationAdapters) {
  it(`${adapter}: actual Stream Conductor acknowledgment projects typed fulfillment and replays`, async () => {
    const f = await foundation("stream-conductor", adapter);
    try {
      const port = streamConductorFoundation(f.engine, (tenant, actor) => ({ ...f.ctx, tenant, actor }));
      const lostResponse = await projectAcknowledgedProduction({ recordAcknowledgedCommand: async (event: Parameters<typeof port.recordAcknowledgedCommand>[0]) => { await port.recordAcknowledgedCommand(event); throw new Error("Lost projection response"); } }, "acme", session, command);
      expect(lostResponse).toEqual({ status: "pending", commandId: command.id });
      const result = await projectAcknowledgedProduction(port, "acme", session, command);
      expect(result.status).toBe("recorded");
      expect(await projectAcknowledgedProduction(port, "acme", session, command)).toEqual(result);
      const linked = await f.call(app + "ProductionCommand.get", { id: result.command });
      expect(linked).toMatchObject({ nativeId: command.id, sequence: 1, kind: "cut", operatorId: "operator" });
      expect((await Effect.runPromise(new Fulfillments(f.engine).status(String(linked.fulfillment), f.ctx))).phase).toBe("completed");
      const storedSession = await f.call(app + "ProductionSession.get", { id: linked.session });
      expect((await f.call(app + "Broadcast.get", { id: storedSession.broadcast })).nativeId).toBe(session.broadcastId);
      expect((await f.call(app + "ProductionCommand.list.bySession", { params: { session: storedSession.id } })).items).toHaveLength(1);
      const changed = await projectAcknowledgedProduction(port, "acme", session, { ...command, payload: { scene: "different" } });
      expect(changed.status).toBe("pending");
      await expect(f.call(app + "ProductionCommand.get", { id: result.command }, { ...f.ctx, tenant: "foreign" })).rejects.toThrow();
    } finally { await f.close(); }
  });
  it(`${adapter}: actual Stream Conductor seam rejects foreign or uncertain commands and reports denied projection`, async () => {
    const f = await foundation("stream-conductor", adapter);
    try {
      const port = streamConductorFoundation(f.engine, (tenant, actor) => ({ ...f.ctx, tenant, actor }));
      await expect(projectAcknowledgedProduction(port, "foreign", session, command)).rejects.toThrow();
      await expect(projectAcknowledgedProduction(port, "acme", session, { ...command, status: "uncertain" })).rejects.toThrow();
      f.engine.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [], epoch: 1, knownObligations: [] });
      expect(await projectAcknowledgedProduction(port, "acme", session, command)).toEqual({ status: "pending", commandId: command.id });
      expect(command.status).toBe("acknowledged");
    } finally { await f.close(); }
  });
}
