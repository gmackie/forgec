; Syntactic workflow bindings only. Cross-file resolution belongs to the LSP.
(workflow_declaration) @local.scope
(step_declaration name: (identifier) @local.definition)
(qualified_name . (identifier) @local.reference)
(step_map) @local.scope
(step_map . (identifier) @local.definition)
