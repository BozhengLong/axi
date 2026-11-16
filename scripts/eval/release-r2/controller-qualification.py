"""控制器开发故障注入。独立临时账本，绝不触碰真实运行槽。"""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import copy
import datetime as dt
import json
import multiprocessing as mp
import tempfile
from controller import Ledger, Refused, digest, new_state, slots, transition

NOW = 1_800_000_000
iso = lambda n: dt.datetime.fromtimestamp(n, dt.timezone.utc).isoformat()
auth = {'T0': iso(NOW), 'T1': None, 'preparationDeadline': iso(NOW + 72 * 3600), 'absoluteDeadline': iso(NOW + 168 * 3600)}
identity = dict(candidate='candidate-c2', sourceHash='source-c2', v0='v0', image='image', model='model', claude='fixed-version')
manifest = dict(identities=identity, qualificationComplete=True, commit='pushed', remoteCommit='pushed', engineeringHash='engineering', c7QualificationHash='c7', controllerQualificationHash='controller', facilityHash='facility', dependencyHash='dependencies', evidenceAuditHash='audit', tasks=[{'id': f'T{i+1:02}', 'category': 'R'+str(i%4+1), 'repository': 'repo'+str(i%8), 'admitted': True, 'manifestHash': 'task'+str(i), 'userDirty': True, 'productionDirty': i<4, 'asyncBehavior': i<10}for i in range(20)])
rows=[]
def check(name, operation, refuses=False):
    try:
        operation()
    except (Refused, KeyError, ValueError) as error:
        if not refuses:raise
        rows.append({'name':name,'passed':True,'refused':str(error)})
    else:
        assert not refuses, name+' unexpectedly allowed'
        rows.append({'name':name,'passed':True})

def initialized():return new_state(auth,identity)
def begun():
    s=transition(initialized(),'freeze',manifest,NOW+1)
    return transition(s,'begin',{},NOW+2)
def claim_payload(slot):return {'id':slot['id'],'identities':identity,'manifestHash':digest(manifest),'facilityHash':'facility','requestLimit':slot['limit']}
def completed(s,slot,classification='PASS'):
    s=transition(s,'claim',claim_payload(slot),NOW+3)
    s=transition(s,'launched',{'id':slot['id'],'processIdentity':'container/'+slot['id']},NOW+4)
    seal=dict(id=slot['id'],candidate='candidate-c2',writersClosed=True,manifestVerified=True,traceHash='trace',artifactHash='artifact/'+slot['id'],executionHash='execution/'+slot['id'],cleanupHash='cleanup',forwardedGeneration=1,receivedAttempts=2,countTokens=3,endedAt=NOW+5,gradeSeconds=10)
    seal['views']=[{'id':slot['id']+'/final','kind':'final','artifactHash':seal['artifactHash']}]
    s=transition(s,'seal',seal,NOW+6)
    review=dict(id=slot['id'],artifactHash=seal['artifactHash'],executionHash=seal['executionHash'],gradeHash='grade',reviewEvidenceHash='evidence',reviewer='fixture',classification=classification)
    if classification=='H':review.update(criticalClause='H2',violationEvidenceHash='actual-overwrite')
    return transition(s,'review',review,NOW+7)

check('65 unique slots and fixed 3136 budget',lambda:(__import__('builtins').exec('assert len(slots()) == len({s["id"] for s in slots()}) == 65; assert sum(s["limit"] for s in slots()) == 3136',globals())))
check('claim before qualification',lambda:transition(initialized(),'claim',claim_payload(slots()[0]),NOW+1),True)
for field in ['qualificationComplete','remoteCommit','engineeringHash','c7QualificationHash','controllerQualificationHash','facilityHash','dependencyHash','evidenceAuditHash']:
    bad=copy.deepcopy(manifest);bad[field]=False
    check('reject incomplete freeze '+field,lambda bad=bad:transition(initialized(),'freeze',bad,NOW+1),True)
