// QuoteOrder as a js-module unit: the default implementation of @acme/pricing. The WASM
// component impl/quote-order.wasm implements the same interface; the linker binds one or the other.
import { Effect } from "effect";
import { defineFunction } from "@forgegraph/runtime";
import { quote, type QuoteOrderInput } from "./quote.js";

export const quoteOrder = defineFunction("@acme/pricing/_/QuoteOrder", (deps) => {
  const r = quote(deps.input as QuoteOrderInput);
  return r.ok ? Effect.succeed({ ...r.value }) : deps.fail(r.code, r.detail);
});
