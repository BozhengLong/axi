"""从上一批正式冻结包提取素材，核对发布账本和资格来源。"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
EVAL = REPO / 'scripts/eval'
sys.path.insert(0, str(EVAL / 'release-r2'))
from inputs import verify_initial


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        subprocess.run(['/bin/cp', '-cRp', source, target], check=True)


def main(old, study):
    assert read(study / 'engineering-admission.json')['qualified']
    assert read(study / 'status.json')['phase'] == 'R2'
    manifest = read(old / 'release-manifest.json')
    ledger = old / 'formal-controller/controller-events.jsonl'
    events = [json.loads(line) for line in ledger.read_text().splitlines()]
    previous_hash = None
    for index, event in enumerate(events):
        values = {key:value for key, value in event.items() if key != 'hash'}
        digest = hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        assert event['sequence'] == index and event['previous'] == previous_hash and event['hash'] == digest
        previous_hash = digest
    assert events[-1]['state']['closure']['verdict'] == 'NO-GO'
    assert manifest['identities']['candidate'] == 'e684620d1fa9109fcbcf442033ed97323cf76716'
    assert read(study / 'candidate.json')['candidate'] == '280d1f3debf95455b7a763b0b9ffc579bac6c5bd'
    claims = [event['payload']['id'] for event in events if event['action'] == 'claim']
    assert len(claims) == 5 and not any(item.startswith('U') for item in claims)
    checksums = read(old / manifest['facilityIndex']['path'])['files']
    assert sha(old / manifest['facilityIndex']['path']) == manifest['facilityIndex']['sha256']
    frozen = {Path(row['path']):row['sha256'] for row in checksums}
    grading_sources = []
    # 确定性题目资格在候选程序外运行。对照整套 R2 评分源码与准备阶段实际使用的 R3 函数。
    for path, checksum in frozen.items():
        if 'scripts' not in path.parts:
            continue
        relative = Path(*path.parts[path.parts.index('scripts'):])
        if (relative.is_relative_to('scripts/eval/release-r2') or
            str(relative) in ('scripts/eval/release-r3/qualification_guard.py',
                              'scripts/eval/release-r3/qualify-material.py',
                              'scripts/eval/release-r3/dependency-audit.py')):
            assert sha(REPO / relative) == checksum
            grading_sources.append({'path':str(relative),'sha256':checksum})
    assert any(row['path'].endswith('/grade-artifact.py') for row in grading_sources)
    resource = read(old / manifest['proofs']['resourcePolicy']['path'])
    assert sha(old / manifest['proofs']['resourcePolicy']['path']) == manifest['proofs']['resourcePolicy']['sha256']
    info = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .}}']))
    assert (resource['dockerMemory'],resource['dockerCpus']) == (info['MemTotal'],info['NCPU'])
    for role in ('bun','pnpm','node'):
        assert read(old/'toolchain/verification.json')['versions'][role] == read(study/'toolchain/verification.json')['versions'][role]

    adopted_audits = {}
    for key in ('taskPackage', 'c7'):
        proof = manifest['proofs'][key]
        assert sha(old / proof['path']) == proof['sha256']
        package = read(old / proof['path'])
        assert package['qualified']
        audits = [row['audit'] for row in package['tasks']] if key == 'taskPackage' else package['audits']
        adopted_audits.update({row['path']:row['sha256'] for row in audits})
    assert len(adopted_audits) == 22
    entries = manifest['tasks'] + manifest['c7Tasks']
    assert [item['id'] for item in entries] == [f'U{i:02}' for i in range(1, 21)] + ['C7-L', 'C7-O']
    mounts = set()
    tasks = []
    for entry in entries:
        task_id = entry['id']
        relative = Path('c7' if task_id.startswith('C7-') else 'tasks') / task_id
        source, dest = old / relative, study / relative
        bound = entry['binding']
        assert sha(old / bound['path']) == bound['sha256']
        binding = read(old / bound['path'])
        for file in binding['files']:
            assert sha(old / file['path']) == file['sha256']
        inputs = read(source / 'input-manifest.json')
        verify_initial(source / 'initial', inputs, binding['gitIdentity'])
        for path in sorted(source.iterdir()):
            if path.name in ('initial', 'qualification-material', 'input-manifest.json', 'grading-profile.json',
                             'qualification-profile.json', 'negative-controls.json', 'environment.json',
                             'business-contract.json', 'reference-declarations.json', 'references.json') or path.name.endswith('-patch.json'):
                copy(path, dest / path.name)
                if path.is_file():
                    assert sha(path) == sha(dest / path.name)
        verify_initial(dest / 'initial', inputs, binding['gitIdentity'])
        for path, checksum in frozen.items():
            if path.is_relative_to(source):
                local = dest / path.relative_to(source)
                if local.is_file():
                    assert sha(local) == checksum
        profile = read(dest / 'qualification-profile.json')
        mounts.update(row['source'] for row in profile.get('dependencyMounts', []))
        assert sha(source / entry['audit']) == adopted_audits[str(relative / entry['audit'])]
        audit = read(source / entry['audit'])
        assert audit['qualified'] and audit['repeatRuleSatisfied']
        expected_roles = {'initial', *profile['references'], 'counterfactual'}
        assert audit['referenceCases'] == 5 * len(expected_roles)
        for key in ('referenceQualification', 'negativeQualification'):
            previous = source / audit[key]
            info = read(previous / 'results.json')
            assert info['qualified'] and info['facilityStable']
            if key == 'referenceQualification':
                assert {(row['role'], row['repeat']) for row in info['rows']} == {(role, n) for role in expected_roles for n in range(1, 6)}
                assert all(row['passed'] for row in info['rows'])
            else:
                expected = {item['id'] for item in read(source / 'negative-controls.json')['controls']}
                assert {(row['id'], row['repeat']) for row in info['rows']} == {(name, n) for name in expected for n in range(1, 6)}
                assert all(row['qualified'] for row in info['rows'])
            for name, checksum in read(previous / 'facility.json').items():
                path = Path(name)
                if path.is_relative_to(source):
                    counterpart = dest / path.relative_to(source)
                else:
                    suffix = path.parts.index('scripts')
                    counterpart = REPO.joinpath(*path.parts[suffix:])
                assert sha(previous / 'facility-source' / checksum) == sha(counterpart) == checksum
        tasks.append({'task':task_id, 'oldBinding':bound, 'oldAudit':entry['audit'],
                      'oldAuditSha256':sha(source / entry['audit']), 'oldQualificationCount':5,
                      'initialGit':binding['gitIdentity']})
    for mount in sorted(mounts):
        relative = Path(mount)
        assert not relative.is_absolute() and '..' not in relative.parts
        copy(old / relative, study / relative)
    write(study / 'material-source-audit.json', {'candidate':read(study / 'candidate.json')['candidate'],
          'previous':str(old), 'formalClaims':claims, 'ledgerSha256':sha(ledger),
          'tasks':tasks, 'bindMounts':sorted(mounts), 'gradingSources':grading_sources,
          'dockerMemory':info['MemTotal'], 'dockerCpus':info['NCPU'], 'realModelStarts':0,
          'scope':'核对素材和上一批五次资格。当前批的依赖测量、重验与端到端模拟另行登记。'})


if __name__ == '__main__':
    main(*(Path(arg).resolve() for arg in sys.argv[1:3]))
