// PriceCart as a js-module unit (FORG-36). The WASM component impl/price-cart.wasm implements the
// same interface; both read products through the unit's declared `Product read` capability.
import { Effect } from "effect";
import { defineFunction } from "@forgegraph/runtime";
import { priceCart, type PriceCartInput, type Product } from "./cart.js";

export const priceCartUnit = defineFunction("@acme/pricing/_/PriceCart", (deps) =>
  priceCart(
    deps.input as PriceCartInput,
    (id) => deps.resources["Product"]!.get(id).pipe(Effect.map((record) => record as unknown as Product)),
    deps.fail,
  ).pipe(Effect.map(({ lines, subtotal }) => ({ lines: lines.map((l) => ({ ...l })), subtotal }))),
);
