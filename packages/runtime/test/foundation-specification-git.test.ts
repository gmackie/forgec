import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { GitSpecificationProvider } from "../src/foundation/git-specification.js";
import { resolveSpecificationSelector, resolveSpecificationSourceSpan } from "../src/foundation/specification.js";

it("resolves real Git commits, moved anchors and pinned dependency closure without floating", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-pinned-git-"));
  // Build fixture Git objects directly; no checkout, shell, network or user Git configuration.
  const git = (args: string[], input = "") => new Promise<string>((resolve, reject) => {
    const child = execFile("git", ["-C", directory, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin!.on("error", reject);
    if (input) child.stdin!.end(input);
    else child.stdin!.destroy();
  });
  try {
    await git(["init", "--bare"]);
    const anchor = "@fixture/app/_/Definition";
    let parent: string | undefined;
    async function commit(file: string, text: string, lock: string, mismatched = false) {
      const blob = (text: string) => git(["hash-object", "-w", "--stdin"], text);
      const source = await blob(text);
      const tree = await git(["mktree"], `100644 blob ${source}\t${file}\n`);
      const map = await blob(JSON.stringify({ version: "forge-source-map/1", sources: { [`src/${file}`]: { digest: "sha256:" + createHash("sha256").update(mismatched ? "incorrect" : text).digest("hex"), byteLength: Buffer.byteLength(text) } }, anchors: { [anchor]: { file: `src/${file}`, start: 0, end: Buffer.byteLength(text) } } }));
      const root = await git(["mktree"], `040000 tree ${tree}\tsrc\n100644 blob ${map}\tsource-map.json\n100644 blob ${await blob(lock)}\tforge.lock\n`);
      parent = await git(["commit-tree", root, ...(parent ? ["-p", parent] : [])], "fixture\n");
      await git(["update-ref", "refs/heads/discovery", parent]);
    }
    await commit("old.forge", "resource Definition { id : id }", "dependency-v1");
    const provider = new GitSpecificationProvider({ repo: { directory, sourceMap: "source-map.json" } });
    const request = { repository: "repo", anchor, selector: "discovery" };
    const old = await resolveSpecificationSelector(provider, request);
    await commit("new.forge", "resource Definition { id : id\n name : text }", "dependency-v2");
    const next = await resolveSpecificationSelector(provider, request);
    expect(old.revision).not.toBe(next.revision);
    expect((await resolveSpecificationSourceSpan(provider, old)).file).toBe("src/old.forge");
    expect((await resolveSpecificationSourceSpan(provider, next)).file).toBe("src/new.forge");
    expect(await provider.lockfile(old)).toBe("dependency-v1");
    await expect(resolveSpecificationSelector(provider, { ...request, repository: "unconfigured" })).rejects.toThrow();
    await expect(resolveSpecificationSelector(provider, { ...request, anchor: "missing" })).rejects.toThrow();
    await expect(resolveSpecificationSelector(provider, { ...request, selector: "--help" })).rejects.toThrow();
    await commit("new.forge", "tampered", "dependency-v3", true);
    await expect(resolveSpecificationSelector(provider, request)).rejects.toThrow("digest mismatch");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
