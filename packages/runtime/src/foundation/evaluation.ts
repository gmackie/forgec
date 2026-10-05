import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { findTerminalFact } from "./facts.js";
import { Evidence } from "./evidence.js";
const p = "@forgegraph/foundation/evaluation/_/";
export type EvaluationPhase = "Planned" | "Running" | "Completed" | "Failed" | "Cancelled";
/** Immutable run, start and terminal facts. Operational completion is not a business verdict. */
export class Evaluations {
  constructor(private readonly engine: Engine) {}
  create(input: {evaluationSet:string;definition:string;executor:string;parent?:string},ctx:CallContext):Effect.Effect<Wire,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      const parent=input.parent?yield* self.engine.call(p+'EvaluationRun.get',{id:input.parent},ctx):null;
      return yield* self.engine.call(p+'EvaluationRun.create',{...input,parent:input.parent??null,depth:parent?Number(parent.depth)+1:1},ctx);
    });
  }
  /** History stays readable, but quarantined legacy results cannot confer authority. */
  result(finish:string,ctx:CallContext):Effect.Effect<Wire,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      const row=yield* self.engine.call(p+'EvaluationFinish.get',{id:finish},ctx);
      yield* self.requireUnquarantined(String(row.run),ctx);
      return row;
    });
  }
  private requireUnquarantined(run:string,ctx:CallContext):Effect.Effect<void,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      yield* self.engine.call(p+'EvaluationRun.get',{id:run},ctx);
      if(yield* findTerminalFact(self.engine,p+'EvaluationQuarantine','run',run,ctx))
        return yield* Effect.fail(err('ValidationFailed','Evaluation is quarantined; execute a new run with fresh bindings'));
    });
  }
  start(run:string,startedAt:string,ctx:CallContext):Effect.Effect<Wire,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      yield* self.requireUnquarantined(run,ctx);
      const end=yield* findTerminalFact(self.engine,p+'EvaluationFinish','run',run,ctx);
      if(end)return yield* Effect.fail(err('InvalidTransition','Evaluation is already terminal'));
      return yield* self.engine.call(p+'EvaluationStart.create',{run,startedAt,recordedBy:ctx.actor},ctx);
    });
  }
  finish(run:string,outcome:Exclude<EvaluationPhase,'Planned'|'Running'>,finishedAt:string,reason:string,ctx:CallContext,support?:string):Effect.Effect<Wire,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      yield* self.requireUnquarantined(run,ctx);
      const start=yield* findTerminalFact(self.engine,p+'EvaluationStart','run',run,ctx);
      if(support){
        const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:support},ctx);
        yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);
      }
      return yield* self.engine.call(p+'EvaluationFinish.create',{run,start:start?.id??null,outcome,finishedAt,support:support??null,reason,recordedBy:ctx.actor},ctx);
    });
  }
  phase(run:string,ctx:CallContext):Effect.Effect<EvaluationPhase,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      yield* self.engine.call(p+'EvaluationRun.get',{id:run},ctx);
      const end=yield* findTerminalFact(self.engine,p+'EvaluationFinish','run',run,ctx);
      if(end)return end.outcome as EvaluationPhase;
      return (yield* findTerminalFact(self.engine,p+'EvaluationStart','run',run,ctx))?'Running':'Planned';
    });
  }
}
