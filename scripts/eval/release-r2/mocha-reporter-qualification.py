from pathlib import Path
import subprocess,json,hashlib,time,sys,re
s=Path(sys.argv[1]).resolve();r=Path(__file__).parent/'reporters'
repository=sys.argv[2] if len(sys.argv)>2 else 'node-fs-extra'
assert re.fullmatch(r'[a-z0-9-]+',repository)
out=s/('mocha-reporter-qualification-'+repository if len(sys.argv)>2 else 'mocha-reporter-qualification');out.mkdir()
cases={'pass':"it('pass',()=>require('node:assert/strict').equal(2+2,4))",'assertion':"it('assertion',()=>require('node:assert/strict').equal(2+2,5))",'throw':"it('ordinary',()=>{throw new Error('ordinary')})",'fake-assertion-word':"it('word',()=>{throw new Error('ERR_ASSERTION')})",'import':"require('./missing-module.cjs')",'syntax':"const ???",'skip':"it.skip('skipped',()=>{})",'todo':"it('later')",'empty':"// empty",'timeout':"it('wait',function(done){this.timeout(10)})",'hook-error':"before(()=>{throw new Error('hook')});it('never',()=>{})"}
(out/'fixtures').mkdir(); rows=[]; checksum=hashlib.sha256((r/'mocha.cjs').read_bytes()).hexdigest();(out/'mocha.cjs').write_bytes((r/'mocha.cjs').read_bytes());(out/'plan.json').write_text(json.dumps({'repeats':5,'cases':cases,'reporterHash':checksum},indent=2))
for label,code in cases.items():(out/'fixtures'/(label+'.cjs')).write_text(code)
for label in cases:
 for repeat in range(1,6):
  d=out/f'{label}-{repeat}';d.mkdir()
  cmd=['docker','run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','--tmpfs','/tmp:rw,size=64m','-e','HOME=/tmp','-e','AXI_RESULT_PATH=/evidence/native.json','-v',str(s/'task-selection/sources'/repository)+':/task:ro','-v',str(r)+':/reporters:ro','-v',str(out/'fixtures')+':/fixtures:ro','-v',str(d)+':/evidence','-w','/task','--entrypoint','node','sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','node_modules/mocha/bin/mocha.js','--reporter','/reporters/mocha.cjs','/fixtures/'+label+'.cjs']
  (d/'command.json').write_text(json.dumps(cmd,indent=2));at=time.monotonic();p=subprocess.run(cmd,capture_output=True,timeout=20);(d/'stdout').write_bytes(p.stdout);(d/'stderr').write_bytes(p.stderr)
  n=json.loads((d/'native.json').read_text())if(d/'native.json').exists()else None
  passed=n is not None and p.returncode==0 and n['stats']['tests']>0 and not n['pending'] and not n['failures'] and n['stats']['passes']==n['stats']['tests']
  behavioral=n is not None and p.returncode==1 and bool(n['failures']) and all(x['error']['assertion'] and not x['hook'] for x in n['failures'])
  assert passed==(label=='pass'),(label,p.returncode,n)
  assert behavioral==(label=='assertion'),(label,n)
  row={'case':label,'repeat':repeat,'qualified':True,'expectedSuccess':passed,'behaviorAssertion':behavioral,'nativeStats':n['stats'] if n else None,'elapsed':time.monotonic()-at};rows.append(row);(d/'result.json').write_text(json.dumps(row,indent=2));print(json.dumps({'case':label,'repeat':repeat,'qualified':True}),flush=True)
assert hashlib.sha256((r/'mocha.cjs').read_bytes()).hexdigest()==checksum
(out/'results.json').write_text(json.dumps({'qualified':True,'cases':len(rows),'rows':rows},indent=2))
