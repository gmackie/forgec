#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function configuration(args){
 const config={profile:'core'};
 for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');if(!['provider','profile','name','state-dir','region'].includes(key)||!args[i+1])throw new Error('Expected --provider d1|dynamodb --name forge-foundation-test-* --state-dir <private directory> [--profile core|package] [--region us-east-1]');config[key]=args[i+1];}
 if(!['d1','dynamodb'].includes(config.provider)||!/^forge-foundation-test-[a-z0-9-]{1,35}$/.test(config.name??'')||!config['state-dir'])throw new Error('Dedicated test resource name and state directory required');
 if(config.provider==='dynamodb'&&!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(config.region??''))throw new Error('Explicit AWS region required');
 if(!/^[a-z][a-z-]*$/.test(config.profile))throw new Error('Invalid profile');
 if(config.profile!=='core'&&!Object.hasOwn(JSON.parse(readFileSync(join(root,'conformance/foundation/providers/profiles.json'),'utf8')),config.profile))throw new Error('Unknown provider profile');
 return config;
}
export function dynamoDefinition(name){return {TableName:name,BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S'},{AttributeName:'SK',AttributeType:'S'},{AttributeName:'pendingShard',AttributeType:'S'},{AttributeName:'pendingAt',AttributeType:'N'}],KeySchema:[{AttributeName:'PK',KeyType:'HASH'},{AttributeName:'SK',KeyType:'RANGE'}],GlobalSecondaryIndexes:[{IndexName:'pending-index',KeySchema:[{AttributeName:'pendingShard',KeyType:'HASH'},{AttributeName:'pendingAt',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}],Tags:[{Key:'purpose',Value:'foundation-certification'}]};}
function command(bin,args,{input,env}={}){const r=spawnSync(bin,args,{cwd:root,encoding:'utf8',input,env:{...process.env,...env},maxBuffer:16*1024*1024});if(r.error||r.status!==0)throw new Error(`${bin} ${args.slice(0,3).join(' ')} failed: ${r.stderr||r.error||r.stdout}`);return r.stdout;}
export function provision(config){
 const state=resolve(config['state-dir']);mkdirSync(state,{recursive:true,mode:0o700});
 const info=lstatSync(state);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new Error('State directory must be owned by this user, private mode0700, and not a symlink');
 const stateFile=join(state,'infrastructure.json');
 if(existsSync(stateFile))throw new Error('State already exists; use recorded resources or choose a fresh state directory');
 const receipt={version:1,provider:config.provider,name:config.name,profile:config.profile,createdAt:new Date().toISOString(),status:'provisioning',production:false,workerName:config.provider==='d1'?config.name.slice(0,45)+'-'+randomBytes(8).toString('hex'):undefined};
 const save=()=>writeFileSync(stateFile,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 writeFileSync(stateFile,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
 if(config.provider==='dynamodb'){
  receipt.account=JSON.parse(command('aws',['sts','get-caller-identity','--output','json'])).Account;save();
  const definition=join(state,'table.json');writeFileSync(definition,JSON.stringify(dynamoDefinition(config.name)));
  const response=JSON.parse(command('aws',['dynamodb','create-table','--region',config.region,'--cli-input-json','file://'+definition,'--output','json']));
  receipt.tableArn=response.TableDescription.TableArn;receipt.region=config.region;save();
  command('aws',['dynamodb','wait','table-exists','--region',config.region,'--table-name',config.name]);
  receipt.environment={AWS_REGION:config.region,FORGE_FOUNDATION_DYNAMO_TABLE:config.name};
 }else{
  const profiles=config.profile==='core'?null:JSON.parse(readFileSync(join(root,'conformance/foundation/providers/profiles.json'),'utf8'));
  const fixture=config.profile==='core'?'conformance/foundation/providers/fixture':profiles[config.profile]?.fixture;
  if(!fixture)throw new Error('Unknown provider profile');
  command('cargo',['run','--quiet','-p','forgegraph-cli','--','build',fixture,'--out',join(state,'bundle')]);
  const wrangler=(args,options)=>command('pnpm',['--filter','@forgegraph/runtime','exec','wrangler',...args],options);
  const created=wrangler(['d1','create',config.name,'--location','enam']);
  writeFileSync(join(state,'create.log'),created);
  const databaseId=created.match(/"database_id"\s*:\s*"([a-f0-9-]{36})"/)?.[1]??created.match(/database_id\s*=\s*"([a-f0-9-]{36})"/)?.[1];
  if(!databaseId)throw new Error('Created database; inspect create.log for its ID before retrying');
  receipt.databaseId=databaseId;save();
  copyFileSync(join(root,'conformance/foundation/providers/d1-worker.mjs'),join(state,'worker.mjs'));
  const wranglerPath=join(state,'wrangler.json');
  writeFileSync(wranglerPath,JSON.stringify({name:receipt.workerName,main:'worker.mjs',compatibility_date:'2026-09-23',workers_dev:true,d1_databases:[{binding:'DB',database_name:config.name,database_id:databaseId}],vars:{BUNDLE_SHA256:hash(readFileSync(join(state,'bundle/app.json'))),HARNESS_SHA256:hash(readFileSync(join(state,'worker.mjs')))}},null,2));
  wrangler(['deploy','--dry-run','--config',wranglerPath]);
  wrangler(['d1','execute',config.name,'--remote','--config',wranglerPath,'--file',join(state,'bundle/d1/0001_init.sql'),'--yes']);
  const deployed=wrangler(['deploy','--config',wranglerPath]);writeFileSync(join(state,'deploy.log'),deployed);
  const url=deployed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];if(!url)throw new Error('Deployed Worker; inspect deploy.log for URL');
  const token=randomBytes(32).toString('hex');writeFileSync(join(state,'token'),token,{mode:0o600,flag:'wx'});
  receipt.environment={FORGE_FOUNDATION_D1_URL:url};receipt.tokenFile=join(state,'token');receipt.configFile=wranglerPath;save();
  wrangler(['secret','put','CERT_TOKEN','--config',wranglerPath],{input:token});
 }
 receipt.status='ready';save();return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(provision(configuration(process.argv.slice(2))),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
