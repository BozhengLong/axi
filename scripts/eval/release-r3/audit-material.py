"""核对本批五次原态、两参考、反事实和每个负例；旧结论不充当本批成绩。"""
from pathlib import Path
import datetime as dt,hashlib,json,re,sys
sys.dont_write_bytecode=True

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read(path):return json.loads(Path(path).read_text())

if __name__=='__main__':
    study=Path(sys.argv[1]).resolve();task_id,positive_revision,negative_revision,audit_revision=sys.argv[2:6]
    assert re.fullmatch(r'U\d\d|C7-[LO]',task_id)
    assert all(re.fullmatch(r'[A-Za-z0-9_-]+',x)for x in (positive_revision,negative_revision,audit_revision))
    task=study/('c7'if task_id.startswith('C7-')else'tasks')/task_id
    profile=read(task/'qualification-profile.json');controls=read(task/'negative-controls.json')
    positive=task/('qualification-'+positive_revision);negative=task/('negative-qualification-'+negative_revision)
    p=read(positive/'results.json');n=read(negative/'results.json')
    assert all(d['qualified'] and d['facilityStable']for d in (p,n))
    for directory in (positive,negative):
        a=read(directory/'adaptation.json');assert a['repeats']==5 and a['assertionLogicUnchanged']
        assert sha(a['original'])==a['originalSha256'] and sha(directory/'adapted-source.py')==a['adaptedSha256']
        for path,h in read(directory/'facility.json').items():
            assert sha(directory/'facility-source'/h)==h and sha(path)==h,'资格后依赖改变: '+path
    roles=['initial',*profile['references'],'counterfactual']
    assert len(p['rows'])==len(roles)*5
    assert {(r['role'],r['repeat'])for r in p['rows']}=={(role,i)for role in roles for i in range(1,6)}
    assert all(r['passed'] and r['elapsedSeconds']<=720 for r in p['rows'])
    by_id={c['id']:c for c in controls['controls']};assert len(by_id)==len(controls['controls'])
    assert len(n['rows'])==len(by_id)*5
    assert {(r['id'],r['repeat'])for r in n['rows']}=={(name,i)for name in by_id for i in range(1,6)}
    for r in n['rows']:
        assert r['qualified']
        c=by_id[r['id']]
        for prefix in c.get('forbiddenPrefixes',[]):assert not any(name.startswith(prefix+':')for name in r.get('failedNames',[]))
    result={'taskId':task_id,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'referenceQualification':positive.name,'negativeQualification':negative.name,'sourceArchivesVerified':True,'taskInputsUnchanged':True,'negativeClassificationChecked':True,'referenceCases':len(p['rows']),'negativeCases':len(n['rows']),'maxReferenceSeconds':max(r['elapsedSeconds']for r in p['rows']),'repeatRuleSatisfied':True,'mode':'current-five','qualified':True,'admitted':False,'remaining':['current actual CLI pipelines','final release admission'],'realModelStarts':0}
    with(task/('qualification-audit-'+audit_revision+'.json')).open('x')as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
    print(json.dumps(result))
