/** Bounded Git object preparation using Web Crypto. No filesystem, subprocesses or ref writes. */
import type { CallContext } from "../engine.js";
import type { ArtifactRevisionPin } from "../versioned-artifacts.js";
import type {
  ArtifactDifference,
  ArtifactFileChange,
  ArtifactWorkspaceAuthorization,
} from "./artifact-workspace-git.js";
import { err, ForgeError } from "../errors.js";

export interface WorkerGitObject {
  readonly type: "blob" | "tree" | "commit";
  readonly bytes: Uint8Array;
}
/** Server-selected immutable object database. write must not update refs. */
export interface WorkerGitObjectStore {
  /** `type` is the kind the caller expects; stores may use it to pick a lookup. */
  read(
    oid: string,
    type?: WorkerGitObject["type"],
  ): Promise<WorkerGitObject | null>;
  write(object: WorkerGitObject): Promise<string>;
  /** Stores that cannot return raw commit bytes (the Artifacts binding exposes
   * parsed commits) provide this instead. The store is authoritative for its own
   * commit IDs; trees and blobs are still verified against their IDs. */
  readCommit?(oid: string): Promise<WorkerGitCommit | null>;
}
export interface WorkerGitCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  /** Committer time in seconds; orders the merge-base walk. */
  readonly time: number;
}
export interface WorkerGitIdentity {
  readonly name: string;
  readonly email: string;
}
export interface WorkerArtifactBinding {
  readonly tenant: string;
  readonly artifact: string;
  readonly generation: string;
  readonly repositoryId: string;
  readonly objectFormat: "sha1";
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const oidValid = (v: string) => /^[a-f0-9]{40}$/.test(v);
const identity = (v: string) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 1024 &&
  !/[\x00-\x1f\x7f]/.test(v);
const pathValid = (v: string) =>
  identity(v) &&
  decoder.decode(encoder.encode(v)) === v &&
  !v.startsWith("/") &&
  !v.includes("\\") &&
  v
    .split("/")
    .every((p) => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git") &&
  v.split("/").length <= 64;
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
async function hash(object: WorkerGitObject): Promise<string> {
  const data = concat([
    encoder.encode(`${object.type} ${object.bytes.length}\0`),
    object.bytes,
  ]);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", data)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
/** Tree, parents and committer time from raw commit bytes. */
export function parseWorkerGitCommit(raw: Uint8Array): WorkerGitCommit {
  const headers = decoder.decode(raw).split("\n\n", 1)[0]!.split("\n");
  const tree = /^tree ([a-f0-9]{40})$/.exec(headers[0] ?? "")?.[1];
  if (!tree) throw err("ValidationFailed", "Invalid Git commit");
  const parents: string[] = [];
  let time = 0;
  for (const line of headers.slice(1)) {
    const parent = /^parent ([a-f0-9]{40})$/.exec(line);
    if (parent) parents.push(parent[1]!);
    const committer = /^committer .* (\d+) [+-]\d{4}$/.exec(line);
    if (committer) time = Number(committer[1]);
  }
  return Object.freeze({ tree, parents: Object.freeze(parents), time });
}
interface Entry {
  mode: string;
  oid: string;
}
/** A loaded tree level. Subtrees stay as their oid until a change reaches them. */
interface Tree {
  files: Map<string, Entry>;
  trees: Map<string, Tree | string>;
  /** Original oid; reused unchanged when nothing below was modified. */
  oid?: string;
  dirty: boolean;
}
const tree = (): Tree => ({ files: new Map(), trees: new Map(), dirty: true });
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const hex = (raw: Uint8Array) =>
  Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
const rawOid = (oid: string) =>
  Uint8Array.from(oid.match(/../g)!, (x) => parseInt(x, 16));
/** Git tree order: names compare bytewise, directories as if suffixed by "/". */
function treeOrder<T extends { name: string; mode: string }>(
  entries: readonly T[],
): T[] {
  return entries
    .map((entry) => ({
      entry,
      key: encoder.encode(entry.name + (entry.mode === "40000" ? "/" : "")),
    }))
    .sort((a, b) => {
      for (let i = 0; i < Math.min(a.key.length, b.key.length); i++)
        if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
      return a.key.length - b.key.length;
    })
    .map(({ entry }) => entry);
}
export function encodeWorkerGitTree(
  entries: readonly { name: string; mode: string; oid: string }[],
): Uint8Array<ArrayBuffer> {
  return concat(
    treeOrder(entries).map(({ name, mode, oid }) =>
      concat([encoder.encode(`${mode} ${name}\0`), rawOid(oid)]),
    ),
  );
}
const identityValid = (who: WorkerGitIdentity) =>
  identity(who.name) &&
  identity(who.email) &&
  !/[<>]/.test(who.name + who.email) &&
  who.name.trim() === who.name &&
  who.email.trim() === who.email;
const DEFAULT_IDENTITY: WorkerGitIdentity = Object.freeze({
  name: "Forge artifact",
  email: "artifact@forge.invalid",
});
interface Budget {
  readBytes: number;
  entries: number;
}
/** SHA-1 matches Artifacts' Git object format; it is not an authentication digest. */
export class WorkerArtifactWorkspace {
  private readonly binding: Readonly<WorkerArtifactBinding>;
  constructor(
    binding: WorkerArtifactBinding,
    private readonly store: WorkerGitObjectStore,
    private readonly authorize: (
      request: Readonly<ArtifactWorkspaceAuthorization>,
    ) => Promise<boolean>,
  ) {
    if (
      ![
        binding.tenant,
        binding.artifact,
        binding.generation,
        binding.repositoryId,
      ].every(identity) ||
      binding.objectFormat !== "sha1"
    )
      throw err("ValidationFailed", "Invalid Worker artifact binding");
    this.binding = Object.freeze({ ...binding });
  }
  private async admit(
    ctx: Readonly<CallContext>,
    action: ArtifactWorkspaceAuthorization["action"],
  ) {
    if (ctx.tenant !== this.binding.tenant || !identity(ctx.actor))
      throw err("NotPermitted", "Artifact workspace access is not permitted");
    let allowed = false;
    try {
      allowed = await this.authorize(
        Object.freeze({
          action,
          tenant: ctx.tenant,
          actor: ctx.actor,
          artifact: this.binding.artifact,
          generation: this.binding.generation,
          ...(ctx.purpose === undefined ? {} : { purpose: ctx.purpose }),
        }),
      );
    } catch {
      throw err("NotPermitted", "Artifact workspace access is not permitted");
    }
    if (!allowed)
      throw err("NotPermitted", "Artifact workspace access is not permitted");
  }
  private pinned(pin: ArtifactRevisionPin) {
    if (
      Object.entries(this.binding).some(
        ([k, v]) => pin[k as keyof WorkerArtifactBinding] !== v,
      )
    )
      throw err("VersionConflict", "Artifact workspace binding changed");
    if (!oidValid(pin.oid) || !oidValid(pin.tree))
      throw err("ValidationFailed", "Invalid artifact revision pin");
  }
  private metadata(
    message: unknown,
    at: unknown,
    author: WorkerGitIdentity | undefined,
  ): WorkerGitIdentity {
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 8192 ||
      message.includes("\0") ||
      typeof at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(at) ||
      !Number.isFinite(Date.parse(at))
    )
      throw err("ValidationFailed", "Invalid artifact commit metadata");
    if (author === undefined) return DEFAULT_IDENTITY;
    const who = Object.freeze({ name: author?.name, email: author?.email });
    if (!identityValid(who as WorkerGitIdentity))
      throw err("ValidationFailed", "Invalid artifact commit identity");
    return who as WorkerGitIdentity;
  }
  private async read(
    oid: string,
    type: WorkerGitObject["type"],
    budget: Budget,
  ): Promise<Uint8Array> {
    if (!oidValid(oid))
      throw err("ValidationFailed", "Invalid artifact object ID");
    let object: WorkerGitObject | null;
    try {
      object = await this.store.read(oid, type);
    } catch {
      throw err("DependencyUnavailable", "Artifact object read failed");
    }
    if (!object) throw err("NotFound", "Artifact object is unavailable");
    if (object.type !== type || !(object.bytes instanceof Uint8Array))
      throw err("ValidationFailed", "Invalid artifact object");
    budget.readBytes += object.bytes.length;
    if (budget.readBytes > 32 * 1024 * 1024)
      throw err("BudgetExceeded", "Artifact base exceeds byte budget");
    const snapshot = { type: object.type, bytes: new Uint8Array(object.bytes) };
    if ((await hash(snapshot)) !== oid)
      throw err("ValidationFailed", "Artifact object does not match its ID");
    return snapshot.bytes;
  }
  private async commitOf(
    oid: string,
    budget: Budget,
  ): Promise<WorkerGitCommit> {
    if (!oidValid(oid))
      throw err("ValidationFailed", "Invalid artifact object ID");
    if (this.store.readCommit) {
      let commit: WorkerGitCommit | null;
      try {
        commit = await this.store.readCommit(oid);
      } catch {
        throw err("DependencyUnavailable", "Artifact object read failed");
      }
      if (!commit) throw err("NotFound", "Artifact object is unavailable");
      if (
        !oidValid(commit.tree) ||
        !Array.isArray(commit.parents) ||
        !commit.parents.every(oidValid) ||
        !Number.isFinite(commit.time)
      )
        throw err("ValidationFailed", "Invalid artifact object");
      return Object.freeze({
        tree: commit.tree,
        parents: Object.freeze([...commit.parents]),
        time: commit.time,
      });
    }
    return parseWorkerGitCommit(await this.read(oid, "commit", budget));
  }
  /** One tree level; subtrees stay unloaded. */
  private async load(oid: string, budget: Budget): Promise<Tree> {
    const bytes = await this.read(oid, "tree", budget),
      result: Tree = { files: new Map(), trees: new Map(), oid, dirty: false };
    let offset = 0;
    while (offset < bytes.length) {
      if (++budget.entries > 1024)
        throw err("BudgetExceeded", "Artifact base exceeds entry budget");
      const space = bytes.indexOf(32, offset),
        end = bytes.indexOf(0, space + 1);
      if (space < offset || end < space || end + 21 > bytes.length)
        throw err("ValidationFailed", "Invalid Git tree");
      let mode: string, name: string;
      try {
        mode = decoder.decode(bytes.subarray(offset, space));
        name = decoder.decode(bytes.subarray(space + 1, end));
      } catch {
        throw err(
          "ValidationFailed",
          "Artifact tree contains a non-UTF-8 path",
        );
      }
      if (
        !pathValid(name) ||
        name.includes("/") ||
        result.files.has(name) ||
        result.trees.has(name)
      )
        throw err("ValidationFailed", "Invalid Git tree path");
      const child = hex(bytes.subarray(end + 1, end + 21));
      if (mode === "40000") result.trees.set(name, child);
      else if (["100644", "100755", "120000", "160000"].includes(mode))
        result.files.set(name, { mode, oid: child });
      else throw err("ValidationFailed", "Unsupported Git tree mode");
      offset = end + 21;
    }
    return result;
  }
  private async subtree(
    node: Tree,
    name: string,
    budget: Budget,
    depth: number,
  ): Promise<Tree | undefined> {
    if (depth > 64)
      throw err("BudgetExceeded", "Artifact tree exceeds depth budget");
    const child = node.trees.get(name);
    if (typeof child !== "string") return child;
    const loaded = await this.load(child, budget);
    node.trees.set(name, loaded);
    return loaded;
  }
  private async flush(prepared: Map<string, WorkerGitObject>) {
    for (const [expected, object] of prepared) {
      let actual: string;
      try {
        actual = await this.store.write({
          type: object.type,
          bytes: new Uint8Array(object.bytes),
        });
      } catch (error) {
        if (error instanceof ForgeError && error.code === "BudgetExceeded")
          throw error;
        throw err("DependencyUnavailable", "Artifact object write failed");
      }
      if (actual !== expected)
        throw err(
          "ValidationFailed",
          "Artifact store substituted a prepared object",
        );
    }
  }
  private async commitObject(
    add: (type: WorkerGitObject["type"], bytes: Uint8Array) => Promise<string>,
    treeOid: string,
    parents: readonly string[],
    message: string,
    at: string,
    author: WorkerGitIdentity,
  ) {
    const who = `${author.name} <${author.email}> ${Date.parse(at) / 1000} +0000`;
    return add(
      "commit",
      encoder.encode(
        `tree ${treeOid}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${who}\ncommitter ${who}\n\n${message}\n`,
      ),
    );
  }
  async prepare(
    input: {
      base: ArtifactRevisionPin | null;
      changes: readonly ArtifactFileChange[];
      message: string;
      at: string;
      /** Author and committer; defaults to the Forge artifact identity. */
      author?: WorkerGitIdentity;
    },
    context: CallContext,
  ): Promise<ArtifactRevisionPin> {
    const base = input.base === null ? null : Object.freeze({ ...input.base });
    const message = input.message,
      at = input.at,
      ctx = Object.freeze({ ...context });
    if (!Array.isArray(input.changes) || input.changes.length > 1024)
      throw err("BudgetExceeded", "Artifact change count exceeds budget");
    const paths = new Set<string>();
    let changedBytes = 0;
    const changes = input.changes.map((c) => {
      if (
        !pathValid(c.path) ||
        paths.has(c.path) ||
        ![undefined, "100644", "100755"].includes(c.mode) ||
        (c.bytes !== null && !(c.bytes instanceof Uint8Array))
      )
        throw err("ValidationFailed", "Invalid artifact file change");
      paths.add(c.path);
      changedBytes += c.bytes?.length ?? 0;
      if (changedBytes > 32 * 1024 * 1024)
        throw err("BudgetExceeded", "Artifact changes exceed byte budget");
      return {
        path: c.path,
        mode: c.mode ?? "100644",
        bytes: c.bytes === null ? null : new Uint8Array(c.bytes),
      };
    });
    const author = this.metadata(message, at, input.author);
    await this.admit(ctx, "prepare");
    const budget: Budget = { readBytes: 0, entries: 0 };
    let root = tree();
    if (base) {
      this.pinned(base);
      if ((await this.commitOf(base.oid, budget)).tree !== base.tree)
        throw err(
          "ValidationFailed",
          "Artifact commit does not match pinned tree",
        );
      root = await this.load(base.tree, budget);
    }
    const prepared = new Map<string, WorkerGitObject>();
    const add = async (type: WorkerGitObject["type"], bytes: Uint8Array) => {
      const object = { type, bytes },
        oid = await hash(object);
      prepared.set(oid, object);
      return oid;
    };
    // Deletions precede replacements so file/directory transitions are independent of input order.
    const ordered = [
      ...changes.filter((c) => c.bytes === null),
      ...changes.filter((c) => c.bytes !== null),
    ];
    const prune = (node: Tree) => {
      for (const [name, child] of node.trees) {
        if (typeof child === "string") continue;
        prune(child);
        if (!child.files.size && !child.trees.size) {
          node.trees.delete(name);
          node.dirty = true;
        }
      }
    };
    let pruned = false;
    for (const c of ordered) {
      if (c.bytes !== null && !pruned) {
        prune(root);
        pruned = true;
      }
      const parts = c.path.split("/"),
        name = parts.pop()!;
      const trail: Tree[] = [root];
      let node = root,
        missing = false;
      for (const part of parts) {
        if (node.files.has(part))
          throw err("ValidationFailed", "Artifact path conflicts with a file");
        let child = await this.subtree(node, part, budget, trail.length);
        if (!child && c.bytes === null) {
          missing = true;
          break;
        }
        if (!child) {
          child = tree();
          node.trees.set(part, child);
        }
        node = child;
        trail.push(node);
      }
      if (missing) continue;
      if (c.bytes === null) {
        if (!node.files.delete(name)) continue;
      } else {
        if (node.trees.has(name))
          throw err(
            "ValidationFailed",
            "Artifact path conflicts with a directory",
          );
        node.files.set(name, { mode: c.mode, oid: await add("blob", c.bytes) });
      }
      for (const touched of trail) touched.dirty = true;
    }
    let outputEntries = 0;
    const build = async (node: Tree): Promise<string> => {
      if (!node.dirty && node.oid) return node.oid;
      const children: { name: string; mode: string; oid: string }[] = [];
      for (const [name, entry] of node.files) children.push({ name, ...entry });
      for (const [name, child] of node.trees) {
        const oid = typeof child === "string" ? child : await build(child);
        // Empty directories are not represented by Git's index.
        if (oid !== EMPTY_TREE) children.push({ name, mode: "40000", oid });
      }
      outputEntries += children.length;
      if (outputEntries > 2048)
        throw err("BudgetExceeded", "Prepared artifact exceeds entry budget");
      return add("tree", encodeWorkerGitTree(children));
    };
    const treeOid = await build(root);
    const oid = await this.commitObject(
      add,
      treeOid,
      base ? [base.oid] : [],
      message,
      at,
      author,
    );
    await this.flush(prepared);
    return Object.freeze({ ...this.binding, oid, tree: treeOid });
  }
  /** Unique best common ancestor, walking at most 4,096 commits newest first. */
  private async mergeBases(left: string, right: string, budget: Budget) {
    const LEFT = 1,
      RIGHT = 2,
      STALE = 4;
    const flags = new Map<string, number>(),
      times = new Map<string, number>(),
      parents = new Map<string, readonly string[]>();
    const visit = async (oid: string) => {
      if (!times.has(oid)) {
        if (times.size >= 4096)
          throw err(
            "BudgetExceeded",
            "Merge-base search exceeds commit budget",
          );
        const commit = await this.commitOf(oid, budget);
        times.set(oid, commit.time);
        parents.set(oid, commit.parents);
      }
    };
    const queue: string[] = [];
    const push = async (oid: string, flag: number) => {
      await visit(oid);
      const before = flags.get(oid) ?? 0;
      if ((before | flag) === before) return;
      flags.set(oid, before | flag);
      if (!queue.includes(oid)) queue.push(oid);
    };
    await push(left, LEFT);
    await push(right, RIGHT);
    const found: string[] = [];
    while (queue.some((oid) => !((flags.get(oid) ?? 0) & STALE))) {
      queue.sort((a, b) => times.get(b)! - times.get(a)! || (a < b ? -1 : 1));
      const oid = queue.shift()!;
      let flag = flags.get(oid)!;
      if ((flag & (LEFT | RIGHT)) === (LEFT | RIGHT) && !(flag & STALE)) {
        found.push(oid);
        flag |= STALE;
        flags.set(oid, flag);
      }
      for (const parent of parents.get(oid)!) await push(parent, flag);
    }
    // Drop candidates reachable from another candidate.
    const reachable = (from: string, target: string) => {
      const seen = new Set<string>(),
        stack = [...(parents.get(from) ?? [])];
      while (stack.length) {
        const oid = stack.pop()!;
        if (oid === target) return true;
        if (seen.has(oid) || !parents.has(oid)) continue;
        seen.add(oid);
        stack.push(...parents.get(oid)!);
      }
      return false;
    };
    return found.filter(
      (c) => !found.some((other) => other !== c && reachable(other, c)),
    );
  }
  /** Three-way tree merge. A path both sides changed differently is a conflict;
   * unlike `git merge-tree`, edits inside one file are not combined.
   * `resolutions` supply content (or deletion) for conflicting paths; each must
   * name a path the merge reports as conflicting. */
  async merge(
    input: {
      base: ArtifactRevisionPin;
      left: ArtifactRevisionPin;
      right: ArtifactRevisionPin;
      message: string;
      at: string;
      author?: WorkerGitIdentity;
      resolutions?: readonly ArtifactFileChange[];
    },
    context: CallContext,
  ): Promise<
    | { status: "prepared"; revision: ArtifactRevisionPin }
    | { status: "conflicted"; paths: readonly string[] }
  > {
    const base = Object.freeze({ ...input.base }),
      left = Object.freeze({ ...input.left }),
      right = Object.freeze({ ...input.right }),
      { message, at } = input,
      ctx = Object.freeze({ ...context });
    const author = this.metadata(message, at, input.author);
    const resolutions = new Map<
      string,
      { mode: string; bytes: Uint8Array | null }
    >();
    if (input.resolutions !== undefined) {
      if (!Array.isArray(input.resolutions) || input.resolutions.length > 1024)
        throw err("BudgetExceeded", "Merge resolution count exceeds budget");
      let resolvedBytes = 0;
      for (const r of input.resolutions) {
        if (
          !pathValid(r.path) ||
          resolutions.has(r.path) ||
          ![undefined, "100644", "100755"].includes(r.mode) ||
          (r.bytes !== null && !(r.bytes instanceof Uint8Array))
        )
          throw err("ValidationFailed", "Invalid merge resolution");
        resolvedBytes += r.bytes?.length ?? 0;
        if (resolvedBytes > 32 * 1024 * 1024)
          throw err("BudgetExceeded", "Merge resolutions exceed byte budget");
        resolutions.set(r.path, {
          mode: r.mode ?? "100644",
          bytes: r.bytes === null ? null : new Uint8Array(r.bytes),
        });
      }
    }
    await this.admit(ctx, "merge");
    for (const pin of [base, left, right]) this.pinned(pin);
    if (left.oid === right.oid)
      throw err("ValidationFailed", "Merge requires two distinct parents");
    const budget: Budget = { readBytes: 0, entries: 0 };
    for (const pin of [base, left, right])
      if ((await this.commitOf(pin.oid, budget)).tree !== pin.tree)
        throw err(
          "ValidationFailed",
          "Artifact commit does not match pinned tree",
        );
    const bases = await this.mergeBases(left.oid, right.oid, budget);
    if (bases.length !== 1 || bases[0] !== base.oid)
      throw err("VersionConflict", "Merge base changed or is ambiguous");
    const prepared = new Map<string, WorkerGitObject>();
    const add = async (type: WorkerGitObject["type"], bytes: Uint8Array) => {
      const object = { type, bytes },
        oid = await hash(object);
      prepared.set(oid, object);
      return oid;
    };
    const conflicts: string[] = [];
    const resolved = new Set<string>();
    const same = (a?: Entry, b?: Entry) =>
      a?.mode === b?.mode && a?.oid === b?.oid;
    const entries = async (oid: string | undefined) => {
      const out = new Map<string, Entry>();
      if (!oid) return out;
      const node = await this.load(oid, budget);
      for (const [name, entry] of node.files) out.set(name, entry);
      for (const [name, child] of node.trees)
        out.set(name, { mode: "40000", oid: child as string });
      return out;
    };
    const mergeEntry = async (
      path: string,
      b?: Entry,
      l?: Entry,
      r?: Entry,
    ): Promise<Entry | undefined> => {
      if (same(l, r)) return l;
      if (same(b, l)) return r;
      if (same(b, r)) return l;
      const isTree = (e?: Entry) => e === undefined || e.mode === "40000";
      if ((l || r) && isTree(b) && isTree(l) && isTree(r) && l && r) {
        const oid = await mergeTree(path, b?.oid, l.oid, r.oid);
        return oid === EMPTY_TREE ? undefined : { mode: "40000", oid };
      }
      const resolution = resolutions.get(path);
      if (resolution) {
        resolved.add(path);
        return resolution.bytes === null
          ? undefined
          : { mode: resolution.mode, oid: await add("blob", resolution.bytes) };
      }
      if (conflicts.length >= 1024)
        throw err("BudgetExceeded", "Artifact merge exceeds conflict budget");
      conflicts.push(path);
      return undefined;
    };
    const mergeTree = async (
      prefix: string,
      b: string | undefined,
      l: string,
      r: string,
    ): Promise<string> => {
      const [be, le, re] = [
        await entries(b),
        await entries(l),
        await entries(r),
      ];
      const names = new Set([...be.keys(), ...le.keys(), ...re.keys()]);
      const out: { name: string; mode: string; oid: string }[] = [];
      for (const name of names) {
        const merged = await mergeEntry(
          prefix ? `${prefix}/${name}` : name,
          be.get(name),
          le.get(name),
          re.get(name),
        );
        if (merged) out.push({ name, ...merged });
      }
      return add("tree", encodeWorkerGitTree(out));
    };
    const treeOid = await mergeTree("", base.tree, left.tree, right.tree);
    if (resolved.size !== resolutions.size)
      throw err(
        "ValidationFailed",
        "Merge resolution names a path that does not conflict",
      );
    if (conflicts.length)
      return {
        status: "conflicted",
        paths: Object.freeze(
          [...conflicts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      };
    const oid = await this.commitObject(
      add,
      treeOid,
      [left.oid, right.oid],
      message,
      at,
      author,
    );
    await this.flush(prepared);
    return {
      status: "prepared",
      revision: Object.freeze({ ...this.binding, oid, tree: treeOid }),
    };
  }
  /** Recursive file-level difference in Git order, skipping identical subtrees. */
  async diff(
    left: ArtifactRevisionPin,
    right: ArtifactRevisionPin,
    context: CallContext,
    options: { maxEntries?: number } = {},
  ): Promise<readonly ArtifactDifference[]> {
    const a = Object.freeze({ ...left }),
      b = Object.freeze({ ...right }),
      ctx = Object.freeze({ ...context }),
      limit = options.maxEntries ?? 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
      throw err("ValidationFailed", "Invalid diff budget");
    await this.admit(ctx, "diff");
    this.pinned(a);
    this.pinned(b);
    const budget: Budget = { readBytes: 0, entries: 0 };
    const out: ArtifactDifference[] = [];
    const emit = (
      path: string,
      before: Entry | undefined,
      after: Entry | undefined,
    ) => {
      if (out.length >= limit)
        throw err("BudgetExceeded", "Artifact diff exceeds entry budget");
      out.push(
        Object.freeze({
          path,
          status: !before ? "added" : !after ? "deleted" : "modified",
          before: before?.oid ?? null,
          after: after?.oid ?? null,
          beforeMode: before?.mode ?? "000000",
          afterMode: after?.mode ?? "000000",
        }),
      );
    };
    const walk = async (
      prefix: string,
      from: string | undefined,
      to: string | undefined,
    ) => {
      if (from === to) return;
      const listing = async (oid: string | undefined) => {
        const result: { name: string; mode: string; oid: string }[] = [];
        if (!oid) return result;
        const node = await this.load(oid, budget);
        for (const [name, e] of node.files) result.push({ name, ...e });
        for (const [name, child] of node.trees)
          result.push({ name, mode: "40000", oid: child as string });
        return result;
      };
      const before = new Map((await listing(from)).map((e) => [e.name, e]));
      const after = new Map((await listing(to)).map((e) => [e.name, e]));
      // Git orders a diff by full path bytes; a file and a directory with the
      // same name appear as separate entries.
      const keys = [
        ...[...before.values()].map((e) => ({ side: "before", e })),
        ...[...after.values()].map((e) => ({ side: "after", e })),
      ];
      const names = new Set<string>();
      const rows: { name: string; mode: string }[] = [];
      for (const { e } of keys) {
        const kind = e.mode === "40000" ? "tree" : "file";
        if (!names.has(e.name + kind)) {
          names.add(e.name + kind);
          rows.push({
            name: e.name,
            mode: e.mode === "40000" ? "40000" : "100644",
          });
        }
      }
      for (const row of treeOrder(rows)) {
        const path = prefix ? `${prefix}/${row.name}` : row.name;
        const pick = (m: Map<string, { mode: string; oid: string }>) => {
          const e = m.get(row.name);
          if (!e) return undefined;
          return (e.mode === "40000") === (row.mode === "40000")
            ? e
            : undefined;
        };
        const x = pick(before),
          y = pick(after);
        if (row.mode === "40000") await walk(path, x?.oid, y?.oid);
        else if (!x || !y || x.oid !== y.oid || x.mode !== y.mode)
          emit(path, x, y);
      }
    };
    await walk("", a.tree, b.tree);
    return Object.freeze(out);
  }
}

/** Request-local preparation sink. Transport must separately publish this pack under a journaled expected-ref guard. */
export class WorkerGitPackStore implements WorkerGitObjectStore {
  private readonly objects = new Map<string, WorkerGitObject>();
  private size = 0;
  readonly readCommit?: (oid: string) => Promise<WorkerGitCommit | null>;
  constructor(
    private readonly base?: Pick<WorkerGitObjectStore, "read" | "readCommit">,
  ) {
    // Prepared commits are raw; base commits come parsed when the base cannot return raw bytes.
    const parsed = base?.readCommit?.bind(base);
    if (parsed)
      this.readCommit = async (oid) => {
        const local = this.objects.get(oid);
        return local?.type === "commit"
          ? parseWorkerGitCommit(local.bytes)
          : parsed(oid);
      };
  }
  async read(
    oid: string,
    type?: WorkerGitObject["type"],
  ): Promise<WorkerGitObject | null> {
    const object = this.objects.get(oid);
    if (object)
      return { type: object.type, bytes: new Uint8Array(object.bytes) };
    return this.base ? this.base.read(oid, type) : null;
  }
  async write(object: WorkerGitObject): Promise<string> {
    if (
      !["blob", "tree", "commit"].includes(object.type) ||
      !(object.bytes instanceof Uint8Array)
    )
      throw err("ValidationFailed", "Invalid prepared Git object");
    if (object.bytes.length > 30 * 1024 * 1024)
      throw err(
        "BudgetExceeded",
        "Prepared object exceeds Artifacts object budget",
      );
    const snapshot = { type: object.type, bytes: new Uint8Array(object.bytes) };
    const oid = await hash(snapshot);
    if (!this.objects.has(oid)) {
      if (
        this.objects.size >= 4096 ||
        this.size + snapshot.bytes.length > 32 * 1024 * 1024
      )
        throw err("BudgetExceeded", "Prepared pack exceeds budget");
      this.objects.set(oid, snapshot);
      this.size += snapshot.bytes.length;
    }
    return oid;
  }
  /** A v2 non-delta Git pack. Does not send requests, mint tokens, or update a ref. */
  async pack(): Promise<Uint8Array<ArrayBuffer>> {
    const objects = [...this.objects.values()];
    const header = new Uint8Array(12),
      view = new DataView(header.buffer);
    header.set(encoder.encode("PACK"));
    view.setUint32(4, 2);
    view.setUint32(8, objects.length);
    const parts = [header];
    for (const object of objects) {
      const type = { commit: 1, tree: 2, blob: 3 }[object.type];
      const length: number[] = [];
      let size = object.bytes.length;
      let byte = (type << 4) | (size & 15);
      size = Math.floor(size / 16);
      while (size) {
        length.push(byte | 128);
        byte = size & 127;
        size = Math.floor(size / 128);
      }
      length.push(byte);
      const stream = new Blob([new Uint8Array(object.bytes)])
        .stream()
        .pipeThrough(new CompressionStream("deflate"));
      parts.push(
        Uint8Array.from(length),
        new Uint8Array(await new Response(stream).arrayBuffer()),
      );
    }
    const payload = concat(parts);
    return concat([
      payload,
      new Uint8Array(await crypto.subtle.digest("SHA-1", payload)),
    ]);
  }
}
