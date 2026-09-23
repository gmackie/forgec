# Configurable SaaS: tenant metadata

Tenant administrators define object types, fields, relationships and automations at runtime. PublishSchema owns metadata revisions; MutateDynamicRecord owns records referencing the object and schema version under which their payload is interpreted. New tenant objects do not require new compiler Entity declarations. Generated CRUD is one interface to the same logical mutation authority.

The static contract describes a platform interpreter. Payload text is an explicit loss of type precision, not proof that arbitrary runtime records are valid. Tenant isolation, schema migration and safe automation interpretation remain runtime obligations. A tenant import is an external acquisition with the same authority checks as interactive administration.
