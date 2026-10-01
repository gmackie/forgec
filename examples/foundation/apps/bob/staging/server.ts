import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { Effect } from '../../../../../packages/runtime/node_modules/effect/dist/index.js';
import { composeRuntime } from '../../../../../packages/runtime/src/hosts/compose.js';
import { Model } from '../../../../../packages/runtime/src/index.js';
import { PostgresStorage, rawPgExecutor } from '../../../../../packages/runtime/src/adapters/postgres.js';
import { bobCompletion } from '../../../../../packages/runtime/src/foundation/apps/bob.js';
import { completionHandler, type Binding } from './handler.js';
const config=JSON.parse(readFileSync(process.env.STAGE_CONFIG!,'utf8'));
const pool=new pg.Pool({connectionString:process.env.FOUNDATION_DATABASE_URL});
const model=new Model(JSON.parse(readFileSync(process.env.FOUNDATION_BUNDLE!,'utf8')));
const engine=composeRuntime({bundle:model.bundle,store:new PostgresStorage(rawPgExecutor(pool),model),cursorSecret:config.serviceToken}).engine;
const handler=completionHandler(config.serviceToken,config.bindings as Binding[],async(binding,fact)=>bobCompletion(engine,{tenant:binding.workspaceId,actor:binding.userId,requestId:binding.taskRunId},binding,Effect.runPromise).recordCompletion(fact));
createServer(async(req,res)=>{try{
 const parts:Buffer[]=[];let size=0;for await(const p of req){size+=p.length;if(size>8192){res.writeHead(413);res.end();return;}parts.push(p);}
 const response=await handler(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers as Record<string,string>,...(req.method==='POST'?{body:Buffer.concat(parts)}:{})}));
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
}catch{res.writeHead(500);res.end();}}).listen(4311,'127.0.0.1');
