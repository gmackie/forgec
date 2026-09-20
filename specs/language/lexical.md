# Lexical structure

Source files are UTF-8, extension `.forge`. Lines end with LF; CRLF is
accepted and normalized by `forge fmt`. A BOM is rejected with a diagnostic.

## Trivia

- Whitespace: space, tab, newline. Newlines are **not** significant except that
  a newline terminates a declaration-body item where the grammar says `NL`
  (see grammar: items inside `{ }` blocks are newline- or `;`-separated).
- Line comments: `//` to end of line. Doc comments: `///` attach to the next
  declaration or member and are preserved in IR as documentation.
- Block comments are not supported (keeps the lossless tree simple).

## Tokens

| token | pattern | notes |
| --- | --- | --- |
| `IDENT` | `[A-Za-z_][A-Za-z0-9_]*` | case-sensitive |
| `INT` | `[0-9]+` | no leading `+`; `_` separators not allowed in v1 |
| `DECIMAL` | `[0-9]+ '.' [0-9]+` | exact; no exponent |
| `PERCENT` | `INT ('.' [0-9]+)? '%'` | only valid in `slo` blocks |
| `DURATION` | `INT ('ms' \| 's' \| 'm' \| 'h' \| 'd')` | fixed elapsed-time units only |
| `STRING` | `'"' ( [^"\\\n] \| '\\' ["\\nt] )* '"'` | no interpolation |
| `RANGE` | `..` | inclusive range in constraints |
| punctuation | `{ } ( ) [ ] < > , : ; . = @ -> \| := == != <= >= + - * /` | |

Keywords are **contextual**: `resource`, `enum`, `type`, `shape`, `function`,
`workflow`, `channel`, `source`, `blob`, `cache`, `view`, `projection`,
`module`, `import`, `export`, `from`, `uses`, `sends`, `errors`, `input`,
`output`, `rules`, `lifecycle`, `initial`, `terminal`, `find`, `list`, `by`,
`order`, `asc`, `desc`, `unique`, `within`, `message`, `distribution`,
`delivery`, `broadcast`, `work`, `on`, `cron`, `timezone`, `slo`,
`availability`, `latency`, `over`, `send-only`, `recv-only`, `at-least-once`,
`true`, `false`, `null`. They are recognized by position; a field may be named
`status` or `order`. A field named exactly like a construct keyword (`resource`)
is rejected with a diagnostic rather than parsed ambiguously.

Builtin scalar type names (`id`, `text`, `integer`, `decimal`, `money`,
`boolean`, `date`, `datetime`, `localTime`, `duration`, `email`, `timezone`,
`countryCode`, `url`, `json`) are ordinary identifiers resolved in the prelude
scope; user declarations may not shadow them.
