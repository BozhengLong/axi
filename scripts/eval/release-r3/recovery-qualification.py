"""两条实际CLI模拟恢复链：健康目标补齐与普通任务第二次尝试。固定冷却真实等待。"""
from pathlib import Path
import datetime as dt,hashlib,json,os,subprocess,sys,time
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];out=study/('recovery-chains-'+revision);out.mkdir()
env={**os.environ,'ANTHROPIC_API_KEY':'synthetic-local-key','ANTHROPIC_BASE_URL':'http://127.0.0.1:1','AXI_EVAL_IMAGE':'sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','PYTHONDONTWRITEBYTECODE':'1'}
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
read=lambda p:json.loads(Path(p).read_text())
def save(name,data):
    with(out/name).open('x')as f:json.dump(data,f,ensure_ascii=False,indent=2);f.write('\n')
def call(label,action,payload):
    r=subprocess.run(['python3',str(HERE/'controller-gateway.py')],input=json.dumps({'study':str(study),'mode':'mock','action':action,'payload':{'ledgerLabel':label,**payload}}),env=env,text=True,capture_output=True,timeout=120)
    assert r.returncode==0,r.stderr;return json.loads(r.stdout)
def run(label,args):
    save(label+'.command.json',args)
    with(out/(label+'.stdout')).open('xb')as o,(out/(label+'.stderr')).open('xb')as e:r=subprocess.run(args,env=env,stdout=o,stderr=e,timeout=1200)
    assert r.returncode==0,label
chains=[]
for task in ['health','U02']:
    label='recovery-interrupt-'+task.lower()+'-'+revision
    run(label,['bun',str(HERE/'recovery-interruption.ts'),str(study),label,task])
    state=call(label,'status',{})['state'];target=read(study/label/'controller-claim.json')['id'];claim=state['claims'][target]
    assert claim['review']['classification']=='ENV_INTERRUPTED'
    incident={'target':target,'externalEvidenceHash':claim['review']['externalEvidenceHash'],'mockOnly':True};save(task+'-incident.json',incident)
    recovery=call(label,'environment-begin',{'target':target,'incident':{'path':str((out/(task+'-incident.json')).relative_to(study)),'sha256':sha(out/(task+'-incident.json'))}})['recovery']
    save(task+'-recovery-begin.json',recovery);chains.append({'task':task,'label':label,'target':target,'recovery':recovery,'originalSeal':claim['seal'],'originalReview':claim['review']})
save('waiting.json',{'chains':chains,'startedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'cooldownSeconds':900})
while True:
    remaining=max(c['recovery']['cooldownUntil']for c in chains)-time.time()
    if remaining<=0:break
    print(json.dumps({'phase':'fixed-cooldown','remainingSeconds':round(remaining)}),flush=True);time.sleep(min(30,remaining))
rows=[]
for chain in chains:
    task=chain['task'];label=chain['label']
    for product in ['v0','v1','claude']:
        runid='recovery-'+task.lower()+'-'+product+'-'+revision
        run(runid,['bun',str(HERE/'claimed-pipeline.ts'),str(study),'health',product,runid,label])
    if task!='health':
        runid='recovery-'+task.lower()+'-attempt2-'+revision
        run(runid,['bun',str(HERE/'claimed-pipeline.ts'),str(study),task,'v1',runid,label])
    state=call(label,'status',{})['state'];original=state['claims'][chain['target']]
    assert original['seal']==chain['originalSeal'] and original['review']==chain['originalReview']
    assert state['activeRecovery'] is None and state['paused'] is None
    recovery=state['recoveries'][-1];assert recovery['completedAt'] and not recovery.get('failed')
    second=state['claims'][chain['target'].removesuffix('-a1')+'-a2'];assert second['review']['classification']=='PASS'
    actual=[c for c in state['claims'].values()if c.get('recovery')==0]
    assert len(actual)==(3 if task=='health'else 4)
    assert all(c['claimedAt']>=recovery['cooldownUntil']for c in actual)
    row={'task':task,'qualified':True,'label':label,'originalPreserved':True,'actualRecoveryCli':len(actual),'cooldownSeconds':recovery['cooldownUntil']-recovery['startedAt'],'recovery':recovery,'secondAttempt':second['id'],'ledger':str((study/'controller-integration'/label/'controller-events.jsonl').relative_to(study))}
    rows.append(row);save(task+'-result.json',row)
save('result.json',{'qualified':True,'nativeIntegrationQualified':True,'mockOnly':True,'realModelStarts':0,'chains':rows,'interruptedCli':2,'recoveryCli':7,'recoveryChains':2})
print(json.dumps({'qualified':True,'actualCli':9,'mockOnly':True}),flush=True)
