import { Cause, Effect } from "effect";
import {
  D1Storage,
  Model,
  ForgeError,
  type AppBundle,
} from "@forgegraph/runtime";
import type { D1Like } from "@forgegraph/runtime/d1";
import type { SqlExecutor } from "@forgegraph/runtime/sql-executor";
import { composeRuntime } from "@forgegraph/runtime/compose";
import bundle from "../studio/compiled/app.json";
import { Problem } from "./model.js";
import type { GitRepository } from "./git.js";

export const studioBundle = bundle as unknown as AppBundle;
export class Studio {
  private engine;
  constructor(db: D1Like | SqlExecutor, secret: string) {
    this.engine = composeRuntime({
      bundle: studioBundle,
      store: new D1Storage(db, new Model(studioBundle)),
      cursorSecret: secret,
    }).engine;
  }
  async call(resource: string, operation: string, input: unknown) {
    const result = await Effect.runPromiseExit(
      this.engine.call(`@forge/studio/_/${resource}.${operation}`, input, {
        tenant: "studio",
        actor: "console-administrator",
        requestId: crypto.randomUUID(),
      }),
    );
    if (result._tag === "Success") return result.value;
    const error = Cause.squash(result.cause);
    if (error instanceof ForgeError)
      throw new Problem(error.status, error.detail ?? error.message);
    throw error;
  }
  async repository(git: GitRepository) {
    const p = git.project;
    let existing;
    try {
      existing = await this.call("Repository", "find.byProjectKey", {
        params: { projectKey: p.id },
      });
    } catch (e) {
      if (!(e instanceof Problem) || e.status !== 404) throw e;
    }
    if (existing) {
      if (existing.locator !== p.repository || existing.sourceRoot !== p.root)
        throw new Problem(
          409,
          "Repository configuration changed. Use a new project ID to preserve review provenance.",
        );
      return existing;
    }
    try {
      return await this.call("Repository", "create", {
        projectKey: p.id,
        name: p.name,
        locator: p.repository,
        defaultBranch: p.branch,
        sourceRoot: p.root,
      });
    } catch (e) {
      if (!(e instanceof Problem) || e.status !== 409) throw e;
      return this.call("Repository", "find.byProjectKey", {
        params: { projectKey: p.id },
      });
    }
  }
  async observe(
    git: GitRepository,
    branches: { name: string; revision: string }[],
    commits: { revision: string; message: string; url: string }[],
  ) {
    const repository = await this.repository(git);
    for (const branch of branches) {
      const key = `${repository.id}:${branch.name}`;
      let row;
      try {
        row = await this.call("Branch", "find.byKey", { params: { key } });
      } catch (e) {
        if (!(e instanceof Problem) || e.status !== 404) throw e;
      }
      if (!row) {
        try {
          await this.call("Branch", "create", {
            key,
            repository: repository.id,
            name: branch.name,
            head: branch.revision,
          });
        } catch (e) {
          if (!(e instanceof Problem) || e.status !== 409) throw e;
        }
      } else if (row.head !== branch.revision)
        try {
          await this.call("Branch", "update", {
            id: row.id,
            expectedVersion: row.version,
            patch: { head: branch.revision },
          });
        } catch (e) {
          if (!(e instanceof Problem) || e.status !== 412) throw e;
        }
    }
    for (const c of commits)
      try {
        await this.call("RepositoryCommit", "create", {
          key: `${repository.id}:${c.revision}`,
          repository: repository.id,
          revision: c.revision,
          url: c.url,
          message: c.message.slice(0, 4000),
        });
      } catch (e) {
        if (!(e instanceof Problem) || e.status !== 409) throw e;
      }
    return repository;
  }
  async list(git: GitRepository, resource: string, cursor?: string) {
    const repository = await this.repository(git);
    return this.call(resource, "list.byRepository", {
      params: { repository: repository.id },
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
  }
  async submit(
    git: GitRepository,
    input: {
      title: string;
      description: string;
      baseBranch: string;
      headBranch: string;
      headRevision: string;
    },
  ) {
    if (input.baseBranch === input.headBranch)
      throw new Problem(
        400,
        "Select a separate change branch before requesting review.",
      );
    const [base, head] = await Promise.all([
      git.onBranch(input.baseBranch).snapshot(),
      git.onBranch(input.headBranch).snapshot(),
    ]);
    if (head.revision !== input.headRevision)
      throw new Problem(
        409,
        "The change branch moved. Reload it before submitting a review.",
      );
    if (
      base.files.length === head.files.length &&
      base.files.every((f) =>
        head.files.some((h) => h.path === f.path && h.text === f.text),
      )
    )
      throw new Problem(400, "There are no Forge changes to review.");
    const repository = await this.observe(
      git,
      [
        { name: input.baseBranch, revision: base.revision },
        { name: input.headBranch, revision: head.revision },
      ],
      [],
    );
    return this.call("ChangeReview", "create", {
      repository: repository.id,
      ...input,
      baseRevision: base.revision,
    });
  }
  async review(git: GitRepository, id: string) {
    const row = await this.call("ChangeReview", "get", { id });
    const repository = await this.repository(git);
    if (row.repository !== repository.id)
      throw new Problem(404, "Review not found in this repository.");
    return row;
  }
  async detail(git: GitRepository, id: string) {
    const review = await this.review(git, id);
    const [base, head, baseHead, headHead, comments] = await Promise.all([
      git.snapshot(review.baseRevision),
      git.snapshot(review.headRevision),
      git.onBranch(review.baseBranch).head(),
      git.onBranch(review.headBranch).head(),
      this.call("ReviewComment", "list.byReview", {
        params: { review: id },
        limit: 100,
      }),
    ]);
    const paths = [
      ...new Set([...base.files, ...head.files].map((f) => f.path)),
    ];
    return {
      review,
      outdated:
        baseHead !== review.baseRevision || headHead !== review.headRevision,
      files: paths
        .map((path) => ({
          path,
          before: base.files.find((f) => f.path === path)?.text,
          after: head.files.find((f) => f.path === path)?.text,
        }))
        .filter((f) => f.before !== f.after),
      comments,
    };
  }
  async decide(
    git: GitRepository,
    id: string,
    action: string,
    expectedVersion: number,
  ) {
    const row = await this.review(git, id);
    if (action !== "close") {
      const [base, head] = await Promise.all([
        git.onBranch(row.baseBranch).head(),
        git.onBranch(row.headBranch).head(),
      ]);
      if (base !== row.baseRevision || head !== row.headRevision)
        throw new Problem(
          409,
          "This review is outdated. Submit a new review for the current commits.",
        );
    }
    return this.call("ChangeReview", `status.${action}`, {
      id,
      expectedVersion,
      input: {},
    });
  }
}
