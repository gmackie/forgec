// RebuildOrderSummary: target of the NightlyReconciliation schedule.
import { Effect } from "effect";
import { defineFunction } from "@forgegraph/runtime";

export const rebuildOrderSummary = defineFunction("@acme/commerce/_/RebuildOrderSummary", () => Effect.succeed({ rebuilt: true }));
