import { expect,it } from 'vitest';
import { foundation,foundationAdapters } from './helpers/foundation.js';
const p='@fixture/sql-identifiers/_/';
for(const adapter of foundationAdapters) it(`${adapter}: reserved table/reference names migrate and roundtrip`,async()=>{
 const f=await foundation('sql-identifiers',adapter);
 try {
  const first=await f.call(p+'To.create',{key:'first'}),second=await f.call(p+'To.create',{key:'second'});
  const transition=await f.call(p+'StageTransition.create',{from:first.id,to:second.id});
  expect(await f.call(p+'StageTransition.get',{id:transition.id})).toMatchObject({from:first.id,to:second.id});
  expect(await f.call(p+'StageTransition.find.byFromTo',{params:{from:first.id,to:second.id}})).toMatchObject({id:transition.id});
  await expect(f.call(p+'StageTransition.create',{from:first.id,to:second.id})).rejects.toMatchObject({code:'UniqueConflict'});
  await expect(f.call(p+'StageTransition.create',{from:first.id,to:'missing'})).rejects.toMatchObject({code:'ReferenceMissing'});
 }finally{await f.close();}
});
