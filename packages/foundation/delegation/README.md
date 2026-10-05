# Delegation

Durable, explicit authority transfer between typed DelegationSubjects. A Party profile binds
only the ultimate entitlement holder; a software delegate has its own Subject and need not
pretend to be a person or organization. Human, employee and agent consumers add their typed
mandate/position/tool payloads. Roles and organizational relationships never create delegation.

Every chain preserves the exact root entitlement, right, scope, constraint specification and
purpose. Validity narrows at every hop. Parents must permit re-delegation, depth is bounded
to eight and revocation propagates through every descendant during explanation. Quantity
and consumption remain properties of the shared root authority: delegation does not mint
additional quota. Root revocation or expiry also invalidates the chain.

`Delegations.explain` reads every immutable link and authorized evidence, returning the
ultimate authority, ordered chain and reasons a chain is ineffective. Hidden revocations
fail closed. `assurance` checks the trusted principal-to-subject mapping supplied by the
caller. `pip` computes a one-second Gatekeeper input for that exact delegation; policy must
still check the required scope, right, purpose and constraints and use live resolution or
cache invalidation. Tests exercise a separate Gatekeeper policy consuming that fact.

Revocation facts and original links remain append-only. A new delegation is a new grant,
not a mutation or resurrection. Domain applications authenticate grant creation and interpret
constraint specifications; the core validates structural attenuation and evidence provenance.
