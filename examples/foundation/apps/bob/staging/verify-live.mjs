import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

// Run only in the disposable staging container, with its private env/config mounted.
const config = JSON.parse(readFileSync('/stage/config.json', 'utf8'));
const binding = config.bindings[0];
const bob = new pg.Client({ connectionString: process.env.BOB_DATABASE_URL });
const foundation = new pg.Client({ connectionString: process.env.FOUNDATION_DATABASE_URL });
await bob.connect(); await foundation.connect();
assert.equal((await bob.query('select current_database() as name')).rows[0].name, 'bob_stage');
assert.equal((await foundation.query('select current_database() as name')).rows[0].name, 'foundation_stage');
const tests = [];
async function check(name, action) {
  await action(); tests.push({ name, status: 'passed' }); console.log(name);
}
async function request(expected, body = { workspaceId: binding.workspaceId, taskRunId: binding.taskRunId }, receiver = false, token = receiver ? config.serviceToken : config.operatorToken) {
  const response = await fetch(receiver ? 'http://127.0.0.1:4311/completion' : 'http://127.0.0.1:4310/api/v1/foundation/completions', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, expected);
  return response.json();
}
async function snapshot() {
  return (await foundation.query('select row_to_json(e) as fact from fulfillment_end e where tenant=$1 and fulfillment=$2 union all select row_to_json(r) from run_completion r where tenant=$1 and task_run_id=$3', [binding.workspaceId, binding.fulfillmentId, binding.taskRunId])).rows;
}
async function mutate(name, table, column, value, id, expected) {
  // All identifiers here are fixed literals supplied below, never request input.
  const original = (await bob.query(`select ${column} as value from ${table} where id=$1`, [id])).rows[0].value;
  try {
    await bob.query(`update ${table} set ${column}=$1 where id=$2`, [value, id]);
    await check(name, () => request(expected));
  } finally {
    await bob.query(`update ${table} set ${column}=$1 where id=$2`, [original, id]);
  }
}
try {
  const baseline = await snapshot();
  const key = (await bob.query('select id from api_keys where key_hash=$1', [createHash('sha256').update(config.operatorToken).digest('hex')])).rows[0];
  const member = (await bob.query('select id from workspace_members where workspace_id=$1 and user_id=$2', [binding.workspaceId, binding.userId])).rows[0];
  await mutate('Revoked key rejected immediately', 'api_keys', 'revoked_at', new Date(), key.id, 401);
  await mutate('Expired key rejected immediately', 'api_keys', 'expires_at', new Date(0), key.id, 401);
  await mutate('Viewer downgrade rejected immediately', 'workspace_members', 'role', 'viewer', member.id, 403);
  const membership = (await bob.query('select * from workspace_members where id=$1', [member.id])).rows[0];
  try {
    await bob.query('delete from workspace_members where id=$1', [member.id]);
    await check('Removed workspace membership rejected', () => request(403));
  } finally {
    await bob.query('insert into workspace_members select * from json_populate_record(null::workspace_members,$1)', [JSON.stringify(membership)]);
  }
  await mutate('Nonterminal persisted run rejected', 'task_runs', 'status', 'running', binding.taskRunId, 409);
  await mutate('Changed completion time cannot rewrite terminal fact', 'task_runs', 'completed_at', new Date('2026-10-01T02:00:00Z'), binding.taskRunId, 503);
  await mutate('Changed persisted session cannot bypass binding', 'task_runs', 'session_id', randomUUID(), binding.taskRunId, 503);
  await mutate('Changed persisted planning item cannot bypass binding', 'task_runs', 'kanbanger_issue_id', randomUUID(), binding.taskRunId, 503);
  const { fulfillmentId, ...fact } = binding;
  fact.completedAt = '2026-10-01T01:00:00.000Z';
  await check('Receiver rejects invalid service credential', () => request(401, fact, true, 'invalid'));
  await check('Receiver rejects caller-supplied fulfillment', () => request(400, { ...fact, fulfillmentId }, true));
  await check('Concurrent replays return original IDs', async () => {
    const original = JSON.parse(readFileSync('/stage/first-result.json', 'utf8'));
    const results = await Promise.all(Array.from({ length: 12 }, () => request(200)));
    for (const result of results) assert.deepEqual(result, original);
  });
  await check('Rejected mutations and concurrent retries preserve exact target rows', async () => assert.deepEqual(await snapshot(), baseline));
} finally {
  await bob.end(); await foundation.end();
  writeFileSync('/stage/live-verification.json', JSON.stringify({ at: new Date().toISOString(), scope: 'Isolated synthetic Bob staging; real HTTP and PostgreSQL', tests }, null, 2) + '\n');
}
