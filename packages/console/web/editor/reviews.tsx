import React, { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import type { GitSnapshot } from "../../src/git.js";
import { SourceEditor } from "./source-editor.js";
type GitApi = (path: string, body?: unknown) => Promise<any>;

export function RepositoryWorkspace({
  snapshot,
  api,
  dirty,
  onLoad,
}: {
  snapshot: GitSnapshot;
  api: GitApi;
  dirty: boolean;
  onLoad: (branch: string) => Promise<void>;
}) {
  const [tab, setTab] = useState("Branches"),
    [rows, setRows] = useState<any[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [acting, setActing] = useState(false);
  const busy = loading || acting;
  const [page, setPage] = useState(1),
    [more, setMore] = useState(false),
    [cursor, setCursor] = useState<string | undefined>(),
    [next, setNext] = useState<string | undefined>();
  const [branch, setBranch] = useState(""),
    [base, setBase] = useState(""),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState("");
  const [detail, setDetail] = useState<any>(null),
    [comment, setComment] = useState("");
  const [artifact, setArtifact] = useState({
    digest: "",
    location: "",
    byteCount: "",
    compilerVersion: "",
    irVersion: "",
  });
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const root = `/${snapshot.id}`;
  async function load() {
    const request = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const section =
        tab === "Branches"
          ? "branches"
          : tab === "Commits"
            ? "commits"
            : tab === "Reviews"
              ? "reviews"
              : "artifacts";
      const data = await api(
        `${root}/${section}?branch=${encodeURIComponent(snapshot.branch)}&page=${page}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (request !== epoch.current) return;
      setRows(data.items);
      setMore(data.hasMore || !!data.next);
      setNext(data.next || undefined);
    } catch (e) {
      if (request === epoch.current) setError((e as Error).message);
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [tab, page, cursor, snapshot.id, snapshot.branch, snapshot.revision]);
  async function act(task: () => Promise<void>) {
    setActing(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  }
  async function openReview(id: string) {
    setDetail(await api(`${root}/reviews/${id}`));
    setComment("");
  }
  return (
    <section className="repository-workspace" aria-label="Repository workspace">
      <header>
        <div>
          <p className="eyebrow">REPOSITORY</p>
          <h3>{snapshot.repository}</h3>
          <p>
            {snapshot.branch} · <code>{snapshot.revision.slice(0, 12)}</code>
          </p>
        </div>
        <Button disabled={busy} onClick={() => void load()}>
          Refresh repository
        </Button>
      </header>
      <nav aria-label="Repository tools">
        {["Branches", "Commits", "Reviews", "IR artifacts"].map((t) => (
          <Button
            key={t}
            aria-pressed={tab === t}
            disabled={busy}
            onClick={() => {
              setTab(t);
              setRows([]);
              setPage(1);
              setCursor(undefined);
              setDetail(null);
            }}
          >
            {t}
          </Button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {tab === "Branches" && (
        <>
          <p>
            Opening another branch replaces the design draft. Save your changes
            first.
          </p>
          <form
            className="editor-row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(`${root}/branches`, {
                  name: branch,
                  revision: snapshot.revision,
                });
                setBranch("");
                await load();
              });
            }}
          >
            <Input
              aria-label="New branch name"
              placeholder="studio/my-change"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              required
              disabled={busy}
            />
            <Button type="submit" disabled={busy}>
              Create branch from this commit
            </Button>
          </form>
          <ul>
            {rows.map((r) => (
              <li key={r.name}>
                <strong>{r.name}</strong> <code>{r.revision.slice(0, 12)}</code>{" "}
                {r.protected && <span>Protected</span>}
                <Button
                  disabled={busy || dirty || r.name === snapshot.branch}
                  onClick={() => void act(() => onLoad(r.name))}
                >
                  Open {r.name}
                </Button>
              </li>
            ))}
          </ul>
          {dirty && (
            <p>Save or export your draft before opening another branch.</p>
          )}
        </>
      )}
      {tab === "Commits" && (
        <ol>
          {rows.map((r) => (
            <li key={r.revision}>
              <strong>{r.message.split("\n")[0]}</strong>
              <p>
                <code>{r.revision.slice(0, 12)}</code> · {r.author} · {r.at}
              </p>
            </li>
          ))}
        </ol>
      )}
      {tab === "Reviews" && (
        <>
          <p>
            Forge reviews are pinned to committed changes. Approval does not
            merge or deploy them. Decisions use this instance's administrator
            identity.
          </p>
          <form
            className="review-create"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const review = await api(`${root}/reviews`, {
                  title,
                  description,
                  baseBranch: base,
                  headBranch: snapshot.branch,
                  headRevision: snapshot.revision,
                });
                setTitle("");
                setDescription("");
                await load();
                await openReview(review.id);
              });
            }}
          >
            <Input
              label="Review title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              disabled={busy || dirty}
            />
            <Input
              label="Target branch"
              placeholder="main"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              required
              disabled={busy || dirty}
            />
            <Textarea
              aria-label="Review description"
              placeholder="What changed and why?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy || dirty}
            />
            <Button
              type="submit"
              disabled={busy || dirty || base === snapshot.branch}
            >
              Submit committed changes for review
            </Button>
            {dirty && (
              <p>
                Save this draft to its change branch before submitting a review.
              </p>
            )}
          </form>
          <ul>
            {rows.map((r) => (
              <li key={r.id}>
                <Button
                  disabled={busy}
                  onClick={() => void act(() => openReview(r.id))}
                >
                  {r.title}
                </Button>
                <span>
                  {r.status} · {r.headBranch} → {r.baseBranch}
                </span>
              </li>
            ))}
          </ul>
          {detail && (
            <section className="review-detail" aria-label="Change review">
              <h4>{detail.review.title}</h4>
              <p>{detail.review.description}</p>
              <p>
                {detail.review.status} ·{" "}
                <code>
                  {detail.review.baseRevision.slice(0, 12)} →{" "}
                  {detail.review.headRevision.slice(0, 12)}
                </code>
              </p>
              {detail.outdated && (
                <p role="alert">
                  A branch has moved. Submit a new review for the current
                  commits; this diff remains pinned to the original revisions.
                </p>
              )}
              {detail.files.map((f: any) => (
                <details key={f.path} open>
                  <summary>
                    {f.path} ·{" "}
                    {f.before === undefined
                      ? "Added"
                      : f.after === undefined
                        ? "Deleted"
                        : "Modified"}
                  </summary>
                  <div className="commit-diff">
                    <div>
                      <h5>Base</h5>
                      <SourceEditor value={f.before ?? ""} readOnly />
                    </div>
                    <div>
                      <h5>Proposed</h5>
                      <SourceEditor value={f.after ?? ""} readOnly />
                    </div>
                  </div>
                </details>
              ))}
              <div className="editor-row">
                {[
                  ["approve", "Approve"],
                  ["requestChanges", "Request changes"],
                  ["close", "Close review"],
                ].map(([action, label]) => (
                  <Button
                    key={action}
                    disabled={
                      busy ||
                      detail.review.status !== "Open" ||
                      (detail.outdated && action !== "close")
                    }
                    onClick={() =>
                      void act(async () => {
                        await api(
                          `${root}/reviews/${detail.review.id}/decisions`,
                          { action, expectedVersion: detail.review.version },
                        );
                        await openReview(detail.review.id);
                        await load();
                      })
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <h5>Discussion</h5>
              {detail.comments.items.map((c: any) => (
                <article key={c.id}>
                  <strong>{c.author}</strong>
                  <p>{c.body}</p>
                </article>
              ))}
              {detail.comments.next && <p>Showing the first 100 comments.</p>}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await api(`${root}/reviews/${detail.review.id}/comments`, {
                      body: comment,
                    });
                    await openReview(detail.review.id);
                  });
                }}
              >
                <Textarea
                  aria-label="Review comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  required
                  disabled={busy}
                />
                <Button type="submit" disabled={busy}>
                  Add comment
                </Button>
              </form>
            </section>
          )}
        </>
      )}
      {tab === "IR artifacts" && (
        <>
          <p>
            Register content-addressed IR stored in your artifact system. This
            catalog records provenance; it does not upload or verify remote
            payloads.
          </p>
          <form
            className="artifact-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(`${root}/artifacts`, {
                  ...artifact,
                  byteCount: Number(artifact.byteCount),
                  revision: snapshot.revision,
                });
                await load();
              });
            }}
          >
            {(
              [
                ["digest", "SHA-256 digest"],
                ["location", "Artifact URL (HTTPS or OCI)"],
                ["byteCount", "Size in bytes"],
                ["compilerVersion", "Compiler version"],
                ["irVersion", "IR format version"],
              ] as const
            ).map(([key, label]) => (
              <Input
                key={key}
                label={label}
                value={artifact[key]}
                onChange={(e) =>
                  setArtifact({ ...artifact, [key]: e.target.value })
                }
                required
                disabled={busy}
              />
            ))}
            <Button type="submit" disabled={busy}>
              Register IR artifact for this commit
            </Button>
          </form>
          <ul>
            {rows.map((r) => (
              <li key={r.id}>
                <code>{r.digest}</code>
                <p>
                  {r.revision.slice(0, 12)} · {r.byteCount} bytes · Compiler{" "}
                  {r.compilerVersion} · IR {r.irVersion}
                </p>
                <p>{r.location}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      {!rows.length && !busy && <p>No {tab.toLowerCase()} to show.</p>}
      {busy && <p role="status">Loading repository information…</p>}
      <footer>
        <Button
          disabled={busy || (page === 1 && !cursor)}
          onClick={() => {
            setPage(1);
            setCursor(undefined);
          }}
        >
          First page
        </Button>
        <Button
          disabled={busy || !more}
          onClick={() => {
            if (next) setCursor(next);
            else setPage((p) => p + 1);
          }}
        >
          Next page
        </Button>
      </footer>
    </section>
  );
}
