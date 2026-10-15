/** Workerd qualification and native Git pack validation, with isolated temporary state. */
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = createRequire(
  new URL("../packages/runtime/package.json", import.meta.url),
);
const wrangler = createRequire(runtime.resolve("wrangler/package.json"));
const { build } = wrangler("esbuild"),
  { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare");
const directory = await mkdtemp(join(tmpdir(), "forge-worker-preparation-"));
let mf,
  posts = 0;
const packet = (text) =>
  (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text;
try {
  const bundle = await build({
    entryPoints: [join(root, "conformance/artifacts/preparation-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["source"],
    metafile: true,
  });
  assert(
    !Object.keys(bundle.metafile.inputs).some(
      (p) =>
        p.includes("artifact-workspace-git") ||
        p.includes("artifact-publication-git"),
    ),
    "Node-only preparation must not enter the Worker bundle",
  );
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-01",
      outboundService: async (request) => {
        assert.equal(new URL(request.url).origin, "https://artifacts.example");
        assert.equal(
          request.headers.get("authorization"),
          "Bearer probe-token",
        );
        if (request.method === "POST") {
          posts++;
          const body = new Uint8Array(await request.arrayBuffer());
          const length = parseInt(
            Buffer.from(body.subarray(0, 4)).toString(),
            16,
          );
          const command = Buffer.from(body.subarray(4, length)).toString();
          assert.match(
            command,
            /^0{40} [a-f0-9]{40} refs\/heads\/main\0report-status\n$/,
          );
          assert.equal(
            Buffer.from(body.subarray(length, length + 8)).toString(),
            "0000PACK",
          );
          return new Response(
            packet("unpack ok\n") + packet("ok refs/heads/main\n") + "0000",
            {
              headers: {
                "content-type": "application/x-git-receive-pack-result",
              },
            },
          );
        }
        return new Response(
          packet("# service=git-receive-pack\n") +
            "0000" +
            packet("0".repeat(40) + " capabilities^{}\0report-status\n") +
            "0000",
          {
            headers: {
              "content-type": "application/x-git-receive-pack-advertisement",
            },
          },
        );
      },
    }),
  );
  const response = await mf.dispatchFetch("http://localhost/probe");
  assert.equal(response.status, 200);
  assert.equal(posts, 1);
  const commit = response.headers.get("x-forge-commit"),
    tree = response.headers.get("x-forge-tree");
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(tree, /^[a-f0-9]{40}$/);
  const pack = new Uint8Array(await response.arrayBuffer());
  const git = (args, input) =>
    execFileSync("git", ["-C", directory, ...args], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  git(["init", "--bare"]);
  git(["index-pack", "--strict", "--stdin"], pack);
  assert.deepEqual(
    git(["show", commit + ":binary"]),
    Buffer.from([0, 255, 128]),
  );
  assert.equal(git(["show", commit + ":nested/run"]).toString(), "#!/bin/sh\n");
  assert.match(
    git(["ls-tree", "-r", commit]).toString(),
    /100755 blob .*nested\/run/,
  );
  assert.equal(git(["for-each-ref"]).length, 0);
  console.log(
    JSON.stringify({
      status: "passed",
      runtime: "workerd",
      commit,
      tree,
      packBytes: pack.length,
      checks: [
        "browser-bundle-no-node-preparer",
        "webcrypto-identity",
        "compressionstream-pack",
        "git-index-pack-strict",
        "binary-bytes",
        "executable-mode",
        "unchanged-refs",
        "workers-guarded-http-transport-mock",
      ],
      liveArtifacts: false,
    }),
  );
} finally {
  if (mf) await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
