"""冻结前把依赖证明绑定到当前批次，并执行正式领取时使用的逐题核对。"""
from pathlib import Path
import hashlib
import json
import runpy


def read(path):
    return json.loads(path.read_text())


def checksum(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def checked_entry(study, entry):
    relative = Path(entry['path'])
    path = study / relative
    if relative.is_absolute() or path.resolve() != path or not path.is_relative_to(study):
        raise ValueError('依赖证明路径越界')
    if checksum(path) != entry['sha256']:
        raise ValueError('依赖证明哈希与记录不符')
    return read(path)


def bind(study, manifest, current_proof):
    study = Path(study).resolve()
    prior = manifest['proofs']['dependencies']
    prior_data = checked_entry(study, prior)
    current_data = checked_entry(study, current_proof)
    verifier = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'eval/release-r3/dependency-audit.py'))

    def signature(proof):
        rows = {row['key']: (row['sha256'], row['bytes'], row['entries']) for row in proof['roots']}
        if len(rows) != len(proof['roots']) or not proof['qualified']:
            raise ValueError('依赖目录重复或证明未通过')
        return rows

    if signature(prior_data) != signature(current_data) or prior_data['image'] != current_data['image']:
        raise ValueError('两批依赖或镜像身份不同')
    if current_data['image'] != manifest['identities']['image']:
        raise ValueError('实测依赖镜像与候选身份不同')

    # 即使两个批次的依赖字节相同，正式领取仍须核对当前挂载源的完整路径。
    task_ids = [t['id'] for t in [manifest['healthTask'], *manifest['c7Tasks'], *manifest['tasks']]]
    checks = {}
    for task in task_ids:
        checks[task] = [r['key'] for r in verifier['verify'](study, current_data, task)]
    if set().union(*map(set, checks.values())) != set(signature(current_data)):
        raise ValueError('逐题核对未覆盖整批依赖')
    manifest['proofs'] = {**manifest['proofs'], 'dependencies': current_proof}
    manifest['dependencyHash'] = current_proof['sha256']
    return {'prior': prior, 'current': current_proof, 'checks': checks}
