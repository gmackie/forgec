// FORG-38 lab entry for linker B: B's host (packages/linker-dynamic/src/host.ts), unchanged, behind the
// lab gate (./gate.js). acme's one workflow class is not exported: the lab deploys no Workflows.
import host from "../../../../packages/linker-dynamic/src/host.ts";
import { labGate } from "./gate.js";

export { D1Gate, Egress, ObjectsGate, QueueGate, WorkflowGate } from "../../../../packages/linker-dynamic/src/host.ts";
export default labGate(host, "b");
