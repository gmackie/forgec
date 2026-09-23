import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { Model, type AppBundle, type Expr, type TypeSpec } from '../src/model.js';
import { decodeValue, evalExpr } from '../src/decode.js';
const model = new Model(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../conformance/fixtures/allocation-consumer/app.json'), 'utf8')) as AppBundle);
const resource = model.resource('@forgegraph/foundation/allocation/_/AllocationReservation');
it('exclusive scalar bounds reject endpoints for decimals, money and integers', () => {
  for (const [name, args, low, high, inside] of [['decimal', ['6'], '0', '100', '0.000001'], ['money', ['USD'], '0', '100', '0.01'], ['integer', [], 0, 100, 1]] as const) {
    const type: TypeSpec = { base: { kind: 'scalar', name, args: [...args] }, optional: false, normalizers: [], constraints: [{ kind: 'compare', op: '>', value: { type: 'int', value: '0' } }, { kind: 'compare', op: '<', value: { type: 'int', value: '100' } }] };
    expect(() => decodeValue(model, type, low)).toThrow();
    expect(() => decodeValue(model, type, high)).toThrow();
    expect(() => decodeValue(model, type, inside)).not.toThrow();
  }
});
it('typed decimal comparisons use exact numeric order across reference fields', () => {
  const lhs: Expr = { kind: 'name', path: ['quantity'] }, rhs: Expr = { kind: 'name', path: ['pool', 'capacity'] };
  const compare = (op: string, a: string, b: string) => evalExpr(model, resource, { kind: 'binary', op, lhs, rhs }, { quantity: a }, undefined, { pool: { capacity: b } });
  expect(compare('<=', '80.000000', '100.000000')).toBe(true);
  expect(compare('>', '100.000001', '100.000000')).toBe(true);
  expect(compare('<', '-2.000000', '-10.000000')).toBe(false);
  expect(evalExpr(model, resource, { kind: 'binary', op: '==', lhs, rhs: { kind: 'literal', literal: { type: 'int', value: '1' } } }, { quantity: '1.000000' })).toBe(true);
  // Text remains lexicographic, even when it looks numeric.
  expect(evalExpr(model, resource, { kind: 'binary', op: '<', lhs: { kind: 'name', path: ['key'] }, rhs: { kind: 'literal', literal: { type: 'string', value: '100' } } }, { key: '80' })).toBe(false);
});

it('comparisons of decimal predicates remain boolean expressions', () => {
 const predicate: Expr = { kind: 'binary', op: '>', lhs: {kind:'name',path:['quantity']}, rhs:{kind:'literal',literal:{type:'int',value:'0'}} };
 expect(evalExpr(model, resource, {kind:'binary',op:'==',lhs:predicate,rhs:{kind:'literal',literal:{type:'bool',value:true}}}, {quantity:'80.000000'})).toBe(true);
});
