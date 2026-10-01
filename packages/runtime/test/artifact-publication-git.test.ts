import { DatabaseSync } from "node:sqlite";
import { ArtifactPublisher } from "../src/artifact-publication.js";
import { SqlArtifactPublicationJournal } from "../src/adapters/artifact-publication-sql.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitArtifactPublicationProvider } from "../src/adapters/artifact-publication-git.js";

it("publishes real Git objects with expected-absent/exact-head CAS and rejects a stale writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-cas-"));
  const git = (cwd: string, args: string[], input?: string) =>
    execFileSync("git", ["-C", cwd, ...args], {
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  try {
    git(dir, ["init", "--bare", "source"]);
    git(dir, ["init", "--bare", "remote"]);
    const source = join(dir, "source"),
      remote = join(dir, "remote"),
      tree = git(source, ["mktree"], "");
    const a = git(source, ["commit-tree", tree], "a\n"),
      b = git(source, ["commit-tree", tree, "-p", a], "b\n");
    git(source, ["config", "push.followTags", "true"]);
    git(source, ["tag", "-a", "unexpected", "-m", "tag", a]);
    const provider = gitArtifactPublicationProvider({
      directory: source,
      remote,
      identity: {
        open: async () => ({
          repositoryId: "repo",
          objectFormat: "sha1",
          resolve: async (ref) => {
            try {
              return git(remote, ["rev-parse", "--verify", ref]);
            } catch {
              return null;
            }
          },
          commit: async () => null,
          file: async () => null,
          dispose: () => {},
        }),
      },
    });
    const repo = await provider.open();
    expect((await repo.commit(a))?.tree).toBe(tree);
    expect(await repo.compareAndSwap("refs/heads/main", null, a)).toBe(
      "accepted",
    );
    expect(git(remote, ["tag", "--list"])).toBe("");
    expect(await repo.compareAndSwap("refs/heads/main", a, b)).toBe("accepted");
    expect(await repo.compareAndSwap("refs/heads/main", a, a)).toBe("rejected");
    expect(await repo.head("refs/heads/main")).toBe(b);
    // Git can report up-to-date without evaluating a stale lease. Never certify that as CAS success.
    await expect(repo.compareAndSwap("refs/heads/main", a, b)).rejects.toThrow(
      "Unknown Git publication outcome",
    );
    await expect(repo.compareAndSwap("--bad", b, a)).rejects.toThrow();
    repo.dispose();
    const db = new DatabaseSync(join(dir, "receipts.sqlite"));
    try {
      const journal = new SqlArtifactPublicationJournal({
        facade: "sqlite",
        first: async (s) =>
          (db.prepare(s.sql).get(...(s.params as any[])) ?? null) as any,
        all: async (s) => db.prepare(s.sql).all(...(s.params as any[])) as any,
        run: async (s) => ({
          changes: Number(
            db.prepare(s.sql).run(...(s.params as any[])).changes,
          ),
        }),
        batch: async () => {
          throw Error("unused");
        },
      });
      await journal.initialize();
      const publisher = () =>
        new ArtifactPublisher(
          [
            {
              tenant: "tenant",
              artifact: "source",
              generation: "one",
              repositoryId: "repo",
              provider,
            },
          ],
          journal,
          async () => true,
        );
      const request = {
        key: "publish",
        ref: "refs/heads/release",
        expected: null,
        revision: {
          tenant: "tenant",
          artifact: "source",
          generation: "one",
          repositoryId: "repo",
          objectFormat: "sha1" as const,
          oid: b,
          tree,
        },
      };
      const ctx = { tenant: "tenant", actor: "alice", requestId: "test" };
      expect((await publisher().publish(request, ctx)).outcome).toBe(
        "accepted",
      );
      git(remote, ["update-ref", "refs/heads/release", a]);
      expect((await publisher().publish(request, ctx)).outcome).toBe(
        "accepted",
      );
      expect(git(remote, ["rev-parse", "refs/heads/release"])).toBe(a);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
