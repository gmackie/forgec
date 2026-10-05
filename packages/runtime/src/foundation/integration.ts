import {Effect} from 'effect';
import type {Engine,CallContext} from '../engine.js';
import type {Wire} from '../decode.js';
import {err,type ForgeError} from '../errors.js';
import {Storage} from '../services.js';
import {Evidence} from './evidence.js';
const p='@forgegraph/foundation/integration/_/';
export class Integrations {
 constructor(private readonly engine:Engine){}
 private support(id:string,ctx:CallContext):Effect.Effect<void,ForgeError>{const self=this;return Effect.gen(function*(){const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);});}
 webhook(connection:string,providerEvent:string,digest:string,support:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){yield* self.support(support,ctx);return yield* self.engine.call(p+'WebhookReceipt.create',{connection,providerEvent,digest,support},{...ctx,idempotencyKey:ctx.idempotencyKey??JSON.stringify(['webhook',connection,providerEvent])}).pipe(Effect.catch(error=>error.code==='UniqueConflict'?Effect.gen(function*(){
 const resource=self.engine.model.resource(p+'WebhookReceipt'),unique=resource.uniques.find(u=>u.fields.includes('providerEvent'))!,values={connection,providerEvent};
 const row=yield* (yield* Storage).findUnique(ctx.tenant,resource,unique,self.engine.claimKey(resource,unique,values)!,values);
 if(!row)return yield* Effect.fail(error);
 const existing=yield* self.engine.call(p+'WebhookReceipt.get',{id:row.id},ctx);
 if(existing.digest!==digest||existing.support!==support)return yield* Effect.fail(err('IdempotencyMismatch','Provider event reused with changed evidence or content'));
 return existing;
}).pipe(Effect.provide(self.engine.layer)):Effect.fail(error)));});}
 accepted(seal:string,ctx:CallContext):Effect.Effect<Wire[],ForgeError>{const self=this;return Effect.gen(function*(){
  const record=yield* self.engine.call(p+'SyncSeal.get',{id:seal},ctx),rows:Wire[]=[];let id:unknown=record.head;
  while(id!=null){if(rows.length>=128)return yield* Effect.fail(err('ValidationFailed','Acceptance chain exceeds bound'));const row=yield* self.engine.call(p+'AcceptedRecord.get',{id},ctx);yield* self.support(String(row.support),ctx);yield* self.engine.call(p+'ExternalMapping.get',{id:row.mapping},ctx);yield* self.engine.call('@forgegraph/foundation/lineage/_/LineageRelation.get',{id:row.lineage},ctx);rows.push(row);id=row.previous;}
  if(rows.length!==record.count)return yield* Effect.fail(err('ValidationFailed','Acceptance chain is incomplete'));
  return rows.reverse();
 });}
 checkpoint(run:string,seal:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.accepted(seal,ctx);const record=yield* self.engine.call(p+'SyncRun.get',{id:run},ctx),previous=record.before?yield* self.engine.call(p+'SyncCursor.get',{id:record.before},ctx):null;
  return yield* self.engine.call(p+'SyncCursor.create',{connection:record.connection,ordinal:previous?Number(previous.ordinal)+1:1,previous:record.before??null,run,seal,token:record.afterToken},ctx);
 });}
 cursor(connection:string,ctx:CallContext):Effect.Effect<Wire|null,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.engine.call(p+'Connection.get',{id:connection},ctx);const model=self.engine.model.resource(p+'SyncCursor'),unique=model.uniques.find(u=>u.fields.includes('ordinal'))!,storage=yield* Storage;let latest:Wire|null=null;
  for(let ordinal=1;ordinal<=128;ordinal++){const values={connection,ordinal},row=yield* storage.findUnique(ctx.tenant,model,unique,self.engine.claimKey(model,unique,values)!,values);if(!row)break;latest=yield* self.engine.call(p+'SyncCursor.get',{id:row.id},ctx);yield* self.accepted(String(latest!.seal),ctx);}
  return latest;
 }).pipe(Effect.provide(self.engine.layer));}
}
