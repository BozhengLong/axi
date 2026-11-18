"""审核同一产品的 C4 工程证据，按文件依赖重验本批恢复控制器。"""
import hashlib
import json
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[2]


def read(p):
    return json.loads(p.read_text())


def sha(p):
    with p.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write(p, data):
    with p.open('x') as out:
        json.dump(data,out,ensure_ascii=False,indent=2)
        out.write('\n')


def main(old, study, matrix):
    manifest = read(old/'release-manifest.json')
    index = manifest['facilityIndex']
    assert sha(old/index['path']) == index['sha256']
    product = read(study/'candidate.json')
    assert read(study/'r0-verified.json')['qualified']
    assert product['candidate'] == manifest['identities']['candidate'] == read(old/'candidate.json')['candidate']
    # 旧索引既包含仓库，也包含旧批次的题目、设施和候选挂载目录。
    expected_changes = {'scripts/eval/release-r3/'+name for name in (
        'controller.py','controller-gateway.py','controller-fixtures.py','release-package.py','pipeline-one.ts')}
    expected_changes.add('scripts/release-c4/readiness.py')
    changes = {}
    checked = 0
    for row in read(old/index['path'])['files']:
        original=Path(row['path'])
        if original.is_relative_to(old):
            continue
        assert sha(original)==row['sha256']==sha(old/row['archive'])
        rel = original.relative_to(next(p for p in original.parents if (p/'.git').exists()))
        other = REPO/rel
        assert other.is_file()
        current=sha(other)
        if current != row['sha256']:
            changes[str(rel)]={'previous':row['sha256'],'current':current}
        checked+=1
    assert set(changes)==expected_changes, set(changes)^expected_changes
    proof=manifest['proofs']['engineering']
    assert sha(old/proof['path'])==proof['sha256']
    engineering=read(old/proof['path'])
    assert engineering['qualified'] and all(engineering['runtimeChecks'].values())
    def bound(path):
        return {'path':str(path.relative_to(study)), 'sha256':sha(path)}
    def actual(path):
        assert read(path)['qualified']
        return bound(path)
    # 在新目录核对旧见证，并在本批引用中显式记录其来源。
    old_rows = [*engineering['proofs'],*[item for rows in engineering['runtimeEvidence'].values() for item in rows]]
    for item in old_rows:
        assert sha(old/item['path']) == sha(study/item['path']) == item['sha256']
    recovery_proofs = {'native':actual(study/('health-matrix-'+matrix)/'result.json'),
                       'protocol':actual(study/'protocol-checks.json'), 'replay':actual(study/'offline-replay-final.json')}
    checks=[actual(study/f'controller-r5-{i}/result.json') for i in range(1,6)]
    mutations=[actual(study/f'mutant-r5-{i}/results.json') for i in range(1,6)]
    grade=actual(study/'recovery-gate-r5/result.json')
    assert len(read(study/recovery_proofs['native']['path'])['rows'])==9
    assert len(read(study/recovery_proofs['protocol']['path'])['rows'])==33
    assert read(study/grade['path'])['checks']==125
    for k in ('RT08','RT09','RT10'):
        rows=engineering['runtimeEvidence'][k]
        engineering['runtimeEvidence'][k]=[r for r in rows if not r['path'].startswith(('controller-qualification-','mutant-qualification-'))]+checks
    engineering['runtimeEvidence']['RT09']+=mutations
    engineering['runtimeEvidence']['RT08'] += [grade,*recovery_proofs.values()]
    engineering['runtimeEvidence']['RT12'].append(recovery_proofs['native'])
    impact={'qualified':True,'previous':str(old),'previousEngineering':proof,'repoFilesCompared':checked,
            'changed':changes,'addedRecoveryAuditor':sha(REPO/'scripts/eval/release-r3/recovery_health.py'),
            'priorEvidenceVerified':len({r['path'] for r in old_rows}), 'newControlProofs':checks+mutations+[grade],
            'recoveryHealthProofs':recovery_proofs}
    impact_path=study/'r1-postqualification-sources.json'
    write(impact_path,impact)
    engineering.update(previousBatch=str(old), priorCheckedAt=engineering.pop('checkedAt'), recoveryHealthProofs=recovery_proofs,
                       sourceAudit=bound(impact_path), scope='同候选工程资格按来源复用。新恢复控制器另行实测。')
    write(study/'engineering-admission.json',engineering)
    print('repo files',checked,'old evidence',impact['priorEvidenceVerified'])


if __name__=='__main__':
    main(Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve(),sys.argv[3])
