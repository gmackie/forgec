/**
 * Read-only integration with KanBanger's real Effect HttpApi paths. The
 * installation fixes the workspace/tenant; the caller cannot choose a URL or
 * workspace. This adapter does not infer source revision, approval or deploy
 * success from a reported DeliveryEvent alone.
 */
function required(v,k){if(typeof v!=='string'||!v.trim())throw new TypeError(`invalid ${k}`);}
const segment=v=>{
  required(v,'path ID');
  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(v))throw new TypeError('invalid path ID');
  return encodeURIComponent(v);
};
export function createKanbangerReader({baseUrl,tenant,workspaceId,credentialForActor,authorize,fetchImpl=fetch,allowInsecureLoopback=false}) {
  for(const [v,k]of [[baseUrl,'base URL'],[tenant,'tenant'],[workspaceId,'workspace']]) required(v,k);
  const root=new URL(baseUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||!(root.protocol==='https:' || (allowInsecureLoopback && root.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(root.hostname)))) {
    throw new TypeError('invalid or untrusted KanBanger origin');
  }
  if(typeof fetchImpl!=='function'||typeof credentialForActor!=='function'||typeof authorize!=='function')throw new TypeError('trusted scoped credentials and policy required');
  const route=`/api/workspaces/${segment(workspaceId)}`;
  async function readJson(path,{tenant:subjectTenant,actor,purpose,issueId}) {
    required(subjectTenant,'tenant');required(actor,'actor');
    if(subjectTenant!==tenant)throw new Error('not authorized');
    if(await authorize({tenant,actor,purpose,issueId:issueId??null})!==true)throw new Error('not authorized');
    // Needs-me is a **caller-scoped** KanBanger endpoint: a broad service
    // credential must never impersonate the actor for this read.
    const credential=await credentialForActor({tenant,actor,purpose});
    required(credential,'actor-scoped credential');
    const url=new URL(route+path,root);
    // Requests only to the fixed origin. Redirects cannot move credentials.
    if(url.origin!==root.origin)throw new Error('provider origin changed');
    const response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{
      accept:'application/json','authorization':`Bearer ${credential}`,
    },signal:AbortSignal.timeout(12000)});
    if(response.status===401||response.status===403||response.status===404)throw new Error('KanBanger record inaccessible');
    if(!response.ok)throw new Error('KanBanger dependency unavailable');
    if(!/^application\/json(?:;|$)/.test(response.headers.get('content-type')??''))throw new Error('KanBanger non-JSON response');
    const declared=Number(response.headers.get('content-length')??0);
    if(declared>1024*1024)throw new Error('KanBanger response too large');
    const data=await response.text();
    if(data.length>1024*1024)throw new Error('KanBanger response too large');
    return JSON.parse(data);
  }
  return Object.freeze({
    tenant,workspaceId,
    async issue({tenant:scope,actor,issueId}){
      const data=await readJson(`/issues/${segment(issueId)}`,{tenant:scope,actor,purpose:'issue.read',issueId});
      if(data?.issue?.id!==issueId||!data?.issue||typeof data.issue.title!=='string')throw new Error('KanBanger issue response mismatch');
      return structuredClone(data);
    },
    async delivery({tenant:scope,actor,issueId}){
      const data=await readJson(`/issues/${segment(issueId)}/delivery`,{tenant:scope,actor,purpose:'delivery.read',issueId});
      if(!data||!Array.isArray(data.prs)||!Array.isArray(data.checks)||!Array.isArray(data.deploys)||!Array.isArray(data.evidence))throw new Error('KanBanger delivery shape mismatch');
      const safe=kind=>data[kind].map(x=>{
        if(x?.workspaceId!==workspaceId||x?.issueId!==issueId)throw new Error('KanBanger delivery ownership mismatch');
        return {kind:x.kind,status:x.status,subject:x.subject,changesetId:x.changesetId??null,updatedAt:x.updatedAt};
      });
      return {prs:safe('prs'),checks:safe('checks'),deploys:safe('deploys'),evidence:safe('evidence')};
    },
    async needsMe({tenant:scope,actor}){
      const data=await readJson('/delivery/needs-me',{tenant:scope,actor,purpose:'delivery.needs-me'});
      for(const k of ['readyForReview','failing','changesRequested'])if(!Array.isArray(data?.[k]))throw new Error('KanBanger actions response mismatch');
      return Object.fromEntries(['readyForReview','failing','changesRequested'].map(k=>[k,data[k].map(x=>{
        if(x?.workspaceId!==workspaceId)throw new Error('KanBanger action workspace mismatch');
        return {kind:x.kind,status:x.status,subject:x.subject,issueId:x.issueId,updatedAt:x.updatedAt};
      })]));
    }
  });
}
