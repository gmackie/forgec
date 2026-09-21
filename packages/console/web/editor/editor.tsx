import React, { useEffect, useRef, useState } from "react";
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
import { ReadDocument } from "./read-document.js";
import { patch } from "./model.js";
import type { GitProject, GitSnapshot } from "../../src/git.js";
import { example } from "./example.js";
import "./editor.css";
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
export function ForgeEditor({ token = "" }: { token?: string }) {
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
    const timer = setTimeout(() => {
      requestSources.current.clear();
      requestSources.current.set(id, { text: file.text, path: file.path });
      worker.current?.postMessage({ id, project });
    }, 160);
    const watchdog = setTimeout(() => {
      if (requestSources.current.has(id)) {
        worker.current?.terminate();
        setError(
          "Compiler time limit reached. Your draft is preserved; shorten the source or restart the compiler.",
        );
      }
    }, 10000);
    return () => {
      clearTimeout(timer);
      clearTimeout(watchdog);
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
  async function loadRepository() {
    setGitBusy(true);
    setError("");
    try {
      const snapshot: GitSnapshot = await gitApi(`/${repoId}`);
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
      const result = await gitApi(`/${repository.id}/commits`, {
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
    <div className="forge-editor app-studio">
      <div className="editor-title">
        <div>
          <p className="eyebrow">FORGE STUDIO · APPLICATION</p>
          <h1>{project.name}</h1>
          <p className="muted">
            {editing
              ? "Editing a draft. Review changes before committing."
              : "Explore your application model."}
          </p>
        </div>
        <Badge variant="outline">
          {repository
            ? `${repository.branch} · ${repository.revision.slice(0, 8)}${changedFiles.length ? " · Uncommitted changes" : ""}`
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
          {repository ? "Change repository" : "Connect Git"}
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
          <summary>Project tools</summary>
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
            void importFiles(e.target.files).catch((e) => setError(String(e)));
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
            Connect a Git application
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
              No repositories are configured. The instance operator can add
              GitHub repositories with GIT_PROJECTS_JSON and a server-side
              GITHUB_TOKEN.
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
              Load repository
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
            Commit to {repository?.repository} on {repository?.branch}. Git will
            reject the commit if this branch has changed since revision{" "}
            {repository?.revision.slice(0, 8)}.
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
            aria-label="Commit message"
            placeholder="Describe why you changed this application"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            disabled={gitBusy}
          />
          <p className="muted small">
            {diagnostics.filter((d) => d.severity === "error").length} compiler
            errors. Fix errors before committing.
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
              Commit changes
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
      <div
        className="app-kind-tabs"
        role="tablist"
        aria-label="Application declarations"
      >
        {categories.map((c) => (
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
            {c}{" "}
            <span className="kind-count">
              {entries.filter((e) => e.category === c).length}
            </span>
          </Button>
        ))}
      </div>
      <div className="app-browser">
        <aside className="app-declarations">
          <Input
            aria-label="Find declaration"
            placeholder={`Find ${category.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <nav aria-label={category}>
            {visible.map((e) => (
              <Button
                key={e.id}
                variant={entry?.id === e.id ? "secondary" : "ghost"}
                onClick={() => choose(e.id)}
              >
                {e.name}
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
                  <p className="eyebrow">{entry.category}</p>
                  <h2>{entry.name}</h2>
                  <p className="muted">{declarationSummary(entry)}</p>
                </div>
                <div className="editor-row">
                  <Button size="sm" onClick={() => setView("visual")}>
                    Document
                  </Button>
                  <Button size="sm" onClick={() => setView("source")}>
                    Source
                  </Button>
                  <Button size="sm" onClick={() => setView("graph")}>
                    Relationships
                  </Button>
                </div>
              </header>
              {view === "visual" &&
                (!editing ? (
                  <ReadDocument entry={entry} />
                ) : (
                  <fieldset
                    className="visual-fieldset"
                    disabled={!ready || gitBusy}
                    aria-label="Visual Forge document"
                  >
                    {analysis && (
                      <VisualDocument
                        key={`${analysis.id}:${entry.id}`}
                        source={entry.source}
                        analysis={analysis.result}
                        selection={entry}
                        onChange={replaceEntry}
                        onError={setError}
                      />
                    )}
                  </fieldset>
                ))}
              {view === "source" && (
                <div className="source-pane">
                  <label htmlFor="forge-source">
                    {entry.name} · {entry.path}
                  </label>
                  {editing ? (
                    <Edit
                      key={entry.id}
                      multiline
                      label="Forge source"
                      value={entry.source.slice(
                        entry.node.start,
                        entry.node.end,
                      )}
                      onCommit={(value) =>
                        replaceEntry(patch(entry.source, entry.node, value))
                      }
                    />
                  ) : (
                    <Textarea
                      id="forge-source"
                      aria-label="Forge source"
                      readOnly
                      value={entry.source.slice(
                        entry.node.start,
                        entry.node.end,
                      )}
                    />
                  )}
                  <Button onClick={() => download(entry.path, entry.source)}>
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
                  resource: "Resource",
                  shape: "Shape",
                  purpose: "Purpose",
                  dataClass: "Data class",
                  enum: "Enum",
                  type: "Type alias",
                  function: "Function",
                  source: "Source",
                }}
              />
              <Input
                aria-label="New declaration name"
                placeholder="Declaration name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
              />
              <Button type="submit">Add declaration</Button>
            </form>
          )}
        </section>
      </div>
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
        <summary>Forge diagnostics ({diagnostics.length})</summary>
        {diagnostics.map((d, i) => (
          <div className={`diagnostic diagnostic-${d.severity}`} key={i}>
            <strong>{d.code}</strong>
            <span>
              {d.message}
              <small>{d.file}</small>
            </span>
          </div>
        ))}
      </details>
    </div>
  );
}
