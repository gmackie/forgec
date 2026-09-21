import React, { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Badge } from "@cloudflare/kumo/components/badge";
import {
  ArrowClockwiseIcon,
  PlayIcon,
  RocketLaunchIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import type { RuntimeCatalog, RuntimeTarget } from "../src/runtime-control.js";
import type {
  DeploymentTarget,
  DeploymentStatus,
  DeploymentAction,
  DeploymentRun,
} from "../src/deployment-control.js";
import "./operations.css";
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const choices = (values: { id: string; name: string }[]) =>
  Object.fromEntries(values.map((v) => [v.id, v.name]));
function ErrorNote({ error }: { error: string }) {
  return error ? (
    <p className="ops-error" role="alert">
      {error}
    </p>
  ) : null;
}
export function FunctionPlayground({
  api,
  initialTarget,
}: {
  api: Api;
  initialTarget?: string | undefined;
}) {
  const [targets, setTargets] = useState<Omit<RuntimeTarget, "token">[]>([]),
    [target, setTarget] = useState(initialTarget || ""),
    [catalog, setCatalog] = useState<RuntimeCatalog | null>(null),
    [operation, setOperation] = useState("");
  const [input, setInput] = useState("{}"),
    [purpose, setPurpose] = useState(""),
    [key, setKey] = useState(""),
    [result, setResult] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [history, setHistory] = useState<any[]>([]);
  const epoch = useRef(0);
  useEffect(() => {
    let alive = true;
    api<{ targets: Omit<RuntimeTarget, "token">[] }>("/runtime/targets")
      .then((r) => {
        if (alive) {
          setTargets(r.targets);
          setTarget((t) => t || r.targets[0]?.id || "");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      epoch.current++;
    };
  }, [api]);
  async function load() {
    if (!target) return;
    const ticket = ++epoch.current;
    setLoading(true);
    setError("");
    setCatalog(null);
    setResult(null);
    try {
      const next = await api<RuntimeCatalog>(
        `/runtime/targets/${target}/catalog`,
      );
      if (ticket !== epoch.current) return;
      setCatalog(next);
      const op = next.operations[0];
      setOperation(op?.id || "");
      setInput(JSON.stringify(op?.sample ?? {}, null, 2));
    } catch (e) {
      if (ticket === epoch.current) setError((e as Error).message);
    } finally {
      if (ticket === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
    };
  }, [target]);
  const selected = catalog?.operations.find((o) => o.id === operation);
  async function invoke() {
    if (!catalog || !selected) return;
    setBusy(true);
    setError("");
    const ticket = epoch.current;
    try {
      const payload = JSON.parse(input);
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw Error("Enter a JSON object as the function input.");
      const reply = await api<any>(
        `/runtime/targets/${target}/invoke`,
        "POST",
        {
          operationId: operation,
          input: payload,
          buildHash: catalog.buildHash,
          ...(catalog.deploymentRevision
            ? { deploymentRevision: catalog.deploymentRevision }
            : {}),
          ...(purpose ? { purpose } : {}),
          ...(key ? { idempotencyKey: key } : {}),
        },
      );
      if (ticket !== epoch.current) return;
      setResult(reply);
      setHistory((h) => [{ ...reply, operation, name: selected.summary }, ...h].slice(0, 10));
    } catch (e) {
      if (ticket === epoch.current) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ops-workspace">
      <header className="heading">
        <div>
          <p className="eyebrow">LIVE RUNTIME</p>
          <h1>Function playground</h1>
          <p className="muted">
            Explore a running contract, prepare an input, and inspect what comes
            back.
          </p>
        </div>
        <TerminalIcon size={34} />
      </header>
      <div className="ops-toolbar">
        <Select
          aria-label="Runtime environment"
          value={target}
          items={choices(targets)}
          placeholder="Choose environment"
          disabled={busy}
          onValueChange={(v) => setTarget(String(v))}
        />
        <Button
          icon={<ArrowClockwiseIcon />}
          disabled={!target || busy || loading}
          onClick={() => void load()}
        >
          Reload contract
        </Button>
      </div>
      <ErrorNote error={error} />
      {!targets.length && !error && (
        <section className="panel ops-empty">
          <h2>Connect a running app</h2>
          <p>
            Configure a runtime connection on this instance to discover
            functions. Credentials stay on the server.
          </p>
        </section>
      )}
      {loading && <p role="status">Discovering runtime contracts…</p>}
      {catalog && (
        <>
          <div className="ops-build">
            <span className="ops-status status-healthy">Connected</span>
            <code>Build {catalog.buildHash.slice(0, 16)}</code>
            <small>
              Observed {new Date(catalog.observedAt).toLocaleString()}
            </small>
          </div>
          {!catalog.operations.length ? (
            <section className="panel ops-empty">
              <h2>No HTTP functions</h2>
              <p>This build does not expose any callable functions.</p>
            </section>
          ) : (
            <div className="playground-grid">
              <aside className="ops-functions">
                {catalog.operations.map((o) => (
                  <button
                    key={o.id}
                    className={o.id === operation ? "selected" : ""}
                    disabled={busy}
                    onClick={() => {
                      setOperation(o.id);
                      setInput(JSON.stringify(o.sample ?? {}, null, 2));
                      setResult(null);
                      setError("");
                    }}
                  >
                    <span>{o.summary}</span>
                    <small>
                      {o.method} {o.path}
                    </small>
                  </button>
                ))}
              </aside>
              <div className="playground-main">
                <section className="panel">
                  <header className="ops-section">
                    <div>
                      <span className="eyebrow">REQUEST</span>
                      <h2>{selected?.summary}</h2>
                    </div>
                    <Badge variant="outline">{selected?.method}</Badge>
                  </header>
                  <code className="ops-route">{selected?.path}</code>
                  <div className="ops-section">
                    <label htmlFor="sample-input">Input JSON</label>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        setInput(
                          JSON.stringify(selected?.sample ?? {}, null, 2),
                        )
                      }
                    >
                      Generate sample
                    </Button>
                  </div>
                  <Textarea
                    id="sample-input"
                    aria-label="Sample input"
                    value={input}
                    disabled={busy}
                    onChange={(e) => setInput(e.target.value)}
                    className="ops-json"
                  />
                  <div className="ops-input-row">
                    <Input
                      label="Purpose"
                      placeholder="Use function's declared purpose"
                      value={purpose}
                      disabled={busy}
                      onChange={(e) => setPurpose(e.target.value)}
                    />
                    <Input
                      label="Idempotency key"
                      placeholder="Optional request key"
                      value={key}
                      disabled={busy}
                      onChange={(e) => setKey(e.target.value)}
                    />
                  </div>
                  {selected?.disabledReason && (
                    <ErrorNote error={selected.disabledReason} />
                  )}
                  <p className="ops-call-note">
                    This invokes the running app and can change its data.
                    Generated values are examples; replace references with real
                    record IDs.
                  </p>
                  <Button
                    variant="primary"
                    icon={<PlayIcon />}
                    loading={busy}
                    disabled={!!selected?.disabledReason}
                    onClick={() => void invoke()}
                  >
                    Invoke function
                  </Button>
                </section>
                <section className="panel">
                  <header className="ops-section">
                    <div>
                      <span className="eyebrow">RESPONSE</span>
                      <h2>
                        {result
                          ? result.outcome.kind === "ok"
                            ? "Completed"
                            : "Function returned an error"
                          : "Ready when you are"}
                      </h2>
                    </div>
                    {result && (
                      <Badge variant="outline">
                        {result.status} · {result.durationMs} ms
                      </Badge>
                    )}
                  </header>
                  <pre className="ops-result" aria-label="Invocation response">
                    {result
                      ? JSON.stringify(result.outcome, null, 2)
                      : "Send an input to see the response here."}
                  </pre>
                </section>
              </div>
            </div>
          )}
          {history.length > 0 && (
            <section className="panel">
              <h2>Recent invocations</h2>
              <p className="muted small">
                This session only. Inputs and responses are not written to the
                activity log.
              </p>
              {history.map((h, i) => (
                <button
                  className="ops-history-row"
                  key={i}
                  onClick={() => setResult(h)}
                >
                  <strong>{h.name}</strong>
                  <span>{h.status}</span>
                  <span>{h.durationMs} ms</span>
                  <time>{new Date(h.at).toLocaleTimeString()}</time>
                </button>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
export function DeploymentWorkspace({
  api,
  onTest,
}: {
  api: Api;
  onTest: (id?: string) => void;
}) {
  const [targets, setTargets] = useState<
      Omit<DeploymentTarget, "token" | "endpoint">[]
    >([]),
    [target, setTarget] = useState(""),
    [status, setStatus] = useState<DeploymentStatus | null>(null),
    [release, setRelease] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<DeploymentAction["action"] | null>(null),
    [selectedRun, setSelectedRun] = useState<string | null>(null),
    [configText, setConfigText] = useState("{}");
  const epoch = useRef(0),
    requestId = useRef(""),
    reviewed = useRef<{
      expected: string | null;
      release: string;
      name: string;
      artifact: string;
      environment: string;
      config: Record<string, string>;
    }>({
      expected: null,
      release: "",
      name: "",
      artifact: "",
      environment: "",
      config: {},
    });
  useEffect(() => {
    let alive = true;
    api<{ targets: typeof targets }>("/deployments/targets")
      .then((r) => {
        if (alive) setTargets(r.targets);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      epoch.current++;
    };
  }, [api]);
  async function load(quiet = false) {
    if (!target) return;
    const ticket = epoch.current;
    if (!quiet) setLoading(true);
    try {
      const data = await api<DeploymentStatus>(
        `/deployments/targets/${target}`,
      );
      if (ticket !== epoch.current) return;
      setStatus(data);
      setRelease((r) => r || data.releases[0]?.id || "");
      if (!quiet)
        setConfigText(
          JSON.stringify(
            data.deployments.find((d) => d.id === data.activeDeployment)
              ?.config || {},
            null,
            2,
          ),
        );
      if (!quiet) setError("");
    } catch (e) {
      if (ticket === epoch.current && !quiet) setError((e as Error).message);
    } finally {
      if (ticket === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    epoch.current++;
    setStatus(null);
    setRelease("");
    setSelectedRun(null);
    void load();
    const timer = setInterval(() => void load(true), 5000);
    return () => {
      clearInterval(timer);
      epoch.current++;
    };
  }, [target]);
  const configured = targets.find((t) => t.id === target),
    active = status?.deployments.find((d) => d.id === status.activeDeployment),
    chosen = status?.releases.find((r) => r.id === release),
    logRun =
      status?.deployments.find((d) => d.id === selectedRun) ||
      status?.deployments[0];
  const progressing = status?.deployments.some((d) =>
    ["queued", "running"].includes(d.status),
  );
  function review(action: DeploymentAction["action"]) {
    try {
      const config = JSON.parse(configText);
      if (
        !config ||
        Array.isArray(config) ||
        typeof config !== "object" ||
        Object.values(config).some((v) => typeof v !== "string")
      )
        throw Error("Configuration must be a JSON object with string values.");
      const selectedRelease = status?.releases.find(
        (r) =>
          r.id ===
          (["deploy", "rollback"].includes(action) ? release : active?.release),
      );
      reviewed.current = {
        expected: status?.activeDeployment || null,
        release,
        name: selectedRelease?.name || "",
        artifact: selectedRelease?.artifact || "",
        environment: configured?.name || "",
        config:
          action === "deploy"
            ? config
            : action === "rollback"
              ? status?.deployments.find(
                  (d) =>
                    d.release === release &&
                    ["healthy", "stopped"].includes(d.status),
                )?.config || {}
              : active?.config || {},
      };
      requestId.current = crypto.randomUUID();
      setConfirm(action);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function execute() {
    if (!confirm || !status) return;
    setBusy(true);
    try {
      const run = await api<DeploymentRun>(
        `/deployments/targets/${target}/actions`,
        "POST",
        {
          action: confirm,
          ...(["deploy", "rollback"].includes(confirm)
            ? { release: reviewed.current.release }
            : {}),
          ...(confirm === "deploy" ? { config: reviewed.current.config } : {}),
          requestId: requestId.current,
          expectedDeployment: reviewed.current.expected,
        },
      );
      setSelectedRun(run.id);
      setConfirm(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ops-workspace">
      <header className="heading">
        <div>
          <p className="eyebrow">RELEASE OPERATIONS</p>
          <h1>Deployments</h1>
          <p className="muted">
            Roll out a release, watch its progress, and return to a known
            version.
          </p>
        </div>
        <RocketLaunchIcon size={34} />
      </header>
      <ErrorNote error={confirm ? "" : error} />
      <div className="deployment-targets">
        {targets.map((t) => (
          <button
            className={`deployment-target ${t.id === target ? "selected" : ""}`}
            key={t.id}
            aria-label={t.name}
            disabled={busy}
            onClick={() => setTarget(t.id)}
          >
            <RocketLaunchIcon />
            <strong>{t.name}</strong>
            <span>{t.kind === "docker" ? "Docker" : "Cloudflare Workers"}</span>
          </button>
        ))}
      </div>
      {!targets.length && !error && (
        <section className="panel ops-empty">
          <h2>Add a deployment connection</h2>
          <p>
            Connect a deployment controller to manage releases from this
            console. Each registry uses its own infrastructure and credentials.
          </p>
        </section>
      )}
      {!target && targets.length > 0 && (
        <section className="panel ops-empty">
          <h2>Choose an environment</h2>
          <p>Inspect its active release and deployment history.</p>
        </section>
      )}
      {target && (
        <>
          <div className="ops-toolbar">
            <h2>{configured?.name}</h2>
            <Button
              disabled={loading || busy}
              icon={<ArrowClockwiseIcon />}
              onClick={() => void load()}
            >
              Refresh status
            </Button>
            {configured?.runtimeId && (
              <Button onClick={() => onTest(configured.runtimeId)}>
                Test functions
              </Button>
            )}
          </div>
          {loading && !status && <p role="status">Loading deployment state…</p>}
          {status && (
            <>
              <section className="deployment-overview">
                <div>
                  <p className="eyebrow">CURRENT RELEASE</p>
                  <h2>
                    {status.releases.find((r) => r.id === active?.release)
                      ?.name || "Not deployed"}
                  </h2>
                  <span
                    className={`ops-status status-${active?.status || "stopped"}`}
                  >
                    {active?.status || "stopped"}
                  </span>
                  <p className="muted small">
                    Status at the last deployment action.
                  </p>
                </div>
                <div>
                  <p className="eyebrow">NEXT RELEASE</p>
                  <Select
                    aria-label="Release to deploy"
                    value={release}
                    placeholder="Choose a release"
                    items={choices(status.releases)}
                    onValueChange={(v) => setRelease(String(v))}
                  />
                  {chosen && <code>{chosen.artifact}</code>}
                </div>
                <div className="deployment-config">
                  <label htmlFor="deployment-config">
                    Environment configuration
                  </label>
                  <Textarea
                    id="deployment-config"
                    aria-label="Deployment configuration"
                    value={configText}
                    onChange={(e) => setConfigText(e.target.value)}
                  />
                  <p className="muted small">
                    JSON string values applied with the next deployment. Secret
                    bindings stay on the controller.
                  </p>
                </div>
                <div className="deployment-actions">
                  <Button
                    variant="primary"
                    disabled={!release || !!progressing}
                    onClick={() => review("deploy")}
                  >
                    Deploy release
                  </Button>
                  <Button
                    disabled={
                      !active ||
                      !release ||
                      active.release === release ||
                      !!progressing
                    }
                    onClick={() => review("rollback")}
                  >
                    Roll back
                  </Button>
                  <Button
                    disabled={!active || !!progressing}
                    onClick={() => review("restart")}
                  >
                    Restart
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      !active || active.status === "stopped" || !!progressing
                    }
                    onClick={() => review("stop")}
                  >
                    Stop app
                  </Button>
                </div>
              </section>
              <div className="deployment-detail-grid">
                <section className="panel">
                  <header className="ops-section">
                    <h2>Deployment history</h2>
                    <Badge variant="outline">{status.deployments.length}</Badge>
                  </header>
                  {!status.deployments.length ? (
                    <p className="muted">
                      Your first deployment will appear here.
                    </p>
                  ) : (
                    status.deployments.map((d) => (
                      <button
                        className={`deployment-run ${logRun?.id === d.id ? "selected" : ""}`}
                        key={d.id}
                        onClick={() => setSelectedRun(d.id)}
                      >
                        <span className={`ops-status status-${d.status}`}>
                          {d.status}
                        </span>
                        <strong>
                          {d.action} ·{" "}
                          {status.releases.find((r) => r.id === d.release)
                            ?.name || d.release}
                        </strong>
                        <small>{new Date(d.createdAt).toLocaleString()}</small>
                      </button>
                    ))
                  )}
                </section>
                <section className="panel">
                  <header className="ops-section">
                    <h2>Deployment log</h2>
                    {logRun && <code>{logRun.id.slice(0, 8)}</code>}
                  </header>
                  <pre className="ops-log">
                    {logRun
                      ? logRun.logs.join("\n") +
                        (logRun.error ? "\n" + logRun.error : "")
                      : "Choose a deployment to inspect its log."}
                  </pre>
                </section>
              </div>
            </>
          )}
        </>
      )}
      {confirm && (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open && !busy) setConfirm(null);
          }}
        >
          <Dialog className="editor">
            <Dialog.Title>
              {confirm === "stop"
                ? "Stop this app?"
                : confirm === "rollback"
                  ? "Roll back this environment?"
                  : "Review deployment"}
            </Dialog.Title>
            <Dialog.Description>
              {reviewed.current.environment} · {reviewed.current.name}
            </Dialog.Description>
            <p className="ops-call-note">
              {confirm === "stop"
                ? "The app will stop accepting requests. Retained data and release history remain available."
                : confirm === "rollback"
                  ? "Runs a previous release. Database migrations are not reversed."
                  : "The controller will run this action and report its actual progress. Existing data is retained."}
            </p>
            <code className="ops-route">{reviewed.current.artifact}</code>
            <h3>Configuration snapshot</h3>
            <pre className="ops-result">
              {JSON.stringify(reviewed.current.config, null, 2)}
            </pre>
            <ErrorNote error={error} />
            <footer className="dialog-footer">
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void execute()}
              >
                {confirm === "deploy"
                  ? "Start deployment"
                  : confirm === "rollback"
                    ? "Confirm rollback"
                    : confirm === "restart"
                      ? "Restart app"
                      : "Confirm stop"}
              </Button>
            </footer>
          </Dialog>
        </Dialog.Root>
      )}
    </div>
  );
}
