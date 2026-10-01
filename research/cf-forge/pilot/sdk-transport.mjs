import {CloudflareApiClient} from '../.cache/pilot-sdk/sdk/Client.ts';
import map from '../.cache/pilot-sdk/sdk/sdk-map.json' with {type:'json'};
export function sdkTransport(fetchImpl=fetch, Client=CloudflareApiClient, operationMap=map) {
 for(const [id,method,keys] of [['worker-script-settings-get-settings','GET',['account_id','script_name']],['worker-script-settings-patch-settings','PATCH',['account_id','body','script_name']]]) {
  const entry=operationMap[id];
  if(!entry||entry.httpMethod!==method||entry.path!=='/accounts/{account_id}/workers/scripts/{script_name}/script-settings'||JSON.stringify([...entry.requiredRequestProperties].sort())!==JSON.stringify(keys)||method==='PATCH'&&entry.requestBodyProperty!=='body')throw new Error('Incompatible connector operation map');
 }
 return async(method,input,{token,signal})=>{
  const entry=operationMap[method==='GET'?'worker-script-settings-get-settings':'worker-script-settings-patch-settings'];
  const client=new Client({auth:false,baseUrl:'https://api.cloudflare.com/client/v4',headers:{Authorization:`Bearer ${token}`},fetch:fetchImpl,maxRetries:0,timeoutInSeconds:15});
  let owner=client;for(const segment of entry.accessor)owner=owner[segment];
  return owner[entry.method]({account_id:input.account,script_name:input.script,...(method==='PATCH'?{body:{tags:input.tags}}:{})},{maxRetries:0,abortSignal:signal});
 };
}
