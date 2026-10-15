/** Bounded Git object preparation using Web Crypto. No filesystem, subprocesses or ref writes. */
import type { CallContext } from "../engine.js";
import type { ArtifactRevisionPin } from "../versioned-artifacts.js";
import type {
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
  read(oid: string): Promise<WorkerGitObject | null>;
  write(object: WorkerGitObject): Promise<string>;
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
interface Entry {
  mode: string;
  oid: string;
}
interface Tree {
  files: Map<string, Entry>;
  trees: Map<string, Tree>;
}
const tree = (): Tree => ({ files: new Map(), trees: new Map() });
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
  async prepare(
    input: {
      base: ArtifactRevisionPin | null;
      changes: readonly ArtifactFileChange[];
      message: string;
      at: string;
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
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 8192 ||
      message.includes("\0") ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(at) ||
      !Number.isFinite(Date.parse(at))
    )
      throw err("ValidationFailed", "Invalid artifact commit metadata");
    if (ctx.tenant !== this.binding.tenant || !identity(ctx.actor))
      throw err("NotPermitted", "Artifact workspace access is not permitted");
    let allowed = false;
    try {
      allowed = await this.authorize(
        Object.freeze({
          action: "prepare",
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
    let readBytes = 0,
      entries = 0;
    const read = async (oid: string, type: WorkerGitObject["type"]) => {
      if (!oidValid(oid))
        throw err("ValidationFailed", "Invalid artifact object ID");
      let object: WorkerGitObject | null;
      try {
        object = await this.store.read(oid);
      } catch {
        throw err("DependencyUnavailable", "Artifact object read failed");
      }
      if (!object) throw err("NotFound", "Artifact object is unavailable");
      if (object.type !== type || !(object.bytes instanceof Uint8Array))
        throw err("ValidationFailed", "Invalid artifact object");
      readBytes += object.bytes.length;
      if (readBytes > 32 * 1024 * 1024)
        throw err("BudgetExceeded", "Artifact base exceeds byte budget");
      const snapshot = {
        type: object.type,
        bytes: new Uint8Array(object.bytes),
      };
      if ((await hash(snapshot)) !== oid)
        throw err("ValidationFailed", "Artifact object does not match its ID");
      return snapshot.bytes;
    };
    const load = async (oid: string, depth: number): Promise<Tree> => {
      if (depth > 64)
        throw err("BudgetExceeded", "Artifact tree exceeds depth budget");
      const bytes = await read(oid, "tree"),
        result = tree();
      let offset = 0;
      while (offset < bytes.length) {
        if (++entries > 1024)
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
        const child = Array.from(bytes.subarray(end + 1, end + 21), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        if (mode === "40000")
          result.trees.set(name, await load(child, depth + 1));
        else if (["100644", "100755", "120000", "160000"].includes(mode))
          result.files.set(name, { mode, oid: child });
        else throw err("ValidationFailed", "Unsupported Git tree mode");
        offset = end + 21;
      }
      return result;
    };
    let root = tree();
    if (base) {
      if (
        Object.entries(this.binding).some(
          ([k, v]) => base[k as keyof WorkerArtifactBinding] !== v,
        )
      )
        throw err("VersionConflict", "Artifact workspace binding changed");
      const headers = decoder
        .decode(await read(base.oid, "commit"))
        .split("\n\n", 1)[0]!
        .split("\n");
      if (headers[0] !== "tree " + base.tree)
        throw err(
          "ValidationFailed",
          "Artifact commit does not match pinned tree",
        );
      root = await load(base.tree, 0);
    }
    const prepared = new Map<string, WorkerGitObject>();
    const add = async (type: WorkerGitObject["type"], bytes: Uint8Array) => {
      const object = { type, bytes },
        oid = await hash(object);
      prepared.set(oid, object);
      return oid;
    };
    const prune = (node: Tree) => {
      for (const [name, child] of node.trees) {
        prune(child);
        if (!child.files.size && !child.trees.size) node.trees.delete(name);
      }
    };
    // Deletions precede replacements so file/directory transitions are independent of input order.
    const ordered = [
      ...changes.filter((c) => c.bytes === null),
      ...changes.filter((c) => c.bytes !== null),
    ];
    let pruned = false;
    for (const c of ordered) {
      if (c.bytes !== null && !pruned) {
        prune(root);
        pruned = true;
      }
      const parts = c.path.split("/"),
        name = parts.pop()!;
      let node = root,
        missing = false;
      for (const part of parts) {
        if (node.files.has(part))
          throw err("ValidationFailed", "Artifact path conflicts with a file");
        let child = node.trees.get(part);
        if (!child && c.bytes === null) {
          missing = true;
          break;
        }
        if (!child) {
          child = tree();
          node.trees.set(part, child);
        }
        node = child;
      }
      if (missing) continue;
      if (c.bytes === null) node.files.delete(name);
      else {
        if (node.trees.has(name))
          throw err(
            "ValidationFailed",
            "Artifact path conflicts with a directory",
          );
        node.files.set(name, { mode: c.mode, oid: await add("blob", c.bytes) });
      }
    }
    let outputEntries = 0;
    const build = async (node: Tree): Promise<string> => {
      const children = new Map(node.files);
      for (const [name, child] of node.trees) {
        if (child.files.size || child.trees.size) {
          const oid = await build(child);
          // Empty directories are not represented by Git's index.
          if (oid !== "4b825dc642cb6eb9a060e54bf8d69288fbee4904")
            children.set(name, { mode: "40000", oid });
        }
      }
      outputEntries += children.size;
      if (outputEntries > 2048)
        throw err("BudgetExceeded", "Prepared artifact exceeds entry budget");
      const sorted = [...children]
        .map(([name, entry]) => ({
          name,
          entry,
          key: encoder.encode(name + (entry.mode === "40000" ? "/" : "")),
        }))
        .sort((a, b) => {
          for (let i = 0; i < Math.min(a.key.length, b.key.length); i++)
            if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
          return a.key.length - b.key.length;
        });
      return add(
        "tree",
        concat(
          sorted.map(({ name, entry }) =>
            concat([
              encoder.encode(`${entry.mode} ${name}\0`),
              Uint8Array.from(entry.oid.match(/../g)!, (x) => parseInt(x, 16)),
            ]),
          ),
        ),
      );
    };
    const treeOid = await build(root);
    const who = `Forge artifact <artifact@forge.invalid> ${Date.parse(at) / 1000} +0000`;
    const oid = await add(
      "commit",
      encoder.encode(
        `tree ${treeOid}\n${base ? `parent ${base.oid}\n` : ""}author ${who}\ncommitter ${who}\n\n${message}\n`,
      ),
    );
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
    return Object.freeze({ ...this.binding, oid, tree: treeOid });
  }
}

/** Request-local preparation sink. Transport must separately publish this pack under a journaled expected-ref guard. */
export class WorkerGitPackStore implements WorkerGitObjectStore {
  private readonly objects = new Map<string, WorkerGitObject>();
  private size = 0;
  constructor(private readonly base?: Pick<WorkerGitObjectStore, "read">) {}
  async read(oid: string): Promise<WorkerGitObject | null> {
    const object = this.objects.get(oid);
    if (object)
      return { type: object.type, bytes: new Uint8Array(object.bytes) };
    return this.base ? this.base.read(oid) : null;
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