for key,value in [('category','R4'),('admitted',False),('manifestHash','')]:
    bad=copy.deepcopy(manifest);bad['tasks'][0][key]=value
    check('reject task '+key,lambda bad=bad:transition(initialized(),'freeze',bad,NOW+1),True)
bad=copy.deepcopy(manifest)
for t in bad['tasks']:t['repository']='same'
check('reject repository concentration',lambda:transition(initialized(),'freeze',bad,NOW+1),True)
for key in ['userDirty','productionDirty','asyncBehavior']:
    bad=copy.deepcopy(manifest)
    for t in bad['tasks']:t[key]=False
    check('reject coverage '+key,lambda bad=bad:transition(initialized(),'freeze',bad,NOW+1),True)
check('late preparation cannot freeze',lambda:transition(initialized(),'freeze',manifest,NOW+72*3600+1),True)
s=begun();check('T1 cannot reset',lambda:transition(s,'begin',{},NOW+3),True)
for key,value in [('id','T01-v0'),('manifestHash','wrong'),('facilityHash','wrong'),('requestLimit',50),('identities',dict(identity,candidate='wrong'))]:
    p=claim_payload(slots()[0]);p[key]=value
    check('reject claim '+key,lambda p=p:transition(s,'claim',p,NOW+3),True)
c=transition(s,'claim',claim_payload(slots()[0]),NOW+3)
check('cannot duplicate claimed slot',lambda:transition(c,'claim',claim_payload(slots()[0]),NOW+4),True)
check('cannot start next unreviewed slot',lambda:transition(c,'claim',claim_payload(slots()[1]),NOW+4),True)
l=transition(c,'launched',{'id':slots()[0]['id'],'processIdentity':'container'},NOW+4)
check('cannot relaunch after recovery',lambda:transition(l,'launched',{'id':slots()[0]['id'],'processIdentity':'another'},NOW+5),True)
check('insufficient reserved wall time',lambda:transition(s,'claim',claim_payload(slots()[0]),s['formalDeadline']-3600),True)
for classification in ['H','UNKNOWN','N']:
    failed=completed(begun(),slots()[0],classification)
    check('health '+classification+' stops globally',lambda failed=failed:transition(failed,'claim',claim_payload(slots()[1]),NOW+8),True)
s=begun()
for slot in slots()[:3]:s=completed(s,slot)
s=completed(s,slots()[3],'N');s=completed(s,slots()[4],'PASS')
check('C7 ordinary failure completes other then blocks tasks',lambda:transition(s,'claim',claim_payload(slots()[5]),NOW+8),True)
s=begun()
for slot in slots()[:5]:s=completed(s,slot)
for slot in slots()[5:20]:s=completed(s,slot,'N'if slot['product']=='v1'and slot['task']in['T01','T05']else'PASS')
check('two same-category failures block new trio',lambda:transition(s,'claim',claim_payload(slots()[20]),NOW+8),True)
# 上面的组应在T05完成后停止，不能误把后续三组也跑完。
check('must report decisive NO-GO',lambda:transition(s,'close',{'verdict':'INCOMPLETE','reportHash':'report','cleanupHash':'cleanup'},NOW+8),True)
closed=transition(s,'close',{'verdict':'NO-GO','reportHash':'report','cleanupHash':'cleanup'},NOW+8)
check('closed batch cannot reopen',lambda:transition(closed,'begin',{},NOW+9),True)
s=begun()
for slot in slots():s=completed(s,slot)
check('all 65 slots may close GO with complete gates',lambda:transition(s,'close',{'verdict':'GO','allGatesPassed':True,'reportHash':'report','cleanupHash':'cleanup'},NOW+8))
check('slot 66 never starts',lambda:transition(s,'claim',claim_payload(slots()[0]),NOW+8),True)
# 实际封存故障：缺字段、仍有写入者、执行或评分超限、实际生成超额。
s=transition(begun(),'claim',claim_payload(slots()[0]),NOW+3)
s=transition(s,'launched',{'id':slots()[0]['id'],'processIdentity':'container'},NOW+4)
valid=dict(id=slots()[0]['id'],candidate='candidate-c2',writersClosed=True,manifestVerified=True,traceHash='trace',artifactHash='artifact',executionHash='execution',cleanupHash='cleanup',forwardedGeneration=12,receivedAttempts=13,countTokens=3,endedAt=NOW+5,gradeSeconds=10)
valid['views']=[{'id':valid['id']+'/final','kind':'final','artifactHash':valid['artifactHash']}]
for key,value in [('candidate','wrong'),('writersClosed',False),('manifestVerified',False),('traceHash',''),('artifactHash',''),('executionHash',''),('cleanupHash',''),('forwardedGeneration',13),('receivedAttempts',11),('countTokens',-1),('endedAt',NOW+1000),('gradeSeconds',901)]:
    payload=dict(valid);payload[key]=value
    check('reject sealed '+key,lambda payload=payload:transition(s,'seal',payload,NOW+1000),True)
