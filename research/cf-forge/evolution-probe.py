"""Controlled vendor changes; these are synthetic changes to a pinned real spec."""
from pathlib import Path
import json
root=Path(__file__).parent
before=json.loads((root/'fixtures/github.json').read_text());after=json.loads(json.dumps(before));p='/repos/{owner}/{repo}/issues'
after['info']['version']='research-next'
after['paths'][p]['post']['x-fern-sdk-method-name']='openIssue'
after['paths'][p]['post']['requestBody']['content']['application/json']['schema']['properties']['research_note']={'type':'string','description':'Synthetic additive field for upgrade experiment.'}
(root/'.cache/github-next.json').write_text(json.dumps(after,indent=2)+'\n')
(root/'results/evolution-input.json').write_text(json.dumps({'kind':'synthetic vendor change on pinned GitHub schema','operationIdUnchanged':after['paths'][p]['post']['operationId'],'changes':['SDK presentation name create -> openIssue','optional body field research_note added'],'notClaimed':'No upstream release matrix or live GitHub compatibility claim'},indent=2)+'\n')
