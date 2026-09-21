import React, { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { children, nameOf } from "./model.js";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import {
  ArrowCounterClockwiseIcon,
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  FolderOpenIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import type { Analysis, Project } from "./language.js";
import { VisualDocument } from "./document.js";
import { Relationships } from "./graph.js";
import { example } from "./example.js";
import "./editor.css";
const storageKey = "forge.visual-editor.v1";
function initial(): Project {
  try {
    const p = JSON.parse(localStorage.getItem(storageKey) || "null");
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
export function ForgeEditor() {
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
    [newName, setNewName] = useState(""),
    [newFile, setNewFile] = useState("");
  const worker = useRef<Worker | null>(null),
    seq = useRef(0),
    fileInput = useRef<HTMLInputElement>(null),
    sourceRef = useRef<HTMLTextAreaElement>(null);
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
      localStorage.setItem(storageKey, JSON.stringify(project));
      setSaved("Draft saved in this browser");
    } catch {
      setSaved(
        "Browser storage unavailable — download your files to keep them",
      );
    }
  }, [project]);
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
    commit({ ...current.current, files: opened, currentFile: opened[0]!.path });
  }
  const diagnostics = analysis?.result.diagnostics ?? [];
  return (
    <div className="forge-editor">
      <div className="editor-title">
        <div>
          <p className="eyebrow">FORGE STUDIO</p>
          <h1>A language you can shape.</h1>
          <p className="muted">
            Edit the model visually. Keep the source yours.
          </p>
        </div>
        <Badge variant="outline">Local compiler · edition 2027</Badge>
      </div>
      <Dialog.Root open={showDemo} onOpenChange={setShowDemo}>
        <Dialog size="base" className="editor">
          <Dialog.Title className="dialog-title">Load the service desk demo?</Dialog.Title>
          <Dialog.Description className="muted">
            Explore seven files with customers, tickets, service plans, purposes,
            events, and an escalation workflow. This replaces your browser draft.
            Export it first to keep a copy, or use Undo immediately after loading.
          </Dialog.Description>
          <footer className="dialog-footer">
            <Button onClick={() => setShowDemo(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              commit(structuredClone(example));
              setView("visual");
              setError("");
              setShowDemo(false);
            }}>Replace draft with demo</Button>
          </footer>
        </Dialog>
      </Dialog.Root>
      <div className="editor-toolbar">
        <Button onClick={() => setShowDemo(true)}>Load demo</Button>
        <Button
          icon={<FolderOpenIcon />}
          onClick={() => fileInput.current?.click()}
        >
          Open .forge files
        </Button>
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
        <Button
          icon={<DownloadSimpleIcon />}
          onClick={() => download(file.path, file.text)}
        >
          Download file
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            download("forge-draft.json", JSON.stringify(project, null, 2))
          }
        >
          Export draft
        </Button>
        <span className="declaration-spacer" />
        <Button
          aria-label="Undo edit"
          icon={<ArrowCounterClockwiseIcon />}
          disabled={!history.past.length}
          onClick={undo}
        >
          Undo
        </Button>
        <Button
          aria-label="Redo edit"
          icon={<ArrowClockwiseIcon />}
          disabled={!history.future.length}
          onClick={redo}
        >
          Redo
        </Button>
      </div>
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
      <div className="editor-workspace">
        <aside className="editor-files">
          <h2>Project files</h2>
          <Input
            label="Package name"
            value={project.name}
            onChange={(e) => commit({ ...project, name: e.target.value })}
          />
          <nav aria-label="Forge files">
            {project.files.map((f) => (
              <Button
                variant="ghost"
                key={f.path}
                className={f.path === file.path ? "file-active" : ""}
                onClick={() => commit({ ...project, currentFile: f.path })}
              >
                {f.path}
              </Button>
            ))}
          </nav>
          {ready && analysis && (
            <nav aria-label="Declarations in this file" className="document-outline">
              <h2>In this file</h2>
              {children(analysis.result.tree).filter(n => n.kind.endsWith("_DECL")).map(n => (
                <Button key={n.start} variant="ghost" size="sm" onClick={() => {
                  setView("visual");
                  setTimeout(() => document.getElementById(`declaration-${n.start}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
                }}>{nameOf(file.text, n) || n.kind.replace("_DECL", "").toLowerCase()}</Button>
              ))}
            </nav>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const path = newFile.trim().endsWith(".forge")
                ? newFile.trim()
                : newFile.trim() + ".forge";
              if (
                !/^[A-Za-z0-9_./-]+\.forge$/.test(path) ||
                path.startsWith("/") ||
                path.split("/").includes("..") ||
                project.files.some((f) => f.path === path)
              ) {
                setError("Use a unique relative .forge path.");
                return;
              }
              commit({
                ...project,
                files: [...project.files, { path, text: "" }],
                currentFile: path,
              });
              setNewFile("");
            }}
          >
            <Input
              aria-label="New file name"
              placeholder="new-model.forge"
              value={newFile}
              onChange={(e) => setNewFile(e.target.value)}
              required
            />
            <Button type="submit" size="sm" icon={<PlusIcon />}>
              New file
            </Button>
          </form>
          <p className="muted small">
            Files stay in your browser. Download .forge files to save them to
            your project.
          </p>
        </aside>
        <section className="editor-document">
          <div className="document-tabs">
            <strong>{file.path}</strong>
            <div role="group" aria-label="Editor view">
              {(["visual", "split", "source", "graph"] as const).map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={view === v ? "secondary" : "ghost"}
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {v === "visual"
                    ? "Document"
                    : v === "split"
                      ? "Split"
                      : v === "source"
                        ? "Source"
                        : "Relationships"}
                </Button>
              ))}
            </div>
          </div>
          <form
            className="declaration-builder"
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return;
              const templates: Record<string, string> = {
                resource: `export resource ${newName}\n  @tenant\n  @timestamps\n  @versioned\n{\n  id : id\n}`,
                shape: `export shape ${newName} {\n  value : text\n}`,
                purpose: `export purpose ${newName}`,
                dataClass: `export dataClass ${newName} extends data.unknown`,
                enum: `export enum ${newName} {\n  First = "first"\n}`,
                type: `export type ${newName} = text`,
              };
              update(
                file.text +
                  (file.text.endsWith("\n") ? "\n" : "\n\n") +
                  templates[newKind] +
                  "\n",
              );
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
              }}
            />
            <Input
              aria-label="New declaration name"
              placeholder="Declaration name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              required
            />
            <Button type="submit" size="sm" icon={<PlusIcon />}>
              Add declaration
            </Button>
          </form>
          <div className={`document-views view-${view}`}>
            {(view === "visual" || view === "split") && (
              <fieldset
                disabled={!ready}
                className="visual-fieldset"
                aria-label="Visual Forge document"
              >
                {analysis ? (
                  <VisualDocument
                    key={analysis.id}
                    source={analysis.text}
                    analysis={analysis.result}
                    onChange={(value) => {
                      if (ready) update(value);
                    }}
                    onError={setError}
                  />
                ) : (
                  <p className="editor-loading">Loading the Forge language…</p>
                )}
              </fieldset>
            )}
            {(view === "source" || view === "split") && (
              <div className="source-pane">
                <label htmlFor="forge-source">Synchronized .forge source</label>
                <Textarea
                  ref={sourceRef}
                  id="forge-source"
                  aria-label="Forge source"
                  spellCheck={false}
                  value={file.text}
                  onChange={(e) => update(e.target.value)}
                />
              </div>
            )}
            {view === "graph" && ready && analysis && (
              <Relationships
                currentFile={file.path}
                onOpenFile={(path) => {
                  commit({ ...project, currentFile: path });
                  setView("visual");
                }}
                analysis={analysis.result}
                source={analysis.text}
                onSelect={(n) => {
                  setView("visual");
                  setTimeout(
                    () =>
                      document
                        .getElementById(`declaration-${n.start}`)
                        ?.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        }),
                    0,
                  );
                }}
              />
            )}
          </div>
          <footer className="editor-status">
            <span>{saved || "Saving browser draft…"}</span>
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
            <p className="muted small">
              Checks use the real compiler on the open files. External
              dependency resolution requires the package build.
            </p>
            {diagnostics.map((d, i) => (
              <button
                type="button"
                key={i}
                className={`diagnostic diagnostic-${d.severity}`}
                onClick={() => {
                  commit({ ...project, currentFile: d.file });
                  setView("source");
                  setTimeout(() => {
                    sourceRef.current?.focus();
                    sourceRef.current?.setSelectionRange(d.start, d.end);
                  }, 0);
                }}
              >
                <strong>{d.code}</strong>
                <span>
                  {d.file} · {d.message}
                  {d.suggestion && <small>{d.suggestion}</small>}
                </span>
              </button>
            ))}
            {!diagnostics.length && ready && (
              <p>No compiler diagnostics for the open files.</p>
            )}
          </details>
        </section>
      </div>
    </div>
  );
}
