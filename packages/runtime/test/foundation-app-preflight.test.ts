import { expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { sha256, stableJson, type Engine } from '../src/engine.js';
import { kanbangerIntake, type IssueFact } from '../src/foundation/apps/kanbanger.js';
import { latchFlowFoundation, type LatchFlowRun } from '../src/foundation/apps/latchflow.js';
import { streamConductorFoundation, type AcknowledgedProductionCommand } from '../src/foundation/apps/stream-conductor.js';
const ctx = () => ({ tenant: 'tenant', actor: 'operator', requestId: 'test' });
const issue: IssueFact = { workspaceId:'tenant', issueId:'issue', teamId:'team', creatorId:'operator', createdAt:'2026-01-01T00:00:00Z' };
const latch: LatchFlowRun = { buildingId:'tenant', roomId:'room', runId:'run', operatorId:'operator', flowId:'flow', compiledFlowId:'compiled', compiledJson:'{"nodes":[]}', runnerId:null, status:'idle', startedAt:'2026-01-01T00:00:00Z' };
const command: AcknowledgedProductionCommand = { teamId:'tenant', sessionId:'session', broadcastId:'broadcast', commandId:'command', operatorId:'operator', sequence:1, type:'cut', payload:{scene:'original'}, issuedAt:'2026-01-01T00:00:00Z', completedAt:'2026-01-01T00:00:01Z' };
function engineFixture(onCall = () => {}) {
  const call = vi.fn().mockImplementation(() => { onCall(); return Effect.succeed({ id:'record' }); });
  return { call, engine: { call } as unknown as Engine };
}
it.each([{teamId:''}, {teamId:'x'.repeat(129)}, {createdAt:'invalid'}])('KanBanger rejects invalid native facts before submission (case %#)', async patch => {
  const f=engineFixture(), run=vi.fn().mockResolvedValue({id:'record'});
  const port=kanbangerIntake(f.engine,ctx(),{creatorId:'operator',formId:'form',submitterId:'party'},run);
  await expect(port.recordIssue({...issue,...patch})).rejects.toThrow();
  expect(run).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
});
it('KanBanger retains exact fact/context across its two writes', async () => {
  const f=engineFixture(), fact={...issue}, context=ctx();
  const run=vi.fn().mockImplementationOnce(async()=>{fact.issueId='changed';fact.teamId='changed';context.tenant='changed';return{id:'submission'};}).mockResolvedValue({id:'link'});
  await kanbangerIntake(f.engine,context,{creatorId:'operator',formId:'form',submitterId:'party'},run).recordIssue(fact);
  expect(f.call).toHaveBeenCalledWith('@foundation-app/kanbanger/_/IssueSubmission.create',{issueId:'issue',teamId:'team',workspaceId:'tenant',creatorId:'operator',submission:'submission'},expect.objectContaining({tenant:'tenant',idempotencyKey:'["kanbanger-issue","issue"]'}));
});
it.each([{operatorId:''}, {runnerId:''}, {flowId:'x'.repeat(129)}, {runId:'x'.repeat(128)}, {startedAt:'invalid'}, {compiledJson:undefined}])('LatchFlow rejects invalid input before resolving or writing (case %#)', async patch => {
  const f=engineFixture(), definition=vi.fn().mockResolvedValue('pin');
  const port=latchFlowFoundation(f.engine,{context:ctx,definition});
  await expect(port.recordRun({...latch,...patch} as LatchFlowRun)).rejects.toThrow();
  expect(f.call).not.toHaveBeenCalled(); expect(definition).not.toHaveBeenCalled();
});
it('LatchFlow snapshots input and context before asynchronous definition resolution', async () => {
  const f=engineFixture(), event={...latch}, context=ctx();
  const port=latchFlowFoundation(f.engine,{context:()=>context,definition:async()=>{event.runId='changed';event.roomId='changed';context.tenant='changed';return'pin';}});
  await port.recordRun(event);
  expect(f.call).toHaveBeenCalledWith('@foundation-app/latchflow/_/Run.create',expect.objectContaining({nativeId:'run',operatorId:'operator'}),expect.objectContaining({tenant:'tenant',idempotencyKey:'["latchflow","run:run"]'}));
  expect(f.call).toHaveBeenCalledWith('@foundation-app/latchflow/_/Room.create',{nativeId:'room'},expect.objectContaining({tenant:'tenant'}));
});
it.each([{operatorId:''}, {broadcastId:''}, {sessionId:'x'.repeat(129)}, {type:'other'}, {issuedAt:'invalid'}, {completedAt:'2025-12-31T23:59:59Z'}, {payload:{value:1n}}])('Stream rejects invalid input before creating any facts (case %#)', async patch => {
  const f=engineFixture();
  await expect(streamConductorFoundation(f.engine,ctx).recordAcknowledgedCommand({...command,...patch} as AcknowledgedProductionCommand)).rejects.toThrow();
  expect(f.call).not.toHaveBeenCalled();
});
it('Stream freezes nested payload digest and identity before its first write', async () => {
  const event={...command,payload:{scene:'original'}}, context=ctx();
  const f=engineFixture(()=>{event.commandId='changed';event.payload.scene='changed';context.tenant='changed';});
  await streamConductorFoundation(f.engine,()=>context).recordAcknowledgedCommand(event);
  expect(f.call).toHaveBeenCalledWith('@foundation-app/stream-conductor/_/ProductionCommand.create',expect.objectContaining({nativeId:'command',payloadDigest:await sha256(stableJson({scene:'original'}))}),expect.objectContaining({tenant:'tenant',idempotencyKey:'["stream-conductor","link:command"]'}));
});
