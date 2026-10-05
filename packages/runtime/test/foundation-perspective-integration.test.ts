import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
const p = '@fixture/integration-consumer/_/';
const i = '@forgegraph/foundation/integration/_/';
const identifiers = '@forgegraph/foundation/identifiers/_/';
const lineage = '@forgegraph/foundation/lineage/_/';
for (const adapter of foundationAdapters) it(`${adapter}: two companies map their documents to one neutral transfer`, async () => {
  const f = await foundation('integration', adapter, true);
  try {
    const { call, ctx } = f;
    const seller = await call(p + 'Company.create', { key: 'seller' });
    const buyer = await call(p + 'Company.create', { key: 'buyer' });
    const outsider = await call(p + 'Company.create', { key: 'outsider' });
    const transfer = await call(p + 'NeutralTransfer.create', { seller: seller.id, buyer: buyer.id, quantity: 1000 });
    const graph = await call(lineage + 'LineageGraph.create', { label: 'Trade' });
    const node = await call(lineage + 'LineageNode.create', { graph: graph.id, rank: 1, label: 'Neutral transfer' });
    for (const [company, document] of [[seller, 'sales-invoice'], [buyer, 'purchase-invoice']] as const) {
      const scope = await call('@forgegraph/foundation/reconciliation/_/ReconciliationScope.create', { key: document });
      const connection = await call(i + 'Connection.create', { key: document, provider: document, credentialBinding: 'test-binding', direction: 'Inbound', authority: 'External', reconciliation: scope.id });
      const set = await call(identifiers + 'IdentifierSet.create', { label: document });
      const identifier = await call(identifiers + 'Identifier.create', { identifierSet: set.id, namespace: document, issuerScope: 'namespace', value: '42', validFrom: '2026-01-01T00:00:00Z' });
      const mapping = await call(i + 'ExternalMapping.create', { connection: connection.id, identifier: identifier.id, node: node.id });
      await expect(call(p + 'TransferDocument.create', { mapping: mapping.id, transfer: transfer.id, observer: outsider.id })).rejects.toThrow();
      const represented = await call(p + 'TransferDocument.create', { mapping: mapping.id, transfer: transfer.id, observer: company.id });
      expect(represented.transfer).toBe(transfer.id);
      await expect(call(p + 'TransferDocument.create', { mapping: mapping.id, transfer: transfer.id, observer: company.id }, { ...ctx, tenant: 'foreign' })).rejects.toThrow();
    }
    expect((await call(p + 'TransferDocument.list.byTransfer', { params: { transfer: transfer.id } })).items).toHaveLength(2);
    expect((await call(p + 'NeutralTransfer.list.bySeller', { params: { seller: seller.id } })).items).toHaveLength(1);
  } finally { await f.close(); }
});
