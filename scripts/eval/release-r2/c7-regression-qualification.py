"""本批C7的空断言、跳过、加载错误不能取得新增回归资格。各固定重复5次。"""
from pathlib import Path
import base64
import datetime
import hashlib
import importlib.util
import json
import sys
import time
sys.dont_write_bytecode = True
from sandbox import Sandbox,save
from observations import observe,regression_valid

spec=importlib.util.spec_from_file_location('grade_artifact',Path(__file__).with_name('grade-artifact.py'))
grade=importlib.util.module_from_spec(spec);spec.loader.exec_module(grade)
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];assert revision.isalnum()
auth=json.loads((study/'authorization.json').read_text());assert auth['T1']is None
assert datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(auth['preparationDeadline'])
out=study/('c7-regression-qualification-'+revision);out.mkdir();rows=[]
sources=[Path(__file__),*[Path(__file__).with_name(n) for n in ['sandbox.py','restore.mjs','capture.mjs','observations.py','bun-report.py','bun-observer.ts','grade-artifact.py','inputs.py']],*Path(__file__).with_name('reporters').glob('*')]
sources=[p for p in sources if p.is_file()];frozen={str(p):hashlib.sha256(p.read_bytes()).hexdigest()for p in sources};save(out/'source-hashes.json',frozen);(out/'sources').mkdir()
for p in sources:(out/'sources'/frozen[str(p)]).write_bytes(p.read_bytes())
for task_id in ['C7-L','C7-O']:
 task=study/'c7'/task_id;profile=json.loads((task/'qualification-profile.json').read_text());manifest=json.loads((task/'input-manifest.json').read_text());initial=grade.source_files(task,manifest);patch=json.loads((task/'reference-patch.json').read_text());path=profile['regressionPaths'][0]
 for kind in ['vacuous','skipped','bad-import']:
  prefix="import {test,expect}from'bun:test';\n"if task_id=='C7-O'else''
  code=prefix+({'vacuous':"test('空断言',()=>expect(true).toBe(true));\n",'skipped':"test.skip('跳过',()=>expect(true).toBe(true));\n",'bad-import':"import{missing}from'./missing-qualification-module';test('加载错误',()=>expect(missing).toBe(true));\n"}[kind])
  for repeat in range(1,6):
   deadline=time.monotonic()+720;pair=[];case=out/f'{task_id}-{kind}-{repeat}';case.mkdir()
   for role in ['initial','reference']:
    files=dict(initial)
    if role=='reference':
     for n,value in patch.items():files[n]={'type':'file','mode':initial.get(n,{}).get('mode',0o644),'data':base64.b64encode(value.encode()).decode()}
    files[path]={'type':'file','mode':0o644,'data':base64.b64encode(code.encode()).decode()}
    with Sandbox(study,task,profile,case/role,deadline,files)as env:
     process=env.run(profile['commands'][0]);assert not process['timedOut'] and (process['code']==0 or kind=='bad-import')
     step=next(x for x in profile['commands']if x['label']=='regression');process=env.run(step);assert not process['timedOut']
     try:report=grade.native(env.case,step['label'],step['framework'],process['code'])
     except(ValueError,KeyError,OSError)as error:report={'passed':False,'behaviorFailure':False,'error':str(error),'tests':0,'skips':[]}
     save(env.case/'observation.json',report);pair.append(report)
   valid=regression_valid(*pair);assert not valid,(task_id,kind,repeat)
   row={'task':task_id,'kind':kind,'repeat':repeat,'passed':True,'regressionValid':valid,'observations':[{k:v for k,v in p.items()if k in ['tests','passed','behaviorFailure','error']}for p in pair]};rows.append(row);save(case/'result.json',row);save(out/'results.json',{'qualified':False,'rows':rows});print(json.dumps(row),flush=True)
assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in frozen.items())
save(out/'results.json',{'qualified':len(rows)==30,'facilityStable':True,'rows':rows})
