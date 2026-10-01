import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import type { Analysis, Project } from "./language.js";
import { VisualDocument, Edit } from "./document.js";
import { Relationships } from "./graph.js";
import {
  appDeclarations,
  categories,
  declarationSummary,
  type Category,
} from "./app-model.js";
import {
  ResourceWorkspace,
  FunctionWorkspace,
  SourceWorkspace,
  DataCatalog,
} from "./workspace.js";
import { named } from "./model.js";
import { ReadDocument } from "./read-document.js";
import { patch } from "./model.js";
import type { GitProject, GitSnapshot } from "../../src/git.js";
import { example } from "./example.js";
import "./editor.css";
import { RepositoryWorkspace } from "./reviews.js";
import { SourceEditor } from "./source-editor.js";
import type { StudioApi } from "../records.js";
import { children, textOf } from "./model.js";
const Records = lazy(() =>
  import("../records.js").then((m) => ({ default: m.RecordWorkspaceView })),
);
const businessLabels: Partial<Record<Category, string>> = {
  Resources: "Data",
  Functions: "Actions",
  Sources: "Schedules",
  Purposes: "Data access",
  Shapes: "Forms",
  Types: "Field types",
  Events: "Events",
  "Data classes": "Data classifications",
};
/**
 * How long to wait for the compiler before treating silence as a fault.
 *
 * Analysis is single-digit milliseconds — the seven-file demo takes about 4 ms warm, and 200k
 * characters still measures near 1 ms — so this is not a budget for large sources. It is how
 * long to wait before concluding the worker is not going to answer at all.
 */
