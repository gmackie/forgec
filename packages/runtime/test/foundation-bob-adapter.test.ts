import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '../src/engine.js';
import { Fulfillments } from '../src/foundation/fulfillment.js';
import { bobCompletion, type RunFact } from '../src/foundation/apps/bob.js';

const fact: RunFact = { taskRunId: 'run', sessionId: 'session', userId: 'operator', workspaceId: 'tenant', planningItemId: 'issue', completedAt: '2026-10-01T01:00:00Z' };
const context = () => ({ tenant: fact.workspaceId, actor: fact.userId, requestId: 'test' });
function fixture(binding = { taskRunId: fact.taskRunId, fulfillmentId: 'execution' }) {
  const call = vi.fn();
  const engine = { call } as unknown as Engine;
  const run = vi.fn().mockResolvedValueOnce({ id: 'end' }).mockResolvedValueOnce({ id: 'link' });
  return { call, run, port: bobCompletion(engine, context(), binding, run) };
}

describe('Bob completion preflight', () => {
  it.each([
    ['empty session', { sessionId: '' }],
    ['oversized planning identity', { planningItemId: 'x'.repeat(129) }],
    ['invalid text', { sessionId: 'bad\u0000session' }],
    ['invalid datetime', { completedAt: 'yesterday' }],
    ['missing session', { sessionId: undefined }],
  ])('rejects %s before executing either write', async (_name, patch) => {
    const f = fixture();
    await expect(f.port.recordCompletion({ ...fact, ...patch } as RunFact)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['sessionId', 'planningItemId', 'userId', 'workspaceId'] as const)('honors trusted %s in an extended binding', async key => {
    const f = fixture({ taskRunId: fact.taskRunId, fulfillmentId: 'execution', ...{ [key]: 'different' } });
    await expect(f.port.recordCompletion(fact)).rejects.toThrow('binding');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('keeps minimal existing bindings compatible', async () => {
    const f = fixture();
    await expect(f.port.recordCompletion(fact)).resolves.toEqual({ fulfillmentEndId: 'end', runLinkId: 'link' });
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('retains the validated fact, context and binding while the first write is pending', async () => {
    const source = { ...fact };
    const ctx = context();
    const binding = { taskRunId: fact.taskRunId, fulfillmentId: 'execution' };
    const call = vi.fn();
    const engine = { call } as unknown as Engine;
    const finish = vi.spyOn(Fulfillments.prototype, 'finish');
    const run = vi.fn().mockImplementationOnce(async () => {
      source.sessionId = 'changed'; source.planningItemId = 'changed'; source.taskRunId = 'changed';
      binding.fulfillmentId = 'changed'; ctx.tenant = 'changed'; ctx.actor = 'changed';
      return { id: 'end' };
    }).mockResolvedValueOnce({ id: 'link' });
    try {
      await bobCompletion(engine, ctx, binding, run).recordCompletion(source);
      expect(call).toHaveBeenCalledWith('@foundation-app/bob/_/RunCompletion.create', {
        taskRunId: fact.taskRunId, sessionId: fact.sessionId, userId: fact.userId,
        workspaceId: fact.workspaceId, planningItemId: fact.planningItemId, execution: 'execution', terminal: 'end',
      }, { ...context(), idempotencyKey: JSON.stringify(['bob-run', fact.taskRunId]) });
      expect(finish.mock.calls[0]?.[5]).toMatchObject(context());
    } finally { finish.mockRestore(); }
  });
});
