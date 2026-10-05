/** Node-only Git transport. All configuration is trusted composition-root input. */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  validArtifactBranch,
  type ArtifactPublicationProvider,
} from "../artifact-publication.js";
import type { ArtifactReadProvider } from "../versioned-artifacts.js";

export interface GitArtifactPublicationOptions {
  /** Dedicated, trusted bare repository containing prepared commit objects. */
  readonly directory: string;
  /** Repository-scoped HTTPS remote, or absolute local path for local qualification. */
  readonly remote: string;
  /** Stable identity/read capability for the SAME remote. Never caller-selected. */
  readonly identity: ArtifactReadProvider;
  /** Repository-scoped credential; supplied only through child process environment. */
  readonly token?: () => Promise<string>;
}
export function gitArtifactPublicationProvider(
  options: GitArtifactPublicationOptions,
): ArtifactPublicationProvider {
  const { directory, remote, identity, token } = options;
  if (
    !isAbsolute(directory) ||
    (!isAbsolute(remote) && !remote.startsWith("https://")) ||
    /[\r\n\x00]/.test(remote)
  )
    throw Error("Invalid configured Git publication transport");
  if (remote.startsWith("https://")) {
    const url = new URL(remote);
    if (url.username || url.password || url.search || url.hash)
      throw Error("Git credentials must not be in the remote URL");
  }
  const run = async (args: string[], authenticate = false) => {
    // Exclude inherited Git overrides, tracing, and credential helpers from this capability.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    });
    if (authenticate && token) {
      const secret = await token();
      if (!secret || /[\r\n\x00]/.test(secret))
        throw Error("Invalid Git credential");
      Object.assign(env, {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_1: "http.extraHeader",
        GIT_CONFIG_VALUE_1: "Authorization: Bearer " + secret,
      });
    }
    return new Promise<{ ok: boolean; stdout: string }>((resolve) => {
      execFile(
        "git",
        [
          "--no-replace-objects",
          "-C",
          directory,
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { env, timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
        (error, stdout) => resolve({ ok: !error, stdout }),
      );
    });
  };
  return {
    async open() {
      const repo = await identity.open();
      try {
        const format = await run(["rev-parse", "--show-object-format"]);
        const bare = await run(["rev-parse", "--is-bare-repository"]);
        if (
          !format.ok ||
          format.stdout.trim() !== repo.objectFormat ||
          !bare.ok ||
          bare.stdout.trim() !== "true"
        )
          throw Error("Invalid prepared artifact repository");
        const validOid = (value: unknown) =>
          typeof value === "string" &&
          (repo.objectFormat === "sha1"
            ? /^[a-f0-9]{40}$/
            : /^[a-f0-9]{64}$/
          ).test(value);
        return {
          repositoryId: repo.repositoryId,
          objectFormat: repo.objectFormat,
          async commit(oid: string) {
            if (!validOid(oid)) throw Error("Invalid object ID");
            const result = await run(["cat-file", "commit", oid]);
            if (!result.ok) return null;
            const headers = result.stdout.split("\n\n", 1)[0]!.split("\n");
            const tree = headers
              .find((line) => line.startsWith("tree "))
              ?.slice(5);
            const parents = headers
              .filter((line) => line.startsWith("parent "))
              .map((line) => line.slice(7));
            if (!validOid(tree) || parents.some((p) => !validOid(p)))
              throw Error("Invalid Git commit");
            return { oid, tree: tree!, parents };
          },
          async head(ref: string) {
            if (!validArtifactBranch(ref)) throw Error("Invalid ref");
            return repo.resolve(ref);
          },
          async compareAndSwap(
            ref: string,
            expected: string | null,
            next: string,
          ) {
            if (
              !validArtifactBranch(ref) ||
              (expected !== null && !validOid(expected)) ||
              !validOid(next)
            )
              throw Error("Invalid conditional push");
            const result = await run(
              [
                "push",
                "--porcelain",
                "--no-verify",
                "--no-follow-tags",
                "--recurse-submodules=no",
                "--force-with-lease=" + ref + ":" + (expected ?? ""),
                "--",
                remote,
                next + ":" + ref,
              ],
              true,
            );
            const statuses = result.stdout
              .split("\n")
              .filter((line) => /^[ =*+!\-]\t/.test(line));
            if (statuses.length !== 1)
              throw Error("Unknown Git publication outcome");
            const [flag, mapping, detail] = statuses[0]!.split("\t");
            if (mapping !== next + ":" + ref)
              throw Error("Unknown Git publication outcome");
            if (result.ok && [" ", "*", "+"].includes(flag!))
              return "accepted" as const;
            if (
              !result.ok &&
              flag === "!" &&
              detail === "[rejected] (stale info)"
            )
              return "rejected" as const;
            throw Error("Unknown Git publication outcome");
          },
          dispose: () => repo.dispose(),
        };
      } catch (error) {
        repo.dispose();
        throw error;
      }
    },
  };
}
