/**
 * Typed view over the compiled app bundle (`forge build` output). The runtime
 * interprets this model; it never re-derives semantics from source.
 */

export interface TypeSpec {
  base: TypeBase;
  optional: boolean;
  normalizers: string[];
  constraints: Constraint[];
}
export type TypeBase =
  | { kind: "scalar"; name: string; args: string[] }
  | { kind: "enum"; id: string }
  | { kind: "shape"; id: string }
  | { kind: "reference"; resource: string }
  | { kind: "record"; resource: string }
  | { kind: "identity"; resource: string }
  | { kind: "status"; resource: string }
  | { kind: "message"; channel: string; message: string };
export type Constraint =
  | { kind: "length"; min?: number; max?: number }
  | { kind: "compare"; op: string; value: Literal }
  | { kind: "pattern"; value: string };
export type Literal =
  | { type: "int"; value: string }
  | { type: "decimal"; value: string }
  | { type: "string"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "null" }
  | { type: "duration"; value: string }
  | { type: "percent"; value: string }
  | { type: "enumMember"; value: { enum: string; member: string } };
export type Expr =
  | { kind: "binary"; op: string; lhs: Expr; rhs: Expr }
  | { kind: "unary"; op: string; operand: Expr }
  | { kind: "name"; path: string[] }
  | { kind: "literal"; literal: Literal }
  | { kind: "call"; callee: string[]; args: Expr[] };

export interface Field {
  name: string;
  type: TypeSpec;
  default?: Literal;
  derived?: Expr;
  immutable: boolean;
  serverOwned: boolean;
  synthesized: boolean;
  hidden?: boolean;
}
export interface Unique { name: string; fields: string[]; within: string[] }
export interface Find { name: string; fields: string[]; coveredBy: string }
export interface OrderKey { field: string; direction: string }
export interface List { name: string; fields: string[]; order: OrderKey[] }
export interface Transition { action: string; from: string[]; to: string; input: Field[] }
export interface Lifecycle { field: string; enumId: string; states: string[]; initial: string; terminals: string[]; transitions: Transition[] }
export interface HttpBinding { method: string; path: string }
export interface Operation { id: string; kind: string; query?: string; action?: string; http?: HttpBinding }
export interface ContentPolicy { mediaTypes: string[]; maxBytes: number }
export interface Resource {
  id: string;
  name: string;
  kind: "resource" | "blob";
  content?: ContentPolicy;
  decorators: { tenant: boolean; timestamps: boolean; softDelete: boolean; versioned: boolean; audited: boolean; hierarchical?: boolean; effectiveDated?: { uniqueBy: string[] }; crud?: { path: string; operations?: string[]; actions: string[] }; purposeScoped?: boolean; subject?: { binding: "kind"; kind: string } | { binding: "from"; field: string }; recordContext?: string };
  fields: Field[];
  uniques: Unique[];
  finds: Find[];
  lists: List[];
  rules: Expr[];
  lifecycle?: Lifecycle;
  operations: Operation[];
}
export interface EnumDecl { id: string; name: string; members: { name: string; value: string }[] }
export interface FunctionDecl {
  id: string;
  name: string;
  input?: TypeSpec;
  output?: TypeSpec;
  uses: ({ kind: "resource"; resource: string; capability: string } | { kind: "transition"; resource: string; action: string } | { kind: "function"; function: string })[];
  sends: { message: string; channel: string }[];
  errors: string[];
  http?: HttpBinding;
  generated: boolean;
}
export interface WebSocketBinding { path: string }
export interface ChannelDecl { id: string; name: string; contract?: string; direction?: string; websocket?: WebSocketBinding; messages: { name: string; fields: Field[] }[] }
export interface ViewDecl { id: string; name: string; source: string; by: string[]; where?: Expr; order: OrderKey[]; fields: string[] }
export interface AggregateDecl { function: "count" | "sum" | "min" | "max"; field: string; alias: string; scale?: number }
export interface ProjectionDecl { id: string; name: string; source: string; by: string[]; where?: Expr; aggregates: AggregateDecl[]; crud?: { path: string; operations?: string[]; actions: string[] } }
export interface CacheDecl { id: string; name: string; keys: Field[]; loader: Expr; freshUntil: Expr; staleUntil?: Expr }
export type WorkflowTerminal = { kind: "return"; value: Expr } | { kind: "fail"; error: string };
export type WorkflowStep =
  | { kind: "call"; id: string; target: { kind: "function"; function: string } | { kind: "transition"; resource: string; action: string }; args: { name: string; value: Expr }[]; catches: { error: string; then: WorkflowTerminal }[] }
  | { kind: "sleep"; id: string; duration: string }
  | { kind: "wait"; id: string; channel: string; message: string; correlate?: { field: string; value: Expr }; timeout?: { duration: string; then: WorkflowTerminal } }
  | { kind: "choice"; id: string; condition: Expr; then: WorkflowStep[]; otherwise: WorkflowStep[] }
  | { kind: "parallel"; id: string; branches: WorkflowStep[][] }
  | { kind: "return"; value: Expr }
  | { kind: "fail"; error: string };
