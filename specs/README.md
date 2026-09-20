# Forge specifications

Normative documents and executable vectors. The compiler (Rust) and the runtime
(TypeScript/Effect) are both conformance targets of what is written here; when
they disagree, the spec wins and one of them has a bug.

| area | contents |
| --- | --- |
| `language/` | lexical structure, grammar (EBNF), lifecycle inference, module and identity rules |
| `ir/` | DomainIR and downstream IR shapes and versioning |
| `portable-profile/` | canonical wire format, error taxonomy, operation state models, operating envelope |
| `codecs/` | codec/normalizer/constraint semantics and golden vectors consumed by both implementations |

Version: `edition = "2026"`, `profile = "portable-v1"`. Changes are RFCs; a
change to a wire-visible rule bumps the profile.
