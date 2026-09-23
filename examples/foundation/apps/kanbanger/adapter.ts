import type { Engine, CallContext } from '../../../../packages/runtime/src/engine.js';
import { Intake } from '../../../../packages/runtime/src/foundation/intake.js';

export interface IssueFact { workspaceId: string; issueId: string; teamId: string; creatorId: string; createdAt: string }
export interface IntakeBinding { readonly creatorId: string; readonly formId: string; readonly submitterId: string }
/** Bindings are trusted, tenant-local Foundation IDs; app user IDs are never cast to Party IDs. */
export function kanbangerIntake(engine: Engine, ctx: CallContext, binding: IntakeBinding, run: (effect: ReturnType<Engine['call']>) => Promise<Record<string, unknown>>) {
  return { async recordIssue(fact: IssueFact) {
    if (fact.workspaceId !== ctx.tenant || fact.creatorId !== binding.creatorId) throw new Error('Issue identity does not match trusted Foundation binding');
    const submission = await run(new Intake(engine).submit({ form: binding.formId,
      submitter: binding.submitterId, sourceKey: fact.issueId, submittedAt: fact.createdAt },
      { ...ctx, idempotencyKey: JSON.stringify(['kanbanger-intake', fact.issueId]) }));
    const link = await run(engine.call('@foundation-app/kanbanger/_/IssueSubmission.create', {
      issueId: fact.issueId, teamId: fact.teamId, workspaceId: fact.workspaceId,
      creatorId: fact.creatorId, submission: submission.id,
    }, { ...ctx, idempotencyKey: JSON.stringify(['kanbanger-issue', fact.issueId]) }));
    return { submissionId: String(submission.id), issueLinkId: String(link.id) };
  } };
}
