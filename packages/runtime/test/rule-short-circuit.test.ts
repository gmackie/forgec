import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { evalExpr } from "../src/decode.js";
import { Model, type AppBundle, type Expr } from "../src/model.js";
const model = new Model(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../conformance/fixtures/acme.app.json'), 'utf8')) as AppBundle);
const resource = model.resource('@acme/commerce/_/Customer');
const name = (value: string): Expr => ({kind:'name',path:[value]});
const literal = (value: boolean): Expr => ({kind:'literal',literal:{type:'bool',value}});
const unsafe: Expr = {kind:'binary',op:'+',lhs:name('nullable'),rhs:{kind:'literal',literal:{type:'int',value:'1'}}};
it('nullable guards short circuit OR and AND before arithmetic on absent values',()=>{
  expect(evalExpr(model,resource,{kind:'binary',op:'||',lhs:literal(true),rhs:unsafe},{nullable:null})).toBe(true);
  expect(evalExpr(model,resource,{kind:'binary',op:'&&',lhs:literal(false),rhs:unsafe},{nullable:null})).toBe(false);
});
it('necessary right hand branches still evaluate rather than suppress invalid arithmetic',()=>{
  expect(()=>evalExpr(model,resource,{kind:'binary',op:'||',lhs:literal(false),rhs:unsafe},{nullable:null})).toThrow();
  expect(()=>evalExpr(model,resource,{kind:'binary',op:'&&',lhs:literal(true),rhs:unsafe},{nullable:null})).toThrow();
});
