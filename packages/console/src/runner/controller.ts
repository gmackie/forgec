import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../model.js";
import {
  deploymentAction,
  type DeploymentAction,
  type DeploymentRun,
  type DeploymentStatus,
  type Release,
} from "../deployment-control.js";
export interface RunnerRelease extends Release {
  image: string;
}
export interface RunnerTarget {
  id: string;
  name: string;
  releases: RunnerRelease[];
  port?: number;
  environment?: Record<string, string>;
  network?: string;
  healthPath?: string;
}
export interface Instance {
  url: string;
  handle: string;
  healthPath?: string;
}
export interface Provider {
  deploy(
    release: RunnerRelease,
    id: string,
    target: RunnerTarget,
  ): Promise<Instance>;
  stop(instance: Instance): Promise<void>;
  restart(instance: Instance): Promise<void>;
}
interface StoredRun extends DeploymentRun {
  requestId: string;
  fingerprint: string;
  instance?: Instance;
}
interface TargetState {
  activeDeployment: string | null;
  deployments: StoredRun[];
}
export class DeploymentController {
  private pending = new Set<Promise<void>>();
  constructor(
    private readonly db: DatabaseSync,
    readonly targets: RunnerTarget[],
    private readonly provider: Provider,
  ) {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS deployment_targets(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    );
    for (const t of targets) {
      db.prepare("INSERT OR IGNORE INTO deployment_targets VALUES (?,?)").run(
        t.id,
        JSON.stringify({ activeDeployment: null, deployments: [] }),
      );
      const state = this.read(t.id);
      let changed = false;
      for (const run of state.deployments)
        if (["running", "queued"].includes(run.status)) {
          run.status = "failed";
          run.error =
            "Controller restarted before this action completed. Inspect the runtime before retrying.";
          changed = true;
        }
      if (changed) this.save(t.id, state);
    }
  }
  private target(id: string) {
    const target = this.targets.find((t) => t.id === id);
    if (!target) throw new Problem(404, "Unknown deployment target.");
    return target;
  }
  private read(id: string): TargetState {
    const row = this.db
      .prepare("SELECT data FROM deployment_targets WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Problem(404, "Unknown deployment target.");
    return JSON.parse(row.data);
  }
  private save(id: string, state: TargetState) {
    this.db
      .prepare("UPDATE deployment_targets SET data=? WHERE id=?")
      .run(JSON.stringify(state), id);
  }
  inspect(id: string): DeploymentStatus {
    const target = this.target(id),
      state = this.read(id);
    return {
      releases: target.releases.map(({ image, ...release }) => release),
      activeDeployment: state.activeDeployment,
      deployments: state.deployments.map(
        ({ instance, requestId, fingerprint, ...run }) => run,
      ),
    };
  }
  retainedInstance(id: string): Instance | null {
    const state = this.read(id);
    return (
      state.deployments.find((d) => d.id === state.activeDeployment)
        ?.instance || null
    );
  }
  runtime(id: string): Instance | null {
    const state = this.read(id),
      run = state.deployments.find((d) => d.id === state.activeDeployment);
    return run?.status === "healthy" ? run.instance || null : null;
  }
  action(id: string, input: DeploymentAction): DeploymentRun {
    const action = deploymentAction.parse(input);
    const target = this.target(id);
    const state = this.read(id);
    const fingerprint = JSON.stringify(action);
    const existing = state.deployments.find(
      (r) => r.requestId === action.requestId,
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Problem(
          409,
          "Request ID was already used for a different action.",
        );
      return this.inspect(id).deployments.find((r) => r.id === existing.id)!;
    }
    if (state.deployments.some((r) => ["queued", "running"].includes(r.status)))
      throw new Problem(409, "A deployment is already in progress.");
    if (state.activeDeployment !== action.expectedDeployment)
      throw new Problem(
        409,
        "Deployment changed. Refresh before starting this action.",
      );
    const previous = state.deployments.find(
      (d) => d.id === state.activeDeployment,
    );
    if (["stop", "restart"].includes(action.action) && action.release)
      throw new Problem(400, "A restart or stop cannot select a release.");
    const release = target.releases.find(
      (r) => r.id === (action.release || previous?.release),
    );
    if (!release) throw new Problem(400, "Choose a configured release.");
    if (["stop", "restart"].includes(action.action) && !previous?.instance)
      throw new Problem(409, "There is no active deployment.");
    if (
      action.action === "rollback" &&
      !state.deployments.some((r) => r.release === release.id && r.instance)
    )
      throw new Problem(
        400,
        "Rollback requires a previously deployed release.",
      );
    if (
      action.config &&
      Object.keys(action.config).some((k) => k in (target.environment || {}))
    )
      throw new Problem(
        400,
        "Configuration cannot replace protected runner bindings.",
      );
    if (action.action !== "deploy" && action.config)
      throw new Problem(400, "Configuration changes require a new deployment.");
    if (state.deployments.length >= 1000)
      throw new Problem(
        409,
        "Deployment history reached its limit. Archive it before adding more releases.",
      );
    const rollbackConfig =
      action.action === "rollback"
        ? state.deployments.find((r) => r.release === release.id && r.instance)
            ?.config
        : undefined;
    const run: StoredRun = {
      config: Object.fromEntries(
        Object.entries(
          action.config ?? rollbackConfig ?? previous?.config ?? {},
        ).filter(([key]) => !(key in (target.environment || {}))),
      ),
      id: crypto.randomUUID(),
      requestId: action.requestId,
      fingerprint,
      release: release.id,
      action: action.action,
      status: "queued",
      createdAt: new Date().toISOString(),
      logs: ["Request accepted."],
    };
    state.deployments.unshift(run);
    this.save(id, state);
    const work = this.execute(target, run.id, release, previous).finally(() =>
      this.pending.delete(work),
    );
    this.pending.add(work);
    return this.inspect(id).deployments.find((r) => r.id === run.id)!;
  }
  private async execute(
    target: RunnerTarget,
    id: string,
    release: RunnerRelease,
    previous: StoredRun | undefined,
  ) {
    const update = (fn: (run: StoredRun, state: TargetState) => void) => {
      const state = this.read(target.id);
      const run = state.deployments.find((r) => r.id === id)!;
      fn(run, state);
      this.save(target.id, state);
    };
    const current = this.read(target.id).deployments.find((r) => r.id === id)!;
    update((r) => {
      r.status = "running";
      r.logs.push(`Starting ${r.action} for ${release.name}.`);
    });
    try {
      if (current.action === "stop") {
        await this.provider.stop(previous!.instance!);
        update((r, state) => {
          r.status = "stopped";
          r.instance = previous!.instance!;
          state.activeDeployment = r.id;
          r.logs.push("App stopped. Data and release history retained.");
        });
      } else if (current.action === "restart") {
        await this.provider.restart(previous!.instance!);
        update((r, state) => {
          r.status = "healthy";
          r.instance = previous!.instance!;
          state.activeDeployment = r.id;
          r.logs.push("Runtime restarted and healthy.");
        });
      } else {
        const instance = await this.provider.deploy(release, id, {
          ...target,
          environment: { ...current.config, ...target.environment },
        });
        update((r, state) => {
          r.status = "healthy";
          r.instance = instance;
          state.activeDeployment = r.id;
          r.logs.push(
            "Candidate passed its health check. Traffic now points to this release.",
          );
        });
        if (
          previous?.instance &&
          previous.instance.handle !== instance.handle
        ) {
          try {
            await this.provider.stop(previous.instance);
            update((r) =>
              r.logs.push(
                "Previous runtime stopped; release retained for rollback.",
              ),
            );
          } catch {
            update((r) =>
              r.logs.push("Previous runtime cleanup needs operator attention."),
            );
          }
        }
      }
    } catch (e) {
      update((r) => {
        r.status = "failed";
        r.error = e instanceof Error ? e.message : "Deployment failed.";
        r.logs.push(
          "Action failed. The active release pointer was not changed.",
        );
      });
    } finally {
      update((r) => {
        r.finishedAt = new Date().toISOString();
      });
    }
  }
  async idle() {
    await Promise.all([...this.pending]);
  }
}
