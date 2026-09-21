# Post-M8 normative decisions

Extracted from implementation plan section 2; proposed until ratified in M9.

## 2. Normative decisions and corrections to earlier sketches

These decisions resolve conversational examples that were intentionally exploratory.

| ID | Decision |
|---|---|
| D01 | M0–M8 remain the regression baseline; no unverified implementation status is assumed. |
| D02 | Pure compilation is offline and deterministic. Fetch/update/publish/deploy are distinct effectful commands. |
| D03 | Folder moves do not change semantic IDs; package/module identity is explicit and versioned. |
| D04 | `source` remains intrinsically one-way. HTTP/MCP request-response and WebSocket duplex interfaces are bindings, not redefinitions of source. |
| D05 | `function` is a typed callable contract; implementation location and RPC transport are realization details. Remote invocation failures remain explicit. |
| D06 | `uses` declares potential effects/dependencies, not unconditional execution, identity proof, or consent. |
| D07 | Purpose taxonomy inheritance describes meaning; it grants **no automatic field/action authority**. Capability inheritance is explicit and separately reviewed. |
| D08 | Resource-local capability inclusion combines grants; all inherited denials remain sticky. Read, create, update, query, export, and actions are distinct permissions. |
| D09 | Runtime restrictions intersect with the static ceiling. They do not union purposes or add authority. |
| D10 | Effect service keys enforce developer-facing separation; request-scoped wrappers enforce runtime checks. Installing a Layer once is not authorization for every row forever. |
| D11 | Classification describes data, not access rights. Legal basis, purpose, record context, identifiability, and handling requirements are separate facets. |
| D12 | Unknown/unclassified is not public. Redaction, hashing, aggregation, encryption, and tokenization do not automatically remove personal-data lineage. |
| D13 | Static lineage describes possible flows; validated runtime receipts describe observed flows. Neither alone proves universal flow completeness. |
| D14 | The registry supplies immutable contracts and a derived catalog. Grants, deployed instances, health, and runtime evidence are separate authoritative records with their own provenance. |
| D15 | A dependency request does not grant access. The callee's protected repository approves the edge; runtime activation verifies matching approved artifacts. |
| D16 | Workload identity does not prove which function inside a shared process executed. Strict function isolation requires a separately attested execution boundary. |
| D17 | Signed snapshots require freshness, trust-root, revocation, and rollback protection. Signature validity alone does not establish current authority. |
| D18 | Semantic diff never invents live row counts, confirms legal compatibility, or declares arbitrary Rego changes wider/narrower without evidence. |
| D19 | Cross-language SDK support is certified per generator/protocol/language tuple, not advertised as every language automatically. Server-runtime portability remains Effect/TS initially. |
| D20 | Compliance evidence is scoped and conditional. Add `unknown`, `external evidence required`, and `coverage gap` states; do not infer safety from absence of telemetry. |
| D21 | A soft delete is not erasure; a retained keyed subject hash is usually still linkable and must receive its own access/retention controls. |
| D22 | New adapters must pass named capability profiles. A provider brand or SQL-compatible label is insufficient evidence of parity. |

The baseline already makes several of these corrections, including source direction, folder identity, reference-versus-record types, and the distinction between API preconditions and business conflicts. Preserve its HTTP `If-Match` handling: failed preconditions map to 412; missing required preconditions to 428. [B01 §§4–5, 12]

