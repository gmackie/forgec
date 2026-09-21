import { z } from "zod";
import { Problem } from "./model.js";
export const deploymentAction = z
  .object({
    action: z.enum(["deploy", "rollback", "restart", "stop"]),
    release: z.string().min(1).max(200).optional(),
    config: z
      .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000))
      .refine((v) => Object.keys(v).length <= 100)
      .optional(),
    requestId: z.string().min(8).max(100),
    expectedDeployment: z.string().max(200).nullable(),
  })
  .strict();
export type DeploymentAction = z.infer<typeof deploymentAction>;
export interface DeploymentTarget {
  id: string;
  name: string;
  kind: "docker" | "cloudflare";
  endpoint: string;
  token: string;
  runtimeId?: string;
  appId?: string;
  environmentId?: string;
}
export interface Release {
  id: string;
  name: string;
  artifact: string;
  createdAt: string;
  commit?: string;
}
export interface DeploymentRun {
  id: string;
  release: string;
  action: string;
  status: "queued" | "running" | "healthy" | "failed" | "stopped";
  createdAt: string;
  finishedAt?: string;
  logs: string[];
  error?: string;
  config?: Record<string, string>;
}
export interface DeploymentStatus {
  releases: Release[];
  deployments: DeploymentRun[];
  activeDeployment: string | null;
}
export class DeploymentConnection {
  readonly public: Omit<DeploymentTarget, "token" | "endpoint">;
  constructor(
    private readonly target: DeploymentTarget,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(target.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("Invalid controller endpoint");
    const { token, endpoint, ...rest } = target;
    this.public = rest;
  }
  private async request(path: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(
        this.target.endpoint.replace(/\/$/, "") + path,
        {
          method: body ? "POST" : "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
          headers: {
            authorization: `Bearer ${this.target.token}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    } catch {
      throw new Problem(
        502,
        "Deployment controller is unavailable. Refresh to reconcile the request before retrying.",
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new Problem(
        502,
        "Deployment controller redirects are not allowed.",
      );
    const text = await response.text();
    if (text.length > 2_000_000)
      throw new Problem(502, "Controller response is too large.");
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Problem(502, "Controller returned invalid JSON.");
    }
    if (!response.ok)
      throw new Problem(
        response.status === 409 ? 409 : 502,
        typeof data.error === "string"
          ? data.error
          : "Deployment controller rejected this request.",
      );
    return data;
  }
  async inspect(): Promise<DeploymentStatus> {
    const data = await this.request("");
    if (!Array.isArray(data.releases) || !Array.isArray(data.deployments))
      throw new Problem(502, "Controller returned invalid deployment status.");
    return data;
  }
  async action(action: DeploymentAction): Promise<DeploymentRun> {
    return this.request("/actions", deploymentAction.parse(action));
  }
}
export function deploymentConnections(
  config: { DEPLOYMENT_TARGETS_JSON?: string },
  fetcher: typeof fetch = fetch,
) {
  const values = JSON.parse(config.DEPLOYMENT_TARGETS_JSON || "[]");
  if (!Array.isArray(values))
    throw Error("DEPLOYMENT_TARGETS_JSON must be an array");
  const seen = new Set();
  return values.map((v: any) => {
    if (
      !/^[a-z0-9-]+$/.test(v.id) ||
      typeof v.name !== "string" ||
      typeof v.token !== "string" ||
      !v.token ||
      !["docker", "cloudflare"].includes(v.kind) ||
      seen.has(v.id)
    )
      throw Error("Invalid deployment target");
    seen.add(v.id);
    return new DeploymentConnection(v, fetcher);
  });
}
