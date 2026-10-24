//! PriceCart (examples/pricing) as a WASM component behind the WIT world forgec generates from its
//! DomainIR declaration (FORG-36). Same logic as `impl/cart.ts`. Unlike QuoteOrder it has a
//! capability: every item is read through the imported `resource-product-read` interface, a plain
//! synchronous call here. The host makes it asynchronous: jco's JSPI mode suspends this stack
//! while the JS host awaits the read, so the unit is written as if storage were local.

wit_bindgen::generate!({ path: "wit", world: "unit" });

use forge::unit::resource_product_read as products;
use forge::unit::types::CartLine;

struct Unit;

impl Guest for Unit {
    fn run(input: PriceCartInput) -> Result<CartPrice, Failure> {
        price(input)
    }
}

export!(Unit);

fn price(input: PriceCartInput) -> Result<CartPrice, Failure> {
    if input.items.is_empty() {
        return Err(Failure::EmptyCart(Some(
            "a cart needs at least one item".into(),
        )));
    }
    let too_large = || Failure::CartTooLarge(Some("line totals overflow".into()));
    let mut lines = Vec::with_capacity(input.items.len());
    let mut subtotal: i128 = 0;
    for item in input.items {
        // A handle failure (NotFound, Unavailable, ...) is the unit's failure, unchanged.
        let product = products::get(&item.product).map_err(Failure::Fault)?;
        if !product.active {
            let mut d = String::from("product ");
            d.push_str(&product.sku);
            d.push_str(" is not active");
            return Err(Failure::InactiveProduct(Some(d)));
        }
        let amount = (item.quantity as i128)
            .checked_mul(cents(&product.unit_price))
            .ok_or_else(too_large)?;
        subtotal = subtotal.checked_add(amount).ok_or_else(too_large)?;
        lines.push(CartLine {
            sku: product.sku,
            quantity: item.quantity,
            amount: money(amount),
        });
    }
    Ok(CartPrice {
        lines,
        subtotal: money(subtotal),
    })
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
