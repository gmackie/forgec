import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { Inventory, type InventoryAction } from '../src/foundation/inventory.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Allocations } from '../src/foundation/allocation.js';
import { Demands } from '../src/foundation/demand.js';
import { Engine } from '../src/engine.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p = '@forgegraph/foundation/inventory/_/', s = '@forgegraph/foundation/specification/_/', a = '@forgegraph/foundation/allocation/_/';
for (const adapter of foundationAdapters) it(`${adapter}: serialized and lot stock, atomic claims, movements, counts and visibility`, async () => {
 const h = await foundation('inventory', adapter, true), run = Effect.runPromise;
 try {
  const { call, engine, ctx } = h, inventory = new Inventory(engine);
  const repository = await call(s + 'Repository.create', { key: 'stock', provider: 'git', locator: 'https://example.test/stock' });
  const pin = await call(s + 'SpecificationPin.create', { repository: repository.id, anchor: 'item', revision: 'e'.repeat(40) });
  const spec = await call(p + 'StockItemSpecification.create', { key: 'part', definition: pin.id, unit: 'each' });
  const ids = await call('@forgegraph/foundation/identifiers/_/IdentifierSet.create', { label: 'Stock' });
  const party = await call('@forgegraph/foundation/party/_/Party.create', { label: 'Custodian' });
  const place = await call('@forgegraph/foundation/place/_/Place.create', { identifiers: ids.id, name: 'Warehouse' });
  const item = await call(p + 'StockItem.create', { key: 'lot', specification: spec.id, identifiers: ids.id, kind: 'lot', serial: null, lot: 'batch-1' });
  const pool = await call(a + 'AllocationPool.create', { key: 'warehouse', mode: 'fungible', capacity: '100', unit: 'each' });
  const position = await call(p + 'InventoryPosition.create', { item: item.id, place: place.id, custodian: party.id, condition: 'usable', pool: pool.id, reorderPoint: '5' });
  const at = '2026-01-02T00:00:00Z'; let n = 0;
  const move = async (kind: InventoryAction, quantity: string, extra: Record<string, string> = {}) => run(inventory.move({ item: String(item.id), previous: (await run(inventory.position(String(position.id), ctx))).head as string | null, key: 'command-' + ++n, kind, at, position: String(position.id), quantity, source: String(pin.id), ...extra }, ctx));
  const received = await move('receipt', '10');
  expect((await run(inventory.position(String(position.id), ctx))).onHand).toBe('10.000000');
  const reservation = await call(a + 'AllocationReservation.create', { pool: pool.id, key: 'pick', quantity: '4', unit: 'each', from: at, until: '2026-01-03T00:00:00Z', holdUntil: at });
  const stockClaim = await call(p + 'InventoryReservation.create', { position: position.id, allocation: reservation.id, demand: null });
  await move('reserve', '4', { reservation: String(stockClaim.id) });
  expect((await run(inventory.position(String(position.id), ctx))).available).toBe('6.000000');
  await expect(move('issue', '7')).rejects.toThrow();
  await move('issue', '4', { reservation: String(stockClaim.id) });
  expect((await run(inventory.position(String(position.id), ctx))).onHand).toBe('6.000000');
  expect((await run(new Allocations(engine).reservation(String(reservation.id), ctx))).phase).toBe('released');
  const positions: Record<string, string> = {};
  for (const condition of ['returned', 'damaged', 'quarantine']) {
   const targetPool = await call(a + 'AllocationPool.create', { key: condition, mode: 'fungible', capacity: '100', unit: 'each' });
   const target = await call(p + 'InventoryPosition.create', { item: item.id, place: place.id, custodian: party.id, condition, pool: targetPool.id, reorderPoint: '0' });
   positions[condition] = String(target.id);
  }
  await move('transfer', '2', { destination: positions.quarantine! });
  expect((await run(inventory.position(positions.quarantine!, ctx))).available).toBe('0.000000');
  await expect(move('issue', '1', { position: positions.quarantine! })).rejects.toThrow();
  await move('transfer', '1', { position: positions.quarantine!, destination: positions.damaged! });
  await move('returned', '1', { position: positions.returned! });
  const bundle = await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create', { key: 'count', label: 'Physical count evidence' });
  const seal = await run(new Evidence(engine).seal(String(bundle.id), null, ctx));
  const count = await call(p + 'InventoryCount.create', { position: position.id, quantity: '3', at, evidence: seal.id });
  await move('reconcile', '1', { count: String(count.id) });
  expect((await run(inventory.position(String(position.id), ctx))).reorderGap).toBe('2.000000');
  const demand = await run(new Demands(engine).record({ key: 'reorder', requester: String(party.id), specification: String(pin.id), constraints: String(pin.id), origin: 'inferred', quantity: '2', unit: 'each', place: String(place.id), from: at, until: '2026-01-03T00:00:00Z', priority: 1, priorityPolicy: String(pin.id), source: 'count', support: String(seal.id) }, ctx));
  const reorder = await call(p + 'InventoryReorder.create', { position: position.id, demand: demand.id });
  expect((await run(inventory.reorder(String(reorder.id), ctx))).gap).toBe('2.000000');
  const previous = (await run(inventory.position(String(position.id), ctx))).head as string | null;
  const races = await Promise.allSettled([1, 2].map(i => run(inventory.move({ item: String(item.id), previous, key: 'race' + i, kind: 'issue', at, position: String(position.id), quantity: '2', source: String(pin.id) }, ctx))));
  expect(races.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await run(inventory.position(String(position.id), ctx))).onHand).toBe('1.000000');
  const claims = [];
  for (const key of ['last-a', 'last-b']) {
   const allocation = await call(a + 'AllocationReservation.create', { pool: pool.id, key, quantity: '1', unit: 'each', from: at, until: '2026-01-03T00:00:00Z', holdUntil: at });
   const claim = await call(p + 'InventoryReservation.create', { position: position.id, allocation: allocation.id, demand: null });
   claims.push({ allocation, claim, key });
  }
  const claimHead = (await run(inventory.position(String(position.id), ctx))).head as string | null;
  const claimsRace = await Promise.allSettled(claims.map(c => run(inventory.move({ item: String(item.id), previous: claimHead, key: c.key, kind: 'reserve', at, position: String(position.id), quantity: '1', reservation: String(c.claim.id), source: String(pin.id) }, ctx))));
  expect(claimsRace.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const phases = await Promise.all(claims.map(c => run(new Allocations(engine).reservation(String(c.allocation.id), ctx))));
  expect(phases.filter(r => r.phase === 'allocated')).toHaveLength(1);
  expect(phases.filter(r => r.phase === null)).toHaveLength(1);
  expect((await run(inventory.position(String(position.id), ctx))).available).toBe('0.000000');
  const resource = await call('@forgegraph/foundation/resource-relations/_/ResourceSubject.create', { key: 'serial-1', label: 'Device' });
  const serial = await call(p + 'StockItem.create', { key: 'serial', specification: spec.id, identifiers: ids.id, kind: 'serialized', serial: resource.id, lot: null });
  const serialPool = await call(a + 'AllocationPool.create', { key: 'serial', mode: 'exclusive', capacity: '1', unit: 'each' });
  const serialPosition = await call(p + 'InventoryPosition.create', { item: serial.id, place: place.id, custodian: party.id, condition: 'usable', pool: serialPool.id, reorderPoint: '0' });
  const serialInput = { item: String(serial.id), previous: null, key: 'serial-receipt', kind: 'receipt' as const, at, position: String(serialPosition.id), quantity: '1', source: String(pin.id) };
  await expect(run(inventory.move({ ...serialInput, quantity: '0.5' }, ctx))).rejects.toThrow();
  const serialReceipt = await run(inventory.move(serialInput, ctx));
  await expect(run(inventory.move({ ...serialInput, key: 'duplicate', previous: String(serialReceipt.id) }, ctx))).rejects.toThrow();
  for (const [name, field] of [['WarehouseStock', 'sku'], ['ManufacturingStock', 'material'], ['ClinicalStock', 'product'], ['ITStock', 'model']]) await call('@fixture/inventory-consumer/_/' + name + '.create', { item: name === 'ITStock' ? serial.id : item.id, [field!]: name });
  for (const kind of ['object', 'aggregation', 'transformation', 'transaction', 'association']) {
   const visibility = await call(p + 'InventoryVisibility.create', { movement: received.id, kind, related: ['aggregation', 'transformation', 'association'].includes(kind) ? serial.id : null, transaction: kind === 'transaction' ? pin.id : null, evidence: seal.id });
   await call('@fixture/inventory-consumer/_/VisibilityEvent.create', { visibility: visibility.id, epcisReference: 'urn:epcis:' + kind });
   expect((await run(inventory.visibility(String(visibility.id), ctx))).row.kind).toBe(kind);
  }
  await expect(run(inventory.position(String(position.id), { ...ctx, tenant: 'other' }))).rejects.toThrow();
  const guarded = new Engine(engine.model, engine.layer);
  guarded.gatekeeper.authorizer = localAuthorizer({ policies: engine.model.resources.filter(r => r.id !== p + 'InventoryMovement').map(r => ({ id: r.id, actions: [r.id + '.*'], requires: [], where: [] })), pips: [], epoch: 2, knownObligations: [] });
  await expect(run(new Inventory(guarded).position(String(position.id), ctx))).rejects.toThrow();
 } finally { await h.close(); }
});
