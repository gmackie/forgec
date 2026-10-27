/**
 * Read-only ForgeGraph changeset/evidence reader against actual /api/fg endpoints.
 * ForgeGraph's changeset detail route verifies a bearer but does not independently
 * scope the GET to a workspace. Host MUST assert repository tenancy and rights.
 * Build/test/artifact observations do not constitute production deployment proof.
 */
const required=(v,k)=>{if(typeof v!=='string'||!v.trim())throw new TypeError('invalid '+k);};
const segment=id=>{required(id,'changeset ID');if(!/^[A-Za-z0-9_-]{1,180}$/.test(id))throw new TypeError('invalid changeset ID');return encodeURIComponent(id);};
const array=(value,kind)=>{if(!Array.isArray(value)||value.length>1000)throw new Error('invalid '+kind);return value;};
const label=v=>typeof v==='string'&&v.length<=250?v:null;
export function createForgeGraphReader({baseUrl,tenant,repositoryId,credentialForActor,authorize,assertRepositoryScope,fetchImpl=fetch,allowInsecureLoopback=false}) {
  required(tenant,'tenant');required(repositoryId,'repository');
  required(baseUrl,'ForgeGraph origin');
  const root=new URL(baseUrl);
  if(root.username||root.password||root.pathname!=='/'||root.search||root.hash||
    !(root.protocol==='https:'||(allowInsecureLoopback && root.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(root.hostname))))throw new TypeError('invalid or untrusted ForgeGraph origin');
  for(const [key,port]of Object.entries({credentialForActor,authorize,assertRepositoryScope,fetchImpl})){
    if(typeof port!=='function')throw new TypeError('trusted '+key+' port required');
  }
  async function read(path,{tenant:scope,actor,changesetId,operation}) {
    required(scope,'tenant');required(actor,'actor');
    if(scope!==tenant||await authorize({tenant,actor,repositoryId,changesetId,operation,purpose:'delivery.read'})!==true)throw new Error('not authorized');
    const credential=await credentialForActor({tenant,actor,purpose:'delivery.read',repositoryId});
    required(credential,'actor-scoped credential');
    const url=new URL(path,root);
    if(url.origin!==root.origin)throw new Error('provider origin changed');
    const response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{accept:'application/json',authorization:'Bearer '+credential},signal:AbortSignal.timeout(12000)});
    if([401,403,404].includes(response.status))throw new Error('ForgeGraph resource inaccessible');
    if(!response.ok)throw new Error('ForgeGraph dependency unavailable');
    if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new Error('ForgeGraph non-JSON response');
    if(Number(response.headers.get('content-length')??0)>2*1024*1024)throw new Error('ForgeGraph response too large');
    const body=await response.text();if(body.length>2*1024*1024)throw new Error('ForgeGraph response too large');
    let data;try{data=JSON.parse(body);}catch{throw new Error('ForgeGraph invalid JSON');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('ForgeGraph invalid response');
    return data;
  }
  async function scoped({tenant:scope,actor,changesetId}) {
    const data=await read('/api/fg/changesets/'+segment(changesetId),{tenant:scope,actor,changesetId,operation:'changeset'});
    if(data.id!==changesetId||data.repositoryId!==repositoryId)throw new Error('ForgeGraph repository mismatch');
    if(await assertRepositoryScope({tenant,actor,repositoryId,changesetId})!==true)throw new Error('not authorized');
    return data;
  }
  return Object.freeze({
    tenant,repositoryId,
    async changeset({tenant:scope,actor,changesetId}) {
      const row=await scoped({tenant:scope,actor,changesetId});
      const identities=array(row.identities,'identities').map(x=>{
        if(!x||typeof x.kind!=='string'||typeof x.value!=='string')throw new Error('ForgeGraph identity mismatch');
        return {kind:x.kind,value:x.value};
      });
      const builds=array(row.builds,'builds').map(x=>({id:label(x.id),pipeline:label(x.pipelineName),status:label(x.status)}));
      const tests=array(row.testRuns,'tests').map(x=>({id:label(x.id),suite:label(x.suiteName),status:label(x.status),passed:x.passedTests??null,failed:x.failedTests??null}));
      const artifacts=array(row.artifacts,'artifacts').map(x=>({id:label(x.id),kind:label(x.kind),digest:label(x.digest)}));
      return {changesetId,repositoryId,headSha:label(row.headSha),status:label(row.status),identities,builds,tests,artifacts,authority:'forgegraph-reported-delivery',deploymentVerified:false};
    },
    async evidence({tenant:scope,actor,changesetId}) {
      await scoped({tenant:scope,actor,changesetId});
      const row=await read('/api/fg/evidence?changesetId='+segment(changesetId),{tenant:scope,actor,changesetId,operation:'evidence'});
      const evidence=array(row.evidence,'evidence').map(x=>({id:label(x.id),type:label(x.type),name:label(x.name),status:label(x.status),createdAt:label(x.createdAt)}));
      return {changesetId,repositoryId,evidence,authority:'forgegraph-reported-evidence',deploymentVerified:false};
    },
  });
}