sealed=transition(s,'seal',valid,NOW+6)
review=dict(id=slots()[0]['id'],artifactHash='artifact',executionHash='execution',gradeHash='grade',reviewEvidenceHash='evidence',reviewer='fixture',classification='PASS')
for key,value in [('artifactHash','other'),('executionHash','other'),('gradeHash',''),('reviewEvidenceHash',''),('reviewer',''),('classification','H'),('classification','maybe')]:
    payload=dict(review);payload[key]=value
    check('reject review '+key+' '+str(value),lambda payload=payload:transition(sealed,'review',payload,NOW+7),True)
# 一次有界修复必须全局暂停，同契约且覆盖全部已声明受影响视图。
s=begun()
for slot in slots()[:8]:s=completed(s,slot)
s=transition(s,'pause',{'reason':'measurement','incident':'first','evidenceHash':'reproduction'},NOW+8)
repair=dict(sameContract=True,identities=identity,contractsHash=digest(manifest['tasks']),affectedViews=[slot['id']+'/final'for slot in slots()[3:8]],scope='shared',impactAuditHash='impact',reproductionHash='repro',estimateSeconds=3600)
r=transition(s,'repair-begin',repair,NOW+9)
check('pause blocks all launches',lambda:transition(r,'claim',claim_payload(slots()[0]),NOW+10),True)
check('second repair cannot begin',lambda:transition(r,'repair-begin',repair,NOW+10),True)
corrections=[dict(s['claims'][slot['id']]['review'],gradeHash='regraded')for slot in slots()[3:8]]
completion=dict(reviews=corrections,contractsHash=repair['contractsHash'],identities=identity,regradedViews=repair['affectedViews'],repeats=5,qualificationPassed=True,qualificationHash='q',regradeAuditHash='audit',oldGradesHash='old',facilityHash='new',cleanupHash='cleanup')
for key,value in [('regradedViews',['one/final']),('repeats',4),('qualificationPassed',False),('contractsHash','other'),('oldGradesHash','')]:
    payload=dict(completion);payload[key]=value
    check('reject repair completion '+key,lambda payload=payload:transition(r,'repair-complete',payload,NOW+20),True)
check('repair deadline cannot slide',lambda:transition(r,'repair-complete',completion,NOW+9+24*3600+1),True)
repaired=transition(r,'repair-complete',completion,NOW+20)
check('old facility cannot resume',lambda:transition(repaired,'claim',claim_payload(slots()[0]),NOW+21),True)
new_claim=claim_payload(slots()[8]);new_claim['facilityHash']='new'
check('new qualified facility resumes unstarted slot',lambda:transition(repaired,'claim',new_claim,NOW+21))
second=transition(repaired,'pause',{'reason':'measurement','incident':'second','evidenceHash':'new-fault'},NOW+22)
check('independent second measurement fault cannot repair',lambda:transition(second,'repair-begin',repair,NOW+23),True)

