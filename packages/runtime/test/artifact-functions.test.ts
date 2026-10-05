import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { defineFunction } from "../src/functions.js";
import { VersionedArtifactReader } from "../src/versioned-artifacts.js";
import { artifactFunctionBindings } from "../src/artifact-functions.js";

it("compiles typed artifact dependencies and invokes authorized pinned reads through Engine", async () => {
  const root = resolve(import.meta.dirname, "../../.."),
    out = mkdtempSync(join(tmpdir(), "forge-artifact-contract-"));
  try {
    execFileSync(
      join(root, "target/debug/forgec"),
      [
        "build",
        join(
          root,
          "packages/capabilities/versioned-artifacts/fixtures/consumer",
        ),
        "--out",
        out,
      ],
      { stdio: "pipe" },
    );
    const bundle = JSON.parse(readFileSync(join(out, "app.json"), "utf8"));
    const client = readFileSync(join(out, "client.ts"), "utf8");
    expect(client).toContain("ResolveArtifact");
    const oid = "a".repeat(40),
      tree = "b".repeat(40);
    let opens = 0,
      allowed = true;
    const reader = new VersionedArtifactReader(
      [
        {
          tenant: "t",
          artifact: "vault",
          generation: "g",
          repositoryId: "repo",
          provider: {
            open: async () => {
              opens++;
              return {
                repositoryId: "repo",
                objectFormat: "sha1",
                resolve: async () => oid,
                commit: async () => ({ oid, tree, parents: [] }),
                file: async () => new Blob([new Uint8Array([0, 128, 255])]),
                dispose() {},
              };
            },
          },
        },
      ],
      async () => allowed,
    );
    const externals = artifactFunctionBindings({ reader });
    const ctx = { tenant: "t", actor: "a", requestId: "r" };
    const id = "@test/artifact-consumer/_/ResolveArtifact";
    const engine = new Engine(
      new Model(bundle),
      testLayer(new MemoryStorage()),
      {
        externals,
        functions: [
          defineFunction(id, (deps) =>
            Effect.gen(function* () {
              const r = yield* deps.external(
                "@forgegraph/versioned-artifacts/_/Resolve",
                deps.input,
              );
              if (!r.ok) return yield* deps.fail("ArtifactUnavailable");
              return r.value;
            }),
          ),
        ],
      },
    );
    const pin = await Effect.runPromise(
      engine.call(id, { artifact: "vault", selector: "main" }, ctx),
    );
    expect(pin).toMatchObject({ tenant: "t", oid, tree });
    const read = externals["@forgegraph/versioned-artifacts/_/ReadFile"]!;
    expect(
      await read({ revision: pin, path: "file", maxBytes: 3 }, ctx),
    ).toEqual({ ok: true, value: { base64: "AID/", mediaType: "" } });
    allowed = false;
    const before = opens;
    expect(
      await read({ revision: pin, path: "file", maxBytes: 3 }, ctx),
    ).toMatchObject({ ok: false, code: "NotPermitted" });
    expect(opens).toBe(before);
    expect(
      await read({ revision: pin, path: "file", maxBytes: 0 }, ctx),
    ).toMatchObject({ ok: false, code: "ValidationFailed" });
    expect(
      await externals["@forgegraph/versioned-artifacts/_/Publish"]!({}, ctx),
    ).toEqual({ ok: false, code: "DependencyUnavailable" });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

it("preserves pending and observed publication outcomes through the compiled application", async () => {
  const { createClient } = await import("@libsql/client");
  const { libsqlExecutor } = await import("../src/adapters/libsql-executor.js");
  const { SqlArtifactPublicationJournal } =
    await import("../src/adapters/artifact-publication-sql.js");
  const { ArtifactPublisher } = await import("../src/artifact-publication.js");
  const root = resolve(import.meta.dirname, "../../.."),
    out = mkdtempSync(join(tmpdir(), "forge-artifact-publish-contract-"));
  const db = createClient({ url: "file::memory:" });
  try {
    execFileSync(
      join(root, "target/debug/forgec"),
      [
        "build",
        join(
          root,
          "packages/capabilities/versioned-artifacts/fixtures/consumer",
        ),
        "--out",
        out,
      ],
      { stdio: "pipe" },
    );
    const journal = new SqlArtifactPublicationJournal(libsqlExecutor(db));
    await journal.initialize();
    const revision = {
      tenant: "t",
      artifact: "vault",
      generation: "g",
      repositoryId: "repo",
      objectFormat: "sha1" as const,
      oid: "a".repeat(40),
      tree: "b".repeat(40),
    };
    let head: string | null = null,
      writes = 0,
      allowed = true;
    const publisher = new ArtifactPublisher(
      [
        {
          tenant: "t",
          artifact: "vault",
          generation: "g",
          repositoryId: "repo",
          provider: {
            open: async () => ({
              repositoryId: "repo",
              objectFormat: "sha1",
              commit: async (oid) => ({
                oid,
                tree: revision.tree,
                parents: [],
              }),
              head: async () => head,
              compareAndSwap: async (_ref, _expected, next) => {
                head = next;
                writes++;
                throw Error("private credential detail");
              },
              dispose() {},
            }),
          },
        },
      ],
      journal,
      async () => allowed,
    );
    const externals = artifactFunctionBindings({ publisher }),
      base = "@test/artifact-consumer/_/";
    const functions = ["Publish", "Recover"].map((name) =>
      defineFunction(base + name + "Artifact", (deps) =>
        Effect.gen(function* () {
          const r = yield* deps.external(
            "@forgegraph/versioned-artifacts/_/" + name,
            deps.input,
          );
          if (!r.ok) return yield* deps.fail("ArtifactUnavailable");
          return r.value;
        }),
      ),
    );
    const engine = new Engine(
      new Model(JSON.parse(readFileSync(join(out, "app.json"), "utf8"))),
      testLayer(new MemoryStorage()),
      { externals, functions },
    );
    const ctx = { tenant: "t", actor: "a", requestId: "r" },
      input = { key: "key", ref: "refs/heads/main", expected: null, revision };
    expect(
      await Effect.runPromise(
        engine.call(base + "PublishArtifact", input, ctx),
      ),
    ).toEqual({ outcome: "pending" });
    expect(
      await Effect.runPromise(
        engine.call(base + "RecoverArtifact", input, ctx),
      ),
    ).toEqual({ outcome: "observed" });
    expect(
      await Effect.runPromise(
        engine.call(base + "PublishArtifact", input, ctx),
      ),
    ).toEqual({ outcome: "observed" });
    expect(writes).toBe(1);
    allowed = false;
    expect(
      await externals["@forgegraph/versioned-artifacts/_/Recover"]!(input, ctx),
    ).toEqual({ ok: false, code: "NotPermitted" });
    expect(
      await externals["@forgegraph/versioned-artifacts/_/Publish"]!(
        { ...input, expected: undefined },
        ctx,
      ),
    ).toEqual({ ok: false, code: "ValidationFailed" });
  } finally {
    db.close();
    rmSync(out, { recursive: true, force: true });
  }
});
