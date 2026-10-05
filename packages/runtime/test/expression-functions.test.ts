// #196: forgec compiles `hour := floor(at / 3600)`; the runtime must evaluate it.
import { expect, it } from "vitest";
import { evalExpr } from "../src/decode.js";
import type { Expr, Model, Resource } from "../src/model.js";

const scalar = (name: string) => ({ base: { kind: "scalar", name, args: [] }, optional: false, normalizers: [], constraints: [] });
const resource = {
  id: "w", name: "Window",
  fields: [
    { name: "at", type: scalar("datetime") },
    { name: "label", type: scalar("text") },
    { name: "remaining", type: scalar("integer") },
  ],
} as unknown as Resource;
const model = { enums: new Map(), resource: () => { throw new Error("no references"); } } as unknown as Model;
const name = (field: string): Expr => ({ kind: "name", path: [field] });
const int = (value: string): Expr => ({ kind: "literal", literal: { type: "int", value } } as unknown as Expr);
const div = (lhs: Expr, rhs: Expr): Expr => ({ kind: "binary", op: "/", lhs, rhs });
const floor = (arg: Expr): Expr => ({ kind: "call", callee: ["floor"], args: [arg] });
const evaluate = (e: Expr, rec: Record<string, unknown>) => evalExpr(model, resource, e, rec as never);

it("buckets a datetime by hour with floor(at / 3600)", () => {
  const at = "2026-10-04T22:15:00Z";
  expect(evaluate(floor(div(name("at"), int("3600"))), { at })).toBe(Math.floor(Date.parse(at) / 1000 / 3600));
  expect(evaluate(floor(div(name("at"), int("3600"))), { at: null })).toBeNull();
});

it("subtracts datetimes in seconds and only treats datetime fields as times", () => {
  const e: Expr = { kind: "binary", op: "-", lhs: name("at"), rhs: name("at") };
  expect(evaluate(e, { at: "2026-10-04T00:00:00Z" })).toBe(0);
  // A text field that happens to hold an ISO string is not reinterpreted as a time.
  expect(() => evaluate(div(name("label"), int("3600")), { label: "2026-10-04T00:00:00Z" })).toThrow();
});

it("floors numbers and rejects functions the compiler does not accept", () => {
  expect(evaluate(floor(name("remaining")), { remaining: 7 })).toBe(7);
  expect(() => evaluate({ kind: "call", callee: ["round"], args: [name("remaining")] }, { remaining: 1 })).toThrow(/not supported/);
});
