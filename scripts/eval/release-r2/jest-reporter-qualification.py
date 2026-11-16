from pathlib import Path
import sys,subprocess,json,hashlib
s=Path(sys.argv[1]).resolve(); r=Path(__file__).parent/'reporters';out=s/'jest-reporter-qualification-3';out.mkdir();fixtures=out/'fixtures';fixtures.mkdir()
cases={'pass':"test('pass',()=>expect(2+2).toBe(4))",'assertion':"test('assertion',()=>expect(2+2).toBe(5))",'throw':"test('ordinary',()=>{throw new Error('ordinary')})",'fake-assertion-word':"test('word',()=>{throw new Error('ERR_ASSERTION')})",'import':"require('./missing-module.cjs')",'syntax':"const ???",'skip':"test.skip('skipped',()=>{})",'todo':"test.todo('later')",'empty':"// empty",'timeout':"test('wait',()=>new Promise(()=>{}),10)",'hook-error':"beforeAll(()=>{throw new Error('hook')});test('never',()=>{})"}
for k,v in cases.items():(fixtures/(k+'.test.cjs')).write_text(v)
(fixtures/'jest.config.cjs').write_text("module.exports={rootDir:'/fixtures',testRegex:'.*\\\\.test\\\\.cjs$',testEnvironment:'node',transform:{}};\n")
h=hashlib.sha256((r/'jest.cjs').read_bytes()).hexdigest();(out/'jest.cjs').write_bytes((r/'jest.cjs').read_bytes());(out/'plan.json').write_text(json.dumps({'repeats':5,'cases':cases,'reporterHash':h},indent=2));rows=[]
for label in cases:
 for repeat in range(1,6):
  d=out/f'{label}-{repeat}';d.mkdir();cmd=['docker','run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','--cpus','2','--memory','4g','--pids-limit','256','--tmpfs','/tmp:rw,size=64m','-e','HOME=/tmp','-e','AXI_RESULT_PATH=/evidence/native.json','-v',str(s/'task-selection/sources/fast-csv/node_modules')+':/task/node_modules:ro','-v',str(r)+':/reporters:ro','-v',str(fixtures)+':/fixtures:ro','-v',str(d)+':/evidence','-w','/fixtures','--entrypoint','node','sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','/task/node_modules/jest/bin/jest.js','--runInBand','--config=/fixtures/jest.config.cjs','--reporters=/reporters/jest.cjs','--runTestsByPath','/fixtures/'+label+'.test.cjs']
  (d/'command.json').write_text(json.dumps(cmd,indent=2));p=subprocess.run(cmd,capture_output=True,timeout=20);(d/'stdout').write_bytes(p.stdout);(d/'stderr').write_bytes(p.stderr);n=json.loads((d/'native.json').read_text()) if(d/'native.json').exists()else None
  c=n['counts']if n else {};tests=[x for suite in n['suites']for x in suite['tests']]if n else [];errors=[x for suite in n['suites']for test in suite['tests']for x in test['errors']]if n else []
  passed=bool(n and p.returncode==0 and not n['interrupted'] and c['numTotalTests']>0 and c['numPassedTests']==c['numTotalTests'] and not c['numFailedTests'] and not c['numPendingTests'] and not c['numTodoTests'] and not c['numRuntimeErrorTestSuites'] and all(x['status']=='passed'for x in tests))
  behavioral=bool(n and p.returncode==1 and c['numFailedTests']>0 and not c['numRuntimeErrorTestSuites'] and errors and all(x['assertion']for x in errors))
  assert passed==(label=='pass'),(label,p.returncode,n)
  assert behavioral==(label=='assertion'),(label,n)
  row={'case':label,'repeat':repeat,'qualified':True,'expectedSuccess':passed,'behaviorAssertion':behavioral,'counts':c};rows.append(row);(d/'result.json').write_text(json.dumps(row,indent=2));print(json.dumps(row),flush=True)
assert hashlib.sha256((r/'jest.cjs').read_bytes()).hexdigest()==h
(out/'results.json').write_text(json.dumps({'qualified':True,'cases':len(rows),'rows':rows},indent=2))