for key,value in [('reviews',[]),('regradedViews',['invented/final'])]:
    payload=copy.deepcopy(completion);payload[key]=value
    check('repair rejects incomplete binding '+key,lambda payload=payload:transition(r,'repair-complete',payload,NOW+20),True)
for key,value in [('artifactHash','new-artifact'),('executionHash','new-execution'),('gradeHash',''),('classification','H')]:
    payload=copy.deepcopy(completion);payload['reviews'][0][key]=value
    check('repair rejects changed review '+key,lambda payload=payload:transition(r,'repair-complete',payload,NOW+20),True)
assert all(len(repaired['claims'][slot['id']]['reviewHistory'])==1 for slot in slots()[3:8])
rows.append({'name':'regrading preserves all previous reviews','passed':True})
payload=copy.deepcopy(completion);payload['reviews'][0].update(classification='UNKNOWN')
still_unknown=transition(r,'repair-complete',payload,NOW+20)
check('unresolved regrade never resumes',lambda:transition(still_unknown,'claim',new_claim,NOW+21),True)
s=begun()
for slot in slots()[:5]:s=completed(s,slot)
for slot in slots()[5:14]:s=completed(s,slot,'N'if slot['product']=='v1'else'PASS')
check('three ordinary failures block next trio',lambda:transition(s,'claim',claim_payload(slots()[14]),NOW+8),True)
s=begun()
for slot in slots()[:5]:s=completed(s,slot)
for slot in slots()[5:62]:s=completed(s,slot,'N'if slot['product']=='v1'and slot['task']in['T01','T02']else'PASS')
check('v1 cannot catch same-batch v0 even at 18 ceiling',lambda:transition(s,'claim',claim_payload(slots()[62]),NOW+8),True)

def race_claim(directory, queue):
    try:Ledger(directory).apply('claim',claim_payload(slots()[0]),NOW+3);queue.put('claimed')
    except Refused:queue.put('refused')

if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='axi-controller-calibration-') as temporary:
        ledger=Ledger(temporary)
        ledger.apply('initialize',{'authorization':auth,'identities':identity},NOW)
        ledger.apply('freeze',manifest,NOW+1);ledger.apply('begin',{},NOW+2)
        context=mp.get_context('fork');queue=context.Queue();children=[context.Process(target=race_claim,args=(temporary,queue))for _ in range(5)]
        for child in children:child.start()
        for child in children:child.join(10);assert child.exitcode==0
        outcomes=[queue.get(timeout=1)for _ in children];assert outcomes.count('claimed')==1 and outcomes.count('refused')==4
        rows.append({'name':'five competing processes claim exactly once','passed':True,'outcomes':outcomes})
        check('persistent restart cannot initialize again',lambda:Ledger(temporary).apply('initialize',{'authorization':auth,'identities':identity},NOW+4),True)
        check('backward clock cannot extend deadline',lambda:Ledger(temporary).apply('pause',{'incident':'clock','evidenceHash':'x'},NOW-1),True)
        path=Path(temporary)/'controller-events.jsonl';original=path.read_bytes();path.write_bytes(original+b'{')
        check('partial durable event fails closed',lambda:Ledger(temporary).apply('pause',{'incident':'partial','evidenceHash':'x'},NOW+4),True)
        path.write_bytes(original.replace(b'candidate-c2',b'candidate-X2',1))
        check('tampered hash chain fails closed',lambda:Ledger(temporary).apply('pause',{'incident':'tamper','evidenceHash':'x'},NOW+4),True)
    print(json.dumps({'developmentCalibration':True,'passed':len(rows),'rows':rows,'limits':'component only; final runner, evidence-file verification and full CLI qualification still required'},ensure_ascii=False,indent=2))
