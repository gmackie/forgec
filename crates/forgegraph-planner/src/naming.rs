//! Physical naming. Stable, reserved-word safe, and identical on both targets.

const RESERVED: &[&str] = &[
    "order",
    "user",
    "group",
    "table",
    "index",
    "select",
    "from",
    "to",
    "where",
    "key",
    "value",
    "values",
    "set",
    "update",
    "delete",
    "insert",
    "into",
    "default",
    "check",
    "constraint",
    "primary",
    "references",
    "transaction",
    "limit",
    "offset",
    "by",
    "in",
    "is",
    "not",
    "null",
    "and",
    "or",
    "as",
    "on",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "case",
    "when",
    "then",
    "else",
    "end",
    "status",
    "version",
];

pub fn snake(name: &str) -> String {
    let mut s = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                s.push('_');
            }
            s.push(c.to_ascii_lowercase());
        } else {
            s.push(c);
        }
    }
    s
}

/// URL path segment for a declaration name (`PendingOrders` -> `pending-orders`).
pub fn kebab(name: &str) -> String {
    snake(name).replace('_', "-")
}

/// Table name for a resource.
pub fn table(resource_name: &str) -> String {
    let s = snake(resource_name);
    if RESERVED.contains(&s.as_str()) {
        format!("{s}_")
    } else {
        s
    }
}

/// Column name for a field. Synthesized system columns keep their names.
pub fn column(field: &str) -> String {
    let s = snake(field);
    if RESERVED.contains(&s.as_str()) && !matches!(s.as_str(), "status" | "version") {
        format!("{s}_")
    } else {
        s
    }
}

pub fn wire(name: &str) -> String {
    snake(name)
}
