import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

// Synthetic fixtures only. Keep the state file to replay the same test identities.
const configPath = '/stage/config.json';
const statePath = '/stage/recovery-fixtures.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const bob = new pg.Client({ connectionString: process.env.BOB_DATABASE_URL });
const foundation = new pg.Client({ connectionString: process.env.FOUNDATION_DATABASE_URL });
await bob.connect(); await foundation.connect();
const tests = [];
const phase = process.argv[2];
assert.ok(['prepare', 'exercise', 'replay'].includes(phase));
async function counts(b) {
  const end = (await foundation.query('select id from fulfillment_end where tenant=$1 and fulfillment=$2', [b.workspaceId, b.fulfillmentId])).rows;
  const link = (await foundation.query('select id,terminal from run_completion where tenant=$1 and task_run_id=$2', [b.workspaceId, b.taskRunId])).rows;
  return { end, link };
}
async function request(b, expected) {
  const response = await fetch('http://127.0.0.1:4310/api/v1/foundation/completions', {
    method: 'POST', headers: { authorization: `Bearer ${config.operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: b.workspaceId, taskRunId: b.taskRunId }), signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, expected);
  const data = await response.json();
  if (expected === 503) assert.deepEqual(data, { error: 'Foundation reconciliation unavailable; retry this persisted run' });
  return data;
}
function pass(name) { tests.push({ name, status: 'passed' }); console.log(name); }
try {
  assert.equal((await bob.query('select current_database() as name')).rows[0].name, 'bob_stage');
  assert.equal((await foundation.query('select current_database() as name')).rows[0].name, 'foundation_stage');
  if (phase === 'prepare') {
    assert.throws(() => readFileSync(statePath), { code: 'ENOENT' });
    const source = config.bindings[0];
    const run = (await bob.query('select * from task_runs where id=$1', [source.taskRunId])).rows[0];
    const fulfillment = (await foundation.query('select * from fulfillment where tenant=$1 and id=$2', [source.workspaceId, source.fulfillmentId])).rows[0];
    const fixtures = {};
    for (const [index, name] of ['interrupted', 'missingStart'].entries()) {
      const b = { ...source, taskRunId: randomUUID(), fulfillmentId: randomUUID() };
      // Explicit synthetic request/native completion observations; no task execution.
      await bob.query('insert into task_runs select * from json_populate_record(null::task_runs,$1)', [JSON.stringify({ ...run, id: b.taskRunId })]);
      await foundation.query('insert into fulfillment select * from json_populate_record(null::fulfillment,$1)', [JSON.stringify({ ...fulfillment, id: b.fulfillmentId, ordinal: 1001 + index })]);
      if (name === 'interrupted') await foundation.query('insert into fulfillment_start (tenant,id,fulfillment,began_at,recorded_by) values ($1,$2,$3,$4,$5)', [b.workspaceId, randomUUID(), b.fulfillmentId, '2026-10-01T00:30:00Z', b.userId]);
      fixtures[name] = b; config.bindings.push(b);
    }
    writeFileSync(statePath, JSON.stringify(fixtures, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    pass('Created separate synthetic started and unstarted fixtures');
  } else {
    const { interrupted, missingStart, result } = JSON.parse(readFileSync(statePath, 'utf8'));
    if (phase === 'exercise') {
      assert.deepEqual(await counts(interrupted), { end: [], link: [] });
      // Scoped to this random test run. Never install on production databases.
      assert.match(interrupted.taskRunId, /^[a-f0-9-]{36}$/);
      try {
        await foundation.query(`create function staging_fail_run_link() returns trigger language plpgsql as $$ begin if NEW.task_run_id = '${interrupted.taskRunId}' then raise exception 'staging injected run-link failure'; end if; return NEW; end $$`);
        await foundation.query('create trigger staging_fail_run_link before insert on run_completion for each row execute function staging_fail_run_link()');
        await request(interrupted, 503);
        const partial = await counts(interrupted);
        assert.equal(partial.end.length, 1); assert.equal(partial.link.length, 0);
        pass('Injected second-write failure leaves exactly one terminal and no run link; HTTP error redacted');
      } finally {
        await foundation.query('drop trigger if exists staging_fail_run_link on run_completion');
        await foundation.query('drop function if exists staging_fail_run_link()');
      }
      const recovered = await request(interrupted, 200);
      const persisted = await counts(interrupted);
      assert.equal(persisted.end.length, 1); assert.equal(persisted.link.length, 1);
      assert.equal(persisted.link[0].terminal, persisted.end[0].id);
      assert.deepEqual(recovered, { fulfillmentEndId: persisted.end[0].id, runLinkId: persisted.link[0].id });
      writeFileSync(statePath, JSON.stringify({ interrupted, missingStart, result: recovered }, null, 2) + '\n', { mode: 0o600 });
      pass('Retry repairs missing run link without duplicating terminal');
      await request(missingStart, 503);
      assert.deepEqual(await counts(missingStart), { end: [], link: [] });
      assert.equal((await foundation.query('select id from fulfillment_start where tenant=$1 and fulfillment=$2', [missingStart.workspaceId, missingStart.fulfillmentId])).rowCount, 0);
      pass('Missing independent start rejected without manufacturing start or terminal');
    } else {
      assert.ok(result);
      for (const replay of await Promise.all(Array.from({ length: 12 }, () => request(interrupted, 200)))) assert.deepEqual(replay, result);
      const persisted = await counts(interrupted);
      assert.equal(persisted.end.length, 1); assert.equal(persisted.link.length, 1);
      pass('Restart and concurrent replay preserve recovered terminal and link IDs');
    }
  }
} finally {
  await bob.end(); await foundation.end();
  writeFileSync(`/stage/recovery-${phase}.json`, JSON.stringify({ at: new Date().toISOString(), phase, tests }, null, 2) + '\n');
}
