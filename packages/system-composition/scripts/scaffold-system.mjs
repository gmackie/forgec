#!/usr/bin/env node
/** Generate an inert Forge application skeleton; never overwrite anything. */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldSystem } from '../src/scaffold.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here, '../../..');
const [systemId, output]=process.argv.slice(2);
if(!systemId||!output) { console.error('usage: scaffold-system.mjs <system-id> <new-dir>'); process.exit(2) }
const dest=resolve(output);
if(existsSync(dest)) { console.error(`refusing to overwrite ${dest}`); process.exit(2) }
const foundation=join(root,'packages/foundation');
const contracts=readdirSync(foundation,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>JSON.parse(readFileSync(join(foundation,x.name,'contract.json'),'utf8')));
const catalog=JSON.parse(readFileSync(resolve(here,'../catalog/systems.json'),'utf8'));
const {plan,files}=scaffoldSystem({catalog,contracts,systemId,repositoryRoot:root,targetDirectory:dest});
// Only perform side effects after successful validation and target-existence check.
mkdirSync(dest,{recursive:true});
for(const [path,body] of Object.entries(files)) {
  const target=join(dest,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,body,{flag:'wx'});
}
console.log(`Created ${dest} (${plan.foundation.length} Foundation packages). Not compiled, approved, certified or deployed.`);
