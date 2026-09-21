# @forgegraph/governance

Subject rights, retention and recovery evidence (M19). The suppression ledger itself lives in
`@forgegraph/runtime` (`Suppression`, consulted by every commit and by the portability import).

| entry | what |
|---|---|
| `planDisposition` | Subject inventory (runtime `admin.subjects.locate`) + data semantics + lineage → reviewable plan: erase/restrict/export items with the personal fields touched, preserved other subjects and holds, unknowns (unmodeled egress, sinks without an adapter), external obligations; verdict `complete` only with no unknowns and nothing outstanding. |
| `RightsExecutor` | Durable job (`_forge/rights-job`) run in chunks with per-chunk re-authorization; revocation stops disclosure (no further chunks, no download URL, staged artifacts disposed per retention); erasure scrubs personal fields, soft-deletes the subject's record, deletes sealed blobs and writes the suppression ledger; external acks `requested → accepted → confirmed` (confirmation needs a reference; acceptance is never verified). |
| `recoveryEvidence` / `retentionVisible` | RPO/RTO only from a successful restore drill inside the evidence window (otherwise `external-evidence-required`/`stale`); items past retention are invisible before cleanup. |
| `controlPack` / `evidenceReport` / `exportOscal` / `assertCompliance` | Technical control mappings with sources, applicability facts, measured/attested/unknown states; the report leads with assumptions, review requirements and stale evidence; bounded OSCAL component definition; compliance is never asserted by the package. |
