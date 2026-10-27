import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scaffoldSystem } from '../src/scaffold.mjs';
const catalog=JSON.parse(readFileSync(new URL('../catalog/systems.json',import.meta.url),'utf8'));
const names=[...new Set(catalog.systems.flatMap(s=>s.foundation))];
const contracts=names.map(slug=>({slug,layer:'system',dependencies:[],acceptance:[{id:'local',status:'passing'}]}));
test('scaffold generates explicit deployment dependencies without inventing domain or authorization schema',()=>{
 const a=scaffoldSystem({catalog,contracts,systemId:'change-intelligence',repositoryRoot:'/repo',targetDirectory:'/repo/examples/changes'});
 const b=scaffoldSystem({catalog,contracts:[...contracts].reverse(),systemId:'change-intelligence',repositoryRoot:'/repo',targetDirectory:'/repo/examples/changes'});
 assert.deepEqual(a,b);
 assert.match(a.files['forge.toml'], /\[package\]/);
 assert.match(a.files['forge.toml'], /\[dependencies\.change\][\s\S]*deploy = true/);
 assert.match(a.files['forge.toml'], /\.\.\/\.\.\/packages\/foundation\/change/);
 assert.match(a.files['src/index.forge'], /import change/);
 assert.doesNotMatch(a.files['src/index.forge'], /export resource/);
 assert.match(a.files['README.md'], /Not compiled|before publishing|Before publishing/i);
});
test('scaffold does not generate an unknown system',()=>{
 assert.throws(()=>scaffoldSystem({catalog,contracts,systemId:'nope',repositoryRoot:'/repo',targetDirectory:'/repo/examples/nope'}),/unknown system/);
});
