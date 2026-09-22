# Write-only credentials

`Integration` models KanBanger integration tokens; `DeploymentCredential` models
Bob/ForgeGraph runtime credentials. `@secret` is distinct from data classification.
It requires a versioned resource and a text field without defaults, derivations,
normalizers or sequence allocation.

Generated create/update schemas accept the field as `writeOnly`. Record/read
schemas expose only `<field>Present`. All normal resource results, including
idempotency receipts, omit plaintext and ciphertext. Replacement uses normal
version-checked update; optional credentials can be cleared with null.

Configure `EngineOptions.secrets` on the host. The provider-neutral `SecretAdapter`
seals a value before any record commit. The included `AesGcmSecretAdapter` uses
WebCrypto AES-GCM, a fresh nonce, and tenant/resource/record/field authenticated
context. Supply keys through host secret bindings, not Forge source or artifacts.
Missing adapters and encryption failures fail closed. Retain old keys for existing
envelopes; rotate the active key for new writes. Each plaintext is limited to 16 KiB.

Trusted external implementations may load a sealed reference from storage and use
`vault.use(context, reference, consumer)`. Every use requires a purpose/actor policy
callback and an audit callback; only the consumer receives plaintext. Do not log
consumer input or return plaintext from handwritten functions. This API is an
explicit trusted-code boundary, not automatic secret-reference injection or proof
about arbitrary implementation code.

Audit redaction recognizes secret fields independently of classification. Generated
row audits contain metadata; their stored records contain sealed envelopes.
Indexes over secret fields, credential read models, row rules/derived fields on
credential resources, CSV staging, changeset staging and record-only migration are
rejected in this profile. Dedicated key-aware migration, read-once disclosure,
automatic external secret injection and provider KMS integrations remain outstanding.

Tests exercise memory and SQLite storage, non-disclosure, sealing failures, tenant
binding, authorized/denied use, receipts and token replacement. Live provider/KMS
certification is not claimed.
