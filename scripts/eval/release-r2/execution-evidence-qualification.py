"""重验本批50份旧模拟Trace，并在独立副本注入完整性/请求口径错误。"""
from pathlib import Path
import copy,hashlib,importlib.util,json,shutil,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('execution_evidence',Path(__file__).with_name('execution-evidence.py'));evidence=importlib.util.module_from_spec(spec);spec.loader.exec_module(evidence)
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];assert revision.isalnum();out=study/('execution-evidence-qualification-'+revision);out.mkdir();source=json.loads((study/'c2-adapter-cli-3/summary.json').read_text());batch=Path(source['directory']);rows=[]
def save(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
for n in ['execution-evidence.py',Path(__file__).name]:(out/n).write_bytes(Path(__file__).with_name(n).read_bytes())
for row in source['rows']:
 result=evidence.audit(batch/row['id'],limit=12,mock=True);rows.append({'id':row['id'],'kind':'old-trace-audit','passed':True,'result':result})
original=batch/'new-allow-1'
def rebind(root):
 run=root/original.name;manifest=json.loads((run/'trace-manifest.json').read_text())
 for entry in manifest['files']:
  p=run/entry['path'];entry['bytes']=p.stat().st_size;entry['sha256']=evidence.sha(p)
 save(run/'trace-manifest.json',manifest)
 seals=json.loads((root/'sealed-traces.json').read_text())
 for seal in seals['seals']:
  if seal['id']==run.name:seal['manifestHash']=evidence.sha(run/'trace-manifest.json')
 save(root/'sealed-traces.json',seals)

for kind in ['changed-api','missing-native','unsealed-manifest','writer-not-closed','wrong-model','wrong-effort','wrong-response-model','wrong-budget','partial-jsonl','duplicate-sequence','blocked-distinct','count-tokens-distinct']:
 for repeat in range(1,6):
  root=out/f'{kind}-{repeat}';root.mkdir();run=root/original.name;shutil.copytree(original,run);(root/'relay').mkdir();relay=root/'relay'/f'{original.name}.jsonl';shutil.copyfile(batch/'relay'/relay.name,relay)
  for name in ['relay-closed.json','sealed-traces.json']:shutil.copyfile(batch/name,root/name)
  events=evidence.lines(relay);execution=json.loads((run/'execution.json').read_text());limit=12
  if kind=='changed-api':relay.write_text(relay.read_text()+'{}\n')
  elif kind=='missing-native':(run/'native/manifest.json').unlink()
  elif kind=='unsealed-manifest':
   p=run/'trace-manifest.json';v=json.loads(p.read_text());v['unsealedChange']=True;save(p,v)
  elif kind=='writer-not-closed':
   p=root/'relay-closed.json';v=json.loads(p.read_text());v['exitCode']=1;save(p,v)
  else:
   if kind in ['wrong-model','wrong-effort']:
    request=next(e for e in events if e['kind']=='request'and e['data']['path']=='/v1/messages')['data']['body']
    if kind=='wrong-model':request['model']='wrong-model'
    else:request['output_config']['effort']='high'
   elif kind=='wrong-response-model':next(e for e in events if e['kind']=='complete_response')['data']['model']='wrong'
   elif kind=='wrong-budget':execution['proxy']['budget']['generationRequests']+=1
   elif kind=='duplicate-sequence':
    requests=[e for e in events if e['kind']=='request'];requests[-1]['data']['sequence']=requests[0]['data']['sequence']
   elif kind=='blocked-distinct':
    b=execution['proxy']['budget'];limit=b['generationRequests'];b['maxTotal']=limit;b['generationRequests']+=1;b['roundRequests']+=1;b['requests']+=1;execution['status']='budget_exhausted';execution['proxy']['faults']=['request_budget'];events.append({'time':events[-1]['time'],'kind':'budget_exhausted','data':copy.deepcopy(b)})
   elif kind=='count-tokens-distinct':
    b=execution['proxy']['budget'];b['requests']+=1;b['countRequests']+=1;events.append({'time':events[-1]['time'],'kind':'request','data':{'sequence':b['requests'],'round':1,'path':'/v1/messages/count_tokens','body':{'model':'claude-opus-5-5'}}})
   relay.write_text(''.join(json.dumps(e)+'\n'for e in events));save(run/'execution.json',execution)
   if kind=='partial-jsonl':relay.write_text(relay.read_text().rstrip('\n'))
   rebind(root)
  expected=kind in ['blocked-distinct','count-tokens-distinct'];result=None
  try:result=evidence.audit(run,limit=limit,mock=True);accepted=True
  except(ValueError,KeyError,OSError)as error:accepted=False;result={'error':str(error)}
  assert accepted==expected,(kind,result)
  if kind=='blocked-distinct':assert result['receivedGeneration']==6 and result['forwardedGeneration']==5 and result['blockedGeneration']==1
  if kind=='count-tokens-distinct':assert result['forwardedGeneration']==5 and result['countTokens']==1 and result['receivedAttempts']==6
  row={'kind':kind,'repeat':repeat,'passed':True,'accepted':accepted,'syntheticRebinding':True,'result':result};rows.append(row);save(root/'result.json',row)
save(out/'results.json',{'qualified':True,'oldTraceAudits':50,'syntheticCases':60,'realModelStarts':0,'rows':rows});print(json.dumps({'qualified':True,'oldTraceAudits':50,'syntheticCases':60}))
