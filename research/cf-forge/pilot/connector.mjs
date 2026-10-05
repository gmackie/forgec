// Qualification adapter only. Dedicated single-writer Worker; no generic vendor idempotency claim.
export function decodeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid settings');
  if(Object.keys(value).some(key=>!['tags','logpush','observability','tail_consumers'].includes(key))) throw new Error('unexpected response shape');
  const out={};
  if(Object.hasOwn(value,'tags')) {
    if(value.tags!==null && (!Array.isArray(value.tags)||value.tags.length>100||value.tags.some(t=>typeof t!=='string'||t.length>256))) throw new Error('invalid tags');
    out.tags=value.tags;
  }
  if(Object.hasOwn(value,'logpush')) {
    if(typeof value.logpush!=='boolean') throw new Error('invalid logpush');
    out.logpush=value.logpush;
  }
  return out;
}
const fail=code=>({ok:false,code});
export function createConnector(options) {
  const {tenant,account,script,credential,transport,journal}=options;
  const scope=JSON.stringify([tenant,account,script]);
  const validScope=ctx=>ctx?.tenant===tenant;
  async function call(method,body,signal) {
    if(signal?.aborted)return fail('ExternalCancelled');
    let token;try{token=await credential();if(typeof token!=='string'||!token)throw Error();}catch{return fail('ExternalCredentialsUnavailable');}
    let raw;try{raw=await transport(method,{account,script,...body},{token,signal,maxRetries:0});}
    catch(error){return fail(error.statusCode===401||error.statusCode===403?'ExternalCredentialsRejected':error.statusCode===429?'ExternalRateLimited':error.statusCode>=400&&error.statusCode<500?'ExternalRejected':method==='PATCH'?'ExternalOutcomeUnknown':signal?.aborted?'ExternalCancelled':'ExternalUnavailable');}
    try{return {ok:true,value:decodeSettings(raw)};}catch{return fail(method==='PATCH'?'ExternalOutcomeUnknown':'ExternalResponseInvalid');}
  }
  return {
    async read(input,ctx,signal) {
      if(!validScope(ctx))return fail('ConnectionScopeMismatch');
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)return fail('ExternalInputInvalid');
      return call('GET',{},signal);
    },
    async mark(input,ctx,signal) {
      if(!validScope(ctx))return fail('ConnectionScopeMismatch');
      if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['key','tag'].includes(k))||typeof input.key!=='string'||!/^[-a-zA-Z0-9]{1,64}$/.test(input.key)||typeof input.tag!=='string'||!/^release:[-a-zA-Z0-9]{1,64}$/.test(input.tag))return fail('ExternalInputInvalid');
      if(signal?.aborted)return fail('ExternalCancelled');
      const prior=await journal.read(input.key);
      if(prior) {
        if(prior.scope!==scope||prior.tag!==input.tag)return fail('IdempotencyMismatch');
        if(prior.status==='applied')return {ok:true,value:{tag:input.tag,reconciled:true}};
        const observed=await call('GET',{},signal);
        if(observed.ok&&observed.value.tags?.includes(input.tag)) {
          await journal.write(input.key,{...prior,status:'applied'});
          return {ok:true,value:{tag:input.tag,reconciled:true}};
        }
        return observed.ok?fail('ExternalOutcomeUnknown'):observed;
      }
      const record={version:1,scope,tag:input.tag,status:'uncertain'};
      if(!await journal.create(input.key,record))return fail('ExternalOutcomeUnknown');
      const current=await call('GET',{},signal);if(!current.ok)return current;
      const tags=[...new Set([...(current.value.tags??[]),input.tag])];
      if(tags.length>100)return fail('ExternalInputInvalid');
      const written=await call('PATCH',{tags},signal);
      if(!written.ok)return written;
      if(!written.value.tags?.includes(input.tag))return fail('ExternalOutcomeUnknown');
      await journal.write(input.key,{...record,status:'applied'});
      return {ok:true,value:{tag:input.tag,reconciled:false}};
    },
  };
}
