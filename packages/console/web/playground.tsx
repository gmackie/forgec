import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AppBundle, DomainIR, TickResult } from "@forgegraph/runtime";
import type { Analysis, OpenApiImport, OpenApiImportRequest, Project } from "./editor/language.js";
import { example } from "./editor/example.js";
import { draftChanged, readDraft, writeDraft } from "./editor/draft.js";
import type { PlaygroundDocument, PlaygroundPosition } from "../src/playground-document.js";
import {
  canFire,
  contractGraph,
  hasCompilerErrors,
  place,
  playgroundGraph,
  positionFor,
  type CanvasNode,
  type GraphNode,
} from "./editor/playground-model.js";
import { decideReopen } from "./editor/playground-reopen.js";
import { openPlaygroundRuntime, type PlaygroundSession } from "./editor/playground-run.js";
import {
  matchingPositions,
  matchingSamples,
  readPlaygroundSession,
  writePlaygroundSession,
  type SessionSample,
} from "./editor/playground-session.js";
import {
  FunctionWorkspace,
  ResourceWorkspace,
  SourceWorkspace,
} from "./editor/workspace.js";
import { VisualDocument } from "./editor/document.js";
import { named, patch, textOf } from "./editor/model.js";
import { OpenApiOnboarding, type DiscoveredApi } from "./openapi-onboarding.js";
import { cutWire, deleteDeclaration, snapTargets, snapWire } from "./editor/playground-wires.js";
import { Edit } from "./editor/document.js";
import "./editor/editor.css";
import "./playground.css";

type Inspect = ((project: Project & { emit?: "ir" }) => Analysis | Promise<Analysis>) & {
  importOpenApi?: (request: OpenApiImportRequest) => OpenApiImport | Promise<OpenApiImport>;
};

export interface OpenedPackage {
  token: number;
  bundle: AppBundle;
  playground: PlaygroundDocument | null;
}

const templates: Record<string, (name: string) => string> = {
  resource: (name) =>
    `export resource ${name} @tenant @timestamps @versioned {\n  id : id\n}`,
  function: (name) => `export function ${name} {\n}`,
  source: (name) => `source ${name} {\n  cron "0 8 * * *"\n  timezone "UTC"\n}`,
  workflow: (name) => `workflow ${name} {\n  version 1\n}`,
  channel: (name) => `channel ${name} {\n  message Payload {\n    value : text\n  }\n}`,
};

const blockLabels: Record<string, string> = {
  resource: "Resource",
  function: "Function",
  source: "Source",
  workflow: "Workflow",
  channel: "Channel",
};

const blocks = ["resource", "function", "source", "workflow", "channel"] as const;

function declarationNames(text: string) {
  return [...text.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:resource|function|source|workflow|channel)\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => match[1])
    .filter((item): item is string => Boolean(item));
}

