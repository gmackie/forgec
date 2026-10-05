"""Select operations and their complete local reference closure, without schema simplification."""
from pathlib import Path
import json,hashlib
root=Path(__file__).parent
sources=[('cloudflare','https://github.com/cloudflare/forge/releases/download/openapi%40e934edf0cddfc816c0a06cec0fabbff479424a1a/openapi.forge.json',{'/zones/{zone_id}/dns_records':['get','post']}),('github','https://raw.githubusercontent.com/github/rest-api-description/1d567e953615d18fc53cd847036489bcd8f7f00c/descriptions/api.github.com/api.github.com.json',{'/repos/{owner}/{repo}/issues':['get','post']})]
manifest=[]
for name,url,selected in sources:
 raw=(root/'.cache'/f'{name}.json').read_bytes();doc=json.loads(raw)
 out={k:doc[k] for k in ['openapi','info','servers','security'] if k in doc};out['paths']={p:{k:v for k,v in doc['paths'][p].items() if k in methods or k=='parameters'} for p,methods in selected.items()};out['components']={}
 refs=set()
 def walk(x):
  if isinstance(x,list):
   for v in x:walk(v)
  if not isinstance(x,dict):return
  if '$ref' in x:
   r=x['$ref']
   if not r.startswith('#/'):raise ValueError('external ref '+r)
   if r not in refs:
    refs.add(r);keys=[k.replace('~1','/').replace('~0','~') for k in r[2:].split('/')];v=doc
    for k in keys:v=v[k]
    dest=out
    for k in keys[:-1]:dest=dest.setdefault(k,{})
    dest[keys[-1]]=v;walk(v)
  for v in x.values():walk(v)
 # snapshot because walk extends components
 walk(json.loads(json.dumps(out)))
 if 'securitySchemes' in doc.get('components',{}):out['components']['securitySchemes']=doc['components']['securitySchemes']
 text=json.dumps(out,indent=2,sort_keys=True)+'\n';(root/'fixtures'/f'{name}.json').write_text(text)
 manifest.append({'name':name,'url':url,'sourceSha256':hashlib.sha256(raw).hexdigest(),'fixtureSha256':hashlib.sha256(text.encode()).hexdigest(),'selection':selected,'localRefs':len(refs),'license':doc['info'].get('license'),'transformation':'select paths/methods and transitive local refs; retain schemas unchanged','operations':[op['operationId'] for path in out['paths'].values() for op in path.values() if isinstance(op,dict) and 'operationId' in op]})
(root/'fixtures'/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