export interface WorkflowDecl { id: string; name: string; version: number; graphHash: string; input?: TypeSpec; output?: TypeSpec; errors: string[]; http?: HttpBinding; steps: WorkflowStep[] }
export interface SchedulesPlan { version: string; schedules: { source: string; name: string; target: string; cloudflare: { cron?: string; tick: boolean }; aws: { expression: string; timezone: string } }[]; cloudflareCrons: string[] }
export interface RealtimePlan { version: string; profile: { frame: string; maxFrameBytes: number; replayDepth: number; delivery: string; heartbeatSeconds: number }; streams: { channel: string; name: string; path: string; messages: string[] }[]; cloudflare: { binding: string; className: string }; aws: { apiName: string; routes: string[] } }
export interface ObservabilityPlan { version: string; dimensions: string[]; classification: Record<string, string>; window: string; operations: { operation: string; kind: string; resource?: string; class: string; slo: { availability: string; latencyGood: string; latencyWithinMs: number; window: string }; histogramBoundariesMs: number[]; businessErrors: string[] }[] }
export interface WorkflowsPlan { version: string; workflows: { id: string; name: string; version: number; graphHash: string; cloudflare: { name: string; binding: string; className: string }; aws: { stateMachine: string; definition: unknown } }[] }
export interface SourceDecl { id: string; name: string; cron?: string; timezone?: string; target: string }
export interface Module { id: string; enums: EnumDecl[]; resources: Resource[]; functions: FunctionDecl[]; channels: ChannelDecl[]; views?: ViewDecl[]; projections?: ProjectionDecl[]; caches?: CacheDecl[]; workflows?: WorkflowDecl[]; sources?: SourceDecl[]; purposes?: PurposeDecl[]; dataClasses?: DataClassDecl[] }
export interface MessagingPlan {
  channels: { id: string; name: string; implicit: boolean; direction?: string; messages: { name: string }[] }[];
  subscriptions: { name: string; channel: string; message: string; handler: string; queue: string }[];
  senders: { function: string; sends: [string, string][] }[];
}
export interface PurposeDecl { id: string; name: string; exported: boolean; extends?: string }
export interface DataClassDecl { id: string; name: string; exported: boolean; extends: string }
/** Critical IR features this runtime understands; unknown `requires` entries fail closed (plan §4.2). */
export const KNOWN_FEATURES = ["governance/1"];
export const DOMAIN_IR_VERSION = "domain-ir/1";
export interface DomainIR { version: string; package: { name: string; version: string; edition?: string; profile?: string }; modules: Module[]; requires?: string[] }
export interface DataSemanticsPlan { version: string; taxonomy: string; fields: { resource: string; field: string; class: string; ancestors: string[]; kinds: string[]; identifiability: string; handling: string; personal: string; evidence: string; completeness: string }[]; subjects: { resource: string; kind: string; via?: string; accessPath?: string; recordContext?: string }[]; summary: Record<string, number> }
export interface Contracts { version: string; resources: { id: string; name: string; wireName: string; operations: Operation[] }[]; functions: { id: string; name: string; http?: HttpBinding }[] }
export interface AppBundle { version: string; buildHash: string; digests?: Record<string, string>; openapi?: unknown; ir: DomainIR; contracts: Contracts; sql: unknown; dynamo: unknown; ui?: unknown; messaging?: MessagingPlan; workflows?: WorkflowsPlan; schedules?: SchedulesPlan; realtime?: RealtimePlan; observability?: ObservabilityPlan; dataSemantics?: DataSemanticsPlan; lineage?: unknown }

export interface OperationRef {
  op: Operation;
  resource: Resource;
}

export class Model {
  readonly resources: Resource[];
  readonly functions: FunctionDecl[];
  readonly channels: ChannelDecl[];
  readonly views: ViewDecl[];
  readonly projections: ProjectionDecl[];
  readonly caches: CacheDecl[];
  readonly workflows: WorkflowDecl[];
  readonly sources: SourceDecl[];
  readonly enums = new Map<string, EnumDecl>();
  private readonly byId = new Map<string, Resource>();
  private readonly ops = new Map<string, OperationRef>();
  readonly wireNames = new Map<string, string>();

