"""在冻结C3的两份干净副本安装并执行固定的基础工程检查。"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import subprocess
import sys
import time

study = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parents[3]
identity = json.loads((study / 'candidate.json').read_text())
toolchain = json.loads((study / 'toolchain/verification.json').read_text())
image = 'sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1'
env = toolchain['env']
revision = int(sys.argv[2]) if len(sys.argv) > 2 else 1
assert revision > 0
label_root = f'base-engineering-{revision}'


def run(platform, label, args, cwd=None, child_env=None):
    directory = study / label_root / platform
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / label
    assert not path.with_suffix('.json').exists(), '不可覆盖已有运行'
    started = time.time()
    with path.with_suffix('.stdout').open('wb') as out, path.with_suffix('.stderr').open('wb') as err:
        result = subprocess.run(args, cwd=cwd, env=child_env or env, stdout=out, stderr=err)
    row = dict(command=args, exitCode=result.returncode, seconds=time.time() - started)
    path.with_suffix('.json').write_text(json.dumps(row, indent=2) + '\n')
    print(json.dumps(dict(platform=platform, label=label, **row)), flush=True)
    if result.returncode:
        raise RuntimeError(f'{platform}/{label}: exit {result.returncode}')


def check(platform):
    directory = study / f'candidate-{platform}-{revision}'
    assert not directory.exists(), '必须新建干净候选副本'
    run(platform, 'clone', ['git', 'clone', '--no-hardlinks', '--no-checkout', str(repo), str(directory)])
    run(platform, 'checkout', ['git', 'checkout', '--detach', identity['candidate']], cwd=directory)
    if platform == 'macos':
        run(platform, 'install', ['bun', 'install', '--frozen-lockfile'], cwd=directory)
        eval_env = study / label_root / 'macos/environment.json'
        eval_env.write_text(json.dumps({'env': env}, indent=2) + '\n')
        run(platform, 'check', ['bun', str(repo / 'scripts/eval/release-r3/check.ts'), str(directory), str(study / 'candidate-source.json'), str(study / f'c3-macos-check-{revision}'), platform], child_env={**env, 'AXI_EVAL_ENV': str(eval_env)})
    else:
        common = ['docker', 'run', '--rm', '--label', 'axi.eval.study=' + study.name,
                  '--cpus', '2', '--memory', '4g', '--user', '1000:1000', '--read-only',
                  '--tmpfs', '/tmp:rw,nosuid,size=1g,mode=1777',
                  '-v', str(directory) + ':/candidate', '-w', '/candidate',
                  '-e', 'TMPDIR=/tmp', '-e', 'BUN_INSTALL_CACHE_DIR=/tmp/bun-cache', '-e', 'HOME=/tmp/eval-home', '-e', 'GIT_CONFIG_GLOBAL=/dev/null', '-e', 'GIT_CONFIG_NOSYSTEM=1',
                  '-e', 'npm_config_package_manager_strict=false', '-e', 'npm_config_manage_package_manager_versions=false']
        run(platform, 'install', [*common, '--name', 'axi-r3-linux-install', '--network', 'bridge', image, 'bun', 'install', '--frozen-lockfile'])
        run(platform, 'check', [*common, '--name', 'axi-r3-linux-check', '--network', 'none',
            '-v', str(repo) + ':/facility:ro', '-v', str(study) + ':/study', image, 'bun',
            '/facility/scripts/eval/release-r3/check.ts', '/candidate', '/study/candidate-source.json', f'/study/c3-linux-check-{revision}', platform])
    return {'platform': platform, 'passed': True}


with ThreadPoolExecutor(max_workers=2) as pool:
    futures = {platform: pool.submit(check, platform) for platform in ('macos', 'linux')}
    results = []
    for platform, future in futures.items():
        try:
            results.append(future.result())
        except Exception as error:
            results.append({'platform': platform, 'passed': False, 'error': str(error)})
summary = {'candidate': identity['candidate'], 'sourceHash': identity['sourceHash'], 'rows': results,
           'qualified': all(row['passed'] for row in results), 'realModelStarts': 0}
(study / label_root / 'results.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary), flush=True)
sys.exit(0 if summary['qualified'] else 1)
