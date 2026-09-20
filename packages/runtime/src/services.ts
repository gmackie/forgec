/** Runtime services (Effect 4): clock, id generation, storage, cursor secret. */
import { Context, Effect } from "effect";
import type { ForgeError } from "./errors.js";
import type { Field, List, Resource, Unique } from "./model.js";

export type StoredRecord = Record<string, unknown>;

export interface AuditEntry {
  tenant: string;
  opId: string;
  resource: string;
  recordId: string;
  kind: string;
  newVersion: number | null;
  actor: string;
  at: string;
  payload?: unknown;
}
export interface OutboxEntry {
  tenant: string;
  opId: string;
  ordinal: number;
  channel: string;
  message: string;
  payload: unknown;
  createdAt: string;
}
export interface Receipt {
  tenant: string;
  operation: string;
  key: string;
  requestHash: string;
  status: number;
  response: unknown;
  createdAt: string;
}
export interface ClaimChange {
  unique: Unique;
  /** Encoded claim keys before/after (null when the record had/has no claim). */
  before: string | null;
  after: string | null;
}
export interface ReferenceGuard {
  field: string;
  resource: Resource;
  id: string;
}
/** A restrict-delete check: no live child of `resource` may reference this record through `field`. */
export interface DependentGuard {
  resource: Resource;
  field: string;
}
export interface CommitPlan {
  tenant: string;
  opId: string;
  actor: string;
  at: string;
  resource: Resource;
  kind: "create" | "update" | "delete" | "restore" | "transition";
  id: string;
  expectedVersion: number | null;
  before: StoredRecord | null;
  after: StoredRecord;
  claims: ClaimChange[];
  references: ReferenceGuard[];
  /** Populated for deletes of a resource that others reference. */
  dependents: DependentGuard[];
  /** True when the row is physically removed (no @softDelete). */
  hardDelete: boolean;
  audit: AuditEntry;
  outbox: OutboxEntry[];
  receipt?: Receipt;
}

export interface ListQuery {
  list: List;
  values: Record<string, unknown>;
  /** Last item of the previous page: encoded sort keys (sort.v1), raw order-field values, and id. */
  after: { keys: string[]; values: unknown[]; id: string } | null;
  limit: number;
}

export interface StorageAdapter {
  readonly name: string;
  get(tenant: string, resource: Resource, id: string): Effect.Effect<StoredRecord | null, ForgeError>;
  findUnique(tenant: string, resource: Resource, unique: Unique, claimKey: string, values: Record<string, unknown>): Effect.Effect<StoredRecord | null, ForgeError>;
  list(tenant: string, resource: Resource, q: ListQuery, sortKeys: (r: StoredRecord) => string[]): Effect.Effect<{ records: StoredRecord[]; hasMore: boolean }, ForgeError>;
  /** Number of live records of `child` whose `field` references `id` (bounded: adapters may stop at 1). */
  countDependents(tenant: string, child: Resource, field: string, id: string): Effect.Effect<number, ForgeError>;
  getReceipt(tenant: string, operation: string, key: string): Effect.Effect<Receipt | null, ForgeError>;
  /** Atomic: record + claims + reference guards + audit + outbox + receipt, or nothing. */
  commit(plan: CommitPlan): Effect.Effect<void, ForgeError>;
  /** Atomic across several plans (a changeset within the physical budget). Adapters report their budget. */
  commitAll(plans: CommitPlan[]): Effect.Effect<void, ForgeError>;
  /** Physical actions one plan will consume, and the adapter's per-transaction ceiling. */
  budget(plans: CommitPlan[]): { actions: number; limit: number };
  /** Opaque JSON documents keyed by (tenant, kind, id): changesets, jobs, import staging. */
  getDocument(tenant: string, kind: string, id: string): Effect.Effect<Record<string, unknown> | null, ForgeError>;
  putDocument(tenant: string, kind: string, id: string, doc: Record<string, unknown>, expectedVersion: number | null): Effect.Effect<void, ForgeError>;
}

export class Clock extends Context.Service<Clock, { now(): string }>()("forge/Clock") {}
export class IdGen extends Context.Service<IdGen, { next(resource: Resource): string; opId(): string }>()("forge/IdGen") {}
export class Storage extends Context.Service<Storage, StorageAdapter>()("forge/Storage") {}
export class CursorSecret extends Context.Service<CursorSecret, { key: string }>()("forge/CursorSecret") {}

export type RuntimeServices = Clock | IdGen | Storage | CursorSecret;
export type { Field };
