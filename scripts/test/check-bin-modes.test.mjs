import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// pnpm install chmods every package bin it links, so a bin committed as 100644
// leaves a mode-only diff in each checkout (FORG-46).
test('package bin entries are committed executable',()=>{
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8'});
 const bins=git('ls-files','--','package.json','*/package.json').split('\n').filter(Boolean).flatMap(manifest=>{
  const {bin}=JSON.parse(readFileSync(manifest,'utf8'));
  const dir=manifest.slice(0,-'package.json'.length);
  return Object.values(typeof bin==='string'?{bin}:bin??{}).map(path=>(dir+path).replace(/\/\.\//g,'/'));
 });
 assert.ok(bins.length>0);
 for(const path of bins)assert.match(git('ls-files','-s','--',path),/^100755 /,`${path} must be committed as 100755`);
});
