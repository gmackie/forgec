import { Effect } from 'effect';
import type { foundation } from './foundation.js';
import { AgreementCatalog } from '../../src/foundation/agreement-catalog.js';
import { Decisions } from '../../src/foundation/decision.js';
/** A genuinely issued two-party agreement for composed business-system tests. */
export async function agreement(h: Awaited<ReturnType<typeof foundation>>) {
 const { engine, ctx, call } = h, run = Effect.runPromise;
 const s = '@forgegraph/foundation/specification/_/', a = '@forgegraph/foundation/agreement-catalog/_/', p = '@forgegraph/foundation/participation/_/', e = '@forgegraph/foundation/entitlement/_/';
 const catalog = new AgreementCatalog(engine), decisions = new Decisions(engine);
 const repo = await call(s + 'Repository.create', { key: 'agreement', provider: 'git', locator: 'https://example.test/terms' }), pin = await call(s + 'SpecificationPin.create', { repository: repo.id, anchor: 'terms', revision: 'a'.repeat(40) });
 const supplier = await call('@forgegraph/foundation/party/_/Party.create', { label: 'Supplier' }), customer = await call('@forgegraph/foundation/party/_/Party.create', { label: 'Customer' });
 const participants = await call(p + 'ParticipationSet.create', { label: 'Signers' }), role = await call(p + 'ParticipationRole.create', { namespace: 'contracts', name: 'signer' }), signers = [];
 for (const party of [supplier, customer]) signers.push(await call(p + 'Participation.create', { participationSet: participants.id, participant: party.id, role: role.id, validFrom: '2025-01-01T00:00:00Z', validUntil: null, reason: 'Signer', recordedBy: ctx.actor }));
 const collection = await call(a + 'Catalog.create', { key: 'catalog', label: 'Catalog' }), entry = await call(a + 'CatalogEntry.create', { catalog: collection.id, key: 'service', specification: pin.id }), scope = await call(e + 'EntitlementScope.create', { label: 'Contract' });
 const right = await call(e + 'RightDefinition.create', { namespace: 'contract', name: 'service' }), requirement = await call(e + 'RequirementDefinition.create', { namespace: 'contract', name: 'payment' });
 const offer = await run(catalog.publish({ entry: String(entry.id), supplier: String(supplier.id), terms: String(pin.id), scope: String(scope.id), right: String(right.id), requirement: String(requirement.id), validFrom: '2025-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' }, ctx));
 const approval = await run(decisions.open({ participationSet: String(participants.id), electors: signers.map(s => String(s.id)), eligibilityAt: '2026-01-01T00:00:00Z', rule: 'Unanimous', options: ['Accept', 'Reject'], deadline: '2027-01-01T00:00:00Z' }, ctx)), options = (await run(decisions.state(String(approval.id), ctx))).options;
 await run(catalog.select(String(offer.id), String(approval.id), String(options[0]!.id), ctx));
 for (const signer of signers) await run(decisions.respond(String(approval.id), String(signer.id), [0], ctx));
 await run(decisions.finalize(String(approval.id), ctx));
 const contract = await run(catalog.accept({ acceptanceKey: 'agreement', offer: String(offer.id), customer: String(customer.id), expectedTerms: String(pin.id), supplierParticipation: String(signers[0]!.id), customerParticipation: String(signers[1]!.id), decisionCase: String(approval.id), approvedOption: String(options[0]!.id), validFrom: '2026-02-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z' }, ctx));
 await run(catalog.issue(String(contract.id), ctx));
 return { pin, supplier, customer, participants, signers, scope, right, requirement, contract, catalog, decisions, approval, accepted: options[0]! };
}
