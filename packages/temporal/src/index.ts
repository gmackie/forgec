/**
 * Temporal-backed WorkflowDriver (FORGE-076, profile self-hosted-full). The
 * Forge engine stays the executor: instances, steps, receipts and the inbox
 * live in the Forge store, exactly as on Cloudflare Workflows and Step
 * Functions. Temporal supplies durable timers and signal buffering: one
 * Temporal execution per Forge instance runs `forgeInstance`, which calls the
 * `advance` activity and waits. `started` starts the execution; `wake` sends
 * the `forge-wake` signal after the engine consumed a business signal.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { Engine, WorkflowDriver } from "@forge/runtime";
import { forgeInstance, wakeSignal, type AdvanceResult, type DriveInput } from "./workflows.js";

export interface TemporalOptions { address: string; namespace?: string; taskQueue: string }

const workflowId = (tenant: string, id: string) => `forge:${tenant}:${id}`.replace(/[^A-Za-z0-9:_-]/g, "_");

/** The driver the engine calls: start one execution per instance, wake it after a consumed signal. */
export async function temporalDriver(o: TemporalOptions): Promise<WorkflowDriver & { client: Client; close(): Promise<void> }> {
  const connection = await Connection.connect({ address: o.address });
  const client = new Client({ connection, namespace: o.namespace ?? "default" });
  return {
    client,
    async started(tenant, _wf, id) {
      // idempotent: a second start for the same instance id (crash between commit and start) is not a second execution
      await client.workflow.start(forgeInstance, { taskQueue: o.taskQueue, workflowId: workflowId(tenant, id), args: [{ tenant, id } satisfies DriveInput] }).catch((e: unknown) => {
        if (String((e as Error).name).includes("WorkflowExecutionAlreadyStartedError")) return;
        throw e;
      });
    },
    async wake(tenant, _wf, inst) {
      try {
        await client.workflow.getHandle(workflowId(tenant, inst.id)).signal(wakeSignal);
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return; // already finished or never driven by Temporal
        throw e;
      }
    },
    close: () => connection.close(),
  };
}

/** The worker hosting the Forge activity: `advance` runs the engine's executor for one instance. */
export async function temporalWorker(engine: Engine, o: TemporalOptions): Promise<{ run(): Promise<void>; shutdown(): void }> {
  const connection = await NativeConnection.connect({ address: o.address });
  const js = fileURLToPath(new URL("./workflows.js", import.meta.url));
  const ts = fileURLToPath(new URL("./workflows.ts", import.meta.url));
  const worker = await Worker.create({
    connection,
    namespace: o.namespace ?? "default",
    taskQueue: o.taskQueue,
    workflowsPath: existsSync(js) ? js : ts,
    activities: {
      async advance(input: DriveInput): Promise<AdvanceResult> {
        const st = (await Effect.runPromise(engine.workflows.advance(input.tenant, input.id).pipe(Effect.provide(engine.layer)) as Effect.Effect<Record<string, unknown>, never, never>)) as Record<string, unknown>;
        const dueAt = ((st["sleeping"] as { dueAt?: string } | undefined)?.dueAt ?? (st["waiting"] as { dueAt?: string } | undefined)?.dueAt) ?? null;
        return { status: String(st["status"]), dueAt };
      },
    },
  });
  return { run: () => worker.run().finally(() => connection.close()), shutdown: () => worker.shutdown() };
}