function freshName(base: string, taken: Set<string>) {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function sourceBlock(name: string, target: string, createTarget: boolean) {
  const companion = createTarget ? `function ${target} {\n}\n\n` : "";
  return `${companion}source ${name} {\n  cron "0 8 * * *"\n  timezone "UTC"\n  -> ${target}\n}`;
}

const defaultClock = "2026-10-03T08:00:00.000Z";

const blankProgram: Project = {
  name: "@local/draft",
  currentFile: "main.forge",
  files: [{ path: "main.forge", text: "\n" }],
};

function resultFor(node: CanvasNode, results: TickResult[] | null) {
  return results?.find(
    (result) =>
      result.source === node.name ||
      result.source.endsWith(`/${node.name}`) ||
      result.source.endsWith(`.${node.name}`),
  );
}

function isGraphNode(node: CanvasNode): node is GraphNode {
  return "entry" in node;
}

function kindLabel(node: CanvasNode) {
  if (
    isGraphNode(node) &&
    node.kind === "function" &&
    textOf(node.entry.source, node.entry.node).includes("@http")
  ) {
    return "external";
  }
  return node.kind;
}

function pointInSvg(svg: SVGSVGElement, clientX: number, clientY: number) {
  const matrix = typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
  if (matrix && typeof svg.createSVGPoint === "function") {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }
  const rect = svg.getBoundingClientRect();
  const box = svg.viewBox?.baseVal;
  const width = box?.width || rect.width || 1;
  const height = box?.height || rect.height || 1;
  return {
    x: ((clientX - rect.left) / (rect.width || 1)) * width + (box?.x || 0),
    y: ((clientY - rect.top) / (rect.height || 1)) * height + (box?.y || 0),
  };
}

interface CompilerReply {
  id: number;
  analysis?: Analysis;
  imported?: OpenApiImport;
  error?: string;
}

function useCompiler(inspect: Inspect | undefined) {
  const worker = useRef<Worker | null>(null);
  const [epoch, setEpoch] = useState(0);
  const seq = useRef(0);
  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;
  useEffect(() => {
    if (inspectRef.current) return;
    const next = new Worker(new URL("./editor/compiler.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = next;
    return () => {
      next.terminate();
      worker.current = null;
    };
  }, [inspect, epoch]);
  const callWorker = useCallback(
    <T,>(message: object, read: (reply: CompilerReply) => T | undefined, timeoutMessage: string) => {
      const id = ++seq.current;
      return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          worker.current?.terminate();
          setEpoch((value) => value + 1);
          reject(Error(timeoutMessage));
        }, 10000);
        const onMessage = (event: MessageEvent<CompilerReply>) => {
          if (event.data.id !== id) return;
          window.clearTimeout(timer);
          worker.current?.removeEventListener("message", onMessage);
          const value = read(event.data);
          if (event.data.error || value === undefined) reject(Error(event.data.error || "Compiler failed"));
          else resolve(value);
        };
        worker.current?.addEventListener("message", onMessage);
        worker.current?.postMessage({ ...message, id });
      });
    },
    [],
  );
  const compile = useCallback(
    (project: Project, emit?: "ir") => {
      const current = inspectRef.current;
      if (current) return Promise.resolve(current(emit ? { ...project, emit } : project));
      return callWorker<Analysis>(
        { project, ...(emit ? { emit } : {}) },
        (reply) => reply.analysis,
        "Compiler time limit reached. Your draft is preserved.",
      );
    },
    [callWorker],
  );
  const importSpec = useCallback(
    (request: OpenApiImportRequest) => {
      const current = inspectRef.current;
      if (current?.importOpenApi) return Promise.resolve(current.importOpenApi(request));
      return callWorker<OpenApiImport>(
        { kind: "import", request },
        (reply) => reply.imported,
        "OpenAPI import time limit reached.",
      );
    },
    [callWorker],
  );
  return { compile, importSpec };
}

