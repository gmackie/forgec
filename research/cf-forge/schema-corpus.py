from pathlib import Path
import json,subprocess
root=Path(__file__).parent
schemas={
 'string':{'type':'string'},'optional-null-31':{'type':['string','null']},'nullable-30':{'type':'string','nullable':True},'array':{'type':'array','items':{'type':'string'},'maxItems':10},'map':{'type':'object','additionalProperties':{'type':'string'}},'union':{'oneOf':[{'type':'string'},{'type':'integer'}]},'negative-minimum':{'type':'number','minimum':-1},'decimal':{'type':'string','pattern':'^[0-9]+\\.[0-9]{2}$'},'enum':{'type':'string','enum':['a','b']},'recursive':{'$ref':'#/components/schemas/Recursive'},'binary':{'type':'string','format':'binary'}}
rows=[]
for name,field in schemas.items():
 response={'description':'OK','content':{'application/json':{'schema':{'type':'object','properties':{'id':{'type':'string'}}}}}}
 body={'required':True,'content':{'application/json':{'schema':{'type':'object','properties':{'value':field}}}}}
 op={'operationId':'CreateItem','requestBody':body,'responses':{'200':response}}
 components={'schemas':{}}
 if name=='recursive':components['schemas']['Recursive']={'type':'object','properties':{'next':{'$ref':'#/components/schemas/Recursive'}}}
 doc={'openapi':'3.0.3' if name=='nullable-30' else '3.1.0','info':{'title':name,'version':'1.0.0'},'servers':[{'url':'https://vendor.example'}],'components':components,'paths':{'/items':{'post':op}}}

 folder=root/'.cache'/'corpus';folder.mkdir(exist_ok=True);spec=folder/(name+'.json');spec.write_text(json.dumps(doc))
 out=folder/name;p=subprocess.run(['target/debug/forgec','import-openapi',str(spec),'--package','@corpus/'+name,'--out',str(out)],capture_output=True,text=True,timeout=20)
 row={'case':name,'schema':field,'importExit':p.returncode}
 if p.returncode==0:
  report=json.loads((out/'import-report.json').read_text());row['unsupported']=report['unsupported'];row['generated']=(out/'src/index.forge').read_text();q=subprocess.run(['target/debug/forgec','check',str(out)],capture_output=True,text=True,timeout=20);row['checkExit']=q.returncode;row['diagnostics']=q.stderr
 else:row['diagnostics']=p.stderr
 rows.append(row)
(root/'results/schema-corpus.json').write_text(json.dumps(rows,indent=2)+'\n');print([(r['case'],r['importExit'],r.get('checkExit'),len(r.get('unsupported',[]))) for r in rows])
