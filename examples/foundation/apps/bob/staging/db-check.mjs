import pg from 'pg';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const c=JSON.parse(readFileSync('/stage/config.json'));const b=c.bindings[0];
const bob=new pg.Client({connectionString:process.env.BOB_DATABASE_URL});const foundation=new pg.Client({connectionString:process.env.FOUNDATION_DATABASE_URL});await bob.connect();await foundation.connect();
const run=(await bob.query('select * from task_runs where id=$1',[b.taskRunId])).rows[0];assert.equal(run.status,'completed');assert.equal(run.completed_at.toISOString(),'2026-10-01T01:00:00.000Z');assert.equal(run.user_id,b.userId);assert.equal(run.session_id,b.sessionId);
const ends=(await foundation.query('select * from fulfillment_end where tenant=$1 and fulfillment=$2',[b.workspaceId,b.fulfillmentId])).rows;assert.equal(ends.length,1);assert.equal(ends[0].outcome,'completed');assert.equal(ends[0].ended_at,'2026-10-01T01:00:00.000Z');assert.ok(ends[0].start);
const links=(await foundation.query('select * from run_completion where tenant=$1 and task_run_id=$2',[b.workspaceId,b.taskRunId])).rows;assert.equal(links.length,1);assert.equal(links[0].terminal,ends[0].id);assert.equal(links[0].session_id,b.sessionId);assert.equal(links[0].planning_item_id,b.planningItemId);
await bob.end();await foundation.end();writeFileSync('/stage/database-acceptance.json',JSON.stringify({at:new Date().toISOString(),status:'passed',checks:['Bob persisted status/completion/owner/session preserved','exactly one terminal fact after retries and restarts','terminal refers to independently seeded start','exactly one typed run link with exact native session/planning identity']},null,2));console.log('Native Bob and Foundation persisted fact checks passed');
