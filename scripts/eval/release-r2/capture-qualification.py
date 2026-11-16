"""在固定Linux卷验证快照的大小写、模式、链接、独立暂停读取和拒绝边界。"""
from pathlib import Path
import base64,datetime,hashlib,importlib.util,json,subprocess,sys,time
sys.dont_write_bytecode=True
from sandbox import Sandbox,save,HERE
spec=importlib.util.spec_from_file_location('grade_artifact',HERE/'grade-artifact.py');grader=importlib.util.module_from_spec(spec);spec.loader.exec_module(grader)
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];assert revision.isalnum();auth=json.loads((study/'authorization.json').read_text());assert auth['T1']is None
assert datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(auth['preparationDeadline'])
out=study/('capture-qualification-'+revision);out.mkdir();task=study/'tasks/T02';profile=json.loads((task/'qualification-profile.json').read_text());manifest=json.loads((task/'input-manifest.json').read_text());initial=grader.source_files(task,manifest);rows=[]
source_names=['capture.mjs','restore.mjs','sandbox.py','inputs.py',Path(__file__).name];frozen={n:hashlib.sha256((HERE/n).read_bytes()).hexdigest()for n in source_names};save(out/'source-hashes.json',frozen)
for n in source_names:(out/n).write_bytes((HERE/n).read_bytes())
file=lambda data,mode=0o644:{'type':'file','mode':mode,'data':base64.b64encode(data).decode()}
for repeat in range(1,6):
 files={**initial,'Case.txt':file(b'UPPER'),'case.txt':file(b'lower'),'private.bin':file(b'\x00\xff\n',0o600),'executable.sh':file(b'exit 0\n',0o755),'dangling':{'type':'symlink','target':'absent-target','mode':0o777}}
 with Sandbox(study,task,profile,out/f'roundtrip-{repeat}',time.monotonic()+120,files)as env:
  before=env.capture('first');assert {k:v for k,v in before['files'].items()if v['type']!='directory'}==files
  env.checked(['docker','pause',env.name],'manual-pause',5)
  try:
   command=['docker','run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','--memory','512m','--tmpfs','/tmp:rw,size=64m','-v',env.volume+':/task:ro','-v',str(HERE/'capture.mjs')+':/capture.mjs:ro','--entrypoint','node',profile['image'],'/capture.mjs']
   env.checked(command,'paused-first',30);env.checked(command,'paused-second',30)
   assert json.loads((env.case/'paused-first.stdout').read_text())==json.loads((env.case/'paused-second.stdout').read_text())
   env.checked(['docker','inspect',env.name,'--format','{{.State.Paused}}'],'paused-state',5);assert(env.case/'paused-state.stdout').read_text().strip()=='true'
  finally:env.checked(['docker','unpause',env.name],'manual-unpause',5)
  row={'case':'linux-roundtrip-and-paused-read','repeat':repeat,'passed':True,'files':len(before['files'])};rows.append(row)
 for kind,code in [('git-symlink',"fs.renameSync('/task/.git','/task/git-original');fs.symlinkSync('git-original','/task/.git');"),('oversize',"fs.closeSync(fs.openSync('/task/oversize','w'));fs.truncateSync('/task/oversize',129*1024*1024);")]:
  with Sandbox(study,task,profile,out/f'{kind}-{repeat}',time.monotonic()+120,initial)as env:
   env.checked(['docker','exec',env.name,'node','-e',"const fs=require('node:fs');"+code],'mutate',10)
   try:env.capture('invalid')
   except RuntimeError as error:
    assert 'invalid-capture'in str(error);assert(env.case/'invalid-capture.process.json').exists();assert json.loads((env.case/'invalid-capture.process.json').read_text())['code']!=0
   else:raise AssertionError('invalid snapshot accepted')
  rows.append({'case':kind,'repeat':repeat,'passed':True})
 save(out/'results.json',{'qualified':False,'rows':rows});print(json.dumps({'repeat':repeat,'checks':len(rows),'passed':True}),flush=True)
assert all(hashlib.sha256((HERE/n).read_bytes()).hexdigest()==h for n,h in frozen.items())
save(out/'results.json',{'qualified':True,'checks':len(rows),'sourceStable':True,'rows':rows,'limits':'capture.ts actual runtime integration remains in the 62 CLI pipelines'})
