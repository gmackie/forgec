import { expect, it, vi } from 'vitest';
import { VersionedArtifactReader, type ArtifactReadProvider, type ArtifactCommit, type ArtifactRepository } from '../src/versioned-artifacts.js';
import { cloudflareArtifactsReader } from '../src/adapters/cloudflare-artifacts.js';
const a='a'.repeat(40), b='b'.repeat(40), c='c'.repeat(40), d='d'.repeat(40), tree='f'.repeat(40);
const ctx={tenant:'tenant',actor:'reader',requestId:'test'};
function fixture() {
  const graph=new Map<string,ArtifactCommit>([[a,{oid:a,tree,parents:[b,c]}],[b,{oid:b,tree,parents:[d]}],[c,{oid:c,tree,parents:[d]}],[d,{oid:d,tree,parents:[]}]]);
  const repo={ repositoryId:'repo-1', objectFormat:'sha1' as const, resolve:vi.fn(async()=>a), commit:vi.fn(async(oid:string)=>graph.get(oid)??null), file:vi.fn(async()=>new Blob(['pinned'])), dispose:vi.fn() } satisfies ArtifactRepository;
  const provider={open:vi.fn(async()=>repo)} satisfies ArtifactReadProvider;
  const authorize=vi.fn(async()=>true);
  const reader=new VersionedArtifactReader([{tenant:'tenant',artifact:'source',generation:'g1',repositoryId:'repo-1',provider}],authorize);
  return {reader,repo,provider,authorize,graph};
}
it('pins discovery once and reads exact revisions after the branch moves',async()=>{
  const f=fixture();const pin=await f.reader.resolve('source','main',ctx);
  f.repo.resolve.mockResolvedValue(b);
  const result=await f.reader.readFile(pin,'src/index.ts',ctx);
  expect(result.bytes).toEqual(new TextEncoder().encode('pinned'));
  expect(f.repo.file).toHaveBeenCalledWith(a,'src/index.ts');
  expect(f.repo.resolve).toHaveBeenCalledTimes(1);expect(Object.isFrozen(pin)).toBe(true);
  expect(f.repo.dispose).toHaveBeenCalledTimes(2);
});
it('walks every merge parent exactly once, not only first-parent history',async()=>{
  const f=fixture(), pin=await f.reader.resolve('source','main',ctx);f.repo.commit.mockClear();
  const history=await f.reader.history(pin,ctx);
  expect(history.map(x=>x.oid)).toEqual([a,b,d,c]);expect(f.repo.commit).toHaveBeenCalledTimes(4);
});
it('fails a bounded traversal rather than returning a complete-looking prefix',async()=>{
  const f=fixture(),pin=await f.reader.resolve('source','main',ctx);f.repo.commit.mockClear();
  await expect(f.reader.history(pin,ctx,{maxCommits:2})).rejects.toMatchObject({code:'BudgetExceeded'});
  expect(f.repo.commit).toHaveBeenCalledTimes(2);expect(f.repo.dispose).toHaveBeenCalledTimes(2);
});
it('rejects missing parents and cycles',async()=>{
  const f=fixture(),pin=await f.reader.resolve('source','main',ctx);f.graph.delete(d);
  await expect(f.reader.history(pin,ctx)).rejects.toMatchObject({code:'NotFound'});
  f.graph.set(d,{oid:d,tree,parents:[a]});
  await expect(f.reader.history(pin,ctx)).rejects.toMatchObject({code:'ValidationFailed'});
});
it('enforces current authorization and tenant before opening a provider',async()=>{
  const f=fixture();await expect(f.reader.resolve('source','main',{...ctx,tenant:'other'})).rejects.toMatchObject({code:'NotPermitted'});
  expect(f.provider.open).not.toHaveBeenCalled();
  const pin=await f.reader.resolve('source','main',ctx);f.provider.open.mockClear();f.authorize.mockResolvedValue(false);
  await expect(f.reader.readFile(pin,'file',ctx)).rejects.toMatchObject({code:'NotPermitted'});expect(f.provider.open).not.toHaveBeenCalled();
});
it('rejects stale generations and replaced provider repositories',async()=>{
  const f=fixture(),pin=await f.reader.resolve('source','main',ctx);f.provider.open.mockClear();
  await expect(f.reader.readFile({...pin,generation:'g0'},'file',ctx)).rejects.toMatchObject({code:'VersionConflict'});
  expect(f.provider.open).not.toHaveBeenCalled();f.repo.repositoryId='repo-2';
  await expect(f.reader.readFile(pin,'file',ctx)).rejects.toMatchObject({code:'VersionConflict'});expect(f.repo.dispose).toHaveBeenCalledTimes(2);
});
it.each(['../secret','/absolute','a/../b','a\\b','a//b','a\u0000b'])('rejects unsafe path %s before provider access',async path=>{
  const f=fixture(),pin=await f.reader.resolve('source','main',ctx);f.provider.open.mockClear();
  await expect(f.reader.readFile(pin,path,ctx)).rejects.toMatchObject({code:'ValidationFailed'});expect(f.provider.open).not.toHaveBeenCalled();
});
it('enforces byte budget before consuming a blob',async()=>{
  const f=fixture(),pin=await f.reader.resolve('source','main',ctx);const blob=new Blob(['oversized']);const consume=vi.spyOn(blob,'arrayBuffer');f.repo.file.mockResolvedValue(blob);
  await expect(f.reader.readFile(pin,'file',ctx,{maxBytes:2})).rejects.toMatchObject({code:'BudgetExceeded'});expect(consume).not.toHaveBeenCalled();
});
it('rejects substituted commit identity and redacts provider errors',async()=>{
  const f=fixture();f.repo.commit.mockResolvedValue({oid:b,tree,parents:[]});
  await expect(f.reader.resolve('source','main',ctx)).rejects.toMatchObject({code:'ValidationFailed'});
  f.repo.resolve.mockRejectedValue(new Error('credential=private'));
  await expect(f.reader.resolve('source','main',ctx)).rejects.toMatchObject({code:'DependencyUnavailable'});
  try{await f.reader.resolve('source','main',ctx);}catch(error){expect(String(error)).not.toContain('private');}
});
it('snapshots caller identities before asynchronous authorization',async()=>{
  const f=fixture(),context={...ctx};f.authorize.mockImplementation(async()=>{context.tenant='other';return true;});
  const pin=await f.reader.resolve('source','main',context);expect(pin.tenant).toBe('tenant');
});
it('Cloudflare binding maps metadata and disposes RPC handles on success and failure',async()=>{
  const dispose=vi.fn(), handle={info:vi.fn(async()=>({id:'repo-1',name:'source-repo'})),log:vi.fn(async()=>[{hash:a}]),readCommit:vi.fn(async()=>({hash:a,treeHash:tree,parents:[b,c]})),readFile:vi.fn(async()=>new Blob(['file'])),[Symbol.dispose]:dispose};
  const binding={get:vi.fn(async()=>handle)};
  const provider=cloudflareArtifactsReader(binding,'source-repo');const repo=await provider.open();
  expect(await repo.resolve('main')).toBe(a);expect(handle.log).toHaveBeenCalledWith({ref:'main',limit:1});
  expect(await repo.commit(a)).toEqual({oid:a,tree,parents:[b,c]});await repo.file(a,'README.md');expect(handle.readFile).toHaveBeenCalledWith({ref:a,path:'README.md'});
  repo.dispose();expect(dispose).toHaveBeenCalledTimes(1);
  handle.info.mockRejectedValue(new Error('sensitive provider detail'));
  await expect(provider.open()).rejects.toThrow();expect(dispose).toHaveBeenCalledTimes(2);
});
it('retains purpose in the authorization request',async()=>{
  const f=fixture();await f.reader.resolve('source','main',{...ctx,purpose:'review'});
  expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({purpose:'review'}));
});
it.each(['IMPORT_IN_PROGRESS','FORK_IN_PROGRESS','CREATE_IN_PROGRESS'])('maps %s to retryable readiness without leaking provider detail',async code=>{
  const f=fixture();f.provider.open.mockRejectedValue({code,message:'private'});
  await expect(f.reader.resolve('source','main',ctx)).rejects.toMatchObject({code:'ProjectionNotReady'});
});
it('does not silently accept a malformed discovery result',async()=>{
  const dispose=vi.fn();const handle={info:async()=>({id:'repo-1',name:'repo'}),log:async()=>({bad:true}),readCommit:async()=>null,readFile:async()=>null,[Symbol.dispose]:dispose};
  const provider=cloudflareArtifactsReader({get:async()=>handle} as never,'repo');
  const reader=new VersionedArtifactReader([{tenant:'tenant',artifact:'source',generation:'g1',repositoryId:'repo-1',provider}],async()=>true);
  await expect(reader.resolve('source','main',ctx)).rejects.toMatchObject({code:'DependencyUnavailable'});expect(dispose).toHaveBeenCalledOnce();
});
it('rejects changed tree identity and honors pin snapshots during authorization',async()=>{
  const f=fixture(),pin={...await f.reader.resolve('source','main',ctx)};
  f.authorize.mockImplementation(async()=>{pin.oid=b;return true;});
  await f.reader.readFile(pin,'file',ctx);expect(f.repo.file).toHaveBeenCalledWith(a,'file');
  f.graph.set(b,{oid:b,tree:'e'.repeat(40),parents:[]});
  await expect(f.reader.readFile(pin,'file',ctx)).rejects.toMatchObject({code:'ValidationFailed'});
});
