/** Workers smart-HTTP single-ref transport. Repository URL and capabilities are trusted host configuration. */
import {
  validArtifactBranch,
  type ArtifactPublicationProvider,
} from "../artifact-publication.js";
import type { ArtifactReadProvider } from "../versioned-artifacts.js";
import type { WorkerGitObjectStore } from "./artifact-workspace-workers.js";

export interface WorkerGitPublicationOptions {
  readonly remote: string;
  /** Stable identity/read capability for this exact remote. Never caller-selected. */
  readonly identity: ArtifactReadProvider;
  readonly prepared: Pick<WorkerGitObjectStore, "read"> & {
    pack(): Promise<Uint8Array>;
  };
  /** Short-lived, repository-scoped write credential. Never returned or persisted. */
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
}
const encode = new TextEncoder(),
  decode = new TextDecoder("utf-8", { fatal: true });
const validOid = (value: string) => /^[a-f0-9]{40}$/.test(value);
const zero = "0".repeat(40);
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function packet(text: string): Uint8Array {
  const payload = encode.encode(text),
    length = payload.length + 4;
  if (length > 65520) throw Error("Git packet exceeds budget");
  return concat([encode.encode(length.toString(16).padStart(4, "0")), payload]);
}
function packets(bytes: Uint8Array): (string | null)[] {
  const result: (string | null)[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (result.length >= 16384)
      throw Error("Git response exceeds packet budget");
    if (at + 4 > bytes.length) throw Error("Truncated Git packet");
    const prefix = decode.decode(bytes.subarray(at, at + 4));
    if (!/^[a-fA-F0-9]{4}$/.test(prefix)) throw Error("Invalid Git packet");
    const length = parseInt(prefix, 16);
    at += 4;
    if (length === 0) {
      result.push(null);
      continue;
    }
    if (length < 4 || length > 65520 || at + length - 4 > bytes.length)
      throw Error("Invalid Git packet length");
    result.push(decode.decode(bytes.subarray(at, at + length - 4)));
    at += length - 4;
    if (result.length > 16384)
      throw Error("Git response exceeds packet budget");
  }
  return result;
}
async function bounded(response: Response): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw Error("Git transport request failed");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 1024 * 1024) throw Error("Git response exceeds byte budget");
      parts.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return concat(parts);
}
export function workerGitArtifactPublicationProvider(
  options: WorkerGitPublicationOptions,
): ArtifactPublicationProvider {
  const { remote, identity, prepared, token } = options,
    send = options.fetch ?? fetch;
  const url = new URL(remote);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(".git") ||
    /[\x00-\x20\x7f]/.test(remote)
  )
    throw Error("Invalid configured Workers Git remote");
  const base = url.href.replace(/\/$/, "");
  return {
    async open() {
      const repo = await identity.open();
      if (repo.objectFormat !== "sha1") {
        repo.dispose();
        throw Error("Workers Git publication requires SHA-1");
      }
      const request = async (
        path: string,
        method: string,
        body?: Uint8Array,
      ) => {
        const secret = await token();
        if (!secret || /[\x00-\x20\x7f]/.test(secret))
          throw Error("Invalid repository credential");
        const response = await send(base + path, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          headers: {
            authorization: "Bearer " + secret,
            "content-type":
              method === "POST"
                ? "application/x-git-receive-pack-request"
                : "application/x-git-receive-pack-advertisement",
            accept:
              method === "POST"
                ? "application/x-git-receive-pack-result"
                : "application/x-git-receive-pack-advertisement",
          },
          ...(body === undefined ? {} : { body: concat([body]) }),
        });
        const expected =
          method === "POST"
            ? "application/x-git-receive-pack-result"
            : "application/x-git-receive-pack-advertisement";
        if (response.headers.get("content-type")?.split(";", 1)[0] !== expected)
          throw Error("Invalid Git response type");
        return bounded(response);
      };
      return {
        repositoryId: repo.repositoryId,
        objectFormat: "sha1" as const,
        async commit(oid: string) {
          if (!validOid(oid)) throw Error("Invalid prepared commit");
          const object = await prepared.read(oid);
          if (!object) return null;
          if (object.type !== "commit" || object.bytes.length > 16384)
            throw Error("Invalid prepared commit");
          const bytes = concat([object.bytes]);
          const digest = await crypto.subtle.digest(
            "SHA-1",
            concat([encode.encode(`commit ${bytes.length}\0`), bytes]),
          );
          const actual = Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
          if (actual !== oid) throw Error("Prepared commit hash mismatch");
          const headers = decode.decode(bytes).split("\n\n", 1)[0]!.split("\n"),
            tree = headers[0]?.slice(5),
            parents = headers
              .filter((h) => h.startsWith("parent "))
              .map((h) => h.slice(7));
          if (
            !headers[0]?.startsWith("tree ") ||
            !tree ||
            !validOid(tree) ||
            parents.some((p) => !validOid(p))
          )
            throw Error("Invalid prepared commit metadata");
          return { oid, tree, parents };
        },
        head: async (ref: string) => {
          if (!validArtifactBranch(ref)) throw Error("Invalid ref");
          return repo.resolve(ref);
        },
        async compareAndSwap(
          ref: string,
          expected: string | null,
          next: string,
        ) {
          if (
            !validArtifactBranch(ref) ||
            (expected !== null && !validOid(expected)) ||
            !validOid(next) ||
            next === zero
          )
            throw Error("Invalid conditional Git update");
          const advertisement = packets(
            await request("/info/refs?service=git-receive-pack", "GET"),
          );
          if (
            advertisement[0] !== "# service=git-receive-pack\n" ||
            advertisement[1] !== null ||
            advertisement.at(-1) !== null
          )
            throw Error("Invalid Git advertisement");
          const refs = advertisement.slice(2, -1);
          if (!refs.length || refs.some((r) => r === null))
            throw Error("Invalid Git advertisement refs");
          const first = refs[0]!,
            nul = first.indexOf("\0");
          if (nul < 0) throw Error("Missing Git capabilities");
          const capabilities = first
            .slice(nul + 1)
            .trim()
            .split(" ");
          if (
            !capabilities.includes("report-status") ||
            capabilities.some(
              (c) =>
                c.startsWith("object-format=") && c !== "object-format=sha1",
            )
          )
            throw Error("Unsupported Git capabilities");
          let current: string | null = null;
          const seen = new Set<string>();
          for (let i = 0; i < refs.length; i++) {
            const line = (i === 0 ? first.slice(0, nul) : refs[i]!).replace(
              /\n$/,
              "",
            );
            const match = /^([a-f0-9]{40}) ([^\x00-\x20\x7f]+)$/.exec(line);
            if (!match || seen.has(match[2]!))
              throw Error("Invalid advertised Git ref");
            seen.add(match[2]!);
            if (match[2] === ref) current = match[1]!;
          }
          if (current !== expected) return "rejected" as const;
          const pack = new Uint8Array(await prepared.pack());
          if (
            pack.length < 32 ||
            pack.length > 34 * 1024 * 1024 ||
            decode.decode(pack.subarray(0, 4)) !== "PACK"
          )
            throw Error("Invalid prepared Git pack");
          const header = new DataView(pack.buffer, pack.byteOffset, 12);
          if (header.getUint32(4) !== 2 || header.getUint32(8) > 4096)
            throw Error("Invalid prepared Git pack header");
          const checksum = new Uint8Array(
            await crypto.subtle.digest("SHA-1", pack.subarray(0, -20)),
          );
          if (
            !checksum.every(
              (byte, index) => byte === pack[pack.length - 20 + index],
            )
          )
            throw Error("Invalid prepared Git pack checksum");
          // The receive-pack command's old OID is the server-side atomic guard, including all-zero create.
          const body = concat([
            packet(`${expected ?? zero} ${next} ${ref}\0report-status\n`),
            encode.encode("0000"),
            pack,
          ]);
          const status = packets(
            await request("/git-receive-pack", "POST", body),
          );
          if (
            status.length !== 3 ||
            status[2] !== null ||
            status[0] !== "unpack ok\n"
          )
            throw Error("Unknown Git publication outcome");
          if (status[1] === `ok ${ref}\n`) return "accepted" as const;
          if (status[1]?.startsWith(`ng ${ref} `) && status[1].endsWith("\n"))
            return "rejected" as const;
          throw Error("Unknown Git publication outcome");
        },
        dispose: () => repo.dispose(),
      };
    },
  };
}
