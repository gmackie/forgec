import { readFileSync,writeFileSync } from 'node:fs';
import pg from 'pg';
import { Effect } from '../../../../../packages/runtime/node_modules/effect/dist/index.js';
import { composeRuntime } from '../../../../../packages/runtime/src/hosts/compose.js';
import { Model } from '../../../../../packages/runtime/src/index.js';
import { PostgresStorage, rawPgExecutor } from '../../../../../packages/runtime/src/adapters/postgres.js';
import { Fulfillments } from '../../../../../packages/runtime/src/foundation/fulfillment.js';
const config=JSON.parse(readFileSync(process.env.STAGE_CONFIG!,'utf8'));
const pool=new pg.Pool({connectionString:process.env.FOUNDATION_DATABASE_URL});
const model=new Model(JSON.parse(readFileSync(process.env.FOUNDATION_BUNDLE!,'utf8')));
const engine=composeRuntime({bundle:model.bundle,store:new PostgresStorage(rawPgExecutor(pool),model),cursorSecret:config.serviceToken}).engine;
for(const b of config.bindings){
 const ctx={tenant:b.workspaceId,actor:b.userId,requestId:'staging-seed'};
 const call=(op:string,input:Record<string,unknown>)=>Effect.runPromise(engine.call(op,input,ctx));
 const s='@forgegraph/foundation/specification/_/',p='@forgegraph/foundation/fulfillment/_/';
 const repo=await call(s+'Repository.create',{key:'staging-bob',provider:'git',locator:'https://git.forgegraf.com/gmackie/bob'});
 const pin=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'staging fixture',revision:config.bobSourceRevision});
 const set=await call(p+'FulfillmentSet.create',{label:'Isolated staging fixture'});
 const executor=await call(p+'FulfillmentExecutor.create',{key:'staging-fixture'});
 const f=await call(p+'Fulfillment.create',{fulfillmentSet:set.id,ordinal:1,specificationPin:pin.id,executor:executor.id,requestedAt:'2026-10-01T00:00:00Z'});
 await Effect.runPromise(new Fulfillments(engine).start(String(f.id),'2026-10-01T00:30:00Z',ctx));
 b.fulfillmentId=String(f.id);
}
writeFileSync(process.env.STAGE_CONFIG!,JSON.stringify(config,null,2)+'\n',{mode:0o600});await pool.end();
console.log('Created explicitly synthetic request/start fixtures and trusted run bindings');
