import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { CodedDomains } from '../src/foundation/coded-domain.js';
import { Evidence } from '../src/foundation/evidence.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p = '@forgegraph/foundation/coded-domain/_/';
const ids = '@forgegraph/foundation/identifiers/_/';
const c = '@forgegraph/foundation/classification/_/';
const e = '@forgegraph/foundation/evidence/_/';
const d = '@fixture/coded-domain-consumer/_/';
const start = '2026-01-01T00:00:00Z', next = '2026-02-01T00:00:00Z', end = '2026-03-01T00:00:00Z';
for (const adapter of foundationAdapters) it(`${adapter}: governed code identities, labels, mappings and lifecycle`, async () => {
  const f = await foundation('coded-domain', adapter, true);
  const { call, engine, ctx } = f;
  const service = new CodedDomains(engine);
  const run = Effect.runPromise;
  try {
    const issuer = await call(ids+'Issuer.create', {key:'illustrative-standards-authority'});
    const bundle = await call(e+'EvidenceBundle.create', {key:'release-citation', label:'Published authority release'});
    const seal = await run(new Evidence(engine).seal(String(bundle.id), null, ctx));
    const support = {source:'illustrative:authority/2026', support:seal.id};
    async function idset(label: string) { return (await call(ids+'IdentifierSet.create', {label})).id; }
    async function domain(key: string, authority = issuer.id, context = 'public') {
      return call(p+'CodedDomain.create', {authority,context,key,identifiers:await idset(key)});
    }
    async function release(domain: unknown, ordinal = 1, previous: unknown = null) {
      return call(p+'DomainRelease.create', {domain,version:String(ordinal),ordinal,previous,validFrom:ordinal===1?start:next,validUntil:null,...support});
    }
    async function code(domain: unknown, literal: string, ordinal = 1) {
      return call(p+'Code.create', {domain,literal,ordinal,identifiers:await idset(literal)});
    }
    async function revision(code: unknown, release: unknown, revision = 1, previous: unknown = null) {
      return call(p+'CodeRevision.create', {code,release,releaseOrdinal:(await call(p+'DomainRelease.get',{id:release})).ordinal,revision,previous,definition:'Authority-defined meaning',meaning:null,validFrom:revision===1?start:next,validUntil:null,...support});
    }
    const countries = await domain('countries');
    const countryRelease = await release(countries.id);
    const us = await code(countries.id,'US');
    const usMeaning = await revision(us.id,countryRelease.id);
    const currency = await domain('currencies');
    const currencyRelease = await release(currency.id);
    const usd = await code(currency.id,'USD');
    const usdMeaning = await revision(usd.id,currencyRelease.id);
    const industries = await domain('industries');
    const industryRelease = await release(industries.id);
    const industry = await code(industries.id,'5415');
    const industryMeaning = await revision(industry.id,industryRelease.id);
    await call(d+'CountryAddress.create', {country:usMeaning.id,street:'Example Street'});
    await call(d+'CurrencyAmount.create', {currency:usdMeaning.id,minorUnits:1234});
    await call(d+'IndustryRegistration.create', {industry:industryMeaning.id,businessName:'Example Systems'});
    const external = await call(ids+'Identifier.create', {identifierSet:us.identifiers,namespace:'illustrative-country',issuer:issuer.id,issuerScope:issuer.id,value:'US',validFrom:start,validUntil:null});
    expect(external.identifierSet).toBe(us.identifiers);
    const label = await call(p+'CodeLabel.create', {code:us.id,locale:'en',revision:1,previous:null,label:'Example United States',source:support.source});
    await call(p+'CodeLabel.create', {code:us.id,locale:'en',revision:2,previous:label.id,label:'Revised display wording',source:support.source});
    expect((await run(service.inspect(String(usMeaning.id),start,ctx))).code).toMatchObject({id:us.id,literal:'US'});
    expect(await call(p+'CodeRevision.get',{id:usMeaning.id})).toMatchObject({definition:usMeaning.definition});
    // New authority data extends the vocabulary without an enum/compiler change.
    const added = await code(countries.id,'ZZ-EXAMPLE',2);
    const addedMeaning = await revision(added.id,countryRelease.id);
    await expect(code(countries.id,'US',3)).rejects.toMatchObject({code:'UniqueConflict'});
    const secondIssuer = await call(ids+'Issuer.create',{key:'other-authority'});
    const other = await domain('countries',secondIssuer.id);
    const privateDomain = await domain('countries',issuer.id,'internal');
    await code(other.id,'US'); await code(privateDomain.id,'US');
    await expect(revision(added.id,currencyRelease.id,2,addedMeaning.id)).rejects.toMatchObject({code:'ValidationFailed'});
    // Exact releases and successor facts preserve historical meaning.
    const secondRelease = await release(countries.id,2,countryRelease.id);
    const usMeaning2 = await revision(us.id,secondRelease.id,2,usMeaning.id);
    expect(await run(service.inspect(String(usMeaning.id),start,ctx))).toMatchObject({state:'active',replacement:null});
    expect(await run(service.inspect(String(usMeaning.id),next,ctx))).toMatchObject({state:'superseded',replacement:usMeaning2.id});
    expect(await run(service.inspect(String(usMeaning2.id),start,ctx))).toMatchObject({state:'inactive'});
    const retired = await call(p+'CodeDisposition.create',{code:us.id,replacement:addedMeaning.id,replacementCode:added.id,effectiveAt:end,reason:'New interchange code',...support});
    expect(await run(service.inspect(String(usMeaning2.id),next,ctx))).toMatchObject({state:'active'});
    expect(await run(service.inspect(String(usMeaning2.id),end,ctx))).toMatchObject({state:'superseded',replacement:addedMeaning.id});
    await expect(call(p+'CodeDisposition.create',{code:added.id,replacement:usMeaning.id,replacementCode:us.id,effectiveAt:end,reason:'Cycle',...support})).rejects.toMatchObject({code:'ValidationFailed'});
    await expect(call(p+'CodeDisposition.delete',{id:retired.id})).rejects.toThrow();
    // Mapping assertions are explicit, versioned, and independent of labels.
    const taxonomy = await call(c+'Taxonomy.create',{key:'business',identifiers:await idset('taxonomy')});
    const concept = await call(c+'Concept.create',{taxonomy:taxonomy.id,ordinal:1,parent:null,identifiers:await idset('concept')});
    const meaning = await call(c+'ConceptRevision.create',{concept:concept.id,taxonomy:taxonomy.id,ordinal:1,revision:1,label:'Technology services',definition:'Internal governed meaning'});
    const mapping = await call(p+'ConceptMapping.create',{code:industry.id,concept:concept.id,authority:issuer.id});
    const map1 = await call(p+'MappingRevision.create',{mapping:mapping.id,revision:1,previous:null,codeRevision:industryMeaning.id,meaning:meaning.id,relation:'Narrower',validFrom:start,validUntil:null,...support});
    const map2 = await call(p+'MappingRevision.create',{mapping:mapping.id,revision:2,previous:map1.id,codeRevision:industryMeaning.id,meaning:meaning.id,relation:'Equivalent',validFrom:next,validUntil:end,...support});
    expect(await run(service.inspectMapping(String(map1.id),start,ctx))).toMatchObject({active:true,relation:'Narrower',meaning:{id:meaning.id}});
    expect(await run(service.inspectMapping(String(map1.id),next,ctx))).toMatchObject({active:false});
    expect(await run(service.inspectMapping(String(map2.id),next,ctx))).toMatchObject({active:true,relation:'Equivalent'});
    expect(await run(service.inspectMapping(String(map2.id),end,ctx))).toMatchObject({active:false});
    await expect(call(p+'MappingRevision.create',{mapping:mapping.id,revision:3,previous:map2.id,codeRevision:usMeaning.id,meaning:meaning.id,relation:'Broader',validFrom:end,validUntil:null,...support})).rejects.toMatchObject({code:'ValidationFailed'});
    await call(p+'ReleaseWithdrawal.create',{release:industryRelease.id,effectiveAt:end,reason:'Erroneous publication',...support});
    expect(await run(service.inspect(String(industryMeaning.id),end,ctx))).toMatchObject({state:'withdrawn'});
    await expect(run(service.inspect(String(usMeaning.id),'not-a-date',ctx))).rejects.toMatchObject({code:'ValidationFailed'});
    await expect(run(service.inspect(String(usMeaning.id),start,{...ctx,tenant:'other'}))).rejects.toThrow();
    // Read all except lifecycle facts: hidden withdrawal cannot look absent.
    engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'visible',actions:[p+'Code.get',p+'CodeRevision.get',p+'CodedDomain.get',p+'DomainRelease.get',ids+'*',c+'*',e+'*'],requires:[],where:[]}],pips:[],epoch:2,knownObligations:[]});
    await expect(run(service.inspect(String(industryMeaning.id),end,ctx))).rejects.toThrow();
    await expect(run(service.inspect(String(usMeaning2.id),end,ctx))).rejects.toThrow();
  } finally { await f.close(); }
});
