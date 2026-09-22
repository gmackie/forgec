import type { GizmoDefinition } from "@forgegraph/react";
import { customerDirectory } from "./customer-directory.js";

/** Application-owned, bundled components; deployment metadata never supplies executable code. */
export const gizmos: readonly GizmoDefinition[] = [customerDirectory];
