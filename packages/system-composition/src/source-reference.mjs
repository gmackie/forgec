/**
 * Read-only resolution of WorkGraph-owned immutable code/config anchors.
 * Loom/SCM owns snapshots/symbol indexing; ForgeGraph owns delivery state;
 * this adapter never guesses code identity from a line number or URL.
 */
const required=(x,k)=>{if(typeof x!=='string'||!x.trim())throw new TypeError(`invalid ${k}`);};
export class SourceReferenceResolver {
  #p;
  constructor({authorize,getAnchor,getSnapshot,resolveSemantic}) {
    this.#p={authorize,getAnchor,getSnapshot,resolveSemantic};
    for(const[k,v]of Object.entries(this.#p))if(typeof v!=='function')throw new TypeError(`trusted ${k} port required`);
  }
  async resolve({tenant,actor,anchorId,targetRevision}) {
    for(const[v,k]of [[tenant,'tenant'],[actor,'actor'],[anchorId,'anchor'],[targetRevision,'target revision']])required(v,k);
    const p=this.#p;
    if(await p.authorize({tenant,actor,anchorId,purpose:'source.resolve'})!==true)throw new Error('not authorized');
    const anchor=await p.getAnchor({tenant,actor,anchorId});
    if(!anchor||anchor.tenant!==tenant||anchor.id!==anchorId||anchor.providerVerified!==true)throw new Error('source anchor inaccessible');
    if(!['code','configuration'].includes(anchor.kind)||!anchor.origin||typeof anchor.origin.path!=='string')throw new Error('invalid source anchor');
    for(const field of ['repositoryId','revision'])required(anchor.origin[field],`origin ${field}`);
    if(await p.authorize({tenant,actor,anchorId,purpose:'source.read',repositoryId:anchor.origin.repositoryId,path:anchor.origin.path})!==true)throw new Error('not authorized');
    // Re-resolve the snapshot on every read: the caller must have current
    // repository permission, even if the backlog task itself remains visible.
    const target=await p.getSnapshot({tenant,actor,repositoryId:anchor.origin.repositoryId,revision:targetRevision});
    if(!target||target.providerVerified!==true||target.tenant!==tenant||target.revision!==targetRevision||target.repositoryId!==anchor.origin.repositoryId)throw new Error('source snapshot inaccessible');
    if(targetRevision===anchor.origin.revision) {
      return {anchorId,targetRevision,status:'exact',location:{path:anchor.origin.path,startLine:anchor.origin.startLine,endLine:anchor.origin.endLine},authority:'source-index'};
    }
    const results=await p.resolveSemantic({tenant,actor,anchor,targetRevision});
    if(!Array.isArray(results)||results.length>64)throw new Error('invalid semantic resolution result');
    const verified=[];
    for(const r of results){
      if(!r||r.providerVerified!==true||r.repositoryId!==anchor.origin.repositoryId||r.revision!==targetRevision)throw new Error('untrusted semantic index result');
      if(typeof r.path!=='string'||!Number.isInteger(r.startLine)||r.startLine<1||!Number.isInteger(r.endLine)||r.endLine<r.startLine)throw new Error('invalid resolved code location');
      verified.push(r);
    }
    // Source location alone does not establish logical identity. Require the
    // resolver's exact semantic symbol ID or immutable matching bytes.
    const matches=verified.filter(r=>(typeof anchor.semanticId==='string'&&r.semanticId===anchor.semanticId) ||
       (typeof anchor.origin.contentHash==='string'&&r.contentHash===anchor.origin.contentHash));
    if(matches.length>1)return {anchorId,targetRevision,status:'ambiguous',candidates:matches.length,authority:'source-index'};
    if(!matches.length)return {anchorId,targetRevision,status:target.indexComplete===true?'deleted-or-rewritten':'unavailable',authority:'source-index'};
    return {anchorId,targetRevision,status:'relocated',location:{path:matches[0].path,startLine:matches[0].startLine,endLine:matches[0].endLine},authority:'source-index'};
  }
}
