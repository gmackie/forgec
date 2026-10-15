/** Secret-authenticated disposable qualification host. Never a production API. */
import {
  WorkerArtifactWorkspace,
  WorkerGitPackStore,
} from "../../packages/runtime/src/adapters/artifact-workspace-workers.js";
import { workerGitArtifactPublicationProvider } from "../../packages/runtime/src/adapters/artifact-publication-workers.js";
import {
  cloudflareArtifactsReader,
  type CloudflareArtifactRepo,
} from "../../packages/runtime/src/adapters/cloudflare-artifacts.js";
import { SqlArtifactPublicationJournal } from "../../packages/runtime/src/adapters/artifact-publication-sql.js";
import { rawD1Executor } from "../../packages/runtime/src/adapters/sql-executor.js";
import { ArtifactPublisher } from "../../packages/runtime/src/artifact-publication.js";
import type { D1Like } from "../../packages/runtime/src/adapters/d1.js";
import { ForgeError } from "../../packages/runtime/src/errors.js";
interface Env {
  EXPIRES_AT: string;
  DB: D1Like;
  ARTIFACTS: {
    get(
      name: string,
    ): Promise<
      CloudflareArtifactRepo & {
        createToken(
          scope: "write",
          ttl: number,
        ): Promise<{ plaintext: string }>;
      }
    >;
  };
  QUALIFICATION_SECRET: string;
  REMOTE: string;
  REPO_ID: string;
  REPO_NAME: string;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const reply = (status: number, value: unknown) =>
      Response.json(value, {
        status,
        headers: { "cache-control": "no-store" },
      });
    if (
      request.headers.get("authorization") !==
      `Bearer ${env.QUALIFICATION_SECRET}`
    )
      return reply(401, { code: "Unauthenticated" });
    if (
      !Number.isFinite(Number(env.EXPIRES_AT)) ||
      Date.now() > Number(env.EXPIRES_AT)
    )
      return reply(410, { code: "ExpiredQualification" });
    if (request.method !== "POST")
      return reply(405, { code: "MethodNotAllowed" });
    const raw = await request.text();
    if (raw.length > 16384) return reply(413, { code: "PayloadTooLarge" });
    let stage = "parse";
    const transport: { method: string; status: number; type: string | null }[] =
      [];
    try {
      const input = JSON.parse(raw);
      if (
        !["publish", "lost", "recover", "denied", "foreign", "claim"].includes(
          input.action,
        ) ||
        typeof input.key !== "string" ||
        !/^[a-z0-9-]{1,64}$/.test(input.key) ||
        !(
          input.expected === null ||
          (typeof input.expected === "string" &&
            /^[a-f0-9]{40}$/.test(input.expected))
        )
      )
        return reply(400, { code: "MalformedRequest" });
      const binding = {
        tenant: "qualification",
        artifact: "source",
        generation: "one",
        repositoryId: env.REPO_ID,
        objectFormat: "sha1" as const,
      };
      const context = {
        tenant: binding.tenant,
        actor: "qualification",
        requestId: "probe",
      };
      const store = new WorkerGitPackStore();
      stage = "prepare";
      const revision = await new WorkerArtifactWorkspace(
        binding,
        store,
        async () => true,
      ).prepare(
        {
          base: null,
          changes: [
            { path: "binary", bytes: new Uint8Array([0, 255, 128]) },
            { path: "key", bytes: new TextEncoder().encode(input.key) },
          ],
          message: input.key,
          at: "2026-10-15T00:00:00Z",
        },
        context,
      );
      let posts = 0;
      const identity = cloudflareArtifactsReader(env.ARTIFACTS, env.REPO_NAME);
      const provider = workerGitArtifactPublicationProvider({
        remote: env.REMOTE,
        identity,
        prepared: store,
        token: async () => {
          const handle = await env.ARTIFACTS.get(env.REPO_NAME);
          try {
            if ((await handle.info()).id !== env.REPO_ID)
              throw Error("Repository identity changed");
            return (await handle.createToken("write", 300)).plaintext;
          } finally {
            handle[Symbol.dispose]();
          }
        },
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          transport.push({
            method: init?.method ?? "GET",
            status: response.status,
            type: response.headers.get("content-type"),
          });
          if (init?.method === "POST") {
            posts++;
            if (input.action === "lost") {
              await response.arrayBuffer();
              throw Error("Injected lost acknowledgement");
            }
          }
          return response;
        },
      });
      const journal = new SqlArtifactPublicationJournal(rawD1Executor(env.DB));
      stage = "journal";
      await journal.initialize();
      const publisher = new ArtifactPublisher(
        [{ ...binding, provider }],
        journal,
        async () => input.action !== "denied",
      );
      const intent = {
        key: input.key,
        ref: "refs/heads/main",
        expected: input.expected,
        revision,
      };
      if (input.action === "claim")
        await journal.claim({ ...intent, actor: context.actor, purpose: null });
      stage = "publish";
      const receipt =
        input.action === "recover"
          ? await publisher.recover(intent, context)
          : await publisher.publish(
              intent,
              input.action === "foreign"
                ? { ...context, tenant: "foreign" }
                : context,
            );
      stage = "verify";
      const repo = await identity.open();
      try {
        const file = await repo.file(revision.oid, "binary");
        return reply(200, {
          transport,
          receipt,
          posts,
          head: await repo.resolve(intent.ref),
          binary: Array.from(
            new Uint8Array(
              file ? await file.arrayBuffer() : new ArrayBuffer(0),
            ),
          ),
        });
      } finally {
        repo.dispose();
      }
    } catch (error) {
      return reply(error instanceof ForgeError ? error.status : 500, {
        code: error instanceof ForgeError ? error.code : "Internal",
        stage,
        transport,
      });
    }
  },
};
