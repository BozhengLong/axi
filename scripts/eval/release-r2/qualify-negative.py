"""真实错误实现校准：编译通过后，要求对应公开条款的原生行为断言失败。"""
from pathlib import Path
import sys, json, shutil, subprocess, time, hashlib, re

study = Path(sys.argv[1]).resolve()
task_id = sys.argv[2]
assert re.fullmatch(r'T\d\d', task_id)
task = study / 'tasks' / task_id
controls = json.loads((task / 'negative-controls.json').read_text())
profile = json.loads((task / 'qualification-profile.json').read_text())
assert controls['repeats'] == 5
assert json.loads((task / 'qualification-2/results.json').read_text())['qualified']
out = task / 'negative-qualification-1'
out.mkdir()
reporters = Path(__file__).parent / 'reporters'
rows = []

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

frozen = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), *reporters.glob('*.mjs'), task / 'negative-controls.json', task / 'qualification-profile.json', task / 'input-manifest.json', *task.glob('*-patch.json'), *(task / 'qualification-material').glob('*')] if p.is_file()}
(out / 'facility-source').mkdir()
for path, checksum in frozen.items():
    (out / 'facility-source' / checksum).write_bytes(Path(path).read_bytes())
save(out / 'facility.json', frozen)
save(out / 'plan.json', {'repeats': 5, 'ids': [c['id'] for c in controls['controls']], 'positiveQualification': 'qualification-2', 'sourceKinds': 'six behavior mutations; two actual protected-file mutations'})
for control in controls['controls']:
    for repeat in range(1, 6):
        case = out / f"{control['id']}-{repeat}"
        case.mkdir()
        work = case / 'work'
        shutil.copytree(task / 'initial', work, ignore=shutil.ignore_patterns('node_modules', 'dist', 'coverage', '*.tsbuildinfo'))
        reference = json.loads((task / (control['reference'] + '-patch.json')).read_text())
        for name, value in reference.items():
            path = work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
        originals = {name: (work / name).read_bytes().hex() for name in control['files']}
        for name, value in control['files'].items():
            (work / name).write_text(value)
        save(case / 'mutation.json', {'beforeHex': originals, 'after': control['files']})
        if control.get('kind') == 'protection':
            caught = False
            try:
                assert all((work / name).read_bytes().hex() == before for name, before in originals.items()), 'protected file changed'
            except AssertionError:
                caught = True
            assert caught
            row = {'id': control['id'], 'repeat': repeat, 'qualified': True, 'origin': 'actual-file-protection-assertion'}
        else:
            container = f"axi-r2-neg-{task_id.lower()}-{control['id'].lower()}-{repeat}"
            args = ['docker', 'run', '-d', '--name', container, '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--cpus', '2', '--memory', '4g', '--pids-limit', '256', '--tmpfs', '/tmp:rw,exec,size=512m', '-e', 'HOME=/tmp', '-v', f'{work}:/task', '-v', f'{task}/qualification-material:/grade:ro', '-v', f'{reporters}:/reporters:ro']
            for mount in profile['dependencyMounts']:
                args += ['-v', f"{study / mount['source']}:{mount['target']}:ro"]
            args += ['-w', '/task', '--entrypoint', 'sleep', profile['image'], 'infinity']
            save(case / 'container-command.json', args)
            commands = []
            started = time.monotonic()
            try:
                subprocess.run(args, capture_output=True, check=True, timeout=20)
                for label, command in [('build', profile['commands'][0]['args']), ('target', next(x['args'] for x in profile['commands'] if x['label'] == 'target'))]:
                    argv = ['docker', 'exec', container, *command]
                    with (case / (label + '.stdout')).open('wb') as stdout, (case / (label + '.stderr')).open('wb') as stderr:
                        result = subprocess.run(argv, stdout=stdout, stderr=stderr, timeout=60)
                    commands.append({'label': label, 'args': argv, 'code': result.returncode})
                    save(case / 'commands.json', commands)
                    assert result.returncode == (0 if label == 'build' else 1)
                marker = '# AXI_TEST_ASSERTIONS_V1 '
                lines = [line[len(marker):] for line in (case / 'target.stdout').read_text().splitlines() if line.startswith(marker)]
                assert len(lines) == 1
                native = json.loads(lines[0])
                summary = next(x for x in native['summaries'] if not x.get('file'))
                assert summary['counts']['tests'] == profile['targetTests']
                assert summary['counts']['cancelled'] == summary['counts']['skipped'] == summary['counts']['todo'] == 0
                assert any(f['name'].startswith(control['prefix'] + ':') and f['assertion'] for f in native['failures'])
                assert all(f['assertion'] and f['failureType'] == 'testCodeFailure' for f in native['failures'])
                row = {'id': control['id'], 'repeat': repeat, 'qualified': True, 'origin': 'native-node-behavior-assertion', 'failedNames': [f['name'] for f in native['failures']], 'elapsedSeconds': time.monotonic() - started}
            finally:
                cleanup = subprocess.run(['docker', 'rm', '-f', container], capture_output=True, text=True, timeout=5)
                check = subprocess.run(['docker', 'ps', '-a', '--filter', f'name=^/{container}$', '--format', '{{.Names}}'], capture_output=True, text=True, timeout=5)
                save(case / 'cleanup.json', {'code': cleanup.returncode, 'remaining': check.stdout})
                assert cleanup.returncode == check.returncode == 0 and not check.stdout.strip()
        rows.append(row)
        save(case / 'result.json', row)
        save(out / 'results.json', {'qualified': len(rows) == len(controls['controls']) * 5, 'rows': rows})
        print(json.dumps(row), flush=True)
for path, checksum in frozen.items():
    assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == checksum
