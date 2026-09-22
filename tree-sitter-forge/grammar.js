// Editor syntax only. crates/forgegraph-syntax remains normative.
const comma = (rule) => seq(rule, repeat(seq(",", rule)));
const block = (rule) => seq("{", repeat(rule), "}");
module.exports = grammar({
  name: "forge",
  extras: ($) => [/\s/, ";", $.comment, $.doc_comment],
  word: ($) => $.identifier,
  conflicts: ($) => [[$.type_expression]],
  rules: {
    source_file: ($) => repeat($._declaration),
    _declaration: ($) =>
      seq(
        optional("export"),
        choice(
          $.module_declaration,
          $.import_declaration,
          $.enum_declaration,
          $.type_declaration,
          $.shape_declaration,
          $.facet_declaration,
          $.resource_declaration,
          $.blob_declaration,
          $.function_declaration,
          $.channel_declaration,
          $.source_declaration,
          $.subscription_declaration,
          $.workflow_declaration,
          $.work_queue_declaration,
          $.view_declaration,
          $.projection_declaration,
          $.cache_declaration,
          $.purpose_declaration,
          $.data_class_declaration,
        ),
      ),
    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*(-[A-Za-z][A-Za-z0-9_]*)*/,
    qualified_name: ($) => seq($.identifier, repeat(seq(".", $.identifier))),
    comment: (_) => token(seq("//", /[^\n]*/)),
    doc_comment: (_) => token(prec(1, seq("///", /[^\n]*/))),
    string: (_) => /"([^"\\\n]|\\.)*"/,
    integer: (_) => /[0-9]+/,
    decimal: (_) => /[0-9]+\.[0-9]+/,
    duration: (_) => /[0-9]+(ms|s|m|h|d)/,
    percent: (_) => /[0-9]+(\.[0-9]+)?%/,
    boolean: (_) => choice("true", "false"),
    null: (_) => "null",
    _literal: ($) =>
      choice(
        $.string,
        $.integer,
        $.decimal,
        $.duration,
        $.percent,
        $.boolean,
        $.null,
      ),
    module_declaration: ($) => seq("module", field("name", $.qualified_name)),
    import_declaration: ($) =>
      seq(
        "import",
        field("name", $.qualified_name),
        optional(seq("as", field("alias", $.identifier))),
      ),
    enum_declaration: ($) =>
      seq("enum", field("name", $.identifier), block($.enum_member)),
    enum_member: ($) =>
      seq(field("name", $.identifier), optional(seq("=", $.string))),
    type_declaration: ($) =>
      seq(
        "type",
        field("name", $.identifier),
        "=",
        $.type_expression,
        repeat($.decorator),
      ),
    facet_declaration: $ => seq('facet', field('name', $.identifier), block($.field_declaration)),
    shape_declaration: ($) =>
      seq("shape", field("name", $.identifier), block($.field_declaration)),
    type_expression: ($) =>
      seq($.type_reference, optional("?"), repeat($.refinement)),
    type_reference: ($) =>
      prec.right(
        seq(field("name", $.qualified_name), optional($.type_arguments)),
      ),
    type_arguments: ($) =>
      seq("<", comma(choice($.type_expression, $.integer, $.string)), ">"),
    refinement: ($) =>
      choice(
        "trim",
        "uppercase",
        "lowercase",
        seq("pattern", $.string),
        seq(
          "length",
          choice(seq($.integer, "..", $.integer), seq($._compare, $.integer)),
        ),
        seq(
          $._compare,
          choice(
            $._literal,
            seq("-", choice($.integer, $.decimal)),
            $.qualified_name,
          ),
        ),
      ),
    _compare: (_) => choice("<", "<=", ">", ">=", "==", "!="),
    _field_name: ($) =>
      choice(
        $.identifier,
        ...[
          "unique",
          "find",
          "list",
          "rules",
          "lifecycle",
          "capability",
          "for",
        ].map((k) => alias(k, $.identifier)),
      ),
    field_declaration: ($) =>
      prec.right(
        seq(
          field("name", $._field_name),
          choice(
            seq(":", $.type_expression, optional(seq("=", $._expression))),
            seq(":=", $._expression),
          ),
          repeat($.decorator),
        ),
      ),
    decorator: ($) =>
      prec.right(
        seq(
          "@",
          field("name", $.identifier),
          optional(seq("(", optional(comma($.decorator_argument)), ")")),
        ),
      ),
    decorator_argument: ($) =>
      seq(
        optional(seq(field("key", $.identifier), ":")),
        choice($._literal, $.qualified_name, $.list_literal),
      ),
    list_literal: ($) =>
      seq("[", optional(comma(choice($._literal, $.qualified_name))), "]"),
    resource_declaration: ($) =>
      seq(
        "resource",
        field("name", $.identifier),
        repeat($.decorator),
        block($._resource_item),
      ),
    _resource_item: ($) =>
      choice(
        $.field_declaration,
        $.unique_declaration,
        $.find_declaration,
        $.list_declaration,
        $.rules_block,
        $.lifecycle_block,
        $.capability_declaration,
        $.purpose_binding,
      ),
    field_list: ($) => comma($.identifier),
    unique_declaration: ($) =>
      prec.right(
        seq("unique", $.field_list, optional(seq("within", $.field_list)), optional(seq("while", $.identifier, "in", "[", comma($.identifier), "]"))),
      ),
    find_declaration: ($) => seq("find", "by", $.field_list),
    list_declaration: ($) =>
      prec.right(seq(choice("list",seq("search",$.identifier)), "by", $.field_list, optional($.order_clause))),
    order_clause: ($) => seq("order", "by", comma($.order_key)),
    order_key: ($) =>
      prec.right(seq($.identifier, optional(choice("asc", "desc")))),
    rules_block: ($) => seq("rules", block($._expression)),
    lifecycle_block: ($) =>
      seq(
        "lifecycle",
        field("name", $.identifier),
        block(choice($.initial_state, $.terminal_state, $.transition)),
      ),
    initial_state: ($) => seq("initial", $.identifier),
    terminal_state: ($) => seq("terminal", $.identifier),
    transition: ($) =>
      prec.right(
        seq(
          field("name", $.identifier),
          ":",
          $.identifier,
          repeat(seq("|", $.identifier)),
          "->",
          $.identifier,
          optional(seq("input", block($.field_declaration))),
        ),
      ),
    capability_declaration: ($) =>
      seq("capability", field("name", $.identifier), block($.capability_item)),
    capability_item: ($) =>
      choice(
        seq("includes", $.identifier),
        seq(
          optional("deny"),
          choice("read", "update", "create", "filter", "order", "actions"),
          block($.qualified_name),
        ),
      ),
    purpose_binding: ($) =>
      seq("for", $.qualified_name, block(seq("use", $.identifier))),
    purpose_declaration: ($) =>
      prec.right(
        seq(
          "purpose",
          field("name", $.identifier),
          optional(seq("extends", $.qualified_name)),
        ),
      ),
    data_class_declaration: ($) =>
      seq(
        "dataClass",
        field("name", $.identifier),
        "extends",
        $.qualified_name,
      ),
    blob_declaration: ($) =>
      seq(
        "blob",
        field("name", $.identifier),
        repeat($.decorator),
        block(choice($._resource_item, $.content_block)),
      ),
    content_block: ($) =>
      seq(
        "content",
        block(
          choice(seq("mediaTypes", $.list_literal), seq("maxBytes", $.integer)),
        ),
      ),
    cache_declaration: ($) =>
      seq(
        "cache",
        field("name", $.identifier),
        repeat($.decorator),
        block(
          choice(
            seq("key", $.field_declaration),
            seq(choice("loader", "freshUntil", "staleUntil"), $._expression),
          ),
        ),
      ),
    view_declaration: ($) =>
      seq(
        "view",
        field("name", $.identifier),
        repeat($.decorator),
        block($._query_item),
      ),
    projection_declaration: ($) =>
      seq(
        "projection",
        field("name", $.identifier),
        repeat($.decorator),
        block($._query_item),
      ),
    _query_item: ($) =>
      choice(
        seq("from", $.qualified_name),
        seq("where", $._expression),
        seq(choice("by", "fields"), $.field_list),
        $.order_clause,
        $.aggregate,
      ),
    aggregate: ($) =>
      prec.right(
        seq(
          choice("count", "sum", "min", "max", "latest", "exists", "notExists"),
          $.identifier,
          optional(seq("as", $.identifier)),
          optional(seq("where", $._expression)),
        ),
      ),
    function_declaration: ($) =>
      seq(
        "function",
        field("name", $.identifier),
        repeat($.decorator),
        block($._function_item),
      ),
    _function_item: ($) =>
      choice(
        seq(choice("input", "output"), $.type_reference),
        seq("purpose", $.qualified_name),
        $.uses_block,
        $.sends_block,
        $.errors_block,
        $.slo_block,
      ),
    uses_block: ($) => seq("uses", block($.use_declaration)),
    use_declaration: ($) =>
      prec.right(
        seq(
          $.qualified_name,
          optional(choice("read", "write", "create", "delete")),
          optional(seq("for", $.qualified_name)),
        ),
      ),
    sends_block: ($) =>
      seq("sends", block(seq($.identifier, "to", $.qualified_name))),
    errors_block: ($) => seq("errors", block($.identifier)),
    slo_block: ($) =>
      seq(
        "slo",
        block(
          choice(
            seq("availability", $.percent, "over", $.duration),
            seq("latency", $.percent, "<=", $.duration, "over", $.duration),
          ),
        ),
      ),
    channel_declaration: ($) =>
      seq(
        "channel",
        field("name", $.identifier),
        optional(seq("from", $.qualified_name)),
        repeat($.decorator),
        block(
          choice(
            seq("distribution", choice("broadcast", "work")),
            seq("delivery", "at-least-once"),
            "send-only",
            "recv-only",
            $.message_declaration,
          ),
        ),
      ),
    message_declaration: ($) =>
      seq("message", field("name", $.identifier), block($.field_declaration)),
    subscription_declaration: ($) =>
      seq("on", $.qualified_name, "->", $.qualified_name),
    source_declaration: ($) =>
      seq(
        "source",
        field("name", $.identifier),
        repeat($.decorator),
        block(
          choice(
            seq(choice("cron", "timezone"), $.string),
            seq("->", $.qualified_name),
          ),
        ),
      ),
    work_queue_declaration: ($) => seq("workQueue", field("name", $.identifier), "{", repeat(choice(seq("execute",$.qualified_name),seq("lease",$.duration),seq(choice("retry","capacity","runners"),$.integer))), "}"),
    workflow_declaration: ($) =>
      seq(
        "workflow",
        field("name", $.identifier),
        repeat($.decorator),
        block(
          choice(
            seq(choice("input", "output"), $.type_reference),
            seq("version", $.integer),
            $.errors_block,
            $._workflow_step,
          ),
        ),
      ),
    _workflow_step: ($) =>
      choice(
        $.step_declaration,
        $.choice,
        $.parallel,
        $.return_statement,
        $.fail_statement,
      ),
    step_declaration: ($) =>
      seq(
        "step",
        field("name", $.identifier),
        "=",
        choice($.step_map, $.step_call, seq("sleep", $.duration), $.step_wait),
      ),
    step_map: ($) => seq("map", $.identifier, "in", $._expression, "concurrency", $.integer, "{", $.step_call, "}"),
    step_call: ($) =>
      prec.right(
        seq(
          field("function", $.qualified_name),
          "(",
          optional(comma($.named_argument)),
          ")",
          repeat(
            seq(
              "catch",
              $.identifier,
              "->",
              choice($.return_statement, $.fail_statement),
            ),
          ),
        ),
      ),
    named_argument: ($) => seq(field("name", $.identifier), ":", $._expression),
    step_wait: ($) =>
      prec.right(
        seq(
          "wait",
          $.qualified_name,
          optional(seq("where", $.identifier, "==", $._expression)),
          optional(
            seq(
              "timeout",
              $.duration,
              "->",
              choice($.return_statement, $.fail_statement),
            ),
          ),
        ),
      ),
    choice: ($) =>
      prec.right(
        seq(
          "if",
          $._expression,
          block($._workflow_step),
          optional(seq("else", block($._workflow_step))),
        ),
      ),
    parallel: ($) => seq("parallel", block($._workflow_step)),
    return_statement: ($) => seq("return", $._expression),
    fail_statement: ($) => seq("fail", $.identifier),
    _expression: ($) =>
      choice(
        $._literal,
        $.qualified_name,
        $.call_expression,
        $.binary_expression,
        $.unary_expression,
        $.parenthesized_expression,
      ),
    call_expression: ($) =>
      prec(
        8,
        seq(
          field("function", $.qualified_name),
          "(",
          optional(comma($._expression)),
          ")",
        ),
      ),
    parenthesized_expression: ($) => seq("(", $._expression, ")"),
    unary_expression: ($) => prec(7, seq(choice("-", "!"), $._expression)),
    binary_expression: ($) =>
      choice(
        ...[
          [1, ["||"]],
          [2, ["&&"]],
          [3, ["==", "!=", "<", "<=", ">", ">="]],
          [4, ["+", "-"]],
          [5, ["*", "/"]],
        ].map(([p, ops]) =>
          prec.left(
            p,
            seq(
              $._expression,
              ops.length === 1 ? ops[0] : choice(...ops),
              $._expression,
            ),
          ),
        ),
      ),
  },
});
