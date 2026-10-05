/**
 * The Temporal workflow that drives one Forge workflow instance. It runs in
 * Temporal's deterministic sandbox and knows nothing about the business
 * graph: it calls the `advance` activity (which runs the Forge executor
 * against the store), then sleeps until the due instant or waits for a
 * `forge-wake` signal, and loops until the instance is terminal. Timers and
 * signal buffering are Temporal's durable state; step semantics, receipts
 * and the instance document stay in the Forge store.
 */
import { condition, defineSignal, proxyActivities, setHandler, sleep, workflowInfo } from "@temporalio/workflow";

export interface DriveInput { tenant: string; id: string }
export interface AdvanceResult { status: string; dueAt: string | null }
export interface ForgeActivities {
  advance(input: DriveInput): Promise<AdvanceResult>;
}

export const wakeSignal = defineSignal("forge-wake");
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function forgeInstance(input: DriveInput): Promise<AdvanceResult> {
  const { advance } = proxyActivities<ForgeActivities>({ startToCloseTimeout: "5 minutes", retry: { maximumAttempts: 50, initialInterval: "1 second", maximumInterval: "30 seconds", backoffCoefficient: 2 } });
  let wakes = 0;
  let consumed = 0;
  setHandler(wakeSignal, () => { wakes++; });
  for (let i = 0; i < 100_000; i++) {
    const st = await advance(input);
    if (TERMINAL.has(st.status)) return st;
    const dueMs = st.dueAt ? Date.parse(st.dueAt) - Date.now() : null;
    if (st.status === "sleeping") {
      await sleep(Math.max(1, dueMs ?? 1000));
      continue;
    }
    if (st.status === "running") {
      await sleep(1000);
      continue;
    }
    // waiting: a signal already buffered wakes immediately; otherwise wait for one or for the deadline
    const before = consumed;
    const woke = await condition(() => wakes > before, dueMs !== null && dueMs > 0 ? dueMs : 365 * 24 * 3600 * 1000);
    if (woke) consumed = wakes;
    void workflowInfo();
  }
  return { status: "failed", dueAt: null };
}
