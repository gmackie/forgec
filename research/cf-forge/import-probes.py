from pathlib import Path
import subprocess,json,time
root=Path(__file__).parent;binary=Path('target/debug/forgec').resolve();results=[]
for name in ['cloudflare','github']:
 out=root/'.cache'/('import-'+name)
 started=time.monotonic();p=subprocess.run([str(binary),'import-openapi',str(root/'fixtures'/(name+'.json')),'--package','@research/'+name,'--out',str(out)],capture_output=True,text=True)
 row={'name':name,'exit':p.returncode,'seconds':time.monotonic()-started,'stdout':p.stdout,'stderr':p.stderr}
 if (out/'import-report.json').exists():
  report=json.loads((out/'import-report.json').read_text());(root/'results'/(name+'-import-report.json')).write_text(json.dumps(report,indent=2)+'\n');row['operations']=report['operations'];row['unsupportedCount']=len(report['unsupported'])
 if p.returncode==0:
  q=subprocess.run([str(binary),'check',str(out)],capture_output=True,text=True);row['check']={'exit':q.returncode,'stdout':q.stdout,'stderr':q.stderr}
 results.append(row)
(root/'results/import-probes.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results,indent=2))
