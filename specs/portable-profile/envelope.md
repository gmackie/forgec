# Operating envelope (portable-v1 defaults)

| limit | default | notes |
| --- | --- | --- |
| normalized record size | 64 KiB | physical side records checked separately |
| synchronous body | 1 MiB | larger imports/exports are jobs backed by blobs |
| inline channel payload | 64 KiB | larger = blob reference |
| list page | default 50, max 100 | nested expansion bounded |
| bounded working set | 1,000 records | beyond: projection/job |
| atomic changeset | ≤ 10 logical mutations, further limited by compiled physical budget | preview reports the bound |
| D1 | 100 bound parameters / statement, 100 columns / table | statements sized against actual bindings |
| DynamoDB | 400 KB / item, 100 actions & 4 MB / transaction | generated side items count |

A portable build validates the compiled plan for every declared target against
these limits and the target capability manifest; violations are compile
errors with a source location and an alternative.
