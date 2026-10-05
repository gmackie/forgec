//! Syntactic equivalence for business contracts, without algebraic rewriting or float rounding.
use crate::concept::ConceptIR;
use crate::concept_semantics::Contract;
use crate::ir::{Expr, Literal};

fn number(value: &str) -> Option<Literal> {
    let (negative, unsigned) = value
        .strip_prefix('-')
        .map_or((false, value), |v| (true, v));
    let unsigned = unsigned.strip_prefix('+').unwrap_or(unsigned);
    let (mantissa, exponent) = unsigned
        .split_once(['e', 'E'])
        .map_or(Some((unsigned, 0i64)), |(m, e)| Some((m, e.parse().ok()?)))?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Some(Literal::Int("0".into()));
    }
    let trimmed = digits.trim_end_matches('0');
    let exponent = exponent
        .checked_sub(i64::try_from(fraction.len()).ok()?)?
        .checked_add(i64::try_from(digits.len() - trimmed.len()).ok()?)?;
    let sign = if negative { "-" } else { "" };
    // Bound expansion independently of numeric magnitude; tiny exponents stay compact.
    if (0..=4096).contains(&exponent) {
        Some(Literal::Int(format!(
            "{sign}{trimmed}{}",
            "0".repeat(exponent as usize)
        )))
    } else if (-4096..0).contains(&exponent) {
        let point = trimmed.len() as i64 + exponent;
        let value = if point > 0 {
            let (a, b) = trimmed.split_at(point as usize);
            format!("{sign}{a}.{b}")
        } else {
            format!("{sign}0.{}{trimmed}", "0".repeat((-point) as usize))
        };
        Some(Literal::Decimal(value))
    } else {
        Some(Literal::Decimal(format!("{sign}{trimmed}e{exponent}")))
    }
}

fn expression(expr: &mut Expr) {
    match expr {
        Expr::Binary { op, lhs, rhs } => {
            *op = match op.as_str() {
                "and" => "&&",
                "or" => "||",
                other => other,
            }
            .into();
            expression(lhs);
            expression(rhs);
        }
        Expr::Unary { op, operand } => {
            if op == "not" {
                *op = "!".into();
            }
            expression(operand);
        }
        Expr::Call { args, .. } => {
            for arg in args {
                expression(arg);
            }
        }
        Expr::Literal { literal } => {
            if let Literal::Int(value) | Literal::Decimal(value) = literal
                && let Some(normalized) = number(value)
            {
                *literal = normalized;
            }
        }
        Expr::Name { .. } => {}
    }
}
impl Contract {
    pub fn canonical_json(&self) -> String {
        let mut canonical = self.clone();
        expression(&mut canonical.predicate);
        serde_json::to_string(&canonical).expect("contract serialization")
    }
    pub fn content_hash(&self) -> String {
        crate::ir::hash_hex(&self.canonical_json())
    }
}
impl ConceptIR {
    pub(crate) fn canonical_contracts(&self) -> Self {
        let mut canonical = self.clone();
        for contract in canonical.semantics.contracts.values_mut() {
            expression(&mut contract.predicate);
        }
        canonical
    }
}
