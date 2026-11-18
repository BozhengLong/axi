"""核对依赖，并按已登记的原态、参考、反事实和负例执行当前批复验。"""
from pathlib import Path
import json
import os
import subprocess
import sys

HERE = Path(__file__).resolve().parent
R3 = HERE.parent / 'eval/release-r3'


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    with path.open('x') as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write('\n')


def checksums(proof):
    assert proof['qualified']
    return {r['key']:(r['sha256'],r['bytes'],r['entries']) for r in proof['roots']}


def run(args, out):
    prefix = out
    attempt = 1
    while prefix.with_suffix('.stdout').exists() or prefix.with_suffix('.stderr').exists():
        attempt += 1
        prefix = out.with_name(f'{out.name}-attempt-{attempt}')
    with prefix.with_suffix('.stdout').open('xb') as stdout, prefix.with_suffix('.stderr').open('xb') as stderr:
        subprocess.run([sys.executable,'-B',*args],stdout=stdout,stderr=stderr,check=True)


def main(old, study):
    os.environ.update(read(study/'toolchain/verification.json')['env'])
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    assert read(study/'engineering-admission.json')['qualified'] and read(study/'status.json')['phase']=='R2'
    out=study/'material-queue-c4';out.mkdir(exist_ok=True)
    if not (study/'material-source-audit.json').exists():
        run([HERE/'prepare-materials.py',old,study],out/'prepare')
    if not (study/'dependency-identity.json').exists():
        directory = 'dependency-audit-1'
        if not (study/directory/'result.json').exists():
            run([R3/'dependency-audit.py',study,directory],out/'dependencies')
        old_proof=read(old/directory/'result.json');new_proof=read(study/directory/'result.json')
        assert old_proof['image']==new_proof['image']
        actual=checksums(new_proof);assert len(actual)==26 and actual==checksums(old_proof)
        write(study/'dependency-identity.json',{'qualified':True,'roots':len(actual),'image':new_proof['image'],
              'current':directory+'/result.json','previous':str(old/directory/'result.json')})
    records=read(study/'material-source-audit.json')['tasks']
    for item in records:
        task_id=item['task'];c7=task_id.startswith('C7-')
        task=study/('c7' if c7 else 'tasks')/task_id
        selection=read(task/'grading-profile.json')['baselineQualification']
        assert selection.startswith('qualification-') and '/' not in selection
        revision=selection.removeprefix('qualification-')
        audit=task/f'qualification-audit-{revision}.json'
        if audit.exists():
            assert read(audit)['qualified']
            continue
        for kind in (('c7','c7-negative','audit') if c7 else ('task','negative','audit')):
            disk=os.statvfs(study)
            if disk.f_bavail*disk.f_frsize<9*2**30:
                raise RuntimeError('保全空间低于9 GiB。尚未启动下一项。')
            run([HERE/'recheck-material.py',kind,study,task_id,revision,*([revision] if 'negative' in kind else [])],out/f'{task_id}-{kind}')
        print(task_id,'qualified',flush=True)
    write(out/'result.json',{'qualified':True,'tasks':len(records),'currentRepeats':1,'priorRepeats':5})


if __name__=='__main__':
    main(*(Path(p).resolve() for p in sys.argv[1:3]))
