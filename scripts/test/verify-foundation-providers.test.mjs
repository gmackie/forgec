import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerConfiguration, validateResult, traceIds } from '../verify-foundation-providers.mjs';
test('provider configuration fails closed and cannot label local emulators hosted', () => {
  for (const provider of ['postgres', 'd1', 'dynamodb']) assert.throws(() => providerConfiguration(provider, {}));
  assert.throws(() => providerConfiguration('d1', { FORGE_FOUNDATION_D1_URL: 'http://localhost:8787', FORGE_FOUNDATION_D1_TOKEN: 'redacted' }));
  assert.throws(() => providerConfiguration('dynamodb', { FORGE_FOUNDATION_DYNAMO_TABLE: 'probe', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL: 'http://localhost:8000' }));
  assert.equal(providerConfiguration('postgres', { FORGE_FOUNDATION_PG_URL: 'postgres://user:secret@127.0.0.1:55479/test' }).topology, 'native-postgres-local');
  assert.ok(!JSON.stringify(providerConfiguration('postgres', { FORGE_FOUNDATION_PG_URL: 'postgres://user:secret@127.0.0.1:55479/test' })).includes('secret'));
});
test('passing receipt requires exactly every named executed trace', () => {
  const result = { success: true, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ assertionResults: traceIds.map(title => ({ title, status: 'passed' })) }] };
  assert.deepEqual(validateResult(result), traceIds);
  assert.throws(() => validateResult({ ...result, numPendingTests: 1 }));
  assert.throws(() => validateResult({ ...result, testResults: [{ assertionResults: [] }] }));
  assert.throws(() => validateResult({ ...result, testResults: [{ assertionResults: [...result.testResults[0].assertionResults, { title: 'extra', status: 'pending' }] }] }));
});
test('D1 harness authenticates and delegates a batch to one transactional binding call', async () => {
  const { default: worker } = await import('../../conformance/foundation/providers/d1-worker.mjs');
  let batches = 0;
  const env = { CERT_TOKEN: 'unit-only', BUNDLE_SHA256: 'bundle', HARNESS_SHA256: 'harness', DB: { prepare: sql => ({ bind: (...params) => ({ sql, params }) }), batch: async statements => { batches++; assert.equal(statements.length, 2); return statements.map(() => ({ meta: { changes: 1 } })); } } };
  const unauthorized = await worker.fetch(new Request('https://probe.workers.dev/sql'), env);
  assert.equal(unauthorized.status, 401); assert.equal(batches, 0);
  const request = new Request('https://probe.workers.dev/sql', { method: 'POST', headers: { authorization: 'Bearer unit-only', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'batch', statements: [{ sql: 'INSERT INTO test VALUES (?)', params: [1] }, { sql: 'INSERT INTO test VALUES (?)', params: [2] }] }) });
  Object.defineProperty(request, 'cf', { value: { colo: 'unit-test-only' } });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200); assert.equal(batches, 1); assert.deepEqual(await response.json(), { value: [{ changes: 1 }, { changes: 1 }] });
});
test('Dynamo preflight matches uppercase string PK/SK used by DynamoStorage', async () => {
  const { validDynamoTable } = await import('../../conformance/foundation/providers/dynamo-schema.mjs');
  const table = { TableStatus: 'ACTIVE', TableArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/probe', KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }], AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }] };
  assert.equal(validDynamoTable(table), true);
  assert.equal(validDynamoTable({ ...table, KeySchema: table.KeySchema.map(key => ({ ...key, AttributeName: key.AttributeName.toLowerCase() })) }), false);
  assert.equal(validDynamoTable({ ...table, AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'N' }, table.AttributeDefinitions[1]] }), false);
  assert.equal(validDynamoTable({ ...table, TableStatus: 'CREATING' }), false);
});
