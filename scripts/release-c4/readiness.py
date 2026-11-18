"""汇总本批证明，保留五次旧资格与一次新复验的分母。"""
from collections import Counter
from pathlib import Path
import hashlib
import json
import sys


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    with path.open('x') as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.write('\n')


def main(study, old, revision):
    def bind(path):
        with path.open('rb') as file:
            return {'path':str(path.relative_to(study)), 'sha256':hashlib.file_digest(file, 'sha256').hexdigest()}

    def passed(relative):
        path=study/relative
        assert read(path)['qualified'], relative
        return bind(path)

    out=study/('readiness-'+revision);out.mkdir()
    prior=read(old/'release-manifest.json')
    tasks=[]
    c7=[]
    reuse=[]
    for row in prior['tasks']+prior['c7Tasks']:
        group='tasks' if row['id'].startswith('U') else 'c7'
        root=study/group/row['id']
        revision_name=read(root/'grading-profile.json')['baselineQualification'].removeprefix('qualification-')
        audit_path=root/f'qualification-audit-{revision_name}.json'
        audit=read(audit_path);assert audit['qualified'] and audit['mode']=='old-five-plus-current-one'
        assert audit['repeatRuleSatisfied'] and audit['priorReferenceCases']==5*audit['referenceCases'] and audit['priorNegativeCases']==5*audit['negativeCases']
        entry={k:v for k,v in row.items() if k not in ('binding','admitted','manifestHash','audit')}
        entry['audit']=audit_path.name
        (tasks if group=='tasks' else c7).append(entry)
        reuse.append({'id':row['id'],'priorAudit':audit['priorAudit'],'priorAuditHash':audit['priorAuditSha256'],
                     'currentAudit':bind(audit_path),'qualified':True,'previousRealResultsUsed':False})
    assert [r['id'] for r in tasks]==[f'U{i:02}' for i in range(1,21)]
    assert [r['id'] for r in c7]==['C7-L','C7-O']
    assert Counter(r['category'] for r in tasks)=={f'R{i}':5 for i in range(1,5)}
    repositories=Counter(r['repository'] for r in tasks)
    assert len(repositories)>=8 and max(repositories.values())<=3
    for field,minimum in [('userDirty',10),('productionDirty',4),('asyncBehavior',8)]:
        assert sum(r[field] for r in tasks)>=minimum
    write(out/'reuse.json',{'qualified':True,'rows':reuse,'sources':bind(study/'material-source-audit.json'),
          'dependencies':passed('dependency-identity.json'),'exposure':passed('exposure-audit-c4/result.json'),
          'engineeringImpact':passed('r1-postqualification-sources.json'),'queue':passed('material-queue-c4/result.json')})
    recovery=passed('recovery-chains-'+revision+'/result.json')
    pipeline=passed('pipeline-audit-'+revision+'/result.json')
    controller_proofs=[passed(f'controller-qualification-{i}/result.json') for i in range(104,109)]
    values=[read(study/r['path'])['checks'] for r in controller_proofs]
    assert len(set(values))==1 and values[0]>=46
    write(out/'controller.json',{'qualified':True,'nativeIntegrationQualified':True,'stateMachineRepeats':5,
          'checksPerRepeat':values[0],'proofs':controller_proofs,'nativeRecovery':recovery,'pipelineAudit':pipeline})
    proofs={'engineering':'engineering-admission.json','controller':str((out/'controller.json').relative_to(study)),
            'capture':'capture-qualification-c4a/results.json','dependencies':'dependency-audit-1/result.json',
            'resourcePolicy':'resource-policy-'+revision+'/result.json','evidenceAudit':pipeline['path'],
            'reuse':str((out/'reuse.json').relative_to(study))}
    for path in proofs.values():passed(path)
    regression=passed('c7-regression-qualification-c4/results.json')
    write(out/'plan.json',{'tasks':tasks,'c7Tasks':c7,'healthTask':{'id':'health'},'pipelineRevision':revision,
          'c7RegressionProof':regression['path'],'proofs':proofs})


if __name__=='__main__':
    main(Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve(),sys.argv[3])
