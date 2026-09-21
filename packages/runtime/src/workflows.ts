/**
 * Workflows (plan §15): the portable executor for WorkflowIR.
 *
 * The step graph is compiled to a small control-flow program whose node
 * indices are stable for a pinned (version, graphHash). An instance is one
 * document advanced with optimistic versioning, so every transition — an
 * activity receipt, a consumed signal, a timeout, a terminal — is a CAS write
 * and two racing drivers can never both record an outcome. Activities are
 * invoked with the idempotency key `wf:<instance>:<version>:<step>`, so a
 * retry after a crash between the activity and its receipt replays the
 * stored result instead of re-running the effect.
 *
 * Signals go through a durable inbox keyed by (workflow, wait step, message,
 * correlation key) and are deduplicated by messageId; a signal that arrives
 * before its waiter registers is consumed when the wait step is reached.
 * Provider drivers (Cloudflare Workflows, Step Functions) call `advance` and
 * use native timers; the `sweep` here is the reference/fallback timer.
 */
import { Cause, Effect } from "effect";
import type { Wire } from "./decode.js";
import type { Envelope, Transport } from "./dispatch.js";
import type { CallContext, Engine } from "./engine.js";
import { err, ForgeError } from "./errors.js";
import type { Expr, WorkflowDecl, WorkflowStep, WorkflowTerminal } from "./model.js";
import { durationMs } from "./readmodels.js";
import { Clock, IdGen, Storage, type RuntimeServices } from "./services.js";

const KIND = "workflow";
/** System tenant holding the registry of tenants with workflow instances (no business data). */
const REGISTRY_TENANT = "_forge";

type Doc = Record<string, unknown> & { _version?: number };
export type InstanceStatus = "running" | "waiting" | "sleeping" | "completed" | "failed" | "cancelled";
export interface HistoryEntry { step: string; kind: string; at: string }
export interface Instance extends Doc {
  id: string;
  workflow: string;
  version: number;
  graphHash: string;
  status: InstanceStatus;
  input: Wire;
  bindings: Record<string, unknown>;
  pc: number;
  consumed: string[];
  history: HistoryEntry[];
  waiting?: { step: string; channel: string; message: string; correlationKey: string; dueAt?: string };
  sleeping?: { step: string; dueAt: string };
  output?: unknown;
  error?: { code: string; detail?: string };
  /** Provider driver state (e.g. a Step Functions task token for the current wait). */
  driver?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Control-flow program: one node per step; `next` is the successor index (-1 = end). */
interface Node { step: WorkflowStep; next: number; then?: number; otherwise?: number }

function compile(steps: WorkflowStep[]): Node[] {
  const nodes: Node[] = [];
  const emit = (list: WorkflowStep[], next: number): number => {
    // Build back to front so every node knows its successor.
    let entry = next;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i]!;
      const idx = nodes.length;
      if (s.kind === "choice") {
        const node: Node = { step: s, next: entry };
        nodes.push(node);
        node.then = emit(s.then, entry);
        node.otherwise = emit(s.otherwise, entry);
        entry = idx;
      } else if (s.kind === "parallel") {
        // Reference lowering runs branches in declared order; providers may run them concurrently.
        let e = entry;
        for (let b = s.branches.length - 1; b >= 0; b--) e = emit(s.branches[b]!, e);
        // The parallel node itself is a no-op jump into the first branch.
        const pidx = nodes.length;
        nodes.push({ step: s, next: e });
        entry = pidx;
      } else {
        nodes.push({ step: s, next: entry });
        entry = idx;
      }
    }
    return entry;
  };
  const entry = emit(steps, -1);
  // Reorder so that entry is 0: remap indices deterministically.
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (i: number) => {
    if (i < 0 || seen.has(i)) return;
    seen.add(i);
    order.push(i);
    const n = nodes[i]!;
    if (n.then !== undefined) visit(n.then);
    if (n.otherwise !== undefined) visit(n.otherwise);
    visit(n.next);
  };
  visit(entry);
  const remap = new Map(order.map((old, i) => [old, i]));
  const map = (i: number | undefined) => (i === undefined || i < 0 ? i : remap.get(i)!);
  return order.map((old) => {
    const n = nodes[old]!;
    const out: Node = { step: n.step, next: map(n.next) as number };
    if (n.then !== undefined) out.then = map(n.then) as number;
    if (n.otherwise !== undefined) out.otherwise = map(n.otherwise) as number;
    return out;
  });
}

