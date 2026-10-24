//! QuoteOrder (examples/pricing) as a WASM component behind the WIT world forgec generates from
//! its DomainIR declaration. Same arithmetic as `impl/quote.ts`: integer cents, half-up rounding.
//! Inputs reach a unit already decoded against the declaration (money has at most two places,
//! quantities are >= 1), so a malformed amount is a host bug and traps.

wit_bindgen::generate!({ path: "wit", world: "unit" });

use forge::unit::types::CustomerTier;

/// 100,000,000.00 in cents.
const LIMIT: i128 = 10_000_000_000;

struct Unit;

impl Guest for Unit {
    fn run(input: QuoteOrderInput) -> Result<OrderQuote, Failure> {
        quote(input)
    }
}

export!(Unit);

fn quote(input: QuoteOrderInput) -> Result<OrderQuote, Failure> {
    if input.lines.is_empty() {
        return Err(Failure::EmptyOrder(Some(
            "a quote needs at least one line".into(),
        )));
    }
    if input.tax_rate_basis_points > 10_000 {
        let mut d = String::from("tax rate ");
        push_int(&mut d, input.tax_rate_basis_points as i128);
        d.push_str(" basis points exceeds 10000");
        return Err(Failure::InvalidTaxRate(Some(d)));
    }
    let too_large = || Failure::QuoteTooLarge(Some("line totals overflow".into()));
    let mut subtotal: i128 = 0;
    let mut top: Option<(i128, usize)> = None;
    for (i, line) in input.lines.iter().enumerate() {
        let amount = (line.quantity as i128)
            .checked_mul(cents(&line.unit_price))
            .ok_or_else(too_large)?;
        subtotal = subtotal.checked_add(amount).ok_or_else(too_large)?;
        if amount > 0 && top.is_none_or(|(best, _)| amount > best) {
            top = Some((amount, i));
        }
    }
    let discount_bps: i128 = match input.tier {
        CustomerTier::Standard => 0,
        CustomerTier::Gold => 500,
        CustomerTier::Enterprise => 1_000,
    };
    let discount = half_up(subtotal.checked_mul(discount_bps).ok_or_else(too_large)?);
    let taxable = subtotal - discount;
    let tax = half_up(
        taxable
            .checked_mul(input.tax_rate_basis_points as i128)
            .ok_or_else(too_large)?,
    );
    let shipping = input.shipping.as_deref().map_or(0, cents);
    let total = taxable + tax + shipping;
    if total > LIMIT {
        let mut d = String::from("total ");
        d.push_str(&money(total));
        d.push_str(" exceeds 100000000.00");
        return Err(Failure::QuoteTooLarge(Some(d)));
    }
    Ok(OrderQuote {
        subtotal: money(subtotal),
        discount: money(discount),
        tax: money(tax),
        shipping: money(shipping),
        total: money(total),
        line_count: input.lines.len() as i64,
        top_sku: top.map(|(_, i)| input.lines[i].sku.clone()),
    })
}

/// Basis points of a non-negative amount, rounded half-up to the cent.
fn half_up(scaled: i128) -> i128 {
    (scaled + 5_000) / 10_000
}

/// `"12"`, `"12.5"`, `"12.50"` -> 1250. At most two places and 30 digits.
fn cents(s: &str) -> i128 {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty() || whole.len() > 30 || frac.len() > 2 {
        std::process::abort();
    }
    let mut v: i128 = 0;
    for b in whole
        .bytes()
        .chain(frac.bytes())
        .chain("00"[frac.len()..].bytes())
    {
        if !b.is_ascii_digit() {
            std::process::abort();
        }
        v = v * 10 + (b - b'0') as i128;
    }
    v
}

fn money(c: i128) -> String {
    let mut s = String::new();
    push_int(&mut s, c / 100);
    s.push('.');
    let r = (c % 100) as u8;
    s.push((b'0' + r / 10) as char);
    s.push((b'0' + r % 10) as char);
    s
}

/// Decimal digits without `core::fmt`, which would add more than the rest of the unit.
fn push_int(s: &mut String, v: i128) {
    if v < 0 {
        s.push('-');
    }
    let mut digits = [0u8; 40];
    let (mut n, mut i) = (v.unsigned_abs(), digits.len());
    loop {
        i -= 1;
        digits[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    s.push_str(core::str::from_utf8(&digits[i..]).unwrap_or_default());
}
