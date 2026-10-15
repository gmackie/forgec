import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { workerGitArtifactPublicationProvider } from "../src/adapters/artifact-publication-workers.js";
import {
  WorkerArtifactWorkspace,
  WorkerGitPackStore,
} from "../src/adapters/artifact-workspace-workers.js";
import { ArtifactPublisher } from "../src/artifact-publication.js";
import { SqlArtifactPublicationJournal } from "../src/adapters/artifact-publication-sql.js";
import type { SqlExecutor } from "../src/adapters/sql-executor.js";
const context = { tenant: "tenant", actor: "alice", requestId: "test" };
const binding = {
  tenant: "tenant",
  artifact: "source",
  generation: "one",
  repositoryId: "repo",
  objectFormat: "sha1" as const,
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const pkt = (text: string) =>
  (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "forge-worker-http-"));
  dirs.push(dir);
  const path = join(dir, "repo.git");
  const git = (args: string[], input?: Uint8Array) =>
    execFileSync(
      "git",
      ["--no-replace-objects", "--git-dir=" + path, ...args],
      { input, stdio: ["pipe", "pipe", "pipe"] },
    );
  git(["init", "--bare"]);
  git(["config", "http.receivepack", "true"]);
  const head = () => {
    try {
      return git(["rev-parse", "--verify", "refs/heads/main"])
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  const prepared = new WorkerGitPackStore();
  const workspace = new WorkerArtifactWorkspace(
    binding,
    prepared,
    async () => true,
  );
  const revision = await workspace.prepare(
    {
      base: null,
      changes: [{ path: "binary", bytes: new Uint8Array([0, 255, 128]) }],
      message: "http publication",
      at: "2026-10-15T00:00:00Z",
    },
    context,
  );
  let posts = 0;
  let beforePost = () => {};
  let afterPost = (response: Response): Response => response;
  let transformGet = (response: Response): Response => response;
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://artifacts.example");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-only-token",
    );
    if (init?.method === "POST") {
      posts++;
      beforePost();
    }
    const body = init?.body
      ? Buffer.from(init.body as Uint8Array)
      : Buffer.alloc(0);
    const output = execFileSync("git", ["http-backend"], {
      input: body,
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: dir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: init?.method ?? "GET",
        CONTENT_TYPE: new Headers(init?.headers).get("content-type") ?? "",
        CONTENT_LENGTH: String(body.length),
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    const split = output.indexOf("\r\n\r\n");
    expect(split).toBeGreaterThan(0);
    const headers = new Headers();
    let status = 200;
    for (const line of output.subarray(0, split).toString().split("\r\n")) {
      const at = line.indexOf(":");
      if (line.startsWith("Status:"))
        status = Number(
          line
            .slice(at + 1)
            .trim()
            .split(" ")[0],
        );
      else headers.append(line.slice(0, at), line.slice(at + 1).trim());
    }
    const response = new Response(output.subarray(split + 4), {
      status,
      headers,
    });
    return init?.method === "POST"
      ? afterPost(response)
      : transformGet(response);
  };
  const identity: any = {
    open: async () => ({
      repositoryId: "repo",
      objectFormat: "sha1",
      resolve: async () => head(),
      dispose: () => {},
    }),
  };
  const options = {
    remote: "https://artifacts.example/repo.git",
    identity,
    prepared,
    token: async () => "test-only-token",
    fetch: send,
  };
  const provider = workerGitArtifactPublicationProvider(options);
  const db = new DatabaseSync(":memory:");
  const executor: SqlExecutor = {
    facade: "sqlite",
    first: async (s) =>
      (db.prepare(s.sql).get(...(s.params as any[])) ?? null) as any,
    all: async (s) => db.prepare(s.sql).all(...(s.params as any[])) as any,
    run: async (s) => ({
      changes: Number(db.prepare(s.sql).run(...(s.params as any[])).changes),
    }),
    batch: async () => {
      throw Error("unused");
    },
  };
  const journal = new SqlArtifactPublicationJournal(executor);
  await journal.initialize();
  const publisher = (allowed = true) =>
    new ArtifactPublisher(
      [{ ...binding, provider }],
      journal,
      async () => allowed,
    );
  const request = {
    key: "operation",
    ref: "refs/heads/main",
    expected: null,
    revision,
  };
  return {
    git,
    head,
    provider,
    options,
    publisher,
    request,
    revision,
    db,
    get posts() {
      return posts;
    },
    before: (fn: () => void) => (beforePost = fn),
    after: (fn: typeof afterPost) => (afterPost = fn),
    advertisement: (fn: typeof transformGet) => (transformGet = fn),
  };
}
it("publishes a portable pack into an empty real Git server and persists replay receipts", async () => {
  const f = await fixture();
  try {
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "accepted",
    );
    expect(f.head()).toBe(f.revision.oid);
    expect(f.git(["show", f.revision.oid + ":binary"])).toEqual(
      Buffer.from([0, 255, 128]),
    );
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "accepted",
    );
    expect(f.posts).toBe(1);
    expect(f.git(["for-each-ref", "--format=%(refname)"]).toString()).toBe(
      "refs/heads/main\n",
    );
  } finally {
    f.db.close();
  }
});
it("rejects stale advertisements without posting", async () => {
  const f = await fixture();
  try {
    await f.publisher().publish(f.request, context);
    expect(
      (await f.publisher().publish({ ...f.request, key: "stale" }, context))
        .outcome,
    ).toBe("rejected");
    expect(f.posts).toBe(1);
  } finally {
    f.db.close();
  }
});
it("guards a competing ref create after advertisement atomically on the server", async () => {
  const f = await fixture();
  try {
    // Install objects without a ref so another writer can win after advertisement.
    f.git(["index-pack", "--stdin"], await f.options.prepared.pack());
    f.before(() => {
      f.git(["update-ref", "refs/heads/main", f.revision.oid]);
    });
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "rejected",
    );
    expect(f.head()).toBe(f.revision.oid);
    expect(f.posts).toBe(1);
  } finally {
    f.db.close();
  }
});
it("recovers lost POST acknowledgement through the SQL journal without resending", async () => {
  const f = await fixture();
  try {
    const originalOpen = f.options.identity.open;
    f.options.identity.open = async () => ({
      ...(await originalOpen()),
      resolve: async () => null,
    });
    f.after(() => {
      throw Error("lost acknowledgement");
    });
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "pending",
    );
    expect(f.head()).toBe(f.revision.oid);
    expect((await f.publisher().recover(f.request, context)).outcome).toBe(
      "observed",
    );
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "observed",
    );
    expect(f.posts).toBe(1);
  } finally {
    f.db.close();
  }
});
it.each([
  "0000",
  pkt("unpack ok\n") + pkt("ok refs/heads/other\n") + "0000",
  pkt("unpack failed\n") + pkt("ok refs/heads/main\n") + "0000",
])("keeps malformed acknowledgement pending: %s", async (status) => {
  const f = await fixture();
  try {
    f.after(
      () =>
        new Response(status, {
          headers: { "content-type": "application/x-git-receive-pack-result" },
        }),
    );
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "pending",
    );
    await f.publisher().publish(f.request, context);
    expect(f.posts).toBe(1);
  } finally {
    f.db.close();
  }
});
it("denies unauthorized and foreign tenant requests before network dispatch", async () => {
  const f = await fixture();
  try {
    await expect(
      f.publisher(false).publish(f.request, context),
    ).rejects.toMatchObject({ code: "NotPermitted" });
    await expect(
      f.publisher().publish(f.request, { ...context, tenant: "other" }),
    ).rejects.toMatchObject({ code: "NotPermitted" });
    expect(f.posts).toBe(0);
    expect(f.head()).toBeNull();
  } finally {
    f.db.close();
  }
});
it("rejects oversized advertisements and invalid capabilities without a POST", async () => {
  const f = await fixture();
  try {
    for (const body of [
      "x".repeat(1024 * 1024 + 1),
      pkt("# service=git-receive-pack\n") +
        "0000" +
        pkt("0".repeat(40) + " capabilities^{}\0object-format=sha256\n") +
        "0000",
    ]) {
      f.advertisement(
        () =>
          new Response(body, {
            headers: {
              "content-type": "application/x-git-receive-pack-advertisement",
            },
          }),
      );
      const repo = await f.provider.open();
      await expect(
        repo.compareAndSwap("refs/heads/main", null, f.revision.oid),
      ).rejects.toThrow();
      repo.dispose();
    }
    expect(f.posts).toBe(0);
  } finally {
    f.db.close();
  }
});
it("rejects credential-bearing and insecure configured remotes", async () => {
  const f = await fixture();
  try {
    for (const remote of [
      "http://artifacts.example/repo.git",
      "https://user:secret@artifacts.example/repo.git",
      "https://artifacts.example/repo.git?token=secret",
      "https://artifacts.example/repo.git#secret",
    ])
      expect(() =>
        workerGitArtifactPublicationProvider({ ...f.options, remote }),
      ).toThrow("Invalid configured Workers Git remote");
  } finally {
    f.db.close();
  }
});

