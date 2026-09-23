import { Effect } from "effect";
import { expect, it } from "vitest";
import { Qualifications } from "../src/foundation/qualification.js";
import { Evidence } from "../src/foundation/evidence.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
const p="@forgegraph/foundation/qualification/_/", party="@forgegraph/foundation/party/_/", spec="@forgegraph/foundation/specification/_/", e="@forgegraph/foundation/evidence/_/", d="@fixture/qualification-consumer/_/";
const start="2026-01-01T00:00:00Z", end="2026-02-01T00:00:00Z";
for(const adapter of foundationAdapters) {
 it(`${adapter}: typed technician, vendor and Runner awards satisfy pinned domain levels without authorization grants`,async()=>{
  const f=await foundation('qualification',adapter,true);const {call,ctx,engine}=f;
  try {
   const service=new Qualifications(engine);
   const repository=await call(spec+'Repository.create',{key:'requirements',provider:'git',locator:'https://example.test/requirements'});
   const pin=await call(spec+'SpecificationPin.create',{repository:repository.id,anchor:'certification',revision:'a'.repeat(40)});
   const definition=await call(p+'QualificationDefinition.create',{key:'domain-skill',pin:pin.id,label:'Domain skill'});
   const basic=await call(p+'QualificationLevel.create',{definition:definition.id,code:'basic',rank:10});
   const expert=await call(p+'QualificationLevel.create',{definition:definition.id,code:'expert',rank:20});
   const requirement=await call(p+'QualificationRequirement.create',{definition:definition.id,minimumLevel:expert.id});
   const issuer=await call(party+'Party.create',{label:'Credential issuer'});
   const bundle=await call(e+'EvidenceBundle.create',{key:'award-basis',label:'Award basis'});
   const seal=await Effect.runPromise(new Evidence(engine).seal(String(bundle.id),null,ctx));
   for(const name of ['Technician','Vendor','Runner']) {
    const subject=await call(p+'QualificationSubject.create',{label:name});
    if(name==='Runner') {
     await call(d+'Runner.create',{subject:subject.id,machineName:'runner-1'});
     await call(d+'RunnerRequirement.create',{requirement:requirement.id,runtimeName:'node'});
    }else{
     const owner=await call(party+'Party.create',{label:name});
     const link=await call(p+'PartySubject.create',{subject:subject.id,party:owner.id});
     await call(d+name+'.create',{[name==='Technician'?'person':'organization']:link.id});
    }
    const input={subject:String(subject.id),definition:String(definition.id),issuer:String(issuer.id),issuerRecord:name,issuedAt:start,expiresAt:end,support:String(seal.id),level:String(basic.id)};
    const low=await Effect.runPromise(service.award(input,ctx));
    expect(await Effect.runPromise(service.satisfies(String(subject.id),String(requirement.id),start,ctx))).toMatchObject({qualified:false});
    const high=await Effect.runPromise(service.award({...input,issuerRecord:name+'-advanced',level:String(expert.id)},ctx));
    await call(d+'CredentialDetails.create',{qualification:high.id,credentialNumber:name+'-001'});
    expect(await Effect.runPromise(service.satisfies(String(subject.id),String(requirement.id),start,ctx))).toEqual({qualified:true,qualification:high.id});
    expect(await Effect.runPromise(service.satisfies(String(subject.id),String(requirement.id),end,ctx))).toMatchObject({qualified:false});
    await expect(call(p+'Qualification.delete',{id:low.id})).rejects.toThrow();
   }
   const subject=await call(p+'QualificationSubject.create',{label:'Private'});
   engine.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:1,knownObligations:[]});
   await expect(Effect.runPromise(service.satisfies(String(subject.id),String(requirement.id),start,ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
 it(`${adapter}: exact definition comparison, duplicate awards, concurrent revocations and hidden evidence fail safely`,async()=>{
  const f=await foundation('qualification',adapter,true);const {call,ctx,engine}=f;
  try {
   const service=new Qualifications(engine);
   const repository=await call(spec+'Repository.create',{key:'requirements',provider:'git',locator:'https://example.test/requirements'});
   const oldPin=await call(spec+'SpecificationPin.create',{repository:repository.id,anchor:'skill',revision:'a'.repeat(40)});
   const newPin=await call(spec+'SpecificationPin.create',{repository:repository.id,anchor:'skill',revision:'b'.repeat(40)});
   const old=await call(p+'QualificationDefinition.create',{key:'skill',pin:oldPin.id,label:'Old'});
   const newer=await call(p+'QualificationDefinition.create',{key:'skill',pin:newPin.id,label:'New'});
   const level=await call(p+'QualificationLevel.create',{definition:old.id,code:'qualified',rank:1});
   const requirement=await call(p+'QualificationRequirement.create',{definition:old.id,minimumLevel:level.id});
   const nextRequirement=await call(p+'QualificationRequirement.create',{definition:newer.id});
   await expect(call(p+'QualificationRequirement.create',{definition:newer.id,minimumLevel:level.id})).rejects.toThrow();
   await expect(call(p+'QualificationLevel.create',{definition:old.id,code:'other',rank:1})).rejects.toThrow();
   const issuer=await call(party+'Party.create',{label:'Issuer'});
   const subject=await call(p+'QualificationSubject.create',{label:'Subject'});
   const bundle=await call(e+'EvidenceBundle.create',{key:'support',label:'Support'});
   const seal=await Effect.runPromise(new Evidence(engine).seal(String(bundle.id),null,ctx));
   const input={subject:String(subject.id),definition:String(old.id),level:String(level.id),issuer:String(issuer.id),issuerRecord:'award',issuedAt:start,support:String(seal.id)};
   // A valid credential after an entire page of expired awards must still match.
   for(let i=0;i<51;i++) await Effect.runPromise(service.award({...input,issuerRecord:'expired-'+i,issuedAt:'2025-01-01T00:00:00Z',expiresAt:start},ctx));
   const awards=await Promise.allSettled(Array.from({length:6},()=>Effect.runPromise(service.award(input,ctx))));
   expect(awards.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   const award=(awards.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Record<string,unknown>>).value;
   expect(await Effect.runPromise(service.satisfies(String(subject.id),String(nextRequirement.id),start,ctx))).toMatchObject({qualified:false});
   await expect(call(p+'Qualification.create',{...input,definition:newer.id,recordedBy:ctx.actor})).rejects.toThrow();
   await expect(Effect.runPromise(service.award({...input,issuerRecord:'invalid',expiresAt:start},ctx))).rejects.toThrow();
   await expect(Effect.runPromise(service.award({...input,issuerRecord:'unsealed',support:String(bundle.id)},ctx))).rejects.toThrow();
   await expect(Effect.runPromise(service.award(input,{...ctx,tenant:'foreign'}))).rejects.toThrow();
   await expect(Effect.runPromise(service.revoke(String(award.id),'2025-12-01T00:00:00Z','Too early',ctx))).rejects.toThrow();
   const revocations=await Promise.allSettled(Array.from({length:6},()=>Effect.runPromise(service.revoke(String(award.id),end,'Revoked',ctx))));
   expect(revocations.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   expect(await Effect.runPromise(service.satisfies(String(subject.id),String(requirement.id),start,ctx))).toMatchObject({qualified:true});
   expect(await Effect.runPromise(service.satisfies(String(subject.id),String(requirement.id),end,ctx))).toMatchObject({qualified:false});
   for(const hidden of ['QualificationRevocation','EvidenceSeal']) {
    engine.gatekeeper.authorizer=localAuthorizer({policies:[...['QualificationSubject','QualificationDefinition','QualificationRequirement','QualificationLevel','Qualification','QualificationRevocation'].filter(n=>n!==hidden).map(n=>({id:n,actions:[p+n+'.*'],requires:[],where:[]})),...['EvidenceSeal','EvidenceBundle'].filter(n=>n!==hidden).map(n=>({id:n,actions:[e+n+'.*'],requires:[],where:[]})),{id:'issuer',actions:[party+'Party.*'],requires:[],where:[]}],pips:[],epoch:hidden==='EvidenceSeal'?2:1,knownObligations:[]});
    await expect(Effect.runPromise(service.satisfies(String(subject.id),String(requirement.id),start,ctx))).rejects.toThrow();
   }
  }finally{await f.close();}
 });
}
