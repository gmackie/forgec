# Upstream reproduction drafts — not submitted

Cloudflare Forge baseline: cfe397c296a5e6d9fce01eb335ed805821e5547c.

- Instance isolation: initialize API A with operation ID listItems and a response description of first API; initialize B with the same ID and second API. A.matchResponseStatus now returns B's metadata. The module-level resolver state in openapi-resolver.ts is shared. Repro: core-probes.mjs. Prefer per-instance resolver state; test interleaved operations across two documents.
- Generic SDK response behavior: unwrapCloudflareEnvelope rewrites any object with success/result and throws when success is false, irrespective of the operation's schema. `{success:true,result:{id:'issue-1'},audit:'business-data'}` loses fields. Scope envelope handling to declared Cloudflare envelopes; preserve generic JSON bodies. Repro: core-probes.mjs.
- Packaging: both advertised public npm names returned 404 on 2026-09-28. Source build requires two ignored OpenAPI inputs. Staging the pinned public release at both paths builds successfully. Document this supported bootstrap or make generic packaging independent of Cloudflare spec artifacts.
- Docs namespaces: fern-forge operation metadata validation rejects ForgeGraph's x-forge-kind/x-forge-slo (55/55 Acme operations). This is an integration namespace conflict, not necessarily an upstream bug. Prefer a separate docs projection/explicit extension handling; don't remove runtime metadata from our canonical contract.
- sdk-map omits responseType for GitHub's array-returning list method, although generated TypeScript returns Issue[]. Do not assume the map alone is a complete type IR.

No maintainer contact or upstream issue submission has been performed.
