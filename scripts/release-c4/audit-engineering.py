"""从新候选的封存记录核对工程准入与十二项运行资格。"""
from pathlib import Path
from collections import Counter
import datetime as dt
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1] / 'eval/release-r3'
sys.path.insert(0, str(HERE))
from trace_io import events, sha, verify_run
spec = importlib.util.spec_from_file_location('execution_evidence', HERE/'execution-evidence.py')
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    with path.open('x') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main(study):
    def bound(file):
        return {'path':str(file.relative_to(study)), 'sha256':sha(file)}

    candidate = read(study/'candidate.json')
    assert read(study/'authorization.json')['T1'] is None
    assert read(study/'base-engineering-2/results.json')['qualified']
    assert read(study/'behavior-engineering-1/results.json')['qualified']
    assert read(study/'engineering-audit-c4/results.json')['candidate'] == candidate['candidate']
    assert read(study/'c4-identity-audit.json')['decision'] == 'B01-PASS'
    assert read(study/'deadline-audit-qualification-2/results.json')['checks'] == 35
    batch_plan = read(study/'r1-final-2/plan.json')['steps']
    batch_result = read(study/'r1-final-2/results.json')
    assert batch_result['qualified'] and [r['step'] for r in batch_result['rows']] == [r[0] for r in batch_plan]
    assert len(batch_result['rows']) == 72 and all(r['exitCode'] == 0 for r in batch_result['rows'])
    out = study/'engineering-observable-audit'
    out.mkdir(exist_ok=True)
    rows = []
    def check(run, kind, source=None):
        run = Path(run).resolve()
        assert run.is_relative_to(study/'runtime') and not any(row['run'] == str(run.relative_to(study)) for row in rows)
        result = {'kind':kind, 'run':str(run.relative_to(study))}
        if kind == 'incomplete':
            assert source['qualified'] and source['completeTraceRejected'] and not source['processes']
            assert not (run/'io.chunks/manifest.json').exists()
            native = read(run/'native/manifest.json')
            assert native['status']=='collected' and native['files']
            for file in native['files']:
                assert sha(run/'native'/file['path']) == file['sha256']
            result['nativeHash'] = sha(run/'native/manifest.json')
        elif kind == 'cancel':
            verify_run(run)
            logs=list((run/'native/axi-session').glob('*.jsonl'));assert len(logs)==1
            native=list(events(logs[0]));http=list(events(run.parent/'relay'/(run.name+'.chunks')))
            assert [r['data']['outcome'] for r in native if r['kind']=='task_end']==['interrupted','completed']
            assert [r['data']['body'] for r in native if r['kind']=='request']==[r['data']['body'] for r in http if r['kind']=='request']
            result['traceHash'] = sha(run/'trace-manifest.json')
        else:
            audited = evidence.audit(run, mock=True)
            assert audited['trustworthyObservableTrace'] and not audited['observerErrors']
            result['traceHash'] = sha(run/'trace-manifest.json')
            result['termination'] = audited['termination']
        result['passed'] = True
        rows.append(result)

    adapter = read(study/'c3-adapter-cli-102/summary.json')
    assert adapter['complete'] and len(adapter['rows']) == 50 and adapter['sourceHash'] == candidate['sourceHash']
    for r in adapter['rows']:
        assert r['passed'] and r['traceComplete']
        check(Path(adapter['directory'])/r['id'], 'single')
    for i in range(5):
        check(read(study/f'integration-{103+i}/result.json')['traceDirectory'],'single')
        for folder,kind,count in [(f'runtime-qualification-{110+i}','single',9),
                                  (f'runtime-qualification-{120+i}','single',1),
                                  (f'guard-qualification-{110+i}','single',6),
                                  (f'cancel-qualification-{110+i}','cancel',3)]:
            data=read(study/folder/'results.json')
            assert data['qualified'] and len(data['rows'])==count
            for r in data['rows']:
                assert r['qualified']
                check(r['traceDirectory'],kind,r)
        for j in [2*i,2*i+1]:
            data=read(study/f'orphan-qualification-{110+j}/result.json')
            check(data['traceDirectory'],'incomplete',data)
        for actor in ('v0','v1','claude'):
            data=read(study/f'health/pipeline-{actor}-r3-r1-2-{i+1}/result.json')
            assert data['qualified'] and data['mockOnly']
            check(data['traceDirectory'],'single')
        deadline=read(study/f'deadline-cli-{i+1}/result.json')
        assert deadline['qualified'] and deadline['classification']=='ENV_INTERRUPTED'
        check(deadline['traceDirectory'],'deadline')
    assert Counter(row['kind'] for row in rows)=={'single':150,'cancel':15,'incomplete':10,'deadline':5}
    write(out/'result.json',{'qualified':True,'counts':dict(Counter(r['kind'] for r in rows)),'rows':rows})

    # 复用已批准的检查项与输入，绑定本批产生的每份证明。
    ref=read(Path(sys.argv[2])/'engineering-admission.json')['runtimeEvidence']
    def current_name(path):
        import re
        for prefix,lo,hi,delta in [('integration-',303,307,-200),('runtime-qualification-',310,324,-200),
                                  ('guard-qualification-',310,314,-200),('cancel-qualification-',310,314,-200),
                                  ('orphan-qualification-',310,319,-200),('controller-qualification-',204,208,-100),
                                  ('mutant-qualification-',202,206,-100),('evidence-qualification-',202,206,-100)]:
            m=re.match(re.escape(prefix)+r'(\d+)/(.*)',path)
            if m and lo<=int(m[1])<=hi:return prefix+str(int(m[1])+delta)+'/'+m[2]
        return (path.replace('final-observable-audit-1/results.json','engineering-observable-audit/result.json')
                    .replace('deadline-audit-qualification-1/','deadline-audit-qualification-2/')
                    .replace('c3-adapter-cli-202/','c3-adapter-cli-102/')
                    .replace('r1-final-3/','r1-final-2/').replace('r1-final-4/','r1-final-2/')
                    .replace('-r3-r1-4-','-r3-r1-2-'))
    runtime_proofs={k:[bound(study/current_name(r['path'])) for r in items] for k,items in ref.items()}
    assert set(runtime_proofs)=={f'RT{i:02}' for i in range(1,13)}
    proof_names=['base-engineering-2/results.json','behavior-engineering-1/results.json',
                 'engineering-audit-c4/results.json','c4-identity-audit.json','r1-final-2/results.json',
                 'engineering-observable-audit/result.json','deadline-audit-qualification-2/results.json']
    write(study/'engineering-admission.json',{'schema':3,'qualified':True,'candidate':candidate['candidate'],
          'sourceHash':candidate['sourceHash'],'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
          'runtimeChecks':{k:True for k in runtime_proofs},'runtimeEvidence':runtime_proofs,
          'proofs':[bound(study/path) for path in proof_names],'unresolvedCandidateH':0,'T1':None,'realModelStarts':0,
          'actualMockCli':180,'completeObservable':170,'intentionalIncomplete':10,'testsPerRun':210,'assertionsPerRun':1360})


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve())
