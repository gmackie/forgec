/** Read-only versioned artifact contract. Journaled publication is a separate
 * capability in artifact-publication.ts; this reader never mutates repositories. */
import type { CallContext } from './engine.js';
import { err } from './errors.js';

export type ArtifactObjectFormat = 'sha1' | 'sha256';
export interface ArtifactCommit { readonly oid: string; readonly tree: string; readonly parents: readonly string[] }
export interface ArtifactRepository {
  readonly repositoryId: string;
  readonly objectFormat: ArtifactObjectFormat;
  resolve(selector: string): Promise<string | null>;
  commit(oid: string): Promise<ArtifactCommit | null>;
  file(oid: string, path: string): Promise<Blob | null>;
  dispose(): void;
}
/** A trusted composition-root capability, never constructed from caller URLs. */
export interface ArtifactReadProvider { open(): Promise<ArtifactRepository> }
export interface ArtifactReadBinding {
  readonly tenant: string; readonly artifact: string; readonly generation: string;
  readonly repositoryId: string; readonly provider: ArtifactReadProvider;
}
export interface ArtifactRevisionPin {
  readonly tenant: string; readonly artifact: string; readonly generation: string;
  readonly repositoryId: string; readonly objectFormat: ArtifactObjectFormat;
  readonly oid: string; readonly tree: string;
}
export interface ArtifactReadAuthorization {
  readonly action: 'resolve' | 'readFile' | 'history'; readonly tenant: string;
  readonly actor: string; readonly artifact: string; readonly generation: string;
  readonly purpose?: string;
}
export type AuthorizeArtifactRead = (request: Readonly<ArtifactReadAuthorization>) => Promise<boolean>;
const MAX_COMMITS = 1024, MAX_BYTES = 32 * 1024 * 1024, MAX_PARENTS = 32;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
const oidValid = (value: unknown, format: ArtifactObjectFormat) => typeof value === 'string' && (format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value);
function budget(value: number | undefined, fallback: number) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fallback) throw err('ValidationFailed', 'Invalid artifact read budget');
  return limit;
}
/** Never copy provider messages, response bodies or credentials into public errors. */
async function providerCall<T>(call: () => Promise<T> | T): Promise<T> {
  try { return await call(); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'NOT_FOUND') throw err('NotFound', 'Artifact repository or object is unavailable');
    if (['CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS'].includes(String(code))) throw err('ProjectionNotReady', 'Artifact repository is not ready');
    throw err('DependencyUnavailable', 'Artifact provider request failed');
  }
}
function commitSnapshot(commit: ArtifactCommit | null, oid: string, format: ArtifactObjectFormat): Readonly<ArtifactCommit> {
  if (commit === null) throw err('NotFound', 'Pinned artifact commit is unavailable');
  if (!commit || commit.oid !== oid || !oidValid(commit.tree, format) || !Array.isArray(commit.parents) || commit.parents.length > MAX_PARENTS || commit.parents.some(p => !oidValid(p, format)) || new Set(commit.parents).size !== commit.parents.length) throw err('ValidationFailed', 'Invalid artifact commit metadata');
  return Object.freeze({ oid, tree: commit.tree, parents: Object.freeze([...commit.parents]) });
}

