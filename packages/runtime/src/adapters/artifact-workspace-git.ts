/** Node-only object preparation. Writes objects, never refs or a working tree. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CallContext } from "../engine.js";
import type {
  ArtifactRevisionPin,
  ArtifactObjectFormat,
} from "../versioned-artifacts.js";
import { err } from "../errors.js";
export interface GitArtifactWorkspaceBinding {
  readonly directory: string;
  readonly tenant: string;
  readonly artifact: string;
  readonly generation: string;
  readonly repositoryId: string;
  readonly objectFormat: ArtifactObjectFormat;
}
export interface ArtifactFileChange {
  readonly path: string;
  readonly bytes: Uint8Array | null;
  readonly mode?: "100644" | "100755";
}
export interface ArtifactDifference {
  readonly path: string;
  readonly status: "added" | "deleted" | "modified";
  readonly before: string | null;
  readonly after: string | null;
  readonly beforeMode: string;
  readonly afterMode: string;
}
export interface ArtifactWorkspaceAuthorization {
  readonly action: "prepare" | "diff" | "merge";
  readonly tenant: string;
  readonly actor: string;
  readonly artifact: string;
  readonly generation: string;
  readonly purpose?: string;
}
const identity = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 1024 &&
  !/[\x00-\x1f\x7f]/.test(v);
const safePath = (p: string) =>
  identity(p) &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  p
    .split("/")
    .every((x) => x && x !== "." && x !== ".." && x.toLowerCase() !== ".git");
export class GitArtifactWorkspace {
  private readonly binding: Readonly<GitArtifactWorkspaceBinding>;
  constructor(
    binding: GitArtifactWorkspaceBinding,
    private readonly authorize: (
      request: Readonly<ArtifactWorkspaceAuthorization>,
    ) => Promise<boolean>,
  ) {
    if (
      !isAbsolute(binding.directory) ||
      ![
        binding.tenant,
        binding.artifact,
        binding.generation,
        binding.repositoryId,
      ].every(identity) ||
      !["sha1", "sha256"].includes(binding.objectFormat)
    )
      throw err("ValidationFailed", "Invalid artifact workspace binding");
    this.binding = Object.freeze({ ...binding });
  }
  private oid(v: unknown) {
    return (
      typeof v === "string" &&
      (this.binding.objectFormat === "sha1"
        ? /^[a-f0-9]{40}$/
        : /^[a-f0-9]{64}$/
      ).test(v)
    );
  }
  private async git(
    args: string[],
    input?: Uint8Array | string,
    extra: Record<string, string> = {},
  ) {
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
      ),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
      ...extra,
    };
    return new Promise<{ code: number; out: Buffer }>((resolve) => {
      const child = execFile(
        "git",
        [
          "--no-replace-objects",
          "-C",
          this.binding.directory,
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { env, encoding: "buffer", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) =>
          resolve({
            code: error
              ? typeof error.code === "number"
                ? error.code
                : -1
              : 0,
            out: stdout,
          }),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
  private async checked(
    args: string[],
    input?: Uint8Array | string,
    env?: Record<string, string>,
  ) {
    const r = await this.git(args, input, env);
    if (r.code !== 0)
      throw err(
        "DependencyUnavailable",
        "Artifact Git object operation failed",
      );
    return r.out;
  }
  private async admit(
    context: CallContext,
    action: ArtifactWorkspaceAuthorization["action"],
  ) {
    const ctx = Object.freeze({ ...context }),
      b = this.binding;
    if (ctx.tenant !== b.tenant || !identity(ctx.actor))
      throw err("NotPermitted", "Artifact workspace access is not permitted");
    let allowed = false;
    try {
      allowed = await this.authorize(
        Object.freeze({
          action,
          tenant: ctx.tenant,
          actor: ctx.actor,
          artifact: b.artifact,
          generation: b.generation,
          ...(ctx.purpose === undefined ? {} : { purpose: ctx.purpose }),
        }),
      );
    } catch {}
    if (allowed !== true)
      throw err("NotPermitted", "Artifact workspace access is not permitted");
    const bare = (await this.checked(["rev-parse", "--is-bare-repository"]))
        .toString()
        .trim(),
      format = (await this.checked(["rev-parse", "--show-object-format"]))
        .toString()
        .trim();
    if (bare !== "true" || format !== b.objectFormat)
      throw err("VersionConflict", "Prepared repository format changed");
  }
  private async pin(pin: ArtifactRevisionPin) {
    const b = this.binding;
    if (pin.tenant !== b.tenant || pin.artifact !== b.artifact)
      throw err("NotPermitted", "Artifact workspace access is not permitted");
    if (
      pin.generation !== b.generation ||
      pin.repositoryId !== b.repositoryId ||
      pin.objectFormat !== b.objectFormat
    )
      throw err("VersionConflict", "Artifact workspace binding changed");
    if (!this.oid(pin.oid) || !this.oid(pin.tree))
      throw err("ValidationFailed", "Invalid artifact revision");
    const headers = (await this.checked(["cat-file", "commit", pin.oid]))
      .toString()
      .split("\n\n", 1)[0]!
      .split("\n");
    if (headers[0] !== "tree " + pin.tree)
      throw err(
        "ValidationFailed",
        "Artifact commit does not match pinned tree",
      );
  }
  private metadata(message: string, at: string) {
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 8192 ||
      message.includes("\0") ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(at) ||
      !Number.isFinite(Date.parse(at))
    )
      throw err("ValidationFailed", "Invalid artifact commit metadata");
    return {
      GIT_AUTHOR_NAME: "Forge artifact",
      GIT_AUTHOR_EMAIL: "artifact@forge.invalid",
      GIT_COMMITTER_NAME: "Forge artifact",
      GIT_COMMITTER_EMAIL: "artifact@forge.invalid",
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
    };
  }
  private async commit(
    tree: string,
    parents: string[],
    message: string,
    at: string,
  ) {
    if (!this.oid(tree)) throw err("ValidationFailed", "Invalid prepared tree");
    const oid = (
      await this.checked(
        ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])],
        message + "\n",
        this.metadata(message, at),
      )
    )
      .toString()
      .trim();
    const { directory: _directory, ...b } = this.binding;
    return Object.freeze({ ...b, oid, tree });
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
    const base = input.base === null ? null : Object.freeze({ ...input.base }),
      message = input.message,
      at = input.at;
    if (!Array.isArray(input.changes) || input.changes.length > 1024)
      throw err("BudgetExceeded", "Artifact change count exceeds budget");
    let bytes = 0;
    const paths = new Set<string>();
    const changes = input.changes
      .map((c) => {
        if (
          !safePath(c.path) ||
          paths.has(c.path) ||
          ![undefined, "100644", "100755"].includes(c.mode) ||
          (c.bytes !== null && !(c.bytes instanceof Uint8Array))
        )
          throw err("ValidationFailed", "Invalid artifact file change");
        paths.add(c.path);
        bytes += c.bytes?.byteLength ?? 0;
        if (bytes > 32 * 1024 * 1024)
          throw err("BudgetExceeded", "Artifact changes exceed byte budget");
        return {
          path: c.path,
          mode: c.mode ?? "100644",
          bytes: c.bytes === null ? null : new Uint8Array(c.bytes),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    this.metadata(message, at);
    await this.admit(context, "prepare");
    if (base) await this.pin(base);
    const temporary = await mkdtemp(join(tmpdir(), "forge-index-")),
      env = { GIT_INDEX_FILE: join(temporary, "index") };
    try {
      await this.checked(
        ["read-tree", base ? base.tree : "--empty"],
        undefined,
        env,
      );
      let entries = "";
      for (const c of changes) {
        const id =
          c.bytes === null
            ? "0".repeat(this.binding.objectFormat === "sha1" ? 40 : 64)
            : (await this.checked(["hash-object", "-w", "--stdin"], c.bytes))
                .toString()
                .trim();
        entries += `${c.bytes === null ? "0" : c.mode} ${id}\t${c.path}\0`;
      }
      await this.checked(["update-index", "-z", "--index-info"], entries, env);
      const tree = (await this.checked(["write-tree"], undefined, env))
        .toString()
        .trim();
      return await this.commit(tree, base ? [base.oid] : [], message, at);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async diff(
    left: ArtifactRevisionPin,
    right: ArtifactRevisionPin,
    context: CallContext,
    options: { maxEntries?: number } = {},
  ): Promise<readonly ArtifactDifference[]> {
    const a = Object.freeze({ ...left }),
      b = Object.freeze({ ...right }),
      limit = options.maxEntries ?? 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
      throw err("ValidationFailed", "Invalid diff budget");
    await this.admit(context, "diff");
    await this.pin(a);
    await this.pin(b);
    const parts = (
      await this.checked([
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "-r",
        "-z",
        a.tree,
        b.tree,
      ])
    )
      .toString("utf8")
      .split("\0");
    const out: ArtifactDifference[] = [];
    for (let i = 0; i < parts.length - 1; i += 2) {
      if (out.length >= limit)
        throw err("BudgetExceeded", "Artifact diff exceeds entry budget");
      const [beforeMode, afterMode, before, after, status] =
          parts[i]!.slice(1).split(" "),
        path = parts[i + 1]!;
      if (!safePath(path) || !["A", "D", "M", "T"].includes(status!))
        throw err("ValidationFailed", "Unsupported artifact diff entry");
      out.push(
        Object.freeze({
          path,
          status:
            status === "A" ? "added" : status === "D" ? "deleted" : "modified",
          before: /^0+$/.test(before!) ? null : before!,
          after: /^0+$/.test(after!) ? null : after!,
          beforeMode: beforeMode!,
          afterMode: afterMode!,
        }),
      );
    }
    return Object.freeze(out);
  }
  async merge(
    input: {
      base: ArtifactRevisionPin;
      left: ArtifactRevisionPin;
      right: ArtifactRevisionPin;
      message: string;
      at: string;
    },
    context: CallContext,
  ): Promise<
    | { status: "prepared"; revision: ArtifactRevisionPin }
    | { status: "conflicted"; paths: readonly string[] }
  > {
    const { message, at } = input,
      base = Object.freeze({ ...input.base }),
      left = Object.freeze({ ...input.left }),
      right = Object.freeze({ ...input.right });
    this.metadata(message, at);
    await this.admit(context, "merge");
    for (const p of [base, left, right]) await this.pin(p);
    const bases = (
      await this.checked(["merge-base", "--all", left.oid, right.oid])
    )
      .toString()
      .trim()
      .split("\n");
    if (bases.length !== 1 || bases[0] !== base.oid)
      throw err("VersionConflict", "Merge base changed or is ambiguous");
    const result = await this.git([
      "merge-tree",
      "--write-tree",
      "--name-only",
      "-z",
      "--merge-base=" + base.oid,
      left.oid,
      right.oid,
    ]);
    if (result.code !== 0 && result.code !== 1)
      throw err("DependencyUnavailable", "Artifact merge failed");
    const parts = result.out.toString().split("\0"),
      tree = parts.shift()!;
    if (result.code === 1) {
      const end = parts.indexOf(""),
        paths = parts.slice(0, end < 0 ? parts.length : end);
      if (
        !paths.length ||
        paths.length > 1024 ||
        paths.some((p) => !safePath(p))
      )
        throw err("ValidationFailed", "Invalid merge conflict result");
      return { status: "conflicted", paths: Object.freeze(paths) };
    }
    return {
      status: "prepared",
      revision: await this.commit(tree, [left.oid, right.oid], message, at),
    };
  }
}
