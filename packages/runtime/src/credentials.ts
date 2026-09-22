/** Secret payloads stay sealed in records. Key material is supplied by the host,
 * never by the compiled bundle. Plaintext is available only inside authorized use. */
export interface SecretContext {tenant:string;resource:string;record:string;field:string}
export interface SecretUseContext extends SecretContext {actor:string;purpose:string}
export interface SecretAdapter {seal(context:SecretContext,plaintext:string):Promise<string>}
const bytes=(s:string)=>new TextEncoder().encode(s);
const base64=(b:Uint8Array)=>btoa(String.fromCharCode(...b)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"" );
const unbase64=(s:string)=>Uint8Array.from(atob(s.replaceAll("-","+").replaceAll("_","/")),c=>c.charCodeAt(0));
const aad=(context:SecretContext)=>bytes(JSON.stringify([context.tenant,context.resource,context.record,context.field]));
export class AesGcmSecretAdapter implements SecretAdapter {
 private readonly keys:ReadonlyMap<string,CryptoKey>;
 constructor(private readonly activeKey:string,keys:ReadonlyMap<string,CryptoKey>,private readonly authorize:(context:SecretUseContext)=>Promise<boolean>,private readonly audit:(event:SecretUseContext & {kind:"secret.use";keyId:string})=>Promise<void>) {
  this.keys=new Map(keys);
  const key=this.keys.get(activeKey);
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(activeKey) || !key || key.algorithm.name!=="AES-GCM" || !key.usages.includes("encrypt")) throw Error("invalid secret encryption key");
 }
 async seal(context:SecretContext,plaintext:string):Promise<string> {
  if(bytes(plaintext).length>16384) throw Error("secret exceeds 16 KiB");
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad(context)},this.keys.get(this.activeKey)!,bytes(plaintext));
  return `sealed.v1.${this.activeKey}.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
 }
 async use<A>(context:SecretUseContext,sealed:string,consumer:(plaintext:string)=>Promise<A>):Promise<A> {
  if(!await this.authorize(context)) throw Error("secret use denied");
  const [tag,version,keyId,nonce,ciphertext,...extra]=sealed.split(".");
  const key=this.keys.get(keyId??"");
  if(tag!=="sealed" || version!=="v1" || !key || !nonce || !ciphertext || extra.length) throw Error("invalid sealed credential");
  let plaintext:string;
  try {plaintext=new TextDecoder("utf-8",{fatal:true}).decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:unbase64(nonce),additionalData:aad(context)},key,unbase64(ciphertext)));}
  catch {throw Error("credential authentication failed");}
  await this.audit({...context,kind:"secret.use",keyId:keyId!});
  return consumer(plaintext);
 }
}
