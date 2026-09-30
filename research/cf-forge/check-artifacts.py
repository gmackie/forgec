from pathlib import Path
import hashlib,json
root=Path(__file__).parent

def hashes(folder):
 return {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.rglob('*') if p.is_file()}
a=hashes(root/'.cache/github-sdk/sdk');b=hashes(root/'.cache/github-sdk-repeat/sdk')
report={'identical':a==b,'fileCountFirst':len(a),'fileCountRepeat':len(b),'changed':[k for k in a if a[k]!=b.get(k)],'added':[k for k in b if k not in a]}
(root/'results/reproducibility.json').write_text(json.dumps(report,indent=2)+'\n')
assert a and a==b,report
for name in ['github','cloudflare']:
 m=json.loads((root/'.cache'/f'{name}-sdk/sdk/sdk-map.json').read_text())
 expected=next(f['operations'] for f in json.loads((root/'fixtures/provenance.json').read_text()) if f['name']==name)
 assert set(m)==set(expected),(name,m.keys(),expected)
print('Both operation maps cover the selected operations; repeated GitHub generation is byte-identical.')
