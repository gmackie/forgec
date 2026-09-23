import { Evaluations } from "./evaluation.js";
import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import type { ForgeError } from "../errors.js";
const p='@forgegraph/foundation/intake/_/';
/** Domain transforms own their output schema and create capability; no untyped business payload. */
export class Intake {
  constructor(private readonly engine:Engine) {}
  submit(input:{form:string;submitter?:string;sourceKey:string;submittedAt:string;raw?:string},ctx:CallContext):Effect.Effect<Wire,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      const form=yield* self.engine.call(p+'IntakeForm.get',{id:input.form},ctx);
      if(input.submitter)yield* self.engine.call('@forgegraph/foundation/party/_/Party.get',{id:input.submitter},ctx);
      if(input.raw)yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get',{id:input.raw},ctx);
      return yield* self.engine.call(p+'Submission.create',{...input,submitter:input.submitter??null,raw:input.raw??null,definition:form.definition},ctx);
    });
  }
  validate(submission:string,finish:string,verdict:'Accepted'|'Rejected',reason:string,ctx:CallContext):Effect.Effect<Wire,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      yield* self.engine.call(p+'Submission.get',{id:submission},ctx);
      const terminal=yield* new Evaluations(self.engine).result(String(finish),ctx);
      yield* self.engine.call('@forgegraph/foundation/evaluation/_/EvaluationRun.get',{id:terminal.run},ctx);
      return yield* self.engine.call(p+'SubmissionValidation.create',{submission,run:terminal.run,finish,verdict,reason},ctx);
    });
  }
}
