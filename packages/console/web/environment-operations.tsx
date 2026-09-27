import React, { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { App, Environment } from "../src/model.js";
import type {
  DeploymentTarget,
  DeploymentStatus,
} from "../src/deployment-control.js";
type Api = <T>(path: string) => Promise<T>;
type Target = Omit<DeploymentTarget, "token" | "endpoint">;
const providers = {
  cloudflare: "Cloudflare Workers",
  docker: "Docker / Node",
  aws: "AWS",
  other: "Other",
};
export function EnvironmentOperations({
  app,
  api,
  onConfigure,
  onRemove,
  onManage,
  onTest,
}: {
  app: App;
  api: Api;
  onConfigure: (environment: Environment) => void;
  onRemove: (environment: Environment) => void;
  onManage: (target: string) => void;
  onTest: (runtime: string) => void;
}) {
  const [connections, setConnections] = useState<Target[] | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setConnections(null);
    setError("");
    api<{ targets: Target[] }>("/deployments/targets")
      .then((r) => {
        if (alive) setConnections(r.targets);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [api, app.id, refresh]);
  return (
    <>
      <div className="section-toolbar">
        <p className="muted small">
          Connections use the app and environment identifiers configured on this
          instance.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh deployments
        </Button>
      </div>
      {error && <p role="alert">Deployment connections unavailable: {error}</p>}
      <div className="environment-grid">
        {app.environments.map((environment) => {
          const matches =
            connections?.filter(
              (t) => t.appId === app.id && t.environmentId === environment.id,
            ) || [];
          return (
            <EnvironmentCard
              key={environment.id + ":" + refresh}
              app={app}
              environment={environment}
              matches={matches}
              loading={!connections && !error}
              unavailable={!!error}
              api={api}
              onConfigure={onConfigure}
              onRemove={onRemove}
              onManage={onManage}
              onTest={onTest}
            />
          );
        })}
      </div>
    </>
  );
}
function EnvironmentCard({
  app,
  environment: e,
  matches,
  loading,
  unavailable,
  api,
  onConfigure,
  onRemove,
  onManage,
  onTest,
}: {
  app: App;
  environment: Environment;
  matches: Target[];
  loading: boolean;
  unavailable: boolean;
  api: Api;
  onConfigure: (e: Environment) => void;
  onRemove: (e: Environment) => void;
  onManage: (id: string) => void;
  onTest: (id: string) => void;
}) {
  const target = matches.length === 1 ? matches[0] : undefined;
  const [status, setStatus] = useState<DeploymentStatus | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError("");
    if (target)
      api<DeploymentStatus>(
        "/deployments/targets/" + encodeURIComponent(target.id),
      )
        .then((r) => {
          if (alive) setStatus(r);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [api, target?.id]);
  const active = status?.deployments.find(
      (d) => d.id === status.activeDeployment,
    ),
    release = status?.releases.find((r) => r.id === active?.release);
  const keys = new Set([
    ...Object.keys(e.config),
    ...Object.keys(active?.config || {}),
  ]);
  const differences = active?.config
    ? Array.from(keys).filter((k) => e.config[k] !== active.config?.[k]).length
    : null;
  return (
    <section className="panel environment" aria-label={e.name}>
      <div className="section-toolbar">
        <h3>{e.name}</h3>
        <Badge variant="secondary">{providers[e.target]}</Badge>
      </div>
      {e.endpoint && (
        <a
          href={e.endpoint}
          target="_blank"
          rel="noreferrer"
          className="endpoint"
        >
          {e.endpoint}
        </a>
      )}
      <div className="environment-meta">
        <span>{Object.keys(e.config).length} configuration values</span>
        <span>{Object.keys(e.secretRefs).length} secret references</span>
      </div>
      <p className="muted small">
        {e.packageDigest
          ? `Package ${e.packageDigest.slice(0, 22)}…`
          : "No package pinned"}
      </p>
      {loading ? (
        <p role="status">Loading deployment connection…</p>
      ) : matches.length > 1 ? (
        <p role="alert">Multiple deployment connections</p>
      ) : !target ? (
        <Badge variant="outline">
          {unavailable
            ? "Deployment status unavailable"
            : "Deployment unverified"}
        </Badge>
      ) : (
        <div className="environment-deployment">
          <p className="muted small">{target.name}</p>
          {error ? (
            <p role="alert">{error}</p>
          ) : !status ? (
            <p role="status">Loading deployment status…</p>
          ) : (
            <>
              <strong>{release?.name || "No active release"}</strong>
              <p>
                <Badge variant="outline">
                  {active?.status || "Not deployed"}
                </Badge>
              </p>
              {active && (
                <p className="muted small">
                  Last deployment action ·{" "}
                  {new Date(active.createdAt).toLocaleString()}
                </p>
              )}
              {differences !== null && (
                <p className="muted small">
                  {differences
                    ? `${differences} configuration ${differences === 1 ? "value differs" : "values differ"}`
                    : "Configuration matches the deployment snapshot"}
                </p>
              )}
              {release &&
                e.packageDigest &&
                e.packageDigest !== release.artifact && (
                  <p className="muted small">
                    Deployed artifact differs from the pinned package
                  </p>
                )}
            </>
          )}
          <p className="muted small">
            Inventory edits take effect only through a reviewed deployment.
          </p>
        </div>
      )}
      <div className="card-footer">
        {target && (
          <>
            <Button onClick={() => onManage(target.id)}>
              Manage deployment
            </Button>
            {target.runtimeId && (
              <Button
                disabled={!active || active.status !== "healthy"}
                onClick={() => onTest(target.runtimeId!)}
              >
                Test functions
              </Button>
            )}
          </>
        )}
        <Button disabled={app.archived} onClick={() => onConfigure(e)}>
          Configure
        </Button>
        <Button
          disabled={app.archived}
          variant="ghost"
          onClick={() => onRemove(e)}
        >
          Remove
        </Button>
      </div>
    </section>
  );
}