export function PlaygroundEditor({
  inspect,
  initialProject,
  initialSession,
  readonlyView,
  opened,
  onUseDraft,
}: {
  inspect?: Inspect;
  initialProject?: Project;
  initialSession?: { positions: PlaygroundPosition[]; samples: SessionSample[] } | undefined;
  readonlyView?: { ir: DomainIR; reason: string } | null;
  opened?: OpenedPackage | null;
  onUseDraft?: (() => void) | undefined;
}) {
  const { compile, importSpec } = useCompiler(inspect);
  const openApi = !inspect || inspect.importOpenApi ? importSpec : null;
  const skipStorage = initialProject !== undefined || readonlyView != null;
  const [project, setProject] = useState<Project>(
    () => initialProject ?? readDraft()?.project ?? structuredClone(blankProgram),
  );
  const projectRef = useRef(project);
  projectRef.current = project;
  const external = useRef(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisKey, setAnalysisKey] = useState("");
  const [selected, setSelected] = useState("");
  const [clock, setClock] = useState(defaultClock);
  const [payload, setPayload] = useState("{}");
  const [positions, setPositions] = useState<PlaygroundPosition[]>(
    () => initialSession?.positions ?? (skipStorage ? [] : readPlaygroundSession().positions),
  );
  const [samples, setSamples] = useState<SessionSample[]>(
    () => initialSession?.samples ?? (skipStorage ? [] : readPlaygroundSession().samples),
  );
  const [readonly, setReadonly] = useState(readonlyView ?? null);
  const readonlyRef = useRef(readonly);
  readonlyRef.current = readonly;
  const [results, setResults] = useState<TickResult[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("source");
  const [name, setName] = useState("");
  const [snapTo, setSnapTo] = useState("");
  const session = useRef<PlaygroundSession | null>(null);
  const pending = useRef<string | null>(null);
  const dragging = useRef<{
    path: string;
    name: string;
    dx: number;
    dy: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const skipClick = useRef(false);
  const fingerprint = project.files.map((file) => `${file.path}\0${file.text}`).join("\0");

  useEffect(() => {
    session.current = null;
    setResults(null);
  }, [fingerprint]);

  useEffect(() => {
    if (skipStorage || readonly) return;
    if (external.current) {
      external.current = false;
      return;
    }
    const saved = readDraft()?.project;
    if (saved && JSON.stringify(saved) === JSON.stringify(project)) return;
    try {
      writeDraft(project);
    } catch {
      setError("Browser storage unavailable. Download the draft from the Editor to keep it.");
    }
  }, [project, skipStorage, readonly]);

  useEffect(() => {
    if (skipStorage || readonly) return;
    try {
      writePlaygroundSession({ positions, samples });
    } catch {
      setError("Browser storage unavailable. Download the draft from the Editor to keep it.");
    }
  }, [positions, samples, skipStorage, readonly]);

  useEffect(() => {
    if (skipStorage) return;
    const sync = () => {
      const next = readDraft()?.project;
      if (!next || JSON.stringify(next) === JSON.stringify(projectRef.current)) return;
      external.current = true;
      setProject(next);
    };
    window.addEventListener(draftChanged, sync);
    return () => window.removeEventListener(draftChanged, sync);
  }, [skipStorage]);

  useEffect(() => {
    if (readonlyRef.current) return;
    const key = fingerprint;
    let live = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve(compile(project))
        .then((next) => {
          if (!live || readonlyRef.current) return;
          setAnalysis(next);
          setAnalysisKey(key);
          setError(next.error || "");
        })
        .catch((reason: unknown) => {
          if (live && !readonlyRef.current) setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, inspect ? 0 : 160);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [project, compile, inspect, readonly, fingerprint]);

  useEffect(() => {
    if (!opened) return;
    let live = true;
    setBusy(true);
    setError("");
    void decideReopen(opened.bundle, opened.playground, (next) => compile(next, next.emit))
      .then((decision) => {
        if (!live) return;
        if (decision.mode === "readonly") {
          setReadonly({ ir: decision.ir, reason: decision.reason });
          setSelected("");
          return;
        }
        projectRef.current = decision.project;
        external.current = true;
        setReadonly(null);
        setProject(decision.project);
        setPositions(decision.positions);
        setSamples(decision.samples);
        setSelected("");
        setResults(null);
        session.current = null;
        if (!skipStorage) {
          try {
            writeDraft(decision.project);
            writePlaygroundSession({ positions: decision.positions, samples: decision.samples });
          } catch {
            setError("Browser storage unavailable. Download the draft from the Editor to keep it.");
          }
        }
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [opened, compile, skipStorage]);

  // A compile for the previous draft must not drop this draft's layout. Keep the last
  // matching graph on screen until the compile for the current source arrives.
  const currentAnalysis = analysisKey === fingerprint ? analysis : null;
  const freshGraph =
    !readonly && currentAnalysis?.documents ? playgroundGraph(project, currentAnalysis) : null;
  const shownGraph = useRef(freshGraph);
  if (freshGraph) shownGraph.current = freshGraph;
  const draftGraph = freshGraph ?? shownGraph.current ?? { nodes: [], edges: [] };
  const graph = readonly ? contractGraph(readonly.ir) : draftGraph;
  const current = graph.nodes.find((node) => node.id === selected) ?? null;

  useEffect(() => {
    if (readonly || !currentAnalysis?.documents) return;
    const nodes = playgroundGraph(project, currentAnalysis).nodes;
    setPositions((items) => {
      const next = matchingPositions(nodes, items);
      return next.length === items.length ? items : next;
    });
    setSamples((items) => {
      const next = matchingSamples(nodes, items);
      return next.length === items.length ? items : next;
    });
  }, [currentAnalysis, project, readonly]);

  useEffect(() => {
    if (!pending.current) return;
    const created = graph.nodes.find((node) => node.name === pending.current);
    if (!created) return;
    pending.current = null;
    setSelected(created.id);
  }, [graph.nodes]);

  function choose(id: string) {
    const node = graph.nodes.find((item) => item.id === id);
    setSelected(id);
    if (!node) return;
    const sample = samples.find((item) => item.path === node.path && item.name === node.name);
    setClock(sample?.clock ?? defaultClock);
    setPayload(sample?.payload ?? "{}");
  }

  function rememberSample(node: { path: string; name: string }, clockValue: string, payloadValue: string) {
    setSamples((items) => [
      ...items.filter((item) => item.path !== node.path || item.name !== node.name),
      { path: node.path, name: node.name, clock: clockValue, payload: payloadValue },
    ]);
  }

  function rememberPosition(node: { path: string; name: string }, x: number, y: number) {
    setPositions((items) => [
      ...items.filter((item) => item.path !== node.path || item.name !== node.name),
      { path: node.path, name: node.name, x, y },
    ]);
  }

  function replaceFile(path: string, text: string) {
    setProject((currentProject) => ({
      ...currentProject,
      currentFile: path,
      files: currentProject.files.map((file) => (file.path === path ? { ...file, text } : file)),
    }));
  }

  function loadProject(next: Project, focus?: string) {
    session.current = null;
    pending.current = focus ?? null;
    setResults(null);
    setError("");
    setSelected("");
    setSnapTo("");
    setPositions([]);
    setSamples([]);
    setClock(defaultClock);
    setPayload("{}");
    setName("");
    setProject(structuredClone(next));
  }

  function addExternal(api: DiscoveredApi) {
    pending.current = api.focus;
    setSelected("");
    setSnapTo("");
    setError("");
    setProject((currentProject) => ({
      ...currentProject,
      currentFile: api.path,
      files: [
        ...currentProject.files.filter((file) => file.path !== api.path),
        { path: api.path, text: api.text },
      ],
    }));
  }

  function useExternal(api: DiscoveredApi) {
    loadProject(
      { name: api.packageName, currentFile: api.path, files: [{ path: api.path, text: api.text }] },
      api.focus,
    );
  }

  function removeSelected(node: GraphNode) {
    replaceFile(node.path, deleteDeclaration(node.entry.source, node.entry.node));
    setSelected("");
    setSnapTo("");
    setError("");
    setPositions((items) => items.filter((item) => item.path !== node.path || item.name !== node.name));
    setSamples((items) => items.filter((item) => item.path !== node.path || item.name !== node.name));
  }

  function connectNodes(from: GraphNode, to: GraphNode) {
    try {
      const next = snapWire(
        from.entry.source,
        { kind: from.kind, name: from.name, path: from.path, node: from.entry.node },
        { kind: to.kind, name: to.name, path: to.path, node: to.entry.node },
      );
      replaceFile(from.path, next.text);
      setError("");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  }

  function connect(from: GraphNode) {
    const to = draftGraph.nodes.find((node) => node.id === snapTo);
    if (!to) return;
    connectNodes(from, to);
  }

  function cutEdge(edge: { from: string; to: string; label: string }) {
    const from = draftGraph.nodes.find((node) => node.id === edge.from);
    const to = draftGraph.nodes.find((node) => node.id === edge.to);
    if (!from || !to) return;
    try {
      replaceFile(
        from.path,
        cutWire(
          from.entry.source,
          { kind: from.kind, name: from.name, path: from.path, node: from.entry.node },
          { kind: to.kind, name: to.name, path: to.path, node: to.entry.node },
          edge.label,
        ),
      );
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function addBlock(nextKind: string) {
    const file = project.files.find((item) => item.path === project.currentFile);
    const create = templates[nextKind];
    if (!file || !create) return;
    const taken = new Set(project.files.flatMap((item) => declarationNames(item.text)));
    const explicit = name.trim();
    if (explicit && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(explicit)) {
      setError("Use a valid declaration name.");
      return;
    }
    if (explicit && taken.has(explicit)) {
      setError(`${explicit} already exists.`);
      return;
    }
    const declName = explicit || freshName(blockLabels[nextKind] ?? "Block", taken);
    taken.add(declName);
    let body = create(declName);
    if (nextKind === "source") {
      const existing = file.text.match(/(?:^|\n)\s*(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
      const target = existing ?? freshName(`Run${declName}`, taken);
      body = sourceBlock(declName, target, existing === null);
    }
    pending.current = declName;
    replaceFile(file.path, `${file.text.replace(/\s*$/, "")}\n\n${body}\n`);
    setName("");
    setKind(nextKind);
    setError("");
  }

  async function fire() {
    if (readonly || !current || !isGraphNode(current) || !canFire(currentAnalysis, current)) return;
    if (Number.isNaN(Date.parse(clock))) {
      setError("Enter an ISO-8601 clock time.");
      return;
    }
    setBusy(true);
    setError("");
    setResults(null);
    try {
      const compiled = await compile(project, "ir");
      if (hasCompilerErrors(compiled) || !compiled.ir) {
        if (compiled.documents) {
          setAnalysis(compiled);
          setAnalysisKey(fingerprint);
        }
        setError(compiled.error || "Fix compiler errors before firing a source.");
        return;
      }
      session.current ??= openPlaygroundRuntime(compiled.ir);
      setResults(await session.current.tick(new Date(Date.parse(clock)).toISOString()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const fired = current ? resultFor(current, results) : undefined;
  const ready = readonly ? true : Boolean(currentAnalysis?.documents) || shownGraph.current !== null;
  const errors = readonly ? [] : (currentAnalysis?.diagnostics.filter((diagnostic) => diagnostic.severity === "error") ?? []);
  const placed = graph.nodes.map((node, index) => ({ node, at: readonly ? place(index) : positionFor(node, index, positions) }));
  const bounds = placed.length
    ? {
        minX: Math.min(0, ...placed.map((item) => item.at.x)),
        minY: Math.min(0, ...placed.map((item) => item.at.y)),
        width: Math.max(640, Math.max(...placed.map((item) => item.at.x)) + 290),
        height: Math.max(160, Math.max(...placed.map((item) => item.at.y)) + 120),
      }
    : { minX: 0, minY: 0, width: 640, height: 160 };
  const editable = current && isGraphNode(current) && !readonly ? current : null;
  const snapChoices =
    editable == null
      ? []
      : draftGraph.nodes.filter(
          (node) => node.path === editable.path && node.id !== editable.id && snapTargets(editable.kind, node.kind),
        );
  const snapValue = snapChoices.some((node) => node.id === snapTo) ? snapTo : "";
  const touching =
    editable == null
      ? []
      : draftGraph.edges.filter(
          (edge) =>
            (edge.from === editable.id || edge.to === editable.id) &&
            (edge.label === "runs" || edge.label === "uses" || edge.label === "sends" || edge.label === "on"),
        );

  function openNode(id: string) {
    const node = graph.nodes.find((item) => item.id === id);
    if (
      editable &&
      node &&
      isGraphNode(node) &&
      node.id !== editable.id &&
      node.path === editable.path &&
      snapTargets(editable.kind, node.kind)
    ) {
      if (connectNodes(editable, node)) choose(node.id);
      return;
    }
    choose(id);
  }

  return (
    <div className="playground-editor">
      <header className="heading">
        <div>
          <p className="eyebrow">APPLICATION</p>
          <h1>{project.name}</h1>
          <p className="muted">
            Declarations in this browser draft. Wires follow the source. A schedule runs here
            and does not call a deployment.
          </p>
        </div>
        {readonly ? null : (
          <div className="playground-actions">
            <button type="button" onClick={() => loadProject(blankProgram)}>
              New draft
            </button>
            <button type="button" onClick={() => loadProject(example)}>
              Service desk
            </button>
            <button
              type="button"
              onClick={() => {
                session.current = null;
                setResults(null);
                setError("");
              }}
            >
              Reset runtime
            </button>
          </div>
        )}
      </header>
      {readonly ? (
        <div className="playground-readonly" role="status">
          <p>{readonly.reason} Fire and edits stay off until a draft recompiles to this package.</p>
          <button
            type="button"
            onClick={() => {
              setReadonly(null);
              setSelected("");
              onUseDraft?.();
            }}
          >
            Use the browser draft
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="playground-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="playground-layout">
        <div className="playground-canvas">
          {readonly ? null : (
            <div className="playground-palette" role="toolbar" aria-label="Declarations">
              {blocks.map((block) => (
                <button key={block} type="button" onClick={() => addBlock(block)}>
                  {blockLabels[block]}
                </button>
              ))}
            </div>
          )}
          {openApi && !readonly ? (
            <OpenApiOnboarding importSpec={openApi} onUse={useExternal} onAdd={addExternal} />
          ) : null}
          {!ready ? <p>Checking source…</p> : null}
          {ready && !graph.nodes.length ? (
            <div className="blank">
              <h2>No declarations</h2>
              <p>Add a declaration, or import an OpenAPI document. The graph shows the source.</p>
            </div>
          ) : null}
          {ready && graph.nodes.length ? (
            <svg
              role="img"
              aria-label="Forge graph"
              viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width - bounds.minX} ${bounds.height - bounds.minY}`}
            >
              <defs>
                <marker id="playground-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6" fill="#8791a6" />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const from = placed.find((item) => item.node.id === edge.from);
                const to = placed.find((item) => item.node.id === edge.to);
                if (!from || !to) return null;
                const a = from.at;
                const b = to.at;
                const d = `M${a.x + 130} ${a.y + 72} C${a.x + 130} ${a.y + 108},${b.x + 130} ${b.y - 28},${b.x + 130} ${b.y}`;
                const cuttable =
                  !readonly &&
                  isGraphNode(from.node) &&
                  isGraphNode(to.node) &&
                  (edge.label === "runs" || edge.label === "uses" || edge.label === "sends" || edge.label === "on");
                return (
                  <g key={`${edge.from}-${edge.label}-${edge.to}`}>
                    {cuttable ? (
                      <path
                        className="playground-edge-hit"
                        role="button"
                        aria-label={`Cut ${from.node.name} ${edge.label} ${to.node.name}`}
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={14}
                        onClick={(event) => {
                          event.stopPropagation();
                          cutEdge(edge);
                        }}
                      />
                    ) : null}
                    <path
                      data-from-name={from.node.name}
                      data-to-name={to.node.name}
                      data-label={edge.label}
                      d={d}
                      fill="none"
                      stroke="#8791a6"
                      markerEnd="url(#playground-arrow)"
                    />
                    <text className="playground-edge" x={(a.x + b.x) / 2 + 136} y={(a.y + b.y) / 2 + 36}>
                      {edge.label}
                    </text>
                  </g>
                );
              })}
              {placed.map(({ node, at }) => {
                const outcome = readonly ? undefined : resultFor(node, results)?.outcome;
                return (
                  <g
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${node.name}`}
                    aria-pressed={node.id === selected}
                    className={`playground-node kind-${node.kind}${node.id === selected ? " selected" : ""}${
                      editable &&
                      node.id !== editable.id &&
                      node.path === editable.path &&
                      snapTargets(editable.kind, node.kind)
                        ? " snap-target"
                        : ""
                    }`}
                    data-outcome={outcome}
                    data-external={kindLabel(node) === "external" ? "true" : undefined}
                    data-x={at.x}
                    data-y={at.y}
                    onClick={() => {
                      if (skipClick.current) {
                        skipClick.current = false;
                        return;
                      }
                      openNode(node.id);
                    }}
                    onPointerDown={(event) => {
                      if (readonly || event.button !== 0) return;
                      const svg = event.currentTarget.ownerSVGElement;
                      if (!svg) return;
                      const start = pointInSvg(svg, event.clientX, event.clientY);
                      dragging.current = {
                        path: node.path,
                        name: node.name,
                        dx: start.x - at.x,
                        dy: start.y - at.y,
                        x: event.clientX,
                        y: event.clientY,
                        moved: false,
                      };
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const drag = dragging.current;
                      if (!drag || drag.path !== node.path || drag.name !== node.name) return;
                      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) drag.moved = true;
                      const svg = event.currentTarget.ownerSVGElement;
                      if (!svg) return;
                      const point = pointInSvg(svg, event.clientX, event.clientY);
                      rememberPosition(node, Math.round(point.x - drag.dx), Math.round(point.y - drag.dy));
                    }}
                    onPointerUp={() => {
                      const drag = dragging.current;
                      if (drag?.path === node.path && drag.name === node.name) {
                        if (drag.moved) skipClick.current = true;
                        dragging.current = null;
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        choose(node.id);
                      }
                    }}
                  >
                    <rect x={at.x} y={at.y} width="250" height="78" rx="10" />
                    <text className="playground-kind" x={at.x + 14} y={at.y + 22}>
                      {kindLabel(node)}
                    </text>
                    <text x={at.x + 14} y={at.y + 46}>
                      {node.name}
                    </text>
                    {outcome ? (
                      <text className="playground-outcome" x={at.x + 14} y={at.y + 66}>
                        {outcome}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          ) : null}
          {errors.length ? (
            <ul className="playground-diagnostics">
              {errors.slice(0, 8).map((diagnostic, index) => (
                <li key={`${diagnostic.file}:${diagnostic.start}:${index}`}>
                  {diagnostic.file}: {diagnostic.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <aside className="playground-inspector" aria-label="Declaration">
          {readonly && current ? (
            <>
              <p className="eyebrow">{kindLabel(current)}</p>
              <h2>{current.name}</h2>
              <p className="muted small">{current.path}</p>
              {current.cron ? <p>Schedule {current.cron}</p> : null}
              <p className="muted small">This declaration is part of the published contract.</p>
            </>
          ) : null}
          {editable ? (
            <>
              <p className="eyebrow">{kindLabel(editable)}</p>
              {named(editable.entry.source, editable.entry.node) ? (
                <Edit
                  label="Declaration name"
                  value={editable.name}
                  onCommit={(value) => {
                    const token = named(editable.entry.source, editable.entry.node);
                    if (!token || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
                      setError("Use a valid declaration name.");
                      return;
                    }
                    replaceFile(editable.path, patch(editable.entry.source, token, value));
                  }}
                />
              ) : (
                <h2>{editable.name}</h2>
              )}
              <p className="muted small">{editable.path}</p>
              <div className="playground-snap">
                <button type="button" onClick={() => removeSelected(editable)}>
                  Delete declaration
                </button>
                {editable.kind === "source" || editable.kind === "function" || editable.kind === "channel" ? (
                  snapChoices.length ? (
                    <>
                      <label>
                        Snap to
                        <select
                          aria-label="Snap to"
                          value={snapValue}
                          onChange={(event) => setSnapTo(event.target.value)}
                        >
                          <option value="">Choose a declaration</option>
                          {snapChoices.map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.kind} {node.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" disabled={!snapValue} onClick={() => connect(editable)}>
                        Snap wire
                      </button>
                    </>
                  ) : (
                    <p className="muted small">Add another declaration in this file to snap a wire.</p>
                  )
                ) : null}
                {touching.map((edge) => {
                  const from = draftGraph.nodes.find((node) => node.id === edge.from);
                  const to = draftGraph.nodes.find((node) => node.id === edge.to);
                  if (!from || !to) return null;
                  return (
                    <button
                      key={`${edge.from}-${edge.label}-${edge.to}`}
                      type="button"
                      onClick={() => cutEdge(edge)}
                    >
                      {`Cut ${from.name} ${edge.label} ${to.name}`}
                    </button>
                  );
                })}
              </div>
              {currentAnalysis && editable.kind === "resource" ? (
                <ResourceWorkspace
                  entry={editable.entry}
                  entries={draftGraph.nodes.map((node) => node.entry)}
                  analysis={currentAnalysis}
                  editing
                  onChange={(text) => replaceFile(editable.path, text)}
                  onError={setError}
                  onSelect={choose}
                />
              ) : null}
              {currentAnalysis && editable.kind === "function" ? (
                <FunctionWorkspace
                  entry={editable.entry}
                  entries={draftGraph.nodes.map((node) => node.entry)}
                  analysis={currentAnalysis}
                  editing
                  onChange={(text) => replaceFile(editable.path, text)}
                  onError={setError}
                  onSelect={choose}
                />
              ) : null}
              {currentAnalysis && editable.kind === "source" ? (
                <SourceWorkspace
                  entry={editable.entry}
                  entries={draftGraph.nodes.map((node) => node.entry)}
                  analysis={currentAnalysis}
                  editing
                  onChange={(text) => replaceFile(editable.path, text)}
                  onError={setError}
                  onSelect={choose}
                />
              ) : null}
              {currentAnalysis && (editable.kind === "workflow" || editable.kind === "channel") ? (
                <VisualDocument
                  source={editable.entry.source}
                  analysis={currentAnalysis}
                  selection={editable.entry}
                  onChange={(text) => replaceFile(editable.path, text)}
                  onError={setError}
                />
              ) : null}
              {editable.kind === "source" ? (
                <form
                  className="playground-fire"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void fire();
                  }}
                >
                  <label htmlFor="playground-clock">Clock time</label>
                  <input
                    id="playground-clock"
                    aria-label="Clock time"
                    value={clock}
                    onChange={(event) => {
                      setClock(event.target.value);
                      rememberSample(editable, event.target.value, payload);
                    }}
                  />
                  <label htmlFor="playground-payload">Sample payload</label>
                  <textarea
                    id="playground-payload"
                    aria-label="Sample payload"
                    value={payload}
                    rows={4}
                    onChange={(event) => {
                      setPayload(event.target.value);
                      rememberSample(editable, clock, event.target.value);
                    }}
                  />
                  <p className="muted small">
                    Runs in memory at this clock. The payload stays with the draft. A function
                    without an impl records a stand-in and writes no records.
                  </p>
                  <button type="submit" disabled={!canFire(currentAnalysis, editable) || busy}>
                    {busy ? "Firing…" : "Fire source"}
                  </button>
                  {fired ? (
                    <div className="playground-result">
                      <strong>{fired.outcome === "ran" ? "Ran" : fired.outcome === "duplicate" ? "Duplicate" : fired.outcome === "skipped-overlap" ? "Skipped" : "Failed"}</strong>
                      <p className="muted small">{fired.occurrence}</p>
                      {fired.error ? <p role="alert">{fired.error}</p> : null}
                      <pre aria-label="Scheduler payload">
                        {JSON.stringify({ occurrence: fired.occurrence, source: fired.source }, null, 2)}
                      </pre>
                    </div>
                  ) : results && !busy && editable.cron ? (
                    <p>Nothing is due at this time.</p>
                  ) : null}
                </form>
              ) : null}
            </>
          ) : null}
          {!current ? <p>Select a declaration to define it.</p> : null}
          {readonly ? null : (
            <form
              className="playground-create"
              onSubmit={(event) => {
                event.preventDefault();
                addBlock(kind);
              }}
            >
              <h2>Add a declaration</h2>
              <label>
                File
                <select
                  aria-label="File"
                  value={project.currentFile}
                  onChange={(event) =>
                    setProject((currentProject) => ({ ...currentProject, currentFile: event.target.value }))
                  }
                >
                  {project.files.map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.path}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Kind
                <select aria-label="Declaration kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="resource">Resource</option>
                  <option value="function">Function</option>
                  <option value="source">Source</option>
                  <option value="workflow">Workflow</option>
                  <option value="channel">Channel</option>
                </select>
              </label>
              <label>
                Name
                <input
                  aria-label="New declaration name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
              <button type="submit">Add declaration</button>
            </form>
          )}
        </aside>
      </div>
    </div>
  );
}

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export function PlaygroundPage({
  api,
  initialTarget,
  opened,
  onUseDraft,
}: {
  api: Api;
  initialTarget?: string | undefined;
  opened?: OpenedPackage | null;
  onUseDraft?: (() => void) | undefined;
}) {
  const [tab, setTab] = useState<"graph" | "deployed">(initialTarget && !opened ? "deployed" : "graph");
  useEffect(() => {
    if (opened) setTab("graph");
    else if (initialTarget) setTab("deployed");
  }, [opened, initialTarget]);
  return (
    <div className="playground-page">
      <div className="playground-tabs" role="tablist" aria-label="Playground">
        <button type="button" role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}>
          Graph
        </button>
        <button type="button" role="tab" aria-selected={tab === "deployed"} onClick={() => setTab("deployed")}>
          Deployed environment
        </button>
      </div>
      {tab === "graph" ? (
        <PlaygroundEditor opened={opened ?? null} onUseDraft={onUseDraft} />
      ) : (
        <DeployedPlayground api={api} initialTarget={initialTarget} />
      )}
    </div>
  );
}

function DeployedPlayground({
  api,
  initialTarget,
}: {
  api: Api;
  initialTarget?: string | undefined;
}) {
  const [Playground, setPlayground] = useState<React.ComponentType<{
    api: Api;
    initialTarget?: string | undefined;
  }> | null>(null);
  useEffect(() => {
    let live = true;
    void import("./operations.js").then((module) => {
      if (live) setPlayground(() => module.FunctionPlayground);
    });
    return () => {
      live = false;
    };
  }, []);
  return Playground ? <Playground api={api} initialTarget={initialTarget} /> : <p>Loading deployed functions…</p>;
}