export class VersionedArtifactReader {
  readonly capabilities = Object.freeze({ resolve: true, readFile: true, history: true, publish: false, merge: false, fork: false });
  private readonly bindings = new Map<string, Readonly<ArtifactReadBinding>>();
  constructor(bindings: readonly ArtifactReadBinding[], private readonly authorize: AuthorizeArtifactRead) {
    for (const binding of bindings) {
      if (![binding.tenant,binding.artifact,binding.generation,binding.repositoryId].every(identity)) throw err('ValidationFailed','Invalid artifact binding');
      const key = JSON.stringify([binding.tenant,binding.artifact]);
      if (this.bindings.has(key)) throw err('ValidationFailed','Duplicate artifact binding');
      this.bindings.set(key,Object.freeze({...binding}));
    }
  }
  private async binding(artifact: string, ctx: Readonly<CallContext>, action: ArtifactReadAuthorization['action'], pin?: Readonly<ArtifactRevisionPin>) {
    if (!identity(artifact) || !identity(ctx.tenant) || !identity(ctx.actor)) throw err('NotPermitted','Artifact read is not permitted');
    const binding = this.bindings.get(JSON.stringify([ctx.tenant,artifact]));
    if (!binding || pin && pin.tenant !== ctx.tenant) throw err('NotPermitted','Artifact read is not permitted');
    // Authorization is evaluated on every operation, including reads of old pins.
    let allowed: boolean;
    try { allowed = await this.authorize(Object.freeze({action,tenant:ctx.tenant,actor:ctx.actor,artifact,generation:binding.generation,...(ctx.purpose === undefined ? {} : {purpose:ctx.purpose})})); }
    catch { throw err('NotPermitted','Artifact read is not permitted'); }
    if (allowed !== true) throw err('NotPermitted','Artifact read is not permitted');
    if (pin && (pin.generation !== binding.generation || pin.repositoryId !== binding.repositoryId)) throw err('VersionConflict','Artifact repository binding changed');
    if (pin && (!['sha1','sha256'].includes(pin.objectFormat) || !oidValid(pin.oid,pin.objectFormat) || !oidValid(pin.tree,pin.objectFormat))) throw err('ValidationFailed','Invalid artifact revision pin');
    return binding;
  }
  private async withRepository<T>(binding: Readonly<ArtifactReadBinding>, work: (repo: ArtifactRepository) => Promise<T>): Promise<T> {
    const repo = await providerCall(()=>binding.provider.open());
    try {
      if (repo.repositoryId !== binding.repositoryId) throw err('VersionConflict','Artifact repository identity changed');
      if (!['sha1','sha256'].includes(repo.objectFormat)) throw err('ValidationFailed','Unsupported artifact object format');
      return await work(repo);
    } finally { await providerCall(()=>repo.dispose()); }
  }
  private async pinnedCommit(repo: ArtifactRepository, pin: Readonly<ArtifactRevisionPin>) {
    if (pin.objectFormat !== repo.objectFormat) throw err('VersionConflict','Artifact object format changed');
    const commit = commitSnapshot(await providerCall(()=>repo.commit(pin.oid)),pin.oid,repo.objectFormat);
    if (commit.tree !== pin.tree) throw err('ValidationFailed','Artifact provider substituted pinned tree');
    return commit;
  }
  async resolve(artifact: string, selector: string, context: CallContext): Promise<Readonly<ArtifactRevisionPin>> {
    const ctx = Object.freeze({...context});
    if (!identity(selector)) throw err('ValidationFailed','Invalid artifact selector');
    const binding = await this.binding(artifact,ctx,'resolve');
    return this.withRepository(binding,async repo=>{
      const oid = await providerCall(()=>repo.resolve(selector));
      if (oid === null) throw err('NotFound','Artifact selector has no commit');
      if (!oidValid(oid,repo.objectFormat)) throw err('ValidationFailed','Invalid artifact object ID');
      const commit = commitSnapshot(await providerCall(()=>repo.commit(oid)),oid,repo.objectFormat);
      return Object.freeze({tenant:ctx.tenant,artifact,generation:binding.generation,repositoryId:binding.repositoryId,objectFormat:repo.objectFormat,oid,tree:commit.tree});
    });
  }
  async readFile(revision: ArtifactRevisionPin, path: string, context: CallContext, options: {maxBytes?: number} = {}): Promise<{bytes: Uint8Array; mediaType: string}> {
    const pin = Object.freeze({...revision}), ctx = Object.freeze({...context}), maxBytes = budget(options.maxBytes,MAX_BYTES);
    if (!identity(path) || path.startsWith('/') || path.includes('\\') || path.split('/').some(p=>!p || p === '.' || p === '..')) throw err('ValidationFailed','Invalid artifact file path');
    const binding = await this.binding(pin.artifact,ctx,'readFile',pin);
    return this.withRepository(binding,async repo=>{
      await this.pinnedCommit(repo,pin);
      const blob = await providerCall(()=>repo.file(pin.oid,path));
      if (blob === null) throw err('NotFound','Artifact file is unavailable');
      if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > maxBytes) throw err('BudgetExceeded','Artifact file exceeds byte budget');
      const bytes = new Uint8Array(await providerCall(()=>blob.arrayBuffer()));
      if (bytes.byteLength !== blob.size || bytes.byteLength > maxBytes) throw err('BudgetExceeded','Artifact file exceeds byte budget');
      return {bytes,mediaType:blob.type};
    });
  }
  /** Deterministic depth-first traversal in parent order; never a truncated success.
   * Missing/shallow ancestry, cycles and exhausted budgets fail explicitly. */
  async history(revision: ArtifactRevisionPin, context: CallContext, options: {maxCommits?: number} = {}): Promise<readonly Readonly<ArtifactCommit>[]> {
    const pin = Object.freeze({...revision}), ctx = Object.freeze({...context}), maxCommits = budget(options.maxCommits,MAX_COMMITS);
    const binding = await this.binding(pin.artifact,ctx,'history',pin);
    return this.withRepository(binding,async repo=>{
      if (pin.objectFormat !== repo.objectFormat) throw err('VersionConflict','Artifact object format changed');
      const output: Readonly<ArtifactCommit>[] = [], active = new Set<string>(), done = new Set<string>();
      const stack = [{oid:pin.oid,exit:false}];
      while (stack.length) {
        const item = stack.pop()!;
        if (item.exit) { active.delete(item.oid); done.add(item.oid); continue; }
        if (active.has(item.oid)) throw err('ValidationFailed','Artifact history contains a cycle');
        if (done.has(item.oid)) continue;
        if (output.length >= maxCommits) throw err('BudgetExceeded','Artifact history exceeds commit budget');
        const commit = commitSnapshot(await providerCall(()=>repo.commit(item.oid)),item.oid,repo.objectFormat);
        if (item.oid === pin.oid && commit.tree !== pin.tree) throw err('ValidationFailed','Artifact provider substituted pinned tree');
        output.push(commit); active.add(item.oid); stack.push({oid:item.oid,exit:true});
        for (const parent of [...commit.parents].reverse()) stack.push({oid:parent,exit:false});
      }
      return Object.freeze(output);
    });
  }
}
