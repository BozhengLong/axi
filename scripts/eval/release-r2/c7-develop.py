"""本批C7开发前置。只运行固定容器中的离线检查，不启动产品或模型。"""
from pathlib import Path
import datetime
import json
import os
import re
import shutil
import subprocess
import sys

study = Path(sys.argv[1]).resolve()
task_id, revision = sys.argv[2:4]
assert task_id in ('C7-L', 'C7-O') and re.fullmatch(r'[A-Za-z0-9_-]+', revision)
auth = json.loads((study / 'authorization.json').read_text())
assert auth['T1'] is None and datetime.datetime.now(datetime.timezone.utc) < datetime.datetime.fromisoformat(auth['preparationDeadline'])
assert not any(n.startswith('axi-r2-') for n in subprocess.check_output(['docker', 'ps', '--format', '{{.Names}}'], text=True).splitlines())
task = study / 'c7' / task_id
profile = json.loads((task / 'development-profile.json').read_text())
out = task / ('contract-development-' + revision)
out.mkdir()
(out / 'driver.py').write_bytes(Path(__file__).read_bytes())
(out / 'profile.json').write_bytes((task / 'development-profile.json').read_bytes())
repo = Path(__file__).resolve().parents[3]
reporters = Path(__file__).with_name('reporters')
observer = Path(__file__).with_name('bun-observer.ts')
image = profile['image']


def command(args, evidence, timeout=120):
    evidence.with_suffix('.command.json').write_text(json.dumps(args, indent=2) + '\n')
    with evidence.with_suffix('.stdout').open('wb') as stdout, evidence.with_suffix('.stderr').open('wb') as stderr:
        result = subprocess.run(args, stdout=stdout, stderr=stderr, timeout=timeout)
    evidence.with_suffix('.exit').write_text(str(result.returncode))
    return result.returncode


if profile['dependencyPaths']:
    volume = profile['dependencyVolume']
    marker = study / 'c7' / 'dependency-copy.json'
    inspect = subprocess.run(['docker', 'volume', 'inspect', volume], capture_output=True)
    if inspect.returncode == 0:
        assert marker.exists(), '已有依赖卷缺少本批复制记录，不能复用'
        prior = json.loads(marker.read_text())
        assert prior['image'] == image and prior['volume'] == volume
    else:
        old = 'axi-c6-dependencies-20261111'
        subprocess.run(['docker', 'volume', 'inspect', old], check=True, capture_output=True)
        subprocess.run(['docker', 'volume', 'create', '--label', 'axi.eval.study=' + study.name, volume], check=True, capture_output=True)
        parts = []
        for path in profile['dependencyPaths']:
            assert re.fullmatch(r'[A-Za-z0-9_/-]+', path)
            parts.append("mkdir -p '/new/" + path + "' && cp -a '/old/" + path + "/.' '/new/" + path + "/'")
        args = ['docker', 'run', '--rm', '--name', 'axi-r2-c7-copy-dependencies', '--network', 'none', '--user', '0', '--read-only', '--cap-drop=ALL', '--cap-add=CHOWN', '--memory', '1g', '--cpus', '2', '-v', old + ':/old:ro', '-v', volume + ':/new', '--entrypoint', 'sh', image, '-c', ' && '.join(parts)]
        assert command(args, study / 'c7' / 'dependency-copy', 180) == 0
        marker.write_text(json.dumps({'sourceVolume': old, 'volume': volume, 'image': image, 'paths': profile['dependencyPaths'], 'copied': True, 'fullDependencyHashAudit': 'pending'}, indent=2) + '\n')

for role in ('initial', 'reference'):
    case = out / role
    case.mkdir()
    work = case / 'work'
    shutil.copytree(task / 'initial', work, symlinks=True)
    if role == 'reference':
        for name, text in json.loads((task / 'reference-patch.json').read_text()).items():
            assert not Path(name).is_absolute() and '..' not in Path(name).parts
            path = work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    name = 'axi-r2-c7-dev-' + task_id.lower() + '-' + revision + '-' + role
    volume = name + '-task'
    subprocess.run(['docker', 'volume', 'create', volume], check=True, capture_output=True)
    try:
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--user', '0', '--read-only', '--cap-drop=ALL', '--cap-add=CHOWN', '-v', volume + ':/task', '--entrypoint', 'chown', image, '1000:1000', '/task'], check=True, capture_output=True)
        seed = ['docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '-v', volume + ':/task', '-v', str(work) + ':/seed:ro', '--entrypoint', 'cp', image, '-R', '-P', '--preserve=mode', '/seed/.', '/task/']
        assert command(seed, case / 'seed', 30) == 0
        args = ['docker', 'run', '-d', '--name', name, '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--cpus', '2', '--memory', '4g', '--pids-limit', '256', '--tmpfs', '/tmp:rw,exec,size=1g', '-e', 'HOME=/tmp', '-v', volume + ':/task', '-v', str(task / 'qualification-material') + ':/grade:ro', '-v', str(reporters) + ':/reporters:ro', '-v', str(observer) + ':/observer.ts:ro', '-v', str(case) + ':/evidence']
        for path in profile['dependencyPaths']:
            args += ['--mount', 'type=volume,src=' + profile['dependencyVolume'] + ',dst=/task/' + path + ',volume-subpath=' + path + ',readonly']
        args += ['-w', '/task', '--entrypoint', 'sleep', image, 'infinity']
        assert command(args, case / 'container', 30) == 0
        for step in profile['commands']:
            if role == 'initial' and step.get('referenceOnly'):
                continue
            label = step['label']
            args = ['docker', 'exec', '-e', 'AXI_RESULT_PATH=/evidence/' + label + '.native.json', '-e', 'AXI_BUN_ASSERTIONS_PATH=/evidence/' + label + '.assertions.jsonl', name, *step['args']]
            code = command(args, case / label, 300)
            print(task_id, role, label, code, flush=True)
            if code and not (role == 'initial' and label == 'target'):
                break
    finally:
        result = subprocess.run(['docker', 'rm', '-f', name], capture_output=True, text=True, timeout=10)
        volume_result = subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, text=True, timeout=10)
        (case / 'cleanup.json').write_text(json.dumps({'container': result.returncode, 'volume': volume_result.returncode, 'containerStderr': result.stderr, 'volumeStderr': volume_result.stderr}, indent=2) + '\n')
        assert result.returncode == volume_result.returncode == 0
