/** Bounded portable work queues. One CAS document seals task and runner state;
 * wakeups are advisory. Callers authenticate/authorize before invoking this service. */
import { deriveExecutionRequirements, executionDigest, type ExecutionRequirements } from "@forgegraph/capability-manifest";
import { Cause,Effect } from "effect";
import {err,type ForgeError} from "./errors.js";
import type {StorageAdapter} from "./services.js";
export interface QueueDefinition {id:string;execute:string;leaseMs:number;maxAttempts:number;maxTasks:number;maxRunners:number}
export type TaskRequirements = ExecutionRequirements;
export interface QueueTask {
 id:string;input:Record<string,unknown>;requirements:TaskRequirements;priority:number;createdAt:number;
 status:"queued"|"claimed"|"running"|"completed"|"failed"|"cancelled";
 generation:number;attempts:number;runner?:string;leaseUntil?:number;result?:Record<string,unknown>;
 history:{kind:string;at:number;generation:number;runner?:string}[];
}
export interface QueueRunner {id:string;capabilities:string[];presence:"online"|"draining"|"offline";lastSeen:number}
interface Board {definitionDigest:string;tasks:QueueTask[];runners:QueueRunner[]}
export interface QueueWakeup {notify(tenant:string,queue:string):Promise<void>}
export interface QueueEvent {queue:string;kind:string;depth:number;task?:string;generation?:number}
export class InProcessQueueWakeup implements QueueWakeup {
 constructor(private readonly wake:(tenant:string,queue:string)=>void) {}
 async notify(tenant:string,queue:string) {this.wake(tenant,queue);}
}
export class CloudflareQueueWakeup implements QueueWakeup {
 constructor(private readonly queue:{send(body:unknown):Promise<void>}) {}
 async notify(tenant:string,queue:string) {await this.queue.send({kind:"forge.workQueue.wake",tenant,queue});}
}
export class WorkQueue {
 constructor(private readonly storage:StorageAdapter,readonly definition:QueueDefinition,private readonly now:()=>number=Date.now,private readonly wakeup?:QueueWakeup,private readonly observe?:(event:QueueEvent)=>void) {
  if(!definition.id || !definition.execute || !Number.isInteger(definition.leaseMs) || definition.leaseMs<1000 || definition.leaseMs>300000 || !Number.isInteger(definition.maxAttempts) || definition.maxAttempts<1 || definition.maxAttempts>10 || !Number.isInteger(definition.maxTasks) || definition.maxTasks<1 || definition.maxTasks>128 || !Number.isInteger(definition.maxRunners) || definition.maxRunners<1 || definition.maxRunners>64) throw Error("invalid bounded work queue definition");
  this.definition=Object.freeze({...definition});
 }
 private mutate<A>(tenant:string,kind:string,change:(board:Board,at:number)=>A):Effect.Effect<A,ForgeError> {
  const self=this;
  return Effect.gen(function*(){
   for(let retry=0;retry<64;retry++) {
    const previous=yield* self.storage.getDocument(tenant,"work-queue",self.definition.id);
    const definitionDigest=executionDigest(self.definition);
    if(previous && previous["definitionDigest"]!==definitionDigest) return yield* Effect.fail(err("VersionConflict","queue definition changed; drain or migrate the existing queue before activation"));
    const board:Board=previous?structuredClone(previous as unknown as Board):{definitionDigest,tasks:[],runners:[]};
    const result=yield* Effect.try({try:()=>change(board,self.now()),catch:error=>error instanceof Error && "code" in error ? error as ForgeError : err("ValidationFailed",String(error))});
    if(new TextEncoder().encode(JSON.stringify(board)).length>256*1024) return yield* Effect.fail(err("BudgetExceeded","queue document exceeds 256 KiB"));
    const saved=yield* self.storage.putDocument(tenant,"work-queue",self.definition.id,board as unknown as Record<string,unknown>,(previous?.["_version"] as number | undefined)??null).pipe(Effect.exit);
    if(saved._tag==="Success") {
     try {self.observe?.({queue:self.definition.id,kind,depth:board.tasks.filter(t=>t.status==="queued").length});} catch { /* telemetry does not determine ownership */ }
     return structuredClone(result);
    }
    const error=Cause.squash(saved.cause);
    if(!(error instanceof Error) || !("code" in error) || error.code!=="VersionConflict") return yield* Effect.fail(error as ForgeError);
   }
   return yield* Effect.fail(err("TransientConflict","work queue contention"));
  });
 }
 private task(board:Board,id:string) {const task=board.tasks.find(t=>t.id===id);if(!task) throw err("NotFound","task not found");return task;}
 private evidence(task:QueueTask,kind:string,at:number) {task.history.push({kind,at,generation:task.generation,...(task.runner?{runner:task.runner}:{})});}
 private fenced(board:Board,id:string,runner:string,generation:number,at:number) {
  const task=this.task(board,id);
  if(task.runner!==runner || task.generation!==generation || !["claimed","running"].includes(task.status) || (task.leaseUntil??0)<=at) throw err("VersionConflict","stale or expired task claim");
  return task;
 }
 register(tenant:string,runner:QueueRunner):Effect.Effect<QueueRunner,ForgeError> {
  return this.mutate(tenant,"runner.register",(board,at)=>{
   if(!runner.id || runner.id.length>128 || runner.capabilities.length>256 || runner.capabilities.some(c=>!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(c)) || !["online","draining","offline"].includes(runner.presence)) throw err("ValidationFailed","invalid runner");
   const index=board.runners.findIndex(r=>r.id===runner.id);
   if(index<0 && board.runners.length>=this.definition.maxRunners) throw err("BudgetExceeded","runner limit reached");
   const next={...runner,lastSeen:at,capabilities:[...new Set(runner.capabilities)].sort()};
   if(index<0) board.runners.push(next);else board.runners[index]=next;
   return next;
  });
 }
 enqueueDerived(tenant:string,id:string,input:Record<string,unknown>,provenance:Parameters<typeof deriveExecutionRequirements>[0],priority=0):Effect.Effect<QueueTask,ForgeError> {
  return Effect.try({try:()=>deriveExecutionRequirements(provenance),catch:error=>err("ValidationFailed",String(error))}).pipe(Effect.flatMap(requirements=>this.enqueue(tenant,id,input,requirements,priority)));
 }
 enqueue(tenant:string,id:string,input:Record<string,unknown>,requirements:TaskRequirements,priority=0):Effect.Effect<QueueTask,ForgeError> {
  const self=this;
  return this.mutate(tenant,"task.enqueued",(board,at)=>{
   if(requirements.operation!==this.definition.execute || !id || id.length>128 || !Number.isSafeInteger(priority) || !/^[a-f0-9]{64}$/.test(requirements.provenanceDigest) || requirements.requirements.length>256 || requirements.requirements.some(c=>!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(c))) throw err("ValidationFailed","invalid task or requirements");
   const {provenanceDigest,...snapshot}=requirements;
   if(executionDigest(snapshot)!==provenanceDigest) throw err("ValidationFailed","task requirement provenance digest mismatch");
   if(board.tasks.some(t=>t.id===id)) throw err("VersionConflict","task already exists");
   if(board.tasks.length>=this.definition.maxTasks) throw err("BudgetExceeded","queue task limit reached; terminal evidence is retained");
   const task:QueueTask={id,input:structuredClone(input),requirements:structuredClone(requirements),priority,createdAt:at,status:"queued",generation:0,attempts:0,history:[]};
   this.evidence(task,"enqueued",at);board.tasks.push(task);return task;
  }).pipe(Effect.tap(()=>self.wakeup?Effect.tryPromise({try:()=>self.wakeup!.notify(tenant,self.definition.id),catch:()=>err("Internal","advisory wake failed")}).pipe(Effect.catch(()=>Effect.void)):Effect.void));
 }
 claimNext(tenant:string,runnerId:string):Effect.Effect<QueueTask|null,ForgeError> {
  return this.mutate(tenant,"task.claim",(board,at)=>{
   const runner=board.runners.find(r=>r.id===runnerId);
   if(!runner || runner.presence!=="online" || runner.lastSeen+this.definition.leaseMs<=at) throw err("Forbidden","runner is not online; register/heartbeat first");
   const task=board.tasks.filter(t=>t.status==="queued" && t.requirements.requirements.every(c=>runner.capabilities.includes(c))).sort((a,b)=>b.priority-a.priority || a.createdAt-b.createdAt || (a.id<b.id?-1:a.id>b.id?1:0))[0];
   if(!task) return null;
   task.status="claimed";task.runner=runnerId;task.generation++;task.attempts++;task.leaseUntil=at+this.definition.leaseMs;this.evidence(task,"claimed",at);return task;
  });
 }
 start(tenant:string,id:string,runner:string,generation:number) {return this.mutate(tenant,"task.start",(board,at)=>{const task=this.fenced(board,id,runner,generation,at);if(task.status==="claimed") {task.status="running";this.evidence(task,"started",at);}return task;});}
 heartbeat(tenant:string,id:string,runner:string,generation:number) {return this.mutate(tenant,"task.heartbeat",(board,at)=>{const task=this.fenced(board,id,runner,generation,at);task.leaseUntil=at+this.definition.leaseMs;const owner=board.runners.find(r=>r.id===runner);if(owner) owner.lastSeen=at;return task;});}
 complete(tenant:string,id:string,runner:string,generation:number,result:Record<string,unknown>) {return this.mutate(tenant,"task.complete",(board,at)=>{const task=this.fenced(board,id,runner,generation,at);if(task.status!=="running") throw err("InvalidTransition","start task before completion");task.status="completed";task.result=structuredClone(result);delete task.leaseUntil;this.evidence(task,"completed",at);return task;});}
 fail(tenant:string,id:string,runner:string,generation:number) {return this.mutate(tenant,"task.fail",(board,at)=>{const task=this.fenced(board,id,runner,generation,at);task.status=task.attempts>=this.definition.maxAttempts?"failed":"queued";delete task.leaseUntil;this.evidence(task,task.status==="failed"?"exhausted":"retry",at);return task;});}
 cancel(tenant:string,id:string) {return this.mutate(tenant,"task.cancel",(board,at)=>{const task=this.task(board,id);if(["completed","failed","cancelled"].includes(task.status)) return task;task.status="cancelled";delete task.leaseUntil;this.evidence(task,"cancelled",at);return task;});}
 reapExpired(tenant:string) {return this.mutate(tenant,"task.reap",(board,at)=>{let count=0;for(const task of board.tasks) if(["claimed","running"].includes(task.status) && (task.leaseUntil??0)<=at) {task.status=task.attempts>=this.definition.maxAttempts?"failed":"queued";delete task.leaseUntil;this.evidence(task,task.status==="failed"?"exhausted":"lease-expired",at);count++;}return count;});}
 get(tenant:string,id:string):Effect.Effect<QueueTask,ForgeError> {return this.storage.getDocument(tenant,"work-queue",this.definition.id).pipe(Effect.flatMap(doc=>Effect.try({try:()=>structuredClone(this.task(doc as unknown as Board??{definitionDigest:"",tasks:[],runners:[]},id)),catch:e=>e as ForgeError})));}
}
