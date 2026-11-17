"""只用合成见证验证R3状态机；不创建真实模型额度或运行模型。"""
from pathlib import Path
import copy
import hashlib
import datetime as dt
import json
import sys
import tempfile
from controller import new_state, transition, slots, next_slot, assessed, decisive_failure, remaining_window, Ledger, digest, Refused, HOUR

out = Path(sys.argv[1]);out.mkdir()
checks = []


def check(name, action, refused=False):
    try:
        action()
        assert not refused, '应拒绝但接受'
        checks.append(dict(name=name, passed=True, expectedRefusal=refused))
    except Refused:
        assert refused, name
        checks.append(dict(name=name, passed=True, expectedRefusal=True))
    (out/'checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2)+'\n')


class Run:
    def __init__(self):
        self.now = 1800000000.0
        iso = lambda seconds: dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat()
        self.auth = dict(T0=iso(self.now), preparationDeadline=iso(self.now+72*HOUR), absoluteDeadline=iso(self.now+168*HOUR), T1=None, maximumRealCli=73, limitMode='unlimited', requestLimit=None)
        self.identity = dict(candidate='synthetic-candidate', sourceHash='synthetic-source', v0='fixed-v0', image='fixed-image', model='fixed-model', claude='fixed-cli')
        self.state = new_state(self.auth, self.identity)
        tasks = [dict(id=f'U{i+1:02}', category='R'+str(i%4+1), admitted=True, manifestHash=digest(i), repository='repo-'+str(i%8), userDirty=i<10, productionDirty=i<4, asyncBehavior=i<8) for i in range(20)]
        self.manifest = dict(identities=self.identity, qualificationComplete=True, remoteCommit='fixed-F', commit='fixed-F', executionPolicy=dict(version='r3',limitMode='unlimited',requestLimit=None), tasks=tasks)
        self.manifest.update({k:digest(k) for k in ('engineeringHash','c7QualificationHash','controllerQualificationHash','facilityHash','dependencyHash','evidenceAuditHash','reuseAuditHash')})
        self.apply('freeze', self.manifest);self.apply('begin', {})

    def apply(self, action, payload):
        self.state = transition(self.state, action, payload, self.now)
        return self.state

    def claim(self):
        slot=next_slot(self.state,self.now)
        payload=dict(id=slot['id'], attempt=slot['attempt'], identities=self.identity, manifestHash=digest(self.manifest), facilityHash=self.manifest['facilityHash'], limitMode='unlimited',requestLimit=None)
        self.apply('claim',payload)
        return slot['id']

    def complete(self, classification='PASS', clean=True, forwarded=10000):
        id=self.claim();self.apply('launched',dict(id=id,processIdentity='synthetic-pid'))
        self.now+=2
        artifact=digest(id+'/artifact');execution=digest(id+'/execution')
        seal=dict(id=id,candidate=self.identity['candidate'],writersClosed=True,manifestVerified=True,traceHash=digest(id+'/trace'),artifactHash=artifact,executionHash=execution,cleanupHash=digest(id+'/clean'),forwardedGeneration=forwarded,receivedAttempts=forwarded,countTokens=0,endedAt=self.now,gradeSeconds=1,views=[dict(id=id+'/final',kind='final',artifactHash=artifact)],termination='upstream_interrupted' if classification=='ENV_INTERRUPTED' else 'completed')
        self.apply('seal',seal);self.now+=1
        review=dict(id=id,artifactHash=artifact,executionHash=execution,gradeHash=digest(id+'/grade'),reviewEvidenceHash=digest(id+'/review'),reviewer='synthetic-reviewer',classification=classification,allChecksPassed=classification=='PASS',cleanUpstream=clean)
        if classification=='ENV_INTERRUPTED':review.update(externalCauseConfirmed=True,externalEvidenceHash=digest(id+'/external'),protectionReviewed=True,confirmedH=False)
        if classification=='H':review.update(criticalClause='H2',violationEvidenceHash=digest(id+'/H'))
        self.apply('review',review)
        return id

    def advance(self,n):
        for _ in range(n):self.complete()

    def recover(self,id):
        return self.apply('environment-begin',dict(target=id,incidentHash=digest(id+'/incident'),externalEvidenceHash=self.state['claims'][id]['review'].get('externalEvidenceHash',digest('missing'))))


def normal():
    r=Run();assert abs((remaining_window(r.state,r.now)+2*HOUR)/HOUR-90.9)<1e-9
    r.advance(65);assert len(r.state['claims'])==65 and len(assessed(r.state))==65
    r.apply('close',dict(verdict='GO',allGatesPassed=True,reportHash=digest('report'),cleanupHash=digest('clean')))
    assert r.state['closure']['verdict']=='GO'
    check('关闭后不能重开',lambda:r.apply('begin',{}),True)
check('65槽完整成功，可超过3136请求且按90.9小时预留',normal)

r=Run();first=r.claim();check('未审查上一claim不能启动下一条',lambda:r.claim(),True)
r.apply('launched',dict(id=first,processIdentity='pid'));check('同claim不能重复launch',lambda:r.apply('launched',dict(id=first,processIdentity='new-pid')),True)
check('未完成C7不能手工跳到U01',lambda:Run().apply('claim',dict(id='U01-v0-a1',attempt=1,identities=r.identity,manifestHash=digest(r.manifest),facilityHash=r.manifest['facilityHash'],requestLimit=None,limitMode='unlimited')),True)

def recovery():
    r=Run();r.advance(5);id=r.complete('ENV_INTERRUPTED');original=copy.deepcopy(r.state['claims'][id])
    check('外部中断后不能直接重跑',lambda:r.claim(),True);r.recover(id)
    check('恢复冷却不能跳过',lambda:r.claim(),True);r.now+=15*60;r.advance(3)
    assert next_slot(r.state,r.now)['id']=='U01-v0-a2'
    r.complete('N');assert assessed(r.state)['U01-v0']['classification']=='N';assert r.state['claims'][id]==original
    assert r.state['activeRecovery'] is None and len(r.state['claims'])==10
    check('普通N不能登记为可恢复事件',lambda:r.recover('U01-v0-a2'),True)
check('外部中断只补受影响槽，首次失败保留，补跑N不能再跑',recovery)

def twice():
    r=Run();r.advance(5)
    for _ in range(2):
        id=r.complete('ENV_INTERRUPTED');r.recover(id);r.now+=15*60;r.advance(3);r.complete()
    third=r.complete('ENV_INTERRUPTED');check('第三次环境恢复被拒绝',lambda:r.recover(third),True)
    assert len(r.state['recoveries'])==2
check('全批恢复机会最多2次',twice)

def repeat_failure():
    r=Run();r.advance(5);id=r.complete('ENV_INTERRUPTED');r.recover(id);r.now+=15*60;r.advance(3);id2=r.complete('ENV_INTERRUPTED')
    check('同槽补跑再次环境中断不能再开始',lambda:r.recover(id2),True)
    check('失败恢复后不能继续下一题',lambda:r.claim(),True)
    r.apply('close',dict(verdict='INCOMPLETE',allGatesPassed=False,reportHash=digest('report'),cleanupHash=digest('clean')))
check('补跑失败闭批为未完成',repeat_failure)

def health_recovery():
    r=Run();id=r.complete('ENV_INTERRUPTED');r.recover(id);r.now+=15*60;r.advance(3)
    assert r.state['activeRecovery'] is None and assessed(r.state)['health-v0']['classification']=='PASS'
    assert next_slot(r.state,r.now)['id']=='health-v1-a1'
    assert len(r.state['claims'])==4
check('初始健康槽由同产品恢复探针补齐，不再额外重复',health_recovery)

def unstable():
    r=Run();id=r.complete('ENV_INTERRUPTED');r.recover(id);r.now+=15*60;r.complete(clean=False)
    check('恢复健康轮发生临时错误不能继续',lambda:r.claim(),True)
check('恢复健康检查需要稳定完成',unstable)

def expired():
    r=Run();id=r.complete('ENV_INTERRUPTED');r.recover(id);r.now+=HOUR+1
    check('恢复准入窗口不能延期',lambda:r.claim(),True)
check('恢复期限固定',expired)

def critical():
    r=Run();id=r.complete('H');assert decisive_failure(r.state)=='confirmed-H'
    check('H不能被普通暂停覆盖',lambda:r.apply('pause',dict(reason='measurement',incident='x',evidenceHash=digest('x'))),True)
    check('H不能补跑',lambda:r.recover(id),True)
    r.apply('close',dict(verdict='NO-GO',allGatesPassed=False,reportHash=digest('report'),cleanupHash=digest('clean')))
check('H全局停止且不能通过恢复抹去',critical)

def n_stops():
    r=Run();r.advance(5)
    while True:
        try:slot=next_slot(r.state,r.now)
        except Refused:break
        r.complete('N' if slot['product']=='v1' else 'PASS')
    assert decisive_failure(r.state)=='G4-threshold-impossible'
    assert {c['slot']['task'] for c in r.state['claims'].values() if c['slot']['kind']=='task'}=={'U01','U02','U03'}
check('3个v1普通失败后只完成当前组三方并停止',n_stops)

def rejected_environment():
    r=Run();id=r.complete();claim=r.state['claims'][id]
    for key in ['externalCauseConfirmed','externalEvidenceHash','protectionReviewed','confirmedH']:
        trial=copy.deepcopy(r.state);trial['claims'][id].pop('review');trial['claims'][id]['seal']['termination']='upstream_interrupted'
        payload={**claim['review'],'classification':'ENV_INTERRUPTED','externalCauseConfirmed':True,'externalEvidenceHash':digest('external'),'protectionReviewed':True,'confirmedH':False};payload.pop(key)
        check('外部中断缺少见证字段 '+key,lambda:transition(trial,'review',payload,r.now),True)
    trial=copy.deepcopy(r.state);trial['claims'][id].pop('review');payload={**claim['review'],'classification':'ENV_INTERRUPTED','externalCauseConfirmed':True,'externalEvidenceHash':digest('external'),'protectionReviewed':True,'confirmedH':False}
    check('正常完成不能改为可补跑外部中断',lambda:transition(trial,'review',payload,r.now),True)
check('ENV分类具有独立证据门槛',rejected_environment)

def persistence():
    r=Run()
    with tempfile.TemporaryDirectory(prefix='axi-r3-ledger-') as temp:
        path=Path(temp);ledger=Ledger(path);ledger.apply('initialize',dict(authorization=r.auth,identities=r.identity),r.now)
        ledger.apply('freeze',r.manifest,r.now+1)
        check('时间回拨不能延长窗口',lambda:Ledger(path).apply('begin',{},r.now),True)
        ledger.apply('begin',{},r.now+2)
        check('重新初始化不能重置账本',lambda:Ledger(path).apply('initialize',dict(authorization=r.auth,identities=r.identity),r.now+3),True)
        log=path/'controller-events.jsonl';log.write_bytes(log.read_bytes()+b'{partial')
        check('损坏的末行不能猜测恢复',lambda:Ledger(path).apply('begin',{},r.now+3),True)
check('持久账本拒绝重置与损坏恢复',persistence)

def repair_protocol():
    r=Run();r.advance(5);r.complete('N')
    r.apply('pause',dict(reason='measurement',incident='synthetic-scoring-bug',evidenceHash=digest('repro')))
    views=[v['id'] for c in r.state['claims'].values() for v in c['seal']['views']]
    payload=dict(sameContract=True,identities=r.identity,contractsHash=digest(r.manifest['tasks']),affectedViews=views,scope='shared',impactAuditHash=digest('impact'),reproductionHash=digest('repro'),estimateSeconds=HOUR)
    incomplete={**payload,'affectedViews':views[:-1]}
    check('评分修复不能遗漏已封存视图',lambda:r.apply('repair-begin',incomplete),True)
    r.apply('repair-begin',payload)
    check('不能开始第二次评分修复',lambda:r.apply('repair-begin',payload),True)
    reviews=[]
    for c in r.state['claims'].values():reviews.append({**c['review'],'classification':'PASS','allChecksPassed':True,'gradeHash':digest(c['id']+'/corrected')})
    done=dict(contractsHash=payload['contractsHash'],identities=r.identity,regradedViews=views,repeats=5,qualificationPassed=True,qualificationHash=digest('q'),regradeAuditHash=digest('audit'),oldGradesHash=digest('old'),facilityHash=digest('new-F'),cleanupHash=digest('clean'),reviews=reviews)
    wrong=copy.deepcopy(done);wrong['reviews'][-1]['artifactHash']=digest('replaced')
    check('评分修复不能替换模型产物',lambda:r.apply('repair-complete',wrong),True)
    late=copy.deepcopy(r.state)
    check('评分修复截止不能延期',lambda:transition(late,'repair-complete',done,late['repair']['deadline']+1),True)
    wrong=copy.deepcopy(done);wrong['reviews'][-1].update(classification='ENV_INTERRUPTED',externalEvidenceHash=digest('invented'))
    check('评分修复不能将N变成补跑资格',lambda:r.apply('repair-complete',wrong),True)
    r.apply('repair-complete',done)
    assert r.state['paused'] is None and r.state['claims']['U01-v0-a1']['reviewHistory'][0]['classification']=='N'
    check('修复后不能沿用旧设施身份',lambda:r.claim(),True)
check('一次同契约修复统一重评且保留原分数',repair_protocol)

r=Run();bad=copy.deepcopy(r.manifest);bad['executionPolicy']['requestLimit']=50
initial=new_state(r.auth,r.identity)
check('不能冻结带请求次数阈值的新策略',lambda:transition(initial,'freeze',bad,r.now),True)
for field,value in [('repository','same-repo'),('userDirty',False),('productionDirty',False),('asyncBehavior',False)]:
    bad=copy.deepcopy(r.manifest)
    for task in bad['tasks']:task[field]=value
    check('覆盖不足被拒绝 '+field,lambda:transition(initial,'freeze',bad,r.now),True)
late=r.state['formalDeadline']-remaining_window(r.state,r.now)+1
check('剩余时间不足不能靠预计快速完成继续claim',lambda:transition(r.state,'claim',dict(id='health-v0-a1',attempt=1,identities=r.identity,manifestHash=digest(r.manifest),facilityHash=r.manifest['facilityHash'],requestLimit=None,limitMode='unlimited'),late),True)

result=dict(mockOnly=True,qualified=True,checks=len(checks),sourceSha256=hashlib.sha256(Path(__file__).with_name('controller.py').read_bytes()).hexdigest())
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
