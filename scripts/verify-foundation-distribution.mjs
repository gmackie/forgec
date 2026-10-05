#!/usr/bin/env node
/** Verify freshly built runtime and workspace dependency tarballs outside the repo.
 * Registry dependencies reuse the existing install; no published availability claim. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=mkdtempSync(join(tmpdir(),'forge-foundation-distribution-'));
const runtime=join(root,'packages/runtime');
const capability=join(root,'packages/contracts/capability-manifest');
const adapters={bob:'bobCompletion',kanbanger:'kanbangerIntake',forgegraph:'assessChangeset',levelforge:'withFoundationProduction',latchflow:'latchFlowFoundation','stream-conductor':'streamConductorFoundation'};
function packAndInstall(directory,name) {
 const archive=join(out,name.replaceAll('/','-')+'.tgz');
 execFileSync('pnpm',['pack','--out',archive],{cwd:directory,stdio:['ignore','ignore','inherit']});
 const installed=join(out,'node_modules',name);mkdirSync(installed,{recursive:true});
 execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',installed]);
 const manifest=JSON.parse(readFileSync(join(installed,'package.json'),'utf8'));
 if(manifest.name!==name)throw new Error(`Unexpected packed package ${manifest.name}`);
 if(relative(realpathSync(out),realpathSync(installed)).startsWith('..'))throw new Error(`Packed package escapes isolated consumer: ${name}`);
 for(const [dependency,version] of Object.entries({...manifest.dependencies,...manifest.optionalDependencies})) {
  if(/^(workspace|link|file):/.test(version))throw new Error(`Unresolved local dependency in ${name}: ${dependency}`);
 }
 return {manifest,installed};
}
try {
 // Build the dependency first, so current runtime declarations resolve its current API.
 for(const directory of [capability,runtime])execFileSync('pnpm',['run','build'],{cwd:directory,stdio:'inherit'});
 const contract=packAndInstall(capability,'@forgegraph/capability-manifest');
 const {manifest}=packAndInstall(runtime,'@forgegraph/runtime');
 if(manifest.dependencies['@forgegraph/capability-manifest']!==contract.manifest.version)throw new Error('Packed capability-manifest version differs from runtime dependency');
 if(Object.keys({...contract.manifest.dependencies,...contract.manifest.optionalDependencies}).length)throw new Error('Capability manifest gained dependencies; extend the isolated dependency closure explicitly');
 for(const [name] of Object.entries(manifest.dependencies)){
  if(name==='@forgegraph/capability-manifest')continue;
  const source=join(runtime,'node_modules',name),target=join(out,'node_modules',name);
  if(!existsSync(source))throw new Error(`Install dependencies before verification: ${name}`);
  if(realpathSync(source).startsWith(join(realpathSync(root),'packages')+sep))throw new Error(`Unpacked workspace dependency ${name}; add its tarball to the closure`);
  mkdirSync(dirname(target),{recursive:true});symlinkSync(source,target,'dir');
 }
 mkdirSync(join(out,'node_modules/@types'),{recursive:true});symlinkSync(join(runtime,'node_modules/@types/node'),join(out,'node_modules/@types/node'),'dir');
 writeFileSync(join(out,'package.json'),JSON.stringify({private:true,type:'module'}));
 const imports=Object.entries(adapters).map(([app,name])=>`import { ${name} } from '@forgegraph/runtime/foundation/apps/${app}';`).join('\n');
 writeFileSync(join(out,'consumer.mjs'),imports+'\n'+Object.values(adapters).map(name=>`if(typeof ${name}!=='function')throw Error('Missing ${name}');`).join('\n'));
 writeFileSync(join(out,'consumer.ts'),imports+`
import type { Engine, CallContext } from '@forgegraph/runtime';
import { Effect } from 'effect';
import type { RunFact } from '@forgegraph/runtime/foundation/apps/bob';
import type { IssueFact } from '@forgegraph/runtime/foundation/apps/kanbanger';
import type { ProductionJob, ProductionStore } from '@forgegraph/runtime/foundation/apps/levelforge';
import type { AssessmentInput, ForgeGraphFunctions } from '@forgegraph/runtime/foundation/apps/forgegraph';
import type { LatchFlowRun } from '@forgegraph/runtime/foundation/apps/latchflow';
import type { AcknowledgedProductionCommand } from '@forgegraph/runtime/foundation/apps/stream-conductor';
declare const engine: Engine, ctx: CallContext;
declare const run: RunFact, issue: IssueFact, job: ProductionJob, store: ProductionStore<ProductionJob>;
declare const assessment: AssessmentInput, functions: ForgeGraphFunctions, nativeRun: LatchFlowRun, command: AcknowledgedProductionCommand;
const bob=bobCompletion(engine,ctx,{taskRunId:'run',fulfillmentId:'fulfillment'},Effect.runPromise);
const bobResult: Promise<{fulfillmentEndId:string;runLinkId:string}>=bob.recordCompletion(run);
const kanbanger=kanbangerIntake(engine,ctx,{creatorId:'user',formId:'form',submitterId:'party'},Effect.runPromise);
const issueResult: Promise<{submissionId:string;issueLinkId:string}>=kanbanger.recordIssue(issue);
const level=withFoundationProduction(store,engine,{projectId:'project',definition:'pin',evaluationSet:'set',executor:'executor'},ctx);
const jobResult: Promise<ProductionJob>=level.save(job,1);
const assessmentResult: Promise<{eligible:boolean;reason:string;assessment:string}>=assessChangeset(engine,functions,assessment,ctx,async()=> 'head',()=>new Date().toISOString());
const latch=latchFlowFoundation(engine,{context:()=>ctx,definition:async()=> 'pin'});
const runResult: Promise<{run:string;phase:'Planned'|'Running'}>=latch.recordRun(nativeRun);
const stream=streamConductorFoundation(engine,()=>ctx);
const commandResult: Promise<{command:string}>=stream.recordAcknowledgedCommand(command);
// These directives fail compilation if parameter declarations silently degrade to any.
// @ts-expect-error typed Bob facts require a string task-run identity
bob.recordCompletion({...run,taskRunId:123});
// @ts-expect-error Intake facts require the persisted creator identity
kanbanger.recordIssue({workspaceId:'tenant',issueId:'issue',teamId:'team',createdAt:'now'});
// @ts-expect-error CAS revision is numeric
level.save(job,'revision');
// @ts-expect-error current head callback must return a string
assessChangeset(engine,functions,assessment,ctx,async()=>123,()=>new Date().toISOString());
// @ts-expect-error completed is not a native LatchFlow admission state
latch.recordRun({...nativeRun,status:'completed'});
// @ts-expect-error command order is numeric
stream.recordAcknowledgedCommand({...command,sequence:'first'});
void [bobResult,issueResult,jobResult,assessmentResult,runResult,commandResult];
`);
 execFileSync(process.execPath,[join(out,'consumer.mjs')],{cwd:out,stdio:'inherit'});
 execFileSync(join(runtime,'node_modules/.bin/tsc'),['--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',join(out,'consumer.ts')],{cwd:out,stdio:'inherit'});
 console.log(JSON.stringify({status:'passing',package:manifest.name,version:manifest.version,packedWorkspaceDependencies:{[contract.manifest.name]:contract.manifest.version},installedAdapterExports:Object.keys(adapters),scope:'fresh runtime and capability-manifest tarballs; strict valid/invalid consumer API checks; registry dependencies from existing installation'}));
}finally{rmSync(out,{recursive:true,force:true});}
