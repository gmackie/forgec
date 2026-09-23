import type { GizmoDefinition } from "@forgegraph/react";
import { customerDirectory } from "./customer-directory.js";

/** Application-owned, bundled components; deployment metadata never supplies executable code. */
import { foundationExplorer } from "./foundation-explorer.js";

export const gizmos: readonly GizmoDefinition[] = [customerDirectory, foundationExplorer];
