import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Storage } from '../services.js';
import { findTerminalFact } from './facts.js';
const p='@forgegraph/foundation/lineage/_/';
export interface LineageTraversal { nodes:Wire[]; relations:Wire[]; transformations:Wire[] }
/** Traversal returns explicit hyperedge memberships, never inferred pairwise edges. */
export class Lineage {
 constructor(private readonly engine:Engine){}
 member(kind:'Input'|'Output',transformation:string,node:string,next:string|null,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const previous=next?yield* self.engine.call(p+'Transformation'+kind+'.get',{id:next},ctx):null;
  return yield* self.engine.call(p+'Transformation'+kind+'.create',{transformation,node,next,depth:previous?Number(previous.depth)+1:1},ctx);
 });}
 private chain(kind:'Input'|'Output',head:string,ctx:CallContext):Effect.Effect<Wire[],ForgeError>{const self=this;return Effect.gen(function*(){
  const rows:Wire[]=[],seen=new Set<string>();let current:string|null=head;
  while(current){
   if(seen.has(current)||rows.length>=128)return yield* Effect.fail(err('BudgetExceeded','Transformation membership exceeds bounded chain'));
   seen.add(current);const row:Wire=yield* self.engine.call(p+'Transformation'+kind+'.get',{id:current},ctx);
   yield* self.engine.call(p+'LineageNode.get',{id:row.node},ctx);rows.push(row);current=row.next==null?null:String(row.next);
  }return rows;
 });}
 seal(transformation:string,inputs:string,outputs:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.engine.call(p+'Transformation.get',{id:transformation},ctx);
  yield* self.chain('Input',inputs,ctx);yield* self.chain('Output',outputs,ctx);
  return yield* self.engine.call(p+'TransformationSeal.create',{transformation,inputs,outputs,recordedBy:ctx.actor},ctx);
 });}
 /** Enumerate the complete bounded candidate index, then authorize every record.
  * A filtered public list cannot prove that hidden provenance links are absent. */
 private completeIndex(type:string,field:string,value:string,ctx:CallContext,limit:number):Effect.Effect<Wire[],ForgeError>{const self=this;return Effect.gen(function*(){
  const resource=self.engine.model.resource(p+type),list=resource.lists.find(x=>x.fields.length===1&&x.fields[0]===field)!;
  const storage=yield* Storage;
  const page=yield* storage.list(ctx.tenant,resource,{list,values:{[field]:value},after:null,limit},self.engine.sortKeys(resource,list));
  if(page.hasMore)return yield* Effect.fail(err('BudgetExceeded','Lineage index exceeds traversal budget'));
  const rows:Wire[]=[];
  for(const row of page.records){
   yield* self.engine.gatekeeper.requireRead(p+type+'.list.'+list.name,resource,ctx,row);
   rows.push(yield* self.engine.call(p+type+'.get',{id:row.id},ctx));
  }return rows;
 }).pipe(Effect.provide(self.engine.layer));}
 traverse(node:string,direction:'ancestors'|'descendants',ctx:CallContext,budget=128):Effect.Effect<LineageTraversal,ForgeError>{const self=this;return Effect.gen(function*(){
  if(!Number.isInteger(budget)||budget<1||budget>512)return yield* Effect.fail(err('ValidationFailed','Traversal budget must be 1..512'));
  const nodes:Wire[]=[],relations:Wire[]=[],transformations:Wire[]=[],seen=new Set<string>(),edges=new Set<string>(),transforms=new Set<string>(),pending=[node];
  let reads=0,members=0;
  const index=(type:string,field:string,id:string)=>Effect.gen(function*(){if(++reads>budget*4)return yield* Effect.fail(err('BudgetExceeded','Lineage index read budget exceeded'));return yield* self.completeIndex(type,field,id,ctx,budget);});
  while(pending.length){
   const id=pending.shift()!;if(seen.has(id))continue;
   if(seen.size>=budget)return yield* Effect.fail(err('BudgetExceeded','Lineage node budget exceeded'));
   seen.add(id);nodes.push(yield* self.engine.call(p+'LineageNode.get',{id},ctx));
   const field=direction==='ancestors'?'target':'source',other=direction==='ancestors'?'source':'target';
   for(const edge of yield* index('LineageRelation',field,id)){
    if(edge.definition!=null)yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:edge.definition},ctx);
    if(!edges.has(String(edge.id))){if(edges.size>=budget)return yield* Effect.fail(err('BudgetExceeded','Lineage edge budget exceeded'));edges.add(String(edge.id));const successor=yield* findTerminalFact(self.engine,p+'LineageRelation','supersedes',edge.id,ctx);relations.push({...edge,supersededBy:successor?.id??null});}
    pending.push(String(edge[other]));
   }
   const kind=direction==='ancestors'?'Output':'Input';
   for(const link of yield* index('Transformation'+kind,'node',id)){
    const tid=String(link.transformation);if(transforms.has(tid))continue;
    const seal=yield* findTerminalFact(self.engine,p+'TransformationSeal','transformation',tid,ctx);
    if(!seal)continue;
    const inputs=yield* self.chain('Input',String(seal.inputs),ctx),outputs=yield* self.chain('Output',String(seal.outputs),ctx);
    members+=inputs.length+outputs.length;if(members>budget)return yield* Effect.fail(err('BudgetExceeded','Transformation membership budget exceeded'));
    if(!(kind==='Input'?inputs:outputs).some(row=>row.id===link.id))continue;
    if(transforms.size>=budget)return yield* Effect.fail(err('BudgetExceeded','Transformation budget exceeded'));
    const transformation=yield* self.engine.call(p+'Transformation.get',{id:tid},ctx);
    if(transformation.definition!=null)yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:transformation.definition},ctx);
    transforms.add(tid);transformations.push({...transformation,inputs:inputs.map(x=>x.node),outputs:outputs.map(x=>x.node)});
    for(const member of direction==='ancestors'?inputs:outputs)pending.push(String(member.node));
   }
  }return {nodes,relations,transformations};
 });}
}
