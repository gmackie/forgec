import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script=resolve('scripts/check-workflows.mjs');
for(const [label,workflow,status] of [['valid','name: Check\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n',0],['invalid','jobs:\n  test:\n    with: { token: ${{ secrets.TOKEN }} }\n',1]]){
 test(`validates ${label} Forgejo workflow without a GitHub directory`,t=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-workflow-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'.forgejo/workflows'),{recursive:true});writeFileSync(join(dir,'.forgejo/workflows/check.yml'),workflow);
  assert.equal(spawnSync(process.execPath,[script],{cwd:dir,encoding:'utf8'}).status,status);
 });
}
