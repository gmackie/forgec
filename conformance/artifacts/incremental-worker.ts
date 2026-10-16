/** Disposable FORG-22 qualification: incremental preparation, guarded publication,
 * Worker merge and diff against a temporary Artifacts repository. Never an
 * application endpoint; the repository is deleted before the response. */
import {
  WorkerArtifactWorkspace,
  WorkerGitPackStore,
} from "../../packages/runtime/src/adapters/artifact-workspace-workers.js";
import { workerGitArtifactPublicationProvider } from "../../packages/runtime/src/adapters/artifact-publication-workers.js";
import {
  cloudflareArtifactsObjectSource,
  cloudflareArtifactsReader,
} from "../../packages/runtime/src/adapters/cloudflare-artifacts.js";

interface Env {
  ARTIFACTS: any;
  QUALIFICATION_SECRET: string;
  REPO_NAME: string;
  EXPIRES_AT: string;
}
const at = "2026-10-15T00:00:00Z";
const text = (s: string) => new TextEncoder().encode(s);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const reply = (status: number, body: unknown) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    if (
      !env.QUALIFICATION_SECRET ||
      request.headers.get("authorization") !==
        `Bearer ${env.QUALIFICATION_SECRET}`
    )
      return reply(401, { code: "Unauthenticated" });
    if (!/^forge-incremental-[a-z0-9-]+$/.test(env.REPO_NAME))
      return reply(400, { code: "InvalidRequest" });
    if (Date.now() >= Number(env.EXPIRES_AT))
      return reply(410, { code: "Expired" });
    const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
    const check = (name: string, pass: boolean, detail?: unknown) =>
      checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
    let stage = "create";
    let created = false;
    try {
      const repo = await env.ARTIFACTS.create(env.REPO_NAME, {
        setDefaultBranch: "main",
      });
      created = true;
      const handle = await env.ARTIFACTS.get(env.REPO_NAME);
      try {
        const info = await handle.info();
        const binding = {
          tenant: "qualification",
          artifact: "source",
          generation: "one",
          repositoryId: info.id as string,
          objectFormat: "sha1" as const,
        };
        const context = {
          tenant: binding.tenant,
          actor: "qualification",
          requestId: "forg-22",
        };
        const source = cloudflareArtifactsObjectSource(handle);
        const identity = cloudflareArtifactsReader(
          env.ARTIFACTS,
          env.REPO_NAME,
        );
        // One pack store per publication: it holds only that step's new objects.
        const step = () => {
          const store = new WorkerGitPackStore(source);
          return {
            store,
            workspace: new WorkerArtifactWorkspace(
              binding,
              store,
              async () => true,
            ),
            publish: async (
              ref: string,
              expected: string | null,
              next: string,
            ) => {
              const provider = workerGitArtifactPublicationProvider({
                remote: repo.remote,
                identity,
                prepared: store,
                token: async () =>
                  (await handle.createToken("write", 300)).plaintext,
              });
              const opened = await provider.open();
              try {
                return {
                  outcome: await opened.compareAndSwap(ref, expected, next),
                  objects: new DataView((await store.pack()).buffer).getUint32(
                    8,
                  ),
                };
              } finally {
                opened.dispose();
              }
            },
          };
        };

        stage = "base";
        const s1 = step();
        const base = await s1.workspace.prepare(
          {
            base: null,
            changes: [
              { path: "README.md", bytes: text("# Fixture\n") },
              { path: "src/a.ts", bytes: text("export const a = 1;\n") },
              { path: "src/b.ts", bytes: text("export const b = 1;\n") },
              { path: "src/deep/c.ts", bytes: text("export const c = 1;\n") },
            ],
            message: "base",
            at,
          },
          context,
        );
        const pushedBase = await s1.publish("refs/heads/main", null, base.oid);
        check("base published", pushedBase.outcome === "accepted", pushedBase);

        stage = "session";
        const s2 = step();
        const left = await s2.workspace.prepare(
          {
            base,
            changes: [
              { path: "src/a.ts", bytes: text("export const a = 2;\n") },
            ],
            message: "session edit",
            at,
            author: { name: "Agent Smith", email: "agent@loom.invalid" },
          },
          context,
        );
        const pushedLeft = await s2.publish(
          "refs/heads/loom/sessions/s1",
          null,
          left.oid,
        );
        // blob, src tree, root tree, commit: untouched src/deep is reused by ID.
        check(
          "session commit built incrementally on the remote base",
          pushedLeft.outcome === "accepted" && pushedLeft.objects === 4,
          pushedLeft,
        );

        stage = "head moves";
        const s3 = step();
        const right = await s3.workspace.prepare(
          {
            base,
            changes: [
              { path: "src/deep/d.ts", bytes: text("export const d = 1;\n") },
            ],
            message: "head moves",
            at,
          },
          context,
        );
        const pushedRight = await s3.publish(
          "refs/heads/main",
          base.oid,
          right.oid,
        );
        check(
          "main advanced with compare-and-swap",
          pushedRight.outcome === "accepted",
          pushedRight,
        );

        stage = "merge";
        const s4 = step();
        const merged = await s4.workspace.merge(
          {
            base,
            left: right,
            right: left,
            message: "land session s1",
            at,
            author: { name: "Agent Smith", email: "agent@loom.invalid" },
          },
          context,
        );
        check(
          "merge prepared without conflicts",
          merged.status === "prepared",
          merged,
        );
        if (merged.status !== "prepared") throw Error("merge conflicted");
        const landed = await s4.publish(
          "refs/heads/main",
          right.oid,
          merged.revision.oid,
        );
        check("merge landed on main", landed.outcome === "accepted", landed);

        stage = "stale";
        const s5 = step();
        const stale = await s5.workspace.prepare(
          {
            base,
            changes: [{ path: "late", bytes: text("late") }],
            message: "stale",
            at,
          },
          context,
        );
        const rejected = await s5.publish(
          "refs/heads/main",
          base.oid,
          stale.oid,
        );
        check(
          "stale expected head is rejected",
          rejected.outcome === "rejected",
          rejected,
        );

        stage = "conflict";
        const s6 = step();
        const other = await s6.workspace.prepare(
          {
            base,
            changes: [
              { path: "src/a.ts", bytes: text("export const a = 3;\n") },
            ],
            message: "other",
            at,
          },
          context,
        );
        const conflict = await s6.workspace.merge(
          { base, left, right: other, message: "conflict", at },
          context,
        );
        check(
          "same-path edits conflict",
          conflict.status === "conflicted" &&
            JSON.stringify(conflict.paths) === '["src/a.ts"]',
          conflict,
        );

        stage = "read back";
        const diff = await s6.workspace.diff(base, merged.revision, context);
        check(
          "diff of the landed merge",
          JSON.stringify(diff.map((d) => [d.path, d.status])) ===
            '[["src/a.ts","modified"],["src/deep/d.ts","added"]]',
          diff.map((d) => [d.path, d.status]),
        );
        const head = (await handle.log({ ref: "main", limit: 1 }))[0]?.hash;
        const commit = await handle.readCommit(merged.revision.oid);
        const file = await (
          await handle.readFile({ ref: "main", path: "src/a.ts" })
        )?.text();
        check(
          "binding reads the landed commit",
          head === merged.revision.oid &&
            commit?.parents.join(",") === `${right.oid},${left.oid}` &&
            file === "export const a = 2;\n",
          {
            head,
            parents: commit?.parents,
            author: commit?.author,
          },
        );
      } finally {
        handle[Symbol.dispose]?.();
      }
    } catch (error) {
      check(
        `stage ${stage}`,
        false,
        String((error as Error)?.message ?? error),
      );
    } finally {
      if (created) {
        try {
          check(
            "repository deleted",
            (await env.ARTIFACTS.delete(env.REPO_NAME)) === true,
          );
        } catch (error) {
          check("repository deleted", false, String(error));
        }
      }
    }
    return reply(200, {
      status: checks.every((c) => c.pass) ? "passed" : "failed",
      checks,
    });
  },
};
