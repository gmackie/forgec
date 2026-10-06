//! ForgeGraph's canonical JSON, byte for byte.
//!
//! ForgeGraph recomputes every fingerprint on ingest as
//! `sha256(JSON.stringify(sortKeys(value)))`, so the bytes hashed here must
//! be exactly what V8 would produce for the same value:
//!
//! - object keys sorted by UTF-16 code units (`Array.prototype.sort`), then
//!   re-enumerated the way a JS object does: array-index keys (`"0"`, `"10"`)
//!   first in numeric order, every other key in insertion order;
//! - numbers formatted by `Number.prototype.toString` (`1` not `1.0`,
//!   `1e+21`, `1e-7`, integers beyond 2^53 rounded to the nearest double);
//! - strings escaped by `JSON.stringify` (only `"`, `\` and controls).
//!
//! `serde_json` differs on all three, so this serializer is separate.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

/// `canonicalJson` from `@forgegraph/contract`: sorted keys, no whitespace.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// `sha256:<hex>` of the canonical JSON form of `value`.
pub fn fingerprint(value: &Value) -> String {
    let digest = Sha256::digest(canonical_json(value).as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

/// `a < b` as JavaScript compares strings: by UTF-16 code units.
pub fn js_string_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number_of(n)),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, key) in js_key_order(map.keys()).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, &map[key]);
            }
            out.push('}');
        }
    }
}

/// The order `JSON.stringify` emits the keys of an object that `sortKeys`
/// rebuilt in sorted order.
fn js_key_order<'a>(keys: impl Iterator<Item = &'a String>) -> Vec<&'a str> {
    let mut sorted: Vec<&str> = keys.map(String::as_str).collect();
    sorted.sort_by(|a, b| js_string_cmp(a, b));
    let (mut indices, rest): (Vec<&str>, Vec<&str>) =
        sorted.into_iter().partition(|k| array_index(k).is_some());
    indices.sort_by_key(|k| array_index(k));
    indices.extend(rest);
    indices
}

/// A canonical array index (`0` ..= 2^32 - 2, no leading zeros), which JS
/// objects enumerate before every other key.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// 2^53: the largest integer below which every integer is a double.
const MAX_EXACT: u64 = 1 << 53;

fn js_number_of(n: &serde_json::Number) -> String {
    if let Some(u) = n.as_u64() {
        if u <= MAX_EXACT {
            return u.to_string();
        }
        return js_number(u as f64);
    }
    if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= MAX_EXACT {
            return i.to_string();
        }
        return js_number(i as f64);
    }
    js_number(n.as_f64().unwrap_or(f64::NAN))
}

/// `Number.prototype.toString()` for a double (ECMA-262 Number::toString).
pub fn js_number(x: f64) -> String {
    if x.is_nan() || x.is_infinite() {
        // JSON.stringify writes non-finite numbers as null.
        return "null".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", js_number(-x));
    }
    // Rust's `{:e}` is the shortest round-tripping digit string, the same
    // digits ECMA-262 requires: `d[.ddd]e<exp>`.
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci
        .split_once('e')
        .expect("LowerExp always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("LowerExp exponent is an integer") + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_format_like_javascript() {
        // Expected strings are what `String(x)` prints in Node 24.
        for (x, js) in [
            (1.0, "1"),
            (0.999, "0.999"),
            (0.1 + 0.2, "0.30000000000000004"),
            (99.9 / 100.0, "0.9990000000000001"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.0000015, "0.0000015"),
            (-0.0, "0"),
            (-2.5, "-2.5"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (2f64.powi(53), "9007199254740992"),
            (f64::NAN, "null"),
        ] {
            assert_eq!(js_number(x), js, "{x:?}");
        }
    }

    #[test]
    fn integers_beyond_two_to_the_53_round_like_json_parse() {
        // JSON.stringify(JSON.parse("9223372036854775807")) in Node 24.
        assert_eq!(canonical_json(&json!(i64::MAX)), "9223372036854776000");
        assert_eq!(canonical_json(&json!(u64::MAX)), "18446744073709552000");
        assert_eq!(
            canonical_json(&json!(-9007199254740991i64)),
            "-9007199254740991"
        );
        assert_eq!(
            canonical_json(&json!(9007199254740993u64)),
            "9007199254740992"
        );
    }

    #[test]
    fn keys_sort_by_utf16_with_array_indices_first() {
        let v = json!({ "b": 1, "a": { "z": [], "y": null }, "10": 0, "2": 0, "02": 0, "A": 0 });
        assert_eq!(
            canonical_json(&v),
            r#"{"2":0,"10":0,"02":0,"A":0,"a":{"y":null,"z":[]},"b":1}"#
        );
        // U+FF61 sorts after U+1F600 by code point but before it by UTF-16 unit.
        let v = json!({ "\u{1F600}": 1, "\u{FF61}": 2 });
        assert_eq!(canonical_json(&v), "{\"\u{1F600}\":1,\"\u{FF61}\":2}");
    }

    #[test]
    fn strings_escape_like_json_stringify() {
        let v = json!("q\" b\\ \u{08}\u{0c}\n\r\t \u{01} \u{1f} \u{7f} / é \u{2028}");
        assert_eq!(
            canonical_json(&v),
            "\"q\\\" b\\\\ \\b\\f\\n\\r\\t \\u0001 \\u001f \u{7f} / é \u{2028}\""
        );
    }

    #[test]
    fn fingerprint_matches_node_crypto() {
        // node -e 'const c=require("crypto");console.log(c.createHash("sha256")
        //   .update(JSON.stringify({a:[1,0.5,"x"],b:null})).digest("hex"))'
        assert_eq!(
            fingerprint(&json!({ "b": null, "a": [1.0, 0.5, "x"] })),
            "sha256:5e18ff3d53bdff48fa32bb6108a2cf1de617f57d4a9729af442d67d27da67b7a"
        );
    }
}
