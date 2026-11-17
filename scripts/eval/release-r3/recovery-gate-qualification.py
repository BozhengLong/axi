"""校准恢复评分准入和探针完成期限；错误暂停原因与旧attempt不能获得权限。"""
from pathlib import Path
import copy,hashlib,importlib.util,json,sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
grade=load('grading-admission');controller=load('controller')
study=Path(sys.argv[1]).resolve();out=study/sys.argv[2];out.mkdir();rows=[]
def fixture(recovery=False,kind='health'):
    state={'closure':None,'paused':{'reason':'environment'}if recovery else None,'activeRecovery':0 if recovery else None,'recoveries':[{'deadline':300,'cooldownUntil':100}],'formalDeadline':100000}
    claim={'id':'probe','slot':{'kind':kind},'recovery':0 if recovery else None,'claimedAt':150,'executionDeadline':250,'seal':{'endedAt':180}}
    return state,claim
for repeat in range(1,6):
    for name,enabled,kind,now,change,expected in [
        ('normal-health',False,'health',200,lambda s,c:None,480),
        ('normal-task',False,'task',200,lambda s,c:None,1080),
        ('registered-recovery-probe',True,'recovery-health',200,lambda s,c:None,300),
        ('health-target-attempt-two',True,'health',200,lambda s,c:None,300),
        ('task-retry-grades-after-admission-window',True,'task',301,lambda s,c:None,1080),
        ('paused-normal',False,'health',200,lambda s,c:s.update(paused={'reason':'environment'}),None),
        ('old-attempt-during-recovery',True,'health',200,lambda s,c:c.update(recovery=None),None),
        ('wrong-recovery-index',True,'health',200,lambda s,c:c.update(recovery=1),None),
        ('missing-active-recovery',True,'health',200,lambda s,c:s.update(activeRecovery=None),None),
        ('measurement-pause',True,'health',200,lambda s,c:s.update(paused={'reason':'measurement'}),None),
        ('resource-pause',True,'health',200,lambda s,c:s.update(paused={'reason':'resource'}),None),
        ('failed-recovery',True,'health',200,lambda s,c:s['recoveries'][0].update(failed=True),None),
        ('completed-recovery',True,'health',200,lambda s,c:s['recoveries'][0].update(completedAt=190),None),
        ('claim-before-cooldown',True,'health',200,lambda s,c:c.update(claimedAt=99),None),
        ('claim-after-admission',True,'task',350,lambda s,c:c.update(claimedAt=301),None),
        ('probe-expired',True,'health',301,lambda s,c:None,None),
        ('probe-at-deadline-no-time-to-grade',True,'health',300,lambda s,c:None,None),
        ('already-reviewed',False,'health',200,lambda s,c:c.update(review={}),None),
        ('not-sealed',False,'health',200,lambda s,c:c.pop('seal'),None),
        ('closed-batch',True,'health',200,lambda s,c:s.update(closure={'verdict':'INCOMPLETE'}),None),
        ('shared-grade-time-exhausted',False,'task',1080,lambda s,c:None,None),
    ]:
        state,claim=fixture(enabled,kind);change(state,claim)
        try:actual=grade.first_grade_deadline(state,claim,now)
        except RuntimeError:assert expected is None,name
        else:assert expected is not None and actual==expected,name
        rows.append({'case':name,'repeat':repeat,'passed':True,'expectedDeadline':expected})
    for target_kind in ('health','task'):
        for late in (False,True):
            state={'activeRecovery':0,'paused':{'reason':'environment'},'recoveries':[{'number':1,'target':'target','deadline':300}],'claims':{'target':{'slot':{'kind':target_kind,'product':'v1'},'logicalId':'health-v1'if target_kind=='health'else'U02-v1'}}}
            for product in ('v0','v1','claude'):
                logical='health-v1'if target_kind=='health'and product=='v1'else'recovery-1-health-'+product
                state['claims'][product]={'id':product,'logicalId':logical,'slot':{'kind':'recovery-health','product':product},'recovery':0,'review':{'classification':'PASS','cleanUpstream':True}}
            controller.update_recovery(state,state['claims']['claude'],301 if late else 299)
            if late:assert state['activeRecovery']==0 and state['recoveries'][0]['failed']and state['paused']['reason']=='recovery-window-expired'
            elif target_kind=='health':assert state['activeRecovery']is None and state['paused']is None
            else:assert state['activeRecovery']==0 and not state['recoveries'][0].get('failed')
            rows.append({'case':'controller-probe-completion-'+target_kind+('-late'if late else'-timely'),'repeat':repeat,'passed':True})
sources={str(HERE/n):hashlib.sha256((HERE/n).read_bytes()).hexdigest()for n in ['grading-admission.py','formal-grade.py','controller.py',Path(__file__).name]}
(out/'source').mkdir()
for path,h in sources.items():(out/'source'/h).write_bytes(Path(path).read_bytes())
result={'qualified':True,'mockOnly':True,'repeats':5,'checksPerRepeat':25,'checks':len(rows),'sourceHashes':sources,'rows':rows}
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'qualified':True,'checks':len(rows)}))
