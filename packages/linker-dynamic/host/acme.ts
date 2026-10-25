// Linker B host for examples/acme. Generic except for the classes the platform binds by name:
// one Workflows class per workflow entry point (manifest `trigger.className`).
import { forgeWorkflow } from "../src/host.ts";

export { default, D1Gate, Egress, ManifestPointer, ObjectsGate, QueueGate, WorkflowGate } from "../src/host.ts";
export class ProcessOrderWorkflow extends forgeWorkflow("ProcessOrderWorkflow") {}
