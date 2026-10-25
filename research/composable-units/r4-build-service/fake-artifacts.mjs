// A stand-in for the Cloudflare Artifacts REST API's read routes, served from this repository's git
// objects, so the Artifacts source can be measured locally. Same routes and envelopes as the ones
// Loom's backend reads (src/loom/backends/artifacts.mjs): {success, result} JSON, raw blob bytes.
// Objects come from one long-lived `git cat-file --batch`, so the fake adds little latency of its own.
// usage: node fake-artifacts.mjs <port> <token>    (port 0 picks one; prints "ready <port>")
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { repoRoot } from "./request.mjs";

const [portArg, token] = process.argv.slice(2);

// `git cat-file --batch`: write "<rev>\n", read "<sha> <type> <size>\n<bytes>\n" (or "<rev> missing\n").
const batch = spawn("git", ["cat-file", "--batch"], { cwd: repoRoot, stdio: ["pipe", "pipe", "inherit"] });
let buffer = Buffer.alloc(0);
const waiting = [];
batch.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const nl = buffer.indexOf(10);
    if (nl < 0 || !waiting.length) return;
    const header = buffer.subarray(0, nl).toString();
    if (header.endsWith(" missing")) {
      buffer = buffer.subarray(nl + 1);
      waiting.shift()(null);
      continue;
    }
    const [, type, size] = header.split(" ");
    const end = nl + 1 + Number(size);
    if (buffer.length < end + 1) return;
    const body = Buffer.from(buffer.subarray(nl + 1, end));
    buffer = buffer.subarray(end + 1);
    waiting.shift()({ type, body });
  }
});
const object = (hash) =>
  new Promise((ok) => {
    waiting.push(ok);
    batch.stdin.write(`${hash}\n`);
  });

function treeEntries(body) {
  const out = [];
  for (let i = 0; i < body.length; ) {
    const sp = body.indexOf(32, i);
    const nul = body.indexOf(0, sp);
    const mode = body.subarray(i, sp).toString().padStart(6, "0");
    const name = body.subarray(sp + 1, nul).toString();
    const hash = body.subarray(nul + 1, nul + 21).toString("hex");
    out.push({ name, mode, hash, type: mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob" });
    i = nul + 21;
  }
  return out;
}

const ok = (res, result) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: true, errors: [], result }));
};
const fail = (res, status, code, message) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: false, errors: [{ code, message }], result: null }));
};
let requests = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/stats") return ok(res, { requests });
  requests++;
  if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 403, 10000, "Authentication error");
  const m = /^\/accounts\/[^/]+\/artifacts\/namespaces\/[^/]+\/repos\/[^/]+\/(log|commit|tree|blob)(?:\/([0-9a-f]{40}))?$/.exec(url.pathname);
  if (!m) return fail(res, 404, 10200, "not found");
  const [, route, hash] = m;
  if (route === "log") {
    try {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      return ok(res, [{ hash: execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot, encoding: "utf8" }).trim() }]);
    } catch {
      return ok(res, []);
    }
  }
  const found = hash ? await object(hash) : null;
  // Artifacts answers a hash of the wrong type on /commit and /tree as a corrupt object (10400).
  if (!found || found.type !== route) return fail(res, 500, 10400, "object not found or wrong type");
  if (route === "commit") {
    const text = found.body.toString();
    const header = text.slice(0, text.indexOf("\n\n"));
    const field = (k) => header.split("\n").filter((l) => l.startsWith(`${k} `)).map((l) => l.slice(k.length + 1));
    return ok(res, { hash, treeHash: field("tree")[0], parents: field("parent"), message: text.slice(header.length + 2) });
  }
  if (route === "tree") return ok(res, treeEntries(found.body));
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(found.body);
});
server.listen(Number(portArg), "127.0.0.1", () => console.log(`ready ${server.address().port}`));
