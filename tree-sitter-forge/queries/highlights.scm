(comment) @comment
(doc_comment) @comment.documentation
(string) @string
(integer) @number
(decimal) @number.float
(duration) @number
(percent) @number
(boolean) @boolean
(null) @constant.builtin
(identifier) @variable
(type_reference (qualified_name) @type)
(decorator name: (identifier) @attribute)
(field_declaration name: (identifier) @variable.member)
(enum_member name: (identifier) @constant)
(transition name: (identifier) @function.method)
(initial_state (identifier) @constant)
(terminal_state (identifier) @constant)
(named_argument name: (identifier) @variable.parameter)
(call_expression function: (qualified_name) @function.call)
(step_call function: (qualified_name) @function.call)
[(resource_declaration name: (identifier) @type)
 (blob_declaration name: (identifier) @type)
 (shape_declaration name: (identifier) @type)
 (enum_declaration name: (identifier) @type)
 (type_declaration name: (identifier) @type)
 (channel_declaration name: (identifier) @type)
 (message_declaration name: (identifier) @type)
 (view_declaration name: (identifier) @type)
 (projection_declaration name: (identifier) @type)
 (cache_declaration name: (identifier) @type)
 (purpose_declaration name: (identifier) @type)
 (data_class_declaration name: (identifier) @type)]
[(function_declaration name: (identifier) @function)
 (workflow_declaration name: (identifier) @function)
 (source_declaration name: (identifier) @function)
 (capability_declaration name: (identifier) @type)]
["export" "module" "import" "as" "enum" "type" "shape" "resource" "blob" "cache" "view" "projection" "function" "channel" "source" "workflow" "purpose" "dataClass" "extends" "on" "unique" "within" "find" "list" "by" "order" "asc" "desc" "rules" "lifecycle" "initial" "terminal" "input" "output" "capability" "includes" "deny" "read" "write" "update" "create" "delete" "filter" "actions" "for" "use" "uses" "sends" "to" "errors" "slo" "availability" "latency" "over" "distribution" "delivery" "broadcast" "work" "at-least-once" "send-only" "recv-only" "message" "cron" "timezone" "step" "sleep" "wait" "where" "timeout" "catch" "if" "else" "parallel" "return" "fail" "version" "from" "fields" "count" "sum" "min" "max" "key" "loader" "freshUntil" "staleUntil" "content" "mediaTypes" "maxBytes" "length" "pattern" "trim" "uppercase" "lowercase"] @keyword
["{" "}" "(" ")" "[" "]"] @punctuation.bracket
["," ":" "."] @punctuation.delimiter
["=" ":=" "->" "<" ">" "<=" ">=" "==" "!=" "&&" "||" "+" "-" "*" "/" "!" "?" "|" ".."] @operator

(facet_declaration name: (identifier) @type)
"facet" @keyword