it("updates an existing branch using exact old OID and preserves unrelated refs", async () => {
  const f = await fixture();
  try {
    await f.publisher().publish(f.request, context);
    f.git(["update-ref", "refs/heads/other", f.revision.oid]);
    const store = new WorkerGitPackStore();
    const next = await new WorkerArtifactWorkspace(
      binding,
      store,
      async () => true,
    ).prepare(
      {
        base: null,
        changes: [{ path: "updated", bytes: new TextEncoder().encode("next") }],
        message: "next",
        at: "2026-10-15T00:00:00Z",
      },
      context,
    );
    const repo = await workerGitArtifactPublicationProvider({
      ...f.options,
      prepared: store,
    }).open();
    try {
      expect(
        await repo.compareAndSwap("refs/heads/main", f.revision.oid, next.oid),
      ).toBe("accepted");
    } finally {
      repo.dispose();
    }
    expect(f.head()).toBe(next.oid);
    expect(f.git(["rev-parse", "refs/heads/other"]).toString().trim()).toBe(
      f.revision.oid,
    );
  } finally {
    f.db.close();
  }
});
it("rejects a race updating an existing head even after a matching advertisement", async () => {
  const f = await fixture();
  try {
    await f.publisher().publish(f.request, context);
    const store = new WorkerGitPackStore();
    const next = await new WorkerArtifactWorkspace(
      binding,
      store,
      async () => true,
    ).prepare(
      { base: null, changes: [], message: "next", at: "2026-10-15T00:00:00Z" },
      context,
    );
    f.before(() => {
      f.git(["update-ref", "-d", "refs/heads/main"]);
    });
    const repo = await workerGitArtifactPublicationProvider({
      ...f.options,
      prepared: store,
    }).open();
    try {
      expect(
        await repo.compareAndSwap("refs/heads/main", f.revision.oid, next.oid),
      ).toBe("rejected");
    } finally {
      repo.dispose();
    }
    expect(f.head()).toBeNull();
  } finally {
    f.db.close();
  }
});

