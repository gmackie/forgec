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
}
export interface Unique { name: string; fields: string[]; within: string[] }
export interface Find { name: string; fields: string[]; coveredBy: string }
export interface OrderKey { field: string; direction: string }
export interface List { name: string; fields: string[]; order: OrderKey[] }
export interface Transition { action: string; from: string[]; to: string; input: Field[] }
export interface Lifecycle { field: string; enumId: string; states: string[]; initial: string; terminals: string[]; transitions: Transition[] }
export interface HttpBinding { method: string; path: string }
export interface Operation { id: string; kind: string; query?: string; action?: string; http?: HttpBinding }
export interface Resource {
  id: string;
  name: string;
  decorators: { tenant: boolean; timestamps: boolean; softDelete: boolean; versioned: boolean; audited: boolean; crud?: { path: string; operations?: string[]; actions: string[] } };
  fields: Field[];
  uniques: Unique[];
  finds: Find[];
  lists: List[];
  rules: Expr[];
  lifecycle?: Lifecycle;
  operations: Operation[];
}
export interface EnumDecl { id: string; name: string; members: { name: string; value: string }[] }
export interface Module { id: string; enums: EnumDecl[]; resources: Resource[] }
export interface DomainIR { version: string; package: { name: string }; modules: Module[] }
export interface Contracts { version: string; resources: { id: string; name: string; wireName: string; operations: Operation[] }[]; functions: { id: string; name: string; http?: HttpBinding }[] }
export interface AppBundle { version: string; buildHash: string; ir: DomainIR; contracts: Contracts; sql: unknown; dynamo: unknown }

export interface OperationRef {
  op: Operation;
  resource: Resource;
}

export class Model {
  readonly resources: Resource[];
  readonly enums = new Map<string, EnumDecl>();
  private readonly byId = new Map<string, Resource>();
  private readonly ops = new Map<string, OperationRef>();
  readonly wireNames = new Map<string, string>();

  constructor(readonly bundle: AppBundle) {
    this.resources = bundle.ir.modules.flatMap((m) => m.resources);
    for (const m of bundle.ir.modules) for (const e of m.enums) this.enums.set(e.id, e);
    for (const r of this.resources) {
      this.byId.set(r.id, r);
      for (const op of r.operations) this.ops.set(op.id, { op, resource: r });
    }
    for (const c of bundle.contracts.resources) this.wireNames.set(c.id, c.wireName);
  }

  resource(id: string): Resource {
    const r = this.byId.get(id);
    if (!r) throw new Error(`unknown resource ${id}`);
    return r;
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
