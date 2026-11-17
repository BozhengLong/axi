"""逐条重读65份封存证据、完整题面、评分与账本，不能只接受队列退出码。"""
from pathlib import Path
import hashlib,importlib.util,json,subprocess,sys,datetime as dt
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sys.path.append(str(HERE.parent/'release-r2'))
from inputs import verify_initial
def module(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
execution=module('execution_evidence',HERE/'execution-evidence.py');gateway=module('gateway',HERE/'controller-gateway.py')
read=lambda p:json.loads(Path(p).read_text())
def sha(p):
    with Path(p).open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];out=study/('pipeline-audit-'+revision);out.mkdir()
queue=read(study/('pipeline-queue-'+revision)/'result.json');assert queue['qualified'] and len(queue['rows'])==65
rows=[]
for q in queue['rows']:
    task,product=q['task'],q['product'];root=study/'health'if task=='health'else study/('c7'if task.startswith('C7-')else'tasks')/task
    directory=root/('pipeline-'+product+'-'+revision);result=read(directory/'result.json')
    assert result['qualified'] and result['mockOnly'] and result['task']==task and result['product']==product
    f=read(directory/'facility.json');v=read(directory/'facility-verification.json');assert v['stable'] and v['sourceHash']==f['sourceHash']
    for entry in f['records']:
        assert sha(entry['path'])==entry['sha256'] and sha(directory/'facility-source'/entry['sha256'])==entry['sha256'],'CLI资格后设施改变: '+entry['path']
    verify_initial(root/'initial',read(root/'input-manifest.json'))
    trace=Path(result['traceDirectory']);observed=execution.audit(trace,mock=True);assert observed==read(directory/'execution-evidence.json')
    entered=json.loads(subprocess.check_output(['python3',str(HERE/'input-evidence.py'),str(trace),str(directory/'prompt.json'),'--require-document']))
    assert entered==read(directory/'input-evidence.json')
    grade=read(directory/'final-grade/result.json');assert grade['automaticChecksPassed'] and grade['gradeStatus']=='complete'
    assert read(directory/'cleanup.json')['complete']
    label=f'{task.lower()}-{product}-{revision}';state,h=gateway.read_state(study/'controller-integration'/label)
    claim=read(directory/'controller-claim.json');actual=state['claims'][claim['id']]
    assert actual['review']['classification']=='PASS' and actual['seal']['executionHash']==observed['executionHash']
    assert bool(result['checkpointCaptured'])==(product=='v1')
    row={'task':task,'product':product,'qualified':True,'result':{'path':str((directory/'result.json').relative_to(study)),'sha256':sha(directory/'result.json')},'traceHash':observed['traceHash'],'executionHash':observed['executionHash'],'completeDocumentSeen':True,'ledgerHash':h,'files':observed['files']};rows.append(row)
    print(json.dumps({'task':task,'product':product,'verified':True}),flush=True)
result={'qualified':True,'mockOnly':True,'realModelStarts':0,'cases':len(rows),'taskCases':60,'c7Cases':2,'healthCases':3,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'rows':rows}
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
