"""将参考补丁经Linux快照再评分，检验新评分链路；不计模型成绩。"""
from pathlib import Path
import base64,datetime,importlib.util,json,subprocess,sys,time
sys.dont_write_bytecode=True
from sandbox import Sandbox,save,HERE
spec=importlib.util.spec_from_file_location('grade_artifact',HERE/'grade-artifact.py');grader=importlib.util.module_from_spec(spec);spec.loader.exec_module(grader)
study=Path(sys.argv[1]).resolve();task_id=sys.argv[2];revision=sys.argv[3];assert revision.isalnum()
auth=json.loads((study/'authorization.json').read_text());assert auth['T1']is None
assert datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(auth['preparationDeadline'])
task=study/('c7'if task_id.startswith('C7-')else'tasks')/task_id;out=task/('grading-development-'+revision);out.mkdir();profile=json.loads((task/'qualification-profile.json').read_text());manifest=json.loads((task/'input-manifest.json').read_text());files=grader.source_files(task,manifest)
subprocess.run([sys.executable,str(HERE/'prepare-grading-profile.py'),str(study),task_id],check=True)
patch=json.loads((task/(profile['references'][0]+'-patch.json')).read_text())
for n,text in patch.items():files[n]={'type':'file','mode':files.get(n,{}).get('mode',0o644),'data':base64.b64encode(text.encode()).decode()}
with Sandbox(study,task,profile,out/'capture',time.monotonic()+120,files)as env:
 snapshot=env.capture('reference')
artifact=out/'reference-snapshot.json';save(artifact,snapshot)
result=grader.grade(study,task_id,artifact,out/'grade',720);print(json.dumps(result));assert result['automaticChecksPassed'],result
