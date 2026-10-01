import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
export async function invokeApplication(runtimeRoot, binding, input, ctx) {
 const req=createRequire(pathToFileURL(`${runtimeRoot}/packages/runtime/package.json`));
 const {Effect}=await import(req.resolve('effect'));
 const module=name=>import(pathToFileURL(`${runtimeRoot}/packages/runtime/src/${name}.ts`));
 const [{Engine},{Model},{MemoryStorage},{testLayer},{defineFunction}]=await Promise.all(['engine','model','adapters/memory','testing','functions'].map(module));
 const bundle=JSON.parse(readFileSync(new URL('../.cache/pilot-app/app.json',import.meta.url)));
 const id='@pilot/deployment-verification/_/VerifyRelease',external='@pilot/deployment-provider/_/CheckRelease';
 const impl=defineFunction(id,deps=>Effect.gen(function*(){
  const result=yield* deps.external(external,deps.input);
  if(!result.ok)return yield* deps.fail('ProviderUnavailable');
  return {applied:true};
 }));
 const engine=new Engine(new Model(bundle),testLayer(new MemoryStorage()),{functions:[impl],externals:{[external]:binding}});
 return Effect.runPromise(engine.call(id,input,ctx));
}
