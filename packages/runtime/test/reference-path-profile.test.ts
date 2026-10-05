import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect,it } from 'vitest';
import { Model,type AppBundle,type Expr } from '../src/model.js';
const bundle=()=>JSON.parse(readFileSync(resolve(import.meta.dirname,'../../../conformance/fixtures/quota/app.json'),'utf8')) as AppBundle;
it('rejects legacy nested reference rules before null coercion can authorize writes',()=>{
 for(const kind of ['rule','derived']){
  const app=bundle();
  const allowance=app.ir.modules.flatMap(m=>m.resources).find(r=>r.name==='Allowance')!;
  const nested:Expr={kind:'binary',op:'>',lhs:{kind:'literal',literal:{type:'int',value:'1'}},rhs:{kind:'name',path:['grant','predecessor','quantity']}};
  if(kind==='rule') allowance.rules.push(nested);
  else allowance.fields.find(f=>f.name==='limit')!.derived=nested;
  expect(()=>new Model(app)).toThrow('unsupported multi-hop reference expression');
 }
});
it('accepts existing direct reference rules and lifecycle enum literals',()=>{
 expect(()=>new Model(bundle())).not.toThrow();
 const app=JSON.parse(readFileSync(resolve(import.meta.dirname,'../../../conformance/fixtures/acme.app.json'),'utf8')) as AppBundle;
 expect(()=>new Model(app)).not.toThrow();
});
