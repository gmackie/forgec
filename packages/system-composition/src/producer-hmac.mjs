/** HMAC verification for intentionally configured Forge producer webhooks.
 * This is our own envelope, not a claim to accept GitHub/ForgeGraph webhooks
 * directly; those require provider-specific verification/adapters upstream. */
const utf8=new TextEncoder();
const fromHex=s=>{
  if(!/^[0-9a-f]{64}$/i.test(s??''))throw new Error('invalid signature');
  return Uint8Array.from(s.match(/.{2}/g),v=>Number.parseInt(v,16));
};
const hex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
export async function signProducerEvent({source,timestamp,rawBody,secret}) {
  const key=await crypto.subtle.importKey('raw',utf8.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(rawBody);
  const prefix=utf8.encode(`${source}\n${timestamp}\n`);
  const message=new Uint8Array(prefix.length+bytes.length);message.set(prefix);message.set(bytes,prefix.length);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC',key,message)));
}
export function createProducerHmacVerifier({config,now=()=>Math.floor(Date.now()/1000),maxSkewSeconds=300}) {
  if(!config||typeof config!=='object') throw new TypeError('trusted producer configuration required');
  return async ({request,source,rawBody})=>{
    const entry=config[source];
    if(!entry||typeof entry.tenant!=='string'||!entry.tenant||!Array.isArray(entry.secrets)||!entry.secrets.length) throw new Error('unknown trusted producer');
    const stamp=request.headers.get('x-forge-timestamp');
    if(!/^\d{10,12}$/.test(stamp??'')) throw new Error('bad timestamp');
    const ts=Number(stamp);
    if(!Number.isSafeInteger(ts)||Math.abs(now()-ts)>maxSkewSeconds)throw new Error('stale signature');
    const signature=request.headers.get('x-forge-signature')?.replace(/^v1=/,'');
    const proof=fromHex(signature);
    const prefix=utf8.encode(`${source}\n${stamp}\n`);
    const message=new Uint8Array(prefix.length+rawBody.length);message.set(prefix);message.set(rawBody,prefix.length);
    for(const secret of entry.secrets) {
      if(typeof secret!=='string'||secret.length<32)throw new Error('weak or invalid producer secret');
      const key=await crypto.subtle.importKey('raw',utf8.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
      if(await crypto.subtle.verify('HMAC',key,proof,message))return {verified:true,source,tenant:entry.tenant};
    }
    throw new Error('invalid producer signature');
  };
}
