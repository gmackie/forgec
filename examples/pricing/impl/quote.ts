// QuoteOrder's arithmetic as plain TypeScript: the JS twin of impl/quote-order-rs/src/lib.rs.
// Integer cents in BigInt, half-up rounding, and the Rust unit's i128 overflow points, so the two
// implementations agree on every input, failures and details included.

export type CustomerTier = "standard" | "gold" | "enterprise";
export interface QuoteLine {
  sku: string;
  quantity: number;
  unitPrice: string;
}
export interface QuoteOrderInput {
  lines: QuoteLine[];
  tier: CustomerTier;
  taxRateBasisPoints: number;
  shipping?: string | null;
}
export interface OrderQuote {
  subtotal: string;
  discount: string;
  tax: string;
  shipping: string;
  total: string;
  lineCount: number;
  topSku: string | null;
}
export type QuoteResult = { ok: true; value: OrderQuote } | { ok: false; code: "EmptyOrder" | "InvalidTaxRate" | "QuoteTooLarge"; detail: string };

/** 100,000,000.00 in cents. */
const LIMIT = 10_000_000_000n;
const I128_MAX = (1n << 127n) - 1n;
const DISCOUNT_BPS: Record<CustomerTier, bigint> = { standard: 0n, gold: 500n, enterprise: 1_000n };

export class Overflow extends Error {}
export const checked = (v: bigint) => {
  if (v > I128_MAX || v < -I128_MAX - 1n) throw new Overflow();
  return v;
};
const halfUp = (scaled: bigint) => (scaled + 5_000n) / 10_000n;

/** `"12"`, `"12.5"`, `"12.50"` -> 1250n. Decoded input never violates this, so a violation is a host bug. */
export function cents(s: string): bigint {
  const [whole = "", frac = "", ...rest] = s.split(".");
  if (rest.length || whole === "" || whole.length > 30 || frac.length > 2 || !/^\d+$/.test(whole + frac + "0")) throw new Error(`malformed amount ${s}`);
  return BigInt(whole + frac.padEnd(2, "0"));
}

export function money(c: bigint): string {
  const r = c % 100n;
  return `${c / 100n}.${r < 10n ? "0" : ""}${r}`;
}

export function quote(input: QuoteOrderInput): QuoteResult {
  if (input.lines.length === 0) return { ok: false, code: "EmptyOrder", detail: "a quote needs at least one line" };
  if (input.taxRateBasisPoints > 10_000) return { ok: false, code: "InvalidTaxRate", detail: `tax rate ${input.taxRateBasisPoints} basis points exceeds 10000` };
  try {
    let subtotal = 0n;
    let top: { amount: bigint; sku: string } | null = null;
    for (const line of input.lines) {
      const amount = checked(BigInt(line.quantity) * cents(line.unitPrice));
      subtotal = checked(subtotal + amount);
      if (amount > 0n && (top === null || amount > top.amount)) top = { amount, sku: line.sku };
    }
    const discount = halfUp(checked(subtotal * DISCOUNT_BPS[input.tier]));
    const taxable = subtotal - discount;
    const tax = halfUp(checked(taxable * BigInt(input.taxRateBasisPoints)));
    const shipping = input.shipping == null ? 0n : cents(input.shipping);
    const total = taxable + tax + shipping;
    if (total > LIMIT) return { ok: false, code: "QuoteTooLarge", detail: `total ${money(total)} exceeds 100000000.00` };
    return {
      ok: true,
      value: { subtotal: money(subtotal), discount: money(discount), tax: money(tax), shipping: money(shipping), total: money(total), lineCount: input.lines.length, topSku: top?.sku ?? null },
    };
  } catch (e) {
    if (e instanceof Overflow) return { ok: false, code: "QuoteTooLarge", detail: "line totals overflow" };
    throw e;
  }
}
