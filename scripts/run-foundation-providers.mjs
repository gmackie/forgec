#!/usr/bin/env node
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { profiles, providerConfiguration } from './verify-foundation-providers.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function privateFile(directory, path) {
  if (typeof path !== 'string' || !path) throw new Error('Missing private state file reference');
  const file = resolve(directory, path);
  const inside = candidate => { const rel = relative(directory, candidate); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
  let canonical;
  try { canonical = realpathSync(file); } catch (error) {
    if (!inside(file)) throw new Error('State file is outside the setup directory');
    throw error;
  }
  if (!inside(canonical)) throw new Error('State file is outside the setup directory');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid()) throw new Error('State files must be private, owned regular files');
  return readFileSync(file, 'utf8');
}
export function providerEnvironment(stateDirectory, provider, profile, ambient = process.env) {
  const directory = realpathSync(stateDirectory), stat = lstatSync(stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('Setup directory must be private and owned');
  const setup = JSON.parse(privateFile(directory, 'setup.json'));
  if (setup.version !== 1) throw new Error('Unsupported provider setup version');
  const env = { ...ambient };
  if (provider === 'postgres') env.FORGE_FOUNDATION_PG_URL = privateFile(directory, setup.postgresUrlFile).trim();
  else {
    const path = provider === 'd1' ? setup.d1?.[profile] : setup.dynamodb;
    if (provider === 'd1' && !path) throw new Error(`No D1 state for profile ${profile}`);
    const receipt = JSON.parse(privateFile(directory, path));
    if (receipt.status !== 'ready' || receipt.production !== false || receipt.provider !== provider) throw new Error('Dedicated provider receipt must be ready');
    if (provider === 'd1') {
      if (receipt.profile !== profile) throw new Error('D1 profile does not match its deployed bundle');
      env.FORGE_FOUNDATION_D1_URL = receipt.environment.FORGE_FOUNDATION_D1_URL;
      env.FORGE_FOUNDATION_D1_TOKEN = privateFile(directory, receipt.tokenFile).trim();
    } else if (provider === 'dynamodb') {
      if (ambient.AWS_ACCESS_KEY_ID || ambient.AWS_SECRET_ACCESS_KEY || ambient.AWS_SESSION_TOKEN) throw new Error('Remove ambient static credentials before selecting AWS_PROFILE');
      if (!setup.awsProfile) throw new Error('Missing AWS_PROFILE reference');
      env.AWS_PROFILE = setup.awsProfile;
      env.AWS_REGION = receipt.environment.AWS_REGION;
      env.FORGE_FOUNDATION_DYNAMO_TABLE = receipt.environment.FORGE_FOUNDATION_DYNAMO_TABLE;
    } else throw new Error('Unknown provider');
  }
  providerConfiguration(provider, env);
  return env;
}
export function run(args) {
  const options = {provider:'all',profile:'core'};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i]?.replace(/^--/,'');
    if(!['state-dir','provider','profile','receipt-dir'].includes(key)||!args[i+1]) throw new Error('Use --state-dir <private setup> [--provider all|postgres|d1|dynamodb] [--profile core|all|package] [--receipt-dir <directory>]');
    options[key]=args[i+1];
  }
  if(!options['state-dir']) throw new Error('Explicit --state-dir required');
  const selectedProviders=options.provider==='all'?['postgres','d1','dynamodb']:[options.provider];
  const selectedProfiles=options.profile==='all'?['core',...Object.keys(profiles)]:[options.profile];
  if(selectedProfiles.some(p=>p!=='core'&&!profiles[p])) throw new Error('Unknown provider profile');
  // Resolve every selected credential reference before running any tests.
  const cells=selectedProfiles.flatMap(profile=>selectedProviders.map(provider=>({profile,provider,env:providerEnvironment(options['state-dir'],provider,profile)})));
  for(const {profile,provider,env} of cells) {
    console.log(`Running ${profile} on ${provider}`);
    const result=spawnSync(process.execPath,[join(root,'scripts/verify-foundation-providers.mjs'),'--provider',provider,'--profile',profile,'--receipt-dir',resolve(options['receipt-dir']??join(options['state-dir'],'receipts'))],{cwd:root,env,stdio:'inherit'});
    if(result.error||result.status!==0) throw new Error(`Verification failed for ${profile}/${provider}; inspect its receipt`);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { run(process.argv.slice(2)); } catch(error) { console.error(error.message); process.exitCode=1; }
}
