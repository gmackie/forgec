import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { Compositions } from '../src/foundation/composition.js';
const p = '@forgegraph/foundation/composition/_/', s = '@forgegraph/foundation/specification/_/';
for (const adapter of foundationAdapters) it(`${adapter}: intended structure, substitutions, nested instances, effectivity and swaps`, async () => {
 const h = await foundation('composition', adapter, true), run = Effect.runPromise;
 try {
  const { call, engine, ctx } = h, service = new Compositions(engine), from = '2026-01-01T00:00:00Z', later = '2026-02-01T00:00:00Z';
  const repository = await call(s + 'Repository.create', { key: 'composition', provider: 'git', locator: 'https://example.test/composition' });
  const pin = await call(s + 'SpecificationPin.create', { repository: repository.id, anchor: 'structure', revision: 'f'.repeat(40) });
  const spec = async (key: string, slotCount = 0, allowCycles = false) => call(p + 'CompositionSpecification.create', { key, definition: pin.id, slotCount, ordered: true, allowCycles });
  const leaf = await spec('component'), alternative = await spec('substitute'), wrong = await spec('wrong'), parent = await spec('assembly', 2);
  const slotInput = { specification: parent.id, component: leaf.id, unit: 'each', minimumCount: 1, maximumCount: 1, minimumQuantity: '2', maximumQuantity: '2', from, until: null };
  const required = await call(p + 'CompositionSlot.create', { ...slotInput, key: 'required', ordinal: 1, alternativeCount: 1 });
  const optional = await call(p + 'CompositionSlot.create', { ...slotInput, key: 'optional', ordinal: 2, minimumCount: 0, minimumQuantity: '1', maximumQuantity: '1', alternativeCount: 0 });
  await expect(run(service.specification(String(parent.id), ctx))).rejects.toThrow();
  await call(p + 'CompositionAlternative.create', { slot: required.id, ordinal: 1, component: alternative.id, authority: pin.id });
  expect((await run(service.specification(String(parent.id), ctx))).slots).toHaveLength(2);
  const instance = async (key: string, specification: unknown) => call(p + 'CompositionInstance.create', { key, specification, resource: null });
  const root = await instance('assembly', parent.id), component = await instance('component', leaf.id), substitute = await instance('substitute', alternative.id), unrelated = await instance('wrong', wrong.id);
  const makeSet = async (child: unknown, quantity = '2', withOptional = false, reversed = false) => {
   const set = await call(p + 'CompositionSet.create', { instance: root.id, componentCount: withOptional ? 2 : 1 });
   await call(p + 'CompositionMember.create', { set: set.id, ordinal: reversed ? 2 : 1, slot: required.id, child, quantity, unit: 'each' });
   if (withOptional) await call(p + 'CompositionMember.create', { set: set.id, ordinal: reversed ? 1 : 2, slot: optional.id, child: component.id, quantity: '1', unit: 'each' });
   return String(set.id);
  };
  const publish = (set: string, previous: string | null, at = from) => run(service.publish({ instance: String(root.id), set, previous, from: at, reason: 'Build or swap' }, ctx));
  const incomplete = await call(p + 'CompositionSet.create', { instance: root.id, componentCount: 1 });
  await expect(publish(String(incomplete.id), null)).rejects.toThrow();
  await expect(publish(await makeSet(unrelated.id), null)).rejects.toThrow();
  await expect(publish(await makeSet(component.id, '1'), null)).rejects.toThrow();
  const initial = await publish(await makeSet(component.id), null);
  const original = await run(service.conform(String(root.id), from, ctx));
  expect(original.children[0]!.instance.id).toBe(component.id);
  await expect(publish(await makeSet(substitute.id, '2', true, true), String(initial.id), later)).rejects.toThrow();
  const replacement = await publish(await makeSet(substitute.id, '2', true), String(initial.id), later);
  expect((await run(service.conform(String(root.id), later, ctx))).children[0]!.instance.id).toBe(substitute.id);
  expect((await run(service.conform(String(root.id), from, ctx))).revision!.id).toBe(initial.id);
  await expect(publish(await makeSet(component.id), String(initial.id), '2026-03-01T00:00:00Z')).rejects.toThrow();
  for (const [name, field] of [['Assembly', 'partNumber'], ['ServiceBundle', 'offering'], ['SoftwarePackage', 'packageName'], ['Curriculum', 'program']]) await call('@fixture/composition-consumer/_/' + name + '.create', { instance: root.id, [field!]: name });
  const empty = await call(p + 'CompositionSet.create', { instance: root.id, componentCount: 0 });
  await expect(publish(String(empty.id), String(replacement.id), '2026-03-01T00:00:00Z')).rejects.toThrow();
  for (const allow of [false, true]) {
   const cycle = await spec('cycle-' + allow, 1, allow);
   const slot = await call(p + 'CompositionSlot.create', { ...slotInput, specification: cycle.id, component: cycle.id, key: 'self', ordinal: 1, minimumCount: 0, minimumQuantity: '1', maximumQuantity: '1', alternativeCount: 0 });
   if (!allow) { await expect(run(service.specification(String(cycle.id), ctx))).rejects.toThrow(); continue; }
   const node = await instance('cycle', cycle.id), set = await call(p + 'CompositionSet.create', { instance: node.id, componentCount: 1 });
   await call(p + 'CompositionMember.create', { set: set.id, ordinal: 1, slot: slot.id, child: node.id, quantity: '1', unit: 'each' });
   await run(service.publish({ instance: String(node.id), set: String(set.id), previous: null, from, reason: 'Permitted recursive structure' }, ctx));
   expect((await run(service.conform(String(node.id), from, ctx))).children[0]!.cycle).toBe(true);
  }
  await expect(run(service.conform(String(root.id), from, { ...ctx, tenant: 'other' }))).rejects.toThrow();
 } finally { await h.close(); }
});
