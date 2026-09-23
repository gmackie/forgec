import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { Engine } from '../../src/engine.js';
import { Model, type AppBundle } from '../../src/model.js';
import { PostgresStorage, rawPgExecutor } from '../../src/adapters/postgres.js';
import { D1Storage } from '../../src/adapters/d1.js';
import { DynamoStorage } from '../../src/adapters/dynamodb.js';
import type { SqlExecutor, SqlStatement } from '../../src/adapters/sql-executor.js';
import type { StorageAdapter } from '../../src/services.js';
import { MemoryObjectStore } from '../../src/adapters/memory-objects.js';
import { testLayer } from '../../src/testing.js';
import { validDynamoTable } from '../../../../conformance/foundation/providers/dynamo-schema.mjs';
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}; provider traces cannot skip or use local substitution`); return value; };
let fixtureSequence = 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function providerEnvironment() {
  const provider = required('FORGE_PROVIDER'), runId = required('FORGE_PROVIDER_RUN_ID');
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid provider run identity');
  const fixture = required('FORGE_PROVIDER_FIXTURE');
  const bytes = readFileSync(resolve(fixture, 'app.json'), 'utf8');
  if (hash(bytes) !== required('FORGE_PROVIDER_BUNDLE_SHA256')) throw new Error('Generated bundle digest mismatch');
  const model = new Model(JSON.parse(bytes) as AppBundle);
  let storage: StorageAdapter, close: () => Promise<void> = async () => {};
  let observed: Record<string, unknown>;
  if (provider === 'postgres') {
    const schema = 'foundation_provider_' + runId.replaceAll('-', '');
    const pool = new pg.Pool({ connectionString: required('FORGE_FOUNDATION_PG_URL'), options: `-c search_path=${schema}`, max: 8 });
    try {
      const version = await pool.query('SHOW server_version');
      observed = { driver: 'pg', serverVersion: version.rows[0].server_version };
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(readFileSync(resolve(fixture, 'postgres/0001_init.sql'), 'utf8'));
    } catch { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await pool.end(); throw new Error('PostgreSQL fixture setup failed; connection details withheld'); }
    storage = new PostgresStorage(rawPgExecutor(pool), model);
    close = async () => { try { await pool.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await pool.end(); } };
  } else if (provider === 'd1') {
    const url = new URL(required('FORGE_FOUNDATION_D1_URL'));
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url.password || url.search || url.hash) throw new Error('Hosted HTTPS workers.dev endpoint required');
    const headers = { authorization: `Bearer ${required('FORGE_FOUNDATION_D1_TOKEN')}`, 'content-type': 'application/json' };
    const response = await fetch(new URL('/identity', url), { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Hosted D1 identity request failed');
    const identity = await response.json() as Record<string, unknown>;
    if (identity.protocol !== 'foundation-d1/1' || identity.provider !== 'cloudflare-d1-hosted' || identity.bundleSha256 !== hash(bytes) || identity.harnessSha256 !== required('FORGE_PROVIDER_HARNESS_SHA256') || typeof identity.colo !== 'string') throw new Error('D1 deployment/bundle identity mismatch');
    observed = identity;
    const command = async <T>(kind: string, statements: SqlStatement[]): Promise<T> => {
      const result = await fetch(new URL('/sql', url), { method: 'POST', headers, body: JSON.stringify({ kind, statements }), redirect: 'error', signal: AbortSignal.timeout(30000) });
      const body = await result.json() as { value: T; error?: string };
      if (!result.ok || body.error) throw new Error(body.error ?? 'Hosted D1 command failed');
      return body.value;
    };
    const executor: SqlExecutor = { facade: 'hosted-d1-certification', first: <T>(s: SqlStatement) => command<T | null>('first', [s]), all: <T>(s: SqlStatement) => command<T[]>('all', [s]), run: s => command('run', [s]), batch: s => command('batch', s) };
    storage = new D1Storage(executor, model);
  } else if (provider === 'dynamodb') {
    const table = required('FORGE_FOUNDATION_DYNAMO_TABLE'), region = required('AWS_REGION');
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) || !/^[A-Za-z0-9_.-]{3,255}$/.test(table) || process.env['AWS_ENDPOINT_URL'] || process.env['AWS_ENDPOINT_URL_DYNAMODB']) throw new Error('Hosted AWS table and region required without endpoint overrides');
    const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    const client = new DynamoDBClient({ region, endpoint: `https://dynamodb.${region}.${suffix}` });
    try {
      const result = await client.send(new DescribeTableCommand({ TableName: table }));
      if (!validDynamoTable(result.Table)) throw new Error('Existing active Forge Dynamo table required');
      observed = { service: 'aws-dynamodb', region, tableArnHash: hash(result.Table!.TableArn!), tableStatus: result.Table!.TableStatus };
    } catch { client.destroy(); throw new Error('AWS Dynamo table preflight failed; no table was provisioned'); }
    storage = new DynamoStorage({ table, region, client }, model);
    close = async () => { client.destroy(); };
  } else throw new Error('Explicit postgres, d1 or dynamodb provider required');
  const objects = new MemoryObjectStore();
  const engine = new Engine(model, testLayer(storage, { objects, runId: runId.slice(0, 16) + '-' + (++fixtureSequence) + '-' }));
  const tenantPrefix = 'foundation-cert-' + runId;
  writeFileSync(required('FORGE_PROVIDER_IDENTITY'), JSON.stringify({ provider, runId, tenantPrefix, observed, objectStore: process.env['FORGE_PROVIDER_PROFILE'] === 'core' ? 'not exercised' : 'memory object-store test double; database durability only', retainedData: provider === 'postgres' ? 'isolated test schema removed on close' : 'unique test tenants retained; no cleanup or provisioning performed' }, null, 2));
  return { engine, storage, model, tenantPrefix, objects, close };
}
