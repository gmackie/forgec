import {Effect} from 'effect';
import {expect,it} from 'vitest';
import {foundation, foundationAdapters} from './helpers/foundation.js';
import {Lineage} from '../src/foundation/lineage.js';
import {localAuthorizer} from '../src/gatekeeper.js';
const p='@forgegraph/foundation/lineage/_/',s='@forgegraph/foundation/specification/_/',d='@fixture/lineage-consumer/_/';
for(const adapter of foundationAdapters){
 it(`${adapter}: explicit lineage and sealed transformation inputs/outputs preserve typed provenance`,async()=>{
  const f=await foundation('lineage',adapter,true);const {call,ctx,engine}=f;
  try{
   const service=new Lineage(engine);
   const graph=await call(p+'LineageGraph.create',{label:'Production'});
   const nodes=[];for(const rank of [1,2,4,5,6])nodes.push(await call(p+'LineageNode.create',{graph:graph.id,rank,label:'Node '+rank}));
   const [source,child,output,late,copy]=nodes;
   const repository=await call(s+'Repository.create',{key:'recipe',provider:'git',locator:'https://example.test/recipe'});
   const pin=await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'recipe',revision:'a'.repeat(40)});
   const relation=await call(p+'LineageRelation.create',{graph:graph.id,source:source!.id,target:child!.id,kind:'Aggregated',definition:pin.id,revision:1});
   const transformed=await call(p+'Transformation.create',{graph:graph.id,rank:3,definition:pin.id,label:'Explicit inputs/outputs'});
   const input=await Effect.runPromise(service.member('Input',String(transformed.id),String(child!.id),null,ctx));
   const out=await Effect.runPromise(service.member('Output',String(transformed.id),String(output!.id),null,ctx));
   expect((await Effect.runPromise(service.traverse(String(output!.id),'ancestors',ctx))).transformations).toEqual([]);
   const seals=await Promise.allSettled(Array.from({length:6},()=>Effect.runPromise(service.seal(String(transformed.id),String(input.id),String(out.id),ctx))));
   expect(seals.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   await Effect.runPromise(service.member('Output',String(transformed.id),String(late!.id),String(out.id),ctx));
   const ancestry=await Effect.runPromise(service.traverse(String(output!.id),'ancestors',ctx));
   expect(ancestry.nodes.map(n=>n.id)).toEqual([output!.id,child!.id,source!.id]);
   expect(ancestry.relations.map(n=>n.id)).toEqual([relation.id]);
   expect(ancestry.transformations).toEqual([expect.objectContaining({inputs:[child!.id],outputs:[output!.id],definition:pin.id})]);
   expect((await Effect.runPromise(service.traverse(String(late!.id),'ancestors',ctx))).transformations).toEqual([]);
   const correction=await call(p+'LineageRelation.create',{graph:graph.id,source:source!.id,target:child!.id,kind:'Derived',definition:pin.id,supersedes:relation.id,revision:2});
   expect((await Effect.runPromise(service.traverse(String(child!.id),'ancestors',ctx))).relations).toContainEqual(expect.objectContaining({id:relation.id,supersededBy:correction.id}));
   await expect(call(p+'LineageRelation.create',{graph:graph.id,source:source!.id,target:child!.id,kind:'Copied',supersedes:relation.id,revision:3})).rejects.toThrow();
   await call(p+'LineageRelation.create',{graph:graph.id,source:output!.id,target:copy!.id,kind:'Copied',revision:1});
   await call(p+'LineageRelation.create',{graph:graph.id,source:late!.id,target:copy!.id,kind:'Extracted',revision:1});
   for(const [name,input]of [['SoftwareBuild',{provenance:source!.id,commit:'a'.repeat(40)}],['ManufacturingBatch',{provenance:output!.id,lot:'L1'}],['DatasetTransform',{transformation:transformed.id,recipe:'Pinned transform'}],['LevelGeneration',{provenance:copy!.id,seed:7}]]as const)await call(d+name+'.create',input);
   const build=await call(d+'SoftwareBuild.create',{provenance:output!.id,commit:'b'.repeat(40)});
   await call(d+'BuildExecution.create',{transformation:transformed.id,build:build.id,command:'Typed execution provenance'});
   await expect(call(p+'TransformationOutput.delete',{id:out.id})).rejects.toThrow();
   await expect(Effect.runPromise(service.traverse(String(source!.id),'descendants',ctx,1))).rejects.toMatchObject({code:'BudgetExceeded'});
   engine.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'TransformationSeal').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
   await expect(Effect.runPromise(service.traverse(String(output!.id),'ancestors',ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
 it(`${adapter}: raw ranks, graph ownership, fanout and unreadable links fail closed`,async()=>{
  const f=await foundation('lineage',adapter,true);const {call,ctx,engine}=f;
  try{
   const service=new Lineage(engine),graph=await call(p+'LineageGraph.create',{label:'Graph'}),other=await call(p+'LineageGraph.create',{label:'Other'});
   const one=await call(p+'LineageNode.create',{graph:graph.id,rank:1,label:'One'}),two=await call(p+'LineageNode.create',{graph:graph.id,rank:2,label:'Two'}),foreign=await call(p+'LineageNode.create',{graph:other.id,rank:4,label:'Foreign'});
   const edge={graph:graph.id,source:one.id,target:two.id,kind:'Derived',revision:1};
   const relation=await call(p+'LineageRelation.create',edge);
   for(const patch of [{source:two.id,target:one.id},{source:one.id,target:one.id},{target:foreign.id}])await expect(call(p+'LineageRelation.create',{...edge,...patch})).rejects.toThrow();
   await expect(call(p+'LineageRelation.create',{...edge,graph:other.id,supersedes:relation.id,revision:2})).rejects.toThrow();
   await expect(call(p+'LineageNode.create',{graph:graph.id,rank:1,label:'Duplicate rank'})).rejects.toThrow();
   await expect(call(p+'LineageRelation.create',{...edge,supersedes:relation.id,revision:129})).rejects.toThrow();
   await expect(Effect.runPromise(service.traverse(String(one.id),'descendants',{...ctx,tenant:'other'}))).rejects.toThrow();
   for(let i=3;i<7;i++){
    const node=await call(p+'LineageNode.create',{graph:graph.id,rank:i,label:'Fanout'});
    await call(p+'LineageRelation.create',{...edge,target:node.id});
   }
   await expect(Effect.runPromise(service.traverse(String(one.id),'descendants',ctx,2))).rejects.toMatchObject({code:'BudgetExceeded'});
   const chainGraph=await call(p+'LineageGraph.create',{label:'Deep chain'});let previous:string|undefined;let root:string|undefined;
   for(let rank=1;rank<=4;rank++){
    const node=await call(p+'LineageNode.create',{graph:chainGraph.id,rank,label:'Depth '+rank});
    if(previous)await call(p+'LineageRelation.create',{graph:chainGraph.id,source:previous,target:node.id,kind:'Derived',revision:1});
    root??=String(node.id);previous=String(node.id);
   }
   await expect(Effect.runPromise(service.traverse(root!,'descendants',ctx,3))).rejects.toMatchObject({code:'BudgetExceeded'});
   expect((await Effect.runPromise(service.traverse(root!,'descendants',ctx,4))).nodes).toHaveLength(4);
   const transform=await call(p+'Transformation.create',{graph:graph.id,rank:3,label:'Rank barrier'});
   await expect(call(p+'TransformationInput.create',{transformation:transform.id,node:two.id,next:null,depth:129})).rejects.toThrow();
   await expect(call(p+'TransformationOutput.create',{transformation:transform.id,node:one.id,next:null,depth:1})).rejects.toThrow();
   const member=await Effect.runPromise(service.member('Input',String(transform.id),String(one.id),null,ctx));
   await expect(call(p+'TransformationInput.create',{transformation:transform.id,node:two.id,next:member.id,depth:1})).rejects.toThrow();
   engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'nodes',actions:[p+'LineageNode.*'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});
   // Hidden links must not turn a connected graph into a false leaf.
   await expect(Effect.runPromise(service.traverse(String(one.id),'descendants',ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
}
