import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { Collaborations } from '../src/foundation/collaboration.js';
import { Artifacts } from '../src/foundation/artifact.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p = '@forgegraph/foundation/collaboration/_/', m = '@forgegraph/foundation/participation/_/', a = '@forgegraph/foundation/artifact/_/';
const at = '2026-01-01T00:00:00Z';
const run = Effect.runPromise;
for (const adapter of foundationAdapters) {
  it(`${adapter}: typed discussion sidecars, immutable corrections and activity rebuild`, async () => {
    const f = await foundation('collaboration', adapter, true), { call, engine, ctx } = f;
    try {
      const party = await call('@forgegraph/foundation/party/_/Party.create', { label: 'Alice' });
      const set = await call(m + 'ParticipationSet.create', { label: 'Discussants' });
      const role = await call(m + 'ParticipationRole.create', { namespace: 'discussion', name: 'member' });
      const membership = await call(m + 'Participation.create', { participationSet: set.id, participant: party.id, role: role.id, validFrom: at, recordedBy: 'test', reason: 'Joined' });
      const thread = await call(p + 'Thread.create', { participants: set.id, title: 'Review' });
      const actor = await call(p + 'ThreadParticipant.create', { thread: thread.id, membership: membership.id });
      for (const name of ['KanBangerIssue', 'ForgeGraphDeployment', 'LevelForgeCandidate']) {
        const sidecar = await call('@fixture/collaboration-consumer/_/' + name + '.create', { label: name, discussion: thread.id });
        expect(sidecar.discussion).toBe(thread.id);
      }
      const api = new Collaborations(engine);
      const entry = await call(p + 'ThreadEntry.create', { thread: thread.id, author: actor.id, body: 'Initial', recordedAt: at });
      expect((await run(api.activity(String(thread.id), ctx))).events).toHaveLength(0);
      const initial = { thread: String(thread.id), actor: String(actor.id), kind: 'Entry' as const, at, previous: null, fact: String(entry.id) };
      const first = await run(api.publish(initial, { ...ctx, idempotencyKey: 'entry-1' }));
      expect(await run(api.publish(initial, { ...ctx, idempotencyKey: 'entry-1' }))).toEqual(first);
      await expect(run(api.publish({ ...initial, kind: 'Close' }, { ...ctx, idempotencyKey: 'entry-1' }))).rejects.toThrow();
      const reactions = await Promise.allSettled(Array.from({ length: 5 }, () => call(p + 'Reaction.create', { thread: thread.id, entry: entry.id, author: actor.id, code: 'agree' })));
      expect(reactions.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const reaction = (reactions.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Record<string, unknown>>).value;
      let head = await run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Reaction', at, previous: String(first.id), fact: String(reaction.id) }, ctx));
      const mention = await call(p + 'Mention.create', { thread: thread.id, entry: entry.id, participant: actor.id });
      head = await run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Mention', at, previous: String(head.id), fact: String(mention.id) }, ctx));
      const artifact = await call(a + 'Artifact.create', { key: 'attachment', label: 'Attachment' });
      const content = await call(a + 'ArtifactContent.create', {});
      const upload = await call(a + 'ArtifactContent.beginUpload', { id: content.id, expectedVersion: 1, mediaType: 'text/plain', byteCount: 5 });
      await f.objects.simulateUpload((upload.upload as { url: string }).url, new TextEncoder().encode('proof'), 'text/plain');
      const ready = await call(a + 'ArtifactContent.finalizeUpload', { id: content.id, expectedVersion: 2 });
      const revision = await run(new Artifacts(engine).publish({ artifact: String(artifact.id), content: String(content.id), digest: String(ready.digest) }, ctx));
      const attachment = await call(p + 'AttachmentLink.create', { thread: thread.id, entry: entry.id, revision: revision.id });
      head = await run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Attachment', at, previous: String(head.id), fact: String(attachment.id) }, ctx));
      const correction = await call(p + 'ThreadEntry.create', { thread: thread.id, author: actor.id, body: 'Corrected', corrects: entry.id, recordedAt: at });
      head = await run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Entry', at, previous: String(head.id), fact: String(correction.id) }, ctx));
      const contenders = await Promise.allSettled(Array.from({ length: 4 }, () => run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Close', at, previous: String(head.id) }, ctx))));
      expect(contenders.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const activity = await run(new Collaborations(engine).activity(String(thread.id), ctx));
      expect(activity.closed).toBe(true); expect(activity.events).toHaveLength(6);
      expect((await call(p + 'ThreadEntry.get', { id: entry.id })).body).toBe('Initial');
      await expect(run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Mention', at, previous: activity.head, fact: String(mention.id) }, ctx))).rejects.toThrow();
      const reopened = await run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Reopen', at, previous: activity.head }, ctx));
      expect((await run(api.activity(String(thread.id), ctx))).closed).toBe(false);
      await expect(call(p + 'ThreadEntry.update', { id: entry.id, body: 'Erase history' })).rejects.toThrow();
      await expect(call(p + 'AttachmentLink.create', { thread: thread.id, entry: entry.id, revision: revision.id }, { ...ctx, tenant: 'foreign' })).rejects.toThrow();
      engine.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== p + 'ThreadEvent').map(r => ({ id: r.id, actions: [r.id + '.*'], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(api.activity(String(thread.id), ctx))).rejects.toThrow();
      engine.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== a + 'ArtifactRevision' && r.id !== p + 'ThreadParticipant').map(r => ({ id: r.id, actions: [r.id + '.*'], requires: [], where: [] })), pips: [], epoch: 2, knownObligations: [] });
      const hiddenMention = await call(p + 'Mention.create', { thread: thread.id, entry: correction.id, participant: actor.id });
      await expect(run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Mention', at, previous: String(reopened.id), fact: String(hiddenMention.id) }, ctx))).rejects.toThrow();
      engine.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== a + 'ArtifactRevision').map(r => ({ id: r.id, actions: [r.id + '.*'], requires: [], where: [] })), pips: [], epoch: 3, knownObligations: [] });
      const hiddenAttachment = await call(p + 'AttachmentLink.create', { thread: thread.id, entry: correction.id, revision: revision.id });
      await expect(run(api.publish({ thread: String(thread.id), actor: String(actor.id), kind: 'Attachment', at, previous: String(reopened.id), fact: String(hiddenAttachment.id) }, ctx))).rejects.toThrow();
    } finally { await f.close(); }
  });
}
