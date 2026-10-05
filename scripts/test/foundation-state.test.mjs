import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, evidenceErrors } from '../foundation-state.mjs';
const node = (slug, issue, dependencies=[], requiresGates=['core'], acceptanceGates=[]) => ({slug, issue, dependencies, requiresGates, acceptanceGates});
const cs = ns => ns.map(n => ({slug:n.slug,issue:n.issue,dependencies:n.dependencies,acceptance:[{status:'passing'}]}));
const proof = slug => ({version:1,package:slug,suite:'local',status:'passing',fingerprint:slug,commands:['verify'],artifacts:[{path:'app.json',sha256:'a'.repeat(64)}],verifiedAt:'2026-09-22T00:00:00Z'});
const options={slots:3,fingerprintOf:s=>s,kernelFingerprint:'kernel-v1'};
const state=()=>({packages:{},gates:{core:{status:'passing',fingerprint:'kernel-v1'}}});
test('own acceptance gates do not block producer but do block consumer', () => {
  const ns=[node('party',52,[],['core'],['identity']),node('participation',29,['party'],['core','identity'])];
  const g={packages:ns,gateOwnership:{core:'kernel',identity:'party'}};
  const st=state();
  assert.deepEqual(schedule(g,cs(ns),st,options).dispatch,['party']);
  st.packages.party=proof('party');
  assert.deepEqual(schedule(g,cs(ns),st,options).dispatch,['party']);
  st.gates.identity={status:'passing',fingerprint:'party'};
  assert.deepEqual(schedule(g,cs(ns),st,options).dispatch,['participation']);
});
test('stale dependency or kernel evidence blocks downstream work', () => {
  const ns=[node('a',26),node('b',27,['a'])],g={packages:ns,gateOwnership:{core:'kernel'}},st=state();
  st.packages.a=proof('a');
  assert.deepEqual(schedule(g,cs(ns),st,options).dispatch,['b']);
  st.packages.a.fingerprint='old';
  assert.ok(schedule(g,cs(ns),st,options).blocked.find(x=>x.package==='b'));
  st.gates.core.fingerprint='old';
  assert.deepEqual(schedule(g,cs(ns),st,options).dispatch,[]);
});
test('ready ordering prioritizes fanout, excludes active workers and respects three slots', () => {
  const ns=[node('leaf',26),node('root',28),node('child',29,['root']),node('another',30),node('fourth',31)];
  const g={packages:ns,gateOwnership:{core:'kernel'}},st=state();
  assert.deepEqual(schedule(g,cs(ns),st,options).dispatch,['root','leaf','another']);
  st.active=['root','another'];
  assert.deepEqual(schedule(g,cs(ns),st,options).dispatch,['leaf']);
});
test('false or incomplete receipts cannot release dependency', () => {
  assert.ok(evidenceErrors({status:'passing'},'x','x').length);
  assert.deepEqual(evidenceErrors(proof('x'),'x','x'),[]);
  assert.ok(evidenceErrors({...proof('x'),artifacts:[]},'x','x').length);
});

test('malformed graph and active workers cannot release tasks', () => {
  const ns=[node('a',26)],g={packages:ns,gateOwnership:{core:'kernel'}};
  assert.throws(()=>schedule(g,cs(ns),{...state(),active:['ghost']},options),/invalid active/);
  assert.throws(()=>schedule(g,cs(ns),{...state(),active:['a','a']},options),/invalid active/);
  assert.throws(()=>schedule({...g,packages:[...ns,...ns]},cs(ns),state(),options),/duplicate/);
  assert.throws(()=>schedule({...g,gateOwnership:{}},cs(ns),state(),options),/no owner/);
  assert.throws(()=>schedule(g,[{...cs(ns)[0],dependencies:['ghost']}],state(),options),/differs/);
});

test('upper integration checks do not create reverse dependency deadlocks', () => {
 const ns=[{...node('calendar',55,[],['core'],['calendar-ready']),deferredIntegrationAcceptance:['bridge']},node('scheduling',58,['calendar'],['core','calendar-ready'])];
 const contracts=cs(ns);contracts[0].acceptance.push({id:'bridge',status:'planned'});
 const st=state();st.packages.calendar=proof('calendar');st.gates['calendar-ready']={status:'passing',fingerprint:'calendar'};
 const result=schedule({packages:ns,gateOwnership:{core:'kernel','calendar-ready':'calendar'}},contracts,st,options);
 assert.deepEqual(result.dispatch,['scheduling']);
 assert.deepEqual(result.integrationPending,[{package:'calendar',acceptance:'bridge'}]);
});
