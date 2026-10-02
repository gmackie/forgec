/** Disposable opt-in qualification; secrets arrive over stdin, never argv/output. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ArtifactPublisher } from "../../packages/runtime/dist/artifact-publication.js";
import { SqlArtifactPublicationJournal } from "../../packages/runtime/dist/adapters/artifact-publication-sql.js";
import { gitArtifactPublicationProvider } from "../../packages/runtime/dist/adapters/artifact-publication-git.js";
const config = JSON.parse(readFileSync(0, "utf8"));
const base = `https://api.cloudflare.com/client/v4/accounts/${config.account}`;
async function api(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: "Bearer " + config.credential,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw Error("Cloudflare API HTTP " + response.status);
  const data = await response.json();
  if (!data.success) throw Error("Cloudflare API rejected request");
  return data.result;
}
const query = async (s) => {
  const rows = await api(`/d1/database/${config.database}/query`, s);
  if (rows.length !== 1 || rows[0].success !== true)
    throw Error("D1 query rejected");
  return rows[0];
};
const sql = {
  facade: "live-d1-rest",
  first: async (s) => (await query(s)).results[0] ?? null,
  all: async (s) => (await query(s)).results,
  run: async (s) => ({ changes: (await query(s)).meta.changes }),
  batch: async () => {
    throw Error("Qualification does not use batch");
  },
};
async function workerJournal(action, intent, outcome) {
  const response = await fetch(config.journalWorker.url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + config.journalWorker.secret,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 ForgeArtifactQualification",
    },
    body: JSON.stringify({ action, intent, outcome }),
    signal: AbortSignal.timeout(45000),
  });
  const payload = await response.text();
  let reply;
  try {
    reply = JSON.parse(payload);
  } catch {
    throw Object.assign(Error("Worker returned non-JSON"), {
      code: "WorkerNonJson",
      httpStatus: response.status,
      platformCode: /^error code: (\d+)\s*$/.exec(payload)?.[1],
      bodySha256: createHash("sha256").update(payload).digest("hex"),
    });
  }
  if (!response.ok)
    throw Object.assign(Error("Workers journal request failed"), {
      code: reply.code,
      httpStatus: response.status,
    });
  return reply.value;
}
const journal = () =>
  config.journalWorker
    ? {
        initialize: () => workerJournal("initialize"),
        claim: (intent) => workerJournal("claim", intent),
        get: (intent) => workerJournal("get", intent),
        finish: (intent, outcome) => workerJournal("finish", intent, outcome),
      }
    : new SqlArtifactPublicationJournal(sql);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Qualification",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Qualification",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (args, input) =>
  execFileSync("git", ["-C", config.directory, ...args], {
    input,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
async function head(ref) {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      ["ls-remote", config.remote, ref],
      {
        env: {
          ...gitEnv,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: "Authorization: Bearer " + config.token,
        },
        timeout: 45000,
      },
      (error, stdout) => {
        if (error) return reject(Error("Git head lookup failed"));
        resolve(stdout.trim() ? stdout.trim().split(/\s+/)[0] : null);
      },
    ),
  );
}
const identity = {
  open: async () => {
    const info = await api(
      `/artifacts/namespaces/forge-runtime-cert/repos/${config.repo}`,
    );
    return {
      repositoryId: info.id,
      objectFormat: "sha1",
      resolve: head,
      commit: async () => {
        throw Error("unused");
      },
      file: async () => {
        throw Error("unused");
      },
      dispose() {},
    };
  },
};
const transport = gitArtifactPublicationProvider({
  directory: config.directory,
  remote: config.remote,
  identity,
  token: async () => config.token,
});
let dispatches = 0;
const counted = {
  open: async () => {
    const repo = await transport.open();
    return {
      ...repo,
      compareAndSwap: async (...args) => {
        dispatches++;
        return repo.compareAndSwap(...args);
      },
    };
  },
};
const publisher = (provider = counted, store = journal(), allow = true) =>
  new ArtifactPublisher(
    [
      {
        tenant: "qualification",
        artifact: "fixture",
        generation: "one",
        repositoryId: config.repoId,
        provider,
      },
    ],
    store,
    async () => allow,
  );
const ctx = {
  tenant: "qualification",
  actor: "qualification",
  requestId: "live",
};
const tests = [];
const record = (name) => {
  tests.push({ name, status: "passed" });
};
try {
  if (process.argv.includes("--replay")) {
    assert.equal(
      (await publisher().publish(config.replay, ctx)).outcome,
      "accepted",
    );
    assert.equal(dispatches, 0);
    process.stdout.write(JSON.stringify({ replayed: true }));
  } else {
    mkdirSync(config.directory);
    git(["init", "--bare"]);
    const tree = git(["mktree"], "");
    const commit = (parent, message) =>
      git(
        ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
        message + "\n",
      );
    const root = commit(null, "root"),
      a = commit(root, "a"),
      b = commit(root, "b");
    const request = (key, oid, expected, ref = "refs/heads/main") => ({
      key,
      ref,
      expected,
      revision: {
        tenant: "qualification",
        artifact: "fixture",
        generation: "one",
        repositoryId: config.repoId,
        objectFormat: "sha1",
        oid,
        tree,
      },
    });
    await journal().initialize();
    await journal().initialize();
    record("Live D1 journal provisioned idempotently");
    const first = request("initial", root, null);
    assert.equal((await publisher().publish(first, ctx)).outcome, "accepted");
    assert.equal(await head(first.ref), root);
    record(
      "Runtime publisher accepts expected-absent push and persists D1 receipt",
    );
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--replay"],
      {
        input: JSON.stringify({ ...config, replay: first }),
        encoding: "utf8",
        timeout: 60000,
      },
    );
    if (child.status !== 0) {
      let failure;
      try {
        failure = JSON.parse(child.stdout);
      } catch {
        failure = {};
      }
      throw Object.assign(Error("Fresh-process replay failed"), {
        code:
          typeof failure.errorCode === "string"
            ? failure.errorCode
            : "ReplayFailed",
        httpStatus: failure.httpStatus,
        platformCode: failure.platformCode,
        bodySha256: failure.bodySha256,
      });
    }
    assert.equal(JSON.parse(child.stdout).replayed, true);
    record(
      "Fresh Node process replays durable D1 receipt without Git dispatch",
    );
    const before = dispatches;
    const same = request("duplicate", root, null, "refs/heads/duplicate");
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () => publisher().publish(same, ctx)),
    );
    assert.equal(dispatches - before, 1);
    assert(
      duplicates.every((x) => ["pending", "accepted"].includes(x.outcome)),
    );
    assert.equal((await publisher().publish(same, ctx)).outcome, "accepted");
    record("Concurrent runtime instances claim one D1 dispatch for one key");
    const contenders = [
      request("writer-a", a, root),
      request("writer-b", b, root),
    ];
    const outcomes = await Promise.all(
      contenders.map((r) => publisher().publish(r, ctx)),
    );
    assert.equal(outcomes.filter((x) => x.outcome === "accepted").length, 1);
    const winner = await head(first.ref);
    assert.equal(
      winner,
      outcomes.find((x) => x.outcome === "accepted").intent.revision.oid,
    );
    const loserIndex = outcomes.findIndex((x) => x.outcome !== "accepted"),
      beforeReplay = dispatches;
    assert(["pending", "rejected"].includes(outcomes[loserIndex].outcome));
    assert.equal(
      (await publisher().publish(contenders[loserIndex], ctx)).outcome,
      outcomes[loserIndex].outcome,
    );
    assert.equal(
      (await publisher().recover(contenders[loserIndex], ctx)).outcome,
      outcomes[loserIndex].outcome,
    );
    assert.equal(dispatches, beforeReplay);
    assert.equal(await head(first.ref), winner);
    record(
      "Concurrent journaled expected-head writers admit exactly one accepted update",
    );
    assert.equal(
      (await publisher().publish(request("stale", root, root), ctx)).outcome,
      "rejected",
    );
    assert.equal(await head(first.ref), winner);
    record("Stale expected head persists rejection without overwriting winner");
    const noOp = request("noop", winner, root);
    assert.equal((await publisher().publish(noOp, ctx)).outcome, "pending");
    assert.equal((await publisher().recover(noOp, ctx)).outcome, "observed");
    record("Live Git no-op cannot certify a stale precondition");
    const lost = request("lost-ack", root, null, "refs/heads/lost");
    const drop = {
      open: async () => {
        const repo = await counted.open();
        return {
          ...repo,
          compareAndSwap: async (...args) => {
            assert.equal(await repo.compareAndSwap(...args), "accepted");
            throw Error("Injected lost acknowledgement");
          },
        };
      },
    };
    assert.equal((await publisher(drop).publish(lost, ctx)).outcome, "pending");
    const afterLost = dispatches;
    assert.equal((await publisher().recover(lost, ctx)).outcome, "observed");
    await publisher().publish(lost, ctx);
    assert.equal(dispatches, afterLost);
    record(
      "Injected lost acknowledgement after real push recovers by observation without resend",
    );
    const missing = request("not-dispatched", root, null, "refs/heads/missing");
    const crashStore = journal();
    await crashStore.claim({ ...missing, actor: ctx.actor, purpose: null });
    assert.equal((await publisher().recover(missing, ctx)).outcome, "pending");
    assert.equal((await publisher().publish(missing, ctx)).outcome, "pending");
    assert.equal(dispatches, afterLost);
    record(
      "Durable claim without dispatch remains pending without automatic takeover",
    );
    const failRequest = request(
      "failed-receipt",
      root,
      null,
      "refs/heads/receipt",
    );
    const broken = journal();
    broken.finish = async () => {
      throw Error("Injected receipt failure");
    };
    await assert.rejects(publisher(counted, broken).publish(failRequest, ctx), {
      code: "StorageUnavailable",
    });
    const afterFailure = dispatches;
    assert.equal(
      (await publisher().recover(failRequest, ctx)).outcome,
      "observed",
    );
    assert.equal(dispatches, afterFailure);
    record(
      "Injected terminal persistence failure after real push recovers from D1 intent",
    );
    await assert.rejects(
      publisher(counted, journal(), false).publish(first, ctx),
      { code: "NotPermitted" },
    );
    await assert.rejects(
      publisher().publish({ ...first, expected: root }, ctx),
      { code: "IdempotencyMismatch" },
    );
    await assert.rejects(
      publisher().publish(first, { ...ctx, tenant: "foreign" }),
      { code: "NotPermitted" },
    );
    record(
      "Live receipt replay enforces authorization tenant and immutable intent",
    );
    process.stdout.write(
      JSON.stringify({
        status: "passed",
        tests,
        dispatches,
        concurrentOutcomes: outcomes.map((x) => x.outcome),
      }),
    );
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      status: "failed",
      tests,
      ...(Number.isInteger(error?.httpStatus)
        ? {
            httpStatus: error.httpStatus,
            platformCode: error.platformCode,
            bodySha256: error.bodySha256,
          }
        : {}),
      errorCode:
        typeof error?.code === "string" && /^[A-Za-z_]+$/.test(error.code)
          ? error.code
          : "QualificationFailed",
    }),
  );
  process.exitCode = 1;
}
