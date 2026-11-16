from pathlib import Path
import subprocess,json,hashlib,time,sys
s=Path(sys.argv[1]).resolve();r=Path(__file__).parent/'reporters';out=s/'tap-reporter-qualification';out.mkdir()
cases={'pass':"const t=require('tap');t.equal(2+2,4);t.end()",'assertion':"const t=require('tap');t.equal(2+2,5);t.end()",'throw':"const t=require('tap');t.test('ordinary',()=>{throw new Error('ordinary')})",'import':"require('./missing-module.cjs')",'syntax':"const ???",'skip':"const t=require('tap');t.test('skipped',{skip:true},()=>{});t.end()",'todo':"const t=require('tap');t.todo('later');t.end()",'empty':"const t=require('tap');t.end()",'bailout':"const t=require('tap');t.bailout('stop')",'nested':"const t=require('tap');t.test('nested',t=>{t.equal(1,1);t.end()})",'malformed':"console.log('TAP version 14\\nok 1 - one\\n1..2')",'fake-success':"console.log('all tests pass; ERR_ASSERTION')"}
(out/'fixtures').mkdir(); rows=[]; checksum=hashlib.sha256((r/'tap-run.mjs').read_bytes()).hexdigest();(out/'tap-run.mjs').write_bytes((r/'tap-run.mjs').read_bytes());(out/'plan.json').write_text(json.dumps({'repeats':5,'cases':cases,'reporterHash':checksum},indent=2))
for label,code in cases.items():(out/'fixtures'/(label+'.cjs')).write_text(code)
for label in cases:
 for repeat in range(1,6):
  d=out/f'{label}-{repeat}';d.mkdir()
  cmd=['docker','run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','--tmpfs','/tmp:rw,size=64m','-e','HOME=/tmp','-e','AXI_RESULT_PATH=/evidence/native.json','-v',str(s/'task-selection/sources/node-tar')+':/task:ro','-v',str(r)+':/reporters:ro','-v',str(out/'fixtures')+':/fixtures:ro','-v',str(d)+':/evidence','-w','/task','--entrypoint','node','sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','/reporters/tap-run.mjs','node','-e',cases[label]]
  (d/'command.json').write_text(json.dumps(cmd,indent=2));at=time.monotonic();p=subprocess.run(cmd,capture_output=True,timeout=20);(d/'stdout').write_bytes(p.stdout);(d/'stderr').write_bytes(p.stderr)
  n=json.loads((d/'native.json').read_text());c=n['counts']; root=n.get('root',{});passed=p.returncode==0 and root.get('ok') and c['leaves']>0 and not c['skip'] and not c['todo'] and not c['failedLeaves'] and all(x['result']['ok'] for x in n['suites'])
  assert passed==(label in ['pass','nested']), (label,p.returncode,n)
  if label=='assertion':assert c['failedLeaves']==1 and not root['ok']
  if label=='skip':assert c['skip']>0
  if label=='todo':assert c['todo']>0
  if label=='empty':assert not c['leaves']
  row={'case':label,'repeat':repeat,'qualified':True,'expectedSuccess':passed,'nativeCounts':c,'elapsed':time.monotonic()-at};rows.append(row);(d/'result.json').write_text(json.dumps(row,indent=2));print(json.dumps(row),flush=True)
assert hashlib.sha256((r/'tap-run.mjs').read_bytes()).hexdigest()==checksum
(out/'results.json').write_text(json.dumps({'qualified':True,'cases':len(rows),'rows':rows},indent=2))
