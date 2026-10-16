/** Cloudflare Artifacts Workers read binding, open-beta surface checked 2026-10-01.
 * Kept structural so consumers need not upgrade their Workers global types. */
import type { ArtifactReadProvider } from '../versioned-artifacts.js';
import { encodeWorkerGitTree, type WorkerGitObjectStore } from './artifact-workspace-workers.js';
export interface CloudflareArtifactRepo {
  info(): Promise<{id: string; name: string}>;
  log(options: {ref: string; limit: number}): Promise<readonly {hash: string}[]>;
  readCommit(oid: string): Promise<{hash: string; treeHash: string; parents: string[]} | null>;
  readFile(options: {ref: string; path: string}): Promise<Blob | null>;
  [Symbol.dispose](): void;
}
export interface CloudflareArtifactsBinding { get(name: string): Promise<CloudflareArtifactRepo> }
/** Object reads on a repo handle (readCommit/readTree/readBlob), checked live 2026-10-15. */
export interface CloudflareArtifactObjectRepo {
  readCommit(oid: string): Promise<{hash: string; treeHash: string; parents: string[]; committedAt: number} | null>;
  readTree(oid: string): Promise<readonly {name: string; mode: string; hash: string; type: string}[] | null>;
  readBlob(oid: string): Promise<Blob | null>;
}
/** Base objects for Worker preparation and merge from an open repo handle. The binding
 * returns parsed commits, so they are trusted by ID; trees are re-encoded and blobs read
 * raw, and the workspace verifies both against their IDs. The caller owns the handle. */
export function cloudflareArtifactsObjectSource(repo: CloudflareArtifactObjectRepo): Pick<WorkerGitObjectStore, 'read' | 'readCommit'> {
  return {
    async read(oid, type) {
      if (type === 'commit') return null;
      if (type !== 'blob') {
        const entries = await repo.readTree(oid);
        if (entries) return {type: 'tree' as const, bytes: encodeWorkerGitTree(entries.map((e) => ({name: e.name, mode: e.mode, oid: e.hash})))};
        if (type === 'tree') return null;
      }
      const blob = await repo.readBlob(oid);
      return blob ? {type: 'blob' as const, bytes: new Uint8Array(await blob.arrayBuffer())} : null;
    },
    async readCommit(oid) {
      const commit = await repo.readCommit(oid);
      if (!commit) return null;
      if (commit.hash !== oid) throw new Error('Artifact commit does not match its ID');
      return {tree: commit.treeHash, parents: commit.parents, time: commit.committedAt};
    },
  };
}
/** Bind only server-selected repository names. The reader verifies the stable repo
 * ID against its configured binding on every open, rejecting name reuse. */
export function cloudflareArtifactsReader(binding: CloudflareArtifactsBinding, name: string): ArtifactReadProvider {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('Invalid configured artifact repository name');
  return { async open() {
    const handle = await binding.get(name);
    try {
      const info = await handle.info();
      if (info.name !== name || typeof info.id !== 'string' || !info.id) throw new Error('Invalid artifact repository metadata');
      return {
        repositoryId:info.id,objectFormat:'sha1' as const,
        async resolve(selector) {
          const entries = await handle.log({ref:selector,limit:1});
          if (!Array.isArray(entries) || entries.length > 1 || entries.length === 1 && !/^[a-f0-9]{40}$/.test(entries[0]?.hash ?? '')) throw new Error('Invalid artifact discovery result');
          return entries[0]?.hash ?? null;
        },
        async commit(oid) {
          const commit = await handle.readCommit(oid);
          return commit === null ? null : {oid:commit.hash,tree:commit.treeHash,parents:commit.parents};
        },
        file: (oid,path)=>handle.readFile({ref:oid,path}),
        dispose: ()=>handle[Symbol.dispose](),
      };
    } catch (error) { handle[Symbol.dispose](); throw error; }
  } };
}