it("rejects a corrupt pack before dispatch", async () => {
  const f = await fixture();
  try {
    const pack = await f.options.prepared.pack();
    pack[pack.length - 1] = pack[pack.length - 1]! ^ 1;
    const repo = await workerGitArtifactPublicationProvider({
      ...f.options,
      prepared: {
        read: f.options.prepared.read.bind(f.options.prepared),
        pack: async () => pack,
      },
    }).open();
    try {
      await expect(
        repo.compareAndSwap("refs/heads/main", null, f.revision.oid),
      ).rejects.toThrow("checksum");
    } finally {
      repo.dispose();
    }
    expect(f.posts).toBe(0);
  } finally {
    f.db.close();
  }
});

it("rejects invalid credentials and HTTP authentication errors without publishing", async () => {
  const f = await fixture();
  try {
    let requests = 0;
    for (const token of ["", "bad\r\nheader"]) {
      const repo = await workerGitArtifactPublicationProvider({
        ...f.options,
        token: async () => token,
        fetch: async () => {
          requests++;
          throw Error("unexpected");
        },
      }).open();
      try {
        await expect(
          repo.compareAndSwap("refs/heads/main", null, f.revision.oid),
        ).rejects.toThrow("Invalid repository credential");
      } finally {
        repo.dispose();
      }
    }
    expect(requests).toBe(0);
    f.advertisement(
      () =>
        new Response("denied", {
          status: 401,
          headers: {
            "content-type": "application/x-git-receive-pack-advertisement",
          },
        }),
    );
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "pending",
    );
    expect(f.posts).toBe(0);
  } finally {
    f.db.close();
  }
});

it("never follows a redirect or accepts it as a publication acknowledgement", async () => {
  const f = await fixture();
  try {
    f.advertisement(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://other.example/collect",
            "content-type": "application/x-git-receive-pack-advertisement",
          },
        }),
    );
    expect((await f.publisher().publish(f.request, context)).outcome).toBe(
      "pending",
    );
    expect(f.posts).toBe(0);
  } finally {
    f.db.close();
  }
});

it("discovers only the exact full branch name when an identically named tag exists", async () => {
  const f = await fixture();
  try {
    await f.publisher().publish(f.request, context);
    const store = new WorkerGitPackStore();
    const tag = await new WorkerArtifactWorkspace(
      binding,
      store,
      async () => true,
    ).prepare(
      { base: null, changes: [], message: "tag", at: "2026-10-15T00:00:00Z" },
      context,
    );
    f.git(["index-pack", "--stdin"], await store.pack());
    f.git(["update-ref", "refs/tags/main", tag.oid]);
    const repo = await f.provider.open();
    try {
      expect(await repo.head("refs/heads/main")).toBe(f.revision.oid);
      expect(await repo.head("refs/heads/missing")).toBeNull();
      await expect(repo.head("main")).rejects.toThrow("Invalid ref");
    } finally {
      repo.dispose();
    }
    expect(f.posts).toBe(1);
  } finally {
    f.db.close();
  }
});
