# Codecs, normalizers, constraints, and sort keys

Both implementations (Rust constant evaluation in the compiler, TypeScript at
runtime) must pass every vector in `vectors/`. Vector files are the contract;
prose here explains them.

## Vector file format

```json
{
  "codec": "text.normalize",
  "version": 1,
  "cases": [
    { "name": "trim-both", "params": { "normalizers": ["trim"] }, "input": "  a ", "expect": "a" },
    { "name": "reject-control", "params": {}, "input": "a", "error": "InvalidText" }
  ]
}
```

Exactly one result key per case: `expect` (canonical output), `error` (error
code), `expect_order` (with `input_list`: the inputs sorted by their encoded
keys), or `expect_distinct` (with `input_list`: all encodings differ).
`input_json` supplies raw JSON text when the distinction matters (`1.0` vs
`1`). `params` are codec-specific.

## Rules

### Text
- Input must be valid Unicode scalar values; normalized to **NFC** first.
- Normalizers run in declared order after NFC: `trim` (Unicode White_Space at
  both ends), `uppercase`/`lowercase` (full Unicode default case mapping, no
  locale). Case mapping is never applied to `email` local parts.
- `length` counts **Unicode scalar values** (code points) of the NFC-normalized
  text, not UTF-16 units, bytes, or grapheme clusters.
- Control characters other than `\t \n \r` are rejected (`InvalidText`).

### Integer
- Wire: JSON number that is an exact integer within `[-(2^53-1), 2^53-1]`.
  `1.0` and `1e3` are rejected (`InvalidInteger`); beyond range is `OutOfRange`.

### Decimal and money
- Wire: string `-?[0-9]+(\.[0-9]+)?`. Canonical output has exactly the
  declared scale, no redundant leading zeros, and `-0` normalizes to `0`.
- More fractional digits than the scale is `PrecisionExceeded` — never rounded.
- `money<CUR>` scale is the currency's minor unit (USD 2, JPY 0, KWD 3).
- Runtime representation: minor-unit integer within the safe range;
  overflow is `OutOfRange`.

### Date / datetime / localTime / duration
- `date`: `YYYY-MM-DD`, proleptic Gregorian, validated (no Feb 30).
- `datetime`: RFC 3339. Any offset accepted on input; output is canonical UTC
  with uppercase `Z` at the declared precision (`ms` default; `s` allowed).
  Input with finer precision than declared is `PrecisionExceeded`. Leap
  seconds are rejected.
- `localTime`: `HH:MM` or `HH:MM:SS`; canonical output always `HH:MM:SS`.
- `duration`: ISO 8601 with fixed units only (`PT90S`, `P2D`); calendar units
  (`P1M`, `P1Y`) are `InvalidDuration`.

### Enum
- Wire value = declared value or member name. Matching is exact and
  case-sensitive; member names are not accepted when a value is declared.

### Sort key codec (`sort.v1`)
Order-preserving string encodings so D1 (`BINARY` collation on UTF-8) and
DynamoDB (UTF-8 byte order on S keys) agree with Forge comparison:

| type | encoding |
| --- | --- |
| integer / decimal (as minor units) | 16 lowercase hex digits of `n + 2^63` |
| text | NFC text (binary order) |
| date, datetime (canonical) | the canonical string |
| boolean | `0` / `1` |
| null (optional) | empty component; sorts first |

### Identity codec (`identity.v1`)
Composite keys join components with `#`; inside a component `\` → `\\` and
`#` → `\#`. Decoding is unambiguous: `("a#b","c")` ≠ `("a","b#c")`.
Composite **sort** keys use the same escaping, so ordering of a text component
containing `#` or `\` is by escaped form — deterministic and identical on both
providers.