  readonly purposes: PurposeDecl[];
  readonly dataClasses: DataClassDecl[];

  constructor(readonly bundle: AppBundle) {
    // Fail closed (plan §4.2): an artifact from a newer compiler with critical semantics this
    // runtime does not know is refused rather than interpreted partially. An M8 bundle (no
    // `requires`, no governance fields) loads by rule: every new field defaults to empty.
    if (bundle.ir.version !== DOMAIN_IR_VERSION) throw new Error(`unsupported IR version ${bundle.ir.version} (this runtime reads ${DOMAIN_IR_VERSION})`);
    const unknown = (bundle.ir.requires ?? []).find((f) => !KNOWN_FEATURES.includes(f));
    if (unknown) throw new Error(`bundle requires unknown critical feature ${unknown}; refusing to run it partially`);
    this.purposes = bundle.ir.modules.flatMap((m) => m.purposes ?? []);
    this.dataClasses = bundle.ir.modules.flatMap((m) => m.dataClasses ?? []);
    this.resources = bundle.ir.modules.flatMap((m) => m.resources);
    this.functions = bundle.ir.modules.flatMap((m) => m.functions ?? []);
    this.channels = bundle.ir.modules.flatMap((m) => m.channels ?? []);
    this.views = bundle.ir.modules.flatMap((m) => m.views ?? []);
    this.projections = bundle.ir.modules.flatMap((m) => m.projections ?? []);
    this.caches = bundle.ir.modules.flatMap((m) => m.caches ?? []);
    this.workflows = bundle.ir.modules.flatMap((m) => m.workflows ?? []);
    this.sources = bundle.ir.modules.flatMap((m) => m.sources ?? []);
    for (const m of bundle.ir.modules) for (const e of m.enums) this.enums.set(e.id, e);
    for (const r of this.resources) {
      this.byId.set(r.id, r);
      for (const op of r.operations) this.ops.set(op.id, { op, resource: r });
    }
    for (const c of bundle.contracts.resources) this.wireNames.set(c.id, c.wireName);
  }

  /** (child resource, field) pairs that reference `resourceId`. */
  dependentsOf(resourceId: string): { resource: Resource; field: string }[] {
    const out: { resource: Resource; field: string }[] = [];
    for (const r of this.resources) {
      for (const f of r.fields) {
        if (f.type.base.kind === "reference" && f.type.base.resource === resourceId && (!f.synthesized || f.name === "parent")) out.push({ resource: r, field: f.name });
      }
    }
    return out;
  }

  resource(id: string): Resource {
    const r = this.byId.get(id);
    if (!r) throw new Error(`unknown resource ${id}`);
    return r;
  }
  function(id: string): FunctionDecl | undefined {
    return this.functions.find((f) => f.id === id);
  }
  /** Resolve a channel by stable id or local name (declared or implicit `<Resource>.changes`). */
  channel(ref: string): { id: string; messages: string[]; direction?: string } | undefined {
    const declared = this.channels.find((c) => c.id === ref || c.name === ref);
    if (declared) return { id: declared.id, messages: declared.messages.map((m) => m.name), ...(declared.direction ? { direction: declared.direction } : {}) };
    const planned = this.bundle.messaging?.channels.find((c) => c.id === ref || c.name === ref);
    return planned ? { id: planned.id, messages: planned.messages.map((m) => m.name), ...(planned.direction ? { direction: planned.direction } : {}) } : undefined;
  }
  subscription(name: string) {
    return this.bundle.messaging?.subscriptions.find((s) => s.name === name);
  }
  operation(id: string): OperationRef | undefined {
    return this.ops.get(id);
  }
  wireName(resourceId: string): string {
    return this.wireNames.get(resourceId) ?? resourceId;
  }
  /** Operations that carry an HTTP binding, in a stable order. */
  httpOperations(): OperationRef[] {
    return [...this.ops.values()].filter((o) => o.op.http);
  }
  enumValues(id: string): string[] {
    return this.enums.get(id)?.members.map((m) => m.value) ?? [];
  }
}

export function fieldOf(r: Resource, name: string): Field | undefined {
  return r.fields.find((f) => f.name === name);
}

/** Scale used for a decimal/money field's minor-unit arithmetic and sort keys. */
export function scaleOf(t: TypeSpec): number {
  if (t.base.kind !== "scalar") return 0;
  if (t.base.name === "money") {
    const cur = t.base.args[0] ?? "USD";
    return ({ JPY: 0, KRW: 0, CLP: 0, KWD: 3, BHD: 3 } as Record<string, number>)[cur] ?? 2;
  }
  if (t.base.name === "decimal") return Number(t.base.args[0] ?? 2);
  return 0;
}
