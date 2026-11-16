from pathlib import Path
import subprocess,json,os,sys,hashlib,importlib.util
sys.dont_write_bytecode=True
study=Path(sys.argv[1]).resolve();platform=sys.argv[2];revision=sys.argv[3]
assert platform in ('host','linux') and revision.isalnum()
out=study/('bun-observer-qualification-'+platform+'-'+revision);out.mkdir()
observer=Path(__file__).with_name('bun-observer.ts').resolve();reader=Path(__file__).with_name('bun-report.py')
spec=importlib.util.spec_from_file_location('bun_report',reader);report=importlib.util.module_from_spec(spec);spec.loader.exec_module(report)
for path in [Path(__file__),observer,reader]:(out/path.name).write_bytes(path.read_bytes())
(out/'source-hashes.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest()for p in [Path(__file__),observer,reader]},indent=2)+'\n')
image='sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1'
cases={
 'real-fail':("test('real',()=>expect(1).toBe(2));",1,[True]),
 'plain-fail':("test('plain',()=>{throw Error('AssertionError Expected:');});",1,[False]),
 'after-pass':("test('after',()=>{expect(1).toBe(1);throw Error('expected');});",1,[False]),
 'pass':("test('pass',()=>expect(1).toBe(1));",0,[]),
 'not':("test('not',()=>expect(1).not.toBe(1));",1,[True]),
 'async-matcher':("test('async',async()=>await expect(Promise.resolve(1)).resolves.toBe(2));",1,[True]),
 'async-plain':("test('async',async()=>{await Promise.resolve();throw Error('plain');});",1,[False]),
 'callback':("test('done',done=>{setImmediate(()=>done());});",0,[]),
 'each':("test.each([1,2])('each %i',value=>expect(value).toBe(3));",1,[True,True]),
 'custom-result':("expect.extend({toBeSeven(value){return{pass:value===7,message:()=> 'value must be seven'};}});test('custom',()=>expect(1).toBeSeven());",1,[True]),
 'custom-throw':("expect.extend({toBeSeven(){throw Error('Expected: 7');}});test('custom',()=>expect(1).toBeSeven());",1,[False]),
 'skip':("test.skip('skip',()=>expect(1).toBe(2));",0,[]),
 'vacuous':("test('vacuous',()=>{});",0,[]),
 'done-null':("test('done',done=>setImmediate(()=>done(null)));",0,[]),
 'throw-undefined':("test('undefined',()=>{throw undefined;});",1,[False]),
 'async-undefined':("test('undefined',async()=>{throw undefined;});",1,[False]),
 'node-assert':("import assert from 'node:assert/strict';test('node',()=>assert.equal(1,2));",1,[True]),
 'node-plain':("import assert from 'node:assert/strict';test('node',()=>{assert.equal(1,1);throw Object.assign(Error('AssertionError'),{code:'ERR_ASSERTION',actual:1,expected:2});});",1,[False]),
 'node-async':("import assert from 'node:assert/strict';test('node',async()=>await assert.rejects(Promise.resolve(1)));",1,[True]),
 'import-error':("import './missing-module';test('never',()=>expect(1).toBe(2));",1,[]),
}

rows=[]
for name,(code,expected,origins) in cases.items():
 for repeat in range(1,6):
  case=name+'-'+str(repeat);d=out/case;d.mkdir();(d/'case.test.ts').write_text("import {test,expect} from 'bun:test';\n"+code+'\n')
  if platform=='host':
   cmd=['/Users/spidey0o0zheng/.bun/bin/bun','test','--preload',str(observer),str(d/'case.test.ts'),'--reporter=junit','--reporter-outfile='+str(d/'native.xml')];environment={**os.environ,'AXI_BUN_ASSERTIONS_PATH':str(d/'assertions.jsonl')}
  else:
   cmd=['docker','run','--rm','--name','axi-r2-bun-'+case,'--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','--cpus','2','--memory','4g','--pids-limit','128','--tmpfs','/tmp:rw,size=128m','-v',str(d)+':/case','-v',str(observer)+':/observer.ts:ro','-e','AXI_BUN_ASSERTIONS_PATH=/case/assertions.jsonl','--entrypoint','bun',image,'test','--preload','/observer.ts','/case/case.test.ts','--reporter=junit','--reporter-outfile=/case/native.xml'];environment=os.environ.copy()
  (d/'command.json').write_text(json.dumps(cmd,indent=2)+'\n')
  with(d/'stdout').open('wb')as stdout,(d/'stderr').open('wb')as stderr:p=subprocess.run(cmd,stdout=stdout,stderr=stderr,env=environment,timeout=20)
  (d/'exit').write_text(str(p.returncode));events=[json.loads(x)for x in(d/'assertions.jsonl').read_text().splitlines()];ends=[x for x in events if x['kind']=='test-end'];actual=[x['assertionFailure']for x in ends if not x['passed']];native=report.parse(d/'native.xml',d/'assertions.jsonl',p.returncode)
  valid_native=(not native['trustworthy'])if name=='import-error'else native['trustworthy']
  row={'name':name,'repeat':repeat,'exit':p.returncode,'origins':actual,'expectedOrigins':origins,'passed':p.returncode==expected and actual==origins and valid_native,'report':native};rows.append(row);(d/'result.json').write_text(json.dumps(row,indent=2)+'\n');(out/'results.json').write_text(json.dumps({'qualified':False,'platform':platform,'rows':rows},indent=2)+'\n');assert row['passed'],row
 print(name,'5/5',flush=True)
# 缺观察、XML计数不符及普通异常不得成为有效反事实失败。
a=out/'real-fail-1';b=out/'pass-1';c=out/'after-pass-1'
positive=report.parse(a/'native.xml',a/'assertions.jsonl',1);current=report.parse(b/'native.xml',b/'assertions.jsonl',0);ordinary=report.parse(c/'native.xml',c/'assertions.jsonl',1)
assert report.regression_valid(positive,current) and not report.regression_valid(ordinary,current)
assert not report.parse(a/'native.xml',out/'missing-observer',1)['trustworthy']
changed=out/'wrong-count.xml';changed.write_text((a/'native.xml').read_text().replace('tests="1"','tests="2"',1));assert not report.parse(changed,a/'assertions.jsonl',1)['trustworthy']
for source,digest in json.loads((out/'source-hashes.json').read_text()).items():assert hashlib.sha256(Path(source).read_bytes()).hexdigest()==digest
(out/'results.json').write_text(json.dumps({'qualified':True,'platform':platform,'rows':rows,'additionalConsistencyChecks':4,'limits':'assertion provenance and count consistency; semantic relevance still needs review'},indent=2)+'\n')
print('qualified',len(rows),'plus consistency checks',flush=True)
