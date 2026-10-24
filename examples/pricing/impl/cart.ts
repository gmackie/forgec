// PriceCart's logic as TypeScript (FORG-36): the JS twin of impl/price-cart-rs/src/lib.rs. It reads
// every item's product through a capability, so it is written against an Effect-returning `get`
// and `fail`: the unit passes the runtime's resource handle and `deps.fail`, a test can pass an
// in-memory catalog. A handle failure (NotFound, ...) propagates unchanged, as in the Rust unit.
import { Effect } from "effect";
import { cents, checked, money, Overflow } from "./quote.js";

export interface CartItem {
  product: string;
  quantity: number;
}
export interface PriceCartInput {
  items: CartItem[];
}
export interface Product {
  id: string;
  sku: string;
  unitPrice: string;
  active: boolean;
}
export interface CartLine {
  sku: string;
  quantity: number;
  amount: string;
}
export interface CartPrice {
  lines: CartLine[];
  subtotal: string;
}
export type CartError = "CartTooLarge" | "EmptyCart" | "InactiveProduct";

export function priceCart<E>(input: PriceCartInput, get: (id: string) => Effect.Effect<Product, E>, fail: (code: CartError, detail: string) => Effect.Effect<never, E>): Effect.Effect<CartPrice, E> {
  return Effect.gen(function* () {
    if (input.items.length === 0) return yield* fail("EmptyCart", "a cart needs at least one item");
    const lines: CartLine[] = [];
    let subtotal = 0n;
    for (const item of input.items) {
      const product = yield* get(item.product);
      if (!product.active) return yield* fail("InactiveProduct", `product ${product.sku} is not active`);
      let amount: bigint;
      try {
        amount = checked(BigInt(item.quantity) * cents(product.unitPrice));
        subtotal = checked(subtotal + amount);
      } catch (e) {
        if (e instanceof Overflow) return yield* fail("CartTooLarge", "line totals overflow");
        throw e;
      }
      lines.push({ sku: product.sku, quantity: item.quantity, amount: money(amount) });
    }
    return { lines, subtotal: money(subtotal) };
  });
}

export type CartResult = { ok: true; value: CartPrice } | { ok: false; code: string; detail?: string };

/** The logic run directly over an in-memory catalog: the reference a differential test checks units against. */
export function priceCartIn(input: PriceCartInput, catalog: ReadonlyMap<string, Product>): CartResult {
  type F = { code: string; detail?: string };
  const get = (id: string): Effect.Effect<Product, F> => {
    const p = catalog.get(id);
    return p ? Effect.succeed(p) : Effect.fail({ code: "NotFound", detail: `Product ${id} does not exist` });
  };
  return Effect.runSync(
    Effect.match(
      priceCart(input, get, (code, detail): Effect.Effect<never, F> => Effect.fail({ code, detail })),
      { onFailure: (e): CartResult => ({ ok: false, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) }), onSuccess: (value): CartResult => ({ ok: true, value }) },
    ),
  );
}
