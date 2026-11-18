"""验证已有五次资格的材料。每个角色与每个负例在本批各做一次完整检查。"""
from pathlib import Path
import hashlib
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
FACILITY = HERE.parents[1] / 'scripts/eval/release-r3'
sys.path.insert(0, str(FACILITY))
sys.path.append(str(FACILITY.parent / 'release-r2'))
spec = importlib.util.spec_from_file_location('material', FACILITY / 'qualify-material.py')
material = importlib.util.module_from_spec(spec)
spec.loader.exec_module(material)


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def current_source(kind):
    original, source, changes = material.prepare(kind)
    replacements = [
        ('for repeat in range(1, 6):', 'for repeat in range(1, 2):'),
        ("'repeats': 5", "'repeats': 1"),
        ("R3_HERE / 'qualify-material.py',", "R3_HERE / 'qualify-material.py', C4_DRIVER,"),
    ]
    if 'negative' in kind:
        replacements.append(("len(controls['controls']) * 5", "len(controls['controls'])"))
    else:
        replacements.extend([("'counterfactualRepeats': 5", "'counterfactualRepeats': 1"),
                             ("(len(profile['references']) + 2) * 5", "(len(profile['references']) + 2)")])
    for before, after in replacements:
        assert source.count(before) == 1, (kind, before)
        source = source.replace(before, after)
        changes.append({'before':before, 'after':after, 'occurrences':1})
    return original, source, changes


def audit(study, task, revision):
    contract = read(study / 'material-source-audit.json')
    old = Path(contract['previous'])
    entry = next(r for r in contract['tasks'] if r['task'] == task)
    group = 'tasks' if task.startswith('U') else 'c7'
    dest = study / group / task
    prior_audit = old / group / task / entry['oldAudit']
    assert sha(prior_audit) == entry['oldAuditSha256']
    prior = read(prior_audit)
    positive, negative = [dest / (prefix + revision) for prefix in ('qualification-', 'negative-qualification-')]
    positives, negatives = [read(path / 'results.json') for path in (positive, negative)]
    roles = {'initial', 'counterfactual', *read(dest / 'qualification-profile.json')['references']}
    assert len(positives['rows']) == len(roles)
    assert {(r['role'],r['repeat']) for r in positives['rows']} == {(role,1) for role in roles}
    assert all(r['passed'] and r['elapsedSeconds'] <= 720 for r in positives['rows'])
    controls = {c['id']:c for c in read(dest / 'negative-controls.json')['controls']}
    assert len(negatives['rows']) == len(controls)
    assert {(r['id'],r['repeat']) for r in negatives['rows']} == {(key,1) for key in controls}
    for row in negatives['rows']:
        assert row['qualified']
        for prefix in controls[row['id']].get('forbiddenPrefixes', []):
            assert not any(name.startswith(prefix+':') for name in row.get('failedNames', []))
    for directory, result in [(positive, positives), (negative, negatives)]:
        assert result['qualified'] and result['facilityStable']
        adaptation = read(directory / 'adaptation.json')
        assert adaptation['repeats'] == 1 and sha(directory / 'adapted-source.py') == adaptation['adaptedSha256']
        for path, digest in read(directory / 'facility.json').items():
            assert sha(Path(path)) == sha(directory / 'facility-source' / digest) == digest
    assert prior['referenceCases'] == 5*len(roles) and prior['negativeCases'] == 5*len(controls)
    result = {'taskId':task, 'qualified':True, 'mode':'old-five-plus-current-one',
              'sourceArchivesVerified':True, 'taskInputsUnchanged':True, 'negativeClassificationChecked':True,
              'repeatRuleSatisfied':True, 'referenceCases':len(roles), 'negativeCases':len(controls),
              'priorReferenceCases':prior['referenceCases'], 'priorNegativeCases':prior['negativeCases'],
              'priorAudit':str(prior_audit), 'priorAuditSha256':sha(prior_audit),
              'dependencyComparison':sha(study / 'dependency-identity.json'),
              'referenceQualification':positive.name, 'negativeQualification':negative.name, 'realModelStarts':0}
    with (dest/f'qualification-audit-{revision}.json').open('x') as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
        file.write('\n')


if __name__ == '__main__':
    kind = sys.argv.pop(1)
    study, task_id, revision = Path(sys.argv[1]).resolve(), sys.argv[2], sys.argv[3]
    assert read(study / 'status.json')['phase'] == 'R2'
    assert read(study / 'dependency-identity.json')['qualified']
    assert task_id in {entry['task'] for entry in read(study / 'material-source-audit.json')['tasks']}
    if kind == 'audit':
        audit(study, task_id, revision)
    else:
        original, source, changes = current_source(kind)
        adaptation = {'kind':kind,'original':str(original),'originalSha256':sha(original),
                      'adaptedSha256':hashlib.sha256(source.encode()).hexdigest(),'changes':changes,
                      'repeats':1,'assertionLogicUnchanged':True}
        exec(compile(source, str(original), 'exec'),
             {'__name__':'__main__','__file__':str(original),'R3_HERE':FACILITY,
              'R3_ADAPTATION':adaptation,'R3_SOURCE':source,'C4_DRIVER':Path(__file__).resolve()})
