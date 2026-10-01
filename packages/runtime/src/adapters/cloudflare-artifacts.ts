/** Cloudflare Artifacts Workers read binding, open-beta surface checked 2026-10-01.
 * Kept structural so consumers need not upgrade their Workers global types. */
import type { ArtifactReadProvider } from '../versioned-artifacts.js';
export interface CloudflareArtifactRepo {
  info(): Promise<{id: string; name: string}>;
  log(options: {ref: string; limit: number}): Promise<readonly {hash: string}[]>;
  readCommit(oid: string): Promise<{hash: string; treeHash: string; parents: string[]} | null>;
  readFile(options: {ref: string; path: string}): Promise<Blob | null>;
  [Symbol.dispose](): void;
}
export interface CloudflareArtifactsBinding { get(name: string): Promise<CloudflareArtifactRepo> }
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
