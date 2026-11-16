"""在固定、无网络、只读依赖环境校准任务。此入口不能启动真实模型。"""
from pathlib import Path
import sys, json, os, re, shutil, hashlib, subprocess, time, datetime, fnmatch, traceback
sys.dont_write_bytecode = True
from inputs import materialize

study = Path(sys.argv[1]).resolve()
task_id = sys.argv[2]
assert re.fullmatch(r'T\d\d', task_id)
task = study / 'tasks' / task_id
profile = json.loads((task / 'qualification-profile.json').read_text())
admission = json.loads((study / 'engineering-admission.json').read_text())
authorization = json.loads((study / 'authorization.json').read_text())
assert admission['stage'] == 'R2' and authorization['T1'] is None
assert datetime.datetime.now(datetime.timezone.utc) < datetime.datetime.fromisoformat(authorization['preparationDeadline'])
assert re.fullmatch(r'[A-Za-z0-9_-]+', sys.argv[3])
out = task / ('qualification-' + sys.argv[3])
out.mkdir()
reporters = Path(__file__).parent / 'reporters'
frozen = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), Path(__file__).with_name('inputs.py'), *reporters.glob('*.mjs'), *reporters.glob('*.cjs'), task / 'qualification-profile.json', task / 'input-manifest.json', *task.glob('*-patch.json'), * (task / 'qualification-material').glob('*')] if p.is_file()}

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

save(out / 'facility.json', frozen)
(out / 'facility-source').mkdir()
for path, checksum in frozen.items():
    (out / 'facility-source' / checksum).write_bytes(Path(path).read_bytes())
save(out / 'plan.json', {'task': task_id, 'repeats': 5, 'roles': ['initial', *profile['references']], 'counterfactualRepeats': 5, 'sharedWindowSeconds': 720, 'mockOnly': True})
initial_manifest = json.loads((task / 'input-manifest.json').read_text())
original_files = [f['path'] for f in initial_manifest['files']]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git_state(root):
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_OPTIONAL_LOCKS': '0'}
    return {label: subprocess.check_output(['git', '-C', str(root), *args], env=env, text=True) for label, args in [('head', ['rev-parse', 'HEAD']), ('index', ['ls-files', '--stage'])]}

def file_snapshot(root, name):
    path = root / name
    parent = path.parent
    while parent != root:
        assert parent.is_relative_to(root) and not parent.is_symlink(), '父路径不能改成链接'
        parent = parent.parent
    stat = path.lstat()
    if path.is_symlink():
        return {'type': 'symlink', 'target': os.readlink(path), 'mode': stat.st_mode & 511}
    return {'type': 'file', 'sha256': digest(path), 'mode': stat.st_mode & 511}


def input_snapshot(root, paths):
    return {'files': {p: file_snapshot(root, p) for p in paths}, 'git': git_state(root)}

def node_report(stdout):
    marker = '# AXI_TEST_ASSERTIONS_V1 '
    rows = [line[len(marker):] for line in stdout.splitlines() if line.startswith(marker)]
    assert len(rows) == 1, '缺少唯一原生Node断言记录'
    data = json.loads(rows[0])
    summaries = [s for s in data['summaries'] if not s.get('file')]
    assert len(summaries) == 1
    counts = summaries[0]['counts']
    assert counts['cancelled'] == counts['skipped'] == counts['todo'] == 0
    assert all(f['failureType'] == 'testCodeFailure' and f['assertion'] for f in data['failures']), '失败不是行为断言'
    return data, counts