const COMPILE_TIMEOUT_MS = 4000;
const storageKey = "forge.visual-editor.v1";
function initial(): Project {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    const p = stored?.project ?? stored;
    if (
      p &&
      typeof p.name === "string" &&
      Array.isArray(p.files) &&
      p.files.length &&
      p.files.length <= 50 &&
      p.files.every(
        (f: any) => typeof f.path === "string" && typeof f.text === "string",
      ) &&
      p.files.some((f: any) => f.path === p.currentFile)
    )
      return p;
  } catch {}
  return structuredClone(example);
}
export function ForgeEditor({
  token = "",
  api,
}: {
  token?: string;
  api?: StudioApi;
}) {
  const [mode, setMode] = useState<"Design" | "Use" | "Developer">("Design");
  const [used, setUsed] = useState(false);
  const developer = mode === "Developer";
  const label = (c: Category) => (developer ? c : businessLabels[c] || c);
  const [editing, setEditing] = useState(false);
  const [repositories, setRepositories] = useState<GitProject[]>([]);
  const [repository, setRepository] = useState<GitSnapshot | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      return saved?.repository?.revision &&
        Array.isArray(saved.repository.files)
        ? saved.repository
        : null;
    } catch {
      return null;
    }
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const [repoId, setRepoId] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [notice, setNotice] = useState("");
  async function gitApi(path: string, body?: unknown) {
    const response = await fetch(`/api/git/projects${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Git request failed");
    return data;
  }
  useEffect(() => {
    let live = true;
    void gitApi("")
      .then((data) => {
        if (live) {
          setRepositories(data.projects);
          setRepoId(data.projects[0]?.id || "");
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [token]);
  const [category, setCategory] = useState<Category>("Resources");
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<{
    past: Project[];
    present: Project;
    future: Project[];
  }>(() => ({ past: [], present: initial(), future: [] }));
  const [showDemo, setShowDemo] = useState(false);
  const project = history.present;
  const file = project.files.find((f) => f.path === project.currentFile)!;
  const [view, setView] = useState<"visual" | "split" | "source" | "graph">(
    "visual",
  );
  const [analysis, setAnalysis] = useState<{
    result: Analysis;
    id: number;
    text: string;
    path: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [workerEpoch, setWorkerEpoch] = useState(0);
  const [newKind, setNewKind] = useState("resource"),
    [newName, setNewName] = useState("");
  const worker = useRef<Worker | null>(null),
    seq = useRef(0),
    // Whether the compiler has already been restarted once for the current trouble, so a
    // worker that dies repeatedly is reported rather than restarted forever.
    restarted = useRef(false),
    fileInput = useRef<HTMLInputElement>(null);
  const current = useRef(project);
  current.current = project;
  const requestSources = useRef(
    new Map<number, { text: string; path: string }>(),
  );
  const ready = analysis?.text === file.text && analysis?.path === file.path;
  const commit = (next: Project) =>
    setHistory((h) =>
      JSON.stringify(next) === JSON.stringify(h.present)
        ? h
        : {
            past: [...h.past.slice(-39), h.present],
            present: next,
            future: [],
          },
    );
  const update = (text: string) =>
    commit({
      ...project,
      files: project.files.map((f) =>
        f.path === file.path ? { ...f, text } : f,
      ),
    });
  const undo = () =>
    setHistory((h) =>
      h.past.length
        ? {
            past: h.past.slice(0, -1),
            present: h.past.at(-1)!,
            future: [h.present, ...h.future],
          }
        : h,
    );
  const redo = () =>
    setHistory((h) =>
      h.future.length
        ? {
            past: [...h.past, h.present],
            present: h.future[0]!,
            future: h.future.slice(1),
          }
        : h,
    );
  useEffect(() => {
    const w = new Worker(new URL("./compiler.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    w.onmessage = (e) => {
      if (e.data.id !== seq.current) return;
      const requested = requestSources.current.get(e.data.id);
      requestSources.current.clear();
      if (e.data.error || e.data.analysis?.error) {
        setError(e.data.error || e.data.analysis.error);
        return;
      }
      if (requested) {
        setAnalysis({ result: e.data.analysis, id: e.data.id, ...requested });
        setError("");
        restarted.current = false;
      }
    };
    w.onerror = () =>
      setError(
        "The compiler worker stopped. Your source is preserved. Restart the compiler to continue.",
      );
    return () => {
      w.terminate();
      worker.current = null;
    };
  }, [workerEpoch]);
  useEffect(() => {
    const id = ++seq.current;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      const w = worker.current;
      // Without a worker there is nothing to wait for. Recording the request anyway is what
      // made a missing compiler report itself as a time limit ten seconds later.
      if (!w) {
        setError(
          "The compiler is not running. Restart it to continue; your draft is preserved.",
        );
        return;
      }
      requestSources.current.clear();
      requestSources.current.set(id, { text: file.text, path: file.path });
      w.postMessage({ id, project });
      // Timed from the request, not from the keystroke that scheduled it. Analysis of this
      // project takes single-digit milliseconds, so seconds of silence means the compiler has
      // stopped answering rather than that it needs longer.
      watchdog = setTimeout(() => {
        if (!requestSources.current.has(id)) return;
        requestSources.current.clear();
        w.terminate();
        if (worker.current === w) worker.current = null;
        // Restart once on its own. A worker that dies should cost a redraw, not leave the
        // editor inert until someone notices a button.
        if (!restarted.current) {
          restarted.current = true;
          setWorkerEpoch((n) => n + 1);
          return;
        }
        setError(
          "The compiler stopped responding twice. Your draft is preserved; restart the compiler to continue.",
        );
      }, COMPILE_TIMEOUT_MS);
    }, 160);
    return () => {
      clearTimeout(timer);
      if (watchdog !== undefined) clearTimeout(watchdog);
    };
  }, [project, workerEpoch]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ project, repository }));
      setSaved("Draft saved in this browser");
    } catch {
      setSaved(
        "Browser storage unavailable — download your files to keep them",
      );
    }
  }, [project, repository]);
  const download = (path: string, text: string) => {
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = path.split("/").at(-1)!;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  async function importFiles(files: FileList | null) {
    if (!files) return;
    const draft = Array.from(files).find((f) => f.name.endsWith(".json"));
    if (draft) {
      if (files.length !== 1 || draft.size > 1000000)
        throw Error("Open a single exported draft of at most 1 MB.");
      const p = JSON.parse(await draft.text());
      if (
        !p ||
        typeof p.name !== "string" ||
        !Array.isArray(p.files) ||
        !p.files.length ||
        p.files.length > 50 ||
        !p.files.every(
          (f: any) =>
            typeof f.path === "string" &&
            f.path.endsWith(".forge") &&
            typeof f.text === "string",
        ) ||
        new Set(p.files.map((f: any) => f.path)).size !== p.files.length ||
        !p.files.some((f: any) => f.path === p.currentFile) ||
        p.files.reduce(
          (n: number, f: any) => n + new TextEncoder().encode(f.text).length,
          0,
        ) > 500000
      )
        throw Error("Invalid Forge draft.");
      setRepository(null);
      commit(p);
      return;
    }
    const chosen = Array.from(files).filter((f) => f.name.endsWith(".forge"));
    if (!chosen.length) {
      setError("Choose one or more .forge files.");
      return;
    }
    if (chosen.length > 50 || chosen.reduce((s, f) => s + f.size, 0) > 500000) {
      setError("Open up to 50 files and 500 KB of source.");
      return;
    }
    const opened = await Promise.all(
      chosen.map(async (f) => ({
        path: f.webkitRelativePath || f.name,
        text: await f.text(),
      })),
    );
    if (new Set(opened.map((f) => f.path)).size !== opened.length) {
      setError(
        "Selected files have duplicate paths. Give each file a unique name before opening them together.",
      );
      return;
    }
    setRepository(null);
    commit({ ...current.current, files: opened, currentFile: opened[0]!.path });
  }
  const changedFiles = repository
    ? [
        ...new Set([
          ...repository.files.map((f) => f.path),
          ...project.files.map((f) => f.path),
        ]),
      ]
        .map((path) => ({
          path,
          before: repository.files.find((f) => f.path === path)?.text,
          after: project.files.find((f) => f.path === path)?.text,
        }))
        .filter((f) => f.before !== f.after)
    : [];
  async function loadRepository(branch?: string) {
    setGitBusy(true);
    setError("");
    try {
      const snapshot: GitSnapshot = await gitApi(`/${branch && repository ? repository.id : repoId}${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`);
      if (!snapshot.files.length)
        throw Error("This source directory contains no Forge files.");
      const next = {
        name: snapshot.name,
        files: snapshot.files,
        currentFile: snapshot.files[0]!.path,
      };
      setHistory({ past: [], present: next, future: [] });
      setRepository(snapshot);
      setSelected("");
      setCategory("Resources");
      setEditing(false);
      setConnectOpen(false);
      setNotice("Loaded committed application model.");
    } catch (e) {
      setError(String(e));
    } finally {
      setGitBusy(false);
    }
  }
  async function createCommit() {
    if (!repository || !ready || !commitMessage.trim()) return;
    setGitBusy(true);
    setError("");
    try {
      const result = await gitApi(`/${repository.id}/commits${repository.branch !== repositories.find(r=>r.id===repository.id)?.branch ? `?branch=${encodeURIComponent(repository.branch)}` : ""}`, {
        base: repository.revision,
        message: commitMessage,
        files: project.files,
      });
      setRepository({
        ...repository,
        revision: result.revision,
        files: structuredClone(project.files),
      });
      setHistory((h) => ({ ...h, past: [], future: [] }));
      setReviewOpen(false);
      setCommitMessage("");
      setEditing(false);
      setNotice(
        `Committed ${result.revision.slice(0, 8)} to ${repository.branch}.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setGitBusy(false);
    }
  }
  const diagnostics = analysis?.result.diagnostics ?? [];
  const entries = analysis ? appDeclarations(project, analysis.result) : [];
  const visible = entries.filter(
    (e) =>
      e.category === category &&
      e.name.toLowerCase().includes(search.toLowerCase()),
  );
  const entry =
    entries.find((e) => e.id === selected && e.category === category) ??
    visible[0];
  const choose = (id: string) => {
    const e = entries.find((e) => e.id === id);
    if (!e) return;
    setSelected(id);
    setCategory(e.category);
    setHistory((h) => ({
      ...h,
      present: { ...h.present, currentFile: e.path },
    }));
    setView("visual");
  };
  useEffect(() => {
    if (entry && entry.path !== project.currentFile) {
      setHistory((h) => ({
        ...h,
        present: { ...h.present, currentFile: entry.path },
      }));
    }
  }, [entry?.path, project.currentFile]);
  const replaceEntry = (text: string) => {
    if (!ready || !editing || gitBusy || !entry) return;
    commit({
      ...project,
      files: project.files.map((f) =>
        f.path === entry.path ? { ...f, text } : f,
      ),
    });
  };
  return (
    <div className={`forge-editor app-studio studio-${mode.toLowerCase()}`}>
      <nav className="studio-modes" aria-label="Workspace view">
        {(["Design", "Use", "Developer"] as const).map((m) => (
          <Button
            key={m}
            aria-pressed={mode === m}
            variant={mode === m ? "primary" : "ghost"}
            onClick={() => {
              setMode(m);
              if (m === "Use") setUsed(true);
              if (m === "Design") setView("visual");
            }}
          >
            {m}
            <small>
              {m === "Design"
                ? "Shape your application"
                : m === "Use"
                  ? "Work with live records"
                  : "Routes, source & diagnostics"}
            </small>
          </Button>
        ))}
      </nav>
      {used && (
        <div hidden={mode !== "Use"}>
          <Suspense fallback={<p>Loading record workspace…</p>}>
            {api ? (
              <Records api={api} />
            ) : (
              <p>Connect to an instance to work with live records.</p>
            )}
          </Suspense>
        </div>
      )}
      <div hidden={mode === "Use"}>
        <div className="editor-title">
          <div>
            <p className="eyebrow">FORGE STUDIO · APPLICATION</p>
            <h1>{project.name}</h1>
            <p className="muted">
              {editing
                ? "Design draft · Changes are saved in this browser. Review them before saving to your application."
                : "Design your data, actions, and workflows. Use opens records from a deployed application."}
            </p>
          </div>
          <Badge variant="outline">
            {repository
              ? developer
                ? `${repository.branch} · ${repository.revision.slice(0, 8)}`
                : `${changedFiles.length ? "Draft changes" : "Saved design"} · Not deployed`
              : "Local demo / draft"}
          </Badge>
        </div>
        <div className="editor-toolbar">
          <Button
            disabled={gitBusy}
            variant={editing ? "secondary" : "primary"}
            onClick={() => {
              setEditing(!editing);
              setView("visual");
            }}
          >
            {editing ? "Read view" : "Edit draft"}
          </Button>
          {editing && (
            <>
              <Button
                aria-label="Undo edit"
                disabled={!history.past.length}
                onClick={undo}
              >
                Undo
              </Button>
              <Button
                aria-label="Redo edit"
                disabled={!history.future.length}
                onClick={redo}
              >
                Redo
              </Button>
            </>
          )}
          <Button disabled={gitBusy} onClick={() => setConnectOpen(true)}>
            {developer
              ? repository
                ? "Change repository"
                : "Connect Git"
              : repository
                ? "Change application"
                : "Open application"}
          </Button>
          {repository && (
            <Button
              variant="primary"
              disabled={gitBusy || !changedFiles.length}
              onClick={() => setReviewOpen(true)}
            >
              Review changes ({changedFiles.length})
            </Button>
          )}
          <span className="declaration-spacer" />
          <details className="studio-project-tools">
            <summary>{developer ? "Project tools" : "Draft options"}</summary>
            <div className="editor-row">
              <Button disabled={gitBusy} onClick={() => setShowDemo(true)}>
                Load demo
              </Button>
              <Button
                disabled={gitBusy || !!repository}
                onClick={() => fileInput.current?.click()}
              >
                Open .forge files
              </Button>
              <Button
                onClick={() =>
                  download("forge-draft.json", JSON.stringify(project, null, 2))
                }
              >
                Export draft
              </Button>
            </div>
          </details>
          <input
            ref={fileInput}
            type="file"
            accept=".forge,.json"
            multiple
            hidden
            onChange={(e) => {
              void importFiles(e.target.files).catch((e) =>
                setError(String(e)),
              );
              e.target.value = "";
            }}
          />
        </div>
        <Dialog.Root open={showDemo} onOpenChange={setShowDemo}>
          <Dialog className="editor">
            <Dialog.Title className="dialog-title">
              Load the service desk demo?
            </Dialog.Title>
            <Dialog.Description>
              This replaces your browser draft, disconnects Git, and clears undo
              history. Export your changes first to keep a copy.
            </Dialog.Description>
            <footer className="dialog-footer">
              <Button onClick={() => setShowDemo(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setRepository(null);
                  setHistory({
                    past: [],
                    present: structuredClone(example),
                    future: [],
                  });
                  setSelected("");
                  setCategory("Resources");
                  setShowDemo(false);
                  setEditing(false);
                }}
              >
                Replace draft with demo
              </Button>
            </footer>
          </Dialog>
        </Dialog.Root>
        <Dialog.Root
          open={connectOpen}
          onOpenChange={(open) => {
            if (!gitBusy) setConnectOpen(open);
          }}
        >
          <Dialog className="editor">
            <Dialog.Title className="dialog-title">
              {developer ? "Connect a Git application" : "Open an application"}
            </Dialog.Title>
            <Dialog.Description>
              Load a committed snapshot from an instance-configured repository.
              This replaces your browser draft and its undo history. Export any
              changes you want to keep first.
            </Dialog.Description>
            {repositories.length ? (
              <Select
                aria-label="Git application"
                value={repoId}
                items={Object.fromEntries(
                  repositories.map((r) => [
                    r.id,
                    `${r.name} · ${r.repository} / ${r.branch}`,
                  ]),
                )}
                onValueChange={(v) => setRepoId(String(v))}
              />
            ) : (
              <p className="muted">
                No applications are connected yet. Ask your administrator to
                connect your application repository.
              </p>
            )}
            <footer className="dialog-footer">
              <Button disabled={gitBusy} onClick={() => setConnectOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={gitBusy}
                disabled={!repoId}
                onClick={() => void loadRepository()}
              >
                {developer ? "Load repository" : "Open application"}
              </Button>
            </footer>
            {error && <p role="alert">{error}</p>}
          </Dialog>
        </Dialog.Root>
        <Dialog.Root
          open={reviewOpen}
          onOpenChange={(open) => {
            if (!gitBusy) setReviewOpen(open);
          }}
        >
          <Dialog className="editor" size="xl">
            <Dialog.Title className="dialog-title">Review changes</Dialog.Title>
            <Dialog.Description>
              {developer
                ? `Commit to ${repository?.repository} on ${repository?.branch}. Changes are checked against revision ${repository?.revision.slice(0, 8)}.`
                : "Save this design to your application. This does not deploy it or change live records. If someone has saved a newer design, your draft will be kept for review."}
            </Dialog.Description>
            <div className="commit-changes">
              {changedFiles.map((f) => (
                <details key={f.path} open>
                  <summary>
                    {f.path} ·{" "}
                    {f.before === undefined
                      ? "Added"
                      : f.after === undefined
                        ? "Deleted"
                        : "Modified"}
                  </summary>
                  <div className="commit-diff">
                    <div>
                      <h4>Committed</h4>
                      <pre>{f.before ?? "Not present"}</pre>
                    </div>
                    <div>
                      <h4>Draft</h4>
                      <pre>{f.after ?? "Deleted"}</pre>
                    </div>
                  </div>
                </details>
              ))}
            </div>
            <Textarea
              aria-label={developer ? "Commit message" : "Change description"}
              placeholder="Describe why you changed this application"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              disabled={gitBusy}
            />
            <p className="muted small">
              {diagnostics.filter((d) => d.severity === "error").length} issues
              to resolve before saving.
            </p>
            <footer className="dialog-footer">
              <Button disabled={gitBusy} onClick={() => setReviewOpen(false)}>
                Keep editing
              </Button>
              <Button
                variant="primary"
                loading={gitBusy}
                disabled={
                  !changedFiles.length ||
                  !commitMessage.trim() ||
                  !ready ||
                  diagnostics.some((d) => d.severity === "error")
                }
                onClick={() => void createCommit()}
              >
                {developer ? "Commit changes" : "Save design"}
              </Button>
            </footer>
            {error && <p role="alert">{error}</p>}
          </Dialog>
        </Dialog.Root>
        {notice && (
          <p role="status" className="studio-notice">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert">
            <Banner variant="error" title={error} />
            <Button
              onClick={() => {
                setError("");
                setWorkerEpoch((v) => v + 1);
              }}
            >
              Restart compiler
            </Button>
          </div>
        )}
        {repository && <details className="studio-repository-tools"><summary>Repository, branches & reviews</summary><RepositoryWorkspace key={repository.id + repository.branch + repository.revision} snapshot={repository} api={gitApi} dirty={changedFiles.length>0} onLoad={loadRepository}/></details>}
        {developer && (
          <details className="studio-routes">
            <summary>Declared API routes</summary>
            <p>
              Explicit function bindings in this draft. Generated resource
              routes and deployed routes may differ.
            </p>
            {entries.flatMap((e) =>
              children(e.node, "DECORATOR")
                .filter((n) => textOf(e.source, n).startsWith("@http("))
                .map((n) => (
                  <Button
                    key={`${e.id}:${n.start}`}
                    onClick={() => choose(e.id)}
                  >
                    <strong>{e.name}</strong>
                    <code>{textOf(e.source, n)}</code>
                  </Button>
                )),
            )}
          </details>
        )}
        <div
          className="app-kind-tabs"
          role="tablist"
          aria-label="Application declarations"
        >
          {categories
            .filter((c) =>
              [
                "Resources",
                "Functions",
                "Sources",
                "Data catalog",
                "Purposes",
              ].includes(c),
            )
            .map((c) => (
              <Button
                key={c}
                role="tab"
                aria-selected={category === c}
                variant={category === c ? "secondary" : "ghost"}
                onClick={() => {
                  setCategory(c);
                  setSelected("");
                  setSearch("");
                  setView("visual");
                }}
              >
                {label(c)}{" "}
                <span className="kind-count">
                  {c === "Data catalog"
                    ? (analysis?.result.dataSemantics?.fields.length ?? 0)
                    : entries.filter((e) => e.category === c).length}
                </span>
              </Button>
            ))}
          <Select
            aria-label="More definitions"
            value={
              [
                "Resources",
                "Functions",
                "Sources",
                "Data catalog",
                "Purposes",
              ].includes(category)
                ? "__more"
                : category
            }
            items={{
              __more: "More definitions",
              ...Object.fromEntries(
                categories
                  .filter(
                    (c) =>
                      ![
                        "Resources",
                        "Functions",
                        "Sources",
                        "Data catalog",
                        "Purposes",
                      ].includes(c),
                  )
                  .map((c) => [c, label(c)]),
              ),
            }}
            onValueChange={(value) => {
              if (value !== "__more") {
                setCategory(String(value) as Category);
                setSelected("");
                setSearch("");
                setView("visual");
              }
            }}
          />
        </div>
        {category === "Data catalog" && analysis ? (
          <DataCatalog
            analysis={analysis.result}
            entries={entries}
            onSelect={choose}
          />
        ) : (
          <div className="app-browser">
            <aside className="app-declarations">
              <Input
                aria-label="Find declaration"
                placeholder={`Find ${label(category).toLowerCase()}…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <nav aria-label={category}>
                {visible.map((e) => (
                  <Button
                    key={e.id}
                    aria-label={e.name}
                    variant={entry?.id === e.id ? "secondary" : "ghost"}
                    onClick={() => choose(e.id)}
                  >
                    <span>{e.name}</span>
                    <small className="declaration-preview">
                      {declarationSummary(e)}
                    </small>
                    {e.module !== "_" && <small>{e.module}</small>}
                  </Button>
                ))}
              </nav>
              {!visible.length && (
                <p className="muted">No matching {category.toLowerCase()}.</p>
              )}
            </aside>
            <section className="app-detail" aria-busy={!ready}>
              {entry ? (
                <>
                  <header className="app-detail-heading">
                    <div>
                      <p className="eyebrow">{label(entry.category)}</p>
                      {editing && named(entry.source, entry.node) ? (
                        <Edit
                          label="Declaration name"
                          value={entry.name}
                          onCommit={(value) => {
                            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
                              replaceEntry(
                                patch(
                                  entry.source,
                                  named(entry.source, entry.node)!,
                                  value,
                                ),
                              );
                            else setError("Use a valid declaration name.");
                          }}
                        />
                      ) : (
                        <h2>{entry.name}</h2>
                      )}
                      <p className="muted">{declarationSummary(entry)}</p>
                    </div>
                    <div className="editor-row">
                      <Button size="sm" onClick={() => setView("visual")}>
                        Document
                      </Button>
                      {developer && (
                        <Button size="sm" onClick={() => setView("source")}>
                          Source
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setView("graph")}>
                        Relationships
                      </Button>
                    </div>
                  </header>
                  {view === "visual" &&
                    analysis &&
                    (["RESOURCE_DECL", "FUNCTION_DECL", "SOURCE_DECL"].includes(
                      entry.node.kind,
                    ) ? (
                      <fieldset
                        className="visual-fieldset composer-fieldset"
                        disabled={!ready || gitBusy}
                        aria-label="Application document"
                      >
                        {entry.node.kind === "RESOURCE_DECL" ? (
                          <ResourceWorkspace
                            key={entry.id}
                            entry={entry}
                            entries={entries}
                            analysis={analysis.result}
                            editing={editing}
                            developer={developer}
                            onChange={replaceEntry}
                            onError={setError}
                            onSelect={choose}
                          />
                        ) : entry.node.kind === "FUNCTION_DECL" ? (
                          <FunctionWorkspace
                            key={entry.id}
                            entry={entry}
                            entries={entries}
                            analysis={analysis.result}
                            editing={editing}
                            developer={developer}
                            onChange={replaceEntry}
                            onError={setError}
                            onSelect={choose}
                          />
                        ) : (
                          <SourceWorkspace
                            key={entry.id}
                            entry={entry}
                            entries={entries}
                            analysis={analysis.result}
                            editing={editing}
                            developer={developer}
                            onChange={replaceEntry}
                            onError={setError}
                            onSelect={choose}
                          />
                        )}
                      </fieldset>
                    ) : !editing ? (
                      <ReadDocument entry={entry} />
                    ) : (
                      <fieldset
                        className="visual-fieldset"
                        disabled={!ready || gitBusy}
                        aria-label="Visual Forge document"
                      >
                        <VisualDocument
                          key={`${analysis.id}:${entry.id}`}
                          source={entry.source}
                          analysis={analysis.result}
                          selection={entry}
                          onChange={replaceEntry}
                          onError={setError}
                        />
                      </fieldset>
                    ))}
                  {view === "source" && (
                    <div className="source-pane">
                      <label htmlFor="forge-source">
                        {entry.name} · {entry.path}
                      </label>
                      <SourceEditor key={entry.id} value={entry.source.slice(entry.node.start, entry.node.end)} readOnly={!editing || !ready || gitBusy}
                        onCommit={value => replaceEntry(patch(entry.source,entry.node,value))} />
                      <Button
                        onClick={() => download(entry.path, entry.source)}
                      >
                        Download file
                      </Button>
                    </div>
                  )}
                  {view === "graph" && ready && analysis && (
                    <Relationships
                      analysis={analysis.result}
                      source={file.text}
                      currentFile={file.path}
                      onOpenFile={(path) => {
                        const target = entries.find((e) => e.path === path);
                        if (target) choose(target.id);
                      }}
                      onSelect={(node) => {
                        const target = entries.find(
                          (e) =>
                            e.path === file.path && e.node.start === node.start,
                        );
                        if (target) choose(target.id);
                      }}
                    />
                  )}
                </>
              ) : (
                <div className="editor-empty">
                  {analysis
                    ? `No ${category.toLowerCase()} yet.`
                    : "Loading the Forge application…"}
                </div>
              )}
              {editing && (
                <details className="create-definition">
                  <summary>
                    {developer
                      ? "Create a definition"
                      : "Add to your application"}
                  </summary>
                  <form
                    className="declaration-builder"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return;
                      const templates: Record<string, string> = {
                        resource: `export resource ${newName} @tenant @timestamps @versioned {\n  id : id\n}`,
                        shape: `export shape ${newName} {\n  value : text\n}`,
                        purpose: `export purpose ${newName}`,
                        dataClass: `export dataClass ${newName} extends data.unknown`,
                        enum: `export enum ${newName} {\n  First = "first"\n}`,
                        type: `export type ${newName} = text`,
                        function: `export function ${newName} {\n}`,
                        source: `source ${newName} {\n  cron "0 8 * * *"\n  timezone "UTC"\n}`,
                      };
                      update(file.text + "\n" + templates[newKind] + "\n");
                      setNewName("");
                    }}
                  >
                    <Select
                      aria-label="Declaration kind"
                      value={newKind}
                      onValueChange={(v) => setNewKind(String(v))}
                      items={{
                        resource: developer ? "Resource" : "Data collection",
                        shape: "Shape",
                        purpose: "Purpose",
                        dataClass: "Data class",
                        enum: "Enum",
                        type: "Type alias",
                        function: developer ? "Function" : "Business action",
                        source: developer ? "Source" : "Schedule",
                      }}
                    />
                    <Input
                      aria-label="New declaration name"
                      placeholder="Name, for example Customer"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      required
                    />
                    <Button type="submit">
                      {developer ? "Add declaration" : "Add"}
                    </Button>
                  </form>
                </details>
              )}
            </section>
          </div>
        )}
        <footer className="editor-status">
          <span>{saved}</span>
          <span role="status">
            {ready
              ? `${diagnostics.filter((d) => d.severity === "error").length} errors · ${diagnostics.filter((d) => d.severity === "warning").length} warnings`
              : "Checking source…"}
          </span>
        </footer>
        <details
          className="editor-diagnostics"
          open={diagnostics.some((d) => d.severity === "error")}
        >
          <summary>
            {developer ? "Forge diagnostics" : "Things to check"} (
            {diagnostics.length})
          </summary>
          {diagnostics.map((d, i) => (
            <div className={`diagnostic diagnostic-${d.severity}`} key={i}>
              {developer && <strong>{d.code}</strong>}
              <span>
                {d.message}
                {d.suggestion && <p>{d.suggestion}</p>}
                {developer ? (
                  <small>{d.file}</small>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      const target =
                        entries.find(
                          (e) =>
                            e.path === d.file &&
                            e.node.start <= d.start &&
                            e.node.end >= d.start,
                        ) ?? entries.find((e) => e.path === d.file);
                      if (target) choose(target.id);
                    }}
                  >
                    Review affected item
                  </Button>
                )}
              </span>
            </div>
          ))}
        </details>
      </div>
    </div>
  );
}
