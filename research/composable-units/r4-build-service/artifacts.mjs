// A read-only tree over a Cloudflare Artifacts repository at one commit, through the Artifacts REST
// API's object routes (the ones Loom's src/loom/backends/artifacts.mjs uses): /commit/<hash>,
// /tree/<hash>, /blob/<hash>, and /log?ref= to resolve a ref. Tree objects are cached by path, so
// a lookup costs one request per directory it has not seen, and each file one blob request.
// Git objects are immutable, so everything read is fixed by the commit hash.
export const ARTIFACTS_API_BASE = "https://api.cloudflare.com/client/v4";

export async function artifactsSource({ accountId, token, namespace, repo, commit, ref, baseUrl = ARTIFACTS_API_BASE, fetch: fetchImpl = globalThis.fetch }) {
  const base = [baseUrl.replace(/\/$/, ""), "accounts", encodeURIComponent(accountId), "artifacts/namespaces", encodeURIComponent(namespace), "repos", encodeURIComponent(repo)].join("/");
  const source = { requests: 0 };
  async function request(route, { query, binary } = {}) {
    source.requests++;
    const url = `${base}${route}${query ? `?${new URLSearchParams(query)}` : ""}`;
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    if (res.ok && binary && !isJson) return new Uint8Array(await res.arrayBuffer());
    const envelope = isJson ? await res.json().catch(() => null) : null;
    if (res.ok && envelope?.success) return envelope.result;
    const upstream = envelope?.errors?.[0];
    const error = new Error(`artifacts ${route}: ${upstream ? `${upstream.code} ${upstream.message}` : `HTTP ${res.status}`}`);
    error.status = res.status;
    throw error;
  }
  if (!commit) {
    const [head] = await request("/log", { query: { ref, limit: "1" } });
    if (!head) throw new Error(`artifacts: ref not found: ${ref}`);
    commit = head.hash;
  }
  const { treeHash } = await request(`/commit/${commit}`);
  const listings = new Map();
  async function listTree(hash) {
    if (!listings.has(hash)) listings.set(hash, request(`/tree/${hash}`).then((entries) => entries.map(({ name, mode, hash, type }) => ({ name, mode, hash, type }))));
    return listings.get(hash);
  }
  /** The tree entry at `path` ("" is the root), or null. Symlinks and submodules read as absent. */
  async function stat(path) {
    const parts = path === "." || path === "" ? [] : path.split("/");
    let entry = { name: "", type: "tree", hash: treeHash, mode: "040000" };
    for (const part of parts) {
      if (entry.type !== "tree") return null;
      entry = (await listTree(entry.hash)).find((e) => e.name === part);
      if (!entry || entry.mode === "120000" || entry.type === "commit") return null;
    }
    return entry;
  }
  return Object.assign(source, {
    commit,
    tree: treeHash,
    stat,
    async list(dir) {
      const entry = await stat(dir);
      if (!entry || entry.type !== "tree") return [];
      return (await listTree(entry.hash)).filter((e) => e.mode !== "120000" && e.type !== "commit");
    },
    blob: (hash) => request(`/blob/${hash}`, { binary: true }),
  });
}
