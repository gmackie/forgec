import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { kanbangerIntake } from '../../../examples/foundation/apps/kanbanger/adapter.js';
const root = process.env['FORGE_FOUNDATION_KANBANGER_ROOT'];
if (!root) throw new Error('FORGE_FOUNDATION_KANBANGER_ROOT is required');
// Database handle is injected; avoid initializing the app's deployed D1 client.
vi.doMock(root + '/packages/db/src/client.ts', () => ({}));
const { reconcileIssueFoundationIntake } = await import(root + '/packages/api/src/services/foundation-intake-service.ts');
const s = '@forgegraph/foundation/specification/_/', p = '@forgegraph/foundation/intake/_/';
for (const adapter of foundationAdapters) it(`${adapter}: Kanbanger persisted issue reconciliation uses real Intake with safe replay`, async () => {
  const f = await foundation('app-kanbanger', adapter);
  try {
    const repository = await f.call(s+'Repository.create', { key:'kanbanger', provider:'git', locator:'https://github.com/gmackie/kanbanger' });
    const pin = await f.call(s+'SpecificationPin.create', { repository:repository.id, anchor:'issue-intake', revision:'a'.repeat(40) });
    const form = await f.call(p+'IntakeForm.create', { definition:pin.id, label:'Persisted Kanbanger issue', anonymousAllowed:false });
    const party = await f.call('@forgegraph/foundation/party/_/Party.create', { label:'Issue creator' });
    const port = kanbangerIntake(f.engine,f.ctx,{creatorId:'user-01',formId:String(form.id),submitterId:String(party.id)},Effect.runPromise);
    const source = { workspaceId:f.ctx.tenant, issueId:'issue-01',teamId:'team-01',creatorId:'user-01',createdAt:new Date('2026-01-01T00:00:00Z') };
    let rows: unknown[] = [source];
    // Only the application DB read is controlled. The actual application service,
    // adapter, generated model, runtime validation and storage all execute.
    const query: any = { from:()=>query,innerJoin:()=>query,where:()=>query,limit:async()=>rows };
    const db = { select:()=>query };
    let writes = 0;
    const interrupted = kanbangerIntake(f.engine,f.ctx,{creatorId:'user-01',formId:String(form.id),submitterId:String(party.id)}, async effect => {
      if (++writes === 2) throw new Error('link transport interrupted');
      return Effect.runPromise(effect);
    });
    await expect(reconcileIssueFoundationIntake(db,f.ctx.tenant,source.issueId,interrupted)).rejects.toThrow('link transport interrupted');
    const result = await reconcileIssueFoundationIntake(db,f.ctx.tenant,source.issueId,port);
    expect(await reconcileIssueFoundationIntake(db,f.ctx.tenant,source.issueId,port)).toEqual(result);
    expect(await f.call(p+'Submission.get',{id:result.submissionId})).toMatchObject({sourceKey:source.issueId,submitter:party.id,definition:pin.id});
    expect(await f.call('@foundation-app/kanbanger/_/IssueSubmission.get',{id:result.issueLinkId})).toMatchObject({issueId:source.issueId,teamId:source.teamId,creatorId:source.creatorId,submission:result.submissionId});
    rows=[{...source,creatorId:'different-user'}];
    await expect(reconcileIssueFoundationIntake(db,f.ctx.tenant,source.issueId,port)).rejects.toThrow();
    rows=[source];
    await expect(reconcileIssueFoundationIntake(db,'foreign',source.issueId,port)).rejects.toThrow('authorized workspace');
    rows=[];
    await expect(reconcileIssueFoundationIntake(db,f.ctx.tenant,'missing',port)).rejects.toThrow('authorized workspace');
  } finally { await f.close(); }
});
