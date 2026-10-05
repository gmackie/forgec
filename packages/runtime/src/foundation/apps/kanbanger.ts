import type { Engine, CallContext } from '../../engine.js';
import { Intake } from '../intake.js';
import { checkLength, decodeDatetime, decodeText } from '../../codecs.js';

export interface IssueFact { workspaceId: string; issueId: string; teamId: string; creatorId: string; createdAt: string }
export interface IntakeBinding { readonly creatorId: string; readonly formId: string; readonly submitterId: string }
/** Bindings are trusted, tenant-local Foundation IDs; app user IDs are never cast to Party IDs. */
export function kanbangerIntake(engine: Engine, ctx: CallContext, binding: IntakeBinding, run: (effect: ReturnType<Engine['call']>) => Promise<Record<string, unknown>>) {
  return { async recordIssue(input: IssueFact) {
    const fact = { ...input }, context = { ...ctx }, trusted = { ...binding };
    for (const key of ['workspaceId','issueId','teamId','creatorId'] as const) checkLength(decodeText(fact[key]), 1, 128);
    decodeDatetime(fact.createdAt);
    if (fact.workspaceId !== context.tenant || fact.creatorId !== trusted.creatorId) throw new Error('Issue identity does not match trusted Foundation binding');
    const submission = await run(new Intake(engine).submit({ form: trusted.formId,
      submitter: trusted.submitterId, sourceKey: fact.issueId, submittedAt: fact.createdAt },
      { ...context, idempotencyKey: JSON.stringify(['kanbanger-intake', fact.issueId]) }));
    const link = await run(engine.call('@foundation-app/kanbanger/_/IssueSubmission.create', {
      issueId: fact.issueId, teamId: fact.teamId, workspaceId: fact.workspaceId,
      creatorId: fact.creatorId, submission: submission.id,
    }, { ...context, idempotencyKey: JSON.stringify(['kanbanger-issue', fact.issueId]) }));
    return { submissionId: String(submission.id), issueLinkId: String(link.id) };
  } };
}
