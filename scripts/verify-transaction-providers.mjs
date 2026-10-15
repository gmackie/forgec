#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { providerEnvironment } from "./run-foundation-providers.mjs";
import {
  providerConfiguration,
  validateResult,
} from "./verify-foundation-providers.mjs";
const requiredTraces = [
  "staged-parent-query",
  "predicate-phantom-rollback",
  "read-only-snapshot-conflict",
  "declared-function-receipt",
  "competing-transaction-guards",
];
const root = fileURLToPath(new URL("../", import.meta.url));
const options = { provider: "all" };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  if (
    !["state-dir", "provider", "receipt-dir"].includes(key) ||
    !process.argv[i + 1]
  )
    throw new Error(
      "Use --state-dir <private provider setup> --provider all|postgres|d1|dynamodb --receipt-dir <output>",
    );
  options[key] = process.argv[i + 1];
}
if (!options["state-dir"] || !options["receipt-dir"])
  throw new Error("Explicit provider setup and receipt output required");
const directory = resolve(options["state-dir"]),
  out = resolve(options["receipt-dir"]);
const providers =
  options.provider === "all"
    ? ["postgres", "d1", "dynamodb"]
    : [options.provider];
// Existing D1 core bundle is the deployed schema identity, shared by every cell.
const setup = JSON.parse(readFileSync(join(directory, "setup.json")));
const bundle = resolve(directory, setup.d1.core, "../bundle");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = () =>
  hash(
    execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "packages/runtime/src",
        "packages/runtime/test/provider-foundation",
        "scripts/verify-transaction-providers.mjs",
        "scripts/run-foundation-providers.mjs",
        "scripts/verify-foundation-providers.mjs",
        "conformance/foundation/providers/d1-worker.mjs",
        "conformance/transactions/vitest.config.mjs",
      ],
      { cwd: root },
    )
      .toString()
      .split("\0")
      .concat([
        "scripts/verify-transaction-providers.mjs",
        "scripts/run-foundation-providers.mjs",
        "scripts/verify-foundation-providers.mjs",
        "conformance/foundation/providers/d1-worker.mjs",
        "conformance/transactions/vitest.config.mjs",
        "packages/runtime/test/provider-foundation/transactions.ts",
      ])
      .filter(Boolean)
      .sort()
      .filter((p, i, all) => i === 0 || p !== all[i - 1])
      .map((p) => p + "\0" + hash(readFileSync(join(root, p))))
      .join("\0"),
  );
const fingerprint = source();
const cells = providers.map((provider) => {
  const env = providerEnvironment(directory, provider, "core");
  if (provider === "postgres" && process.env.FORGE_FOUNDATION_PG_URL)
    env.FORGE_FOUNDATION_PG_URL = process.env.FORGE_FOUNDATION_PG_URL;
  return { provider, env, configuration: providerConfiguration(provider, env) };
});
mkdirSync(out, { recursive: true });
for (const { provider, env, configuration } of cells) {
  const id = randomUUID(),
    report = join(out, provider + "-" + id + ".vitest.json"),
    identity = join(out, provider + "-" + id + ".identity.json");
  const result = spawnSync(
    process.execPath,
    [
      join(root, "packages/runtime/node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      join(root, "conformance/transactions/vitest.config.mjs"),
      "--reporter=default",
      "--reporter=json",
      "--outputFile=" + report,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...env,
        FORGE_PROVIDER: provider,
        FORGE_PROVIDER_RUN_ID: id,
        FORGE_PROVIDER_FIXTURE: bundle,
        FORGE_PROVIDER_IDENTITY: identity,
        FORGE_PROVIDER_BUNDLE_SHA256: hash(
          readFileSync(join(bundle, "app.json")),
        ),
        FORGE_PROVIDER_HARNESS_SHA256: hash(
          readFileSync(
            join(root, "conformance/foundation/providers/d1-worker.mjs"),
          ),
        ),
      },
    },
  );
  let passed = false;
  try {
    const r = JSON.parse(readFileSync(report));
    passed =
      result.status === 0 &&
      r.success === true &&
      validateResult(r, requiredTraces).length === requiredTraces.length &&
      source() === fingerprint;
  } catch {}
  writeFileSync(
    join(out, provider + "-" + id + ".json"),
    JSON.stringify(
      {
        suite: "transaction-providers/1",
        ...configuration,
        runId: id,
        status: passed ? "passing" : "failed",
        runtimeSourceSha256: fingerprint,
        bundleSha256: hash(readFileSync(join(bundle, "app.json"))),
        verifiedAt: new Date().toISOString(),
        reportSha256: existsSync(report) ? hash(readFileSync(report)) : null,
        identitySha256: existsSync(identity)
          ? hash(readFileSync(identity))
          : null,
        requiredTraces,
        scope:
          "staged references/queries, phantom and read-only guards, function receipts and competing transactions; existing dedicated database only; no production activation",
      },
      null,
      2,
    ) + "\n",
  );
  if (!passed)
    throw new Error(
      provider + " transaction verification failed; inspect receipts",
    );
}