/** Workflow expressions bind `input` and completed step results. */
function evalWf(e: Expr, env: Record<string, unknown>): unknown {
  switch (e.kind) {
    case "literal": {
      const l = e.literal;
      if (l.type === "bool") return l.value;
      if (l.type === "null") return null;
      if (l.type === "int") return Number(l.value);
      return l.value;
    }
    case "name": {
      let cur: unknown = env;
      for (const seg of e.path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
      return cur ?? null;
    }
    case "unary": {
      const v = evalWf(e.operand, env);
      return e.op === "!" ? !v : typeof v === "number" ? -v : v;
    }
    case "binary": {
      const l = evalWf(e.lhs, env);
      const r = evalWf(e.rhs, env);
      switch (e.op) {
        case "&&": return Boolean(l) && Boolean(r);
        case "||": return Boolean(l) || Boolean(r);
        case "==": return cmp(l, r) === 0;
        case "!=": return cmp(l, r) !== 0;
        case "<": return cmp(l, r) < 0;
        case "<=": return cmp(l, r) <= 0;
        case ">": return cmp(l, r) > 0;
        case ">=": return cmp(l, r) >= 0;
        default: return null;
      }
    }
    default:
      return null;
  }
}
/** Numeric strings (decimal/money) compare exactly as scaled integers; everything else compares canonically. */
function cmp(a: unknown, b: unknown): number {
  const num = /^-?\d+(\.\d+)?$/;
  if ((typeof a === "number" || (typeof a === "string" && num.test(a))) && (typeof b === "number" || (typeof b === "string" && num.test(b)))) {
    const [x, y] = [String(a), String(b)];
    const scale = Math.max(x.split(".")[1]?.length ?? 0, y.split(".")[1]?.length ?? 0);
    const toInt = (s: string) => { const [i, f = ""] = s.split("."); return BigInt(i + f.padEnd(scale, "0")); };
    const d = toInt(x) - toInt(y);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  const [x, y] = [String(a ?? ""), String(b ?? "")];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A provider's durable driver (Cloudflare Workflows instance, Step Functions execution).
 * `started` spawns it after the instance exists; `wake` nudges it after a signal or cancel
 * so a native wait ends without waiting for its deadline.
 */
export interface WorkflowDriver {
  started(tenant: string, wf: WorkflowDecl, instanceId: string): Promise<void>;
  wake(tenant: string, wf: WorkflowDecl, inst: Instance): Promise<void>;
}

export class Workflows {
  private readonly programs = new Map<string, Node[]>();
  /** Provider driver; absent for the reference executor (the sweep is the timer). */
  driver: WorkflowDriver | null = null;
  /** Test-only fault injection: crash after this step's activity succeeded, before its receipt. */
  readonly faults: { crashAfterStep: string | null } = { crashAfterStep: null };

  constructor(private readonly engine: Engine) {}

  private program(wf: WorkflowDecl): Node[] {
    let p = this.programs.get(wf.id);
    if (!p) { p = compile(wf.steps); this.programs.set(wf.id, p); }
    return p;
  }
  private docId(wf: WorkflowDecl, id: string): string { return `${wf.name}:${id}`; }
  private inboxId(wf: WorkflowDecl, step: string, message: string, key: string): string { return `${wf.name}:inbox:${step}:${message}:${key}`; }
  private waitersId(wf: WorkflowDecl, step: string, message: string, key: string): string { return `${wf.name}:waiters:${step}:${message}:${key}`; }
  private activeId(wf: WorkflowDecl): string { return `${wf.name}:active`; }

  // ------------------------------------------------------------ public ops
  /** Start: create the instance (idempotent per key) and run until it blocks or ends. */
  start(wf: WorkflowDecl, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const now = (yield* Clock).now();
      const keyDoc = ctx.idempotencyKey ? `${wf.name}:start:${ctx.idempotencyKey}` : null;
      if (keyDoc) {
        const existing = (yield* storage.getDocument(ctx.tenant, KIND, keyDoc)) as { instance: string } | null;
        if (existing) return yield* self.get(wf, existing.instance, ctx);
      }
      const id = (yield* IdGen).next({ name: `wf${wf.name}` } as never);
      const inst: Instance = { id, workflow: wf.id, version: wf.version, graphHash: wf.graphHash, status: "running", input, bindings: {}, pc: 0, consumed: [], history: [], createdAt: now, updatedAt: now };
      yield* storage.putDocument(ctx.tenant, KIND, self.docId(wf, id), inst, null);
      if (keyDoc) yield* storage.putDocument(ctx.tenant, KIND, keyDoc, { instance: id }, null).pipe(Effect.catch(() => Effect.void));
      yield* self.listMutate(ctx.tenant, self.activeId(wf), (ids) => [...ids, id]);
      // Hosts without a native driver sweep in-flight instances; they need to know which tenants have any.
      yield* self.listMutate(REGISTRY_TENANT, "tenants", (ids) => (ids.includes(ctx.tenant) ? ids : [...ids, ctx.tenant]));
      const state = yield* self.advance(ctx.tenant, id, wf);
      if (self.driver && ["running", "waiting", "sleeping"].includes(state["status"] as string)) {
        yield* Effect.tryPromise({ try: () => self.driver!.started(ctx.tenant, wf, id), catch: (e) => err("Internal", `workflow driver failed to start: ${String(e)}`) });
      }
      return state;
    });
  }

  get(wf: WorkflowDecl, id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const inst = (yield* (yield* Storage).getDocument(ctx.tenant, KIND, self.docId(wf, id))) as Instance | null;
      if (!inst) return yield* Effect.fail(err("NotFound", `workflow instance ${id} not found`));
      return self.render(inst);
    });
  }

  cancel(wf: WorkflowDecl, id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const inst = (yield* storage.getDocument(ctx.tenant, KIND, self.docId(wf, id))) as Instance | null;
      if (!inst) return yield* Effect.fail(err("NotFound", `workflow instance ${id} not found`));
      if (!["running", "waiting", "sleeping"].includes(inst.status)) return yield* Effect.fail(err("InvalidTransition", `instance is ${inst.status}; completed effects are not undone by cancellation`));
      const now = (yield* Clock).now();
      const next = self.finish(inst, "cancelled", now, { step: inst.waiting?.step ?? inst.sleeping?.step ?? "", kind: "cancel", at: now });
      const saved = yield* self.save(ctx.tenant, wf, inst, next).pipe(Effect.catch((e) => (e.code === "TransientConflict" ? self.cancelRetry(wf, id, ctx) : Effect.fail(e))));
      if (self.driver) yield* self.wakeDriver(ctx.tenant, wf, saved.id);
      return self.render(next);
    });
  }

  private cancelRetry(wf: WorkflowDecl, id: string, ctx: CallContext): Effect.Effect<Instance, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const inst = (yield* storage.getDocument(ctx.tenant, KIND, self.docId(wf, id))) as Instance | null;
      if (!inst) return yield* Effect.fail(err("NotFound", `workflow instance ${id} not found`));
      if (!["running", "waiting", "sleeping"].includes(inst.status)) return yield* Effect.fail(err("InvalidTransition", `instance is ${inst.status}; completed effects are not undone by cancellation`));
      const now = (yield* Clock).now();
      return yield* self.save(ctx.tenant, wf, inst, self.finish(inst, "cancelled", now, { step: inst.waiting?.step ?? inst.sleeping?.step ?? "", kind: "cancel", at: now }));
    });
  }

  /** Deliver one message to every wait step of the workflow that matches its correlation key. */
  signal(wf: WorkflowDecl, message: string, messageId: string, payload: Wire, ctx: CallContext): Effect.Effect<{ delivered: number; held: number }, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const now = (yield* Clock).now();
      let delivered = 0;
      let held = 0;
      for (const node of self.program(wf)) {
        const s = node.step;
        if (s.kind !== "wait" || s.message !== message) continue;
        const key = s.correlate ? String(payload[s.correlate.field] ?? "") : "";
        // Persist before acknowledging: the inbox is the durable record, deduplicated by messageId.
        const inboxId = self.inboxId(wf, s.id, message, key);
        const inbox = (yield* storage.getDocument(ctx.tenant, KIND, inboxId)) as (Doc & { signals: { messageId: string; payload: Wire; at: string }[] }) | null;
        if (!inbox?.signals.some((x) => x.messageId === messageId)) {
          yield* storage.putDocument(ctx.tenant, KIND, inboxId, { signals: [...(inbox?.signals ?? []), { messageId, payload, at: now }] }, inbox?._version ?? null);
        }
        const waiters = (yield* storage.getDocument(ctx.tenant, KIND, self.waitersId(wf, s.id, message, key))) as (Doc & { instances: string[] }) | null;
        let consumedHere = 0;
        for (const id of waiters?.instances ?? []) {
          const before = (yield* storage.getDocument(ctx.tenant, KIND, self.docId(wf, id))) as Instance | null;
          if (!before || before.status !== "waiting" || before.consumed.includes(messageId)) continue;
          // An incompatible deployment or a concurrent driver leaves the signal held in the inbox.
          let after = yield* self.advance(ctx.tenant, id, wf).pipe(Effect.catch(() => Effect.succeed(null as Wire | null)));
          if (!after) after = (yield* storage.getDocument(ctx.tenant, KIND, self.docId(wf, id))) as Wire | null;
          if (after && (after["consumed"] as string[]).includes(messageId)) {
            consumedHere++;
            if (self.driver) yield* self.wakeDriver(ctx.tenant, wf, id);
          }
        }
        delivered += consumedHere;
        if (consumedHere === 0) held++;
      }
      return { delivered, held };
    });
  }

  /** Reference timer: advance every active instance (due timers fire, crashed `running` instances resume). */
  sweep(tenant: string): Effect.Effect<{ advanced: number }, never, never> {
    const self = this;
    return Effect.gen(function* () {
      let advanced = 0;
      for (const wf of self.engine.model.workflows) {
        const ids = yield* self.inflight(tenant, wf);
        for (const id of ids) {
          const r = yield* self.advance(tenant, id, wf).pipe(Effect.catch(() => Effect.succeed(null)));
          if (r) advanced++;
        }
      }
      return { advanced };
    }).pipe(Effect.provide(this.engine.layer));
  }

  /** Tenants that have ever started a workflow instance (durable registry for sweep-driven hosts). */
  tenants(): Effect.Effect<string[], never, never> {
    return Effect.gen(function* () {
      const doc = (yield* (yield* Storage).getDocument(REGISTRY_TENANT, KIND, "tenants")) as { ids?: string[] } | null;
      return doc?.ids ?? [];
    }).pipe(Effect.catch(() => Effect.succeed([] as string[])), Effect.provide(this.engine.layer));
  }

  /** Ids of instances that have not reached a terminal status. */
  inflight(tenant: string, wf?: WorkflowDecl): Effect.Effect<string[], never, never> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const out: string[] = [];
      for (const w of wf ? [wf] : self.engine.model.workflows) {
        const active = (yield* storage.getDocument(tenant, KIND, self.activeId(w))) as { ids: string[] } | null;
        out.push(...(active?.ids ?? []));
      }
      return out;
    }).pipe(Effect.catch(() => Effect.succeed([] as string[])), Effect.provide(this.engine.layer));
  }

  // -------------------------------------------------------------- executor
  /** Run the instance until it blocks (wait/sleep) or ends; every transition is a CAS write. */
  advance(tenant: string, id: string, wf?: WorkflowDecl): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      let inst: Instance | null = null;
      let decl: WorkflowDecl | undefined = wf;
      for (const w of wf ? [wf] : self.engine.model.workflows) {
        inst = (yield* storage.getDocument(tenant, KIND, self.docId(w, id))) as Instance | null;
        if (inst) { decl = w; break; }
      }
      if (!inst || !decl) return yield* Effect.fail(err("NotFound", `workflow instance ${id} not found`));
      if (inst.version !== decl.version || inst.graphHash !== decl.graphHash) {
        return yield* Effect.fail(err("WorkflowVersionMismatch", `instance is pinned to ${decl.name} v${inst.version} (${inst.graphHash.slice(0, 8)}); deployed is v${decl.version} (${decl.graphHash.slice(0, 8)})`));
      }
      const program = self.program(decl);
      const docId = self.docId(decl, id);
      // Several drivers may advance one instance (an HTTP request, the provider's durable driver, the
      // sweep). Transitions are deterministic from persisted state and activities are exactly-once at
      // the storage level, so a driver that loses a CAS reloads and continues from the winner's state.
      let conflicts = 0;
      for (let guard = 0; guard < 10_000; guard++) {
        if (!["running", "waiting", "sleeping"].includes(inst.status)) break;
        const now = (yield* Clock).now();
        const node: Node | undefined = program[inst.pc];
        const attempt: Effect.Effect<Instance | null, ForgeError, RuntimeServices> = Effect.gen(function* () {
          if (!node) { // fell off the end without a terminal: complete with no output
            return yield* self.save(tenant, decl, inst!, self.finish(inst!, "completed", now, { step: "", kind: "end", at: now }));
          }
          const next: Instance | null = yield* self.step(tenant, decl, inst!, node, now);
          if (next === null) return null; // blocked
          return yield* self.save(tenant, decl, inst!, next);
        });
        const exit = yield* Effect.exit(attempt);
        if (exit._tag === "Failure") {
          const e = Cause.squash(exit.cause);
          if (e instanceof ForgeError && e.code === "TransientConflict" && ++conflicts < 50) {
            const fresh = (yield* storage.getDocument(tenant, KIND, docId)) as Instance | null;
            if (!fresh) return yield* Effect.fail(err("NotFound", `workflow instance ${id} vanished`));
            inst = fresh;
            continue;
          }
          return yield* Effect.fail(e instanceof ForgeError ? e : err("Internal", String(e)));
        }
        if (exit.value === null) break;
        inst = exit.value;
      }
      return self.render(inst);
    });
  }

  /** One node transition; returns the updated instance (unsaved) or null when blocked. */
  private step(tenant: string, wf: WorkflowDecl, inst: Instance, node: Node, now: string): Effect.Effect<Instance | null, ForgeError, RuntimeServices> {
    const self = this;
    const s = node.step;
    const env = { input: inst.input, ...inst.bindings };
    return Effect.gen(function* () {
      switch (s.kind) {
        case "call": {
          const { opId, input } = self.lower(s, env);
          const callCtx: CallContext = { tenant, actor: "workflow", requestId: `${inst.id}:${s.id}`, idempotencyKey: `wf:${inst.id}:${inst.version}:${s.id}` };
          const exit = yield* Effect.exit(self.engine.callInternal(opId, input, callCtx));
          if (exit._tag === "Failure") {
            const fe = Cause.squash(exit.cause);
            if (!(fe instanceof ForgeError)) return yield* Effect.fail(err("Internal", "workflow activity died"));
            if (fe.code === "TransientConflict") return yield* Effect.fail(fe); // another driver ran this activity: reload and continue
            const name = self.errorName(s, fe.code);
            const caught = s.catches.find((c) => c.error === name);
            const entry: HistoryEntry = { step: s.id, kind: "error", at: now };
            if (caught) return self.terminal(inst, caught.then, wf, now, entry);
            return self.finish(inst, "failed", now, entry, { code: fe.code, ...(fe.detail ? { detail: fe.detail } : {}) });
          }
          if (self.faults.crashAfterStep === s.id) return yield* Effect.fail(err("Internal", `injected crash after ${s.id}`));
          return { ...inst, status: "running", bindings: { ...inst.bindings, [s.id]: exit.value }, pc: node.next, history: [...inst.history, { step: s.id, kind: "call", at: now }] };
        }
        case "sleep": {
          if (inst.status !== "sleeping" || inst.sleeping?.step !== s.id) {
            const dueAt = new Date(Date.parse(now) + durationMs(s.duration)).toISOString();
            return { ...inst, status: "sleeping", sleeping: { step: s.id, dueAt } };
          }
          if (inst.sleeping.dueAt > now) return null;
          const { sleeping, ...rest } = inst;
          void sleeping;
          return { ...rest, status: "running", pc: node.next, history: [...inst.history, { step: s.id, kind: "sleep", at: now }] } as Instance;
        }
        case "wait": {
          const key = s.correlate ? String(evalWf(s.correlate.value, env) ?? "") : "";
          if (inst.status !== "waiting" || inst.waiting?.step !== s.id) {
            // Register the waiter first, then look at the inbox: a signal can never slip between.
            yield* self.listMutate(tenant, self.waitersId(wf, s.id, s.message, key), (ids) => (ids.includes(inst.id) ? ids : [...ids, inst.id]));
            const waiting = { step: s.id, channel: s.channel, message: s.message, correlationKey: key, ...(s.timeout ? { dueAt: new Date(Date.parse(now) + durationMs(s.timeout.duration)).toISOString() } : {}) };
            return { ...inst, status: "waiting", waiting };
          }
          const inbox = (yield* (yield* Storage).getDocument(tenant, KIND, self.inboxId(wf, s.id, s.message, key))) as { signals: { messageId: string; payload: Wire }[] } | null;
          const sig = inbox?.signals.find((x) => !inst.consumed.includes(x.messageId));
          if (sig) {
            yield* self.listMutate(tenant, self.waitersId(wf, s.id, s.message, key), (ids) => ids.filter((x) => x !== inst.id));
            const { waiting, ...rest } = inst;
            void waiting;
            return { ...rest, status: "running", pc: node.next, consumed: [...inst.consumed, sig.messageId], bindings: { ...inst.bindings, [s.id]: sig.payload }, history: [...inst.history, { step: s.id, kind: "signal", at: now }] } as Instance;
          }
          if (inst.waiting.dueAt && inst.waiting.dueAt <= now && s.timeout) {
            yield* self.listMutate(tenant, self.waitersId(wf, s.id, s.message, key), (ids) => ids.filter((x) => x !== inst.id));
            return self.terminal(inst, s.timeout.then, wf, now, { step: s.id, kind: "timeout", at: now });
          }
          return null;
        }
        case "choice": {
          const take = Boolean(evalWf(s.condition, env));
          return { ...inst, pc: (take ? node.then : node.otherwise) as number, history: [...inst.history, { step: s.id, kind: "choice", at: now }] };
        }
        case "parallel":
          return { ...inst, pc: node.next };
        case "return":
          return self.finish({ ...inst, output: evalWf(s.value, env) }, "completed", now, { step: "return", kind: "return", at: now });
        case "fail":
          return self.finish(inst, "failed", now, { step: "fail", kind: "fail", at: now }, { code: `${wf.id}.${s.error}` });
      }
    });
  }

  private terminal(inst: Instance, t: WorkflowTerminal, wf: WorkflowDecl, now: string, entry: HistoryEntry): Instance {
    const env = { input: inst.input, ...inst.bindings };
    if (t.kind === "return") return this.finish({ ...inst, output: evalWf(t.value, env) }, "completed", now, entry);
    return this.finish(inst, "failed", now, entry, { code: `${wf.id}.${t.error}` });
  }

  private finish(inst: Instance, status: InstanceStatus, now: string, entry: HistoryEntry, error?: { code: string; detail?: string }): Instance {
    const { waiting, sleeping, ...rest } = inst;
    void waiting;
    void sleeping;
    return { ...rest, status, history: [...inst.history, entry], ...(error ? { error } : {}), updatedAt: now } as Instance;
  }

  /** Function calls take the named arguments as input; transitions split `id`/`expectedVersion` from the action input. */
  private lower(s: Extract<WorkflowStep, { kind: "call" }>, env: Record<string, unknown>): { opId: string; input: Wire } {
    const args: Wire = {};
    for (const a of s.args) args[a.name] = evalWf(a.value, env);
    if (s.target.kind === "function") return { opId: s.target.function, input: args };
    const { id, expectedVersion, ...input } = args;
    return { opId: `${s.target.resource}.status.${s.target.action}`, input: { id, expectedVersion, input } };
  }

  private errorName(s: Extract<WorkflowStep, { kind: "call" }>, code: string): string {
    if (s.target.kind === "function" && code.startsWith(`${s.target.function}.`)) return code.slice(s.target.function.length + 1);
    return code;
  }

  private save(tenant: string, wf: WorkflowDecl, before: Instance, after: Instance): Effect.Effect<Instance, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const { _version, ...doc } = { ...after, updatedAt: (yield* Clock).now() };
      yield* storage.putDocument(tenant, KIND, self.docId(wf, before.id), doc, before._version ?? null).pipe(
        Effect.mapError((e) => (e.code === "VersionConflict" ? err("TransientConflict", "another driver advanced this workflow instance") : e)),
      );
      if (!["running", "waiting", "sleeping"].includes(after.status)) {
        yield* self.listMutate(tenant, self.activeId(wf), (ids) => ids.filter((x) => x !== before.id));
      }
      return { ...doc, _version: (_version ?? 0) + 1 } as Instance;
    });
  }

  /** CAS update of a small id list document (waiters, active instances). */
  private listMutate(tenant: string, docId: string, f: (ids: string[]) => string[]): Effect.Effect<void, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const storage = yield* Storage;
      for (let attempt = 0; attempt < 5; attempt++) {
        const cur = (yield* storage.getDocument(tenant, KIND, docId)) as (Doc & { ids?: string[]; instances?: string[] }) | null;
        const ids = cur?.ids ?? cur?.instances ?? [];
        const next = f(ids);
        const body = docId.includes(":waiters:") ? { instances: next } : { ids: next };
        const r = yield* storage.putDocument(tenant, KIND, docId, body, cur?._version ?? null).pipe(Effect.exit);
        if (r._tag === "Success") return;
      }
      return yield* Effect.fail(err("TransientConflict", "workflow index contention"));
    });
  }

  private render(inst: Instance): Wire {
    const { _version, driver, ...rest } = inst;
    void _version;
    void driver;
    return rest as Wire;
  }

  /** Wake the provider driver with the raw instance (driver state included); never fails the caller. */
  private wakeDriver(tenant: string, wf: WorkflowDecl, id: string): Effect.Effect<void, never, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const raw = yield* self.load(tenant, id);
      yield* Effect.promise(() => self.driver!.wake(tenant, wf, raw).catch(() => undefined));
    }).pipe(Effect.catch(() => Effect.void));
  }

  /** Provider drivers park a callback handle on the instance (CAS) while it waits. */
  setDriverState(tenant: string, id: string, state: Record<string, unknown>): Effect.Effect<void, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      for (const wf of self.engine.model.workflows) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const inst = (yield* storage.getDocument(tenant, KIND, self.docId(wf, id))) as Instance | null;
          if (!inst) break;
          const { _version, ...doc } = { ...inst, driver: { ...(inst.driver ?? {}), ...state } };
          const r = yield* Effect.exit(storage.putDocument(tenant, KIND, self.docId(wf, id), doc, _version ?? null));
          if (r._tag === "Success") return;
        }
      }
      return yield* Effect.fail(err("NotFound", `workflow instance ${id} not found`));
    });
  }

  /** Raw instance (with driver state) for provider drivers. */
  load(tenant: string, id: string): Effect.Effect<Instance, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      for (const wf of self.engine.model.workflows) {
        const inst = (yield* storage.getDocument(tenant, KIND, self.docId(wf, id))) as Instance | null;
        if (inst) return inst;
      }
      return yield* Effect.fail(err("NotFound", `workflow instance ${id} not found`));
    });
  }

  // ---------------------------------------------------------- integration
  /** Wait steps subscribe to their channel: `workflow:<Name>:<step>` logical subscriptions. */
  subscriptions(base: Record<string, string[]> = {}): Record<string, string[]> {
    const out: Record<string, string[]> = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]]));
    for (const wf of this.engine.model.workflows) {
      for (const node of this.program(wf)) {
        if (node.step.kind === "wait") (out[node.step.channel] ??= []).push(`workflow:${wf.name}:${node.step.id}`);
      }
    }
    return out;
  }

  /** In-process transport delivering channel messages to workflow inboxes. */
  transport(): Transport {
    const self = this;
    return {
      name: "workflows",
      send: (d) => {
        const m = /^workflow:([^:]+):(.+)$/.exec(d.subscription);
        const wf = m && self.engine.model.workflows.find((w) => w.name === m[1]);
        if (!wf) return Effect.fail(new Error(`unknown workflow subscription ${d.subscription}`));
        const env: Envelope = d.envelope;
        return self.signal(wf, env.message, env.messageId, env.payload as Wire, { tenant: env.tenant, actor: "channel", requestId: env.messageId }).pipe(Effect.provide(self.engine.layer), Effect.asVoid, Effect.mapError((e) => new Error(e.message)));
      },
    };
  }
}