results = []
for role in ['initial', *profile['references'], 'counterfactual']:
    for repeat in range(1, 6):
        assert datetime.datetime.now(datetime.timezone.utc) < datetime.datetime.fromisoformat(authorization['preparationDeadline']), '准备截止已到'
        case = out / f'{role}-{repeat}'
        case.mkdir()
        work = case / 'work'
        materialize(task / 'initial', work, initial_manifest)
        patch = {} if role == 'initial' else json.loads((task / ((profile['counterfactualReference'] if role == 'counterfactual' else role) + '-patch.json')).read_text())
        if role == 'counterfactual':
            patch = {p: value for p, value in patch.items() if p in profile['regressionPaths']}
        for name, value in patch.items():
            assert not Path(name).is_absolute() and '..' not in Path(name).parts
            dest = work / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(value)
        all_paths = sorted(set(original_files + list(patch)))
        before = input_snapshot(work, all_paths)
        assert before['git']['head'].strip() == initial_manifest['upstreamCommit']
        for original in initial_manifest['files']:
            expected = {k: v for k, v in original.items() if k != 'path'}
            expected.setdefault('type', 'file')
            if original['path'] in patch:
                expected = {'type': 'file', 'sha256': hashlib.sha256(patch[original['path']].encode()).hexdigest(), 'mode': original['mode']}
            assert before['files'][original['path']] == expected, '工作副本与固定初态不符'
        save(case / 'source-before.json', before)
        generated = profile.get('generatedPaths', [])
        assert not any(fnmatch.fnmatch(p, pattern) for p in patch for pattern in generated), '参考源码不能藏在生成目录'
        paths = [p for p in all_paths if not any(fnmatch.fnmatch(p, pattern) for pattern in generated)]
        before['files'] = {p: before['files'][p] for p in paths}
        if profile.get('taskStorage') == 'linux-volume':
            # Linux 不支持修改 symlink 自身的权限位；只对这类位采用已声明的目标平台值。
            for value in before['files'].values():
                if value['type'] == 'symlink':
                    value['mode'] = profile['linuxSymlinkMode']
        save(case / 'before.json', before)
        save(case / 'snapshot-paths.json', paths)
        name = f'axi-r2-q-{task_id.lower()}-{role}-{repeat}'
        volume = name + '-task' if profile.get('taskStorage') == 'linux-volume' else None
        storage = ['-v', f'{volume}:/task', '-v', f'{work}:/seed:ro'] if volume else ['-v', f'{work}:/task']
        args = ['docker', 'run', '-d', '--name', name, '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', '4g', '--pids-limit', '256', '--tmpfs', '/tmp:rw,exec,size=1g', '-e', 'HOME=/tmp/home', '-e', 'TMPDIR=/tmp', *storage, '-v', f'{case}:/evidence', '-v', f'{task}/qualification-material:/grade:ro', '-v', f'{reporters}:/reporters:ro']
        for mount in profile['dependencyMounts']:
            source = (study / mount['source']).resolve()
            assert source.is_relative_to(study)
            args += ['-v', f"{source}:{mount['target']}:ro"]
        for mount in profile.get('cacheTmpfs', []):
            args += ['--tmpfs', mount]
        for key, value in profile.get('environment', {}).items():
            assert re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and isinstance(value, str)
            assert key not in ['PATH', 'HOME', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']
            args += ['-e', f'{key}={value}']
        args += ['-w', '/task', '--entrypoint', 'sleep', profile['image'], 'infinity']
        save(case / 'container-command.json', args)
        started = time.monotonic()
        deadline = started + 720
        commands = []
        failure = None
        try:
            if volume:
                subprocess.run(['docker', 'volume', 'create', volume], check=True, capture_output=True, timeout=10)
                init = ['docker', 'run', '--rm', '--network', 'none', '--user', '0', '--read-only', '--cap-drop=ALL', '--cap-add=CHOWN', '-v', f'{volume}:/task', '--entrypoint', 'chown', profile['image'], '1000:1000', '/task']
                save(case / 'volume-init-command.json', init)
                subprocess.run(init, check=True, capture_output=True, timeout=10)
                # 先复制源码再挂只读嵌套依赖，避免Docker先创建root拥有的包目录。
                seed = ['docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '-v', f'{volume}:/task', '-v', f'{work}:/seed:ro', '--entrypoint', 'cp', profile['image'], '-R', '-P', '--preserve=mode', '/seed/.', '/task/']
                save(case / 'seed-command.json', seed)
                seeded = subprocess.run(seed, capture_output=True, timeout=20)
                save(case / 'seed-result.json', {'code': seeded.returncode, 'stdout': seeded.stdout.decode(), 'stderr': seeded.stderr.decode()})
                assert seeded.returncode == 0, '输入复制失败，不能运行测试'
            subprocess.run(args, check=True, capture_output=True, timeout=30)
            steps = profile['counterfactualCommands'] if role == 'counterfactual' else profile['commands']
            for index, step in enumerate(steps):
                if step.get('referenceOnly') and role == 'initial':
                    continue
                command = ['docker', 'exec', '-e', f'AXI_RESULT_PATH=/evidence/{index}.native.json', name, *step['args']]
                save(case / f'{index}.command.json', command)
                at = time.monotonic()
                with (case / f'{index}.stdout').open('wb') as stdout, (case / f'{index}.stderr').open('wb') as stderr:
                    process = subprocess.run(command, stdout=stdout, stderr=stderr, timeout=max(0.1, deadline - time.monotonic() - 5))
                code = process.returncode
                record = {'label': step['label'], 'args': step['args'], 'exitCode': code, 'elapsedSeconds': time.monotonic() - at}
                commands.append(record)
                save(case / 'commands.json', commands)
                if step['label'] == 'target':
                    native, counts = node_report((case / f'{index}.stdout').read_text())
                    assert counts['tests'] == profile['targetTests']
                    if role == 'initial':
                        assert code == 1 and counts['failed'] == len(profile['initialFailPrefixes'])
                        assert sorted(f['name'].split(':')[0] for f in native['failures']) == sorted(profile['initialFailPrefixes'])
                    else:
                        assert code == 0 and counts['failed'] == 0
                elif step.get('framework') == 'vitest':
                    native = json.loads((case / f'{index}.native.json').read_text())
                    assert not native['unhandled'] and not any(s['errors'] for s in native['suites'])
                    counts = native['counts']
                    assert sum(counts.get(k, 0) for k in ['skip', 'todo', 'run', 'only']) == 0
                    expected = step.get('tests', profile['regressionTests'] if role == 'counterfactual' else profile['originalTests'] + (0 if role == 'initial' else profile['regressionTests']))
                    if role in profile['references']:
                        expected += step.get('referenceAdditionalTests', 0)
                    assert len(native['tests']) == expected
                    if role == 'counterfactual':
                        assert code == 1 and counts['fail'] > 0 and native['assertionFailures']
                        assert all(t['state'] != 'fail' or any(e['assertion'] for e in t['errors']) for t in native['tests'])
                    else:
                        assert code == 0 and counts['pass'] == expected and counts['fail'] == 0
                elif step.get('framework') == 'node':
                    native, counts = node_report((case / f'{index}.stdout').read_text())
                    assert counts['tests'] == step.get('tests', profile['regressionTests'])
                    if role == 'counterfactual':
                        assert code == 1 and counts['failed'] > 0
                        assert sorted(f['name'].split(':')[0] for f in native['failures']) == sorted(profile['counterfactualFailPrefixes'])
                    else:
                        assert code == 0 and counts['failed'] == 0
                elif step.get('framework') == 'jest':
                    native = json.loads((case / f'{index}.native.json').read_text())
                    counts = native['counts']
                    tests = [test for suite in native['suites'] for test in suite['tests']]
                    assert code == 0 and not native['interrupted']
                    assert counts['numTotalTests'] == counts['numPassedTests'] == len(tests) == step['tests']
                    assert counts['numTotalTestSuites'] == counts['numPassedTestSuites'] == len(native['suites']) == step['suites']
                    assert all(counts[k] == 0 for k in ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numRuntimeErrorTestSuites'])
                    assert all(not suite['execError'] for suite in native['suites'])
                    assert all(test['status'] == 'passed' and not test['errors'] for test in tests)
                elif step.get('framework') == 'mocha':
                    native = json.loads((case / f'{index}.native.json').read_text())
                    assert code == 0 and not native['failures'] and native['stats']['failures'] == 0
                    expected = step.get('tests', profile.get('originalTests'))
                    assert expected and len(native['tests']) == native['stats']['tests'] == expected
                    pending = step.get('pending', profile.get('originalMochaPending', []))
                    assert sorted(native['pending'], key=lambda x: (x['file'], x['name'])) == sorted(pending, key=lambda x: (x['file'], x['name']))
                    assert native['stats']['pending'] == len(pending)
                    assert native['stats']['passes'] == expected - len(pending)
                    assert all(t['state'] == 'passed' or t['pending'] for t in native['tests'])
                elif step.get('framework') == 'tap':
                    native = json.loads((case / f'{index}.native.json').read_text())
                    assert code == native['code'] == 0 and not native.get('signal') and not native.get('launchError')
                    assert not native['parserErrors'] and native['root']['ok']
                    extra_files = step.get('referenceAdditionalFiles', 0) if role in profile['references'] else 0
                    extra_leaves = step.get('referenceAdditionalLeaves', 0) if role in profile['references'] else 0
                    assert native['root']['count'] == profile['originalTests'] + extra_files
                    assert native['counts']['leaves'] == profile['originalTapLeaves'] + extra_leaves
                    assert not native['counts']['failedLeaves'] and not native['counts']['todo']
                    assert sorted(p['name'] for p in native['points'] if p['skip']) == sorted(profile['originalTapSkips'])
                    assert all(p['ok'] and not p['tapError'] for p in native['points'])
                    assert all(s['result']['ok'] and not s['result']['bailout'] for s in native['suites'])
                else:
                    assert code == 0, f"{step['label']}失败"
                subprocess.run(['docker', 'pause', name], check=True, capture_output=True, timeout=5)
                try:
                    if volume:
                        audit = ['docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '-v', f'{volume}:/task:ro', '-v', f'{case}/snapshot-paths.json:/paths.json:ro', '-v', f'{reporters}:/reporters:ro', '--entrypoint', 'node', profile['image'], '/reporters/snapshot.mjs', '/paths.json']
                        save(case / f'{index}.audit-command.json', audit)
                        checked = subprocess.run(audit, capture_output=True, timeout=10)
                        (case / f'{index}.audit.stdout').write_bytes(checked.stdout)
                        (case / f'{index}.audit.stderr').write_bytes(checked.stderr)
                        assert checked.returncode == 0, '只读卷快照失败'
                        after = json.loads(checked.stdout)
                    else:
                        after = input_snapshot(work, paths)
                finally:
                    subprocess.run(['docker', 'unpause', name], check=True, capture_output=True, timeout=5)
                save(case / f'{index}.protected.json', after)
                assert after == before, '验证进程修改了源码、用户文件或Git状态'
        except Exception as error:
            failure = f'{type(error).__name__}: {error}'
            (case / 'failure.txt').write_text(traceback.format_exc())
        finally:
            cleanup = subprocess.run(['docker', 'rm', '-f', name], capture_output=True, text=True, timeout=max(0.1, deadline - time.monotonic()))
            remaining = subprocess.run(['docker', 'ps', '-a', '--filter', f'name=^/{name}$', '--format', '{{.Names}}'], capture_output=True, text=True, timeout=max(0.1, deadline - time.monotonic()))
            save(case / 'cleanup.json', {'code': cleanup.returncode, 'stdout': cleanup.stdout, 'stderr': cleanup.stderr, 'remaining': remaining.stdout})
            if cleanup.returncode or remaining.returncode or remaining.stdout.strip():
                failure = failure or 'cleanup incomplete'
            if volume:
                volume_cleanup = subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, text=True, timeout=5)
                save(case / 'volume-cleanup.json', {'code': volume_cleanup.returncode, 'stdout': volume_cleanup.stdout, 'stderr': volume_cleanup.stderr})
                if volume_cleanup.returncode:
                    failure = failure or 'volume cleanup incomplete'
        row = {'role': role, 'repeat': repeat, 'passed': failure is None, 'error': failure, 'elapsedSeconds': time.monotonic() - started, 'commands': commands}
        results.append(row)
        save(case / 'result.json', row)
        save(out / 'results.json', {'task': task_id, 'qualified': False, 'rows': results})
        print(json.dumps({k: v for k, v in row.items() if k != 'commands'}), flush=True)
        if failure:
            raise SystemExit(1)
for path, expected in frozen.items():
    assert digest(Path(path)) == expected, f'资格期间输入或设施改变: {path}'
assert datetime.datetime.now(datetime.timezone.utc) < datetime.datetime.fromisoformat(authorization['preparationDeadline']), '准备截止后不能准入'
save(out / 'results.json', {'task': task_id, 'qualified': len(results) == (len(profile['references']) + 2) * 5 and all(r['passed'] for r in results), 'facilityStable': True, 'rows': results})
