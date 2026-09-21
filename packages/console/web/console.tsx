import React, {
  lazy,
  Suspense,
  useEffect,
  useState,
  useRef,
  type ReactNode,
  type FormEvent,
} from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Table } from "@cloudflare/kumo/components/table";
import { Select } from "@cloudflare/kumo/components/select";
import {
  SquaresFourIcon,
  PackageIcon,
  GearSixIcon,
  ClockCounterClockwiseIcon,
  PlusIcon,
  ArrowLeftIcon,
  ArrowClockwiseIcon,
  SignOutIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  ArrowUpRightIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import type { App, Environment, ViewState } from "../src/model.js";
import type { PackageSummary } from "../src/oci.js";
import { PackageGovernance } from "./governance.js";

type Api = <T>(
  path: string,
  method?: string,
  body?: unknown,
  revision?: number,
) => Promise<T>;
const ForgeEditor = lazy(() => import("./editor/editor.js").then(m => ({ default: m.ForgeEditor })));

type Page = "Editor" | "Apps" | "Registry" | "Activity" | "Settings";
const pages = [
  { name: "Editor", icon: SquaresFourIcon },
  { name: "Apps", icon: SquaresFourIcon },
  { name: "Registry", icon: PackageIcon },
  { name: "Activity", icon: ClockCounterClockwiseIcon },
  { name: "Settings", icon: GearSixIcon },
] as const;
function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div role="alert">
      <Banner variant="error" title={error} />
    </div>
  ) : null;
}
function Blank({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="blank">
      <CubeIcon size={38} weight="light" />
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </section>
  );
}
function Heading({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{children}</p>
      </div>
      <div className="actions">{action}</div>
    </header>
  );
}
function Modal({
  title,
  description,
  children,
  close,
  submit,
  label,
}: {
  title: string;
  description: string;
  children: ReactNode;
  close: () => void;
  submit: () => Promise<void>;
  label: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await submit();
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Dialog size="lg" className="editor">
        <Dialog.Title className="dialog-title">{title}</Dialog.Title>
        <Dialog.Description className="muted">{description}</Dialog.Description>
        <form onSubmit={save}>
          <fieldset disabled={busy} className="form-fields">
            {children}
          </fieldset>
          <ErrorMessage error={error} />
          <footer className="dialog-footer">
            <Button type="button" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {label}
            </Button>
          </footer>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
function AppEditor({
  app,
  revision,
  api,
  saved,
  close,
}: {
  app?: App;
  revision: number;
  api: Api;
  saved: (v: ViewState) => void;
  close: () => void;
}) {
  const [name, setName] = useState(app?.name || ""),
    [description, setDescription] = useState(app?.description || "");
  return (
    <Modal
      title={app ? "Edit app" : "Register an app"}
      description="Keep your application and its environments in one place."
      close={close}
      label="Save app"
      submit={async () =>
        saved(
          await api<ViewState>(
            app ? `/apps/${app.id}` : "/apps",
            app ? "PATCH" : "POST",
            { name, description, ...(app ? { archived: app.archived } : {}) },
            revision,
          ),
        )
      }
    >
      <Input
        label="App name"
        required
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Commerce"
      />
      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={2000}
        placeholder="What does this application do?"
      />
    </Modal>
  );
}
const targets = {
  cloudflare: "Cloudflare Workers",
  docker: "Docker / Node",
  aws: "AWS",
  other: "Other",
};
function parseMap(text: string, label: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be a JSON object.`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== "string")
  )
    throw new Error(`${label} must contain string values.`);
  return value as Record<string, string>;
}
function EnvironmentEditor({
  app,
  environment,
  revision,
  api,
  saved,
  close,
}: {
  app: App;
  environment?: Environment;
  revision: number;
  api: Api;
  saved: (v: ViewState) => void;
  close: () => void;
}) {
  const [name, setName] = useState(environment?.name || ""),
    [target, setTarget] = useState<Environment["target"]>(
      environment?.target || "cloudflare",
    );
  const [endpoint, setEndpoint] = useState(environment?.endpoint || ""),
    [digest, setDigest] = useState(environment?.packageDigest || "");
  const [config, setConfig] = useState(
      JSON.stringify(environment?.config || {}, null, 2),
    ),
    [secrets, setSecrets] = useState(
      JSON.stringify(environment?.secretRefs || {}, null, 2),
    );
  return (
    <Modal
      title={environment ? "Configure environment" : "Add environment"}
      description={`${app.name} · Saving records configuration; it does not deploy or change a running app.`}
      close={close}
      label="Save environment"
      submit={async () =>
        saved(
          await api<ViewState>(
            `/apps/${app.id}/environments${environment ? "/" + environment.id : ""}`,
            environment ? "PUT" : "POST",
            {
              name,
              target,
              endpoint,
              packageDigest: digest,
              config: parseMap(config, "Configuration"),
              secretRefs: parseMap(secrets, "Secret references"),
            },
            revision,
          ),
        )
      }
    >
      <div className="two-columns">
        <Input
          label="Environment name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="production"
        />
        <Select
          label="Target"
          value={target}
          onValueChange={(v) => setTarget(v as Environment["target"])}
          items={targets}
        />
      </div>
      <Input
        label="Endpoint"
        required
        type="url"
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        placeholder="https://app.example.com"
      />
      <Input
        label="OCI package digest"
        value={digest}
        onChange={(e) => setDigest(e.target.value)}
        placeholder="sha256:… (optional)"
        description="Pin a verified package from this instance’s registry."
      />
      <Textarea
        className="code-input"
        label="Configuration (JSON)"
        value={config}
        onChange={(e) => setConfig(e.target.value)}
        rows={4}
        description="Non-secret values, with uppercase keys and string values."
      />
      <Textarea
        className="code-input"
        label="Secret references (JSON)"
        value={secrets}
        onChange={(e) => setSecrets(e.target.value)}
        rows={3}
        description={
          'References only, e.g. {"API_KEY":"worker:API_KEY"}. Do not enter secret values.'
        }
      />
    </Modal>
  );
}
function PublishEditor({
  api,
  close,
  saved,
}: {
  api: Api;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [version, setVersion] = useState(""),
    [owner, setOwner] = useState(""),
    [commit, setCommit] = useState(""),
    [file, setFile] = useState<File | null>(null);
  return (
    <Modal
      title="Publish a package"
      description="Upload a compiled app.json bundle. Forge signs the package and publishes its artifacts and metadata to your OCI registry."
      close={close}
      label="Publish package"
      submit={async () => {
        if (!file) throw new Error("Choose a compiled app.json bundle.");
        if (file.size > 3_500_000)
          throw new Error("Bundle must be smaller than 3.5 MB.");
        let bundle: unknown;
        try {
          bundle = JSON.parse(await file.text());
        } catch {
          throw new Error("The bundle is not valid JSON.");
        }
        await api("/packages", "POST", {
          name,
          version,
          owner,
          commit,
          bundle,
        });
        await saved();
      }}
    >
      <Input
        label="Package name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="@acme/commerce"
      />
      <div className="two-columns">
        <Input
          label="Version"
          required
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="1.0.0"
        />
        <Input
          label="Owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="Commerce team"
        />
      </div>
      <Input
        label="Source revision"
        value={commit}
        onChange={(e) => setCommit(e.target.value)}
        placeholder="Commit hash"
      />
      <Input
        label="Compiled bundle"
        type="file"
        accept="application/json,.json"
        required
        onChange={(e) => setFile(e.target.files?.[0] || null)}
      />
      <Banner
        variant="secondary"
        description="Review the bundle before publishing. Environment secrets and implementation code do not belong in a package."
      />
    </Modal>
  );
}
function Confirm({
  title,
  children,
  close,
  submit,
  label,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  submit: () => Promise<void>;
  label: string;
}) {
  return (
    <Modal
      title={title}
      description="This changes the management inventory only."
      close={close}
      submit={submit}
      label={label}
    >
      <p>{children}</p>
    </Modal>
  );
}

export function Console({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const [token, setToken] = useState(""),
    [state, setState] = useState<ViewState | null>(null),
    [page, setPage] = useState<Page>("Editor");
  const [selectedApp, setSelectedApp] = useState<string | null>(null),
    [selectedPackage, setSelectedPackage] = useState<PackageSummary | null>(
      null,
    );
  const [packages, setPackages] = useState<PackageSummary[]>([]),
    [registryLoaded, setRegistryLoaded] = useState(false),
    [registryError, setRegistryError] = useState("");
  const [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  type DialogState = {
    kind: "app" | "environment" | "publish" | "archive" | "remove";
    app?: App;
    environment?: Environment;
    revision: number;
  };
  const [dialog, setDialogState] = useState<DialogState | null>(null);
  const session = useRef(0);
  const setDialog = (next: Omit<DialogState, "revision"> | null) =>
    setDialogState(next ? { ...next, revision: state?.revision ?? 0 } : null);
  const api: Api = async (path, method = "GET", body, revision) => {
    const epoch = session.current;
    const response = await fetcher(`/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(revision !== undefined ? { "if-match": String(revision) } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json()) as { error?: string };
    if (epoch !== session.current) throw new Error("Session ended.");
    if (!response.ok)
      throw new Error(data.error || `Request failed (${response.status})`);
    return data as never;
  };
  async function refresh() {
    const epoch = session.current;
    setBusy(true);
    setError("");
    try {
      const next = await api<ViewState>("/state");
      if (epoch === session.current) setState(next);
    } catch (e) {
      if (epoch === session.current) setError((e as Error).message);
    } finally {
      if (epoch === session.current) setBusy(false);
    }
  }
  async function loadRegistry() {
    const epoch = session.current;
    setRegistryLoaded(false);
    setRegistryError("");
    try {
      const result = await api<{ packages: PackageSummary[] }>("/packages");
      if (epoch === session.current) setPackages(result.packages);
    } catch (e) {
      if (epoch === session.current) setRegistryError((e as Error).message);
    } finally {
      if (epoch === session.current) setRegistryLoaded(true);
    }
  }
  useEffect(() => {
    if (page === "Registry" && state) void loadRegistry();
  }, [page, state?.instance.authority]);
  function navigate(next: Page) {
    setPage(next);
    setSearch("");
    setSelectedApp(null);
    setSelectedPackage(null);
    setError("");
    setNotice("");
  }
  function saved(next: ViewState) {
    setState(next);
    setNotice("Changes saved.");
  }
  const app = state?.apps.find((a) => a.id === selectedApp);
  const close = () => setDialog(null);
  if (!state)
    return (
      <main className="login-page">
        <div className="login-brand">
          <span className="brand-mark">F</span>
          <strong>forge</strong>
          <Badge variant="outline">Console</Badge>
        </div>
        <section className="login-card">
          <p className="eyebrow">YOUR APPS. YOUR INFRASTRUCTURE.</p>
          <h1>
            A workspace
            <br />
            under your control.
          </h1>
          <p className="muted">
            Manage applications, configure environments, and explore your
            registry.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void refresh();
            }}
          >
            <Input
              label="Administrator token"
              type="password"
              required
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              description="Use the token configured by this instance’s operator."
            />
            <ErrorMessage error={error} />
            <Button variant="primary" type="submit" loading={busy}>
              Connect to instance
            </Button>
          </form>
          <div className="login-note">
            <ShieldCheckIcon size={18} />
            <span>
              Your token stays in this browser tab. No central account required.
            </span>
          </div>
        </section>
        <p className="login-footer">
          Forge management console · Independently hosted
        </p>
      </main>
    );
  const filteredApps = state.apps.filter((a) =>
    `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  const visiblePackages = packages.filter((p) =>
    `${p.entry.name} ${p.entry.version} ${p.entry.owner || ""} ${p.entry.exports.map((e) => e.name).join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">F</span>
          <strong>forge</strong>
          <Badge variant="outline">Console</Badge>
        </div>
        <div className="instance-name">
          <span className="instance-dot" />
          <span>{state.instance.name}</span>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {pages.map(({ name, icon: Icon }) => (
            <Button
              key={name}
              variant="ghost"
              className={`nav-item ${page === name ? "active" : ""}`}
              aria-current={page === name ? "page" : undefined}
              icon={<Icon size={19} />}
              onClick={() => navigate(name)}
            >
              {name}
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="independent">
            <ShieldCheckIcon size={18} />
            <div>
              <strong>Independent instance</strong>
              <small>Your registry, your rules.</small>
            </div>
          </div>
          <Button
            variant="ghost"
            icon={<SignOutIcon />}
            onClick={() => {
              session.current++;
              setBusy(false);
              setState(null);
              setToken("");
              setPackages([]);
              setDialog(null);
              setSelectedApp(null);
              setSelectedPackage(null);
              setPage("Apps");
              setSearch("");
              setNotice("");
              setError("");
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> {page}
            {app ? (
              <>
                <span className="slash">/</span>
                {app.name}
              </>
            ) : null}
          </span>
          <div className="actions">
            <Badge variant="secondary">{state.instance.runtime}</Badge>
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowClockwiseIcon />}
              loading={busy}
              onClick={() => {
                void refresh();
                if (page === "Registry") void loadRegistry();
              }}
            >
              Refresh
            </Button>
          </div>
        </header>
        <main className="content">
          {page === "Editor" ? <Suspense fallback={<p>Loading Forge Studio…</p>}><ForgeEditor token={token} /></Suspense> : null}
          <ErrorMessage error={error} />
          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}
          {page === "Apps" && !app ? (
            <>
              <Heading
                eyebrow="APPLICATION MANAGEMENT"
                title="Apps"
                action={
                  <Button
                    variant="primary"
                    icon={<PlusIcon />}
                    onClick={() => setDialog({ kind: "app" })}
                  >
                    Register app
                  </Button>
                }
              >
                Your applications and the environments they run in.
              </Heading>
              <div className="stats">
                <div>
                  <span>Registered apps</span>
                  <strong>
                    {state.apps.filter((a) => !a.archived).length}
                  </strong>
                </div>
                <div>
                  <span>Environments</span>
                  <strong>
                    {state.apps
                      .filter((a) => !a.archived)
                      .reduce((n, a) => n + a.environments.length, 0)}
                  </strong>
                </div>
                <div>
                  <span>Registry storage</span>
                  <strong className="stat-text">
                    {state.instance.registry ? "OCI" : "Not connected"}
                  </strong>
                </div>
              </div>
              <div className="section-toolbar">
                <Input
                  aria-label="Search apps"
                  placeholder="Search apps…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span className="muted">
                  {filteredApps.length} applications
                </span>
              </div>
              {!filteredApps.length ? (
                <Blank
                  title={
                    search ? "No matching apps" : "Make room for your first app"
                  }
                  action={
                    !search ? (
                      <Button
                        onClick={() => setDialog({ kind: "app" })}
                        icon={<PlusIcon />}
                      >
                        Add an application
                      </Button>
                    ) : undefined
                  }
                >
                  {search
                    ? "Try a different name or description."
                    : "Register an application, then add its environments and configuration."}
                </Blank>
              ) : (
                <div className="panel table-scroll">
                  <Table>
                    <Table.Header>
                      <Table.Row>
                        <Table.Head>Application</Table.Head>
                        <Table.Head>Environments</Table.Head>
                        <Table.Head>Status</Table.Head>
                        <Table.Head>Updated</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {filteredApps.map((a) => (
                        <Table.Row key={a.id}>
                          <Table.Cell>
                            <div className="app-cell">
                              <span className="app-icon">
                                <CubeIcon size={23} />
                              </span>
                              <div>
                                <Button
                                  variant="ghost"
                                  className="table-link"
                                  onClick={() => setSelectedApp(a.id)}
                                >
                                  {a.name}
                                </Button>
                                <p className="muted small">
                                  {a.description || "No description"}
                                </p>
                              </div>
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="badges">
                              {a.environments.length ? (
                                a.environments.map((e) => (
                                  <Badge key={e.id} variant="secondary">
                                    {e.name}
                                  </Badge>
                                ))
                              ) : (
                                <span className="muted">None configured</span>
                              )}
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <Badge
                              variant={a.archived ? "secondary" : "outline"}
                            >
                              {a.archived ? "Archived" : "Registered"}
                            </Badge>
                          </Table.Cell>
                          <Table.Cell className="muted">
                            {new Date(a.updatedAt).toLocaleDateString()}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              )}
              <p className="footnote">
                App registrations describe your inventory. Deployment and health
                are verified separately.
              </p>
            </>
          ) : null}
          {page === "Apps" && app ? (
            <>
              <Button
                variant="ghost"
                icon={<ArrowLeftIcon />}
                onClick={() => setSelectedApp(null)}
              >
                All apps
              </Button>
              <Heading
                eyebrow="APPLICATION"
                title={app.name}
                action={
                  <>
                    <Button onClick={() => setDialog({ kind: "app", app })}>
                      Edit app
                    </Button>
                    <Button onClick={() => setDialog({ kind: "archive", app })}>
                      {app.archived ? "Restore app" : "Archive app"}
                    </Button>
                  </>
                }
              >
                {app.description || "No description yet."}
              </Heading>
              {app.archived ? (
                <Banner
                  variant="secondary"
                  title="This app is archived"
                  description="Restore it to edit environments. Running deployments are unaffected."
                />
              ) : null}
              <div className="section-toolbar">
                <h2>
                  Environments{" "}
                  <span className="count">{app.environments.length}</span>
                </h2>
                <Button
                  disabled={app.archived}
                  icon={<PlusIcon />}
                  onClick={() => setDialog({ kind: "environment", app })}
                >
                  Add environment
                </Button>
              </div>
              {!app.environments.length ? (
                <Blank title="An app, ready for its environments">
                  Add production, staging, or a local environment to organize
                  endpoints and configuration.
                </Blank>
              ) : (
                <div className="environment-grid">
                  {app.environments.map((e) => (
                    <section className="panel environment" key={e.id}>
                      <div className="section-toolbar">
                        <h3>{e.name}</h3>
                        <Badge variant="secondary">{targets[e.target]}</Badge>
                      </div>
                      <a
                        href={e.endpoint}
                        target="_blank"
                        rel="noreferrer"
                        className="endpoint"
                      >
                        {e.endpoint}
                        <ArrowUpRightIcon />
                      </a>
                      <div className="environment-meta">
                        <span>
                          {Object.keys(e.config).length} configuration values
                        </span>
                        <span>
                          {Object.keys(e.secretRefs).length} secret references
                        </span>
                      </div>
                      <p className="muted small">
                        {e.packageDigest
                          ? `Package ${e.packageDigest.slice(0, 22)}…`
                          : "No package pinned"}
                      </p>
                      <Badge variant="outline">Deployment unverified</Badge>
                      <div className="card-footer">
                        <Button
                          disabled={app.archived}
                          onClick={() =>
                            setDialog({
                              kind: "environment",
                              app,
                              environment: e,
                            })
                          }
                        >
                          Configure
                        </Button>
                        <Button
                          disabled={app.archived}
                          variant="ghost"
                          onClick={() =>
                            setDialog({ kind: "remove", app, environment: e })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </>
          ) : null}
          {page === "Registry" && !selectedPackage ? (
            <>
              <Heading
                eyebrow="PACKAGE REGISTRY"
                title="Registry"
                action={
                  <Button
                    variant="primary"
                    disabled={!state.instance.registry}
                    icon={<PlusIcon />}
                    onClick={() => setDialog({ kind: "publish" })}
                  >
                    Publish package
                  </Button>
                }
              >
                Versioned contracts and artifacts, stored in your OCI registry.
              </Heading>
              {state.instance.registry ? (
                <div className="registry-connection">
                  <PackageIcon size={21} />
                  <code>
                    {state.instance.registry.url}/
                    {state.instance.registry.repository}
                  </code>
                  <Badge variant="outline">OCI Distribution</Badge>
                </div>
              ) : (
                <Banner
                  variant="alert"
                  title="Connect an OCI registry"
                  description="Set OCI_URL, OCI_REPOSITORY and your signing key on the server. Connection details are in the deployment guide."
                />
              )}
              <div className="section-toolbar">
                <Input
                  aria-label="Search packages"
                  placeholder="Search packages, owners, or exports…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span className="muted">{visiblePackages.length} versions</span>
              </div>
              <ErrorMessage error={registryError} />
              {!registryLoaded ? (
                <p role="status" className="loading">
                  Reading and verifying registry artifacts…
                </p>
              ) : registryError ? (
                <Button onClick={() => void loadRegistry()}>
                  Retry registry
                </Button>
              ) : !visiblePackages.length ? (
                <Blank
                  title={
                    search
                      ? "No matching packages"
                      : "Your contracts belong here"
                  }
                >
                  {search
                    ? "Try a package name, an owner, or an exported resource."
                    : "Publish a compiled Forge package to browse its resources, actions, dependencies, and signed metadata."}
                </Blank>
              ) : (
                <div className="panel table-scroll">
                  <Table>
                    <Table.Header>
                      <Table.Row>
                        <Table.Head>Package</Table.Head>
                        <Table.Head>Version</Table.Head>
                        <Table.Head>Exports</Table.Head>
                        <Table.Head>Owner</Table.Head>
                        <Table.Head>Integrity</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {visiblePackages.map((p) => (
                        <Table.Row key={p.ociDigest}>
                          <Table.Cell>
                            <Button
                              className="table-link"
                              variant="ghost"
                              onClick={() => setSelectedPackage(p)}
                            >
                              {p.entry.name}
                            </Button>
                          </Table.Cell>
                          <Table.Cell>
                            <code>{p.entry.version}</code>
                          </Table.Cell>
                          <Table.Cell>{p.entry.exports.length}</Table.Cell>
                          <Table.Cell>{p.entry.owner || "—"}</Table.Cell>
                          <Table.Cell>
                            <Badge variant="success">Signature verified</Badge>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              )}
            </>
          ) : null}
          {page === "Registry" && selectedPackage ? (
            <>
              <Button
                variant="ghost"
                icon={<ArrowLeftIcon />}
                onClick={() => setSelectedPackage(null)}
              >
                All packages
              </Button>
              <Heading
                eyebrow="PACKAGE CONTRACT"
                title={selectedPackage.entry.name}
                action={
                  <Button
                    onClick={async () => {
                      try {
                        const result = await api<{
                          pulled: { bundle: unknown };
                        }>(`/packages/${selectedPackage.ociDigest}`);
                        const url = URL.createObjectURL(
                          new Blob(
                            [JSON.stringify(result.pulled.bundle, null, 2)],
                            { type: "application/json" },
                          ),
                        );
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "app.json";
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Download bundle
                  </Button>
                }
              >
                Version {selectedPackage.entry.version} ·{" "}
                {selectedPackage.entry.owner || "No owner specified"}
              </Heading>
              <section className="panel detail-panel">
                <Badge variant="success">Signature verified</Badge>
                <dl>
                  <dt>Authority</dt>
                  <dd>{selectedPackage.entry.authority}</dd>
                  <dt>OCI manifest digest</dt>
                  <dd>
                    <code>{selectedPackage.ociDigest}</code>
                  </dd>
                  <dt>Signed Forge digest</dt>
                  <dd>
                    <code>{selectedPackage.entry.digest}</code>
                  </dd>
                </dl>
                <p className="muted small">
                  Pin the OCI manifest digest in an environment. Signature
                  verification proves artifact integrity, not a live deployment.
                </p>
              </section>
              <section className="panel detail-panel">
                <h2>
                  Exports{" "}
                  <span className="count">
                    {selectedPackage.entry.exports.length}
                  </span>
                </h2>
                <div className="export-list">
                  {selectedPackage.entry.exports.map((e) => (
                    <div key={`${e.kind}:${e.id}`}>
                      <Badge variant="secondary">{e.kind}</Badge>
                      <code>{e.name}</code>
                    </div>
                  ))}
                </div>
              </section>
              <PackageGovernance governance={selectedPackage.governance} />
              <div className="two-columns">
                <section className="panel detail-panel">
                  <h2>Dependencies</h2>
                  {selectedPackage.entry.dependencies.length ? (
                    selectedPackage.entry.dependencies.map((d) => (
                      <p key={d}>
                        <code>{d}</code>
                      </p>
                    ))
                  ) : (
                    <p className="muted">No declared dependencies.</p>
                  )}
                </section>
                <section className="panel detail-panel">
                  <h2>Contract metadata</h2>
                  <p>
                    {selectedPackage.entry.actions.length} actions ·{" "}
                    {selectedPackage.entry.fields.length} fields ·{" "}
                    {selectedPackage.entry.effects.length} function effects
                  </p>
                  <details>
                    <summary>Inspect actions, fields and effects</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          actions: selectedPackage.entry.actions,
                          fields: selectedPackage.entry.fields,
                          effects: selectedPackage.entry.effects,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </section>
              </div>
            </>
          ) : null}
          {page === "Activity" ? (
            <>
              <Heading eyebrow="ADMINISTRATION" title="Activity">
                Recent app and environment changes on this instance.
              </Heading>
              {state.audit.length ? (
                <div className="panel activity-list">
                  {state.audit.map((a) => (
                    <div className="activity-row" key={a.id}>
                      <span className="activity-icon">
                        <ClockCounterClockwiseIcon size={19} />
                      </span>
                      <div>
                        <strong>{a.action}</strong>
                        <p className="muted">{a.subject}</p>
                      </div>
                      <time dateTime={a.at}>
                        {new Date(a.at).toLocaleString()}
                      </time>
                    </div>
                  ))}
                </div>
              ) : (
                <Blank title="A clean slate">
                  App and environment changes will appear here as you work.
                </Blank>
              )}
              <p className="footnote">
                The most recent 200 configuration events are retained. Package
                provenance lives with each signed artifact in OCI.
              </p>
            </>
          ) : null}
          {page === "Settings" ? (
            <>
              <Heading eyebrow="INSTANCE" title="Settings">
                This workspace is configured and operated independently.
              </Heading>
              <section className="panel detail-panel">
                <h2>Instance identity</h2>
                <dl>
                  <dt>Display name</dt>
                  <dd>{state.instance.name}</dd>
                  <dt>Registry authority</dt>
                  <dd>{state.instance.authority}</dd>
                  <dt>Hosting runtime</dt>
                  <dd>{state.instance.runtime}</dd>
                  <dt>OCI endpoint</dt>
                  <dd>{state.instance.registry?.url || "Not configured"}</dd>
                  <dt>OCI repository</dt>
                  <dd>
                    {state.instance.registry?.repository || "Not configured"}
                  </dd>
                </dl>
                <p className="muted">
                  Change identity and registry connection settings through the
                  server’s environment configuration.
                </p>
              </section>
              <div className="two-columns">
                <section className="panel detail-panel">
                  <ShieldCheckIcon size={24} />
                  <h2>Local authority</h2>
                  <p>
                    Authentication and package signing belong to this instance.
                    There is no central sign-in, telemetry, or required upstream
                    registry.
                  </p>
                </section>
                <section className="panel detail-panel">
                  <PackageIcon size={24} />
                  <h2>Portable storage</h2>
                  <p>
                    Artifacts and published metadata live in OCI. App
                    configuration is stored separately in{" "}
                    {state.instance.runtime.includes("Cloudflare")
                      ? "D1"
                      : "SQLite"}
                    . Keep backups of both, along with your signing key.
                  </p>
                </section>
              </div>
            </>
          ) : null}
        </main>
        <footer className="workspace-footer">
          <span>Forge console</span>
          <span>Powered by Cloudflare Kumo · React · Effect</span>
        </footer>
      </div>
      {dialog?.kind === "app" ? (
        <AppEditor
          {...(dialog.app ? { app: dialog.app } : {})}
          revision={dialog.revision}
          api={api}
          saved={saved}
          close={close}
        />
      ) : null}
      {dialog?.kind === "environment" && dialog.app ? (
        <EnvironmentEditor
          app={dialog.app}
          {...(dialog.environment ? { environment: dialog.environment } : {})}
          revision={dialog.revision}
          api={api}
          saved={saved}
          close={close}
        />
      ) : null}
      {dialog?.kind === "publish" ? (
        <PublishEditor api={api} close={close} saved={loadRegistry} />
      ) : null}
      {dialog?.kind === "archive" && dialog.app ? (
        <Confirm
          title={dialog.app.archived ? "Restore app?" : "Archive app?"}
          close={close}
          label={dialog.app.archived ? "Restore app" : "Archive app"}
          submit={async () => {
            const a = dialog.app!;
            saved(
              await api<ViewState>(
                `/apps/${a.id}`,
                "PATCH",
                {
                  name: a.name,
                  description: a.description,
                  archived: !a.archived,
                },
                dialog.revision,
              ),
            );
          }}
        >
          All saved environments are retained. This does not stop or start
          infrastructure.
        </Confirm>
      ) : null}
      {dialog?.kind === "remove" && dialog.app && dialog.environment ? (
        <Confirm
          title={`Remove ${dialog.environment.name}?`}
          close={close}
          label="Remove environment"
          submit={async () =>
            saved(
              await api<ViewState>(
                `/apps/${dialog.app!.id}/environments/${dialog.environment!.id}`,
                "DELETE",
                undefined,
                dialog.revision,
              ),
            )
          }
        >
          This removes the endpoint, configuration values and secret references
          from the inventory. The running application is unaffected.
        </Confirm>
      ) : null}
    </div>
  );
}
